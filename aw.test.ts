import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINEAR_ISSUES, type Config, type Io, type Ticket, type Tracker, allowedRepo, byPriority, canonCache, github, labelPriority, launcher, linear, linearRepo, linearTicket, parseConfig, parsePhases, pass, render, validRepo } from "./aw";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aw-test-"));
  canonCache.clear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const src = (over: object = {}) => ({ name: "web", tracker: "github", ...over });
const raw = (over: object = {}) => ({
  host: "box",
  workspaceRoot: root,
  defaults: { agent: "claude", sandbox: "nono", testCmd: "bun test" },
  repos: [{ name: "acme/web", path: join(root, "src-web") }],
  sources: [src()],
  ...over,
});
const config = (over: object = {}): Config => parseConfig(raw(over), import.meta.dir);
const web = (c: Config) => c.repos["acme/web"]!;
const ticket = (n: number, repo = "acme/web"): Ticket => ({ id: `gh-${n}`, ref: String(n), title: `Fix thing ${n}`, body: "body; rm -rf ~ $(whoami)", url: `https://x/${n}`, repo });

function fakeTracker(s: { ready?: Ticket[]; inProgress?: Ticket[]; inReview?: Ticket[]; done?: string[] }) {
  const calls: string[] = [];
  const subs: { ref: string; title: string }[] = [];
  const tr: Tracker = {
    listReady: async () => s.ready ?? [],
    listInProgress: async () => s.inProgress ?? [],
    listInReview: async () => s.inReview ?? [],
    isDone: async (id, repo) => (s.done ?? []).some((d) => d === id || d === `${repo}#${id}`),
    claim: async (t) => void calls.push(`claim ${t.id}`),
    toReview: async (t, pr) => void calls.push(`review ${t.id} ${pr}`),
    comment: async (t, b) => void calls.push(`comment ${t.id} ${b}`),
    createPhase: async (t, title) => (calls.push(`create ${t.id} ${title}`), subs.push({ ref: `sub-${calls.length}`, title }), `sub-${calls.length}`),
    listPhases: async () => subs,
    setPhase: async (_t, ref, st) => void calls.push(`set ${ref} ${st}`),
  };
  return { tr, calls, subs };
}

function fakeIo(respond: (argv: string[]) => { code?: number; out?: string } | undefined = () => undefined, dry = false) {
  const cmds: string[] = [];
  const logs: string[] = [];
  const io: Io = {
    dry,
    fetch: (() => Promise.reject(new Error("no network"))) as any,
    log: (m) => logs.push(m),
    run: async (argv) => {
      cmds.push(argv.join(" "));
      const r =
        respond(argv) ??
        (argv[1] === "repo" && argv[2] === "view" ? { out: JSON.stringify({ nameWithOwner: argv[3] }) } : argv[5] === "--git-common-dir" ? { out: join(realpathSync(argv[2]!), ".git") + "\n" } : {});
      if (argv[1] === "repo" && argv[2] === "clone" && !r.code) mkdirSync(argv[4]!, { recursive: true });
      return { code: r.code ?? 0, out: r.out ?? "", err: r.code ? "boom" : "" };
    },
  };
  return { io, cmds, logs };
}

async function withLinearKey<T>(fn: () => Promise<T>) {
  const prev = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_KEY = "k";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = prev;
  }
}

const worktree = (id: string, source = "web", repo = "acme/web") => {
  mkdirSync(join(root, repo, id), { recursive: true });
  writeFileSync(join(root, repo, `${id}.source`), source);
};
const writePhases = (id: string, phases: unknown) => {
  worktree(id);
  mkdirSync(join(root, "acme/web", id, ".aw"), { recursive: true });
  writeFileSync(join(root, "acme/web", id, ".aw/phases.json"), typeof phases === "string" ? phases : JSON.stringify(phases));
};
const phase = (key: string, status: unknown, over: object = {}) => ({ key, title: `Do ${key}`, body: "b", status, ...over });

const windowsOut =(names: string[]) => ({ out: names.map((n, i) => `@${i} ${n}`).join("\n") });
const noPr = (argv: string[]) => (argv[1] === "pr" ? { out: "[]" } : undefined);

test("config: defaults applied and errors listed", () => {
  const c = config();
  expect(c.pollIntervalMs).toBe(60000);
  expect(c.tmuxSession).toBe("aw");
  expect(c.maxConcurrent).toBe(2);
  expect(c.reposRoot).toMatch(/\/agent-repos$/);
  expect(c.sources[0]).toMatchObject({ readyLabel: "agent", done: ["Done", "Canceled", "Duplicate"] });
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
  expect(err(raw({ defaultHost: "yes" }))).toMatch(/defaultHost/);
});

test("example config validates", () => {
  const raw = JSON.parse(readFileSync(join(import.meta.dir, "aw.example.json"), "utf8"));
  expect(parseConfig(raw, import.meta.dir).sources.length).toBeGreaterThan(0);
});

test("render is single-pass so ticket text cannot expand placeholders", () => {
  expect(render("{{title}} / {{body}} / {{nope}}", { title: "{{body}}", body: "b" })).toBe("{{body}} / b / {{nope}}");
});

test("launcher: claude under nono, ticket text never in shell", () => {
  const c = config();
  const s = launcher(web(c), { ...ticket(1), title: "x'; rm -rf / $(id) `id`" }, "/ws/web/gh-1", "/ws/web/gh-1.prompt.md", "/aw");
  expect(s).toContain("export CLAUDE_CONFIG_DIR=\"$HOME/.claude-aw\" CODEX_HOME=\"$HOME/.codex-aw\" CLAUDE_CODE_TMPDIR=\"$HOME/.claude-aw/tmp\"");
  expect(s).toContain("--no-rollback-prompt");
  expect(s).toContain(`exec nono run --no-rollback-prompt --profile '/aw/nono/aw-claude.json' --allow '/ws/web/gh-1' --allow '${root}/src-web/.git' -- claude --remote-control`);
  expect(s).toContain(`--permission-mode bypassPermissions "$(cat '/ws/web/gh-1.prompt.md')"`);
  expect(s).not.toMatch(/\$\(id\)|`id`|'; rm/);
});

test("launcher: codex without sandbox keeps the daemon", () => {
  const c = config({ repos: [{ name: "acme/web", agent: "codex", sandbox: "none" }] });
  const s = launcher(web(c), ticket(2), "/ws/web/gh-2", "/ws/web/gh-2.prompt.md", "/aw");
  expect(s).toContain('export CODEX_HOME="$HOME/.codex-aw"');
  expect(s).toContain(`exec codex --sandbox danger-full-access --ask-for-approval never -C '/ws/web/gh-2' "$(cat '/ws/web/gh-2.prompt.md')"`);
  expect(launcher(web(config({ repos: [{ name: "acme/web", agent: "codex" }] })), ticket(2), "/w", "/p", "/aw")).toContain("-- codex --no-daemon ");
});

test("starts ready tickets up to maxConcurrent", async () => {
  const c = config({ maxConcurrent: 2 });
  const { tr, calls } = fakeTracker({ ready: [ticket(1), ticket(2), ticket(3)] });
  const { io, cmds } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/gh-9"]) : a[4] === "--verify" ? { code: 1 } : noPr(a)));
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["claim gh-1"]);
  expect(cmds).toContain(`git -C ${root}/src-web worktree add ${root}/acme/web/gh-1 -b agent/gh-1 origin/main`);
  expect(cmds).toContain(`tmux new-window -d -t =aw: -n acme/web/gh-1 ${root}/acme/web/gh-1.sh`);
  const prompt = readFileSync(join(root, "acme/web/gh-1.prompt.md"), "utf8");
  expect(prompt).toContain("body; rm -rf ~ $(whoami)");
  expect(prompt).toContain("git push -u origin agent/gh-1");
});

