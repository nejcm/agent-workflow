import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "../src/config/config";
import { TENDER_DIR } from "../src/util";
import { config, raw, root, src, useTempRoot, web } from "./helpers";

useTempRoot();

test("config: defaults applied and errors listed", () => {
  const c = config();
  expect(c.pollIntervalMs).toBe(60000);
  expect(c.tmuxSession).toBe("tender");
  expect(c.maxConcurrent).toBe(2);
  expect(c.stallMinutes).toBe(30);
  for (const v of [0, 1.5, "30"]) expect(() => config({ stallMinutes: v })).toThrow("stallMinutes: positive integer");
  expect(c.reposRoot).toMatch(/\/agent-repos$/);
  expect(c.sources[0]).toEqual({ name: "web", tracker: "github", readyLabel: "agent", needsHumanLabel: "needs-human", inProgressLabel: "in-progress", inReviewLabel: "in-review", readyToMergeLabel: "ready-to-merge" });
  expect(config({ sources: [src({ tracker: "linear", team: "ENG" })] }).sources[0]).toEqual({ name: "web", tracker: "linear", readyLabel: "agent", needsHumanLabel: "needs-human", team: "ENG", todo: "Todo", inProgress: "In Progress", inReview: "In Review", done: ["Done"] });
  expect(web(c)).toEqual({ key: "acme/web", path: join(root, "src-web"), baseBranch: undefined, sandbox: "nono", maxConcurrent: undefined, autoMerge: "off", criticalPaths: [], feedbackAuthors: [], stallMinutes: 30, feedbackRounds: 3 });
  const c2 = config({ reposRoot: "/r", repos: ["acme/web", { name: "acme/api", maxConcurrent: 1, baseBranch: "dev" }] });
  expect(web(c2).path).toBe("/r/acme/web");
  expect(c2.repos["acme/api"]).toMatchObject({ path: "/r/acme/api", sandbox: "nono", maxConcurrent: 1, baseBranch: "dev" });
  const err = (raw: object) => {
    try {
      parseConfig(raw, root);
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };
  const e1 = err({ host: "a b", maxConcurrent: 0, sources: [{ name: "Bad Name", tracker: "jira", repo: "x", repoPath: "/x", testCmd: "t" }] });
  for (const k of ["host:", "maxConcurrent:", "repos:", ".name:", ".tracker:", ".repo: moved", ".repoPath: moved", ".testCmd: moved"]) expect(e1).toContain(k);
  const e2 = err(raw({ defaults: {}, repos: [{ name: "acme/web", sandbox: "vm" }, "../x", { name: "-x/y" }, "a/b/c", { path: "/p" }, 7] }));
  for (const k of [`repos[0] (acme/web).sandbox: "nono" | "none" (here or in defaults)`, `repos[1]: must be "owner/name"`, `repos[2].name: must be "owner/name"`, `repos[3]: must be`, `repos[4].name: must be`, `repos[5]: array of`])
    expect(e2).toContain(k);
  expect(err(raw({ repos: [{ name: "acme/web", path: "/a" }, { name: "ACME/Web", path: "/b" }] }))).toContain("unique ignoring case");
  expect(err(raw({ repos: [{ name: "acme/web", path: "/a" }, { name: "acme/api", path: "/a" }] }))).toContain("paths must be unique");
  expect(err(raw({ repos: { "acme/web": {} } }))).toContain("repos: now an array");
  expect(err(raw({ repos: [] }))).toContain("repos: non-empty array");
  expect(err(raw({ sources: [src({ repos: ["acme/web"] })] }))).toContain(".repos: removed; a GitHub source polls every repo in repos");
  expect(err(raw({ lanes: [] }))).toContain("lanes: replaced by sources");
  expect(err(raw({ sources: [src({ tracker: "linear" })] }))).toMatch(/team/);
  for (const tracker of ["jira", ["github"], { toString: null }, "toString"]) expect(err(raw({ host: "a b", sources: [src({ tracker })] }))).toContain(`sources[0] (web).tracker: "github" | "linear"`);
  const e3 = err(raw({ sources: [src({ name: "gh", team: "ENG", done: ["Done"], bogus: 1 }), src({ name: "lin", tracker: "linear", team: "ENG", inProgressLabel: "x" })] }));
  for (const k of ["sources[0] (gh).team: not a github source key", "sources[0] (gh).done: not a github source key", "sources[0] (gh).bogus: not a github source key", "sources[1] (lin).inProgressLabel: not a linear source key"]) expect(e3).toContain(k);
  expect(err(raw({ sources: [src({ repos: ["acme/web"] })] }))).not.toContain("not a github source key");
  expect(err(raw({ defaultHost: "yes" }))).toMatch(/defaultHost/);
});

test("example config validates", () => {
  const raw = JSON.parse(readFileSync(join(TENDER_DIR, "tender.example.json"), "utf8"));
  expect(parseConfig(raw, TENDER_DIR).sources.length).toBeGreaterThan(0);
});

test("config: repo overrides of the wrong type are rejected, not replaced by defaults", () => {
  for (const [k, v] of [["path", 42], ["path", ""], ["path", null], ["baseBranch", 42]] as const)
    expect(() => config({ repos: [{ name: "acme/web", [k]: v }] })).toThrow(`repos[0] (acme/web).${k}: non-empty string`);
  expect(() => config({ defaults: { sandbox: "nono", baseBranch: 1 } })).toThrow(".baseBranch: non-empty string");
  for (const b of ["a..b", "-x", "a b"]) expect(() => config({ repos: [{ name: "acme/web", baseBranch: b }] })).toThrow(".baseBranch: invalid");
});

test("config: stallMinutes per repo entry, else defaults, else the top level; feedback.maxRounds 1-10, default 3", () => {
  const c = config({ stallMinutes: 45, defaults: { sandbox: "nono", stallMinutes: 20, feedback: { maxRounds: 2 } }, repos: [{ name: "acme/web", path: "/a", stallMinutes: 5, feedback: { maxRounds: 10 } }, { name: "acme/api", path: "/b" }] });
  expect(c.repos["acme/web"]).toMatchObject({ stallMinutes: 5, feedbackRounds: 10 });
  expect(c.repos["acme/api"]).toMatchObject({ stallMinutes: 20, feedbackRounds: 2 });
  expect(web(config({ stallMinutes: 45 }))).toMatchObject({ stallMinutes: 45, feedbackRounds: 3 });
  for (const v of [0, 1.5, "5"]) expect(() => config({ repos: [{ name: "acme/web", stallMinutes: v }] })).toThrow("repos[0] (acme/web).stallMinutes: positive integer");
  for (const f of [3, { maxRounds: 0 }, { maxRounds: 11 }, { maxRounds: 2, x: 1 }, {}]) expect(() => config({ repos: [{ name: "acme/web", feedback: f }] })).toThrow("repos[0] (acme/web).feedback: { maxRounds: integer 1-10 }");
});

test("config: work keys moved to the repo's .tender/config.yaml are rejected", () => {
  const keys = ["agent", "testCmd", "planStep", "prompt", "testPaths"];
  const one = Object.fromEntries(keys.map((k) => [k, "x"]));
  let msg = "";
  try {
    config({ defaults: { sandbox: "nono", ...one }, repos: [{ name: "acme/web", ...one }] });
  } catch (e) {
    msg = (e as Error).message;
  }
  for (const k of keys) {
    expect(msg).toContain(`defaults.${k}: moved to .tender/config.yaml in the repo`);
    expect(msg).toContain(`repos[0] (acme/web).${k}: moved to .tender/config.yaml in the repo`);
  }
  expect(msg).not.toContain("unknown key");
});

test("config: unknown keys at the top level, in defaults and in repos entries are rejected", () => {
  expect(() => config({ pollIntervalMS: 5000 })).toThrow("pollIntervalMS: unknown key");
  expect(() => config({ defaults: { sandbox: "nono", feedbackAuthor: ["x"] } })).toThrow("defaults.feedbackAuthor: unknown key");
  expect(() => config({ repos: [{ name: "acme/web", criticalpaths: ["x/**"] }] })).toThrow("repos[0] (acme/web).criticalpaths: unknown key");
});

test("config: values the name regexes would coerce from a non-string are rejected", () => {
  for (const v of [3, ["tender"]]) expect(() => config({ tmuxSession: v })).toThrow("tmuxSession: [a-z0-9-]");
  expect(() => config({ sources: [src({ name: ["web"] })] })).toThrow("sources[0].name: required");
  expect(() => config({ sources: [src({ tracker: "linear", team: 42 })] })).toThrow("team: Linear team key");
  for (const k of ["workspaceRoot", "reposRoot"]) expect(() => config({ [k]: 5 })).toThrow(`${k}: non-empty string`);
});

test("config: host criticalPaths from defaults or per repo, validated", () => {
  expect(web(config({ defaults: { sandbox: "nono", criticalPaths: ["x/**"] } })).criticalPaths).toEqual(["x/**"]);
  for (const v of ["x", [""], null, ["./x/**"], ["{a,b}"]]) expect(() => config({ repos: [{ name: "acme/web", criticalPaths: v }] })).toThrow("repos[0] (acme/web).criticalPaths: array of non-empty glob strings");
});

test("config: autoMerge ceiling from defaults or per repo, validated", () => {
  expect(web(config()).autoMerge).toBe("off");
  const c = config({ defaults: { sandbox: "nono", autoMerge: "intelligent" }, repos: ["acme/web", { name: "acme/api", autoMerge: "shadow" }] });
  expect(web(c).autoMerge).toBe("intelligent");
  expect(c.repos["acme/api"]!.autoMerge).toBe("shadow");
  expect(() => config({ repos: [{ name: "acme/web", autoMerge: "yes" }] })).toThrow(`repos[0] (acme/web).autoMerge: "off" | "shadow" | "intelligent" | "all"`);
  expect(() => config({ repos: [{ name: "acme/web", autoMerge: null }] })).toThrow(`autoMerge: "off" | "shadow" | "intelligent" | "all"`);
});

test("config: feedbackAuthors defaults to [], from defaults or per repo, validated", () => {
  expect(web(config()).feedbackAuthors).toEqual([]);
  const c = config({ defaults: { sandbox: "nono", feedbackAuthors: ["lead"] }, repos: ["acme/web", { name: "acme/api", feedbackAuthors: ["octocat", "a@b.c"] }] });
  expect(web(c).feedbackAuthors).toEqual(["lead"]);
  expect(c.repos["acme/api"]!.feedbackAuthors).toEqual(["octocat", "a@b.c"]);
  for (const v of ["octocat", [1], [""], {}]) expect(() => config({ repos: [{ name: "acme/web", feedbackAuthors: v }] })).toThrow(`repos[0] (acme/web).feedbackAuthors: array of non-empty strings`);
});
