import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Config, Repo, Source } from "../types";
import { MODEL } from "../session/agents";
import { TRACKERS } from "../trackers";
import { validBranch } from "../util";

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const INTAKE_NAME = NAME;

// Owner may not start with "-" (flag to gh/git) or "." (tender's own dirs in workspaceRoot); keys map 1:1 to <owner>/<name> dirs.
const REPO = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/;
export const validRepo = (s: unknown) => typeof s === "string" && REPO.test(s) && !s.includes("..") && !s.endsWith("/.") && !/\.git$/i.test(s);
/** Canonical allowlist key for an untrusted repo string, or undefined. */
export const allowedRepo = (cfg: Config, raw: unknown) => (validRepo(raw) ? Object.keys(cfg.repos).find((k) => k.toLowerCase() === (raw as string).toLowerCase()) : undefined);
const LANE_KEYS = ["repo", "repoPath", "baseBranch", "agent", "sandbox", "maxConcurrent", "testCmd", "prompt"];
const MOVED_KEYS = ["agent", "testCmd", "planStep", "prompt", "testPaths"];
const TOP_KEYS = ["host", "defaultHost", "pollIntervalMs", "workspaceRoot", "reposRoot", "tmuxSession", "maxConcurrent", "maxInReview", "stallMinutes", "lanes", "defaults", "repos", "sources", "intake", "judge", "prs"];
const REPO_KEYS = ["path", "baseBranch", "sandbox", "maxConcurrent", "maxInReview", "autoMerge", "criticalPaths", "feedbackAuthors", "stallMinutes", "feedback", ...MOVED_KEYS];
export const AUTO_MERGE = ["off", "shadow", "intelligent", "all"] as const;
export const validGlob = (v: unknown): v is string => typeof v === "string" && v.trim() === v && /[^/]/.test(v) && !/^!|[{}\\]|\/\/|(^|\/)\.\.?(\/|$)/.test(v);
export const GLOB_RULES = 'no surrounding spaces, "!", "{}", "\\", "." or ".." segments, or "//"';

const expand = (p: string, base: string) => resolve(base, p.replace(/^~(?=$|\/)/, homedir()));
// Missing segments resolve as written; any other error (EACCES, ENOTDIR) throws.
const real = (p: string): string => (lstatSync(p, { throwIfNoEntry: false }) || dirname(p) === p ? realpathSync(p) : join(real(dirname(p)), basename(p)));
const within = (p: string, dir: string) => [p, real(p)].some((a) => [dir, real(dir)].some((d) => !/^\.\.(\/|$)/.test(relative(d, a))));

