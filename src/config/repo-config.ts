import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { AUTO_MERGE, GLOB_RULES, INTAKE_NAME, validGlob } from "./config";
import { agentConfig, defaultProfile, mergeTypes, parseNeeds, parseTypes, repoPath } from "./profile";
import { baseBranch } from "../github";
import type { AutoMerge, Check, IntakeRule, Io, Profile, Repo, RepoConfig, Session, TaskType, VerifyContract } from "../types";
import { GIT, read, TENDER_DIR, write } from "../util";

const MAX_FILE = 64 * 1024;
const KEYS = ["agent", "autoMerge", "feedback", "criticalPaths", "testPaths", "trust", "escapeHatches", "types", "tracker", "intake"];
const MAX_HATCHES = 20;
const MAX_HATCH_CHARS = 200;

/** A file under `.tender/`, `name` relative to it (`.` for `.tender` itself); `text` only for a regular file within the size cap. */
export interface Entry {
  name: string;
  regular: boolean;
  size: number;
  text?: string;
}

const wanted = (name: string) => name === "config.yaml" || name === "verify.yaml";

/** Validates a repo's `.tender/config.yaml` and `verify.yaml`, its `types` against `profile`; throws listing every problem. */
export function parseRepoConfig(entries: Entry[], profile: Profile = defaultProfile()): RepoConfig {
  const errs: string[] = [];
  const check = (ok: unknown, msg: string) => ok || errs.push(msg);
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
  let yaml: string | undefined;
  let verify: string | undefined;
  for (const e of entries) {
    if (e.name === ".") errs.push(".tender: must be a directory");
    else if (!wanted(e.name)) errs.push(`${e.name}: not expected here`);
    else if (!e.regular) errs.push(`${e.name}: must be a regular file`);
    else if (e.size > MAX_FILE || e.text === undefined) errs.push(`${e.name}: over 64 KiB`);
    else if (e.name === "config.yaml") yaml = e.text;
    else verify = e.text;
  }
  let raw: any = {};
  try {
    raw = yaml === undefined ? {} : (Bun.YAML.parse(yaml) ?? {});
  } catch (e) {
    errs.push(`config.yaml: ${(e as Error).message}`);
  }
  check(obj(raw), "config.yaml: must be a mapping");
  raw = obj(raw) ? raw : {};
  for (const k of Object.keys(raw)) check(KEYS.includes(k), `${k}: unknown key`);
  const agent = agentConfig(raw.agent === undefined ? "claude" : raw.agent, "agent", check);
  const fb = raw.feedback;
  check(fb === undefined || (obj(fb) && Object.keys(fb).every((k) => k === "maxRounds")), "feedback: mapping with maxRounds");
  if (obj(fb)) check(Number.isInteger(fb.maxRounds) && fb.maxRounds >= 1 && fb.maxRounds <= 10, "feedback.maxRounds: integer 1-10");
  const c: RepoConfig = {
    agent: agent.name,
    model: agent.model,
    effort: agent.effort,
    autoMerge: raw.autoMerge,
    criticalPaths: raw.criticalPaths === undefined ? [] : raw.criticalPaths,
    testPaths: raw.testPaths === undefined ? [] : raw.testPaths,
    trust: raw.trust === undefined ? [] : raw.trust,
    escapeHatches: raw.escapeHatches === undefined ? [] : raw.escapeHatches,
    types: mergeTypes(profile.types, raw.types === undefined ? [] : parseTypes(raw.types, "types", profile.dir, check)),
    tracker: raw.tracker,
    intake: parseIntake(raw.intake, check),
    feedbackRounds: obj(fb) ? fb.maxRounds : undefined,
    verify: verify === undefined ? undefined : parseVerify(verify, check),
  };
  const modes = AUTO_MERGE.map((m) => `"${m}"`).join(" | ");
  check(c.autoMerge === undefined || AUTO_MERGE.includes(c.autoMerge), `autoMerge: ${modes}`);
  for (const k of ["criticalPaths", "testPaths"] as const) check(Array.isArray(c[k]) && c[k].every(validGlob), `${k}: list of non-empty glob strings (${GLOB_RULES})`);
  check(Array.isArray(c.trust) && c.trust.every((t) => obj(t) && Object.keys(t).every((k) => ["paths", "autoMerge"].includes(k)) && Array.isArray(t.paths) && t.paths.length > 0 && t.paths.every(validGlob) && AUTO_MERGE.includes(t.autoMerge)), `trust: list of { paths: [glob, …], autoMerge: ${modes} } (${GLOB_RULES})`);
  const regex = (p: unknown) => {
    try {
      return str(p) && p.length <= MAX_HATCH_CHARS && !!new RegExp(p);
    } catch {
      return false;
    }
  };
  // Run on agent-written lines in a worker with a time limit, so a backtracking pattern stalls only its own check.
  check(Array.isArray(c.escapeHatches) && c.escapeHatches.length <= MAX_HATCHES && c.escapeHatches.every(regex), `escapeHatches: at most ${MAX_HATCHES} valid regexes of at most ${MAX_HATCH_CHARS} chars`);
  const lt = obj(c.tracker) ? c.tracker.linear : undefined;
  check(c.tracker === undefined || (obj(c.tracker) && Object.keys(c.tracker).every((k) => k === "linear")), "tracker: mapping with linear");
  check(lt === undefined || (obj(lt) && Object.keys(lt).every((k) => ["project", "team"].includes(k))), "tracker.linear: mapping with project and team");
  if (obj(lt)) check(str(lt.project), "tracker.linear.project: non-empty string, the Linear project's name");
  if (obj(lt)) check(lt.team === undefined || (str(lt.team) && /^[A-Z0-9]+$/.test(lt.team)), "tracker.linear.team: Linear team key, e.g. ENG");
  if (errs.length) throw new Error(errs.join("\n  "));
  // tender runs it through the Docker daemon, which is host root, so a change to it never auto-merges.
  const compose = [...c.types, ...(c.verify?.checks ?? [])].flatMap((x) => x.needs?.compose ?? []);
  c.criticalPaths = [...new Set([...c.criticalPaths, ...compose])];
  return c;
}

