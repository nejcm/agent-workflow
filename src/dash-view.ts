import type { State } from "./state";
import type { PhaseStatus } from "./phases";
import { dur, label, type Row } from "./status";
import { fit, KIND } from "./tail";
import { clean } from "./util";

export interface Span {
  t: string;
  fg?: string;
  bg?: string;
  b?: boolean;
  d?: boolean;
  u?: boolean;
  r?: boolean;
}
export type Line = Span[];
export type Look = State | "orphan";
export type Pane = "list" | "tail";

const COLORS = {
  fg: "#d1d7e0",
  dim: "#7d8590",
  faint: "#3d444d",
  ink: "#0d1117",
  accent: "#56d4dd",
  ok: "#7ee787",
  warn: "#e3b341",
  bad: "#f47067",
  idle: "#9aa5b1",
  orphan: "#b08a3e",
  gone: "#5c6570",
  head: "#161b22",
  sel: "#1b2733",
  track: "#2d333b",
  badge: "#262c36",
};
type Tone = keyof typeof COLORS;
export type Palette = { mono: boolean } & Partial<Record<Tone, string>>;

/** Truecolor palette, or none at all (bold/dim/reverse only) under NO_COLOR. */
export const palette = (env: Record<string, string | undefined> = process.env): Palette => (env.NO_COLOR ? { mono: true } : { mono: false, ...COLORS });

const TONE: Record<Look, Tone> = { working: "accent", waiting: "warn", question: "warn", idle: "idle", unknown: "bad", orphan: "orphan", ended: "gone" };
const GLYPH: Record<Look, string> = { working: "●", waiting: "◆", question: "◇", idle: "○", unknown: "?", orphan: "◌", ended: "✕" };
const ORDER: Look[] = ["waiting", "question", "working", "idle", "unknown", "orphan", "ended"];

const s = (P: Palette, tone: Tone, t: string, x: Omit<Span, "t"> = {}): Span => ({ t, fg: P[tone], d: P.mono && (tone === "dim" || tone === "faint" || tone === "gone") ? true : undefined, ...x });
const w = (l: Line) => l.reduce((n, x) => n + Bun.stringWidth(x.t), 0);
const seg = new Intl.Segmenter();

/** `l` truncated (with …) or padded with `pad`'s style to exactly `n` columns. */
export function clip(l: Line, n: number, pad: Omit<Span, "t"> = {}): Line {
  const out: Line = [];
  let left = Math.max(0, n);
  for (const x of l) {
    if (!left) break;
    const xw = Bun.stringWidth(x.t);
    if (xw <= left) {
      if (x.t) out.push(x);
      left -= xw;
    } else {
      out.push({ ...x, t: fit(x.t, left) });
      left = 0;
    }
  }
  if (left) out.push({ ...pad, t: " ".repeat(left) });
  return out;
}

/** `l` split at column `n`; a wide char straddling the cut becomes spaces. */
export function cut(l: Line, n: number): [Line, Line] {
  const a: Line = [];
  const b: Line = [];
  let col = 0;
  for (const x of l) {
    let ta = "";
    let tb = "";
    for (const { segment } of seg.segment(x.t)) {
      const cw = Bun.stringWidth(segment);
      if (col >= n) tb += segment;
      else if (col + cw <= n) ta += segment;
      else (ta += " ".repeat(n - col)), (tb += " ".repeat(col + cw - n));
      col += cw;
    }
    if (ta) a.push({ ...x, t: ta });
    if (tb) b.push({ ...x, t: tb });
  }
  return [a, b];
}

/** `left`, then `right` flush to column `n` when both fit, else `left` alone; padded with `pad`. */
export function spread(left: Line, right: Line, n: number, pad: Omit<Span, "t"> = {}): Line {
  const gap = n - w(left) - w(right);
  return gap >= 1 ? [...left, { ...pad, t: " ".repeat(gap) }, ...right] : clip(left, n, pad);
}

const EIGHTHS = "▏▎▍▌▋▊▉";