export function parseConfig(raw: any, base: string): Config {
  const errs: string[] = [];
  const check = (ok: unknown, msg: string) => ok || errs.push(msg);
  const str = (v: unknown) => typeof v === "string" && v.length > 0;
  const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
  const posInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
  const rounds = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10;
  check(obj(raw), "config must be a JSON object");
  raw = obj(raw) ? raw : {};
  for (const k of Object.keys(raw)) check(TOP_KEYS.includes(k), `${k}: unknown key`);
  check(str(raw.host) && /^[A-Za-z0-9._-]+$/.test(raw.host), "host: required, [A-Za-z0-9._-]");
  const defaultHost = raw.defaultHost ?? false;
  check(typeof defaultHost === "boolean", "defaultHost: boolean");
  const pollIntervalMs = raw.pollIntervalMs ?? 60000;
  check(Number.isInteger(pollIntervalMs) && pollIntervalMs >= 5000, "pollIntervalMs: integer >= 5000");
  const tmuxSession = raw.tmuxSession ?? "tender";
  check(typeof tmuxSession === "string" && NAME.test(tmuxSession), "tmuxSession: [a-z0-9-]");
  const maxConcurrent = raw.maxConcurrent ?? 2;
  check(posInt(maxConcurrent), "maxConcurrent: positive integer");
  check(raw.maxInReview === undefined || posInt(raw.maxInReview), "maxInReview: positive integer");
  const stallMinutes = raw.stallMinutes ?? 30;
  check(posInt(stallMinutes), "stallMinutes: positive integer");
  for (const k of ["workspaceRoot", "reposRoot"]) check(raw[k] === undefined || str(raw[k]), `${k}: non-empty string`);
  const reposRoot = expand(str(raw.reposRoot) ? raw.reposRoot : "~/agent-repos", base);
  const workspaceRoot = expand(str(raw.workspaceRoot) ? raw.workspaceRoot : "~/agent-ws", base);
  check(raw.lanes === undefined, "lanes: replaced by sources + repos + defaults");
  const defaults = raw.defaults ?? {};
  check(obj(defaults) && defaults.path === undefined, "defaults: object without path");
  if (obj(defaults)) for (const k of MOVED_KEYS) check(defaults[k] === undefined, `defaults.${k}: moved to .tender/config.yaml in the repo`);
  if (obj(defaults)) for (const k of Object.keys(defaults)) check(k === "path" || REPO_KEYS.includes(k), `defaults.${k}: unknown key`);

  const shape = `array of "owner/name" or { "name": "owner/name", …overrides }`;
  check(!obj(raw.repos), `repos: now an ${shape}; move each "owner/name": {…} entry to { "name": "owner/name", … }`);
  check(obj(raw.repos) || (Array.isArray(raw.repos) && raw.repos.length > 0), `repos: non-empty ${shape}`);
  const repos: Record<string, Repo> = {};
  const keys: string[] = [];
  const ats: Record<string, string> = {};
  for (const [i, e] of (Array.isArray(raw.repos) ? raw.repos : []).entries()) {
    const { name: key, ...o } = typeof e === "string" ? { name: e } : obj(e) ? e : { name: undefined };
    check(typeof e === "string" || obj(e), `repos[${i}]: ${shape}`);
    check(validRepo(key), `repos[${i}]${typeof e === "string" ? "" : ".name"}: must be "owner/name"`);
    if (!validRepo(key)) continue;
    const at = `repos[${i}] (${key})`;
    const v = { ...(obj(defaults) ? defaults : {}), ...o };
    for (const k of MOVED_KEYS) check(o[k] === undefined, `${at}.${k}: moved to .tender/config.yaml in the repo`);
    for (const k of Object.keys(o)) check(REPO_KEYS.includes(k), `${at}.${k}: unknown key`);
    for (const k of ["path", "baseBranch"]) check(v[k] === undefined || str(v[k]), `${at}.${k}: non-empty string`);
    const r: Repo = {
      key,
      path: str(v.path) ? expand(v.path, base) : join(reposRoot, key),
      baseBranch: str(v.baseBranch) ? v.baseBranch : undefined,
      sandbox: v.sandbox,
      maxConcurrent: v.maxConcurrent,
      maxInReview: v.maxInReview,
      autoMerge: v.autoMerge === undefined ? "off" : v.autoMerge,
      criticalPaths: v.criticalPaths === undefined ? [] : v.criticalPaths,
      feedbackAuthors: v.feedbackAuthors === undefined ? [] : v.feedbackAuthors,
      stallMinutes: v.stallMinutes ?? stallMinutes,
      feedbackRounds: v.feedback === undefined ? 3 : v.feedback?.maxRounds,
    };
    check(r.baseBranch === undefined || validBranch(r.baseBranch), `${at}.baseBranch: invalid`);
    check(["nono", "none"].includes(r.sandbox), `${at}.sandbox: "nono" | "none" (here or in defaults)`);
    check(r.maxConcurrent === undefined || posInt(r.maxConcurrent), `${at}.maxConcurrent: positive integer`);
    check(r.maxInReview === undefined || posInt(r.maxInReview), `${at}.maxInReview: positive integer`);
    check(AUTO_MERGE.includes(r.autoMerge), `${at}.autoMerge: ${AUTO_MERGE.map((m) => `"${m}"`).join(" | ")}`);
    check(Array.isArray(r.criticalPaths) && r.criticalPaths.every(validGlob), `${at}.criticalPaths: array of non-empty glob strings (${GLOB_RULES})`);
    check(Array.isArray(r.feedbackAuthors) && r.feedbackAuthors.every(str), `${at}.feedbackAuthors: array of non-empty strings (GitHub logins / Linear emails)`);
    check(v.stallMinutes === undefined || posInt(r.stallMinutes), `${at}.stallMinutes: positive integer`);
    check(v.feedback === undefined || (obj(v.feedback) && Object.keys(v.feedback).every((k) => k === "maxRounds") && rounds(r.feedbackRounds)), `${at}.feedback: { maxRounds: integer 1-10 }`);
    repos[key] = r;
    keys.push(key);
    ats[key] = at;
  }
  check(new Set(keys.map((k) => k.toLowerCase())).size === keys.length, "repos: names must be unique ignoring case");
  check(new Set(Object.values(repos).map((r) => r.path)).size === keys.length, "repos: paths must be unique");
  // Cleanup deletes `<ID>.*` in a repo's workspace dir, so no base clone may sit there.
  for (const r of Object.values(repos)) {
    try {
      check(!keys.some((k) => within(r.path, join(workspaceRoot, k))), `${ats[r.key]}.path: must be outside every repo's <workspaceRoot>/<owner>/<name>`);
    } catch (e) {
      check(false, `${ats[r.key]}.path: cannot resolve: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  }

  check(Array.isArray(raw.sources) && raw.sources.length > 0, "sources: non-empty array required");
  const sources: Source[] = (Array.isArray(raw.sources) ? raw.sources : []).map((r: any, i: number) => {
    const at = `sources[${i}]${str(r?.name) ? ` (${r.name})` : ""}`;
    r = obj(r) ? r : {};
    for (const k of LANE_KEYS) check(r[k] === undefined, `${at}.${k}: moved to repos / defaults`);
    check(r.repos === undefined, `${at}.repos: removed; a GitHub source polls every repo in repos`);
    const common = { name: r.name, tracker: r.tracker, readyLabel: r.readyLabel ?? "agent", needsHumanLabel: r.needsHumanLabel ?? "needs-human" };
    check(typeof common.name === "string" && NAME.test(common.name), `${at}.name: required, [a-z0-9-]`);
    for (const k of ["readyLabel", "needsHumanLabel"] as const) check(str(common[k]), `${at}.${k}: non-empty string`);
    const adapter = typeof common.tracker === "string" && Object.hasOwn(TRACKERS, common.tracker) ? TRACKERS[common.tracker as Source["tracker"]] : undefined;
    check(adapter, `${at}.tracker: ${Object.keys(TRACKERS).map((k) => `"${k}"`).join(" | ")}`);
    const s = { ...common, ...adapter?.parse(r, at, check) } as Source;
    if (adapter) for (const k of Object.keys(r)) check(Object.hasOwn(s, k) || LANE_KEYS.includes(k) || k === "repos", `${at}.${k}: not a ${s.tracker} source key`);
    return s;
  });
  const names = sources.map((s) => s.name);
  check(new Set(names).size === names.length, "source names must be unique");
  const intake = raw.intake;
  check(intake === undefined || (obj(intake) && Object.keys(intake).every((k) => ["enabled", "host"].includes(k))), "intake: object with enabled and host");
  if (obj(intake)) {
    check(str(intake.host) && /^[A-Za-z0-9._-]+$/.test(intake.host), "intake.host: required, the one host that runs intake");
    check(Array.isArray(intake.enabled) && intake.enabled.every((e: unknown) => typeof e === "string" && keys.includes(e.slice(0, e.lastIndexOf(":"))) && INTAKE_NAME.test(e.slice(e.lastIndexOf(":") + 1))), `intake.enabled: array of "owner/name:rule" for repos in repos`);
  }
  const judge = raw.judge === undefined ? undefined : { agent: raw.judge?.agent, model: raw.judge?.model, maxPerRun: raw.judge?.maxPerRun ?? 10, ...(raw.judge?.guardrails === true && { guardrails: true as const }) };
  check(raw.judge === undefined || (obj(raw.judge) && Object.keys(raw.judge).every((k) => ["agent", "model", "maxPerRun", "guardrails"].includes(k))), "judge: object with agent, model, maxPerRun and guardrails");
  if (judge) {
    check(obj(intake), "judge: needs intake, as it runs during `tender intake` on the intake host");
    check(["claude", "codex"].includes(judge.agent), `judge.agent: "claude" | "codex"`);
    check(typeof judge.model === "string" && MODEL.test(judge.model), "judge.model: required, the model name, e.g. sonnet");
    check(Number.isInteger(judge.maxPerRun) && judge.maxPerRun > 0 && judge.maxPerRun <= 100, "judge.maxPerRun: integer 1-100");
    check(raw.judge.guardrails === undefined || typeof raw.judge.guardrails === "boolean", "judge.guardrails: true or false");
  }
  const prs = { staleDays: raw.prs?.staleDays ?? 14, digestIssue: raw.prs?.digestIssue };
  check(raw.prs === undefined || (obj(raw.prs) && Object.keys(raw.prs).every((k) => ["staleDays", "digestIssue"].includes(k))), "prs: object with staleDays and digestIssue");
  check(Number.isInteger(prs.staleDays) && prs.staleDays > 0 && prs.staleDays <= 365, "prs.staleDays: integer 1-365");
  const digest = /^([^#]+)#([1-9]\d{0,9})$/.exec(typeof prs.digestIssue === "string" ? prs.digestIssue : "");
  check(prs.digestIssue === undefined || (digest && keys.includes(digest[1]!)), `prs.digestIssue: "owner/name#<issue number>" for a repo in repos`);
  if (errs.length) throw new Error(`invalid config:\n  ${errs.join("\n  ")}`);
  return { host: raw.host, defaultHost, pollIntervalMs, workspaceRoot, reposRoot, tmuxSession, maxConcurrent, maxInReview: raw.maxInReview, stallMinutes, repos, sources, ...(obj(intake) && { intake: { enabled: intake.enabled, host: intake.host } }), ...(judge && { judge }), prs: { staleDays: prs.staleDays, ...(prs.digestIssue && { digestIssue: prs.digestIssue }) } };
}

export const repoDir = (cfg: Config, key: string) => join(cfg.workspaceRoot, key);
