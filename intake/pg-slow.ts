#!/usr/bin/env -S bun --no-env-file
// tender intake example: one ticket per query that got slow since the last run, from pg_stat_statements. Needs PG_INTAKE_URL, the database host in `network`, and `loopback: true`.
// Copy with pg.ts to .tender/intake/ (this file executable) and add a rule with `labels: [supabase]`; `private: true` is required, as tickets show query shapes. See docs/intake.md.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { open as openPg, withDb, type Open, type Query } from "./pg";

/** Cumulative counters per queryid: `[calls, total exec ms]`. */
export interface Snapshot {
  at: string;
  reset: string | null;
  /** The `--user` list the counters were summed over. */
  users?: string[];
  q: Record<string, [number, number]>;
}
export interface Slow {
  queryid: string;
  calls: number;
  totalMs: number;
  meanMs: number;
}

// Only plain DML: utility statements (SET, ALTER ROLE … PASSWORD) are not query shapes to fix, and older servers keep their literals.
const DML = /^(?:\s+|\/\*[\s\S]*?\*\/|--[^\n]*\n)*(select|insert|update|delete|with|merge|values|table)\b/i;

const comparable = (prev: Snapshot, now: Snapshot) => prev.reset === now.reset && String(prev.users) === String(now.users);

/** Queries over both thresholds in the window `prev`..`now`; none across a stats reset or a changed `--user` list, and a query whose counters went down starts over. */
// shortcut: an entry evicted and re-created with more calls than before reads as one window of inflated delta; use PG17's per-entry stats_since if that bites.
export function slow(prev: Snapshot, now: Snapshot, min: { calls: number; meanMs: number }): Slow[] {
  if (!comparable(prev, now)) return [];
  const out: Slow[] = [];
  for (const [queryid, [calls, total]] of Object.entries(now.q)) {
    const [pc, pt] = prev.q[queryid] ?? [0, 0];
    const [dc, dt] = [calls - pc, total - pt];
    if (dc <= 0 || dt < 0 || dc < min.calls || dt / dc < min.meanMs) continue;
    out.push({ queryid, calls: dc, totalMs: Math.round(dt), meanMs: Math.round((dt / dc) * 10) / 10 });
  }
  return out.sort((a, b) => b.totalMs - a.totalMs);
}

async function stats(q: Query, users: string[]) {
  const [ext] = await q("select n.nspname as schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_stat_statements'", []);
  if (!ext) throw new Error("pg_stat_statements is not installed in this database");
  const schema = `"${String(ext.schema).replace(/"/g, '""')}"`;
  const [info] = await q(`select stats_reset::text as reset from ${schema}.pg_stat_statements_info`, []);
  const rows = await q(
    `select s.queryid::text as queryid, min(left(s.query, 4000)) as query, sum(s.calls)::float8 as calls, sum(s.total_exec_time)::float8 as total
     from ${schema}.pg_stat_statements s join pg_database d on d.oid = s.dbid join pg_roles r on r.oid = s.userid
     where d.datname = current_database() and (cardinality($1::text[]) = 0 or r.rolname = any($1::text[]))
     group by s.queryid`,
    [users],
  );
  // Without pg_read_all_stats, other roles' rows come back with a null queryid and `<insufficient privilege>` as text.
  if (rows.some((r) => r.queryid === null)) throw new Error(`cannot read other roles' queries in pg_stat_statements: grant pg_read_all_stats to this role, or pass --user for the roles it may read`);
  const dml = rows.filter((r) => DML.test(r.query));
  const snap: Snapshot = { at: new Date().toISOString(), reset: info?.reset ?? null, users, q: Object.fromEntries(dml.map((r) => [r.queryid, [r.calls, r.total]])) };
  return { snap, text: Object.fromEntries(dml.map((r) => [r.queryid, r.query as string])) };
}