/** A `width`-cell bar `done/total` full in eighth blocks; the unfilled track is spaces. */
export function bar(done: number, total: number, width: number) {
  if (width <= 0) return "";
  const e = total > 0 ? Math.round((Math.max(0, Math.min(done, total)) / total) * width * 8) : 0;
  const full = Math.floor(e / 8);
  const part = e % 8 ? EIGHTHS[(e % 8) - 1]! : "";
  return "█".repeat(full) + part + " ".repeat(width - full - (part ? 1 : 0));
}

const barTone = (r: Row): Tone => (r.phases && r.phases.total > 0 && r.phases.done >= r.phases.total ? "ok" : ({ working: "accent", waiting: "warn", question: "warn", idle: "idle", unknown: "idle", orphan: "gone", ended: "gone" } as const)[label(r)]);

function barSpan(P: Palette, r: Row, width: number, bg?: string): Span {
  const p = r.phases ?? { done: 0, total: 0 };
  if (P.mono) {
    const full = p.total ? Math.round((Math.min(p.done, p.total) / p.total) * width) : 0;
    return { t: "█".repeat(full) + "░".repeat(width - full) };
  }
  return { t: bar(p.done, p.total, width), fg: P[barTone(r)], bg: P.track ?? bg };
}

export const counts = (rs: Row[]) => {
  const c = Object.fromEntries(ORDER.map((k) => [k, 0])) as Record<Look, number>;
  for (const r of rs) c[label(r)]++;
  return c;
};

