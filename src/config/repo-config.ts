import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTO_MERGE, INTAKE_NAME } from "./config";
import { baseBranch } from "../github";
import { EFFORTS, MODEL } from "../session/agents";
import type { AgentConfig, AgentName, AutoMerge, Check, IntakeRule, Io, PromptSet, PromptText, Repo, RepoConfig, Session } from "../types";
import { GIT, hasLabel, read, TENDER_DIR, write } from "../util";

const MAX_FILE = 64 * 1024;
const PROMPT = /^[a-z0-9-]+\.md$/;
const KEYS = ["agent", "testCmd", "autoMerge", "feedback", "criticalPaths", "testPaths", "trust", "escapeHatches", "prompt", "byLabel", "tracker", "intake"];
const RETIRED: Record<string, string> = { planStep: "moved to prompt.steps.plan", prompts: "replaced by prompt and byLabel" };
export const STEPS = ["clarify", "plan", "test", "verify", "review", "commit"];
const MAX_PROMPT_TEXT = 32 * 1024;
const MAX_HATCHES = 20;
const MAX_HATCH_CHARS = 200;

/** A file under `.tender/`, `name` relative to it (`.` for `.tender` itself); `text` only for a regular file within the size cap. */
export interface Entry {
  name: string;
  regular: boolean;
  size: number;
  text?: string;
}

const wanted = (name: string) => name === "config.yaml" || (name.startsWith("prompts/") && PROMPT.test(name.slice(8)));