test("reuses existing worktree dir and existing branch", async () => {
  const c = config();
  mkdirSync(join(root, "acme/web/gh-1"), { recursive: true });
  const { tr } = fakeTracker({ ready: [ticket(1), ticket(2)] });
  const { io, cmds, logs } = fakeIo(noPr);
  await pass(c, io, () => tr, "/aw");
  expect(logs.some((l) => l.includes(`reuse ${root}/acme/web/gh-1`))).toBe(true);
  expect(cmds).toContain(`git -C ${root}/src-web worktree add ${root}/acme/web/gh-2 agent/gh-2`);
});

test("in-progress: PR moves to review; missing window comments once", async () => {
  const c = config();
  const { tr, calls } = fakeTracker({ inProgress: [ticket(1), ticket(2), ticket(3)] });
  const { io } = fakeIo((a) => {
    if (a[1] === "list-windows") return windowsOut(["acme/web/gh-3"]);
    if (a[1] === "pr") return { out: a.includes("agent/gh-1") ? '[{"url":"https://pr/1","state":"OPEN"}]' : "[]" };
  });
  await pass(c, io, () => tr, "/aw");
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["review gh-1 https://pr/1", "comment gh-2 session ended without a PR", "review gh-1 https://pr/1"]);
  expect(existsSync(join(root, "acme/web/gh-2.ended"))).toBe(true);
});

test("done: kills window, removes worktree and files; keeps files when remove fails", async () => {
  const c = config();
  for (const id of ["gh-1", "gh-2", "gh-3"]) {
    mkdirSync(join(root, "acme/web", id), { recursive: true });
    for (const ext of [".prompt.md", ".sh", ".ended"]) writeFileSync(join(root, "acme/web", id + ext), "");
    writeFileSync(join(root, "acme/web", `${id}.source`), "web\n");
  }
  const { tr } = fakeTracker({ done: ["gh-1", "gh-2"] });
  const { io, cmds, logs } = fakeIo((a) => {
    if (a[1] === "list-windows") return windowsOut(["acme/web/gh-1"]);
    if (a[3] === "worktree" && a[5]?.endsWith("gh-2")) return { code: 1 };
  });
  await pass(c, io, () => tr, "/aw");
  expect(cmds).toContain("tmux kill-window -t @0");
  expect(cmds.filter((x) => x.includes("kill-window"))).toHaveLength(1);
  expect(existsSync(join(root, "acme/web/gh-1.sh"))).toBe(false);
  expect(existsSync(join(root, "acme/web/gh-1.source"))).toBe(false);
  expect(existsSync(join(root, "acme/web/gh-2.sh"))).toBe(true);
  expect(existsSync(join(root, "acme/web/gh-3.sh"))).toBe(true);
  expect(logs.some((l) => l.includes("[web] cleanup acme/web/gh-2 failed"))).toBe(true);
});

test("one ticket or source failing does not stop the rest", async () => {
  const c = config({ sources: [src(), src({ name: "api" })] });
  const bad: Tracker = { ...fakeTracker({}).tr, listReady: () => Promise.reject(new Error("api down")), listInProgress: () => Promise.reject(new Error("api down")) };
  const good = fakeTracker({ ready: [ticket(1), ticket(2)] });
  good.tr.claim = async (t) => {
    if (t.id === "gh-1") throw new Error("nope");
    good.calls.push(`claim ${t.id}`);
  };
  const { io, logs } = fakeIo(noPr);
  await pass(c, io, (l) => (l.name === "web" ? bad : good.tr), "/aw");
  expect(logs.some((l) => l.includes("[web] list ready failed: api down"))).toBe(true);
  expect(logs.some((l) => l.includes("[api] start gh-1 failed: nope"))).toBe(true);
  expect(good.calls).toEqual(["claim gh-2"]);
});

test("dry-run logs side effects and executes none", async () => {
  const c = config();
  mkdirSync(join(root, "acme/web/gh-5"), { recursive: true });
  writeFileSync(join(root, "acme/web/gh-5.source"), "web");
  const { tr } = fakeTracker({ ready: [ticket(1)], done: ["gh-5"] });
  const { io, cmds, logs } = fakeIo((a) => (a[1] === "has-session" ? { code: 1 } : noPr(a)), true);
  await pass(c, io, () => tr, "/aw");
  expect(cmds.every((x) => /has-session|list-windows|rev-parse|gh pr list|gh repo view/.test(x))).toBe(true);
  expect(logs.some((l) => l.includes("dry: tmux new-session -d -s aw"))).toBe(true);
  expect(logs.some((l) => l.includes(`dry: git -C ${root}/src-web worktree remove ${root}/acme/web/gh-5`))).toBe(true);
  expect(logs.some((l) => l.includes("dry: tmux new-window"))).toBe(true);
  expect(existsSync(join(root, "acme/web/gh-1.prompt.md"))).toBe(false);
  expect(existsSync(join(root, "acme/web/gh-1.source"))).toBe(false);
});

test("github adapter: ready requires host label, skips claimed, edits labels", async () => {
  const l = config().sources[0]!;
  const issues = [
    { number: 7, title: "t", body: null, url: "u", labels: [{ name: "agent" }, { name: "priority:High" }] },
    { number: 8, title: "t", body: "", url: "u", labels: [{ name: "agent" }, { name: "in-progress" }] },
    { number: 9, title: "t", body: "", url: "u", labels: [{ name: "agent" }, { name: "in-review" }] },
  ];
  const { io, cmds } = fakeIo((a) => (a[2] === "list" ? { out: JSON.stringify(issues) } : a[1] === "issue" && a[2] === "view" ? { out: '{"state":"CLOSED"}' } : undefined));
  const tr = github(l, "box", io, false, ["acme/web"]);
  expect((await tr.listReady()).map((t) => [t.id, t.priority])).toEqual([["gh-7", 2]]);
  expect(cmds[0]).toBe("gh repo view acme/web --json nameWithOwner");
  expect(cmds[1]).toContain("--label agent --label host:box");
  await tr.claim((await tr.listReady())[0]!);
  expect(cmds).toContain("gh issue edit 7 --repo acme/web --add-label in-progress");
  expect(cmds).toContain("gh issue comment 7 --repo acme/web --body picked up on box");
  expect(await tr.isDone("gh-7", "acme/web")).toBe(true);
  expect(cmds).toContain("gh issue view 7 --repo acme/web --json state");
  await expect(tr.isDone("ENG-1", "acme/web")).rejects.toThrow();
});

test("github adapter: polls every repo of the source and tags tickets with it", async () => {
  const c = config({ repos: [{ name: "acme/web", path: "/a" }, { name: "acme/api", path: "/b" }] });
  const { io, cmds } = fakeIo((a) => (a[2] === "list" ? { out: JSON.stringify([{ number: 12, title: "t", body: "", url: "u", labels: [] }]) } : undefined));
  const tickets = await github(c.sources[0]!, "box", io, false, Object.keys(c.repos)).listInProgress();
  expect(tickets.map((t) => `${t.repo}#${t.id}`)).toEqual(["acme/web#gh-12", "acme/api#gh-12"]);
  expect(cmds.filter((x) => x.startsWith("gh issue list")).map((x) => x.split(" ")[4])).toEqual(["acme/web", "acme/api"]);
  await github(c.sources[0]!, "box", io, false, []).comment(tickets[1]!, "hi");
  expect(cmds.at(-1)).toBe("gh issue comment 12 --repo acme/api --body hi");
});