/** Waiting first, then working, idle, unknown, orphan, ended; by ID then repo within. */
export const sortRows = (rs: Row[]) => [...rs].sort((a, b) => ORDER.indexOf(label(a)) - ORDER.indexOf(label(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));

const frac = (r: Row) => (r.phases ? `${r.phases.done}/${r.phases.total}` : "-");

/** A list card (2 lines, or 1 when `two` is false) exactly `n` columns wide; the first column is the selection bar, IDs padded to `idW`. */
export function card(r: Row, n: number, two: boolean, selected: boolean, P: Palette, idW = 0): Line[] {
  const look = label(r);
  const gone = look === "ended" || look === "orphan";
  const bg = selected ? P.sel : undefined;
  const st = { bg, r: selected && P.mono ? true : undefined };
  const x = (tone: Tone, t: string, o: Omit<Span, "t"> = {}) => s(P, tone, t, { ...st, ...o });
  const inner = n - 2;
  const id = clean(r.id, 40);
  const left = [x(TONE[look], GLYPH[look]), x("fg", " "), x(gone ? "dim" : "fg", id, { b: true }), x("fg", " ".repeat(Math.max(0, idW - Bun.stringWidth(id)) + 2)), x("dim", clean(r.repo, 80))];
  const count = x(gone ? "dim" : "fg", ` ${frac(r).padEnd(5)}`);
  const times = x("dim", `${dur(r.idleMs)} · ${dur(r.runtimeMs)}`.padStart(11));
  const row = (body: Line) => clip([selected ? x("accent", "▌", { b: true }) : x("fg", " "), ...clip(body, inner, st), x("fg", " ")], n, st);
  if (!two) {
    const right = inner >= 80 ? [x("dim", `${r.agent}  `), barSpan(P, r, 16, bg), count, x("fg", "  "), times] : inner >= 30 ? [barSpan(P, r, Math.min(10, inner - 26), bg), count] : [count];
    return [row(spread(left, right, inner, st))];
  }
  const bw = Math.max(0, Math.min(18, inner - 2 - 6 - 2 - 11));
  const bottom = bw >= 4 ? [x("fg", "  "), barSpan(P, r, bw, bg), count] : [x("fg", "  "), count];
  return [row(spread(left, [x("dim", r.agent)], inner, st)), row(spread(bottom, [times], inner, st))];
}

interface Box {
  title: Line;
  foot?: Line;
  focused: boolean;
  pad: boolean;
}

/** A rounded box `n`×`h` around `content`; borderless when too small for one. */
export function box(b: Box, content: Line[], n: number, h: number, P: Palette): Line[] {
  if (h <= 0 || n <= 0) return [];
  if (n < 6 || h < 3) return Array.from({ length: h }, (_, i) => clip(content[i] ?? [], n));
  const tone: Tone = b.focused ? "accent" : "faint";
  const e = (t: string) => s(P, tone, t, b.focused && P.mono ? { b: true } : {});
  const title = clip(b.title, Math.min(w(b.title), n - 6));
  const foot = b.foot ? clip(b.foot, Math.min(w(b.foot), n - 6)) : [];
  const top = [e("╭─"), ...title, e("─".repeat(n - 3 - w(title))), e("╮")];
  const bottom = [e("╰"), e("─".repeat(n - 3 - w(foot))), ...foot, e("─╯")];
  const inner = b.pad ? n - 4 : n - 2;
  const mid = Array.from({ length: h - 2 }, (_, i) => [e("│"), ...(b.pad ? [{ t: " " }] : []), ...clip(content[i] ?? [], inner), ...(b.pad ? [{ t: " " }] : []), e("│")]);
  return [top, ...mid, bottom];
}

export interface Layout {
  mode: "wide" | "narrow" | "tiny" | "max";
  body: number;
  listW: number;
  listH: number;
  detailH: number;
  tailH: number;
  cardH: 1 | 2;
}

/** Pane sizes for a `width`×`height` screen with `n` tickets whose detail wants `need` rows. */
export function layout(width: number, height: number, n: number, max: boolean, need: number): Layout {
  const body = Math.max(0, height - 2);
  const base = { body, listW: width, listH: 0, detailH: 0, tailH: 0, cardH: 1 as 1 | 2 };
  if (max) return { ...base, mode: "max", tailH: body };
  if (width < 50 || body < 12) {
    const listH = Math.min(Math.max(n, 1), body > 4 ? Math.ceil(body / 2) : body);
    return { ...base, mode: "tiny", listH, tailH: body - listH };
  }
  if (width >= 110) {
    const detailH = Math.max(0, Math.min(need + 2, body - Math.max(6, Math.ceil(body * 0.4))));
    return { ...base, mode: "wide", listW: Math.max(38, Math.min(42, Math.round(width * 0.27))), listH: body, detailH, tailH: body - detailH, cardH: n * 2 <= body - 2 ? 2 : 1 };
  }
  const listH = Math.min(Math.max(n, 1) + 2, Math.max(3, Math.floor(body * 0.35)));
  const rest = body - listH;
  const detailH = Math.max(0, Math.min(need + 2, rest - Math.max(3, Math.floor(rest * 0.4))));
  return { ...base, mode: "narrow", listH, detailH, tailH: rest - detailH };
}

/** First row index to show so `sel` stays visible in `visible` lines. */
export const scroll = (sel: number, n: number, visible: number) => Math.max(0, Math.min(sel - Math.floor(visible / 2), n - visible));

export function chips(rs: Row[], P: Palette, compact: boolean): Line {
  const c = counts(rs);
  const out: Line = [];
  for (const k of ORDER) {
    if ((k === "unknown" || k === "question") && !c[k]) continue;
    const text = compact ? `${GLYPH[k]}${c[k]}` : `${GLYPH[k]} ${c[k]} ${k}`;
    if (k === "waiting" && c[k]) out.push(P.mono ? { t: ` ${text} `, b: true, r: true } : { t: ` ${text} `, fg: P.ink, bg: P.warn, b: true });
    else if (!c[k]) out.push(s(P, "faint", ` ${text} `, { bg: P.head }));
    else out.push(s(P, TONE[k], ` ${GLYPH[k]}`, { bg: P.head }), s(P, "fg", compact ? `${c[k]} ` : ` ${c[k]}`, { bg: P.head, b: true }), ...(compact ? [] : [s(P, "dim", ` ${k} `, { bg: P.head })]));
  }
  return out;
}

export function header(rs: Row[], host: string, at: string, every: number, n: number, P: Palette): Line {
  const bg = { bg: P.head };
  const mark: Span = P.mono ? { t: " aw ", b: true, r: true } : { t: " aw ", fg: P.ink, bg: P.accent, b: true };
  const h = s(P, "dim", ` ${clean(host, 40)} `, bg);
  const time = [s(P, "fg", `${at} `, bg), s(P, "dim", `· every ${every}s `, bg)];
  for (const [left, right] of [
    [[mark, h, ...chips(rs, P, false)], time],
    [[mark, h, ...chips(rs, P, true)], time],
    [[mark, ...chips(rs, P, true)], [s(P, "fg", `${at} `, bg)]],
    [[mark, ...chips(rs, P, true)], []],
  ] as [Line, Line][])
    if (w(left) + w(right) + 1 <= n || !right.length) return spread(left, right, n, bg);
  return [];
}

interface Hints {
  pane: Pane;
  max: boolean;
  help: boolean;
  window: boolean;
  pr: boolean;
}

export function footer(h: Hints, msg: string, n: number, P: Palette): Line {
  const k = (key: string, what: string): Line => [s(P, "fg", ` ${key}`, { b: true }), s(P, "dim", ` ${what} `)];
  const keys: Line[] = h.help
    ? [k("?", "close help"), k("q", "quit")]
    : [
        ...(h.pane === "tail" ? [k("j/k", "scroll"), k("g/G", "top/end")] : [k("j/k", "select")]),
        k("tab", h.pane === "tail" ? "list" : "transcript"),
        k("⏎", h.max ? "restore" : "maximise"),
        ...(h.window ? [k("a", "attach")] : []),
        ...(h.pr ? [k("o", "open PR")] : []),
        k("r", "refresh"),
        k("?", "help"),
        k("q", "quit"),
      ];
  const flat = keys.flat();
  return msg ? clip([s(P, "warn", ` ${msg} `, { b: true }), s(P, "faint", "│"), ...flat], n) : clip(flat, n);
}

const HELP: [string, string][] = [
  ["j k ↓ ↑", "select ticket / scroll transcript"],
  ["g G", "first / last"],
  ["tab", "switch list ↔ transcript"],
  ["enter", "maximise / restore transcript"],
  ["a", "attach to the ticket's tmux window"],
  ["o", "open the PR in a browser"],
  ["r", "refresh now"],
  ["?  esc", "close this help"],
  ["q  ctrl-c", "quit"],
];

/** The key help box drawn over the middle of `screen` rows 1..n-2. */
export function helpOverlay(screen: Line[], n: number, P: Palette): Line[] {
  const bw = Math.min(n, 50);
  const lines = HELP.map(([key, what]) => [s(P, "accent", key.padEnd(11), { b: true }), s(P, "fg", what)]);
  const bh = Math.min(lines.length + 2, screen.length - 2);
  if (bh < 3 || bw < 10) return screen;
  const panel = box({ title: [s(P, "fg", " keys ", { b: true })], focused: true, pad: true }, lines, bw, bh, P).map((l) => l.map((x) => ({ ...x, bg: x.bg ?? P.head })));
  const x0 = Math.floor((n - bw) / 2);
  const y0 = 1 + Math.max(0, Math.floor((screen.length - 2 - bh) / 2));
  return screen.map((l, i) => {
    if (i < y0 || i >= y0 + bh) return l;
    const [a, rest] = cut(l, x0);
    return [...a, ...panel[i - y0]!, ...cut(rest, bw)[1]];
  });
}

const home = (p: string, h: string) => (h && (p === h || p.startsWith(h + "/")) ? "~" + p.slice(h.length) : p);
const when = (ms: number, now: number) => {
  const d = new Date(ms);
  const t = d.toTimeString().slice(0, 5);
  return now - ms < 20 * 3600_000 ? t : `${d.toISOString().slice(5, 10)} ${t}`;
};
const pct = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0);

