import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, type Io, type Ticket, type Tracker, github, launcher, parseConfig, pass, render } from "./aw";

let root: string;
beforeEach(() => (root = mkdtempSync(join(tmpdir(), "aw-test-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

const lane = (over: object = {}) => ({ name: "web", tracker: "github", repo: "acme/web", repoPath: "/src/web", agent: "claude", sandbox: "nono", testCmd: "bun test", ...over });
const config = (over: object = {}): Config => parseConfig({ host: "box", workspaceRoot: root, lanes: [lane(over)] }, import.meta.dir);
const ticket = (n: number): Ticket => ({ id: `gh-${n}`, ref: String(n), title: `Fix thing ${n}`, body: "body; rm -rf ~ $(whoami)", url: `https://x/${n}` });

function fakeTracker(s: { ready?: Ticket[]; inProgress?: Ticket[]; done?: string[] }) {
  const calls: string[] = [];
  const tr: Tracker = {
    listReady: async () => s.ready ?? [],
    listInProgress: async () => s.inProgress ?? [],
    isDone: async (id) => (s.done ?? []).includes(id),
    claim: async (t) => void calls.push(`claim ${t.id}`),
    toReview: async (t, pr) => void calls.push(`review ${t.id} ${pr}`),
    comment: async (t, b) => void calls.push(`comment ${t.id} ${b}`),
  };
  return { tr, calls };
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

const windowsOut = (names: string[]) => ({ out: names.map((n, i) => `@${i} ${n}`).join("\n") });
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
  expect(s).toContain("export CLAUDE_CONFIG_DIR=\"$HOME/.claude-aw\"");
  expect(s).toContain("exec nono run --profile '/aw/nono/aw-claude.json' --allow '/ws/web/gh-1' --allow '/src/web/.git' -- claude --remote-control");
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
    { number: 2, title: "t", body: "", url: "u", labels: lbl("agent", "host:box") },
    { number: 3, title: "t", body: "", url: "u", labels: lbl("agent", "host:vm") },
  ];
  const { io, cmds } = fakeIo((a) => (a[2] === "list" ? { out: JSON.stringify(issues) } : undefined));
  expect((await github(l, "box", io, true).listReady()).map((t) => t.id)).toEqual(["gh-1", "gh-2"]);
  expect(cmds[0]).not.toContain("host:");
});

test("github adapter: in-progress list needs the agent label (defaultHost)", async () => {
  const l = config().lanes[0]!;
  const { io, cmds } = fakeIo((a) => (a[2] === "list" ? { out: "[]" } : undefined));
  await github(l, "box", io, true).listInProgress();
  expect(cmds[0]).toContain("--label agent --label in-progress");
});