test("github adapter: defaultHost takes unlabelled tickets, not other hosts'", async () => {
  const l = config().sources[0]!;
  const lbl = (...n: string[]) => n.map((name) => ({ name }));
  const issues = [
    { number: 1, title: "t", body: "", url: "u", labels: lbl("agent") },
    { number: 2, title: "t", body: "", url: "u", labels: lbl("agent", "host:BOX") },
    { number: 3, title: "t", body: "", url: "u", labels: lbl("agent", "host:vm") },
  ];
  const { io, cmds } = fakeIo((a) => (a[2] === "list" ? { out: JSON.stringify(issues) } : undefined));
  expect((await github(l, "box", io, true, ["acme/web"]).listReady()).map((t) => t.id)).toEqual(["gh-1", "gh-2"]);
  expect(cmds[1]).not.toContain("host:");
  expect(cmds[1]).toContain('--search -label:"in-progress" -label:"in-review"');
});

test("github adapter: in-progress list needs the agent label (defaultHost)", async () => {
  const l = config().sources[0]!;
  const { io, cmds } = fakeIo((a) => (a[2] === "list" ? { out: "[]" } : undefined));
  await github(l, "box", io, true, ["acme/web"]).listInProgress();
  expect(cmds[1]).toContain("--label agent --label in-progress");
});

test("linear adapter: defaultHost takes unlabelled tickets, not other hosts'", async () => {
  const l = config({ sources: [src({ tracker: "linear", team: "ENG" })] }).sources[0]!;
  const node = (identifier: string, ...labels: string[]) => ({ id: identifier, identifier, title: "t", description: null, url: "u", labels: { nodes: labels.map((name) => ({ name })) } });
  const bodies: any[] = [];
  const { io } = fakeIo();
  io.fetch = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ data: { issues: { nodes: [node("ENG-1", "agent"), node("ENG-2", "agent", "host:box"), node("ENG-3", "agent", "host:other")] } } });
  }) as any;
  const prev = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_KEY = "k";
  try {
    expect((await linear(l, "box", io, true).listReady()).map((t) => t.id)).toEqual(["ENG-1", "ENG-2"]);
  } finally {
    if (prev === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = prev;
  }
  expect(bodies[0].query).toContain("labels { nodes { name parent { name } } }");
  expect(bodies[0].query).toContain("project { description content labels");
  expect(JSON.stringify(bodies[0].variables)).not.toContain("host:");
});

test("pass hands defaultHost to the tracker factory", async () => {
  const c = config({ defaultHost: true });
  const seen: unknown[] = [];
  const { io } = fakeIo(noPr);
  await pass(c, io, (_l, host, _io, defaultHost) => (seen.push(host, defaultHost), fakeTracker({}).tr), "/aw");
  expect(seen).toEqual(["box", true]);
});

test("phases: validation rejects bad files", () => {
  expect(parsePhases(JSON.stringify([phase("a", "todo", { body: undefined })]))).toEqual([{ key: "a", title: "Do a", body: "", status: "todo" }]);
  const bad: unknown[] = [
    "not json",
    "{}",
    Array.from({ length: 21 }, (_, i) => phase(`p${i}`, "todo")),
    [phase("Bad_Key", "todo")],
    [phase("constructor", "todo"), phase("constructor", "done")],
    [phase("a", "blocked")],
    [phase("a", ["done"])],
    [phase("-a", "todo")],
    [phase("a", "todo", { title: "" })],
    [phase("a", "todo", { title: "x".repeat(121) })],
    [phase("a", "todo", { title: "two\nlines" })],
    [phase("a", "todo", { body: "x".repeat(4001) })],
    [phase("a", "todo", { body: "\u001b[2J" })],
    [phase("a", "todo", { id: "42" })],
    [null],
  ];
  for (const b of bad) expect(() => parsePhases(typeof b === "string" ? b : JSON.stringify(b))).toThrow();
});

test("phases: created once, status synced forward only, survives restart", async () => {
  const c = config();
  const { tr, calls } = fakeTracker({ inProgress: [ticket(1)] });
  const { io, logs } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/gh-1"]) : noPr(a)));
  writePhases("gh-1", [phase("a", "in-progress"), phase("b", "todo")]);
  await pass(c, io, () => tr, "/aw");
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["create gh-1 gh-1: Do a", "set sub-1 in-progress", "create gh-1 gh-1: Do b"]);
  calls.length = 0;
  writePhases("gh-1", [phase("a", "todo"), phase("b", "done"), phase("c", "todo")]);
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["set sub-3 in-progress", "create gh-1 gh-1: Do c"]);
  expect(logs.some((l) => l.includes("phase gh-1/a: ignoring in-progress -> todo"))).toBe(true);
  expect(JSON.parse(readFileSync(join(root, "acme/web/gh-1.phases.json"), "utf8"))).toEqual({
    a: { ref: "sub-1", status: "in-progress" },
    b: { ref: "sub-3", status: "in-progress" },
    c: { ref: "sub-2", status: "todo" },
  });
  expect(existsSync(join(root, "acme/web/gh-1.phases.json.tmp"))).toBe(false);
});

test("phases: done is held at in-progress until the PR exists, then closed before review", async () => {
  const c = config();
  const { tr, calls } = fakeTracker({ inProgress: [ticket(1)] });
  let prs = "[]";
  const { io } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/gh-1"]) : a[1] === "pr" ? { out: prs } : undefined));
  writePhases("gh-1", [phase("a", "done")]);
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["create gh-1 gh-1: Do a", "set sub-1 in-progress"]);
  prs = '[{"url":"https://pr/1","state":"OPEN"}]';
  await pass(c, io, () => tr, "/aw");
  expect(calls.slice(2)).toEqual(["set sub-1 done", "review gh-1 https://pr/1"]);
});

test("phases: tickets in review keep syncing until the final sync succeeds", async () => {
  const c = config();
  const { tr, calls } = fakeTracker({ inReview: [ticket(1)] });
  const { io } = fakeIo(noPr);
  writePhases("gh-1", [phase("a", "done"), phase("b", "done")]);
  writeFileSync(join(root, "acme/web/gh-1.phases.json"), JSON.stringify({ a: { ref: "sub-a", status: "in-progress" } }));
  await pass(c, io, () => tr, "/aw");
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["set sub-a done", "create gh-1 gh-1: Do b", "set sub-2 done"]);
});

test("phases: a sub-ticket created before a lost sidecar write is adopted, not duplicated", async () => {
  const c = config();
  const { tr, calls, subs } = fakeTracker({ inProgress: [ticket(1)] });
  subs.push({ ref: "sub-other", title: "gh-1: Something else" }, { ref: "sub-old", title: "gh-1: Do a" });
  const { io } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/gh-1"]) : noPr(a)));
  writePhases("gh-1", [phase("a", "in-progress"), phase("b", "todo")]);
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["set sub-old in-progress", "create gh-1 gh-1: Do b"]);
});