/** The phase strip: one group per phase coloured by its status, or one smooth bar when phases outnumber cells. */
export function segments(items: { status: PhaseStatus }[], n: number, P: Palette): Line {
  if (n <= 0) return [];
  if (!items.length) return clip([s(P, "faint", "─".repeat(n))], n);
  const gap = (n - items.length + 1) / items.length >= 2 ? 1 : 0;
  const size = Math.floor((n - gap * (items.length - 1)) / items.length);
  const toneOf = (st: PhaseStatus): Tone => (st === "done" ? "ok" : st === "in-progress" ? "accent" : "faint");
  if (size < 1) {
    const done = items.filter((x) => x.status === "done").length;
    return [s(P, "ok", bar(done, items.length, n).replace(/ /g, P.mono ? "░" : " "), { bg: P.track })];
  }
  const extra = n - gap * (items.length - 1) - size * items.length;
  const out: Line = items.flatMap((x, i) => {
    const ch = P.mono ? (x.status === "done" ? "█" : x.status === "in-progress" ? "▓" : "░") : "━";
    return [...(i && gap ? [{ t: " " }] : []), s(P, toneOf(x.status), ch.repeat(size + (i < extra ? 1 : 0)))];
  });
  return clip(out, n);
}

export interface DetailCtx {
  now: number;
  wt: string;
  home: string;
}

