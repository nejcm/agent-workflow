import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { action, attachCmd, exclusive, installed, openable, reduce, refreshed, reselect, type View, watch } from "../src/ui/dash";
import { statusRow as row } from "./helpers";
import { ticketTree, treeLayout } from "../src/ui/tree";

const v = (over: Partial<View> = {}): View => ({ sel: 0, pane: "list", max: false, help: false, back: 0, ...over });

test("keys map to actions; unknown, ctrl and meta combos do nothing", () => {
  const k = (name: string, o = {}) => action({ name, ...o });
  expect([k("j"), k("down"), k("k"), k("up"), k("g"), k("g", { shift: true }), k("return"), k("tab"), k("escape"), k("a"), k("o"), k("r"), k("?"), k("q"), k("c", { ctrl: true })]).toEqual([
    "down", "down", "up", "up", "first", "last", "focus", "tab", "back", "attach", "open", "refresh", "help", "quit", "quit",
  ]);
  expect([k("x"), k("toString"), k("__proto__"), k("j", { ctrl: true }), k("q", { meta: true })]).toEqual([undefined, undefined, undefined, undefined, undefined]);
  expect([k("t"), k("left"), k("right")]).toEqual(["tree", "left", "right"]);
});

test("tree mode selects cards, toggles detail, cycles tickets and restores the default view", () => {
  const tree = reduce(v({ pane: "tail", max: true }), "tree", 3);
  const cards = treeLayout(ticketTree(row()), 120).cards;
  expect(tree).toEqual(v({ tree: { sel: 0, detail: false } }));
  const moved = reduce(tree, "down", 3, 0, cards);
  expect(moved.tree?.sel).toBe(2);
  expect(reduce(moved, "left", 3, 0, cards).tree?.sel).toBe(1);
  expect(reduce(tree, "up", 3, 0, cards).tree?.sel).toBe(0);
  expect(reduce(moved, "last", 3, 0, cards).tree?.sel).toBe(3);
  expect(reduce({ ...tree, tree: { sel: 3, detail: false } }, "down", 3, 0, cards).tree?.sel).toBe(3);
  const detail = reduce(moved, "focus", 3);
  expect(detail.tree).toEqual({ sel: 2, detail: true });
  expect(reduce(detail, "focus", 3)).toEqual(moved);
  expect(reduce(detail, "back", 3)).toEqual(moved);
  expect(reduce({ ...detail, help: true }, "back", 3)).toEqual(detail);
  expect(reduce(detail, "tab", 3)).toEqual(v({ sel: 1, tree: { sel: 0, detail: false } }));
  expect(reduce({ ...tree, sel: 2 }, "tab", 3).sel).toBe(0);
  expect(reduce(tree, "tree", 3)).toEqual(v({ tree: undefined }));
});

test("reduce clamps selection, resets the scroll on a move, and toggles panes, maximise and help", () => {
  expect(reduce(v(), "up", 3).sel).toBe(0);
  expect(reduce(v({ sel: 2 }), "down", 3).sel).toBe(2);
  expect(reduce(v(), "last", 3).sel).toBe(2);
  expect(reduce(v({ sel: 2, back: 4 }), "first", 3)).toEqual(v({ sel: 0 }));
  expect(reduce(v(), "down", 0).sel).toBe(0);
  expect(reduce(v(), "focus", 3)).toEqual(v({ max: true, pane: "tail" }));
  expect(reduce(v({ max: true, pane: "tail" }), "focus", 3)).toEqual(v());
  expect(reduce(v(), "tab", 3)).toEqual(v({ pane: "tail" }));
  expect(reduce(v({ pane: "tail", max: true }), "tab", 3)).toEqual(v());
  expect(reduce(v({ help: true }), "help", 3).help).toBe(false);
  expect(reduce(v({ help: true, max: true }), "back", 3)).toEqual(v({ max: true }));
  expect(reduce(v({ max: true, pane: "tail" }), "back", 3)).toEqual(v());
  expect(reduce(v(), "quit", 3)).toEqual(v());
});