test("phases: bad or symlinked file is logged and the parent still moves to review", async () => {
  const c = config();
  const { tr, calls } = fakeTracker({ inProgress: [ticket(1), ticket(2), ticket(3)] });
  const { io, logs } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/gh-1", "acme/web/gh-2", "acme/web/gh-3"]) : a[1] === "pr" ? { out: '[{"url":"https://pr/1","state":"OPEN"}]' } : undefined));
  writePhases("gh-1", "x".repeat(70 * 1024));
  worktree("gh-2");
  mkdirSync(join(root, "outside"));
  writeFileSync(join(root, "outside/phases.json"), JSON.stringify([phase("a", "todo")]));
  symlinkSync(join(root, "outside"), join(root, "acme/web/gh-2/.aw"));
  writePhases("gh-3", "[]");
  rmSync(join(root, "acme/web/gh-3/.aw/phases.json"));
  symlinkSync(join(root, "outside/phases.json"), join(root, "acme/web/gh-3/.aw/phases.json"));
  await pass(c, io, () => tr, "/aw");
  expect(logs.some((l) => l.includes("phases gh-1 failed: phases: must be a regular file"))).toBe(true);
  expect(logs.some((l) => l.includes("phases gh-2 failed: ENOTDIR"))).toBe(true);
  expect(logs.some((l) => l.includes("phases gh-3 failed: ELOOP"))).toBe(true);
  expect(calls).toEqual(["review gh-1 https://pr/1", "review gh-2 https://pr/1", "review gh-3 https://pr/1"]);
});

test("phases: start git-ignores .aw; cleanup removes the sidecar", async () => {
  const c = config();
  const { tr } = fakeTracker({ ready: [ticket(1)], done: ["gh-2"] });
  mkdirSync(join(root, "acme/web/gh-2"), { recursive: true });
  writeFileSync(join(root, "acme/web/gh-2.phases.json"), "{}");
  writeFileSync(join(root, "acme/web/gh-2.source"), "web");
  const { io } = fakeIo(noPr);
  await pass(c, io, () => tr, "/aw");
  expect(readFileSync(join(root, "acme/web/gh-1/.aw/.gitignore"), "utf8")).toBe("*\n");
  expect(existsSync(join(root, "acme/web/gh-2.phases.json"))).toBe(false);
});

test("phases: a FIFO phases file is rejected without blocking the poller", async () => {
  const c = config();
  const { tr } = fakeTracker({ inProgress: [ticket(1)] });
  const { io, logs } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/gh-1"]) : noPr(a)));
  worktree("gh-1");
  mkdirSync(join(root, "acme/web/gh-1/.aw"), { recursive: true });
  expect(Bun.spawnSync(["mkfifo", join(root, "acme/web/gh-1/.aw/phases.json")]).exitCode).toBe(0);
  await pass(c, io, () => tr, "/aw");
  expect(logs.some((l) => l.includes("phases gh-1 failed: phases: must be a regular file"))).toBe(true);
});

test("start never writes .aw/.gitignore through an agent-planted symlink", async () => {
  const c = config();
  const { tr } = fakeTracker({ ready: [ticket(1), ticket(2)] });
  const { io, logs } = fakeIo(noPr);
  mkdirSync(join(root, "outside"));
  writeFileSync(join(root, "outside/victim"), "secret");
  mkdirSync(join(root, "acme/web/gh-1/.aw"), { recursive: true });
  symlinkSync(join(root, "outside/victim"), join(root, "acme/web/gh-1/.aw/.gitignore"));
  mkdirSync(join(root, "acme/web/gh-2"), { recursive: true });
  symlinkSync(join(root, "outside"), join(root, "acme/web/gh-2/.aw"));
  await pass(c, io, () => tr, "/aw");
  expect(readFileSync(join(root, "outside/victim"), "utf8")).toBe("secret");
  expect(readFileSync(join(root, "acme/web/gh-1/.aw/.gitignore"), "utf8")).toBe("*\n");
  expect(existsSync(join(root, "outside/.gitignore"))).toBe(false);
  expect(logs.some((l) => l.includes("start gh-2 failed: ENOTDIR"))).toBe(true);
});

test("github adapter: phases become sub-issues that are never picked up as work", async () => {
  const c = config({ defaultHost: true });
  const issues: { number: number; title: string; body: string; url: string; labels: string[]; open: boolean; parent?: string }[] = [{ number: 1, title: "t", body: "", url: "u", labels: ["agent", "in-progress"], open: true }];
  let prs = "[]";
  const { io, cmds } = fakeIo((a) => {
    if (a[1] === "list-windows") return windowsOut(["acme/web/gh-1"]);
    if (a[1] === "pr") return { out: prs };
    if (a[1] === "api") return { out: JSON.stringify(issues.filter((x) => a[2] === `repos/acme/web/issues/${x.parent}/sub_issues?per_page=100`)) };
    const i = issues.find((x) => String(x.number) === a[3]);
    if (a[2] === "create") {
      issues.push({ number: issues.length + 1, title: a[a.indexOf("--title") + 1]!, body: "", url: "u", labels: [], open: true, parent: a[a.indexOf("--parent") + 1] });
      return { out: `https://github.com/acme/web/issues/${issues.length}\n` };
    }
    if (a[2] === "edit") {
      i!.labels.push(a[a.indexOf("--add-label") + 1]!);
      i!.labels = i!.labels.filter((x) => !a.includes("--remove-label") || x !== a[a.indexOf("--remove-label") + 1]);
    }
    if (a[2] === "close") i!.open = false;
    if (a[2] === "list") {
      const want = a.flatMap((x, k) => (a[k - 1] === "--label" ? [x] : []));
      return { out: JSON.stringify(issues.filter((x) => x.open && want.every((w) => x.labels.includes(w))).map((x) => ({ ...x, labels: x.labels.map((name) => ({ name })) }))) };
    }
  });
  writePhases("gh-1", [phase("a", "in-progress"), phase("b", "done")]);
  await pass(c, io, github, "/aw");
  expect(cmds).toContain("gh issue create --repo acme/web --parent 1 --title gh-1: Do a --body b");
  expect(cmds).toContain("gh issue edit 2 --repo acme/web --add-label in-progress");
  expect(cmds).toContain("gh issue edit 3 --repo acme/web --add-label in-progress");
  expect(issues[1]!.labels).toEqual(["in-progress"]);
  const before = cmds.length;
  await pass(c, io, github, "/aw");
  const second = cmds.slice(before);
  expect(second.filter((x) => /issue (create|edit|close|comment)|new-window/.test(x))).toEqual([]);
  const tr = github(c.sources[0]!, "box", io, true, ["acme/web"]);
  expect((await tr.listInProgress()).map((t) => t.id)).toEqual(["gh-1"]);
  expect(await tr.listReady()).toEqual([]);
  prs = '[{"url":"https://pr/1","state":"OPEN"}]';
  const at = cmds.length;
  await pass(c, io, github, "/aw");
  expect(cmds.slice(at).filter((x) => /issue (create|edit|close)/.test(x))).toEqual(["gh issue close 3 --repo acme/web", "gh issue edit 1 --repo acme/web --add-label in-review --remove-label in-progress"]);
  expect((await tr.listInReview()).map((t) => t.id)).toEqual(["gh-1"]);
});

