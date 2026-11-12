import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { KeyEvent } from "@opentui/core";
import { repoDir } from "./config";
import { type Line, type Pane, palette, screen, sortRows } from "./dash-view";
import { PR_URL } from "./github";
import { type Row, snapshot } from "./status";
import { reader } from "./tail";
import { clean } from "./util";
import type { Config, Io } from "./types";

export type Action = "down" | "up" | "first" | "last" | "focus" | "tab" | "back" | "attach" | "open" | "refresh" | "help" | "quit";
export interface View {
  sel: number;
  pane: Pane;
  max: boolean;
  help: boolean;
  /** Transcript rows scrolled up from the end; 0 follows new events. */
  back: number;
}

const KEYS = new Map<string, Action>([
  ["j", "down"],
  ["down", "down"],
  ["k", "up"],
  ["up", "up"],
  ["return", "focus"],
  ["linefeed", "focus"],
  ["tab", "tab"],
  ["escape", "back"],
  ["a", "attach"],
  ["o", "open"],
  ["r", "refresh"],
  ["?", "help"],
  ["q", "quit"],
]);

export function action(k: { name: string; shift?: boolean; ctrl?: boolean; meta?: boolean }): Action | undefined {
  if (k.ctrl) return k.name === "c" ? "quit" : undefined;
  if (k.meta) return undefined;
  if (k.name === "g") return k.shift ? "last" : "first";
  return KEYS.get(k.name);
}

/** The view after `a` on `n` rows; movement scrolls the transcript (up to `maxBack`) while it has focus. */
export function reduce(v: View, a: Action, n: number, maxBack = Infinity): View {
  const last = Math.max(0, n - 1);
  const move = (i: number) => {
    const sel = Math.max(0, Math.min(last, i));
    return sel === v.sel ? v : { ...v, sel, back: 0 };
  };
  const scrollTo = (b: number) => ({ ...v, back: Math.max(0, Math.min(maxBack, b)) });
  const tail = v.pane === "tail";
  if (a === "down") return tail ? scrollTo(v.back - 1) : move(v.sel + 1);
  if (a === "up") return tail ? scrollTo(v.back + 1) : move(v.sel - 1);
  if (a === "first") return tail ? scrollTo(maxBack) : move(0);
  if (a === "last") return tail ? scrollTo(0) : move(last);
  if (a === "focus") return v.max ? { ...v, max: false, pane: "list" } : { ...v, max: true, pane: "tail" };
  if (a === "tab") return { ...v, max: false, pane: tail ? "list" : "tail" };
  if (a === "back") return v.help ? { ...v, help: false } : v.max ? { ...v, max: false, pane: "list" } : v;
  if (a === "help") return { ...v, help: !v.help };
  return v;
}

const key = (r: Row | undefined) => (r ? `${r.repo}/${r.id}` : undefined);

/** The index of the previously selected ticket in `next`, else the old index clamped. */
export function reselect(prev: string | undefined, next: Row[], sel: number) {
  const i = next.findIndex((r) => key(r) === prev);
  return i >= 0 ? i : Math.max(0, Math.min(next.length - 1, sel));
}

/** tmux argv to show window `win` of `session`: a client switch inside tmux, else an attach the dashboard suspends for. */
export function attachCmd(session: string, win: string | null, inTmux: boolean) {
  if (!win || !/^@\d+$/.test(win)) return undefined;
  const pick = ["tmux", "select-window", "-t", win, ";"];
  return inTmux ? { argv: [...pick, "switch-client", "-t", `=${session}`], suspend: false } : { argv: [...pick, "attach-session", "-t", `=${session}`], suspend: true };
}

export const openable = (url: string | null): url is string => !!url && PR_URL.test(url);

/** Wraps `fn` so a call while one is in flight is skipped (resolves false). */
export function exclusive(fn: () => Promise<void>) {
  let busy = false;
  return async () => {
    if (busy) return false;
    busy = true;
    try {
      await fn();
      return true;
    } finally {
      busy = false;
    }
  };
}

