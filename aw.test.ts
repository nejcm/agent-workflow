import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, type Io, type Ticket, type Tracker, github, launcher, linear, parseConfig, parsePhases, pass, render } from "./aw";

let root: string;
beforeEach(() => (root = mkdtempSync(join(tmpdir(), "aw-test-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

const lane = (over: object = {}) => ({ name: "web", tracker: "github", repo: "acme/web", repoPath: "/src/web", agent: "claude", sandbox: "nono", testCmd: "bun test", ...over });
const config = (over: object = {}): Config => parseConfig({ host: "box", workspaceRoot: root, lanes: [lane(over)] }, import.meta.dir);
const ticket = (n: number): Ticket => ({ id: `gh-${n}`, ref: String(n), title: `Fix thing ${n}`, body: "body; rm -rf ~ $(whoami)", url: `https://x/${n}` });

function fakeTracker(s: { ready?: Ticket[]; inProgress?: Ticket[]; inReview?: Ticket[]; done?: string[] }) {
  const calls: string[] = [];
  const subs: { ref: string; title: string }[] = [];
  const tr: Tracker = {
    listReady: async () => s.ready ?? [],
    listInProgress: async () => s.inProgress ?? [],
    listInReview: async () => s.inReview ?? [],
    isDone: async (id) => (s.done ?? []).includes(id),
    claim: async (t) => void calls.push(`claim ${t.id}`),
    toReview: async (t, pr) => void calls.push(`review ${t.id} ${pr}`),
    comment: async (t, b) => void calls.push(`comment ${t.id} ${b}`),
    createPhase: async (t, title) => (calls.push(`create ${t.id} ${title}`), subs.push({ ref: `sub-${calls.length}`, title }), `sub-${calls.length}`),
    listPhases: async () => subs,
    setPhase: async (ref, st) => void calls.push(`set ${ref} ${st}`),
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
      const r = respond(argv) ?? {};
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

const writePhases = (id: string, phases: unknown) => {
  mkdirSync(join(root, "web", id, ".aw"), { recursive: true });
  writeFileSync(join(root, "web", id, ".aw/phases.json"), typeof phases === "string" ? phases : JSON.stringify(phases));
};
const phase = (key: string, status: unknown, over: object = {}) => ({ key, title: `Do ${key}`, body: "b", status, ...over });

const windowsOut =(names: string[]) => ({ out: names.map((n, i) => `@${i} ${n}`).join("\n") });
const noPr = (argv: string[]) => (argv[1] === "pr" ? { out: "[]" } : undefined);

test("config: defaults applied and errors listed", () => {
  const c = config();
  expect(c.pollIntervalMs).toBe(60000);
  expect(c.tmuxSession).toBe("aw");
  expect(c.lanes[0]).toMatchObject({ baseBranch: "main", maxConcurrent: 2, readyLabel: "agent", done: ["Done", "Canceled", "Duplicate"] });
  const err = (() => {
    try {
      parseConfig({ host: "a b", lanes: [{ name: "Bad Name", tracker: "jira", repo: "x", agent: "gpt" }] }, root);
    } catch (e) {
      return (e as Error).message;
    }
  })();
  for (const k of ["host:", ".name:", ".tracker:", ".repo:", ".repoPath:", ".agent:", ".sandbox:", ".testCmd:"]) expect(err).toContain(k);
  expect(() => parseConfig({ host: "h", lanes: [lane({ tracker: "linear" })] }, root)).toThrow(/team/);
  expect(() => parseConfig({ host: "h", defaultHost: "yes", lanes: [lane()] }, root)).toThrow(/defaultHost/);
});

test("example config validates", () => {
  const raw = JSON.parse(readFileSync(join(import.meta.dir, "aw.example.json"), "utf8"));
  expect(parseConfig(raw, import.meta.dir).lanes.length).toBeGreaterThan(0);
});

test("render is single-pass so ticket text cannot expand placeholders", () => {
  expect(render("{{title}} / {{body}} / {{nope}}", { title: "{{body}}", body: "b" })).toBe("{{body}} / b / {{nope}}");
});

test("launcher: claude under nono, ticket text never in shell", () => {
  const c = config();
  const s = launcher(c.lanes[0]!, { ...ticket(1), title: "x'; rm -rf / $(id) `id`" }, "/ws/web/gh-1", "/ws/web/gh-1.prompt.md", "/aw");
  expect(s).toContain("export CLAUDE_CONFIG_DIR=\"$HOME/.claude-aw\" CODEX_HOME=\"$HOME/.codex-aw\" CLAUDE_CODE_TMPDIR=\"$HOME/.claude-aw/tmp\"");
  expect(s).toContain("--no-rollback-prompt");
  expect(s).toContain("exec nono run --no-rollback-prompt --profile '/aw/nono/aw-claude.json' --allow '/ws/web/gh-1' --allow '/src/web/.git' -- claude --remote-control");
  expect(s).toContain(`--permission-mode bypassPermissions "$(cat '/ws/web/gh-1.prompt.md')"`);
  expect(s).not.toMatch(/\$\(id\)|`id`|'; rm/);
});

test("launcher: codex without sandbox keeps the daemon", () => {
  const c = config({ agent: "codex", sandbox: "none" });
  const s = launcher(c.lanes[0]!, ticket(2), "/ws/web/gh-2", "/ws/web/gh-2.prompt.md", "/aw");
  expect(s).toContain('export CODEX_HOME="$HOME/.codex-aw"');
  expect(s).toContain(`exec codex --sandbox danger-full-access --ask-for-approval never -C '/ws/web/gh-2' "$(cat '/ws/web/gh-2.prompt.md')"`);
  expect(launcher(config({ agent: "codex" }).lanes[0]!, ticket(2), "/w", "/p", "/aw")).toContain("-- codex --no-daemon ");
});

test("starts ready tickets up to maxConcurrent", async () => {
  const c = config({ maxConcurrent: 2 });
  const { tr, calls } = fakeTracker({ ready: [ticket(1), ticket(2), ticket(3)] });
  const { io, cmds } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["web/gh-9"]) : a[3] === "rev-parse" ? { code: 1 } : noPr(a)));
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["claim gh-1"]);
  expect(cmds).toContain(`git -C /src/web worktree add ${root}/web/gh-1 -b agent/gh-1 origin/main`);
  expect(cmds).toContain(`tmux new-window -d -t =aw: -n web/gh-1 ${root}/web/gh-1.sh`);
  const prompt = readFileSync(join(root, "web/gh-1.prompt.md"), "utf8");
  expect(prompt).toContain("body; rm -rf ~ $(whoami)");
  expect(prompt).toContain("git push -u origin agent/gh-1");
});

test("reuses existing worktree dir and existing branch", async () => {
  const c = config();
  mkdirSync(join(root, "web/gh-1"), { recursive: true });
  const { tr } = fakeTracker({ ready: [ticket(1), ticket(2)] });
  const { io, cmds, logs } = fakeIo(noPr);
  await pass(c, io, () => tr, "/aw");
  expect(logs.some((l) => l.includes(`reuse ${root}/web/gh-1`))).toBe(true);
  expect(cmds).toContain(`git -C /src/web worktree add ${root}/web/gh-2 agent/gh-2`);
});

test("in-progress: PR moves to review; missing window comments once", async () => {
  const c = config();
  const { tr, calls } = fakeTracker({ inProgress: [ticket(1), ticket(2), ticket(3)] });
  const { io } = fakeIo((a) => {
    if (a[1] === "list-windows") return windowsOut(["web/gh-3"]);
    if (a[1] === "pr") return { out: a.includes("agent/gh-1") ? '[{"url":"https://pr/1","state":"OPEN"}]' : "[]" };
  });
  await pass(c, io, () => tr, "/aw");
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["review gh-1 https://pr/1", "comment gh-2 session ended without a PR", "review gh-1 https://pr/1"]);
  expect(existsSync(join(root, "web/gh-2.ended"))).toBe(true);
});

test("done: kills window, removes worktree and files; keeps files when remove fails", async () => {
  const c = config();
  for (const id of ["gh-1", "gh-2", "gh-3"]) {
    mkdirSync(join(root, "web", id), { recursive: true });
    for (const ext of [".prompt.md", ".sh", ".ended"]) writeFileSync(join(root, "web", id + ext), "");
  }
  const { tr } = fakeTracker({ done: ["gh-1", "gh-2"] });
  const { io, cmds, logs } = fakeIo((a) => {
    if (a[1] === "list-windows") return windowsOut(["web/gh-1"]);
    if (a[3] === "worktree" && a[5]?.endsWith("gh-2")) return { code: 1 };
  });
  await pass(c, io, () => tr, "/aw");
  expect(cmds).toContain("tmux kill-window -t @0");
  expect(cmds.filter((x) => x.includes("kill-window"))).toHaveLength(1);
  expect(existsSync(join(root, "web/gh-1.sh"))).toBe(false);
  expect(existsSync(join(root, "web/gh-2.sh"))).toBe(true);
  expect(existsSync(join(root, "web/gh-3.sh"))).toBe(true);
  expect(logs.some((l) => l.includes("cleanup gh-2 failed"))).toBe(true);
});

test("one ticket or lane failing does not stop the rest", async () => {
  const c = parseConfig({ host: "box", workspaceRoot: root, lanes: [lane(), lane({ name: "api", repo: "acme/api" })] }, import.meta.dir);
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
  mkdirSync(join(root, "web/gh-5"), { recursive: true });
  const { tr } = fakeTracker({ ready: [ticket(1)], done: ["gh-5"] });
  const { io, cmds, logs } = fakeIo((a) => (a[1] === "has-session" ? { code: 1 } : noPr(a)), true);
  await pass(c, io, () => tr, "/aw");
  expect(cmds.every((x) => /has-session|list-windows|rev-parse|gh pr list/.test(x))).toBe(true);
  expect(logs.some((l) => l.includes("dry: tmux new-session -d -s aw"))).toBe(true);
  expect(logs.some((l) => l.includes(`dry: git -C /src/web worktree remove ${root}/web/gh-5`))).toBe(true);
  expect(logs.some((l) => l.includes("dry: tmux new-window"))).toBe(true);
  expect(existsSync(join(root, "web/gh-1.prompt.md"))).toBe(false);
});

test("github adapter: ready requires host label, skips claimed, edits labels", async () => {
  const l = config().lanes[0]!;
  const issues = [
    { number: 7, title: "t", body: null, url: "u", labels: [{ name: "agent" }] },
    { number: 8, title: "t", body: "", url: "u", labels: [{ name: "agent" }, { name: "in-progress" }] },
    { number: 9, title: "t", body: "", url: "u", labels: [{ name: "agent" }, { name: "in-review" }] },
  ];
  const { io, cmds } = fakeIo((a) => (a[2] === "list" ? { out: JSON.stringify(issues) } : a[2] === "view" ? { out: '{"state":"CLOSED"}' } : undefined));
  const tr = github(l, "box", io);
  expect((await tr.listReady()).map((t) => t.id)).toEqual(["gh-7"]);
  expect(cmds[0]).toContain("--label agent --label host:box");
  await tr.claim((await tr.listReady())[0]!);
  expect(cmds).toContain("gh issue edit 7 --repo acme/web --add-label in-progress");
  expect(cmds).toContain("gh issue comment 7 --repo acme/web --body picked up on box");
  expect(await tr.isDone("gh-7")).toBe(true);
  await expect(tr.isDone("ENG-1")).rejects.toThrow();
});

test("github adapter: defaultHost takes unlabelled tickets, not other hosts'", async () => {
  const l = config().lanes[0]!;
  const lbl = (...n: string[]) => n.map((name) => ({ name }));
  const issues = [
    { number: 1, title: "t", body: "", url: "u", labels: lbl("agent") },
    { number: 2, title: "t", body: "", url: "u", labels: lbl("agent", "host:BOX") },
    { number: 3, title: "t", body: "", url: "u", labels: lbl("agent", "host:vm") },
  ];
  const { io, cmds } = fakeIo((a) => (a[2] === "list" ? { out: JSON.stringify(issues) } : undefined));
  expect((await github(l, "box", io, true).listReady()).map((t) => t.id)).toEqual(["gh-1", "gh-2"]);
  expect(cmds[0]).not.toContain("host:");
  expect(cmds[0]).toContain('--search -label:"in-progress" -label:"in-review"');
});

test("github adapter: in-progress list needs the agent label (defaultHost)", async () => {
  const l = config().lanes[0]!;
  const { io, cmds } = fakeIo((a) => (a[2] === "list" ? { out: "[]" } : undefined));
  await github(l, "box", io, true).listInProgress();
  expect(cmds[0]).toContain("--label agent --label in-progress");
});

test("linear adapter: defaultHost takes unlabelled tickets, not other hosts'", async () => {
  const l = config({ tracker: "linear", team: "ENG" }).lanes[0]!;
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
  expect(bodies[0].query).toContain("labels { nodes { name } }");
  expect(JSON.stringify(bodies[0].variables)).not.toContain("host:");
});

test("pass hands defaultHost to the tracker factory", async () => {
  const c = parseConfig({ host: "box", defaultHost: true, workspaceRoot: root, lanes: [lane()] }, import.meta.dir);
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
  const { io, logs } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["web/gh-1"]) : noPr(a)));
  writePhases("gh-1", [phase("a", "in-progress"), phase("b", "todo")]);
  await pass(c, io, () => tr, "/aw");
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["create gh-1 gh-1: Do a", "set sub-1 in-progress", "create gh-1 gh-1: Do b"]);
  calls.length = 0;
  writePhases("gh-1", [phase("a", "todo"), phase("b", "done"), phase("c", "todo")]);
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["set sub-3 in-progress", "create gh-1 gh-1: Do c"]);
  expect(logs.some((l) => l.includes("phase gh-1/a: ignoring in-progress -> todo"))).toBe(true);
  expect(JSON.parse(readFileSync(join(root, "web/gh-1.phases.json"), "utf8"))).toEqual({
    a: { ref: "sub-1", status: "in-progress" },
    b: { ref: "sub-3", status: "in-progress" },
    c: { ref: "sub-2", status: "todo" },
  });
  expect(existsSync(join(root, "web/gh-1.phases.json.tmp"))).toBe(false);
});