test("linear adapter: phases become child issues that are never picked up as work", async () => {
  const c = config({ defaultHost: true, sources: [src({ tracker: "linear", team: "ENG" })] });
  const states = [
    { id: "s-todo", name: "Todo" },
    { id: "s-prog", name: "In Progress" },
    { id: "s-done", name: "Done" },
  ].map((s) => ({ ...s, team: { id: "team-1" } }));
  const issues: any[] = [{ id: "u-1", identifier: "ENG-1", title: "t", description: "", url: "u", state: "In Progress", labels: ["agent", "repo:acme/web"] }];
  const mutations: any[] = [];
  let prs = "[]";
  const { io } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/ENG-1"]) : a[1] === "pr" ? { out: prs } : undefined));
  io.fetch = (async (_url: string, init: any) => {
    const { query, variables } = JSON.parse(init.body);
    if (query.includes("workflowStates")) return Response.json({ data: { workflowStates: { nodes: states } } });
    if (query.includes("children")) return Response.json({ data: { issue: { children: { nodes: issues.filter((i) => i.parentId === variables.id) } } } });
    if (query.includes("issueCreate")) {
      mutations.push(variables.i);
      const n = issues.length + 1;
      issues.push({ id: `u-${n}`, identifier: `ENG-${n}`, title: variables.i.title, description: "", url: "u", state: "Todo", labels: [], parentId: variables.i.parentId });
      return Response.json({ data: { issueCreate: { issue: { id: `u-${n}` } } } });
    }
    if (query.includes("issueUpdate")) {
      mutations.push(variables);
      issues.find((i) => i.id === variables.id).state = states.find((s) => s.id === variables.s)!.name;
      return Response.json({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes("issues(")) {
      const f = variables.f;
      const want = f.and.map((x: any) => x.labels.some.name.eq);
      const nodes = issues.filter((i) => i.state === f.state.name.eq && want.every((w: string) => i.labels.includes(w)));
      return Response.json({ data: { issues: { nodes: nodes.map((i) => ({ ...i, labels: { nodes: i.labels.map((name: string) => ({ name })) } })) } } });
    }
    return Response.json({ data: {} });
  }) as any;
  writePhases("ENG-1", [phase("a", "in-progress"), phase("b", "done"), phase("c", "todo")]);
  await withLinearKey(async () => {
    await pass(c, io, linear, "/aw");
    await pass(c, io, linear, "/aw");
    const tr = linear(c.sources[0]!, "box", io, true);
    expect((await tr.listReady()).map((t) => t.id)).toEqual([]);
    expect((await tr.listInProgress()).map((t) => t.id)).toEqual(["ENG-1"]);
    prs = '[{"url":"https://pr/1","state":"OPEN"}]';
    await pass(c, io, linear, "/aw");
  });
  expect(mutations).toEqual([
    { teamId: "team-1", parentId: "u-1", stateId: "s-todo", title: "ENG-1: Do a", description: "b" },
    { id: "u-2", s: "s-prog" },
    { teamId: "team-1", parentId: "u-1", stateId: "s-todo", title: "ENG-1: Do b", description: "b" },
    { id: "u-3", s: "s-prog" },
    { teamId: "team-1", parentId: "u-1", stateId: "s-todo", title: "ENG-1: Do c", description: "b" },
    { id: "u-3", s: "s-done" },
  ]);
});

test("phases: dry-run creates nothing and writes no sidecar", async () => {
  const c = config();
  const { io, cmds, logs } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/gh-1"]) : a[2] === "list" ? { out: JSON.stringify([{ number: 1, title: "t", body: "", url: "u", labels: [] }]) } : a[1] === "api" ? { out: "[]" } : noPr(a)), true);
  writePhases("gh-1", [phase("a", "done")]);
  await pass(c, io, github, "/aw");
  expect(cmds.filter((x) => /issue (create|edit|close)/.test(x))).toEqual([]);
  expect(logs.some((l) => l.includes("dry: gh issue create --repo acme/web --parent 1"))).toBe(true);
  expect(logs.some((l) => l.includes("dry: gh issue close  --repo acme/web"))).toBe(true);
  expect(existsSync(join(root, "acme/web/gh-1.phases.json"))).toBe(false);
});

const two = (over: object = {}) =>
  config({ maxConcurrent: 4, repos: [{ name: "acme/web", path: join(root, "src-web") }, { name: "acme/api", path: join(root, "src-api"), ...over }], sources: [src({ name: "gh" }), src({ name: "lin", tracker: "linear", team: "ENG" })] });

test("allowlist: a rejected ticket gets one comment whatever the reason, kept across restarts", async () => {
  const c = two();
  const eng = (n: number, repo?: string): Ticket => ({ ...ticket(n), id: `ENG-${n}`, repo });
  const run = async (ready: Ticket[]) => {
    const f = fakeTracker({ ready });
    const { io, cmds } = fakeIo(noPr);
    await pass(c, io, (s) => (s.name === "lin" ? f.tr : fakeTracker({}).tr), "/aw");
    return { calls: f.calls, cmds };
  };
  const first = await run([eng(1, "evil/x"), eng(2), eng(3, "a/b;rm -rf ~")]);
  expect(first.calls).toEqual([
    "comment ENG-1 aw: repo evil/x is not in the aw allowlist",
    expect.stringContaining("comment ENG-2 aw: no repo set on this ticket"),
    'comment ENG-3 aw: repo "a/b;rm -rf ~" is not a valid owner/name',
  ]);
  expect(first.cmds.some((x) => /worktree|new-window|clone/.test(x))).toBe(false);
  expect((await run([eng(1, "evil/x"), eng(2), eng(3, "a/b;rm -rf ~")])).calls).toEqual([]);
  for (const repo of ["EVIL/X", "evil/y", "evil/x", undefined]) expect((await run([eng(1, repo)])).calls).toEqual([]);
  expect(readFileSync(join(root, ".rejected/ENG-1"), "utf8")).toBe("repo evil/x is not in the aw allowlist");
});

test("linear repo resolution: label > description > project summary > project overview", () => {
  const texts = (d?: string, ps?: string, pc?: string) => [d, ps, pc];
  expect(linearRepo(["agent", "Repo:acme/web"], texts("repo: acme/api"))).toBe("acme/web");
  expect(linearRepo(["agent"], texts("intro\r\nrepo:  acme/api \r\nmore", "repo: acme/web"))).toBe("acme/api");
  expect(linearRepo([], texts("see the repo: acme/api", "repo: acme/web"))).toBe("acme/web");
  expect(linearRepo([], texts(undefined, "summary", "# Overview\nrepo: acme/api"))).toBe("acme/api");
  expect(linearRepo([], texts(null as any, ""))).toBeUndefined();
  expect(linearRepo([], texts())).toBeUndefined();
  const c = two();
  for (const bad of ["../x", "acme/..", "a/b;rm -rf", "a/b/c", "a//b", "/a/b", "-x/y", "a/b\nc", "a b/c", ""])
    expect(allowedRepo(c, linearRepo([], [`repo: ${bad}`]))).toBeUndefined();
  expect(linearRepo([], ["repo: a/b;rm -rf\nrepo: acme/web"])).toBe("a/b;rm -rf");
  expect(allowedRepo(c, "ACME/Web")).toBe("acme/web");
});

test("linear adapter: tickets carry the resolved repo from labels, description and project", async () => {
  const l = two().sources[1]!;
  const node = (identifier: string, labels: string[], description: string | null, project: object | null) => ({ id: identifier, identifier, title: "t", description, url: "u", labels: { nodes: labels.map((name) => ({ name })) }, project });
  const { io } = fakeIo();
  io.fetch = (async () =>
    Response.json({
      data: {
        issues: {
          nodes: [
            node("ENG-1", ["agent", "repo:acme/api"], "repo: acme/web", null),
            node("ENG-2", ["agent"], "x\nrepo: acme/api", { description: "repo: acme/web", content: null }),
            node("ENG-3", ["agent"], null, { description: "", content: "repo: ACME/API" }),
            node("ENG-4", ["agent"], null, null),
          ],
        },
      },
    })) as any;
  const got = await withLinearKey(() => linear(l, "box", io, true).listReady());
  expect(got.map((t) => t.repo)).toEqual(["acme/api", "acme/api", "ACME/API", undefined]);
});

test("allowlist match is case-insensitive and uses the canonical key", async () => {
  const c = two();
  const { tr, calls } = fakeTracker({ ready: [{ ...ticket(1), id: "ENG-1", repo: "ACME/Api" }] });
  const { io, cmds } = fakeIo(noPr);
  await pass(c, io, (s) => (s.name === "lin" ? tr : fakeTracker({}).tr), "/aw");
  expect(calls).toEqual(["claim ENG-1"]);
  expect(cmds).toContain(`tmux new-window -d -t =aw: -n acme/api/ENG-1 ${root}/acme/api/ENG-1.sh`);
  expect(readFileSync(join(root, "acme/api/ENG-1.source"), "utf8")).toBe("lin");
  expect(readFileSync(join(root, "acme/api/ENG-1.prompt.md"), "utf8")).toContain("GitHub repository acme/api");
});

test("clone on demand: missing clone is cloned with gh before the worktree, existing one is not", async () => {
  const c = two();
  mkdirSync(join(root, "src-web"));
  const { tr } = fakeTracker({ ready: [ticket(1)] });
  const { io, cmds } = fakeIo(noPr);
  await pass(c, io, (s) => (s.name === "gh" ? tr : fakeTracker({}).tr), "/aw");
  expect(cmds.filter((x) => x.startsWith("gh repo clone"))).toEqual([]);
  const c2 = config({ reposRoot: join(root, "clones"), repos: ["acme/web"] });
  const f = fakeTracker({ ready: [ticket(3)] });
  const r2 = fakeIo(noPr);
  await pass(c2, r2.io, () => f.tr, "/aw");
  const clone = r2.cmds.findIndex((x) => x.startsWith(`gh repo clone acme/web ${root}/clones/acme/web.tmp-`));
  expect(clone).toBeGreaterThan(-1);
  expect(r2.cmds.indexOf(`git -C ${root}/clones/acme/web fetch origin main`)).toBeGreaterThan(clone);
  expect(readdirSync(join(root, "clones/acme"))).toEqual(["web"]);
});

test("same ticket number in two repos does not collide", async () => {
  const c = two();
  const { tr, calls } = fakeTracker({ ready: [ticket(12), ticket(12, "acme/api")] });
  const { io, cmds } = fakeIo((a) => (a[4] === "--verify" ? { code: 1 } : noPr(a)));
  await pass(c, io, (s) => (s.name === "gh" ? tr : fakeTracker({}).tr), "/aw");
  expect(calls).toEqual(["claim gh-12", "claim gh-12"]);
  expect(cmds).toContain(`git -C ${root}/src-web worktree add ${root}/acme/web/gh-12 -b agent/gh-12 origin/main`);
  expect(cmds).toContain(`git -C ${root}/src-api worktree add ${root}/acme/api/gh-12 -b agent/gh-12 origin/main`);
  expect(cmds.filter((x) => x.includes("new-window")).map((x) => x.split(" ")[6])).toEqual(["acme/web/gh-12", "acme/api/gh-12"]);
  expect(readFileSync(join(root, "acme/api/gh-12.prompt.md"), "utf8")).toContain("acme/api");
  expect(readFileSync(join(root, "acme/web/gh-12.prompt.md"), "utf8")).toContain("acme/web");
});

test("concurrency: per-repo limit and global limit both apply", async () => {
  const c = two({ maxConcurrent: 1 });
  const { tr, calls } = fakeTracker({ ready: [ticket(1, "acme/api"), ticket(2, "acme/api"), ticket(3), ticket(4), ticket(5)] });
  const { io } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/gh-9", "other"]) : noPr(a)));
  await pass(c, io, (s) => (s.name === "gh" ? tr : fakeTracker({}).tr), "/aw");
  expect(calls).toEqual(["claim gh-1", "claim gh-3", "claim gh-4"]);
  const busy = fakeTracker({ ready: [ticket(6, "acme/web")] });
  const r = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/api/gh-1"]) : noPr(a)));
  await pass(c, r.io, (s) => (s.name === "gh" ? busy.tr : fakeTracker({}).tr), "/aw");
  expect(busy.calls).toEqual(["claim gh-6"]);
});

test("priority: Linear field and GitHub priority:* labels map to one rank", () => {
  expect(LINEAR_ISSUES).toContain(" priority ");
  expect([0, 1, 2, 3, 4, undefined, null, 9].map((priority) => linearTicket({ identifier: "ENG-1", priority }).priority)).toEqual([undefined, 1, 2, 3, 4, undefined, undefined, undefined]);
  expect(labelPriority(["bug", "Priority:HIGH"])).toBe(2);
  expect(labelPriority(["priority:low", "priority:urgent"])).toBe(1);
  expect(labelPriority(["priority:medium"])).toBe(3);
  for (const l of [[], ["priority:p0"], ["p1"], ["prio:high"], ["priority: high"], ["priority:highest"]]) expect(labelPriority(l)).toBeUndefined();
});

test("priority: sort is stable with no priority last", () => {
  const t = (n: number, priority?: number) => ({ ...ticket(n), priority });
  expect([t(1), t(2, 4), t(3, 1), t(4), t(5, 4), t(6, 1)].sort(byPriority).map((x) => x.id)).toEqual(["gh-3", "gh-6", "gh-2", "gh-5", "gh-1", "gh-4"]);
});

test("priority: ready tickets from all sources start most urgent first, before the maxConcurrent cut", async () => {
  const c = two();
  c.maxConcurrent = 2;
  const gh = fakeTracker({ ready: [ticket(1), { ...ticket(2), priority: 3 }] });
  const lin = fakeTracker({ ready: [{ ...ticket(3), id: "ENG-3", repo: "acme/api", priority: 1 }, { ...ticket(4), id: "ENG-4", repo: "acme/api" }] });
  const { io, cmds } = fakeIo(noPr);
  await pass(c, io, (s) => (s.name === "gh" ? gh.tr : lin.tr), "/aw");
  expect(cmds.filter((x) => x.includes("new-window")).map((x) => x.split(" ")[6])).toEqual(["acme/api/ENG-3", "acme/web/gh-2"]);
  expect([...gh.calls, ...lin.calls]).toEqual(["claim gh-2", "claim ENG-3"]);
});

test("after a restart cleanup and findPr use the repo and source recorded next to the worktree", async () => {
  const c = two();
  for (const [dir, id, source] of [["acme/web", "gh-5", "gh"], ["acme/api", "gh-5", "gh"], ["acme/api", "ENG-7", "lin"], ["acme/web", "gh-6", "gone"]]) {
    mkdirSync(join(root, dir!, id!), { recursive: true });
    writeFileSync(join(root, dir!, `${id}.source`), source!);
  }
  const gh = fakeTracker({ done: ["acme/api#gh-5"], inProgress: [ticket(5, "acme/api")] });
  const lin = fakeTracker({ inProgress: [{ ...ticket(7), id: "ENG-7", repo: "acme/web" }] });
  const { io, cmds, logs } = fakeIo((a) => {
    if (a[1] === "list-windows") return windowsOut(["acme/web/gh-5", "acme/api/gh-5", "acme/api/ENG-7"]);
    if (a[4] === "remove") rmSync(a[5]!, { recursive: true });
    return noPr(a);
  });
  await pass(c, io, (s) => (s.name === "gh" ? gh.tr : lin.tr), "/aw");
  expect(cmds.filter((x) => /worktree remove|kill-window/.test(x))).toEqual(["tmux kill-window -t @1", `git -C ${root}/src-api worktree remove ${root}/acme/api/gh-5`]);
  expect(existsSync(join(root, "acme/web/gh-5.source"))).toBe(true);
  expect(logs.some((l) => l.includes(`acme/web/gh-6: source "gone" in gh-6.source is not configured; left alone`))).toBe(true);
  expect(cmds).toContain("gh pr list --repo acme/api --head agent/gh-5 --state all --json url,state");
  expect(cmds).toContain("gh pr list --repo acme/api --head agent/ENG-7 --state all --json url,state");
  expect(cmds.some((x) => x.includes("--repo acme/web --head agent/ENG-7"))).toBe(false);
  expect(lin.calls).toEqual([]);
  expect(gh.calls).toEqual(["comment gh-5 session ended without a PR"]);
});

test("redirected or unresolvable repos are skipped before listing, cloning or starting", async () => {
  const c = config({ repos: ["acme/web", { name: "acme/api", path: join(root, "src-api") }, { name: "acme/docs", path: join(root, "src-docs") }], sources: [src({ name: "gh" }), src({ name: "lin", tracker: "linear", team: "ENG" })] });
  const eng = (n: number, repo: string): Ticket => ({ ...ticket(n), id: `ENG-${n}`, repo });
  const st = { ready: [eng(1, "acme/api"), eng(2, "acme/docs"), eng(3, "acme/web")] };
  const lin = fakeTracker(st);
  const { io, cmds, logs } = fakeIo((a) => {
    if (a[2] === "view" && a[3] === "acme/api") return { out: '{"nameWithOwner":"evil/api"}' };
    if (a[2] === "view" && a[3] === "acme/docs") return { code: 1 };
    if (a[2] === "list") return { out: "[]" };
    return noPr(a);
  });
  const factory = (s: any, h: string, i: Io, d: boolean, repos: string[]) => (s.name === "gh" ? github(s, h, i, d, repos) : lin.tr);
  await pass(c, io, factory, "/aw");
  st.ready = st.ready.slice(0, 2);
  await pass(c, io, factory, "/aw");
  expect(lin.calls).toEqual(["comment ENG-1 aw: repo acme/api now resolves to evil/api on GitHub, which is not in the aw allowlist", "claim ENG-3"]);
  expect(cmds.filter((x) => x.startsWith("gh issue list")).map((x) => x.split(" ")[4])).toEqual(Array(6).fill("acme/web"));
  expect(cmds.filter((x) => x === "gh repo view acme/api --json nameWithOwner")).toHaveLength(3);
  expect(cmds.filter((x) => x === "gh repo view acme/docs --json nameWithOwner").length).toBeGreaterThan(1);
  expect(cmds.some((x) => /clone acme\/(api|docs)|src-(api|docs)/.test(x))).toBe(false);
  expect(logs.some((l) => l.includes('repo acme/api: GitHub resolves it to "evil/api", skipped'))).toBe(true);
  expect(logs.some((l) => l.includes("repo acme/docs: lookup failed, skipped"))).toBe(true);
});

test("a Linear ticket requeued with another repo does not start a second session", async () => {
  const c = two();
  worktree("ENG-1", "lin", "acme/web");
  const lin = fakeTracker({ ready: [{ ...ticket(1), id: "ENG-1", repo: "acme/api" }, { ...ticket(2), id: "ENG-2", repo: "acme/api" }] });
  const { io, cmds, logs } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/ENG-2"]) : noPr(a)));
  await pass(c, io, (s) => (s.name === "lin" ? lin.tr : fakeTracker({}).tr), "/aw");
  expect(lin.calls).toEqual([]);
  expect(cmds.some((x) => /new-window|worktree add/.test(x))).toBe(false);
  expect(logs.filter((l) => l.includes("already started in acme/web"))).toHaveLength(2);
});

test("only the source recorded in <ID>.source reconciles a worktree; a missing owner is logged once", async () => {
  const c = config({ sources: [src({ name: "gh" }), src({ name: "gh2", readyLabel: "agent2" })] });
  worktree("gh-1", "gh2");
  worktree("gh-2", "gone");
  const t = [ticket(1), ticket(2)];
  const gh = fakeTracker({ inProgress: t, inReview: t });
  const gh2 = fakeTracker({ inProgress: t, inReview: t });
  const { io, logs } = fakeIo((a) => (a[1] === "pr" ? { out: '[{"url":"https://pr/1","state":"OPEN"}]' } : undefined));
  await pass(c, io, (s) => (s.name === "gh" ? gh.tr : gh2.tr), "/aw");
  await pass(c, io, (s) => (s.name === "gh" ? gh.tr : gh2.tr), "/aw");
  expect(gh.calls).toEqual([]);
  expect(gh2.calls).toEqual(["review gh-1 https://pr/1", "review gh-1 https://pr/1"]);
  expect(logs.filter((l) => l.includes('source "gone"'))).toHaveLength(1);
  expect(existsSync(join(root, "acme/web/gh-2"))).toBe(true);
});

test("repo names map to distinct dirs; dot components and a .git suffix are rejected", async () => {
  for (const bad of ["acme/.", "acme/..", "./x", "../x", ".x/y", "acme/web.git", "acme/Web.GIT"]) expect(validRepo(bad)).toBe(false);
  for (const ok of ["a__b/c", "a/b__c", "acme/.github", "acme/web.js"]) expect(validRepo(ok)).toBe(true);
  const c = config({ repos: [{ name: "a__b/c", path: join(root, "s1") }, { name: "a/b__c", path: join(root, "s2") }] });
  const { tr, calls } = fakeTracker({ ready: [ticket(1, "a__b/c"), ticket(1, "a/b__c")] });
  const { io, cmds } = fakeIo(noPr);
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["claim gh-1", "claim gh-1"]);
  expect(cmds).toContain(`tmux new-window -d -t =aw: -n a__b/c/gh-1 ${root}/a__b/c/gh-1.sh`);
  expect(cmds).toContain(`tmux new-window -d -t =aw: -n a/b__c/gh-1 ${root}/a/b__c/gh-1.sh`);
  expect(readFileSync(join(root, "a/b__c/gh-1.prompt.md"), "utf8")).toContain("a/b__c");
});

test("clone: a leftover non-git dir or a failed clone fails the start before claiming, deleting nothing", async () => {
  const c = config({ reposRoot: join(root, "clones"), repos: ["acme/web"] });
  mkdirSync(join(root, "clones/acme/web"), { recursive: true });
  writeFileSync(join(root, "clones/acme/web/partial"), "");
  const { tr, calls } = fakeTracker({ ready: [ticket(1)] });
  const { io, cmds, logs } = fakeIo((a) => (a[5] === "--git-common-dir" ? { code: 128 } : noPr(a)));
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual([]);
  expect(logs.some((l) => l.includes(`start gh-1 failed: ${root}/clones/acme/web is not the top of its own git clone`))).toBe(true);
  expect(existsSync(join(root, "clones/acme/web/partial"))).toBe(true);
  expect(existsSync(join(root, "acme/web/gh-1.source"))).toBe(false);
  expect(cmds.some((x) => /repo clone|worktree add/.test(x))).toBe(false);
  const c2 = config({ reposRoot: join(root, "c2"), repos: ["acme/web"] });
  const f = fakeTracker({ ready: [ticket(1)] });
  const r2 = fakeIo((a) => (a[2] === "clone" ? { code: 1 } : noPr(a)));
  await pass(c2, r2.io, () => f.tr, "/aw");
  expect(f.calls).toEqual([]);
  expect(existsSync(join(root, "c2/acme/web"))).toBe(false);
});

test("a repo transferred while its name is cached is caught by a fresh lookup before clone or start", async () => {
  const c = config({ reposRoot: join(root, "clones"), repos: ["acme/web"] });
  canonCache.set("acme/web", { name: "acme/web", at: Date.now() });
  const { tr, calls } = fakeTracker({ ready: [ticket(1)] });
  const { io, cmds, logs } = fakeIo((a) => (a[2] === "view" ? { out: '{"nameWithOwner":"evil/web"}' } : noPr(a)));
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual([]);
  expect(cmds.some((x) => /repo clone|worktree add|new-window/.test(x))).toBe(false);
  expect(logs.some((l) => l.includes('repo acme/web: GitHub resolves it to "evil/web", skipped'))).toBe(true);
});

test("a ready ticket never takes over a worktree recorded for another source", async () => {
  const c = config({ sources: [src({ name: "gh" }), src({ name: "gh2", readyLabel: "agent2" })] });
  worktree("gh-1", "gh2");
  worktree("gh-2", "gone");
  const { tr, calls } = fakeTracker({ ready: [ticket(1), ticket(2)] });
  const { io, cmds, logs } = fakeIo(noPr);
  await pass(c, io, (s) => (s.name === "gh" ? tr : fakeTracker({}).tr), "/aw");
  expect(calls).toEqual([]);
  expect(cmds.some((x) => /new-window/.test(x))).toBe(false);
  expect(readFileSync(join(root, "acme/web/gh-1.source"), "utf8")).toBe("gh2");
  expect(logs.some((l) => l.includes('skip gh-1: acme/web/gh-1 belongs to source "gh2"'))).toBe(true);
});

test("a Linear ticket started in a repo since removed from aw.json is not started or reconciled elsewhere", async () => {
  const c = two();
  worktree("ENG-1", "lin", "acme/old");
  const eng1 = { ...ticket(1), id: "ENG-1", repo: "acme/api" };
  const lin = fakeTracker({ ready: [eng1], inProgress: [eng1] });
  const { io, cmds, logs } = fakeIo(noPr);
  await pass(c, io, (s) => (s.name === "lin" ? lin.tr : fakeTracker({}).tr), "/aw");
  expect(lin.calls).toEqual([]);
  expect(cmds.some((x) => /new-window|worktree add|agent\/ENG-1/.test(x))).toBe(false);
  expect(logs.some((l) => l.includes("skip ENG-1: already started in acme/old"))).toBe(true);
});

test("rejection: one comment per Linear ticket across sources and starts; marked before posting, unmarked on failure", async () => {
  const c = config({ maxConcurrent: 4, repos: [{ name: "acme/web", path: join(root, "src-web") }], sources: [src({ name: "lin", tracker: "linear", team: "ENG" }), src({ name: "lin2", tracker: "linear", team: "ENG", readyLabel: "agent2" })] });
  const eng = (repo?: string): Ticket => ({ ...ticket(1), id: "ENG-1", repo });
  const marker = join(root, ".rejected/ENG-1");
  const comments: string[] = [];
  const run = async (repo: string | undefined, fail = false) => {
    const f = fakeTracker({ ready: [eng(repo)] });
    f.tr.comment = async (t, b) => {
      expect(existsSync(marker)).toBe(true);
      if (fail) throw new Error("linear down");
      comments.push(`${t.id} ${b}`);
    };
    await pass(c, fakeIo(noPr).io, () => f.tr, "/aw");
    return f.calls;
  };
  await run("evil/x", true);
  expect(existsSync(marker)).toBe(false);
  await run("evil/x");
  expect(comments).toEqual(["ENG-1 aw: repo evil/x is not in the aw allowlist"]);
  expect(await run("acme/web")).toEqual(["claim ENG-1"]);
  rmSync(join(root, "acme/web/ENG-1"), { recursive: true });
  rmSync(join(root, "acme/web/ENG-1.source"));
  await run(undefined);
  expect(comments).toHaveLength(1);
});

test("clone path: a subdirectory or alias of another repo's clone is refused at start", async () => {
  const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { stdout: "pipe" });
  expect(git("init", "-q", join(root, "clone")).exitCode).toBe(0);
  mkdirSync(join(root, "clone/sub"));
  symlinkSync(join(root, "clone"), join(root, "alias"));
  const run = async (path: string) => {
    const c = config({ repos: [{ name: "acme/web", path: join(root, "clone") }, { name: "acme/api", path }] });
    const { tr, calls } = fakeTracker({ ready: [ticket(1, "acme/api")] });
    const { io, logs } = fakeIo((a) => (a[5] === "--git-common-dir" ? { out: git(...a.slice(1)).stdout.toString() } : noPr(a)));
    await pass(c, io, () => tr, "/aw");
    expect(calls).toEqual([]);
    return logs.find((l) => l.includes("start gh-1 failed"));
  };
  expect(await run(join(root, "clone/sub"))).toContain("is not the top of its own git clone");
  expect(await run(join(root, "alias"))).toContain("is the same clone as acme/web's path");
});