function line(s: Slow, query: string, prev: Snapshot, now: Snapshot) {
  const fence = query.includes("```") ? "~~~" : "```";
  const body = [
    `Between ${prev.at} and ${now.at}: ${s.calls} calls, mean ${s.meanMs} ms, total ${s.totalMs} ms (pg_stat_statements queryid ${s.queryid}).`,
    `${fence}sql\n${query}\n${fence}`,
    "pg_stat_statements normalizes the text: constants are $1, $2… placeholders.",
    "Proof in the PR: run EXPLAIN (ANALYZE, BUFFERS) on this query against the local database, with representative values for the placeholders, before and after the change, and include both plans.",
  ];
  const first = query.replace(/\s+/g, " ").trim().slice(0, 80);
  return JSON.stringify({ key: `pg-slow:${s.queryid}`, title: `Slow query, ${s.meanMs} ms mean: ${first}`, body: body.join("\n\n"), facts: { calls: s.calls, meanMs: s.meanMs, totalMs: s.totalMs } });
}

const load = (file: string): Snapshot | undefined => {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return s && typeof s.at === "string" && s.q && typeof s.q === "object" ? s : undefined;
  } catch {}
};

/** stdout for `argv`: the slow queries since the snapshot in TENDER_STATE (which it then replaces; the first run only stores it), or the `--recheck` verdict. */
export async function main(argv: string[], env = process.env, open: Open = openPg) {
  const { values: a } = parseArgs({
    args: argv,
    options: { "min-mean-ms": { type: "string", default: "100" }, "min-calls": { type: "string", default: "50" }, user: { type: "string", multiple: true, default: [] }, ca: { type: "string" }, recheck: { type: "string" } },
  });
  const num = (k: "min-mean-ms" | "min-calls") => {
    const n = Number(a[k]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${k}: non-negative number`);
    return n;
  };
  const min = { meanMs: num("min-mean-ms"), calls: num("min-calls") };
  const file = env.TENDER_STATE;
  if (!file) throw new Error("TENDER_STATE is not set");
  const prev = load(file);
  if (a.recheck !== undefined) {
    const id = /^pg-slow:(-?\d+)$/.exec(a.recheck)?.[1];
    const done = Date.parse(env.TENDER_DONE_AT ?? "");
    if (!id || !Number.isFinite(done)) throw new Error("--recheck pg-slow:<queryid> needs TENDER_DONE_AT");
    // The window must start after the merge; the next collect moves it there, so failing now retries then.
    if (!prev || Date.parse(prev.at) < done) throw new Error(`no snapshot since ${env.TENDER_DONE_AT} yet; retried after the next collect`);
    const now = await withDb(open, a.ca, (q) => stats(q, a.user));
    if (!comparable(prev, now.snap)) throw new Error("pg_stat_statements was reset or --user changed since the last snapshot; retried after the next collect");
    const [pc, pt] = prev.q[id] ?? [0, 0];
    // Gone from both snapshots means no calls since the last collect; gone only from now means evicted or filtered, so undecided.
    if (prev.q[id] && !now.snap.q[id]) throw new Error(`queryid ${id} left pg_stat_statements since the last snapshot; retried after the next collect`);
    const [c, t] = now.snap.q[id] ?? [0, 0];
    if (c < pc || t < pt) throw new Error(`queryid ${id} restarted its counters; retried after the next collect`);
    const [dc, dt] = [c - pc, t - pt];
    if (dc > 0 && dc < min.calls && dt / dc >= min.meanMs) throw new Error(`queryid ${id} ran ${dc} times since the last snapshot, still slow but under --min-calls; retried after the next collect`);
    const mean = dc ? Math.round((dt / dc) * 10) / 10 : 0;
    const window = `between ${prev.at} and ${now.snap.at}`;
    if (dc > 0 && dc >= min.calls && dt / dc >= min.meanMs) return JSON.stringify({ state: "still", detail: `${dc} calls ${window}, mean ${mean} ms.` });
    return JSON.stringify({ state: "gone", detail: `${dc} calls ${window}${dc ? `, mean ${mean} ms` : ""}: under the thresholds.` });
  }
  const now = await withDb(open, a.ca, (q) => stats(q, a.user));
  writeFileSync(file, JSON.stringify(now.snap));
  if (!prev) return "";
  return slow(prev, now.snap, min)
    .slice(0, 100)
    .map((s) => line(s, now.text[s.queryid]!, prev, now.snap))
    .join("\n");
}

if (import.meta.main) console.log(await main(process.argv.slice(2)));