test("phases: done is held at in-progress until the PR exists, then closed before review", async () => {
  const c = config();
  const { tr, calls } = fakeTracker({ inProgress: [ticket(1)] });
  let prs = "[]";
  const { io } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["web/gh-1"]) : a[1] === "pr" ? { out: prs } : undefined));
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
  writeFileSync(join(root, "web/gh-1.phases.json"), JSON.stringify({ a: { ref: "sub-a", status: "in-progress" } }));
  await pass(c, io, () => tr, "/aw");
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["set sub-a done", "create gh-1 gh-1: Do b", "set sub-2 done"]);
});

test("phases: a sub-ticket created before a lost sidecar write is adopted, not duplicated", async () => {
  const c = config();
  const { tr, calls, subs } = fakeTracker({ inProgress: [ticket(1)] });
  subs.push({ ref: "sub-other", title: "gh-1: Something else" }, { ref: "sub-old", title: "gh-1: Do a" });
  const { io } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["web/gh-1"]) : noPr(a)));
  writePhases("gh-1", [phase("a", "in-progress"), phase("b", "todo")]);
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["set sub-old in-progress", "create gh-1 gh-1: Do b"]);
});

test("phases: bad or symlinked file is logged and the parent still moves to review", async () => {
  const c = config();
  const { tr, calls } = fakeTracker({ inProgress: [ticket(1), ticket(2), ticket(3)] });
  const { io, logs } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["web/gh-1", "web/gh-2", "web/gh-3"]) : a[1] === "pr" ? { out: '[{"url":"https://pr/1","state":"OPEN"}]' } : undefined));
  writePhases("gh-1", "x".repeat(70 * 1024));
  mkdirSync(join(root, "web/gh-2"), { recursive: true });
  mkdirSync(join(root, "outside"));
  writeFileSync(join(root, "outside/phases.json"), JSON.stringify([phase("a", "todo")]));
  symlinkSync(join(root, "outside"), join(root, "web/gh-2/.aw"));
  writePhases("gh-3", "[]");
  rmSync(join(root, "web/gh-3/.aw/phases.json"));
  symlinkSync(join(root, "outside/phases.json"), join(root, "web/gh-3/.aw/phases.json"));
  await pass(c, io, () => tr, "/aw");
  expect(logs.some((l) => l.includes("phases gh-1 failed: phases: must be a regular file"))).toBe(true);
  expect(logs.some((l) => l.includes("phases gh-2 failed: ENOTDIR"))).toBe(true);
  expect(logs.some((l) => l.includes("phases gh-3 failed: ELOOP"))).toBe(true);
  expect(calls).toEqual(["review gh-1 https://pr/1", "review gh-2 https://pr/1", "review gh-3 https://pr/1"]);
});

