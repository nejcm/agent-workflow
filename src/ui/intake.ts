import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoConfig } from "../config/repo-config";
import { DB_FILE } from "../db";
import { HEARTBEAT, ms, SLACK_MS } from "../intake";
import type { Config, IntakeRule, Io } from "../types";
import { clean, GIT, mtime, read, SYSTEMD } from "../util";
import { clip, type Line, type Palette, s as sp, scroll, type Span, spread, when, wrap } from "./dash-view";
import { dur } from "./status";

const TICK = 15 * 60_000;
const STALE = 20 * 60_000;

export type Mode = "auto" | "judge" | "judge(off)" | "shadow";
export interface RuleInfo {
  id: string;
  repo: string;
  name: string;
  enabled: boolean;
  every?: string;
  mode?: Mode;
  /** Set when the rule's definition could not be read. */
  problem?: string;
  ranAt?: number;
  error?: string;
  next?: number;
  due?: boolean;
  filed?: number;
  open?: number;
  reopened?: number;
  gone?: number;
  still?: number;
}
export interface IntakeInfo {
  host: string;
  here: boolean;
  timer: "ok" | "late" | "none";
  beat?: number;
  judge?: { agent: string; model: string; maxPerRun: number; last?: number };
  guardrails?: { last?: number };
  rules: RuleInfo[];
  errors: number;
  /** Set when tender.db could not be read. */
  problem?: string;
}

/** The first timer tick at or after `at`: quarter hours under systemd, else launchd's `last + 15m` steps. */
export function tickAt(at: number, last?: number, aligned = SYSTEMD) {
  if (aligned || last === undefined) return Math.ceil(at / TICK) * TICK;
  return last + Math.max(0, Math.ceil((at - last) / TICK)) * TICK;
}

/** When the rule next runs, and whether it is due now (never ran, or `every` has passed). */
export function nextRun(ranAt: number | undefined, every: string, now: number, last?: number) {
  const target = ranAt === undefined ? now : ranAt + ms(every) - SLACK_MS;
  return { at: tickAt(Math.max(now, target), last), due: target <= now };
}

export const modeOf = (rule: IntakeRule, cfg: Config): Mode => (rule.autoLabel.length ? "auto" : rule.judge ? (cfg.judge ? "judge" : "judge(off)") : "shadow");

