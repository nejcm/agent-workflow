import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { KeyEvent } from "@opentui/core";
import type { State } from "./state";
import { dur, PR_URL, prLabel, type Row, snapshot } from "./status";
import { clean, reader } from "./tail";
import type { Config, Io } from "./types";

export type Action = "down" | "up" | "first" | "last" | "focus" | "attach" | "open" | "refresh" | "help" | "quit";
export interface View {
  sel: number;
  focus: boolean;
  help: boolean;
}

const KEYS = new Map<string, Action>([
  ["j", "down"],
  ["down", "down"],
  ["k", "up"],
  ["up", "up"],
  ["return", "focus"],
  ["linefeed", "focus"],
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

/** Selection, focus and help after `a` on `n` rows; the selection stays put while the tail is focused. */
export function reduce(v: View, a: Action, n: number): View {
  const last = Math.max(0, n - 1);
  const sel = (i: number) => (v.focus ? v : { ...v, sel: Math.max(0, Math.min(last, i)) });
  if (a === "down") return sel(v.sel + 1);
  if (a === "up") return sel(v.sel - 1);
  if (a === "first") return sel(0);
  if (a === "last") return sel(last);
  if (a === "focus") return { ...v, focus: !v.focus };
  if (a === "help") return { ...v, help: !v.help };
  return v;
}

const key = (r: Row | undefined) => (r ? `${r.repo}/${r.id}` : undefined);

/** The index of the previously selected ticket in `next`, else the old index clamped. */
export function reselect(prev: string | undefined, next: Row[], sel: number) {
  const i = next.findIndex((r) => key(r) === prev);
  return i >= 0 ? i : Math.max(0, Math.min(next.length - 1, sel));
}

const seg = new Intl.Segmenter();

/** `s` truncated (with …) or padded to exactly `w` terminal columns. */
export function fit(s: string, w: number) {
  if (w <= 0) return "";
  const sw = Bun.stringWidth(s);
  if (sw <= w) return s + " ".repeat(w - sw);
  let out = "";
  let n = 0;
  for (const { segment } of seg.segment(s)) {
    const cw = Bun.stringWidth(segment);
    if (n + cw > w - 1) break;
    out += segment;
    n += cw;
  }
  return out + "…" + " ".repeat(w - 1 - n);
}

const HEAD = ["ID", "REPO", "AGENT", "STATE", "IDLE", "RUNTIME", "PHASES", "PR"];
const FLEX = [0, 1, 3];
const GAP = "  ";

const cells = (r: Row) =>
  [r.id, r.repo, r.agent, r.waitingFor ? `${r.state}: ${r.waitingFor}` : r.state, dur(r.idleMs), dur(r.runtimeMs), r.phases ? `${r.phases.done}/${r.phases.total}` : "-", prLabel(r)].map((x) => clean(x, 80));

/** Column widths for `all` (header first) within `width`, shrinking ID, REPO and STATE first. */
export function widths(all: string[][], width: number) {
  const w = HEAD.map((_, i) => Math.max(...all.map((c) => Bun.stringWidth(c[i] ?? ""))));
  let over = w.reduce((a, b) => a + b, 0) + GAP.length * (w.length - 1) - width;
  while (over-- > 0) {
    const i = FLEX.reduce((a, b) => (w[b]! > w[a]! ? b : a));
    if (w[i]! <= 4) break;
    w[i]!--;
  }
  return w;
}

/** One table line per row (header first), each exactly `width` columns; "> " marks the selected row. */
export function lines(rs: Row[], width: number, sel: number) {
  const all = [HEAD, ...rs.map(cells)];
  const w = widths(all, width - 2);
  return all.map((c, i) => fit((i - 1 === sel ? "> " : "  ") + c.map((x, j) => fit(x, w[j]!)).join(GAP).trimEnd(), width));
}

/** Heights of the table (header included) and tail pane; header and footer lines take the rest. */
export function layout(h: number, n: number, focus: boolean) {
  const body = Math.max(0, h - 2);
  const table = focus ? 0 : Math.min(n + 1, Math.max(2, Math.ceil(body / 2)), body);
  return { table, tail: body - table };
}

/** First row index to show so `sel` stays visible in `visible` lines. */
export const scroll = (sel: number, n: number, visible: number) => Math.max(0, Math.min(sel - Math.floor(visible / 2), n - visible));

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

const COLOR: Record<State, string> = { waiting: "#e3b341", working: "#7ee787", idle: "#8b949e", ended: "#6e7681", unknown: "#b56a6a" };
const DIM = "#8b949e";
const SEL_BG = "#30363d";
const MAX_TAIL = 500;
const HELP = "j/k move  g/G first/last  Enter focus tail  a attach  o open PR  r refresh  ? help  q quit";

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
  const { BoxRenderable, ScrollBoxRenderable, TextRenderable, createCliRenderer } = await import("@opentui/core");
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
  let view: View = { sel: 0, focus: false, help: false };
  let at = "--:--:--";
  let msg = "";
  let tail: { path: string | null; next?: () => string[]; lines: string[] } = { path: null, lines: [] };

  const header = new TextRenderable(r, { id: "header", content: "", height: 1, fg: DIM, wrapMode: "none" });
  const table = new BoxRenderable(r, { id: "table", flexDirection: "column", flexShrink: 0 });
  const pane = new ScrollBoxRenderable(r, { id: "tail", flexGrow: 1, stickyScroll: true, stickyStart: "bottom", rootOptions: { border: true, borderColor: DIM } });
  const tailText = new TextRenderable(r, { id: "tail-text", content: "", wrapMode: "word" });
  const footer = new TextRenderable(r, { id: "footer", content: "", height: 1, fg: DIM, wrapMode: "none" });
  pane.add(tailText);
  r.root.flexDirection = "column";
  for (const x of [header, table, pane, footer]) r.root.add(x);
  const pool: InstanceType<typeof TextRenderable>[] = [];

  const shown = new WeakMap<object, string>();
  const styled = new WeakMap<object, string>();
  const set = (t: InstanceType<typeof TextRenderable>, s: string) => {
    if (shown.get(t) !== s) shown.set(t, (t.content = s));
  };

  function say(m: string) {
    msg = clean(m, 300);
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => ((msg = ""), paint()), 4000);
    paint();
  }

  function pump() {
    const p = rs[view.sel]?.transcript ?? null;
    if (p !== tail.path) tail = { path: p, next: p ? reader(p) : undefined, lines: [] };
    const add = tail.next?.() ?? [];
    // events() already clean()s every field; cleaning again would collapse its column padding.
    if (add.length) tail.lines = [...tail.lines, ...add].slice(-MAX_TAIL);
    set(tailText, tail.lines.length ? tail.lines.join("\n") : p ? "no events yet" : "no transcript yet");
    const sel = rs[view.sel];
    const title = ` ${sel ? clean(`${sel.repo}/${sel.id}`, 120) : "transcript"}${view.focus ? " (focused)" : ""} `;
    if (pane.title !== title) pane.title = title;
  }

  function paint() {
    if (exiting) return;
    const { width, height } = r;
    const lay = layout(height, rs.length, view.focus);
    table.height = lay.table;
    table.visible = lay.table > 0;
    while (pool.length < lay.table) {
      const t = new TextRenderable(r, { id: `row-${pool.length}`, content: "", height: 1, wrapMode: "none" });
      pool.push(t);
      table.add(t);
    }
    // Rows are hidden, not removed: OpenTUI keeps removed renderables registered until destroyed.
    pool.forEach((t, i) => (t.visible = i < lay.table));
    const all = lines(rs, width, view.sel);
    const start = scroll(view.sel, rs.length, lay.table - 1);
    pool.slice(0, lay.table).forEach((t, i) => {
      const ri = i === 0 ? -1 : start + i - 1;
      set(t, i === 0 ? all[0]! : all[ri + 1] ?? "");
      const look = `${i === 0 ? DIM : COLOR[rs[ri]?.state ?? "unknown"]} ${i > 0 && ri === view.sel ? SEL_BG : "transparent"}`;
      if (styled.get(t) !== look) [t.fg, t.bg] = look.split(" ") as [string, string];
      styled.set(t, look);
    });
    const running = rs.filter((x) => x.session === "running").length;
    set(header, fit(`aw ${clean(cfg.host, 40)}  ${rs.length} sessions, ${running} running  refreshed ${at}  every ${interval}s  ? help  q quit`, width));
    set(footer, fit(msg || (view.help ? HELP : rs.length ? "" : "no worktrees"), width));
    pump();
  }

  const refresh = exclusive(async () => {
    try {
      const next = await snapshot(cfg, io);
      const prev = key(rs[view.sel]);
      rs = next;
      view = { ...view, sel: reselect(prev, rs, view.sel) };
      at = new Date().toLocaleTimeString();
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
    if (view.focus && (a === "down" || a === "up" || a === "first" || a === "last")) {
      if (a === "first" || a === "last") pane.scrollTo(a === "first" ? 0 : pane.scrollHeight);
      else pane.scrollBy(a === "down" ? 1 : -1);
      return;
    }
    view = reduce(view, a, rs.length);
    paint();
  });
  r.on("resize", paint);

  paint();
  startTimer();
  void refresh();
}
