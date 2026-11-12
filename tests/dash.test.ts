import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { action, attachCmd, exclusive, fit, installed, layout, lines, openable, reduce, reselect, scroll, type View, watch } from "../src/dash";
import type { Row } from "../src/status";

const row = (over: Partial<Row> = {}): Row => ({
  id: "PER-1",
  repo: "acme/web",
  agent: "claude",
  session: "running",
  state: "working",
  stateSince: null,
  waitingFor: null,
  runtimeMs: 3_600_000,
  idleMs: 5_000,
  phases: { done: 1, total: 3 },
  pr: "https://github.com/acme/web/pull/4",
  merge: null,
  transcript: null,
  window: "@1",
  ...over,
});
const v = (over: Partial<View> = {}): View => ({ sel: 0, focus: false, help: false, ...over });

test("keys map to actions; unknown, ctrl and meta combos do nothing", () => {
  const k = (name: string, o = {}) => action({ name, ...o });
  expect([k("j"), k("down"), k("k"), k("up"), k("g"), k("g", { shift: true }), k("return"), k("a"), k("o"), k("r"), k("?"), k("q"), k("c", { ctrl: true })]).toEqual([
    "down", "down", "up", "up", "first", "last", "focus", "attach", "open", "refresh", "help", "quit", "quit",
  ]);
  expect([k("x"), k("toString"), k("__proto__"), k("j", { ctrl: true }), k("q", { meta: true })]).toEqual([undefined, undefined, undefined, undefined, undefined]);
});

test("reduce clamps selection, toggles focus and help, and leaves selection alone while focused", () => {
  expect(reduce(v(), "up", 3).sel).toBe(0);
  expect(reduce(v({ sel: 2 }), "down", 3).sel).toBe(2);
  expect(reduce(v(), "last", 3).sel).toBe(2);
  expect(reduce(v({ sel: 2 }), "first", 3).sel).toBe(0);
  expect(reduce(v(), "down", 0).sel).toBe(0);
  expect(reduce(v(), "focus", 3)).toEqual(v({ focus: true }));
  expect(reduce(v({ help: true }), "help", 3).help).toBe(false);
  expect(reduce(v({ focus: true, sel: 1 }), "down", 3).sel).toBe(1);
  expect(reduce(v(), "quit", 3)).toEqual(v());
});

test("reselect follows the ticket across refreshes, else clamps", () => {
  const rs = [row({ id: "A" }), row({ id: "B" }), row({ id: "C" })];
  expect(reselect("acme/web/C", rs, 0)).toBe(2);
  expect(reselect("acme/web/Z", rs, 7)).toBe(2);
  expect(reselect(undefined, [], 3)).toBe(0);
});

test("fit truncates and pads by display width, wide chars included", () => {
  expect(fit("abc", 5)).toBe("abc  ");
  expect(fit("abcdef", 4)).toBe("abc…");
  expect(fit("漢字テスト", 5)).toBe("漢字…");
  expect(fit("漢字テスト", 6)).toBe("漢字… ");
  expect(Bun.stringWidth(fit("漢字テスト", 5))).toBe(5);
  expect(fit("x", 0)).toBe("");
});

