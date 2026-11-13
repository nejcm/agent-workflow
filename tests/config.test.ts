import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "../src/config";
import { AW_DIR } from "../src/util";
import { config, raw, root, src, useTempRoot, web } from "./helpers";

useTempRoot();

test("config: defaults applied and errors listed", () => {
  const c = config();
  expect(c.pollIntervalMs).toBe(60000);
  expect(c.tmuxSession).toBe("aw");
  expect(c.maxConcurrent).toBe(2);
  expect(c.stallMinutes).toBe(30);
  for (const v of [0, 1.5, "30"]) expect(() => config({ stallMinutes: v })).toThrow("stallMinutes: positive integer");
  expect(c.reposRoot).toMatch(/\/agent-repos$/);
  expect(c.sources[0]).toEqual({ name: "web", tracker: "github", readyLabel: "agent", needsHumanLabel: "needs-human", inProgressLabel: "in-progress", inReviewLabel: "in-review" });
  expect(config({ sources: [src({ tracker: "linear", team: "ENG" })] }).sources[0]).toEqual({ name: "web", tracker: "linear", readyLabel: "agent", needsHumanLabel: "needs-human", team: "ENG", todo: "Todo", inProgress: "In Progress", inReview: "In Review", done: ["Done"] });
  expect(web(c)).toMatchObject({ key: "acme/web", path: join(root, "src-web"), baseBranch: "main", agent: "claude", maxConcurrent: undefined });
  const c2 = config({ reposRoot: "/r", repos: ["acme/web", { name: "acme/api", agent: "codex", testCmd: "make test", maxConcurrent: 1, baseBranch: "dev" }] });
  expect(web(c2).path).toBe("/r/acme/web");
  expect(c2.repos["acme/api"]).toMatchObject({ path: "/r/acme/api", agent: "codex", sandbox: "nono", testCmd: "make test", maxConcurrent: 1, baseBranch: "dev" });
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
  const e2 = err(raw({ defaults: {}, repos: [{ name: "acme/web", agent: "gpt" }, "../x", { name: "-x/y" }, "a/b/c", { path: "/p" }, 7] }));
  for (const k of [`repos[0] (acme/web).agent`, `repos[0] (acme/web).sandbox: "nono" | "none" (here or in defaults)`, `repos[0] (acme/web).testCmd: required (here or in defaults)`, `repos[1]: must be "owner/name"`, `repos[2].name: must be "owner/name"`, `repos[3]: must be`, `repos[4].name: must be`, `repos[5]: array of`])
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
  const raw = JSON.parse(readFileSync(join(AW_DIR, "aw.example.json"), "utf8"));
  expect(parseConfig(raw, AW_DIR).sources.length).toBeGreaterThan(0);
});

test("config: repo overrides of the wrong type are rejected, not replaced by defaults", () => {
  for (const [k, v] of [["path", 42], ["path", ""], ["path", null], ["baseBranch", 42], ["prompt", ""], ["prompt", 7]] as const)
    expect(() => config({ repos: [{ name: "acme/web", [k]: v }] })).toThrow(`repos[0] (acme/web).${k}: non-empty string`);
  expect(() => config({ defaults: { agent: "claude", sandbox: "nono", testCmd: "t", baseBranch: 1 } })).toThrow(".baseBranch: non-empty string");
});

test("config: autoMerge and criticalPaths from defaults or per repo, validated", () => {
  expect(web(config())).toMatchObject({ autoMerge: "off", criticalPaths: [] });
  const c = config({ defaults: { agent: "claude", sandbox: "nono", testCmd: "t", autoMerge: "intelligent", criticalPaths: ["x/**"] }, repos: ["acme/web", { name: "acme/api", autoMerge: "all" }] });
  expect(web(c)).toMatchObject({ autoMerge: "intelligent", criticalPaths: ["x/**"] });
  expect(c.repos["acme/api"]!.autoMerge).toBe("all");
  expect(() => config({ repos: [{ name: "acme/web", autoMerge: "yes" }] })).toThrow(`repos[0] (acme/web).autoMerge: "off" | "intelligent" | "all"`);
  expect(() => config({ repos: [{ name: "acme/web", criticalPaths: "x" }] })).toThrow("criticalPaths: array of non-empty glob strings");
  expect(() => config({ repos: [{ name: "acme/web", criticalPaths: [""] }] })).toThrow("criticalPaths");
});

test("config: explicit null autoMerge or criticalPaths is rejected, not defaulted", () => {
  expect(() => config({ repos: [{ name: "acme/web", criticalPaths: null }] })).toThrow("criticalPaths: array of non-empty glob strings");
  expect(() => config({ repos: [{ name: "acme/web", autoMerge: null }] })).toThrow(`autoMerge: "off" | "intelligent" | "all"`);
});

test("config: feedbackAuthors defaults to [], from defaults or per repo, validated", () => {
  expect(web(config()).feedbackAuthors).toEqual([]);
  const c = config({ defaults: { agent: "claude", sandbox: "nono", testCmd: "t", feedbackAuthors: ["lead"] }, repos: ["acme/web", { name: "acme/api", feedbackAuthors: ["octocat", "a@b.c"] }] });
  expect(web(c).feedbackAuthors).toEqual(["lead"]);
  expect(c.repos["acme/api"]!.feedbackAuthors).toEqual(["octocat", "a@b.c"]);
  for (const v of ["octocat", [1], [""], {}]) expect(() => config({ repos: [{ name: "acme/web", feedbackAuthors: v }] })).toThrow(`repos[0] (acme/web).feedbackAuthors: array of non-empty strings`);
});

test("config: planStep defaults to a plain instruction and must be non-empty", () => {
  expect(config({}).repos["acme/web"].planStep).toBe("Plan and implement the ticket.");
  expect(config({ defaults: { agent: "claude", sandbox: "nono", testCmd: "t", planStep: "Use X." } }).repos["acme/web"].planStep).toBe("Use X.");
  expect(() => config({ repos: [{ name: "acme/web", planStep: "" }] })).toThrow(".planStep: non-empty string");
});