// What `gh --attach` uploads.
const PROOF = /\.(png|gif|jpe?g|webp|svg|mp4|mov|webm)$/i;

function parseVerify(yaml: string, check: Check): VerifyContract {
  const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
  let raw: any;
  try {
    raw = Bun.YAML.parse(yaml);
  } catch (e) {
    check(false, `verify.yaml: ${(e as Error).message}`);
  }
  check(obj(raw), "verify.yaml: must be a mapping with checks and maxRounds");
  const o: Record<string, any> = obj(raw) ? raw : {};
  for (const k of Object.keys(o)) check(["checks", "maxRounds"].includes(k), `verify.${k}: unknown key`);
  const maxRounds = o.maxRounds ?? 2;
  check(Number.isInteger(maxRounds) && maxRounds >= 1 && maxRounds <= 10, "verify.maxRounds: integer 1-10");
  check(Array.isArray(o.checks) && o.checks.length > 0 && o.checks.length <= 20, "verify.checks: list of 1-20 checks");
  const checks = (Array.isArray(o.checks) ? o.checks : []).map((c: unknown, i: number) => {
    const at = `verify.checks[${i}]${obj(c) && typeof c.name === "string" ? ` (${c.name})` : ""}`;
    check(obj(c), `${at}: mapping`);
    const x: Record<string, any> = obj(c) ? c : {};
    for (const k of Object.keys(x)) check(["name", "run", "timeout", "proof", "needs"].includes(k), `${at}.${k}: unknown key`);
    const v = { name: x.name, run: x.run, timeout: x.timeout ?? 600, proof: x.proof ?? [] };
    check(typeof v.name === "string" && INTAKE_NAME.test(v.name), `${at}.name: required, [a-z0-9-]`);
    check(typeof v.run === "string" && v.run.trim().length > 0 && v.run.length <= 4000 && !v.run.includes("\0"), `${at}.run: required, a shell command of at most 4000 chars`);
    check(Number.isInteger(v.timeout) && v.timeout >= 1 && v.timeout <= 1800, `${at}.timeout: seconds, integer 1-1800`);
    check(Array.isArray(v.proof) && v.proof.length <= 20 && v.proof.every((g: unknown) => validGlob(g) && PROOF.test(g)), `${at}.proof: at most 20 globs (${GLOB_RULES}) ending in .png, .gif, .jpg, .jpeg, .webp, .svg, .mp4, .mov or .webm`);
    const needs = parseNeeds(x.needs, `${at}.needs`, check);
    return needs ? { ...v, needs } : v;
  });
  check(new Set(checks.map((c: { name: string }) => c.name)).size === checks.length, "verify.checks: names must be unique");
  return { checks, maxRounds, digest: createHash("sha256").update(yaml).digest("hex") };
}