test("table lines are exactly the width, stripped of controls, with the selected row marked", () => {
  const hostile = row({ id: "PER-2", repo: "\x1b]52;c;ZXZpbA==\x07acme/web‮", state: "waiting", waitingFor: "permission " + "漢".repeat(50), pr: null, merge: "held" });
  for (const width of [120, 60, 40, 10]) {
    const ls = lines([row(), hostile], width, 1);
    expect(ls).toHaveLength(3);
    for (const l of ls) {
      expect(Bun.stringWidth(l)).toBe(width);
      expect(l).not.toMatch(/[\x00-\x1f\x7f-\x9f‪-‮]/);
    }
  }
  const [head, a, b] = lines([row(), hostile], 120, 1);
  expect(head).toMatch(/^ {2}ID\s+REPO\s+AGENT\s+STATE\s+IDLE\s+RUNTIME\s+PHASES\s+PR\s*$/);
  expect(a).toMatch(/^ {2}PER-1\s+acme\/web\s+claude\s+working\s+5s\s+1h00m\s+1\/3\s+#4\s*$/);
  expect(b).toMatch(/^> PER-2 .*waiting: permission 漢.*held\s*$/);
});

test("layout and scroll fit small terminals", () => {
  expect(layout(10, 5, false)).toEqual({ table: 4, tail: 4 });
  expect(layout(30, 3, false)).toEqual({ table: 4, tail: 24 });
  expect(layout(10, 5, true)).toEqual({ table: 0, tail: 8 });
  for (const h of [0, 1, 2, 3]) {
    const l = layout(h, 5, false);
    expect(l.table + l.tail).toBe(Math.max(0, h - 2));
    expect(Math.min(l.table, l.tail)).toBeGreaterThanOrEqual(0);
  }
  expect(scroll(0, 5, 3)).toBe(0);
  expect(scroll(4, 5, 3)).toBe(2);
  expect(scroll(2, 10, 3)).toBe(1);
});

test("attach targets the window id, switches inside tmux and suspends outside", () => {
  expect(attachCmd("aw", "@3", false)).toEqual({ argv: ["tmux", "select-window", "-t", "@3", ";", "attach-session", "-t", "=aw"], suspend: true });
  expect(attachCmd("aw", "@3", true)).toEqual({ argv: ["tmux", "select-window", "-t", "@3", ";", "switch-client", "-t", "=aw"], suspend: false });
  for (const w of [null, "", "acme/web/PER-1", "@3; kill-server", "@3\n", "=aw:@3"]) expect(attachCmd("aw", w, false)).toBeUndefined();
});

test("only GitHub PR links are opened", () => {
  expect(openable("https://github.com/acme/web/pull/4")).toBe(true);
  for (const u of [null, "", "http://github.com/acme/web/pull/4", "https://github.com.evil/acme/web/pull/4", "https://github.com/acme/web/pull/4?x", "--help", "file:///etc/passwd", "https://github.com/acme/web/pull/4\n"]) expect(openable(u)).toBe(false);
});

test("exclusive skips overlapping runs and recovers after errors", async () => {
  let n = 0;
  let release = () => {};
  const run = exclusive(() => (n++, new Promise<void>((r) => (release = r))));
  const first = run();
  expect(await run()).toBe(false);
  release();
  expect(await first).toBe(true);
  const failing = exclusive(async () => {
    throw new Error("x");
  });
  await expect(failing()).rejects.toThrow("x");
  await expect(failing()).rejects.toThrow("x");
  expect(n).toBe(1);
});

test("watch picks the dashboard only on a TTY without --plain, and falls back when it fails", async () => {
  const calls: string[] = [];
  const o = (plain: boolean, tty: boolean, fail = false) => ({
    plain,
    tty,
    dash: async () => {
      calls.push("dash");
      if (fail) throw new Error("no native lib\x1b[2J");
    },
    fallback: async () => void calls.push("plain"),
    warn: (m: string) => void calls.push(m),
  });
  await watch(o(false, true));
  await watch(o(true, true));
  await watch(o(false, false));
  await watch(o(false, true, true));
  expect(calls).toEqual(["dash", "plain", "plain", "dash", "aw: dashboard unavailable (no native lib), using plain output", "plain"]);
});

// One real run in a throwaway tmux server: j, then q, must exit 0 with the alt screen off and the tty back in cooked mode.
test.skipIf(!Bun.which("tmux"))("dashboard starts, moves and quits cleanly in a tmux pty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "awd-"));
  const repo = join(import.meta.dir, "..");
  const tmux = (...a: string[]) => Bun.spawnSync(["tmux", "-L", `awtest-${process.pid}`, ...a], { env: { ...process.env, TMUX: "" } });
  const out = () => {
    try {
      return readFileSync(join(dir, "out"), "utf8");
    } catch {
      return "";
    }
  };
  try {
    for (const id of ["PER-1", "PER-2"]) mkdirSync(join(dir, "ws/acme/web", id), { recursive: true });
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/claude"), "#!/bin/sh\necho []\n", { mode: 0o755 });
    writeFileSync(join(dir, "aw.json"), JSON.stringify({ host: "box", workspaceRoot: join(dir, "ws"), tmuxSession: "awtest-none", defaults: { agent: "claude", sandbox: "none", testCmd: "true", prompt: join(repo, "prompts/default.md") }, repos: ["acme/web"], sources: [{ name: "gh", tracker: "github" }] }));
    const cmd = `HOME=${dir} PATH=${dir}/bin:$PATH ${process.execPath} ${join(repo, "aw.ts")} watch --config ${dir}/aw.json; echo EXIT=$? > ${dir}/out; stty -a >> ${dir}/out; sleep 30`;
    expect(tmux("new-session", "-d", "-x", "80", "-y", "20", cmd).exitCode).toBe(0);
    const pane = () => tmux("capture-pane", "-p").stdout.toString();
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(50);
      return ok();
    };
    expect(await until(() => /refreshed \d/.test(pane()))).toBe(true);
    expect(pane()).toMatch(/> PER-1\s+acme\/web/);
    tmux("send-keys", "j");
    expect(await until(() => /> PER-2\s+acme\/web/.test(pane()))).toBe(true);
    expect(pane()).toMatch(/^ {2}PER-1\s+acme\/web/m);
    const restored = async (status: string) => {
      expect(await until(() => out().includes("icanon"))).toBe(true);
      expect(out()).toStartWith(status);
      expect(out()).toMatch(/[\s;]icanon[\s;]/);
      expect(out()).toMatch(/[\s;]echo[\s;]/);
      expect(tmux("display", "-p", "#{alternate_on}").stdout.toString().trim()).toBe("0");
    };
    tmux("send-keys", "q");
    await restored("EXIT=0");
    rmSync(join(dir, "out"));
    tmux("respawn-pane", "-k", cmd);
    expect(await until(() => /refreshed \d/.test(pane()))).toBe(true);
    const pid = Bun.spawnSync(["pgrep", "-f", `^${process.execPath} ${join(repo, "aw.ts")} watch --config ${dir}/`]).stdout.toString().trim();
    expect(pid).toMatch(/^\d+$/);
    process.kill(Number(pid), "SIGTERM");
    await restored("EXIT=143");

    // Attached: a stub tmux reports PER-1's window and its "attach" just sleeps; SIGTERM must not wait for it.
    writeFileSync(join(dir, "bin/tmux"), `#!/bin/sh\n[ "$1" = list-windows ] && { echo "@1 acme/web/PER-1"; exit 0; }\nexec sleep 31.7\n`, { mode: 0o755 });
    rmSync(join(dir, "out"));
    tmux("respawn-pane", "-k", `env -u TMUX ${cmd}`);
    expect(await until(() => /> PER-1 .*claude\s+unknown/.test(pane()))).toBe(true);
    const sleeping = () => Bun.spawnSync(["pgrep", "-f", "^sleep 31.7$"]).stdout.toString().trim();
    tmux("send-keys", "a");
    expect(await until(() => sleeping() !== "")).toBe(true);
    const attached = Bun.spawnSync(["pgrep", "-f", `^${process.execPath} ${join(repo, "aw.ts")} watch --config ${dir}/`]).stdout.toString().trim();
    const t0 = Date.now();
    process.kill(Number(attached), "SIGTERM");
    await restored("EXIT=143");
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(sleeping()).toBe("");
  } finally {
    const sock = tmux("display", "-p", "#{socket_path}").stdout.toString().trim();
    tmux("kill-server");
    if (sock) rmSync(sock, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("installed walks up to a hoisted node_modules without resolving the package", () => {
  const dir = mkdtempSync(join(tmpdir(), "awd-"));
  try {
    mkdirSync(join(dir, "a/node_modules/@opentui/core"), { recursive: true });
    mkdirSync(join(dir, "a/b/c"), { recursive: true });
    mkdirSync(join(dir, "x/node_modules/@opentui/core/package.json"), { recursive: true });
    writeFileSync(join(dir, "a/node_modules/@opentui/core/package.json"), "{}");
    expect(installed(join(dir, "a/b/c"))).toBe(true);
    expect(installed(join(dir, "x"))).toBe(false);
    expect(installed()).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
