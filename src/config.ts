import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Config, Repo, Source } from "./types";
import { TRACKERS } from "./trackers";
import { AW_DIR } from "./util";

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Owner may not start with "-" (flag to gh/git) or "." (aw's own dirs in workspaceRoot); keys map 1:1 to <owner>/<name> dirs.
const REPO = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/;
export const validRepo = (s: unknown) => typeof s === "string" && REPO.test(s) && !s.includes("..") && !s.endsWith("/.") && !/\.git$/i.test(s);
/** Canonical allowlist key for an untrusted repo string, or undefined. */
export const allowedRepo = (cfg: Config, raw: unknown) => (validRepo(raw) ? Object.keys(cfg.repos).find((k) => k.toLowerCase() === (raw as string).toLowerCase()) : undefined);
const LANE_KEYS = ["repo", "repoPath", "baseBranch", "agent", "sandbox", "maxConcurrent", "testCmd", "prompt"];

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
  const tmuxSession = raw.tmuxSession ?? "aw";
  check(NAME.test(tmuxSession), "tmuxSession: [a-z0-9-]");
  const maxConcurrent = raw.maxConcurrent ?? 2;
  check(posInt(maxConcurrent), "maxConcurrent: positive integer");
  const stallMinutes = raw.stallMinutes ?? 30;
  check(posInt(stallMinutes), "stallMinutes: positive integer");
  const reposRoot = expand(raw.reposRoot ?? "~/agent-repos", base);
  check(raw.lanes === undefined, "lanes: replaced by sources + repos + defaults (see README)");
  const defaults = raw.defaults ?? {};
  check(obj(defaults) && defaults.path === undefined, "defaults: object without path");

  const shape = `array of "owner/name" or { "name": "owner/name", …overrides }`;
  check(!obj(raw.repos), `repos: now an ${shape}; move each "owner/name": {…} entry to { "name": "owner/name", … } (see README)`);
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
    for (const k of ["path", "baseBranch", "prompt"]) check(v[k] === undefined || str(v[k]), `${at}.${k}: non-empty string`);
    const r: Repo = {
      key,
      path: str(v.path) ? expand(v.path, base) : join(reposRoot, key),
      baseBranch: str(v.baseBranch) ? v.baseBranch : "main",
      agent: v.agent,
      sandbox: v.sandbox,
      testCmd: v.testCmd,
      prompt: expand(str(v.prompt) ? v.prompt : join(AW_DIR, "prompts/default.md"), base),
      maxConcurrent: v.maxConcurrent,
      autoMerge: v.autoMerge === undefined ? "off" : v.autoMerge,
      criticalPaths: v.criticalPaths === undefined ? [] : v.criticalPaths,
      feedbackAuthors: v.feedbackAuthors === undefined ? [] : v.feedbackAuthors,
    };
    check(/^[\w./-]+$/.test(r.baseBranch) && !r.baseBranch.includes(".."), `${at}.baseBranch: invalid`);
    check(["claude", "codex"].includes(r.agent), `${at}.agent: "claude" | "codex" (here or in defaults)`);
    check(["nono", "none"].includes(r.sandbox), `${at}.sandbox: "nono" | "none" (here or in defaults)`);
    check(str(r.testCmd), `${at}.testCmd: required (here or in defaults)`);
    check(r.maxConcurrent === undefined || posInt(r.maxConcurrent), `${at}.maxConcurrent: positive integer`);
    check(existsSync(r.prompt), `${at}.prompt: ${r.prompt} not found`);
    check(["off", "intelligent", "all"].includes(r.autoMerge), `${at}.autoMerge: "off" | "intelligent" | "all"`);
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
  if (errs.length) throw new Error(`invalid config:\n  ${errs.join("\n  ")}`);
  return { host: raw.host, defaultHost, pollIntervalMs, workspaceRoot: expand(raw.workspaceRoot ?? "~/agent-ws", base), reposRoot, tmuxSession, maxConcurrent, stallMinutes, repos, sources };
}

export const repoDir = (cfg: Config, key: string) => join(cfg.workspaceRoot, key);
