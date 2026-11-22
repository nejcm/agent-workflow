import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cloneAll } from "../src/session/launcher";
import { mergeDecision, type PrFacts } from "../src/review/merge";
import { pass } from "../src/pass";
import { checkProfile } from "../src/config/config";
import { defaultProfile, loadProfile, typeFor } from "../src/config/profile";
import { combine, configCache, dirEntries, type Entry, gitEntries, loadSession, parseRepoConfig, promptFor, repoConfig } from "../src/config/repo-config";
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
  expect(parseRepoConfig([])).toEqual({ agent: "claude", autoMerge: undefined, criticalPaths: [], testPaths: [], trust: [], escapeHatches: [], types: defaultProfile().types, intake: [] });
  expect(parseRepoConfig([file("config.yaml", "")]).agent).toBe("claude");
});

test("repo config: every key parsed, every problem listed", () => {
  const yaml = 'agent: codex\nautoMerge: shadow\ncriticalPaths: ["src/billing/**"]\ntestPaths: [qa/**]\n';
  expect(parseRepoConfig([file("config.yaml", yaml)])).toMatchObject({ agent: "codex", autoMerge: "shadow", criticalPaths: ["src/billing/**"], testPaths: ["qa/**"] });
  const bad = errors([file("config.yaml", "agent: gpt\ntestCmd: make\nautoMerge: yes\ncriticalPaths: x\ntestPaths: [1]\nsandbox: none\nprompt: {}\nbyLabel: {}\n")]);
  for (const k of ['agent: "claude" | "codex"', "testCmd: unknown key", "autoMerge:", "criticalPaths: list", "testPaths: list", "sandbox: unknown key", "prompt: unknown key", "byLabel: unknown key"]) expect(bad).toContain(k);
  expect(errors([file("config.yaml", "agent: [")])).toContain("config.yaml: YAML Parse error");
  expect(errors([file("config.yaml", "- a\n- b\n")])).toContain("config.yaml: must be a mapping");
  expect(errors([file("config.yaml", "agent: codex\n---\nagent: claude\n")])).toContain("config.yaml: must be a mapping");
});

test("repo config: agent is a name or { name, model, effort }, checked per agent; feedback.maxRounds is 1-10", () => {
  expect(parseRepoConfig([file("config.yaml", "agent: codex\n")])).toMatchObject({ agent: "codex", model: undefined, effort: undefined });
  expect(parseRepoConfig([file("config.yaml", "agent: { name: claude, model: \"opus[1m]\", effort: max }\nfeedback: { maxRounds: 10 }\n")])).toMatchObject({ agent: "claude", model: "opus[1m]", effort: "max", feedbackRounds: 10 });
  expect(parseRepoConfig([file("config.yaml", "agent: { name: codex, effort: minimal }\n")])).toMatchObject({ agent: "codex", effort: "minimal" });
  const c = parseRepoConfig([file("config.yaml", "types:\n  - name: big\n    match: { labels: [big] }\n    instructions: instructions/default.md\n    agent: { name: codex, model: gpt-5, effort: xhigh }\n  - name: quick\n    match: { labels: [quick] }\n    instructions: instructions/default.md\n    agent: claude\n")]);
  expect(c.types.filter((t) => t.agent).map((t) => [t.name, t.agent])).toEqual([["big", { name: "codex", model: "gpt-5", effort: "xhigh" }], ["quick", { name: "claude" }]]);
  const err = (y: string) => errors([file("config.yaml", y)]);
  expect(err("agent:\n")).toBe('agent: "claude" | "codex" or { name, model, effort }');
  expect(err("agent: [claude]\n")).toBe('agent: "claude" | "codex" or { name, model, effort }');
  expect(err("agent: { name: claude, args: [--yolo] }\n")).toBe("agent: mapping with name, model and effort");
  expect(err("agent: { model: opus }\n")).toBe('agent.name: "claude" | "codex"');
  for (const m of ["a b", "$(x)", "-m", "x".repeat(101)]) expect(err(`agent: { name: claude, model: ${JSON.stringify(m)} }\n`)).toBe("agent.model: model name like sonnet or gpt-5 ([A-Za-z0-9._:[]/-], at most 100 chars)");
  expect(err("agent: { name: claude, effort: minimal }\n")).toBe("agent.effort: low | medium | high | xhigh | max for claude");
  expect(err("agent: { name: codex, effort: max }\n")).toBe("agent.effort: minimal | low | medium | high | xhigh for codex");
  expect(err("types:\n  - name: big\n    match: { labels: [big] }\n    instructions: instructions/default.md\n    agent: gpt\n")).toBe('types[0] (big).agent: "claude" | "codex" or { name, model, effort }');
  for (const y of ["feedback: 3\n", "feedback: { rounds: 3 }\n"]) expect(err(y)).toStartWith("feedback: mapping with maxRounds");
  for (const n of [0, 11, 1.5, '"3"']) expect(err(`feedback: { maxRounds: ${n} }\n`)).toBe("feedback.maxRounds: integer 1-10");
});