test("phases: start git-ignores .aw; cleanup removes the sidecar", async () => {
  const c = config();
  const { tr } = fakeTracker({ ready: [ticket(1)], done: ["gh-2"] });
  mkdirSync(join(root, "web/gh-2"), { recursive: true });
  writeFileSync(join(root, "web/gh-2.phases.json"), "{}");
  const { io } = fakeIo(noPr);
  await pass(c, io, () => tr, "/aw");
  expect(readFileSync(join(root, "web/gh-1/.aw/.gitignore"), "utf8")).toBe("*\n");
  expect(existsSync(join(root, "web/gh-2.phases.json"))).toBe(false);
});

test("phases: a FIFO phases file is rejected without blocking the poller", async () => {
  const c = config();
  const { tr } = fakeTracker({ inProgress: [ticket(1)] });
  const { io, logs } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["web/gh-1"]) : noPr(a)));
  mkdirSync(join(root, "web/gh-1/.aw"), { recursive: true });
  expect(Bun.spawnSync(["mkfifo", join(root, "web/gh-1/.aw/phases.json")]).exitCode).toBe(0);
  await pass(c, io, () => tr, "/aw");
  expect(logs.some((l) => l.includes("phases gh-1 failed: phases: must be a regular file"))).toBe(true);
});

test("start never writes .aw/.gitignore through an agent-planted symlink", async () => {
  const c = config();
  const { tr } = fakeTracker({ ready: [ticket(1), ticket(2)] });
  const { io, logs } = fakeIo(noPr);
  mkdirSync(join(root, "outside"));
  writeFileSync(join(root, "outside/victim"), "secret");
  mkdirSync(join(root, "web/gh-1/.aw"), { recursive: true });
  symlinkSync(join(root, "outside/victim"), join(root, "web/gh-1/.aw/.gitignore"));
  mkdirSync(join(root, "web/gh-2"), { recursive: true });
  symlinkSync(join(root, "outside"), join(root, "web/gh-2/.aw"));
  await pass(c, io, () => tr, "/aw");
  expect(readFileSync(join(root, "outside/victim"), "utf8")).toBe("secret");
  expect(readFileSync(join(root, "web/gh-1/.aw/.gitignore"), "utf8")).toBe("*\n");
  expect(existsSync(join(root, "outside/.gitignore"))).toBe(false);
  expect(logs.some((l) => l.includes("start gh-2 failed: ENOTDIR"))).toBe(true);
});