/** The selected ticket's detail rows for an `n`-column pane, at most `rows` (Infinity: its natural height). */
export function detail(r: Row | undefined, n: number, rows: number, ctx: DetailCtx, P: Palette): Line[] {
  if (!r) return [[s(P, "dim", "no ticket selected")]];
  const look = label(r);
  const badge = (t: string, tone: Tone): Span => (P.mono ? { t: `[${t}]`, b: true } : s(P, tone, ` ${t} `, { bg: P.badge }));
  const title: Line = [s(P, "fg", clean(r.id, 40), { b: true }), s(P, "dim", `  ${clean(r.repo, 80)}  `), badge(r.agent, "dim"), { t: " " }, badge(`${GLYPH[look]} ${look}`, TONE[look])];
  if (r.waitingFor) title.push(s(P, "warn", ` ${clean(r.waitingFor, 60)}`, { b: true }));
  const pr: Line = r.pr ? [s(P, "accent", `#${/\d+$/.exec(r.pr)?.[0] ?? "?"}`, { u: true }), ...(r.merge ? [s(P, "warn", ` ${r.merge}`)] : [])] : [s(P, "dim", "-")];
  const kv = (k: string, v: Line): Line => [s(P, "dim", k.padEnd(9)), ...v];
  const val = (t: string): Line => [s(P, "fg", t)];
  const pairs: [string, Line][] = [
    ["runtime", val(dur(r.runtimeMs))],
    ["idle", val(dur(r.idleMs))],
    ["started", val(r.startedAt === null ? "-" : when(r.startedAt, ctx.now))],
    ["PR", pr],
  ];
  const branch = kv("branch", val(`agent/${clean(r.id, 40)}`));
  const tree = kv("worktree", val(clean(home(ctx.wt, ctx.home), 300)));
  const cols = (ls: Line[], k: number) => [...ls.slice(0, -1).flatMap((l) => clip(l, Math.floor(n / k))), ...ls.at(-1)!];
  const meta: Line[] =
    n >= 96
      ? [cols(pairs.map((p) => kv(...p)), 4), cols([branch, tree], 4)]
      : n >= 56
        ? [cols([kv(...pairs[0]!), kv(...pairs[1]!)], 2), cols([kv(...pairs[2]!), kv(...pairs[3]!)], 2), branch, tree]
        : [...pairs.map((p) => kv(...p)), branch, tree];
  const p = r.phases;
  const items = p?.items ?? [];
  const phHead: Line = p
    ? [s(P, "dim", "PHASES", { b: true }), s(P, "fg", `  ${p.done}/${p.total}`, { b: true }), s(P, "dim", `  ${pct(p.done, p.total)}%`)]
    : [s(P, "dim", "PHASES", { b: true }), s(P, "dim", "  none reported")];
  const strip = p ? [segments(items, n, P)] : [];
  const check = (x: { title: string; status: PhaseStatus }): Line =>
    x.status === "done"
      ? [s(P, "ok", "✓ "), s(P, "fg", x.title)]
      : x.status === "in-progress"
        ? [s(P, "accent", "◐ "), s(P, "accent", x.title, { b: true })]
        : [s(P, "faint", "○ "), s(P, "dim", x.title)];
  let room = rows - 2 - strip.length;
  const showMeta = room >= meta.length + Math.min(items.length, 3);
  if (showMeta) room -= meta.length;
  let list: Line[] = [];
  if (items.length && room > 0) {
    if (items.length <= room) list = items.map(check);
    else {
      const vis = room - 1;
      const cur = Math.max(0, items.findIndex((x) => x.status !== "done"));
      const start = Math.max(0, Math.min(cur - 1, items.length - vis));
      const below = items.length - start - vis;
      list = [...items.slice(start, start + vis).map(check), [s(P, "dim", `+${items.length - vis} more${start ? ` (${start} above${below ? `, ${below} below` : ""})` : ""}`)]];
    }
  }
  const spare = room - list.length;
  const gap = (k: number): Line[] => (spare >= k ? [[]] : []);
  const out = [title, ...gap(showMeta ? 2 : 1), ...(showMeta ? [...meta, ...gap(1)] : []), phHead, ...strip, ...list];
  return out.slice(0, Math.max(0, rows));
}

