import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoConfig } from "../config/repo-config";
import { DB_FILE } from "../db";
import { HEARTBEAT, ms, SLACK_MS } from "../intake";
import type { Config, IntakeRule, Io } from "../types";
import { clean, GIT, mtime, read, SYSTEMD } from "../util";
import { clip, type Line, type Palette, s as sp, type Span, spread, when } from "./dash-view";
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

// Local git only: the base is tender.json's or the clone's origin/HEAD, never a fetch or the GitHub API.
async function definitions(cfg: Config, io: Io) {
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

function nextText(r: RuleInfo, info: IntakeInfo, now: number) {
  if (!info.here || !r.enabled || r.problem || r.next === undefined) return "-";
  if (info.timer === "ok") return `${r.due ? "due " : ""}~${hhmm(r.next)}`;
  return r.due ? "due, timer not running" : `in ${dur(r.next - now)} if the timer runs`;
}

type Col = { head: string; w: number; cell: (r: RuleInfo) => string };

function columns(info: IntakeInfo, n: number, now: number): Col[] {
  const run = (f: (r: RuleInfo) => string) => (r: RuleInfo) => (info.here && r.enabled && !r.problem ? f(r) : "-");
  const num = (v?: number) => String(v ?? 0);
  const rule: Col = { head: "rule", w: 0, cell: (r) => r.id };
  const next: Col = { head: "next", w: n >= 110 ? 30 : 22, cell: (r) => (r.enabled ? nextText(r, info, now) : "not enabled") };
  const err: Col = { head: "✕", w: 2, cell: (r) => (r.error || (r.enabled && r.problem) ? "✕" : "") };
  if (n < 50) return [rule, { ...next, w: 12 }, err];
  const cols: Col[] = [
    rule,
    { head: "mode", w: 11, cell: (r) => r.mode ?? "-" },
    ...(n >= 110 ? [{ head: "every", w: 6, cell: (r: RuleInfo) => r.every ?? "-" }] : []),
    { head: "last", w: 12, cell: run((r) => (r.ranAt === undefined ? "never" : when(r.ranAt, now))) },
    next,
    err,
    { head: "open/filed", w: 11, cell: run((r) => `${num((r.open ?? 0) + (r.reopened ?? 0))}/${num(r.filed)}`) },
  ];
  return n >= 110 ? [...cols, { head: "reopened", w: 9, cell: run((r) => num(r.reopened)) }, { head: "gone/still", w: 10, cell: run((r) => `${num(r.gone)}/${num(r.still)}`) }] : cols;
}

/** The intake view (`i`): globals, one row per rule, and the selected rule's error in the footer; every line exactly `n` columns. */
export function intakeScreen(info: IntakeInfo | undefined, sel: number, msg: string, now: number, n: number, h: number, P: Palette): Line[] {
  if (h <= 0) return [];
  const bg = { bg: P.head };
  const mark: Span = P.mono ? { t: " intake ", b: true, r: true } : { t: " intake ", fg: P.ink, bg: P.accent, b: true };
  const body: Line[] = [];
  let top: Line = [mark];
  if (!info) body.push([sp(P, "dim", " no intake in tender.json")]);
  else {
    const where = info.here ? `on ${clean(info.host, 40)} (this host)` : `intake runs on ${clean(info.host, 40)}; run data is there`;
    const timer: Line = !info.here ? [] : info.timer === "ok" ? [sp(P, "ok", `timer ok · ${ago(info.beat, now)} `, bg)] : [sp(P, "warn", info.timer === "late" ? `timer late · last ${ago(info.beat, now)} ` : "timer not running ", { ...bg, b: true })];
    top = spread([mark, sp(P, "dim", ` ${where} `, bg)], timer, n, bg);
    const j = info.judge;
    body.push([sp(P, "dim", " judge "), j ? sp(P, "fg", `${clean(`${j.agent} ${j.model}`, 60)} · ${j.maxPerRun}/run · last ${info.here ? ago(j.last, now) : "-"}`) : sp(P, "dim", "off")]);
    body.push([sp(P, "dim", " guardrails "), info.guardrails ? sp(P, "fg", `on · last ${info.here ? ago(info.guardrails.last, now) : "-"}`) : sp(P, "dim", "off")]);
    if (info.problem) body.push([sp(P, "bad", ` ${info.problem}`)]);
    body.push([]);
    const cols = columns(info, n, now);
    const fixed = cols.reduce((a, c) => a + c.w + 1, 1);
    const ruleW = Math.max(8, n - fixed);
    const cells = (texts: string[], st: Omit<Span, "t">, tone: (i: number) => Parameters<typeof sp>[1]) => [sp(P, "fg", " ", st), ...texts.flatMap((t, i) => [...clip([sp(P, tone(i), clean(t, 300), st)], i ? cols[i]!.w : ruleW, st), sp(P, "fg", " ", st)])];
    body.push(cells(cols.map((c) => c.head), {}, () => "dim"));
    info.rules.forEach((r, i) => {
      const st = i === sel ? { bg: P.sel, r: P.mono ? true : undefined } : {};
      const off = !r.enabled;
      body.push(cells(cols.map((c) => c.cell(r)), st, (k) => (off ? "dim" : cols[k]!.head === "✕" ? "bad" : "fg")));
    });
    if (!info.rules.length) body.push([sp(P, "dim", " no rules")]);
    const r = info.rules[sel];
    const why = r && (r.error ?? (r.enabled ? r.problem : undefined));
    if (why && !msg) msg = `${r.name}: ${why}`;
  }
  const footer = msg ? [sp(P, "warn", ` ${clean(msg, 300)} `, { b: true })] : [sp(P, "dim", " j/k select  i/esc back  r refresh  ? help  q quit")];
  const lines = [clip(top, n, bg), ...body.slice(0, Math.max(0, h - 2)).map((l) => clip(l, n))];
  while (lines.length < h - 1) lines.push(clip([], n));
  if (h >= 2) lines.push(clip(footer, n));
  return lines.slice(0, h);
}
