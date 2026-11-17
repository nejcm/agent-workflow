import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Config, Repo, Source } from "../types";
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
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\[\]\/-]{0,99}$/;
export const AUTO_MERGE = ["off", "shadow", "intelligent", "all"] as const;

const expand = (p: string, base: string) => resolve(base, p.replace(/^~(?=$|\/)/, homedir()));

export function parseConfig(raw: any, base: string): Config {
  const errs: string[] = [];
  const check = (ok: unknown, msg: string) => ok || errs.push(msg);
  const str = (v: unknown) => typeof v === "string" && v.length > 0;
  const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
  const posInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
  check(obj(raw), "config must be a JSON object");
  raw = obj(raw) ? raw : {};
  check(str(raw.host) && /^[A-Za-z0-9._-]+$/.test(raw.host), "host: required, [A-Za-z0-9._-]");
  const defaultHost = raw.defaultHost ?? false;
  check(typeof defaultHost === "boolean", "defaultHost: boolean");
  const pollIntervalMs = raw.pollIntervalMs ?? 60000;
  check(Number.isInteger(pollIntervalMs) && pollIntervalMs >= 5000, "pollIntervalMs: integer >= 5000");
  const tmuxSession = raw.tmuxSession ?? "tender";
  check(NAME.test(tmuxSession), "tmuxSession: [a-z0-9-]");
  const maxConcurrent = raw.maxConcurrent ?? 2;
  check(posInt(maxConcurrent), "maxConcurrent: positive integer");
  check(raw.maxInReview === undefined || posInt(raw.maxInReview), "maxInReview: positive integer");
  const stallMinutes = raw.stallMinutes ?? 30;
  check(posInt(stallMinutes), "stallMinutes: positive integer");
  const reposRoot = expand(raw.reposRoot ?? "~/agent-repos", base);
  check(raw.lanes === undefined, "lanes: replaced by sources + repos + defaults (see docs/upgrading.md)");
  const defaults = raw.defaults ?? {};
  check(obj(defaults) && defaults.path === undefined, "defaults: object without path");
  if (obj(defaults)) for (const k of MOVED_KEYS) check(defaults[k] === undefined, `defaults.${k}: moved to .tender/config.yaml in the repo`);

  const shape = `array of "owner/name" or { "name": "owner/name", …overrides }`;
  check(!obj(raw.repos), `repos: now an ${shape}; move each "owner/name": {…} entry to { "name": "owner/name", … } (see docs/upgrading.md)`);
  check(obj(raw.repos) || (Array.isArray(raw.repos) && raw.repos.length > 0), `repos: non-empty ${shape}`);
  const repos: Record<string, Repo> = {};
  const keys: string[] = [];
  for (const [i, e] of (Array.isArray(raw.repos) ? raw.repos : []).entries()) {
    const { name: key, ...o } = typeof e === "string" ? { name: e } : obj(e) ? e : { name: undefined };
    check(typeof e === "string" || obj(e), `repos[${i}]: ${shape}`);
    check(validRepo(key), `repos[${i}]${typeof e === "string" ? "" : ".name"}: must be "owner/name"`);
    if (!validRepo(key)) continue;
    const at = `repos[${i}] (${key})`;
    const v = { ...(obj(defaults) ? defaults : {}), ...o };
    for (const k of MOVED_KEYS) check(o[k] === undefined, `${at}.${k}: moved to .tender/config.yaml in the repo`);
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
    };
    check(r.baseBranch === undefined || validBranch(r.baseBranch), `${at}.baseBranch: invalid`);
    check(["nono", "none"].includes(r.sandbox), `${at}.sandbox: "nono" | "none" (here or in defaults)`);
    check(r.maxConcurrent === undefined || posInt(r.maxConcurrent), `${at}.maxConcurrent: positive integer`);
    check(r.maxInReview === undefined || posInt(r.maxInReview), `${at}.maxInReview: positive integer`);
    check(AUTO_MERGE.includes(r.autoMerge), `${at}.autoMerge: ${AUTO_MERGE.map((m) => `"${m}"`).join(" | ")}`);
    check(Array.isArray(r.criticalPaths) && r.criticalPaths.every(str), `${at}.criticalPaths: array of non-empty glob strings`);
    check(Array.isArray(r.feedbackAuthors) && r.feedbackAuthors.every(str), `${at}.feedbackAuthors: array of non-empty strings (GitHub logins / Linear emails)`);
    repos[key] = r;
    keys.push(key);
  }
  check(new Set(keys.map((k) => k.toLowerCase())).size === keys.length, "repos: names must be unique ignoring case");
  check(new Set(Object.values(repos).map((r) => r.path)).size === keys.length, "repos: paths must be unique");

  check(Array.isArray(raw.sources) && raw.sources.length > 0, "sources: non-empty array required");
  const sources: Source[] = (Array.isArray(raw.sources) ? raw.sources : []).map((r: any, i: number) => {
    const at = `sources[${i}]${str(r?.name) ? ` (${r.name})` : ""}`;
    r = obj(r) ? r : {};
    for (const k of LANE_KEYS) check(r[k] === undefined, `${at}.${k}: moved to repos / defaults`);
    check(r.repos === undefined, `${at}.repos: removed; a GitHub source polls every repo in repos`);
    const common = { name: r.name, tracker: r.tracker, readyLabel: r.readyLabel ?? "agent", needsHumanLabel: r.needsHumanLabel ?? "needs-human" };
    check(NAME.test(common.name ?? ""), `${at}.name: required, [a-z0-9-]`);
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
  const app = raw.githubApp;
  check(app === undefined || (obj(app) && Object.keys(app).every((k) => ["appId", "installationId", "privateKeyFile"].includes(k))), "githubApp: object with appId, installationId and privateKeyFile");
  if (obj(app)) {
    check(posInt(app.appId), "githubApp.appId: positive integer, the App's ID");
    check(posInt(app.installationId), "githubApp.installationId: positive integer");
    check(str(app.privateKeyFile), "githubApp.privateKeyFile: path to the App's private key (.pem)");
    check(new Set(keys.map((k) => k.slice(0, k.indexOf("/")).toLowerCase())).size <= 1, "githubApp: every repo in repos must belong to one owner, the account the App is installed on");
    check(keys.length <= 500, "githubApp: at most 500 repos, GitHub's limit for one installation token");
    for (const r of Object.values(repos)) check(r.sandbox === "nono", `repos (${r.key}).sandbox: "nono" while githubApp is set; an unsandboxed session would push as your own gh login`);
  }
  const lapp = raw.linearApp;
  check(lapp === undefined || (obj(lapp) && Object.keys(lapp).every((k) => k === "clientId")), "linearApp: object with clientId");
  if (obj(lapp)) {
    check(typeof lapp.clientId === "string" && /^[A-Za-z0-9]{1,128}$/.test(lapp.clientId), "linearApp.clientId: the OAuth app's client ID; its secret goes in .env as LINEAR_CLIENT_SECRET");
    check(sources.some((s) => s.tracker === "linear"), "linearApp: needs a linear source");
  }
  if (errs.length) throw new Error(`invalid config:\n  ${errs.join("\n  ")}`);
  return { host: raw.host, defaultHost, pollIntervalMs, workspaceRoot: expand(raw.workspaceRoot ?? "~/agent-ws", base), reposRoot, tmuxSession, maxConcurrent, maxInReview: raw.maxInReview, stallMinutes, repos, sources, ...(obj(intake) && { intake: { enabled: intake.enabled, host: intake.host } }), ...(judge && { judge }), prs: { staleDays: prs.staleDays, ...(prs.digestIssue && { digestIssue: prs.digestIssue }) }, ...(obj(app) && { githubApp: { appId: app.appId, installationId: app.installationId, privateKeyFile: expand(app.privateKeyFile, base) } }), ...(obj(lapp) && { linearApp: { clientId: lapp.clientId } }) };
}

export const repoDir = (cfg: Config, key: string) => join(cfg.workspaceRoot, key);
