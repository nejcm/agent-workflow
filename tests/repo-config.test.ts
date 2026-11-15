import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cloneAll } from "../src/launcher";
import { mergeDecision, type PrFacts } from "../src/merge";
import { pass } from "../src/pass";
import { combine, configCache, dirEntries, type Entry, gitEntries, loadSession, parseRepoConfig, promptFor } from "../src/repo-config";
import { GIT, TENDER_DIR } from "../src/util";
import { check, parseArgs } from "../tender";
import { config, fakeIo, fakeTracker, noPr, repoFiles, root, setBaseSha, ticket, useTempRoot, web, windowsOut } from "./helpers";

useTempRoot();

const file = (name: string, text: string): Entry => ({ name, regular: true, size: Buffer.byteLength(text), text });
const errors = (entries: Entry[]) => {
  try {
    parseRepoConfig(entries);
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

test("repo config: no files means built-in defaults", () => {
  expect(parseRepoConfig([])).toEqual({ agent: "claude", testCmd: undefined, planStep: "Plan and implement the ticket.", autoMerge: undefined, criticalPaths: [], testPaths: [], prompts: { default: undefined, byLabel: {} }, files: {} });
  expect(parseRepoConfig([file("config.yaml", "")]).agent).toBe("claude");
});

test("repo config: every key parsed, every problem listed", () => {
  const yaml = 'agent: codex\ntestCmd: make test\nplanStep: Use X.\nautoMerge: shadow\ncriticalPaths: ["src/billing/**"]\ntestPaths: [qa/**]\nprompts:\n  default: main.md\n  byLabel:\n    "type:bug": bug.md\n';
  expect(parseRepoConfig([file("config.yaml", yaml), file("prompts/main.md", "M"), file("prompts/bug.md", "B")])).toMatchObject({
    agent: "codex", testCmd: "make test", planStep: "Use X.", autoMerge: "shadow", criticalPaths: ["src/billing/**"], testPaths: ["qa/**"],
    prompts: { default: "main.md", byLabel: { "type:bug": "bug.md" } }, files: { "main.md": "M", "bug.md": "B" },
  });
  const bad = errors([file("config.yaml", 'agent: gpt\ntestCmd: ""\nplanStep: ""\nautoMerge: yes\ncriticalPaths: x\ntestPaths: [1]\nsandbox: none\nprompts:\n  default: nope.md\n  byLabel:\n    bug: ../x.md\n')]);
  for (const k of ['agent: "claude" | "codex"', "testCmd: non-empty string", "planStep: non-empty string", "autoMerge:", "criticalPaths: list", "testPaths: list", "sandbox: unknown key", 'prompts.default: "nope.md" is not a file', 'prompts.byLabel.bug: "../x.md" is not a file'])
    expect(bad).toContain(k);
  expect(errors([file("config.yaml", "agent: [")])).toContain("config.yaml: YAML Parse error");
  expect(errors([file("config.yaml", "- a\n- b\n")])).toContain("config.yaml: must be a mapping");
  expect(errors([file("config.yaml", "agent: codex\n---\nagent: claude\n")])).toContain("config.yaml: must be a mapping");
  expect(errors([file("config.yaml", "prompts: [a]\n")])).toContain("prompts: mapping with default and byLabel");
});

test("repo config: size cap, prompt names, regular files only", () => {
  const big = "x".repeat(64 * 1024 + 1);
  expect(errors([file("prompts/a.md", big)])).toBe("prompts/a.md: over 64 KiB");
  expect(errors([{ name: "prompts/b.md", regular: true, size: big.length }])).toBe("prompts/b.md: over 64 KiB");
  expect(parseRepoConfig([file("prompts/a.md", "x".repeat(64 * 1024))]).files["a.md"]).toHaveLength(64 * 1024);
  for (const n of ["Bug.md", "a_b.md", "a.txt", ".md", "sub/a.md"]) expect(errors([file(`prompts/${n}`, "x")])).toBe(`prompts/${n}: prompt files must be named [a-z0-9-]+.md`);
  expect(errors([{ name: "config.yaml", regular: false, size: 0 }])).toBe("config.yaml: must be a regular file");
  expect(errors([file("other.yaml", "")])).toBe("other.yaml: not expected here");
});

test("prompt: the first label match, else the repo default, else default.md, else tender's", () => {
  const c = parseRepoConfig([file("config.yaml", 'prompts:\n  default: main.md\n  byLabel:\n    "type:bug": bug.md\n    ui: ui.md\n'), file("prompts/main.md", "M"), file("prompts/bug.md", "B"), file("prompts/ui.md", "U")]);
  expect(promptFor(c, ["ui", "Type:Bug"])).toBe("B");
  expect(promptFor(c, ["ui"])).toBe("U");
  expect(promptFor(c, [])).toBe("M");
  expect(promptFor(parseRepoConfig([file("prompts/default.md", "D")]))).toBe("D");
  expect(promptFor(parseRepoConfig([]))).toBe(readFileSync(join(TENDER_DIR, "prompts/default.md"), "utf8"));
});

test("combine: autoMerge is the lower of the repo's request and the host's ceiling; critical paths only grow", () => {
  const host = (autoMerge: string) => web(config({ repos: [{ name: "acme/web", autoMerge }] }));
  const repo = (y: string) => parseRepoConfig([file("config.yaml", y)]);
  expect(combine(host("intelligent"), "main", repo("autoMerge: shadow\n")).autoMerge).toBe("shadow");
  expect(combine(host("shadow"), "main", repo("autoMerge: all\n")).autoMerge).toBe("shadow");
  expect(combine(host("all"), "main", repo("")).autoMerge).toBe("all");
  expect(combine(host("off"), "main", repo("autoMerge: all\n")).autoMerge).toBe("off");
  const s = combine(host("all"), "dev", repo('autoMerge: intelligent\ncriticalPaths: ["src/billing/**"]\n'));
  expect(s).toMatchObject({ baseBranch: "dev", sandbox: "nono", agent: "claude" });
  const pr = (filename: string): PrFacts => ({ state: "OPEN", isDraft: false, isCrossRepository: false, baseRefName: "dev", mergeable: "MERGEABLE", additions: 1, deletions: 0, changedFiles: 1, statusCheckRollup: [], labels: [], files: [{ filename, status: "modified", additions: 1, deletions: 0 }] }) as any;
  expect(mergeDecision(pr(".tender/config.yaml"), undefined, s).reason).toBe("touches critical path .tender/config.yaml");
  expect(mergeDecision(pr(".tender/prompts/default.md"), undefined, combine(host("all"), "dev", repo("autoMerge: intelligent\n"))).merge).toBe(false);
  expect(mergeDecision(pr("src/billing/pay.ts"), undefined, s).merge).toBe(false);
  expect(mergeDecision(pr("package.json"), undefined, s).merge).toBe(false);
  expect(mergeDecision(pr("src/a.ts"), undefined, s).merge).toBe(true);
  const floor = web(config({ repos: [{ name: "acme/web", autoMerge: "all", criticalPaths: ["src/pay/**"] }] }));
  expect(combine(floor, "dev", repo("")).criticalPaths).toEqual(["src/pay/**"]);
  const both = combine(floor, "dev", repo('autoMerge: intelligent\ncriticalPaths: ["src/billing/**"]\n'));
  expect(both.criticalPaths).toEqual(["src/pay/**", "src/billing/**"]);
  expect(mergeDecision(pr("src/pay/a.ts"), undefined, both).merge).toBe(false);
  expect(mergeDecision(pr("src/billing/a.ts"), undefined, both).merge).toBe(false);
});

test("loadSession reads .tender/ at origin/<base> of the base clone, cached per commit; a worktree's copy is ignored", async () => {
  mkdirSync(join(root, "acme/web/gh-1/.tender/prompts"), { recursive: true });
  writeFileSync(join(root, "acme/web/gh-1/.tender/config.yaml"), "agent: claude\nautoMerge: all\n");
  repoFiles["config.yaml"] = "agent: codex\ntestCmd: make test\n";
  const c = config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "all" }] });
  const { io, cmds } = fakeIo();
  expect(await loadSession(io, web(c))).toMatchObject({ agent: "codex", testCmd: "make test", baseBranch: "main", autoMerge: "all" });
  repoFiles["config.yaml"] = "agent: claude\n";
  expect((await loadSession(io, web(c)))!.agent).toBe("codex");
  setBaseSha("b".repeat(40));
  expect((await loadSession(io, web(c)))!.agent).toBe("claude");
  const git = cmds.filter((x) => x.startsWith("git"));
  expect(git.every((x) => x.startsWith(`git -C ${root}/src-web `))).toBe(true);
  expect(git.slice(0, 2)).toEqual([`git -C ${root}/src-web fetch origin main`, `git -C ${root}/src-web rev-parse --verify refs/remotes/origin/main^{commit}`]);
  expect(git.filter((x) => x.includes(" ls-tree -r "))).toEqual([
    `git -C ${root}/src-web ls-tree -r -z --long ${"a".repeat(40)} -- .tender/config.yaml .tender/prompts`,
    `git -C ${root}/src-web ls-tree -r -z --long ${"b".repeat(40)} -- .tender/config.yaml .tender/prompts`,
  ]);
  expect(git).toContain(`git -C ${root}/src-web rev-parse --verify refs/remotes/origin/main^{commit}`);
  expect(cmds).toContain("gh repo view acme/web --json nameWithOwner,defaultBranchRef");
  const pinned = config({ repos: [{ name: "acme/web", path: join(root, "src-web"), baseBranch: "dev" }] });
  expect((await loadSession(io, web(pinned)))!.baseBranch).toBe("dev");
});