test("movement scrolls the transcript within its range while it has focus", () => {
  const t = v({ pane: "tail", sel: 1 });
  expect(reduce(t, "up", 3, 5)).toEqual({ ...t, back: 1 });
  expect(reduce({ ...t, back: 5 }, "up", 3, 5).back).toBe(5);
  expect(reduce(t, "down", 3, 5).back).toBe(0);
  expect(reduce(t, "first", 3, 5).back).toBe(5);
  expect(reduce({ ...t, back: 3 }, "last", 3, 5).back).toBe(0);
  expect(reduce(t, "up", 3, 0).back).toBe(0);
});

test("i opens the intake view, j/k move its rule, esc or i leave it", () => {
  expect(action({ name: "i" })).toBe("intake");
  const open = reduce(v({ tree: { sel: 1, detail: false } }), "intake", 3);
  expect(open).toEqual(v({ intake: { sel: 0 } }));
  expect(reduce(open, "down", 3, 0, [], 2).intake).toEqual({ sel: 1 });
  expect(reduce({ ...open, intake: { sel: 1 } }, "down", 3, 0, [], 2).intake).toEqual({ sel: 1 });
  expect(reduce(open, "last", 3, 0, [], 0).intake).toEqual({ sel: 0 });
  expect(reduce(open, "down", 3).sel).toBe(0);
  expect(reduce(open, "back", 3)).toEqual(v());
  expect(reduce({ ...open, help: true }, "back", 3)).toEqual(open);
  expect(reduce(open, "intake", 3)).toEqual(v());
  expect(reduce(open, "tree", 3).intake).toBeUndefined();
});

test("reselect follows the ticket across refreshes, else clamps", () => {
  const rs = [row({ id: "A" }), row({ id: "B" }), row({ id: "C" })];
  expect(reselect("acme/web/C", rs, 0)).toBe(2);
  expect(reselect("acme/web/Z", rs, 7)).toBe(2);
  expect(reselect(undefined, [], 3)).toBe(0);
});

test("refresh keeps the selected ticket's scroll and tree, and resets both when it changes", () => {
  const rs = [row({ id: "A" }), row({ id: "B" }), row({ id: "C" })];
  const gone = refreshed(v({ sel: 1, back: 3 }), rs, [rs[0]!, rs[2]!]);
  expect(gone.rs.map((r) => r.id)).toEqual(["A", "C"]);
  expect(gone.view).toEqual(v({ sel: 1, back: 0 }));
  expect(refreshed(v({ sel: 1, back: 3 }), rs, [row({ id: "0" }), ...rs]).view).toEqual(v({ sel: 2, back: 3 }));
  const fewer = row({ id: "B", phases: { done: 0, total: 1, items: [{ key: "a", title: "Do a", status: "todo" }] } });
  expect(refreshed(v({ sel: 1, tree: { sel: 3, detail: true } }), rs, [rs[0]!, fewer, rs[2]!]).view.tree).toEqual({ sel: 1, detail: true });
  expect(refreshed(v({ sel: 1, tree: { sel: 2, detail: true } }), rs, [rs[0]!, rs[2]!]).view.tree).toEqual({ sel: 0, detail: false });
});

test("attach targets the window id, switches inside tmux and suspends outside", () => {
  expect(attachCmd("tender", "@3", false)).toEqual({ argv: ["tmux", "select-window", "-t", "@3", ";", "attach-session", "-t", "=tender"], suspend: true });
  expect(attachCmd("tender", "@3", true)).toEqual({ argv: ["tmux", "select-window", "-t", "@3", ";", "switch-client", "-t", "=tender"], suspend: false });
  for (const w of [null, "", "acme/web/PER-1", "@3; kill-server", "@3\n", "=tender:@3"]) expect(attachCmd("tender", w, false)).toBeUndefined();
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
  expect(calls).toEqual(["dash", "plain", "plain", "dash", "tender: dashboard unavailable (no native lib), using plain output", "plain"]);
});