const origin = async (io: Io, path: string) => (await read(io, [...GIT, "-C", path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim().replace(/^origin\//, "");

// Local git only: the base is tender.json's or the clone's origin/HEAD, never a fetch or the GitHub API. An empty GIT_ALLOW_PROTOCOL stops a partial clone's lazy fetch on git < 2.45 too.
async function definitions(cfg: Config, parent: Io) {
  const io: Io = { ...parent, run: (argv, cwd, secs, o) => parent.run(argv, cwd, secs, { ...o, env: { ...((o?.env ?? process.env) as Record<string, string>), GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" } }) };
  const out = new Map<string, { rules?: IntakeRule[]; problem?: string }>();
  for (const r of Object.values(cfg.repos)) {
    try {
      const c = await repoConfig(io, r, r.baseBranch ?? (await origin(io, r.path)));
      out.set(r.key, c.config ? { rules: c.config.intake } : { problem: `.tender/ invalid: ${clean(c.error ?? "", 300)}` });
    } catch (e) {
      out.set(r.key, { problem: clean((e as Error).message, 300) });
    }
  }
  return out;
}

type Runs = Map<string, { ranAt: number; error?: string }>;
type Counts = Map<string, Pick<RuleInfo, "filed" | "open" | "reopened" | "gone" | "still">>;

// Read-only, like stats: an older schema just lacks the newer columns.
function history(file: string) {
  const runs: Runs = new Map();
  const counts: Counts = new Map();
  const last: Record<string, number | undefined> = {};
  if (!existsSync(file)) return { runs, counts, last };
  const db = new Database(file, { readonly: true });
  try {
    const has = (t: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const count = (rule: string) => counts.get(rule) ?? counts.set(rule, {}).get(rule)!;
    if (has("intake_runs")) {
      const withError = db.query("SELECT 1 FROM pragma_table_info('intake_runs') WHERE name = 'error'").get();
      for (const r of db.query<{ rule: string; ran_at: string; error: string | null }, []>(`SELECT rule, ran_at, ${withError ? "error" : "NULL AS error"} FROM intake_runs`).all())
        runs.set(r.rule, { ranAt: Date.parse(r.ran_at), ...(r.error && { error: clean(r.error, 300) }) });
    }
    if (has("intake_seen"))
      for (const r of db.query<{ rule: string; filed: number; open: number; reopened: number }, []>("SELECT rule, count(ticket_url) AS filed, sum(state = 'open') AS open, sum(state = 'reopened') AS reopened FROM intake_seen GROUP BY rule").all())
        Object.assign(count(r.rule), { filed: r.filed, open: r.open ?? 0, reopened: r.reopened ?? 0 });
    if (has("events")) {
      for (const r of db.query<{ rule: string; gone: number; still: number }, []>("SELECT json_extract(data, '$.rule') AS rule, sum(json_extract(data, '$.state') = 'gone') AS gone, sum(json_extract(data, '$.state') = 'still') AS still FROM events WHERE kind = 'recheck' GROUP BY 1").all())
        if (r.rule) Object.assign(count(r.rule), { gone: r.gone, still: r.still });
      for (const k of ["judge", "guardrail"]) {
        const at = db.query<{ at: string | null }, [string]>("SELECT max(at) AS at FROM events WHERE kind = ?").get(k)?.at;
        last[k] = at ? Date.parse(at) : undefined;
      }
    }
    return { runs, counts, last };
  } finally {
    db.close();
  }
}

/** What the dashboard shows about intake; undefined without `intake` in tender.json. Never touches the network. */
export async function intakeInfo(cfg: Config, io: Io, now = Date.now()): Promise<IntakeInfo | undefined> {
  if (!cfg.intake) return;
  const here = cfg.intake.host === cfg.host;
  const beat = here ? mtime(join(cfg.workspaceRoot, HEARTBEAT)) : undefined;
  const timer = beat === undefined ? "none" : now - beat > STALE ? "late" : "ok";
  let h: ReturnType<typeof history> = { runs: new Map(), counts: new Map(), last: {} };
  let problem: string | undefined;
  if (here)
    try {
      h = history(join(cfg.workspaceRoot, DB_FILE));
    } catch (e) {
      problem = `${DB_FILE} unreadable: ${clean((e as Error).message)}`;
    }
  const defs = await definitions(cfg, io);
  const enabled = new Set(cfg.intake.enabled);
  const ids = [...cfg.intake.enabled, ...[...defs].flatMap(([repo, d]) => (d.rules ?? []).map((x) => `${repo}:${x.name}`).filter((id) => !enabled.has(id)))];
  const rules = ids.map((id): RuleInfo => {
    const repo = id.slice(0, id.lastIndexOf(":"));
    const name = id.slice(id.lastIndexOf(":") + 1);
    const d = defs.get(repo);
    const rule = d?.rules?.find((x) => x.name === name);
    const base: RuleInfo = { id, repo, name, enabled: enabled.has(id) };
    if (!rule) return { ...base, problem: d?.problem ?? `no rule ${name} in .tender/config.yaml` };
    const info: RuleInfo = { ...base, every: rule.every, mode: modeOf(rule, cfg) };
    if (!here || !info.enabled) return info;
    const run = h.runs.get(id);
    const { at: next, due } = nextRun(run?.ranAt, rule.every, now, beat);
    return { ...info, ...h.counts.get(id), ranAt: run?.ranAt, error: run?.error, next, due };
  });
  return {
    host: cfg.intake.host,
    here,
    timer,
    beat,
    ...(cfg.judge && { judge: { agent: cfg.judge.agent, model: cfg.judge.model, maxPerRun: cfg.judge.maxPerRun, last: h.last.judge }, ...(cfg.judge.guardrails && { guardrails: { last: h.last.guardrail } }) }),
    rules,
    errors: rules.filter((r) => r.error || (r.enabled && r.problem)).length,
    ...(problem && { problem }),
  };
}

const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);
const ago = (t: number | undefined, now: number) => (t === undefined ? "never" : `${when(t, now)} (${dur(Math.max(0, now - t))} ago)`);

/** The header chip: next run, or the error count or a stalled timer in the warn tone; empty without intake. */
export function intakeChip(info: IntakeInfo | undefined, P: Palette): Line {
  if (!info) return [];
  const bg = { bg: P.head };
  if (info.errors) return [sp(P, "warn", ` intake ✕${info.errors} `, { ...bg, b: true })];
  if (!info.here) return [sp(P, "dim", " intake ↗ ", bg)];
  if (info.timer !== "ok") return [sp(P, "warn", " intake timer? ", { ...bg, b: true })];
  const next = Math.min(...info.rules.flatMap((r) => (r.next === undefined ? [] : [r.next])));
  return [sp(P, "dim", ` ⏲ intake${Number.isFinite(next) ? ` ~${hhmm(next)}` : ""} `, bg)];
}

// Full and short forms: a value is never cut, so narrow terminals get the short one.
function nextText(r: RuleInfo, info: IntakeInfo, now: number, short: boolean) {
  if (!r.enabled) return short ? "off" : "not enabled";
  if (!info.here || r.problem || r.next === undefined) return "-";
  if (info.timer === "ok") return `${r.due ? "due " : ""}~${hhmm(r.next)}`;
  if (short) return r.due ? "due, no timer" : `in ${dur(r.next - now)}?`;
  return r.due ? "due, timer not running" : `in ${dur(r.next - now)} if the timer runs`;
}

const RULE_MIN = 12;

// The repo is cut before the name, but never below the prefix that tells same-named rules apart.
function ruleText(r: RuleInfo, w: number, rules: RuleInfo[]) {
  if (Bun.stringWidth(r.id) <= w) return r.id;
  const short = (x: RuleInfo) => x.repo.slice(x.repo.indexOf("/") + 1);
  const base = rules.some((x) => x.repo !== r.repo && short(x) === short(r)) ? r.repo : short(r);
  const peers = rules.filter((x) => x.name === r.name && x.repo !== r.repo).map((x) => (rules.some((y) => y.repo !== x.repo && short(y) === short(x)) ? x.repo : short(x)));
  let k0 = 1;
  while (k0 < base.length && peers.some((p) => p.slice(0, k0) === base.slice(0, k0))) k0++;
  const room = w - Bun.stringWidth(r.name) - 2;
  if (k0 > Math.max(1, room)) return `…${base.slice(k0 - 1)}:${r.name}`;
  const k = Math.min(base.length, Math.max(k0, room));
  return `${base.slice(0, k)}${k < base.length ? "…" : ""}:${r.name}`;
}

type Col = { head: string; w: number; cell: (r: RuleInfo) => string };

// Fixed columns first; next gets its widest value, the rule what is left.
function columns(info: IntakeInfo, n: number, now: number): Col[] {
  const run = (f: (r: RuleInfo) => string) => (r: RuleInfo) => (info.here && r.enabled && !r.problem ? f(r) : "-");
  const num = (v?: number) => String(v ?? 0);
  const rule: Col = { head: "rule", w: 0, cell: (r) => ruleText(r, rule.w, info.rules) };
  let short = false;
  const next: Col = { head: "next", w: 0, cell: (r) => nextText(r, info, now, short) };
  const err: Col = { head: "✕", w: 1, cell: (r) => (r.error || (r.enabled && r.problem) ? "✕" : "") };
  const filed: Col = { head: n >= 80 ? "open/filed" : "o/f", w: n >= 80 ? 10 : 5, cell: run((r) => `${num((r.open ?? 0) + (r.reopened ?? 0))}/${num(r.filed)}`) };
  const mode: Col = { head: "mode", w: 10, cell: (r) => r.mode ?? "-" };
  const last: Col = n >= 80 ? { head: "last", w: 11, cell: run((r) => (r.ranAt === undefined ? "never" : when(r.ranAt, now))) } : { head: "last", w: 5, cell: run((r) => (r.ranAt === undefined ? "never" : now - r.ranAt < 20 * 3600_000 ? hhmm(r.ranAt) : new Date(r.ranAt).toISOString().slice(5, 10))) };
  const cols =
    n < 50
      ? [rule, next, err]
      : n < 110
        ? [rule, mode, last, next, err, filed]
        : [rule, mode, { head: "every", w: 5, cell: (r: RuleInfo) => r.every ?? "-" }, last, next, err, filed, { head: "reopened", w: 8, cell: run((r) => num(r.reopened)) }, { head: "gone/still", w: 10, cell: run((r) => `${num(r.gone)}/${num(r.still)}`) }];
  const avail = n - 1 - cols.reduce((a, c) => a + c.w + 1, 0);
  const widest = () => Math.max(4, ...info.rules.map((r) => Bun.stringWidth(nextText(r, info, now, short))));
  next.w = widest();
  if (avail - next.w < RULE_MIN) (short = true), (next.w = widest());
  rule.w = Math.max(1, avail - next.w);
  return cols;
}

/** The selected rule's failure, if any: its last run's error, else why an enabled rule could not be read. */
export const ruleError = (info: IntakeInfo | undefined, sel: number) => {
  const r = info?.rules[Math.max(0, Math.min(sel, info.rules.length - 1))];
  return r && (r.error ?? (r.enabled ? r.problem : undefined));
};

/** The selected rule's id while it has an error. */
export const errorOf = (info: IntakeInfo | undefined, sel: number) => (ruleError(info, sel) ? info!.rules[Math.max(0, Math.min(sel, info!.rules.length - 1))]!.id : undefined);

/** The intake view (`i`): globals, the rules (scrolled to keep the selected one in view) and its error below them, or with `detail` the whole error scrolled by that many lines; every line exactly `n` columns. */
export function intakeScreen(info: IntakeInfo | undefined, sel: number, msg: string, now: number, n: number, h: number, P: Palette, detail?: number): { lines: Line[]; maxBack: number } {
  if (h <= 0) return { lines: [], maxBack: 0 };
  const bg = { bg: P.head };
  const mark: Span = P.mono ? { t: " intake ", b: true, r: true } : { t: " intake ", fg: P.ink, bg: P.accent, b: true };
  const bodyH = Math.max(0, h - 2);
  let body: Line[] = [];
  let top: Line = [mark];
  let maxBack = 0;
  let hint = " j/k select  i/esc back  r refresh  ? help  q quit";
  if (!info) body.push([sp(P, "dim", " no intake in tender.json")]);
  else {
    const where = sp(P, "dim", ` ${info.here ? `on ${clean(info.host, 40)} (this host)` : `intake runs on ${clean(info.host, 40)}; run data is there`} `, bg);
    const timer: Line = !info.here ? [] : info.timer === "ok" ? [sp(P, "ok", `timer ok · ${ago(info.beat, now)} `, bg)] : [sp(P, "warn", info.timer === "late" ? `timer late · last ${ago(info.beat, now)} ` : "timer not running ", { ...bg, b: true })];
    const width = (l: Line) => Bun.stringWidth(l.map((x) => x.t).join(""));
    top = width([mark, where, ...timer]) < n ? spread([mark, where], timer, n, bg) : [mark, ...timer.map((x) => ({ ...x, t: ` ${x.t.split(" · ")[0]!.trim()} ` })), where];
    const j = info.judge;
    const pre: Line[] = [
      [sp(P, "dim", " judge "), j ? sp(P, "fg", `${clean(`${j.agent} ${j.model}`, 60)} · ${j.maxPerRun}/run · last ${info.here ? ago(j.last, now) : "-"}`) : sp(P, "dim", "off")],
      [sp(P, "dim", " guardrails "), info.guardrails ? sp(P, "fg", `on · last ${info.here ? ago(info.guardrails.last, now) : "-"}`) : sp(P, "dim", "off")],
      ...(info.problem ? [[sp(P, "bad", ` ${info.problem}`)]] : []),
      [],
    ];
    const cols = columns(info, n, now);
    const cells = (texts: string[], st: Omit<Span, "t">, tone: (i: number) => Parameters<typeof sp>[1]) => [sp(P, "fg", " ", st), ...texts.flatMap((t, i) => [...clip([sp(P, tone(i), clean(t, 300), st)], cols[i]!.w, st), sp(P, "fg", " ", st)])];
    sel = Math.max(0, Math.min(sel, info.rules.length - 1));
    const r = info.rules[sel];
    const why = ruleError(info, sel);
    const full = why ? wrap(clean(`${r!.name}: ${why}`, 400), Math.max(1, n - 2)).map((t) => [sp(P, "warn", ` ${t}`)]) : [];
    if (detail !== undefined && full.length) {
      maxBack = Math.max(0, full.length - bodyH);
      const at = Math.min(detail, maxBack);
      body = full.slice(at, at + bodyH);
      hint = ` j/k scroll ${at + 1}-${Math.min(full.length, at + bodyH)}/${full.length}  ⏎/esc close`;
    } else {
      // The globals give way first, then the rows, to the selected rule's error.
      const fitsWith = (lead: number) => bodyH - lead - 1 - 1 - 1 >= full.length;
      const lead = bodyH >= pre.length + 2 && (!full.length || fitsWith(pre.length)) ? pre : [];
      if (!lead.length && info.problem && !msg) msg = info.problem;
      const room = bodyH - lead.length - 1;
      const shown = full.slice(0, Math.max(0, room - 2));
      if (full.length) hint = " ⏎ full error  j/k select  i/esc back";
      const vis = Math.max(1, room - (shown.length ? shown.length + 1 : 0));
      const start = scroll(sel, info.rules.length, vis);
      const rows = info.rules.slice(start, start + vis).map((x, i) => {
        const st = start + i === sel ? { bg: P.sel, r: P.mono ? true : undefined } : {};
        return cells(cols.map((c) => c.cell(x)), st, (k) => (!x.enabled ? "dim" : cols[k]!.head === "✕" ? "bad" : "fg"));
      });
      body = [...lead, cells(cols.map((c) => c.head), {}, () => "dim"), ...(rows.length ? rows : [[sp(P, "dim", " no rules")]])];
      if (shown.length) body.push(...Array.from({ length: Math.max(1, bodyH - body.length - shown.length) }, () => []), ...shown);
    }
  }
  const footer = msg ? [sp(P, "warn", ` ${clean(msg, 300)} `, { b: true })] : [sp(P, "dim", hint)];
  const lines = [clip(top, n, bg), ...body.slice(0, bodyH).map((l) => clip(l, n))];
  while (lines.length < h - 1) lines.push(clip([], n));
  if (h >= 2) lines.push(clip(footer, n));
  return { lines: lines.slice(0, h), maxBack };
}
