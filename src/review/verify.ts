import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoDir } from "../config/config";
import { nonoRun, scopePrefix } from "../session/launcher";
import type { Config, Io, Session, VerifyCheck, VerifyContract } from "../types";
import { budget, collectProof, type Pending } from "./proof";
import { GIT, Kept, put, read, SAFE_ID, SLOW_SECS, strip, subdirs, write } from "../util";

/** `<ID>.verified`: the last verify result tender recorded, for one PR head and contract digest. */
export type Verified = { head: string; digest: string } & ({ pass: true } | { pass: false; check: string; tail: string });
type Job = { base: string; head: string; digest: string; checks: VerifyCheck[]; tenderDir: string; pr?: string };

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
      // The newest pass's staging replaces an older one still waiting to be posted.
      if (res?.pass && existsSync(join(dir, d, "proof", "pending.json")) && !io.dry)
        try {
          rmSync(join(dir, `${id}.proof`), { recursive: true, force: true });
          renameSync(join(dir, d, "proof"), join(dir, `${id}.proof`));
        } catch (e) {
          io.log(`verify ${r.key}/${id}: proof not staged: ${(e as Error).message}`);
        }
      io.log(`verify ${r.key}/${id}: ${res ? `${res.pass ? "passed" : `${res.check} failed`} at ${res.head.slice(0, 12)}` : "ended without a result or a job, so it runs again"}`);
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
  await write(io, [...GIT, "-C", r.path, "fetch", "-q", "--no-tags", "origin", `refs/pull/${pr.number}/head`]);
  // A dry run fetched nothing, so FETCH_HEAD is some earlier fetch's.
  if (io.dry) return;
  const head = (await read(io, [...GIT, "-C", r.path, "rev-parse", "--verify", "FETCH_HEAD^{commit}"])).trim();
  if (head !== pr.headRefOid) return io.log(`verify ${id}: fetched ${head.slice(0, 12) || "nothing"} for PR #${pr.number}, not the head ${pr.headRefOid.slice(0, 12)} it was judged at; retried next poll`);
  put(io, join(vdir, "job.json"), JSON.stringify({ base: r.path, head, digest: c.digest, checks: c.checks, tenderDir, pr: pr.url } satisfies Job));
  verifier.busy = true;
  // A backstop only: each check has its own deadline, and stopping the unit kills everything a check left behind.
  const secs = c.checks.reduce((n, x) => n + x.timeout + 10, SLOW_SECS);
  await write(io, ["systemd-run", "--user", "--quiet", "--collect", "--unit", verifyUnit(cfg), `--description=${vdir}`, "-p", `RuntimeMaxSec=${secs}`, `--setenv=PATH=${process.env.PATH ?? "/usr/bin:/bin"}`, "--", process.execPath, join(tenderDir, "src/review/verify.ts"), vdir]);
  io.log(`verify ${r.key}/${id}: started at ${head.slice(0, 12)}`);
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
  const [nono, run, ...rest] = nonoRun("tender-verify", job.tenderDir, [["--allow", clone], ["--allow", tmp], ["--read", join(job.base, ".git", "objects")]]);
  // Silent: nono's banner would push the check's own output out of the tail.
  const box = [nono!, run!, "--silent", ...rest];
  // No host git or XDG config: it can hold credentials (http.extraHeader), and the profile cannot read it anyway.
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: io.home, LANG: "C.UTF-8", TMPDIR: tmp, TMP: tmp, TEMP: tmp, XDG_CACHE_HOME: join(tmp, "cache"), XDG_CONFIG_HOME: join(tmp, "config"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  try {
    await read(io, [...GIT, "-c", "protocol.file.allow=always", "clone", "-q", "--shared", "--no-checkout", "--", job.base, clone], undefined, SLOW_SECS);
    // The head's tree is agent-written, so even its checkout runs sandboxed and offline.
    const co = await io.run([...box, ...GIT, "-c", "advice.detachedHead=false", "-C", clone, "checkout", "-q", "--detach", job.head], clone, SLOW_SECS, { env });
    if (co.code !== 0) throw new Error(`git checkout ${job.head.slice(0, 12)}: ${co.err.trim() || `exit ${co.code}`}`);
    for (const c of job.checks) {
      const res = await io.run(["bash", "-c", TAIL, "bash", ...box, "sh", "-c", c.run], clone, c.timeout, { env, max: 128 * 1024 });
      if (res.code !== 0) return finish({ pass: false, check: c.name, tail: / timed out after \d+s/.test(res.err) ? `${c.name} timed out after ${c.timeout}s` : lastLines(`${res.out}\n${res.err}`) });
      // Outside the sandbox, right after its own check, before a later one can change the files.
      collectProof(clone, proof, c, b, io.log);
    }
    if (job.pr) put(io, join(proof, "pending.json"), JSON.stringify({ pr: job.pr, head: job.head, checks: job.checks.map((c) => c.name), files: b.files, skipped: b.skipped } satisfies Pending));
    finish({ pass: true });
  } catch (e) {
    finish({ pass: false, check: "(setup)", tail: lastLines((e as Error).message) });
  }
}

if (import.meta.main) {
  const { spawnRun } = await import("../../tender");
  await runVerify(process.argv[2]!, { run: spawnRun, fetch, dry: false, log: console.log, home: homedir() });
}