const INTAKE_KEYS = ["name", "run", "args", "every", "maxPerRun", "secrets", "network", "autoLabel", "labels", "recheck", "recheckAfter", "private", "loopback", "judge"];
export const DURATION = /^([1-9]\d{0,3})([mhd])$/;
/** A `categories` fact listing SECURITY, as splinter's lints do: such a finding never gets the ready label. */
export const securityFact = (v: unknown) => typeof v === "string" && v.toUpperCase().split(",").some((c) => c.trim() === "SECURITY");
const SECRET = /^[A-Z][A-Z0-9_]{0,63}$/;
// No gh token and no tracker key ever reach a script; the rest is the environment tender sets itself.
const RESERVED = /^(GH|GITHUB|LINEAR|TENDER|NONO|CLAUDE|ANTHROPIC|OPENAI|CODEX)_|^(PATH|HOME|LANG|TZ|TMPDIR|TMP|TEMP)$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const FACT = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
// No comma (gh --label splits on it) and no colon, so never host:<host>.
const LABEL = /^(?=.{1,50}$)[\w./-]+( [\w./-]+)*$/;

function parseIntake(raw: unknown, check: Check): IntakeRule[] {
  if (raw === undefined) return [];
  const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
  const list = (v: unknown, ok: (x: unknown) => boolean, max = 20) => Array.isArray(v) && v.length <= max && v.every(ok);
  check(Array.isArray(raw) && raw.length <= 20, "intake: list of at most 20 rules");
  if (!Array.isArray(raw)) return [];
  const rules = raw.map((r, i): IntakeRule => {
    const at = `intake[${i}]${obj(r) && typeof r.name === "string" ? ` (${r.name})` : ""}`;
    check(obj(r), `${at}: mapping`);
    const o: Record<string, any> = obj(r) ? r : {};
    for (const k of Object.keys(o)) check(INTAKE_KEYS.includes(k), `${at}.${k}: unknown key`);
    const rule: IntakeRule = { name: o.name, run: o.run, args: o.args ?? [], every: o.every ?? "1h", maxPerRun: o.maxPerRun ?? 3, secrets: o.secrets ?? [], network: o.network ?? [], autoLabel: o.autoLabel ?? [], labels: o.labels ?? [], recheck: o.recheck ?? true, recheckAfter: o.recheckAfter ?? "24h", private: o.private ?? false, loopback: o.loopback ?? false };
    check(typeof rule.name === "string" && INTAKE_NAME.test(rule.name), `${at}.name: required, [a-z0-9-]`);
    check(repoPath(rule.run), `${at}.run: required, a path inside the repo`);
    check(list(rule.args, (x) => typeof x === "string" && x.length <= 200 && !/\p{Cc}/u.test(x)), `${at}.args: at most 20 strings of at most 200 chars, no control characters`);
    for (const k of ["every", "recheckAfter"] as const) check(typeof rule[k] === "string" && DURATION.test(rule[k]), `${at}.${k}: duration like 15m, 1h or 1d`);
    check(Number.isInteger(rule.maxPerRun) && rule.maxPerRun > 0 && rule.maxPerRun <= 20, `${at}.maxPerRun: integer 1-20`);
    check(list(rule.secrets, (x) => typeof x === "string" && SECRET.test(x) && !RESERVED.test(x)), `${at}.secrets: env var names (no GH_, GITHUB_, LINEAR_ or other reserved names)`);
    check(list(rule.network, (x) => typeof x === "string" && DOMAIN.test(x)), `${at}.network: list of lowercase host names the script may reach`);
    check(list(rule.autoLabel, (x) => obj(x) && Object.keys(x).length > 0 && Object.entries(x).every(([k, v]) => FACT.test(k) && (typeof v === "string" || Number.isFinite(v)))), `${at}.autoLabel: list of { fact: value, minFact: number } rules`);
    check(list(rule.labels, (x) => typeof x === "string" && LABEL.test(x), 5), `${at}.labels: at most 5 label names, no commas or colons`);
    for (const k of ["recheck", "private", "loopback"] as const) check(typeof rule[k] === "boolean", `${at}.${k}: boolean`);
    const j = o.judge;
    const unit = (v: unknown) => typeof v === "number" && v >= 0 && v <= 1;
    check(j === undefined || (obj(j) && Object.keys(j).every((k) => ["minWorth", "minFixable"].includes(k)) && unit(j.minWorth) && unit(j.minFixable)), `${at}.judge: { minWorth, minFixable }, both numbers 0-1`);
    if (obj(j)) rule.judge = { minWorth: j.minWorth, minFixable: j.minFixable };
    check(!Array.isArray(rule.autoLabel) || !rule.autoLabel.some((x) => obj(x) && securityFact(x.categories)), `${at}.autoLabel: a SECURITY finding never gets the ready label; a human decides access policies`);
    return rule;
  });
  check(new Set(rules.map((r) => r.name)).size === rules.length, "intake: rule names must be unique");
  return rules;
}

