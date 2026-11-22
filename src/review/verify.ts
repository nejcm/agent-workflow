import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoDir } from "../config/config";
import { loadSession } from "../config/repo-config";
import { cloned, nonoRun, scopePrefix } from "../session/launcher";
import { allocatePorts, composeDown, composeProject, composeUp, portEnv, portGrants, requireLandlock } from "../session/needs";
import type { Config, Io, Repo, Session, VerifyCheck, VerifyContract } from "../types";
import { budget, collectProof, postProof } from "./proof";
import { GIT, Kept, passLocked, put, read, SAFE_ID, SLOW_SECS, strip, subdirs, write } from "../util";

/** `<ID>.verified`: the last verify result tender recorded, for one PR head and contract digest. */
export type Verified = { head: string; digest: string } & ({ pass: true } | { pass: false; check: string; tail: string });
// `ports` and `project` are the run's own, apart from the session's, and recorded before anything starts.
type Job = { base: string; head: string; digest: string; checks: VerifyCheck[]; tenderDir: string; pr?: string; ports?: number[]; project?: string; baseSha?: string };

const LOG_LINES = 80;
// Whole in one feedback item, and under MAX_FILE once serialized even as 4-byte UTF-8.
const TAIL_CHARS = 8000;
const MAX_FILE = 64 * 1024;
const RUNNING = ["active", "activating", "deactivating", "reloading", "refreshing"];
// tail keeps only the last bytes, so a chatty check never fills memory; pipefail keeps the check's exit code.
const TAIL = 'set -o pipefail; "$@" 2>&1 | tail -c 65536';

/** One transient user service per workspace, so a second start fails rather than running two at once. */
export const verifyUnit = (cfg: Config) => `${scopePrefix(cfg)}-verify.service`;

const parse = (v: any): Verified | undefined => (v && typeof v.head === "string" && typeof v.digest === "string" && typeof v.pass === "boolean" && (v.pass || (typeof v.check === "string" && typeof v.tail === "string")) ? v : undefined);

const readJson = (f: string, max = MAX_FILE) => {
  try {
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8").slice(0, max)) : undefined;
  } catch {
    return undefined;
  }
};
const readFile = (f: string): Verified | undefined => parse(readJson(f));

export const readVerified = (dir: string, id: string) => readFile(join(dir, `${id}.verified`));

/** The recorded result when it is for this head under this contract, else undefined (never verified, stale head or changed contract). */
export const verifiedAt = (v: Verified | undefined, head: string | undefined, c: Pick<VerifyContract, "digest"> | undefined) => (v && c && v.head === head && v.digest === c.digest ? v : undefined);

/** Records finished runs and removes every `<ID>.verify` once the verifier is idle; true while it runs, throws if systemd cannot tell. */
export async function reconcileVerify(cfg: Config, io: Io) {
  const out = await read(io, ["systemctl", "--user", "list-units", "--type=service", "--all", "--plain", "--no-legend", verifyUnit(cfg)]);
  // Not listed once collected; listed as failed or inactive until then.
  const st = out.split("\n").map((l) => l.trim().split(/\s+/)).find((f) => f[0] === verifyUnit(cfg))?.[2] ?? "inactive";
  if (RUNNING.includes(st)) return true;
  for (const r of Object.values(cfg.repos)) {
    const dir = repoDir(cfg, r.key);
    for (const d of subdirs(dir)) {
      const id = d.endsWith(".verify") ? d.slice(0, -".verify".length) : "";
      if (!SAFE_ID.test(id)) continue;
      // tender's own file, so uncapped: a large contract still names its run.
      const job: Job | undefined = readJson(join(dir, d, "job.json"), Infinity);
      // Killed, out of memory or past its deadline: a rerun would likely end the same way and hold the one slot again.
      const lost = job && !verifiedAt(readVerified(dir, id), job.head, job) ? { head: job.head, digest: job.digest, pass: false as const, check: "(verifier)", tail: "the run ended without a result: killed, out of memory or past its deadline" } : undefined;
      const res = readFile(join(dir, d, "result")) ?? lost;
      if (res) put(io, join(dir, `${id}.verified`), JSON.stringify(res));
      io.log(`verify ${r.key}/${id}: ${res ? `${res.pass ? "passed" : `${res.check} failed`} at ${res.head.slice(0, 12)}` : "ended without a result or a job, so it runs again"}`);
      // A run killed mid-check left its services up; the dir stays, holding only this ticket, until they are down.
      if (job?.project) {
        const down = await composeDown(io, job.project).then(() => true, (e) => (io.log(`verify ${r.key}/${id}: ${e.message}`), false));
        if (!down) continue;
      }
      // A check can leave read-only dirs, which rm cannot empty; chmod -R skips symlinks.
      await write(io, ["chmod", "-R", "u+rwX", "--", join(dir, d)], undefined, SLOW_SECS).catch(() => {});
      // One stuck dir must not hold the slot for every other ticket; startVerify skips that ticket while it is there.
      await write(io, ["rm", "-rf", "--one-file-system", "--", join(dir, d)], undefined, SLOW_SECS).catch((e) => io.log(`verify ${r.key}/${id}: ${e.message}`));
    }
  }
  return false;
}