test("repo config: types replace the profile's by name in place, new ones go before default, instructions stay in the profile", () => {
  const dir = join(root, "profile");
  mkdirSync(join(dir, "instructions"), { recursive: true });
  for (const n of ["a", "b", "default"]) writeFileSync(join(dir, "instructions", `${n}.md`), n.toUpperCase());
  writeFileSync(join(dir, "types.yaml"), "types:\n  - { name: a, match: { labels: [x] }, instructions: instructions/a.md }\n  - { name: default, instructions: instructions/default.md }\n");
  writeFileSync(join(root, "outside.md"), "O");
  symlinkSync(join(root, "outside.md"), join(dir, "instructions/out.md"));
  const profile = loadProfile(dir);
  const parse = (y: string) => parseRepoConfig([file("config.yaml", y)], profile).types;
  const t = (name: string, labels: string, md: string, more = "") => `  - { name: ${name}, ${labels ? `match: { labels: [${labels}] }, ` : ""}instructions: ${md}${more} }\n`;
  const types = parse(`types:\n${t("new", "y", "instructions/b.md")}${t("a", "z", "instructions/b.md", ", agent: codex")}`);
  expect(types).toEqual([
    { name: "a", match: { labels: ["z"] }, instructions: join(realpathSync(dir), "instructions/b.md"), agent: { name: "codex" }, output: "pr" },
    { name: "new", match: { labels: ["y"] }, instructions: join(realpathSync(dir), "instructions/b.md"), output: "pr" },
    { name: "default", instructions: join(realpathSync(dir), "instructions/default.md"), output: "pr" },
  ]);
  expect(parse(`types:\n${t("default", "", "instructions/a.md")}`).map((x) => [x.name, readFileSync(x.instructions, "utf8")])).toEqual([["a", "A"], ["default", "A"]]);
  const err = (y: string) => {
    try {
      parse(y);
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };
  expect(err(`types:\n${t("default", "x", "instructions/a.md")}`)).toBe("types[0] (default).match: default takes every ticket no other type matches, so it has no match");
  expect(err(`types:\n${t("c", "", "instructions/a.md")}`)).toBe("types[0] (c).match: { labels: [label, …] }, 1-20 labels");
  for (const md of ["instructions/nope.md", "../outside.md", "instructions/out.md", "/etc/passwd.md", "instructions/a.txt", "instructions"])
    expect(err(`types:\n${t("c", "x", md)}`)).toBe(`types[0] (c).instructions: ${JSON.stringify(md)} is not a .md file in the profile ${dir}`);
  expect(err(`types:\n${t("c", "x", "instructions/a.md", ", needs: { ports: 1 }")}`)).toBe("types[0] (c).needs: unknown key");
  expect(err(`types:\n${t("c", "x", "instructions/a.md", ", output: issue")}`)).toBe('types[0] (c).output: "pr"');
  expect(err(`types:\n${t("c", "x", "instructions/a.md")}${t("c", "y", "instructions/a.md")}`)).toBe("types: names must be unique");
  expect(err("types: { a: 1 }\n")).toBe("types: list of at most 50 types");
  expect(err("types:\n  - { name: Bad, match: { labels: [x] }, instructions: instructions/a.md }\n")).toBe("types[0] (Bad).name: required, [a-z0-9-]");
});

test("repo config: tracker.linear names the project, with an optional team key", () => {
  expect(parseRepoConfig([file("config.yaml", "tracker:\n  linear:\n    project: Web app\n    team: ENG\n")]).tracker).toEqual({ linear: { project: "Web app", team: "ENG" } });
  expect(parseRepoConfig([file("config.yaml", "tracker:\n  linear:\n    project: Web app\n")]).tracker).toEqual({ linear: { project: "Web app" } });
  expect(parseRepoConfig([]).tracker).toBeUndefined();
  expect(errors([file("config.yaml", "tracker: linear\n")])).toBe("tracker: mapping with linear");
  expect(errors([file("config.yaml", "tracker:\n  github: {}\n")])).toBe("tracker: mapping with linear");
  expect(errors([file("config.yaml", "tracker:\n  linear: Web app\n")])).toBe("tracker.linear: mapping with project and team");
  expect(errors([file("config.yaml", "tracker:\n  linear:\n    team: eng\n    repo: x\n")]).split("\n  ")).toEqual([
    "tracker.linear: mapping with project and team",
    "tracker.linear.project: non-empty string, the Linear project's name",
    "tracker.linear.team: Linear team key, e.g. ENG",
  ]);
  expect(errors([file("config.yaml", "tracker:\n  linear:\n    project: 7\n    team: 12\n")])).toContain("tracker.linear.team: Linear team key");
});

test("repo config: trust rules and escapeHatches regexes, capped in count and length", () => {
  const c = parseRepoConfig([file("config.yaml", 'trust:\n  - { paths: ["docs/**", "**/*.md"], autoMerge: all }\n  - { paths: ["**/auth/**"], autoMerge: off }\nescapeHatches: ["pragma: no cover", "^\\\\s*debugger"]\n')]);
  expect(c.trust).toEqual([{ paths: ["docs/**", "**/*.md"], autoMerge: "all" }, { paths: ["**/auth/**"], autoMerge: "off" }]);
  expect(c.escapeHatches).toEqual(["pragma: no cover", "^\\s*debugger"]);
  for (const y of ["trust: docs\n", "trust:\n  - { paths: [], autoMerge: all }\n", "trust:\n  - { paths: [docs/**], autoMerge: yes }\n", "trust:\n  - { paths: [docs/**], autoMerge: all, why: x }\n", "trust:\n  - docs/**\n"])
    expect(errors([file("config.yaml", y)])).toStartWith("trust: list of { paths: [glob, …], autoMerge:");
  for (const g of ["./docs/**", "docs/../src/**", "src//x", "/", " docs/** ", "!docs/**", "*.{ts,tsx}", "docs\\**", "src/./x", ".."]) {
    expect(errors([file("config.yaml", `trust:\n  - { paths: [${JSON.stringify(g)}], autoMerge: all }\n`)])).toStartWith("trust: list of");
    expect(errors([file("config.yaml", `criticalPaths: [${JSON.stringify(g)}]\n`)])).toStartWith("criticalPaths: list of non-empty glob strings (no surrounding spaces");
  }
  expect(parseRepoConfig([file("config.yaml", 'testPaths: ["**", ".github/", "/app/[id]/**", "my docs/*.md", "a.b/c..d"]\n')]).testPaths).toHaveLength(5);
  const many = Array.from({ length: 21 }, (_, i) => `x${i}`);
  for (const v of [many, ["("], [""], ["x".repeat(201)], "x", [1]]) expect(errors([file("config.yaml", `escapeHatches: ${JSON.stringify(v)}\n`)])).toBe("escapeHatches: at most 20 valid regexes of at most 200 chars");
  expect(parseRepoConfig([file("config.yaml", `escapeHatches: ${JSON.stringify(many.slice(2).concat("x".repeat(200)))}\n`)]).escapeHatches).toHaveLength(20);
});

test("repo config: size cap, regular files only", () => {
  const big = "x".repeat(64 * 1024 + 1);
  expect(errors([file("config.yaml", big)])).toBe("config.yaml: over 64 KiB");
  expect(errors([{ name: "verify.yaml", regular: true, size: big.length }])).toBe("verify.yaml: over 64 KiB");
  expect(errors([{ name: "config.yaml", regular: false, size: 0 }])).toBe("config.yaml: must be a regular file");
  expect(errors([file("other.yaml", "")])).toBe("other.yaml: not expected here");
});

test("prompt: tender's header, the type's instruction file, then tender's protocol, for each default type", () => {
  const read = (f: string) => readFileSync(f, "utf8").trim();
  const types = parseRepoConfig([]).types;
  expect(types.map((t) => [t.name, t.match?.labels])).toEqual([["bug", ["type:bug"]], ["docs", ["type:docs"]], ["default", undefined]]);
  for (const t of types) {
    expect(t.instructions).toBe(join(TENDER_DIR, "profile/instructions", `${t.name}.md`));
    expect(promptFor(t)).toBe([read(join(TENDER_DIR, "prompts/header.md")), read(t.instructions), read(join(TENDER_DIR, "prompts/protocol.md"))].join("\n\n") + "\n");
    expect(promptFor(t)).toContain("{{verify}}");
    expect(promptFor(t)).not.toContain("{{tests}}");
  }
  const [bug, docs, def] = types.map((t) => promptFor(t));
  expect(bug).toContain("Reproduce the bug first with a test that fails for the reported reason");
  expect(docs).toContain("Change docs only.");
  expect(def).toContain("whatever the instructions below say:\n\n- Work in this clone only.");
  expect(def).toContain("Do these steps in order:\n\n1. Clarify.");
  for (const p of [def, docs]) expect(p).not.toContain("Reproduce the bug first");
});

test("typeFor: the first type in file order with a label the ticket has, case-insensitively; default otherwise", () => {
  const types = parseRepoConfig([]).types;
  expect(typeFor(types, ["Type:BUG"]).name).toBe("bug");
  expect(typeFor(types, ["type:docs", "type:bug"]).name).toBe("bug");
  expect(typeFor(types, ["type:docs"]).name).toBe("docs");
  for (const l of [[], ["type:foo"], ["bug"]]) expect(typeFor(types, l).name).toBe("default");
  expect(typeFor(types).name).toBe("default");
});

test("combine: autoMerge is the lower of the repo's request and the host's ceiling; critical paths only grow", () => {
  const host = (autoMerge: string) => web(config({ repos: [{ name: "acme/web", autoMerge }] }));
  const repo = (y: string) => parseRepoConfig([file("config.yaml", y)]);
  expect(combine(host("intelligent"), "main", repo("autoMerge: shadow\n")).autoMerge).toBe("shadow");
  expect(combine(host("shadow"), "main", repo("autoMerge: all\n")).autoMerge).toBe("shadow");
  expect(combine(host("all"), "main", repo("")).autoMerge).toBe("all");
  expect(combine(host("off"), "main", repo("autoMerge: all\n")).autoMerge).toBe("off");
  expect(combine(host("intelligent"), "main", repo("autoMerge: shadow\n")).ceiling).toBe("intelligent");
  const rounds = (h: object, y: string) => combine(web(config({ repos: [{ name: "acme/web", ...h }] })), "main", repo(y)).feedbackRounds;
  expect(rounds({}, "")).toBe(3);
  expect(rounds({ feedback: { maxRounds: 2 } }, "")).toBe(2);
  expect(rounds({ feedback: { maxRounds: 2 } }, "feedback: { maxRounds: 5 }\n")).toBe(5);
  expect(rounds({ feedback: { maxRounds: 5 } }, "feedback: { maxRounds: 1 }\n")).toBe(1);
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
  mkdirSync(join(root, "acme/web/gh-1/.tender"), { recursive: true });
  writeFileSync(join(root, "acme/web/gh-1/.tender/config.yaml"), "agent: claude\nautoMerge: all\n");
  repoFiles["config.yaml"] = "agent: codex\ntestPaths: [qa/**]\n";
  const c = config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "all" }] });
  const { io, cmds } = fakeIo();
  expect(await loadSession(io, web(c))).toMatchObject({ agent: "codex", testPaths: ["qa/**"], baseBranch: "main", autoMerge: "all" });
  repoFiles["config.yaml"] = "agent: claude\n";
  expect((await loadSession(io, web(c)))!.agent).toBe("codex");
  setBaseSha("b".repeat(40));
  expect((await loadSession(io, web(c)))!.agent).toBe("claude");
  const git = cmds.filter((x) => x.startsWith("git"));
  expect(git.every((x) => x.startsWith(`git -C ${root}/src-web `))).toBe(true);
  expect(git.slice(0, 2)).toEqual([`git -C ${root}/src-web fetch origin main`, `git -C ${root}/src-web rev-parse --verify refs/remotes/origin/main^{commit}`]);
  expect(git.filter((x) => x.includes(" ls-tree -r "))).toEqual([
    `git -C ${root}/src-web ls-tree -r -z --long ${"a".repeat(40)} -- .tender/config.yaml .tender/verify.yaml`,
    `git -C ${root}/src-web ls-tree -r -z --long ${"b".repeat(40)} -- .tender/config.yaml .tender/verify.yaml`,
  ]);
  expect(git).toContain(`git -C ${root}/src-web rev-parse --verify refs/remotes/origin/main^{commit}`);
  expect(cmds).toContain("gh repo view acme/web --json nameWithOwner,defaultBranchRef");
  const pinned = config({ repos: [{ name: "acme/web", path: join(root, "src-web"), baseBranch: "dev" }] });
  expect((await loadSession(io, web(pinned)))!.baseBranch).toBe("dev");
});