/** The prompt template for a ticket of type `t`: tender's header, the type's instruction file, then tender's protocol. */
export function promptFor(t: TaskType) {
  // Stored as a realpath inside the profile, so an unchanged realpath means no symlink was swapped in since.
  if (realpathSync(t.instructions) !== t.instructions || !statSync(t.instructions).isFile()) throw new Error(`${t.instructions}: changed since the profile was read; restore it or restart tender`);
  return [join(TENDER_DIR, "prompts/header.md"), t.instructions, join(TENDER_DIR, "prompts/protocol.md")].map((f) => readFileSync(f, "utf8").trim()).join("\n\n") + "\n";
}

/** `.tender/` entries at commit `sha` of the clone at `path`. */
export async function gitEntries(io: Io, path: string, sha: string): Promise<Entry[]> {
  const top = await read(io, [...GIT, "-C", path, "ls-tree", "-z", sha, "--", ".tender"]);
  if (top && !top.startsWith("040000 tree ")) return [{ name: ".", regular: false, size: 0 }];
  const out = await read(io, [...GIT, "-C", path, "ls-tree", "-r", "-z", "--long", sha, "--", ".tender/config.yaml", ".tender/verify.yaml"]);
  const entries: Entry[] = [];
  for (const line of out.split("\0").filter(Boolean)) {
    const m = /^(\d+) (\w+) ([0-9a-f]+) +(-|\d+)\t\.tender\/(.+)$/s.exec(line);
    if (!m) throw new Error(`git ls-tree: unexpected output ${JSON.stringify(line.slice(0, 100))}`);
    const [, mode, type, oid, size, name] = m;
    const e: Entry = { name: name!, regular: type === "blob" && ["100644", "100755"].includes(mode!), size: size === "-" ? 0 : Number(size) };
    if (e.regular && e.size <= MAX_FILE && wanted(e.name)) e.text = await read(io, [...GIT, "-C", path, "cat-file", "blob", oid!]);
    entries.push(e);
  }
  return entries;
}

