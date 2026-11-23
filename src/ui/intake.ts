import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoConfig } from "../config/repo-config";
import { DB_FILE } from "../db";
import { HEARTBEAT, ms, SLACK_MS } from "../intake";
import type { Config, IntakeRule, Io } from "../types";
import { clean, GIT, mtime, read, SYSTEMD } from "../util";

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