// A real tmux PTY exercises both views and restores the terminal on quit and SIGTERM.
test.skipIf(!Bun.which("tmux"))("dashboard starts, moves and quits cleanly in a tmux pty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tenderd-"));
  const repo = join(import.meta.dir, "..");
  const tmux = (...a: string[]) => Bun.spawnSync(["tmux", "-L", `tendertest-${process.pid}`, ...a], { env: { ...process.env, TMUX: "" } });
  const out = () => {
    try {
      return readFileSync(join(dir, "out"), "utf8");
    } catch {
      return "";
    }
  };
  try {
    for (const id of ["PER-1", "PER-2"]) {
      const run = join(dir, "ws/acme/web", id, ".tender/run");
      mkdirSync(run, { recursive: true });
      writeFileSync(join(run, "phases.json"), JSON.stringify([{ key: "verify", title: "Verify behavior", status: "in-progress" }, { key: "review", title: "Review result", status: "todo" }]));
    }
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "tender.json"), JSON.stringify({ host: "box", workspaceRoot: join(dir, "ws"), tmuxSession: "tendertest-none", defaults: { sandbox: "none" }, repos: ["acme/web"], sources: [{ name: "gh", tracker: "github" }] }));
    const cmd = `NO_COLOR= HOME=${dir} PATH=${dir}/bin:$PATH ${process.execPath} ${join(repo, "tender.ts")} watch --config ${dir}/tender.json; echo EXIT=$? > ${dir}/out; stty -a >> ${dir}/out; sleep 30`;
    expect(tmux("new-session", "-d", "-x", "80", "-y", "20", cmd).exitCode).toBe(0);
    const pane = () => tmux("capture-pane", "-p").stdout.toString();
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(50);
      return ok();
    };
    const ready = /\d\d:\d\d:\d\d · every/;
    expect(await until(() => ready.test(pane()))).toBe(true);
    expect(pane()).toMatch(/▌. PER-1\s+acme\/web/);
    tmux("send-keys", "j");
    expect(await until(() => /▌. PER-2\s+acme\/web/.test(pane()))).toBe(true);
    expect(pane()).toMatch(/│ . PER-1\s+acme\/web/);
    tmux("send-keys", "t");
    expect(await until(() => pane().includes("Tab ticket"))).toBe(true);
    expect(pane()).toContain("PER-2");
    expect(pane()).toContain("Verify behavior");
    tmux("send-keys", "Down", "Left", "Enter");
    expect(await until(() => pane().includes("phase · verify · Working"))).toBe(true);
    expect(pane()).toContain("[Enter Close]");
    tmux("send-keys", "Right");
    expect(await until(() => pane().includes("phase · review · Idle"))).toBe(true);
    tmux("send-keys", "Left");
    expect(await until(() => pane().includes("phase · verify · Working"))).toBe(true);
    tmux("send-keys", "Enter", "Tab");
    expect(await until(() => pane().includes("PER-1 · acme/web"))).toBe(true);
    expect(pane()).not.toContain("[Enter Close]");
    tmux("send-keys", "t");
    expect(await until(() => /▌. PER-1\s+acme\/web/.test(pane()))).toBe(true);
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
    expect(await until(() => ready.test(pane()))).toBe(true);
    const pid = Bun.spawnSync(["pgrep", "-f", `^${process.execPath} ${join(repo, "tender.ts")} watch --config ${dir}/`]).stdout.toString().trim();
    expect(pid).toMatch(/^\d+$/);
    process.kill(Number(pid), "SIGTERM");
    await restored("EXIT=143");

    // Attached: a stub tmux reports PER-1's window and its "attach" just sleeps; SIGTERM must not wait for it.
    writeFileSync(join(dir, "bin/tmux"), `#!/bin/sh\n[ "$1" = list-windows ] && { echo "@1 1700000000 acme/web/PER-1"; exit 0; }\nexec sleep 31.7\n`, { mode: 0o755 });
    rmSync(join(dir, "out"));
    tmux("respawn-pane", "-k", `env -u TMUX ${cmd}`);
    expect(await until(() => /PER-1 +acme\/web +claude +\? unknown/.test(pane()))).toBe(true);
    const sleeping = () => Bun.spawnSync(["pgrep", "-f", "^sleep 31.7$"]).stdout.toString().trim();
    tmux("send-keys", "a");
    expect(await until(() => sleeping() !== "")).toBe(true);
    const attached = Bun.spawnSync(["pgrep", "-f", `^${process.execPath} ${join(repo, "tender.ts")} watch --config ${dir}/`]).stdout.toString().trim();
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
  const dir = mkdtempSync(join(tmpdir(), "tenderd-"));
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