/** `.tender/` entries in a working tree, for `tender check`. */
export function dirEntries(dir: string, names = ["config.yaml", "verify.yaml"]): Entry[] {
  const top = lstatSync(join(dir, ".tender"), { throwIfNoEntry: false });
  if (top && !top.isDirectory()) return [{ name: ".", regular: false, size: 0 }];
  const at = (name: string): Entry[] => {
    const st = lstatSync(join(dir, ".tender", name), { throwIfNoEntry: false });
    if (!st) return [];
    const ok = st.isFile() && st.size <= MAX_FILE && wanted(name);
    return [{ name, regular: st.isFile(), size: st.size, text: ok ? readFileSync(join(dir, ".tender", name), "utf8") : undefined }];
  };
  return names.flatMap(at);
}

export const configCache = new Map<string, { sha: string; committed: Entry[]; own?: string; config?: RepoConfig; error?: string; logged?: boolean }>();

/** The repo's `.tender/` at `origin/<base>` in its clone, never a worktree; when that commit has no config.yaml, the host checkout's own (personal: no PR writes it), re-read when it changes. */
export async function repoConfig(io: Io, r: Repo, base: string) {
  const sha = (await read(io, [...GIT, "-C", r.path, "rev-parse", "--verify", `refs/remotes/origin/${base}^{commit}`])).trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`${r.key}: no origin/${base} in ${r.path}`);
  const hit = configCache.get(r.key);
  const committed = hit?.sha === sha ? hit.committed : await gitEntries(io, r.path, sha);
  // Fails closed: an unreadable personal file makes the config invalid rather than dropping its policy.
  let mine: Entry[] | Error = [];
  if (!committed.some((e) => e.name === "config.yaml"))
    try {
      mine = dirEntries(r.path, ["config.yaml"]);
    } catch (e) {
      mine = e as Error;
    }
  const own = mine instanceof Error ? `error: ${mine.message}` : mine.length ? JSON.stringify(mine) : undefined;
  if (hit?.sha === sha && hit.own === own) return hit;
  let c: NonNullable<typeof hit>;
  try {
    if (mine instanceof Error) throw mine;
    c = { sha, committed, own, config: parseRepoConfig([...committed, ...mine], r.profile) };
  } catch (e) {
    c = { sha, committed, own, error: (e as Error).message };
  }
  configCache.set(r.key, c);
  return c;
}

const rank = (m: AutoMerge) => AUTO_MERGE.indexOf(m);

/** Host settings plus the repo's config: autoMerge is the lower of the repo's request and the host's ceiling, which also caps trust rules; critical paths add up. */
export function combine(r: Repo, base: string, c: RepoConfig): Session {
  const { baseBranch: _, ...host } = r;
  return { ...host, ...c, feedbackRounds: c.feedbackRounds ?? r.feedbackRounds, baseBranch: base, ceiling: r.autoMerge, criticalPaths: [...r.criticalPaths, ...c.criticalPaths], autoMerge: c.autoMerge !== undefined && rank(c.autoMerge) < rank(r.autoMerge) ? c.autoMerge : r.autoMerge };
}

/** Whether `origin/<base>` is still the commit `s` read `.tender/` at; a failed lookup throws. */
export const atTip = async (io: Io, s: Session) => (await read(io, [...GIT, "-C", s.path, "ls-remote", "origin", `refs/heads/${s.baseBranch}`])).split("\t")[0] === s.baseSha;

/** Fetches `origin/<base>` into the clone, then the settings there; undefined if the repo's config is invalid, logged once per commit. */
export async function loadSession(io: Io, r: Repo, secs?: number): Promise<Session | undefined> {
  const base = await baseBranch(io, r);
  await write(io, [...GIT, "-C", r.path, "fetch", "origin", base], undefined, secs);
  const c = await repoConfig(io, r, base);
  if (c.config) return { ...combine(r, base, c.config), baseSha: c.sha };
  if (!c.logged) io.log(`${r.key}: .tender/ on ${base} at ${c.sha.slice(0, 12)} is invalid, so no tickets start:\n  ${c.error}`);
  c.logged = true;
}