/** One transcript event as styled rows, the message wrapped under its own column. */
export function event(ev: string, n: number, P: Palette): Line[] {
  if (!/^(\d\d:\d\d:\d\d|--:--:--) /.test(ev)) return [[s(P, "dim", ev)]];
  const [kindPart, rest] = cut([{ t: ev.slice(9) }], KIND);
  const kind = kindPart.map((x) => x.t).join("");
  const msg = rest.map((x) => x.t).join("").slice(1);
  const k = kind.trim();
  const tone: Tone = k === "say" ? "fg" : k === "ERROR" ? "bad" : "accent";
  const head: Line = [s(P, "faint", ev.slice(0, 8)), { t: " " }, s(P, tone, kind, { b: k === "ERROR" }), { t: " " }];
  const indent = 9 + KIND + 1;
  const mtone: Tone = k === "say" ? "fg" : k === "ERROR" ? "bad" : "dim";
  if (n - indent < 30) return [clip([...head, s(P, mtone, msg)], n)];
  return wrap(msg, n - indent).map((t, i) => [...(i ? [{ t: " ".repeat(indent) }] : head), s(P, mtone, t)]);
}

/** `t` broken into rows of at most `n` columns, at a space when one is in the back half of the row. */
export function wrap(t: string, n: number): string[] {
  if (n <= 0) return [];
  const out: string[] = [];
  let cur = "";
  let cw = 0;
  for (const { segment } of seg.segment(t)) {
    const gw = Bun.stringWidth(segment);
    if (cw + gw > n) {
      const sp = cur.lastIndexOf(" ");
      if (sp > cur.length / 2) {
        out.push(cur.slice(0, sp));
        cur = cur.slice(sp + 1);
      } else {
        out.push(cur);
        cur = "";
      }
      cw = Bun.stringWidth(cur);
    }
    cur += segment;
    cw += gw;
  }
  if (cur || !out.length) out.push(cur);
  return out;
}

/** The last `h` transcript rows `back` rows above the end, and how far back it can go. */
export function tailView(evs: string[], n: number, h: number, back: number, P: Palette, memo = new Map<string, Line[]>()) {
  const rows: Line[] = [];
  for (const ev of evs) {
    const k = `${n}\0${ev}`;
    let r = memo.get(k);
    if (!r) memo.set(k, (r = event(ev, n, P)));
    rows.push(...r);
  }
  const maxBack = Math.max(0, rows.length - h);
  const b = Math.max(0, Math.min(back, maxBack));
  return { lines: rows.slice(Math.max(0, rows.length - h - b), rows.length - b), maxBack, back: b };
}

export interface Model {
  rs: Row[];
  sel: number;
  pane: Pane;
  max: boolean;
  help: boolean;
  back: number;
  host: string;
  at: string;
  every: number;
  msg: string;
  events: string[];
  empty: string;
  ctx: DetailCtx;
}