/** Validates a repo's `.tender/config.yaml` and prompts; throws listing every problem. */
export function parseRepoConfig(entries: Entry[]): RepoConfig {
  const errs: string[] = [];
  const check = (ok: unknown, msg: string) => ok || errs.push(msg);
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
  const files: Record<string, string> = {};
  let yaml: string | undefined;
  for (const e of entries) {
    if (e.name === ".") errs.push(".tender: must be a directory");
    else if (e.name === "prompts/default.md") errs.push(`${e.name}: no longer replaces tender's prompt; move your changes into prompt.steps and prompt.append (see docs/upgrading.md)`);
    else if (!wanted(e.name)) errs.push(e.name.startsWith("prompts/") ? `${e.name}: prompt files must be named [a-z0-9-]+.md` : `${e.name}: not expected here`);
    else if (!e.regular) errs.push(`${e.name}: must be a regular file`);
    else if (e.size > MAX_FILE || e.text === undefined) errs.push(`${e.name}: over 64 KiB`);
    else if (e.name === "config.yaml") yaml = e.text;
    else files[e.name.slice(8)] = e.text;
  }
  let raw: any = {};
  try {
    raw = yaml === undefined ? {} : (Bun.YAML.parse(yaml) ?? {});
  } catch (e) {
    errs.push(`config.yaml: ${(e as Error).message}`);
  }
  check(obj(raw), "config.yaml: must be a mapping");
  raw = obj(raw) ? raw : {};
  for (const k of Object.keys(raw)) check(KEYS.includes(k), Object.hasOwn(RETIRED, k) ? `${k}: ${RETIRED[k]} (see docs/upgrading.md)` : `${k}: unknown key`);
  const text = (t: unknown, at: string) => {
    if (typeof t === "string") check(!/^\S+\.md$/.test(t.trim()), `${at}: ${JSON.stringify(t)} is a file name; write { file: <name>.md } to use a file in .tender/prompts/`);
    else if (obj(t) && Object.keys(t).length === 1 && str(t.file)) check(Object.hasOwn(files, t.file), `${at}: ${JSON.stringify(t.file)} is not a file in .tender/prompts/`);
    else errs.push(`${at}: text, "" to drop the step, or { file: <name>.md }`);
  };
  const promptSet = (p: unknown, at: string): PromptSet => {
    if (p === undefined) return { steps: {} };
    if (!obj(p) || !Object.keys(p).every((k) => ["steps", "append"].includes(k)) || !(p.steps === undefined || obj(p.steps))) return (errs.push(`${at}: mapping with steps and append`), { steps: {} });
    const steps = p.steps ?? {};
    for (const [n, t] of Object.entries(steps)) STEPS.includes(n) ? text(t, `${at}.steps.${n}`) : errs.push(`${at}.steps.${n}: unknown step; steps are ${STEPS.join(", ")}`);
    if (p.append !== undefined) text(p.append, `${at}.append`);
    return { steps, append: p.append };
  };
  const agentConfig = (a: unknown, at: string): AgentConfig => {
    if (typeof a === "string") return (check(a === "claude" || a === "codex", `${at}: "claude" | "codex" or { name, model, effort }`), { name: a as AgentName });
    if (!obj(a)) return (errs.push(`${at}: "claude" | "codex" or { name, model, effort }`), { name: "claude" });
    check(Object.keys(a).every((k) => ["name", "model", "effort"].includes(k)), `${at}: mapping with name, model and effort`);
    const known = a.name === "claude" || a.name === "codex";
    check(known, `${at}.name: "claude" | "codex"`);
    check(a.model === undefined || (typeof a.model === "string" && MODEL.test(a.model)), `${at}.model: model name like sonnet or gpt-5 ([A-Za-z0-9._:[]/-], at most 100 chars)`);
    if (known) check(a.effort === undefined || EFFORTS[a.name as AgentName].includes(a.effort), `${at}.effort: ${EFFORTS[a.name as AgentName].join(" | ")} for ${a.name}`);
    return { name: a.name, model: a.model, effort: a.effort };
  };
  const agent = agentConfig(raw.agent === undefined ? "claude" : raw.agent, "agent");
  const fb = raw.feedback;
  check(fb === undefined || (obj(fb) && Object.keys(fb).every((k) => k === "maxRounds")), "feedback: mapping with maxRounds");
  if (obj(fb)) check(Number.isInteger(fb.maxRounds) && fb.maxRounds >= 1 && fb.maxRounds <= 10, "feedback.maxRounds: integer 1-10");
  const byLabel = raw.byLabel === undefined ? {} : raw.byLabel;
  check(obj(byLabel), "byLabel: mapping of label to { prompt, agent }");
  const c: RepoConfig = {
    agent: agent.name,
    model: agent.model,
    effort: agent.effort,
    testCmd: raw.testCmd,
    autoMerge: raw.autoMerge,
    criticalPaths: raw.criticalPaths === undefined ? [] : raw.criticalPaths,
    testPaths: raw.testPaths === undefined ? [] : raw.testPaths,
    trust: raw.trust === undefined ? [] : raw.trust,
    escapeHatches: raw.escapeHatches === undefined ? [] : raw.escapeHatches,
    prompt: promptSet(raw.prompt, "prompt"),
    byLabel: {},
    tracker: raw.tracker,
    intake: parseIntake(raw.intake, check),
    feedbackRounds: obj(fb) ? fb.maxRounds : undefined,
    files,
  };
  check(c.testCmd === undefined || str(c.testCmd), "testCmd: non-empty string");
  const modes = AUTO_MERGE.map((m) => `"${m}"`).join(" | ");
  check(c.autoMerge === undefined || AUTO_MERGE.includes(c.autoMerge), `autoMerge: ${modes}`);
  for (const k of ["criticalPaths", "testPaths"] as const) check(Array.isArray(c[k]) && c[k].every(str), `${k}: list of non-empty glob strings`);
  check(Array.isArray(c.trust) && c.trust.every((t) => obj(t) && Object.keys(t).every((k) => ["paths", "autoMerge"].includes(k)) && Array.isArray(t.paths) && t.paths.length > 0 && t.paths.every(str) && AUTO_MERGE.includes(t.autoMerge)), `trust: list of { paths: [glob, …], autoMerge: ${modes} }`);
  const regex = (p: unknown) => {
    try {
      return str(p) && p.length <= MAX_HATCH_CHARS && !!new RegExp(p);
    } catch {
      return false;
    }
  };
  // Run on agent-written lines in a worker with a time limit, so a backtracking pattern stalls only its own check.
  check(Array.isArray(c.escapeHatches) && c.escapeHatches.length <= MAX_HATCHES && c.escapeHatches.every(regex), `escapeHatches: at most ${MAX_HATCHES} valid regexes of at most ${MAX_HATCH_CHARS} chars`);
  // fromEntries, not assignment, so a `__proto__` label stays an own entry.
  c.byLabel = Object.fromEntries(
    Object.entries(obj(byLabel) ? byLabel : {}).flatMap(([l, e]) => {
      if (str(l) && obj(e) && Object.keys(e).every((k) => k === "prompt" || k === "agent"))
        return [[l, { ...(e.prompt !== undefined && { prompt: promptSet(e.prompt, `byLabel.${l}.prompt`) }), ...(e.agent !== undefined && { agent: agentConfig(e.agent, `byLabel.${l}.agent`) }) }]];
      errs.push(`byLabel.${l}: mapping with prompt and agent`);
      return [];
    }),
  );
  const size = (p: PromptSet) => [...Object.values(p.steps), p.append].reduce((n, t) => n + Buffer.byteLength(resolve(files, t)), 0);
  if (!errs.length) check(size(c.prompt) <= MAX_PROMPT_TEXT, "prompt: steps and append over 32 KiB");
  if (!errs.length) for (const [l, e] of Object.entries(c.byLabel)) check(size(merged(c.prompt, e.prompt)) <= MAX_PROMPT_TEXT, `byLabel.${l}.prompt: steps and append over 32 KiB with prompt's`);
  const lt = obj(c.tracker) ? c.tracker.linear : undefined;
  check(c.tracker === undefined || (obj(c.tracker) && Object.keys(c.tracker).every((k) => k === "linear")), "tracker: mapping with linear");
  check(lt === undefined || (obj(lt) && Object.keys(lt).every((k) => ["project", "team"].includes(k))), "tracker.linear: mapping with project and team");
  if (obj(lt)) check(str(lt.project), "tracker.linear.project: non-empty string, the Linear project's name");
  if (obj(lt)) check(lt.team === undefined || (str(lt.team) && /^[A-Z0-9]+$/.test(lt.team)), "tracker.linear.team: Linear team key, e.g. ENG");
  if (errs.length) throw new Error(errs.join("\n  "));
  return c;
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
const repoPath = (p: unknown) => typeof p === "string" && p.length <= 200 && p.split("/").every((x) => /^[A-Za-z0-9_.-]+$/.test(x) && x !== "." && x !== "..") && !p.startsWith("-");

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

const resolve = (files: Record<string, string>, t?: PromptText) => (t === undefined ? "" : typeof t === "string" ? t : (files[t.file] ?? ""));
const merged = (base: PromptSet, label?: PromptSet): PromptSet => ({ steps: { ...base.steps, ...label?.steps }, append: label?.append ?? base.append });

/** The `byLabel` entry of the first label the ticket has, case-insensitively. */
export const labelFor = (c: RepoConfig, labels?: string[]) => Object.entries(c.byLabel).find(([l]) => hasLabel(labels, l))?.[1];

/** The prompt template for a ticket: tender's header, the steps (label over repo over tender's), the repo's append, then tender's protocol. */
export function promptFor(c: RepoConfig, labels: string[] = []) {
  const p = merged(c.prompt, labelFor(c, labels)?.prompt);
  const tender = (name: string) => readFileSync(join(TENDER_DIR, "prompts", name), "utf8").trim();
  const steps = STEPS.map((n) => [n, Object.hasOwn(p.steps, n) ? resolve(c.files, p.steps[n]).trim() : tender(`steps/${n}.md`)]).filter(([, t]) => t);
  return [tender("header.md"), ...steps.map(([n, t]) => `### ${n}\n\n${t}`), resolve(c.files, p.append).trim(), tender("protocol.md")].filter(Boolean).join("\n\n") + "\n";
}

/** `.tender/` entries at commit `sha` of the clone at `path`. */
export async function gitEntries(io: Io, path: string, sha: string): Promise<Entry[]> {
  const top = await read(io, [...GIT, "-C", path, "ls-tree", "-z", sha, "--", ".tender"]);
  if (top && !top.startsWith("040000 tree ")) return [{ name: ".", regular: false, size: 0 }];
  const out = await read(io, [...GIT, "-C", path, "ls-tree", "-r", "-z", "--long", sha, "--", ".tender/config.yaml", ".tender/prompts"]);
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
export function dirEntries(dir: string): Entry[] {
  const top = lstatSync(join(dir, ".tender"), { throwIfNoEntry: false });
  if (top && !top.isDirectory()) return [{ name: ".", regular: false, size: 0 }];
  const at = (name: string): Entry[] => {
    const st = lstatSync(join(dir, ".tender", name), { throwIfNoEntry: false });
    if (!st) return [];
    const ok = st.isFile() && st.size <= MAX_FILE && wanted(name);
    return [{ name, regular: st.isFile(), size: st.size, text: ok ? readFileSync(join(dir, ".tender", name), "utf8") : undefined }];
  };
  const prompts = lstatSync(join(dir, ".tender/prompts"), { throwIfNoEntry: false });
  const names = prompts?.isDirectory() ? readdirSync(join(dir, ".tender/prompts")).sort().map((n) => `prompts/${n}`) : prompts ? ["prompts"] : [];
  return [...at("config.yaml"), ...names.flatMap((n) => (n === "prompts" ? [{ name: n, regular: false, size: 0 }] : at(n)))];
}

export const configCache = new Map<string, { sha: string; config?: RepoConfig; error?: string; logged?: boolean }>();

/** The repo's `.tender/` at `origin/<base>` in its clone, never a worktree; re-read only when that commit moves. */
export async function repoConfig(io: Io, r: Repo, base: string) {
  const sha = (await read(io, [...GIT, "-C", r.path, "rev-parse", "--verify", `refs/remotes/origin/${base}^{commit}`])).trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`${r.key}: no origin/${base} in ${r.path}`);
  const hit = configCache.get(r.key);
  if (hit?.sha === sha) return hit;
  const entries = await gitEntries(io, r.path, sha);
  let c: NonNullable<typeof hit>;
  try {
    c = { sha, config: parseRepoConfig(entries) };
  } catch (e) {
    c = { sha, error: (e as Error).message };
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

/** Fetches `origin/<base>` into the clone, then the settings there; undefined if the repo's config is invalid, logged once per commit. */
export async function loadSession(io: Io, r: Repo, secs?: number): Promise<Session | undefined> {
  const base = await baseBranch(io, r);
  await write(io, [...GIT, "-C", r.path, "fetch", "origin", base], undefined, secs);
  const c = await repoConfig(io, r, base);
  if (c.config) return combine(r, base, c.config);
  if (!c.logged) io.log(`${r.key}: .tender/ on ${base} at ${c.sha.slice(0, 12)} is invalid, so no tickets start:\n  ${c.error}`);
  c.logged = true;
}