test("gitEntries parses real git trees: symlinks, oversize files and odd names come back as entries to reject", async () => {
  const repo = join(root, "r");
  const sh = (...a: string[]) => expect(Bun.spawnSync(a, { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
  sh("git", "init", "-q", "-b", "main", repo);
  mkdirSync(join(repo, ".tender/prompts"), { recursive: true });
  writeFileSync(join(repo, ".tender/config.yaml"), "agent: codex\n");
  writeFileSync(join(repo, ".tender/prompts/bug.md"), "B");
  writeFileSync(join(repo, ".tender/prompts/big.md"), "x".repeat(64 * 1024 + 1));
  writeFileSync(join(repo, ".tender/prompts/we ird\n.md"), "x");
  writeFileSync(join(repo, ".tender/ignored.txt"), "x");
  symlinkSync("/etc/passwd", join(repo, ".tender/prompts/link.md"));
  sh("git", "-C", repo, "add", "-A");
  sh("git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
  const { io } = fakeIo((x) => {
    if (x[0] !== "git") return;
    const r = Bun.spawnSync([...GIT, ...x.slice(1)], { stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() };
  });
  const entries = await gitEntries(io, repo, "HEAD");
  expect(entries.map((e) => [e.name, e.regular, e.text?.length])).toEqual([
    ["config.yaml", true, 13],
    ["prompts/big.md", true, undefined],
    ["prompts/bug.md", true, 1],
    ["prompts/link.md", false, undefined],
    ["prompts/we ird\n.md", true, undefined],
  ]);
  expect(errors(entries).split("\n  ")).toEqual(["prompts/big.md: over 64 KiB", "prompts/link.md: must be a regular file", "prompts/we ird\n.md: prompt files must be named [a-z0-9-]+.md"]);
  sh("git", "-C", repo, "rm", "-rq", ".tender");
  mkdirSync(join(repo, "cfg"));
  writeFileSync(join(repo, "cfg/config.yaml"), "agent: codex\n");
  symlinkSync("cfg", join(repo, ".tender"));
  sh("git", "-C", repo, "add", "-A");
  sh("git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "link");
  expect(errors(await gitEntries(io, repo, "HEAD"))).toBe(".tender: must be a directory");
  expect(errors(dirEntries(repo))).toBe(".tender: must be a directory");
  expect(await gitEntries(io, repo, "HEAD~1")).toHaveLength(5);
});

test("an invalid repo config starts nothing: logged once and commented once per base commit", async () => {
  repoFiles["config.yaml"] = "agent: gpt\n";
  const { tr, calls } = fakeTracker({ ready: [ticket(1), ticket(2)] });
  const { io, cmds, logs } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut([]) : noPr(a)));
  const c = config();
  await pass(c, io, () => tr, "/tender");
  await pass(c, io, () => tr, "/tender");
  const invalid = (sha: string) => `[web] acme/web: .tender/ on main at ${sha.slice(0, 12)} is invalid, so no tickets start:\n  agent: "claude" | "codex"`;
  expect(logs.filter((l) => l.includes("is invalid"))).toEqual([invalid("a".repeat(40))]);
  expect(calls).toEqual([`comment gh-1 not started: acme/web's .tender/ at ${"a".repeat(12)} is invalid; run \`tender check\` in the repo for details`]);
  expect(cmds.some((x) => / clone -q | new-window /.test(x))).toBe(false);
  setBaseSha("c".repeat(40));
  await pass(c, io, () => tr, "/tender");
  expect(logs.filter((l) => l.includes("is invalid"))).toHaveLength(2);
  expect(calls).toHaveLength(2);
  configCache.clear();
  await pass(c, io, () => tr, "/tender");
  expect(calls).toHaveLength(2);
  setBaseSha("f".repeat(40));
  tr.comment = async () => Promise.reject(new Error("rate limited"));
  await pass(c, io, () => tr, "/tender");
  expect(logs.some((l) => l.includes("rate limited"))).toBe(true);
  tr.comment = async (t, b) => void calls.push(`comment ${t.id} ${b}`);
  await pass(c, io, () => tr, "/tender");
  expect(calls.at(-1)).toBe(`comment gh-1 not started: acme/web's .tender/ at ${"f".repeat(12)} is invalid; run \`tender check\` in the repo for details`);
  repoFiles["config.yaml"] = "agent: claude\n";
  setBaseSha("d".repeat(40));
  await pass(c, fakeIo((a) => (a[1] === "list-windows" ? windowsOut([]) : a[5] === "--quiet" ? { code: 1 } : noPr(a))).io, () => tr, "/tender");
  expect(calls.at(-1)).toBe("claim gh-2");
});

test("a start uses the label-chosen prompt from the base branch and records the agent", async () => {
  repoFiles["config.yaml"] = "prompts:\n  byLabel:\n    bug: bug.md\n";
  repoFiles["prompts/bug.md"] = "BUG {{id}} {{tests}}";
  const { tr } = fakeTracker({ ready: [{ ...ticket(1), labels: ["Bug"] }] });
  const { io } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut([]) : a[5] === "--quiet" ? { code: 1 } : noPr(a)));
  await pass(config(), io, () => tr, "/tender");
  expect(readFileSync(join(root, "acme/web/gh-1.prompt.md"), "utf8")).toBe("BUG gh-1 the project's tests (find how they run: README, CI config, package or build files)");
  expect(readFileSync(join(root, "acme/web/gh-1.agent"), "utf8")).toBe("claude");
});

test("cloneAll clones every allowlisted repo that still resolves to itself; one failure does not stop the rest", async () => {
  const repos = ["web", "api", "moved", "gone"].map((n) => ({ name: `acme/${n}`, path: join(root, `src-${n}`) }));
  const { io, cmds, logs } = fakeIo((a) =>
    a[2] === "clone" && a[3] === "acme/web" ? { code: 1 }
    : a[2] === "view" && a[3] === "acme/moved" ? { out: '{"nameWithOwner":"evil/moved"}' }
    : a[2] === "view" && a[3] === "acme/gone" ? { code: 1 } : undefined);
  await cloneAll(config({ repos }), io);
  expect(cmds.filter((x) => x.startsWith("gh repo clone")).map((x) => x.split(" ")[3])).toEqual(["acme/web", "acme/api"]);
  expect(logs.some((l) => l.startsWith("clone acme/web failed:"))).toBe(true);
  expect(logs.some((l) => l.includes('repo acme/moved: GitHub resolves it to "evil/moved", skipped'))).toBe(true);
});

test("in review: each pass fetches the base once, so a policy tightened there holds back a PR already in review", async () => {
  const pr = { state: "OPEN", isDraft: false, isCrossRepository: false, baseRefName: "main", mergeable: "MERGEABLE", additions: 1, deletions: 0, changedFiles: 1, statusCheckRollup: [], labels: [], number: 7, url: "https://github.com/acme/web/pull/7", headRefOid: "a".repeat(40) };
  const files = [{ filename: "src/billing/pay.ts", status: "modified", additions: 1, deletions: 0 }];
  const run = async () => {
    const { tr, calls } = fakeTracker({ inReview: [ticket(1), ticket(2)] });
    const { io, cmds } = fakeIo((a) =>
      a[1] === "pr" && a[2] === "list" ? { out: '[{"url":"https://github.com/acme/web/pull/7","state":"OPEN"}]' }
      : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(a.at(-1) === "state" ? { state: "MERGED" } : pr) }
      : a[1] === "api" ? { out: files.map((f) => JSON.stringify(f)).join("\n") } : undefined);
    await pass(config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "intelligent" }] }), io, () => tr, "/tender");
    return { calls, fetches: cmds.filter((x) => x.endsWith(" fetch origin main")).length };
  };
  repoFiles["config.yaml"] = "autoMerge: intelligent\n";
  const before = await run();
  expect(before.fetches).toBe(1);
  expect(before.calls).toContain("done gh-1");
  repoFiles["config.yaml"] = 'autoMerge: intelligent\ncriticalPaths: ["src/billing/**"]\n';
  setBaseSha("b".repeat(40));
  const after = await run();
  expect(after.fetches).toBe(1);
  expect(after.calls).toEqual(["gh-1", "gh-2"].map((id) => `comment ${id} not auto-merged: touches critical path src/billing/pay.ts`));
});