test("gitEntries parses real git trees: symlinks and oversize files come back as entries to reject; other files are not read", async () => {
  const repo = join(root, "r");
  const sh = (...a: string[]) => expect(Bun.spawnSync(a, { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
  sh("git", "init", "-q", "-b", "main", repo);
  mkdirSync(join(repo, ".tender/prompts"), { recursive: true });
  writeFileSync(join(repo, ".tender/config.yaml"), "x".repeat(64 * 1024 + 1));
  writeFileSync(join(repo, ".tender/prompts/bug.md"), "B");
  writeFileSync(join(repo, ".tender/ignored.txt"), "x");
  symlinkSync("/etc/passwd", join(repo, ".tender/verify.yaml"));
  sh("git", "-C", repo, "add", "-A");
  sh("git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
  const { io } = fakeIo((x) => {
    if (x[0] !== "git") return;
    const r = Bun.spawnSync([...GIT, ...x.slice(1)], { stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() };
  });
  const entries = await gitEntries(io, repo, "HEAD");
  expect(entries.map((e) => [e.name, e.regular, e.text?.length])).toEqual([
    ["config.yaml", true, undefined],
    ["verify.yaml", false, undefined],
  ]);
  expect(errors(entries).split("\n  ")).toEqual(["config.yaml: over 64 KiB", "verify.yaml: must be a regular file"]);
  sh("git", "-C", repo, "rm", "-rq", ".tender");
  mkdirSync(join(repo, "cfg"));
  writeFileSync(join(repo, "cfg/config.yaml"), "agent: codex\n");
  symlinkSync("cfg", join(repo, ".tender"));
  sh("git", "-C", repo, "add", "-A");
  sh("git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "link");
  expect(errors(await gitEntries(io, repo, "HEAD"))).toBe(".tender: must be a directory");
  expect(errors(dirEntries(repo))).toBe(".tender: must be a directory");
  expect(await gitEntries(io, repo, "HEAD~1")).toHaveLength(2);
  sh("git", "-C", repo, "rm", "-q", ".tender");
  mkdirSync(join(repo, ".tender"));
  writeFileSync(join(repo, ".tender/config.yaml"), "agent: codex\n");
  sh("git", "-C", repo, "add", "-A");
  sh("git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "valid");
  expect((await gitEntries(io, repo, "HEAD")).map((e) => [e.name, e.regular, e.text])).toEqual([["config.yaml", true, "agent: codex\n"]]);
});

test("repoConfig reads a git-ignored config.yaml from the host's checkout when the base commit has none, and re-reads it when it changes", async () => {
  const repo = join(root, "own");
  const sh = (...a: string[]) => expect(Bun.spawnSync(a, { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
  const commit = (m: string) => (sh("git", "-C", repo, "add", "-A"), sh("git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", m), sh("git", "-C", repo, "update-ref", "refs/remotes/origin/main", "HEAD"));
  sh("git", "init", "-q", "-b", "main", repo);
  mkdirSync(join(repo, ".tender"));
  writeFileSync(join(repo, ".tender/verify.yaml"), "checks:\n  - { name: test, run: bun test }\n");
  writeFileSync(join(repo, ".gitignore"), ".tender/config.yaml\n");
  commit("c");
  const { io } = fakeIo((x) => {
    if (x[0] !== "git") return;
    const r = Bun.spawnSync([...GIT, ...x.slice(1)], { stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() };
  });
  const r = config({ repos: [{ name: "acme/web", path: repo }] }).repos["acme/web"]!;
  const read = async () => (await repoConfig(io, r, "main")).config;
  expect((await read())?.agent).toBe("claude");
  writeFileSync(join(repo, ".tender/config.yaml"), "agent: codex\ncriticalPaths: [src/**]\n");
  expect(await read()).toMatchObject({ agent: "codex", criticalPaths: ["src/**"], verify: { checks: [{ name: "test" }] } });
  writeFileSync(join(repo, ".tender/config.yaml"), "agent: claude\nautoMerge: shadow\n");
  expect(await read()).toMatchObject({ agent: "claude", autoMerge: "shadow" });
  writeFileSync(join(repo, ".gitignore"), "");
  expect((await read())?.autoMerge).toBeUndefined();
  writeFileSync(join(repo, ".gitignore"), ".tender/config.yaml\n");
  sh("git", "-C", repo, "add", "-f", ".tender/config.yaml");
  sh("git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "tracked");
  sh("git", "-C", repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(repo, ".tender/config.yaml"), "agent: codex\n");
  expect(await read()).toMatchObject({ agent: "claude", autoMerge: "shadow" });
});

test("an invalid repo config starts nothing: logged once and commented once per base commit", async () => {
  repoFiles["config.yaml"] = "agent: gpt\n";
  const { tr, calls } = fakeTracker({ ready: [ticket(1), ticket(2)] });
  const { io, cmds, logs } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut([]) : noPr(a)));
  const c = config();
  await pass(c, io, () => tr, "/tender");
  await pass(c, io, () => tr, "/tender");
  const invalid = (sha: string) => `[web] acme/web: .tender/ on main at ${sha.slice(0, 12)} is invalid, so no tickets start:\n  agent: "claude" | "codex" or { name, model, effort }`;
  expect(logs.filter((l) => l.includes("is invalid"))).toEqual([invalid("a".repeat(40))]);
  expect(calls).toEqual([`comment gh-1 not started: acme/web's .tender/ at ${"a".repeat(12)} is invalid; run \`bun tender.ts check <repo> --config <tender.json>\` for details`]);
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
  expect(calls.at(-1)).toBe(`comment gh-1 not started: acme/web's .tender/ at ${"f".repeat(12)} is invalid; run \`bun tender.ts check <repo> --config <tender.json>\` for details`);
  repoFiles["config.yaml"] = "agent: claude\n";
  setBaseSha("d".repeat(40));
  await pass(c, fakeIo((a) => (a[1] === "list-windows" ? windowsOut([]) : a[5] === "--quiet" ? { code: 1 } : noPr(a))).io, () => tr, "/tender");
  expect(calls.at(-1)).toBe("claim gh-2");
});

test("a start uses the type the base branch's types pick from the host's profile, renders {{verify}} and records the type", async () => {
  const dir = join(root, "prof");
  mkdirSync(join(dir, "instructions"), { recursive: true });
  writeFileSync(join(dir, "instructions/bug.md"), "BUG {{id}} {{verify}}");
  writeFileSync(join(dir, "instructions/default.md"), "DEFAULT");
  writeFileSync(join(dir, "types.yaml"), "types:\n  - { name: default, instructions: instructions/default.md }\n");
  repoFiles["config.yaml"] = "types:\n  - { name: bug, match: { labels: [bug] }, instructions: instructions/bug.md }\n";
  const start = async (t: ReturnType<typeof ticket>) => {
    const { tr } = fakeTracker({ ready: [t] });
    const { io } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut([]) : a[5] === "--quiet" ? { code: 1 } : noPr(a)));
    await pass(config({ profile: dir }), io, () => tr, "/tender");
    return readFileSync(join(root, `acme/web/${t.id}.prompt.md`), "utf8");
  };
  const prompt = await start({ ...ticket(1), labels: ["Bug"] });
  expect(prompt).toStartWith("You are working on ticket gh-1 for the GitHub repository acme/web.");
  expect(prompt).toContain("\n\nBUG gh-1 the project's checks (find how they run: README, CI config, package or build files)\n\nWhen the work is done:");
  expect(JSON.parse(readFileSync(join(root, "acme/web/gh-1.type"), "utf8"))).toEqual({ name: "bug", instructions: join(realpathSync(dir), "instructions/bug.md") });
  repoFiles["verify.yaml"] = "checks:\n  - { name: test, run: bun test }\n  - { name: e2e, run: make e2e }\n";
  setBaseSha("b".repeat(40));
  expect(await start({ ...ticket(2), labels: ["bug"] })).toContain("\n\nBUG gh-2 the commands in `.tender/verify.yaml` (checks `test`, `e2e`)\n\n");
  expect(await start(ticket(3))).toContain("\n\nDEFAULT\n\n");
  expect(JSON.parse(readFileSync(join(root, "acme/web/gh-3.type"), "utf8")).name).toBe("default");
  // Near the 64 KiB file cap: 16 checks of 4000-char commands, named rather than inlined.
  repoFiles["verify.yaml"] = `checks:\n${Array.from({ length: 16 }, (_, i) => `  - name: c${i}\n    run: ${"x".repeat(4000)}\n`).join("")}`;
  setBaseSha("c".repeat(40));
  const big = await start({ ...ticket(4), labels: ["bug"] });
  expect(big).not.toContain("xxxx");
  expect(Buffer.byteLength(big)).toBeLessThan(32 * 1024);
});

test("the type is recorded before the tmux window opens, so a failed window still leaves it", async () => {
  const { tr } = fakeTracker({ ready: [ticket(1)] });
  const { io } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut([]) : a[1] === "new-window" ? { code: 1, err: "no server" } : a[5] === "--quiet" ? { code: 1 } : noPr(a)));
  await pass(config(), io, () => tr, "/tender");
  expect(JSON.parse(readFileSync(join(root, "acme/web/gh-1.type"), "utf8")).name).toBe("default");
});

test("promptFor refuses an instruction file swapped for a symlink, or moved under one, after the profile was read", () => {
  const dir = join(root, "swap");
  mkdirSync(join(dir, "instructions"), { recursive: true });
  mkdirSync(join(root, "outside"));
  writeFileSync(join(root, "outside/default.md"), "OUTSIDE");
  writeFileSync(join(dir, "instructions/default.md"), "D");
  writeFileSync(join(dir, "types.yaml"), "types:\n  - { name: default, instructions: instructions/default.md }\n");
  const [t] = loadProfile(dir).types;
  expect(promptFor(t!)).toContain("\n\nD\n\n");
  rmSync(join(dir, "instructions/default.md"));
  symlinkSync(join(root, "outside/default.md"), join(dir, "instructions/default.md"));
  expect(() => promptFor(t!)).toThrow("changed since the profile was read");
  rmSync(join(dir, "instructions"), { recursive: true });
  symlinkSync(join(root, "outside"), join(dir, "instructions"));
  expect(() => promptFor(t!)).toThrow("changed since the profile was read");
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

test("tender check validates a working tree's .tender/ against a profile and prints the effective settings", () => {
  expect(parseArgs(["check"])).toMatchObject({ cmd: "check", id: undefined, configured: false });
  expect(parseArgs(["check", "../repo"])).toMatchObject({ cmd: "check", id: "../repo" });
  expect(parseArgs(["check", "a", "b"])).toEqual({ error: "unexpected argument b" });
  expect(parseArgs(["check", "--config", "x.json"])).toMatchObject({ cmd: "check", configured: true, path: join(process.cwd(), "x.json") });
  expect(check(join(root, "nope"), () => {}, () => {})).toBe(false);
  const out: string[] = [];
  expect(check(root, (s) => out.push(s), (s) => out.push(s))).toBe(true);
  expect(JSON.parse(out[0]!)).toMatchObject({ agent: "claude", tracker: null, criticalPaths: expect.arrayContaining([".tender/**", ".github/**"]), types: [{ name: "bug" }, { name: "docs" }, { name: "default", instructions: join(TENDER_DIR, "profile/instructions/default.md") }], profile: join(TENDER_DIR, "profile") });
  mkdirSync(join(root, ".tender"), { recursive: true });
  writeFileSync(join(root, ".tender/config.yaml"), 'criticalPaths: ["x/**"]\ntypes:\n  - name: ui\n    match: { labels: [ui] }\n    instructions: instructions/docs.md\n    agent: { name: codex, effort: high }\nfeedback: { maxRounds: 2 }\ntracker:\n  linear:\n    project: Web app\n');
  expect(check(root, (s) => out.push(s))).toBe(true);
  expect(JSON.parse(out[1]!)).toMatchObject({ tracker: { linear: { project: "Web app" } }, criticalPaths: expect.arrayContaining(["x/**", ".tender/**"]), types: [{ name: "bug" }, { name: "docs" }, { name: "ui", match: { labels: ["ui"] }, instructions: join(TENDER_DIR, "profile/instructions/docs.md"), agent: { name: "codex", effort: "high" } }, { name: "default" }], feedbackRounds: 2 });
  const dir = join(root, "prof");
  mkdirSync(join(dir, "instructions"), { recursive: true });
  writeFileSync(join(dir, "instructions/default.md"), "D");
  writeFileSync(join(dir, "types.yaml"), "types:\n  - { name: default, instructions: instructions/default.md }\n");
  expect(check(root, (s) => out.push(s), (s) => out.push(s), loadProfile(dir))).toBe(false);
  expect(out[2]).toBe(`${join(root, ".tender")}: invalid:\n  types[0] (ui).instructions: "instructions/docs.md" is not a .md file in the profile ${dir}`);
  const cfg = config({ profile: dir, repos: [{ name: "acme/web", path: join(root, "src-web"), profile: TENDER_DIR + "/profile" }, { name: "acme/api", path: join(root, "src-api") }] });
  const origin = (url: string) => Bun.spawnSync(["sh", "-c", `rm -rf .git && git init -q && git remote add origin ${url}`], { cwd: root });
  origin("git@github.com:ACME/web.git");
  expect(checkProfile(cfg, root).dir).toBe(join(TENDER_DIR, "profile"));
  origin("https://github.com/acme/api");
  expect(checkProfile(cfg, root).dir).toBe(dir);
  origin("https://github.com/acme/other.git");
  expect(checkProfile(cfg, root).dir).toBe(dir);
  symlinkSync("/etc/passwd", join(root, ".tender/verify.yaml"));
  expect(dirEntries(root).map((e) => [e.name, e.regular])).toEqual([["config.yaml", true], ["verify.yaml", false]]);
});