/** Asks systemd to stop the workspace's verifier, only while it runs `vdir`, without waiting; the next reconcile sees it gone. */
export async function stopVerify(cfg: Config, io: Io, vdir: string) {
  const out = await read(io, ["systemctl", "--user", "show", "--property=ActiveState,Description", verifyUnit(cfg)]);
  const p = Object.fromEntries(out.split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  if (!RUNNING.includes(p.ActiveState) || p.Description !== vdir) return;
  await write(io, ["systemctl", "--user", "stop", "--no-block", verifyUnit(cfg)]).catch((e) => {
    if (!/ not loaded\.$/.test(e.message)) throw e;
  });
}

/** Starts the verifier on the PR head when this contract has no result for it and the session is done; never waits for the run. */
export async function startVerify(cfg: Config, io: Io, r: Session, id: string, pr: any, verifier: { busy?: boolean }, done: () => Promise<boolean>, tenderDir: string) {
  const c = r.verify!;
  const dir = repoDir(cfg, r.key);
  const vdir = join(dir, `${id}.verify`);
  if (verifier.busy !== false || existsSync(vdir) || verifiedAt(readVerified(dir, id), pr.headRefOid, c)) return;
  if (pr.state !== "OPEN" || pr.isCrossRepository || pr.baseRefName !== r.baseBranch || !(await done())) return;
  // Also on `sandbox: none` hosts: the checks are agent-written code.
  if ((await io.run(["nono", "--version"])).code !== 0) throw new Kept("verify: nono is not installed, so no verify contract runs and merges wait");
  const n = Math.max(0, ...c.checks.map((x) => x.needs?.ports ?? 0));
  if (n) requireLandlock();
  const services = c.checks.some((x) => x.needs?.compose);
  if (services && !r.baseSha) throw new Error(`verify ${id}: no base commit to read compose files from`);
  await write(io, [...GIT, "-C", r.path, "fetch", "-q", "--no-tags", "origin", `refs/pull/${pr.number}/head`]);
  // A dry run fetched nothing, so FETCH_HEAD is some earlier fetch's.
  if (io.dry) return;
  const head = (await read(io, [...GIT, "-C", r.path, "rev-parse", "--verify", "FETCH_HEAD^{commit}"])).trim();
  if (head !== pr.headRefOid) return io.log(`verify ${id}: fetched ${head.slice(0, 12) || "nothing"} for PR #${pr.number}, not the head ${pr.headRefOid.slice(0, 12)} it was judged at; retried next poll`);
  const own = { ...(n && { ports: allocatePorts(cfg, n) }), ...(services && { project: composeProject(cfg, r.key, id, "verify"), baseSha: r.baseSha }) };
  put(io, join(vdir, "job.json"), JSON.stringify({ base: r.path, head, digest: c.digest, checks: c.checks, tenderDir, pr: pr.url, ...own } satisfies Job));
  verifier.busy = true;
  // A backstop only: each check has its own deadline (its services' start another), and stopping the unit kills everything a check left behind.
  const secs = c.checks.reduce((n, x) => n + x.timeout * (x.needs?.compose ? 2 : 1) + 10, SLOW_SECS);
  await write(io, ["systemd-run", "--user", "--quiet", "--collect", "--unit", verifyUnit(cfg), `--description=${vdir}`, "-p", `RuntimeMaxSec=${secs}`, `--setenv=PATH=${process.env.PATH ?? "/usr/bin:/bin"}`, "--", process.execPath, join(tenderDir, "src/review/verify.ts"), vdir]);
  io.log(`verify ${r.key}/${id}: started at ${head.slice(0, 12)}`);
}

// `_` is outside SAFE_ID, so no ticket's run, reconcile or Compose project shares it; reservedPorts still counts its ports.
const BASE = "_base";

async function discard(io: Io, vdir: string) {
  const job: Job | undefined = readJson(join(vdir, "job.json"), Infinity);
  if (job?.project) await composeDown(io, job.project);
  await write(io, ["chmod", "-R", "u+rwX", "--", vdir], undefined, SLOW_SECS).catch(() => {});
  await write(io, ["rm", "-rf", "--one-file-system", "--", vdir], undefined, SLOW_SECS);
}

/** `tender verify`: the contract at `origin/<base>` run on that same commit by the verifier, in the foreground; hold `.verify.lock` around it. */
export async function verifyBase(cfg: Config, io: Io, r: Repo, tenderDir: string): Promise<Verified> {
  const vdir = join(repoDir(cfg, r.key), `${BASE}.verify`);
  if (existsSync(vdir)) await discard(io, vdir);
  const keep = (e: Error) => io.log(`verify ${r.key}: ${e.message}; ${vdir} stays until the next tender verify`);
  // Each check runs under `timeout`, its own process group, which forwards the TERM to the whole group.
  const stop = (code: number) => (Bun.spawnSync(["pkill", "-TERM", "-P", String(process.pid)]), void discard(io, vdir).catch(keep).finally(() => process.exit(code)));
  const signals = ([["SIGINT", 130], ["SIGTERM", 143]] as const).map(([sig, code]) => [sig, () => stop(code)] as const);
  for (const [sig, h] of signals) process.once(sig, h);
  try {
    // Under the pass lock only while it fetches and takes ports, so the checks never hold up a poll.
    const job = await passLocked(cfg, io.log, async () => {
      if (!(await cloned(cfg, io, r))) throw new Error(`${r.key}: GitHub resolves it to another repo`);
      const s = await loadSession(io, r, SLOW_SECS);
      if (!s) throw new Error(`${r.key}: .tender/ on its base branch is invalid; see above`);
      const c = s.verify;
      if (!c) throw new Error(`${r.key}: no .tender/verify.yaml on origin/${s.baseBranch}`);
      if ((await io.run(["nono", "--version"])).code !== 0) throw new Error("verify: nono is not installed");
      const n = Math.max(0, ...c.checks.map((x) => x.needs?.ports ?? 0));
      if (n) requireLandlock();
      const services = c.checks.some((x) => x.needs?.compose);
      const j: Job = { base: r.path, head: s.baseSha!, digest: c.digest, checks: c.checks, tenderDir, ...(n && { ports: allocatePorts(cfg, n) }), ...(services && { project: composeProject(cfg, r.key, BASE, "verify"), baseSha: s.baseSha }) };
      put(io, join(vdir, "job.json"), JSON.stringify(j));
      return j;
    });
    io.log(`verify ${r.key}: ${job.checks.map((x) => x.name).join(", ")} at ${job.head.slice(0, 12)}`);
    await runVerify(vdir, io);
    return readFile(join(vdir, "result")) ?? { head: job.head, digest: job.digest, pass: false, check: "(verifier)", tail: "the run ended without a result" };
  } finally {
    for (const [sig, h] of signals) process.off(sig, h);
    await discard(io, vdir).catch(keep);
  }
}

const lastLines = (text: string) => {
  const lines = text.split("\n").map((l) => strip(l).trimEnd());
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines.slice(-LOG_LINES).join("\n").slice(-TAIL_CHARS) || "(no output)";
};

/** The verifier: a `--shared` clone of the base clone at the fetched head, each check in order under nono and its proof copied out, then `result`. */
export async function runVerify(vdir: string, io: Io) {
  const job: Job = JSON.parse(readFileSync(join(vdir, "job.json"), "utf8"));
  const clone = join(vdir, "clone");
  const tmp = join(vdir, "tmp");
  const finish = (r: object) => put(io, join(vdir, "result"), JSON.stringify({ head: job.head, digest: job.digest, ...r }));
  const proof = join(vdir, "proof");
  mkdirSync(join(tmp, "cache"), { recursive: true });
  mkdirSync(proof, { recursive: true });
  const b = budget();
  // Silent: nono's banner would push the check's own output out of the tail.
  const sandbox = (ports: number[] = []) => {
    const [nono, run, ...rest] = nonoRun("tender-verify", job.tenderDir, [["--allow", clone], ["--allow", tmp], ["--read", join(job.base, ".git", "objects")], ...portGrants(ports)]);
    return [nono!, run!, "--silent", ...rest];
  };
  // No host git or XDG config: it can hold credentials (http.extraHeader), and the profile cannot read it anyway.
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: io.home, LANG: "C.UTF-8", TMPDIR: tmp, TMP: tmp, TEMP: tmp, XDG_CACHE_HOME: join(tmp, "cache"), XDG_CONFIG_HOME: join(tmp, "config"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  try {
    await read(io, [...GIT, "-c", "protocol.file.allow=always", "clone", "-q", "--shared", "--no-checkout", "--", job.base, clone], undefined, SLOW_SECS);
    // The head's tree is agent-written, so even its checkout runs sandboxed and offline.
    const co = await io.run([...sandbox(), ...GIT, "-c", "advice.detachedHead=false", "-C", clone, "checkout", "-q", "--detach", job.head], clone, SLOW_SECS, { env });
    if (co.code !== 0) throw new Error(`git checkout ${job.head.slice(0, 12)}: ${co.err.trim() || `exit ${co.code}`}`);
    for (const c of job.checks) {
      const ports = (job.ports ?? []).slice(0, c.needs?.ports ?? 0);
      // Each start takes the last check's services down first; reconcile takes down the last ones.
      const up = c.needs?.compose && (await composeUp(io, { project: job.project!, repo: job.base, sha: job.baseSha!, file: c.needs.compose, ports }, join(vdir, "compose"), c.timeout).catch((e: Error) => e));
      if (up) return finish({ pass: false, check: c.name, tail: lastLines(up.message) });
      const res = await io.run(["bash", "-c", TAIL, "bash", ...sandbox(ports), "sh", "-c", c.run], clone, c.timeout, { env: { ...env, ...portEnv(ports) }, max: 128 * 1024 });
      if (res.code !== 0) return finish({ pass: false, check: c.name, tail: / timed out after \d+s/.test(res.err) ? `${c.name} timed out after ${c.timeout}s` : lastLines(`${res.out}\n${res.err}`) });
      // Outside the sandbox, right after its own check, before a later one can change the files.
      collectProof(clone, proof, c, b, io.log);
    }
    finish({ pass: true });
  } catch (e) {
    return finish({ pass: false, check: "(setup)", tail: lastLines((e as Error).message) });
  }
  // Here rather than in the poll, so a slow upload never holds it; tender's own gh login, never the sandbox's.
  if (job.pr) await postProof(io, job.pr, job.head, job.checks.map((c) => c.name), proof, b);
}

if (import.meta.main) {
  const { spawnRun } = await import("../../tender");
  await runVerify(process.argv[2]!, { run: spawnRun, fetch, dry: false, log: console.log, home: homedir() });
}