test("config: repo overrides of the wrong type are rejected, not replaced by defaults", () => {
  for (const [k, v] of [["path", 42], ["path", ""], ["path", null], ["baseBranch", 42], ["prompt", ""], ["prompt", 7]] as const)
    expect(() => config({ repos: [{ name: "acme/web", [k]: v }] })).toThrow(`repos[0] (acme/web).${k}: non-empty string`);
  expect(() => config({ defaults: { agent: "claude", sandbox: "nono", testCmd: "t", baseBranch: 1 } })).toThrow(".baseBranch: non-empty string");
});

test("linear repo: project label and label groups", () => {
  expect(linearRepo([], [undefined, "repo: acme/api"], ["repo:acme/web"])).toBe("acme/web");
  expect(linearRepo([], ["repo: acme/api"], ["repo:acme/web"])).toBe("acme/api");
  expect(linearRepo(["repo:acme/api"], [], ["repo:acme/web"])).toBe("acme/api");
  expect(linearRepo([], [], ["bug"])).toBeUndefined();
  const node = (labels: object[], projectLabels: object[]) => ({ id: "u", identifier: "PER-1", title: "t", description: null, url: "u", labels: { nodes: labels }, project: { description: "", content: null, labels: { nodes: projectLabels } } });
  const t = linearTicket(node([{ name: "agent", parent: null }], [{ name: "acme/web", parent: { name: "repo" } }]));
  expect(t.repo).toBe("acme/web");
  expect(t.labels).toEqual(["agent"]);
  expect(linearTicket(node([{ name: "acme/api", parent: { name: "repo" } }], [{ name: "acme/web", parent: { name: "repo" } }])).repo).toBe("acme/api");
  expect(linearTicket(node([], [{ name: "acme/web", parent: { name: "other" } }])).repo).toBeUndefined();
  expect(LINEAR_ISSUES).toContain("project { description content labels { nodes { name parent { name } } } }");
});