test("github adapter: phases become sub-issues that are never picked up as work", async () => {
  const c = parseConfig({ host: "box", defaultHost: true, workspaceRoot: root, lanes: [lane()] }, import.meta.dir);
  const issues: { number: number; title: string; body: string; url: string; labels: string[]; open: boolean; parent?: string }[] = [{ number: 1, title: "t", body: "", url: "u", labels: ["agent", "in-progress"], open: true }];
  let prs = "[]";
  const { io, cmds } = fakeIo((a) => {
    if (a[1] === "list-windows") return windowsOut(["web/gh-1"]);
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
  const tr = github(c.lanes[0]!, "box", io, true);
  expect((await tr.listInProgress()).map((t) => t.id)).toEqual(["gh-1"]);
  expect(await tr.listReady()).toEqual([]);
  prs = '[{"url":"https://pr/1","state":"OPEN"}]';
  const at = cmds.length;
  await pass(c, io, github, "/aw");
  expect(cmds.slice(at).filter((x) => /issue (create|edit|close)/.test(x))).toEqual(["gh issue close 3 --repo acme/web", "gh issue edit 1 --repo acme/web --add-label in-review --remove-label in-progress"]);
  expect((await tr.listInReview()).map((t) => t.id)).toEqual(["gh-1"]);
});

test("linear adapter: phases become child issues that are never picked up as work", async () => {
  const c = parseConfig({ host: "box", defaultHost: true, workspaceRoot: root, lanes: [lane({ tracker: "linear", team: "ENG" })] }, import.meta.dir);
  const states = [
    { id: "s-todo", name: "Todo" },
    { id: "s-prog", name: "In Progress" },
    { id: "s-done", name: "Done" },
  ].map((s) => ({ ...s, team: { id: "team-1" } }));
  const issues: any[] = [{ id: "u-1", identifier: "ENG-1", title: "t", description: "", url: "u", state: "In Progress", labels: ["agent"] }];
  const mutations: any[] = [];
  let prs = "[]";
  const { io } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["web/ENG-1"]) : a[1] === "pr" ? { out: prs } : undefined));
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
    const tr = linear(c.lanes[0]!, "box", io, true);
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
  const { io, cmds, logs } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["web/gh-1"]) : a[2] === "list" ? { out: JSON.stringify([{ number: 1, title: "t", body: "", url: "u", labels: [] }]) } : a[1] === "api" ? { out: "[]" } : noPr(a)), true);
  writePhases("gh-1", [phase("a", "done")]);
  await pass(c, io, github, "/aw");
  expect(cmds.filter((x) => /issue (create|edit|close)/.test(x))).toEqual([]);
  expect(logs.some((l) => l.includes("dry: gh issue create --repo acme/web --parent 1"))).toBe(true);
  expect(logs.some((l) => l.includes("dry: gh issue close  --repo acme/web"))).toBe(true);
  expect(existsSync(join(root, "web/gh-1.phases.json"))).toBe(false);
});