/** Every screen row for `m` on a `n`×`h` terminal, each exactly `n` columns. */
export function screen(m: Model, n: number, h: number, P: Palette, memo?: Map<string, Line[]>) {
  if (h <= 0) return { lines: [] as Line[], maxBack: 0 };
  const sel = m.rs[m.sel];
  const need = detail(sel, Math.max(0, n - 4), Infinity, m.ctx, P).length;
  const L = layout(n, h, m.rs.length, m.max, need);
  const bar = (t: string, x: Omit<Span, "t"> = {}) => s(P, "dim", t, x);
  const name = sel ? clean(`${sel.id} · ${sel.repo}`, 120) : "transcript";
  let maxBack = 0;

  const tailBox = (bw: number, bh: number, borderless = false): Line[] => {
    const inner = borderless ? bw : bw - 4;
    const t = tailView(m.events, Math.max(1, inner), Math.max(0, borderless ? bh : bh - 2), m.back, P, memo);
    maxBack = t.maxBack;
    const content = m.events.length ? t.lines : [[bar(m.empty)]];
    if (borderless) return Array.from({ length: bh }, (_, i) => clip(content[i] ?? [], bw));
    const title: Line = [s(P, m.pane === "tail" ? "fg" : "dim", ` ${m.max ? name : "transcript"} `, { b: m.pane === "tail" })];
    const foot: Line | undefined = t.back ? [s(P, "warn", ` ↑ ${t.back} · G to follow `)] : m.events.length ? [bar(" following ")] : undefined;
    return box({ title, foot, focused: m.pane === "tail", pad: true }, content, bw, bh, P);
  };

  const listBox = (bw: number, bh: number, cardH: 1 | 2, borderless = false): Line[] => {
    const inner = borderless ? bw : bw - 2;
    const vis = Math.max(1, Math.floor((borderless ? bh : bh - 2) / cardH));
    const start = scroll(m.sel, m.rs.length, vis);
    const shownRows = m.rs.slice(start, start + vis);
    const idW = Math.min(12, Math.max(0, ...shownRows.map((r) => Bun.stringWidth(clean(r.id, 40)))));
    const content = m.rs.length ? shownRows.flatMap((r, i) => card(r, inner, cardH === 2, start + i === m.sel, P, idW)) : [[bar("  no worktrees")]];
    if (borderless) return Array.from({ length: bh }, (_, i) => clip(content[i] ?? [], bw));
    const title: Line = [s(P, m.pane === "list" ? "fg" : "dim", " tickets ", { b: m.pane === "list" }), bar(`${m.rs.length} `)];
    const foot: Line | undefined = m.rs.length > vis ? [bar(` ${m.sel + 1}/${m.rs.length} `)] : undefined;
    return box({ title, foot, focused: m.pane === "list", pad: false }, content, bw, bh, P);
  };

  const detailBox = (bw: number, bh: number): Line[] => box({ title: [bar(" detail ")], focused: false, pad: true }, detail(sel, bw - 4, bh - 2, m.ctx, P), bw, bh, P);

  let body: Line[];
  if (L.mode === "max") body = tailBox(n, L.tailH);
  else if (L.mode === "tiny") {
    const head = clip([bar(`── ${name} `)], Math.min(n, Bun.stringWidth(`── ${name} `)));
    const rule: Line[] = L.tailH > 0 ? [[...head, s(P, "faint", "─".repeat(Math.max(0, n - w(head))))]] : [];
    body = [...listBox(n, L.listH, 1, true), ...rule, ...(L.tailH > 1 ? tailBox(n, L.tailH - 1, true) : [])];
  } else if (L.mode === "narrow") body = [...listBox(n, L.listH, 1), ...detailBox(n, L.detailH), ...tailBox(n, L.tailH)];
  else {
    const left = listBox(L.listW, L.listH, L.cardH);
    const right = [...detailBox(n - L.listW, L.detailH), ...tailBox(n - L.listW, L.tailH)];
    body = left.map((l, i) => [...l, ...(right[i] ?? [])]);
  }
  const hints = { pane: m.pane, max: m.max, help: m.help, window: !!sel?.window, pr: !!sel?.pr };
  let lines = [header(m.rs, m.host, m.at, m.every, n, P), ...body.slice(0, L.body).map((l) => clip(l, n))];
  while (lines.length < h - 1) lines.push(clip([], n));
  if (h >= 2) lines.push(footer(hints, m.msg, n, P));
  lines = lines.slice(0, h);
  return { lines: m.help ? helpOverlay(lines, n, P) : lines, maxBack };
}