test("in review with an invalid .tender/ or a failed fetch: no merge or comment, but a PR merged by hand still moves the ticket", async () => {
  const merged = { state: "MERGED", isCrossRepository: false, baseRefName: "main", number: 7, url: "https://github.com/acme/web/pull/7", headRefOid: "a".repeat(40) };
  for (const failFetch of [false, true]) {
    configCache.clear();
    repoFiles["config.yaml"] = failFetch ? "autoMerge: intelligent\n" : "agent: gpt\n";
    const { tr, calls } = fakeTracker({ inReview: [ticket(1)] });
    const { io, cmds, logs } = fakeIo((a) =>
      failFetch && a.includes("fetch") ? { code: 1, err: "network down" }
      : a[1] === "pr" && a[2] === "list" ? { out: '[{"url":"https://github.com/acme/web/pull/7","state":"MERGED"}]' }
      : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(merged) } : undefined);
    await pass(config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "intelligent" }] }), io, () => tr, "/tender");
    expect(calls).toEqual(["done gh-1"]);
    expect(cmds.some((x) => x.startsWith("gh pr merge"))).toBe(false);
    if (failFetch) expect(logs.some((l) => l.includes("merge gh-1 failed"))).toBe(true);
  }
});

test("tender check validates a working tree's .tender/ and prints the effective settings", () => {
  expect(parseArgs(["check"])).toMatchObject({ cmd: "check", id: undefined });
  expect(parseArgs(["check", "../repo"])).toMatchObject({ cmd: "check", id: "../repo" });
  expect(parseArgs(["check", "a", "b"])).toBeUndefined();
  expect(check(join(root, "nope"), () => {}, () => {})).toBe(false);
  const out: string[] = [];
  expect(check(root, (s) => out.push(s), (s) => out.push(s))).toBe(true);
  expect(JSON.parse(out[0]!)).toMatchObject({ agent: "claude", testCmd: null, criticalPaths: expect.arrayContaining([".tender/**", ".github/**"]), prompts: { default: "tender's prompts/default.md", byLabel: {} } });
  mkdirSync(join(root, ".tender/prompts"), { recursive: true });
  writeFileSync(join(root, ".tender/config.yaml"), 'testCmd: make\ncriticalPaths: ["x/**"]\nprompts:\n  byLabel:\n    bug: bug.md\n');
  writeFileSync(join(root, ".tender/prompts/bug.md"), "B");
  expect(check(root, (s) => out.push(s))).toBe(true);
  expect(JSON.parse(out[1]!)).toMatchObject({ testCmd: "make", criticalPaths: expect.arrayContaining(["x/**", ".tender/**"]), prompts: { byLabel: { bug: ".tender/prompts/bug.md" } } });
  symlinkSync(join(root, ".tender/prompts/bug.md"), join(root, ".tender/prompts/evil.md"));
  writeFileSync(join(root, ".tender/prompts/Bad.md"), "x");
  expect(dirEntries(root).map((e) => e.name)).toEqual(["config.yaml", "prompts/Bad.md", "prompts/bug.md", "prompts/evil.md"]);
  expect(check(root, (s) => out.push(s), (s) => out.push(s))).toBe(false);
  expect(out[2]).toBe(`${join(root, ".tender")}: invalid:\n  prompts/Bad.md: prompt files must be named [a-z0-9-]+.md\n  prompts/evil.md: must be a regular file`);
});