/** The dashboard on a TTY unless `plain`; falls back to `fallback` with one stderr line if it cannot start. */
export async function watch(o: { plain: boolean; tty: boolean; dash: () => Promise<void>; fallback: () => Promise<void>; warn?: (m: string) => void }) {
  if (!o.plain && o.tty)
    try {
      return await o.dash();
    } catch (e) {
      (o.warn ?? console.error)(`aw: dashboard unavailable (${clean(String((e as Error)?.message ?? e), 160)}), using plain output`);
    }
  return o.fallback();
}

const MAX_TAIL = 500;

const SIGNALS = new Map<NodeJS.Signals, number>([["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129], ["SIGQUIT", 131], ["SIGPIPE", 141]]);

// Bun auto-installs (downloads) a bare import when no node_modules exists, so check for the package first.
export function installed(from = import.meta.dir) {
  for (let d = resolve(from); ; d = dirname(d)) {
    try {
      if (statSync(join(d, "node_modules", "@opentui", "core", "package.json")).isFile()) return true;
    } catch {}
    if (dirname(d) === d) return false;
  }
}

/** Runs the OpenTUI dashboard until quit; resolves once it is on screen, rejects if OpenTUI cannot start. */
export async function dashboard(cfg: Config, io: Io, interval: number) {
  let exiting = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let msgTimer: ReturnType<typeof setTimeout> | undefined;
  let child: Bun.Subprocess | undefined;
  if (!installed()) throw new Error("@opentui/core is not installed (run bun install)");
  const { RGBA, StyledText, TextAttributes: A, TextRenderable, createCliRenderer } = await import("@opentui/core");
  const r = await createCliRenderer({ exitOnCtrlC: true, exitSignals: [], targetFps: 30, onDestroy: () => void exit(0) });

  async function exit(code: number, err?: unknown) {
    if (exiting) return;
    exiting = true;
    clearInterval(timer);
    clearTimeout(msgTimer);
    setTimeout(() => process.exit(code), 2000);
    // Let an attached tmux client restore its own terminal state before OpenTUI tears down.
    if (child) {
      child.kill();
      await Promise.race([child.exited, Bun.sleep(1000)]);
    }
    r.destroy();
    r.closed.finally(() => {
      if (err !== undefined) console.error(err);
      process.exit(code);
    });
  }
  // OpenTUI's own handlers only open its console overlay and leave the terminal in the alt screen.
  for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => void exit(1, e));
  for (const [sig, code] of SIGNALS) process.on(sig, () => void exit(code));

  let rs: Row[] = [];
  let view: View = { sel: 0, pane: "list", max: false, help: false, back: 0 };
  let maxBack = 0;
  let at = "--:--:--";
  let msg = "";
  let tail: { path: string | null; next?: () => string[]; lines: string[] } = { path: null, lines: [] };
  const P = palette();
  const home = homedir();
  const memo = new Map<string, Line[]>();

  r.root.flexDirection = "column";
  const pool: InstanceType<typeof TextRenderable>[] = [];
  const shown = new WeakMap<object, string>();
  const rgba = new Map<string, InstanceType<typeof RGBA>>();
  const color = (hex: string | undefined) => (hex === undefined ? undefined : rgba.get(hex) ?? rgba.set(hex, RGBA.fromHex(hex)).get(hex));
  const styled = (l: Line) =>
    new StyledText(
      l.map((x) => ({
        __isChunk: true as const,
        text: x.t,
        fg: color(x.fg),
        bg: color(x.bg),
        attributes: (x.b ? A.BOLD : 0) | (x.d ? A.DIM : 0) | (x.u ? A.UNDERLINE : 0) | (x.r ? A.INVERSE : 0),
      })),
    );

  function say(m: string) {
    msg = clean(m, 300);
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => ((msg = ""), paint()), 4000);
    paint();
  }

  function pump() {
    const p = rs[view.sel]?.transcript ?? null;
    if (p !== tail.path) tail = { path: p, next: p ? reader(p) : undefined, lines: [] };
    // events() already clean()s every field; cleaning again would collapse its column padding.
    const add = tail.next?.() ?? [];
    if (add.length) tail.lines = [...tail.lines, ...add].slice(-MAX_TAIL);
  }

  function paint() {
    if (exiting) return;
    pump();
    if (memo.size > 4 * MAX_TAIL) memo.clear();
    const { width, height } = r;
    const sel = rs[view.sel];
    const out = screen(
      { ...view, rs, host: cfg.host, at, every: interval, msg, events: tail.lines, empty: tail.path ? "no events yet" : "no transcript yet", ctx: { now: Date.now(), home, wt: sel ? join(repoDir(cfg, sel.repo), sel.id) : "" } },
      width,
      height,
      P,
      memo,
    );
    maxBack = out.maxBack;
    while (pool.length < out.lines.length) {
      const t = new TextRenderable(r, { id: `line-${pool.length}`, content: "", height: 1, flexShrink: 0, wrapMode: "none", fg: RGBA.defaultForeground() });
      pool.push(t);
      r.root.add(t);
    }
    // Lines are hidden, not removed: OpenTUI keeps removed renderables registered until destroyed.
    pool.forEach((t, i) => {
      const l = out.lines[i];
      if (t.visible !== !!l) t.visible = !!l;
      const k = l ? JSON.stringify(l) : "";
      if (l && shown.get(t) !== k) {
        shown.set(t, k);
        t.content = styled(l);
      }
    });
  }

  const refresh = exclusive(async () => {
    try {
      const next = await snapshot(cfg, io);
      const prev = key(rs[view.sel]);
      rs = sortRows(next);
      view = { ...view, sel: reselect(prev, rs, view.sel) };
      at = new Date().toTimeString().slice(0, 8);
    } catch (e) {
      say(`refresh failed: ${(e as Error).message}`);
    }
    paint();
  });
  const startTimer = () => (timer = setInterval(refresh, interval * 1000));

  async function attach() {
    const row = rs[view.sel];
    if (!row) return say("no ticket selected");
    const cmd = attachCmd(cfg.tmuxSession, row.window, !!process.env.TMUX);
    if (!cmd) return say(`${clean(row.id)} has no tmux window`);
    if (!cmd.suspend) {
      const res = await io.run(cmd.argv);
      return say(res.code ? `tmux: ${res.err || `exit ${res.code}`}` : `switched to ${row.repo}/${row.id}`);
    }
    clearInterval(timer);
    await r.suspend();
    let failed = "";
    try {
      child = Bun.spawn(cmd.argv, { stdio: ["inherit", "inherit", "inherit"] });
      const code = await child.exited;
      if (code) failed = `tmux attach exited ${code}`;
    } catch (e) {
      failed = `tmux: ${(e as Error).message}`;
    } finally {
      child = undefined;
      if (!exiting) {
        await r.resume();
        startTimer();
      }
    }
    if (exiting) return;
    if (failed) say(failed);
    void refresh();
  }

  function open() {
    const url = rs[view.sel]?.pr ?? null;
    if (!openable(url)) return say("no PR for this ticket");
    try {
      Bun.spawn(["xdg-open", url], { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();
      say(`opening ${url}`);
    } catch (e) {
      say(`xdg-open: ${(e as Error).message}`);
    }
  }

  r.keyInput.on("keypress", (k: KeyEvent) => {
    const a = action(k);
    if (!a) return;
    if (a === "quit") return void exit(0);
    if (a === "attach") return void attach();
    if (a === "open") return open();
    if (a === "refresh") return void refresh().then((ran) => ran || say("refresh already running"));
    view = reduce(view, a, rs.length, maxBack);
    paint();
  });
  r.on("resize", paint);

  paint();
  startTimer();
  void refresh();
}
