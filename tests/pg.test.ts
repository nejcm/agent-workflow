import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lintKey, main as lintMain, type Lint } from "../intake/pg-lint";
import { main as slowMain, slow, type Snapshot } from "../intake/pg-slow";
import { sqlOptions, type Open } from "../intake/pg";
import { SQL } from "bun";
import { autoLabels, parseCollect, parseRecheck } from "../src/intake";
import { root, useTempRoot } from "./helpers";

useTempRoot();

const fakeDb = (answer: (text: string, params?: unknown[]) => any[]) => {
  const seen: { text: string; params?: unknown[]; ca?: string }[] = [];
  let closed = 0;
  const open: Open = async (ca) => ({ q: async (text, params) => (seen.push({ text, params, ca }), answer(text, params)), close: async () => void closed++ });
  return { open, seen, closed: () => closed };
};

const lint = (name: string, level: string, categories: string[], key = `${name}_public_t`): Lint => ({
  name, title: `Title ${name}`, level, facing: "EXTERNAL", categories, description: "Why it matters.", detail: "Table \\`public.t\\` has a problem.", remediation: `https://supabase.com/docs/guides/database/database-linter?lint=${name}`, metadata: { schema: "public", name: "t" }, cache_key: key,
});

test("pg-lint: runs splinter in a read-only transaction, most severe first, min level, facts and body", async () => {
  const rows = [lint("unindexed_foreign_keys", "INFO", ["PERFORMANCE"]), lint("rls_disabled_in_public", "ERROR", ["SECURITY"]), lint("auth_rls_initplan", "WARN", ["PERFORMANCE"]), lint("auth_rls_initplan", "WARN", ["PERFORMANCE"])];
  const db = fakeDb(() => [[], [], [], rows, []]);
  const found = parseCollect(await lintMain(["--ca", "ca.pem"], db.open));
  expect(found.map((f) => f.facts)).toEqual([
    { name: "rls_disabled_in_public", level: "ERROR", categories: "SECURITY" },
    { name: "auth_rls_initplan", level: "WARN", categories: "PERFORMANCE,SECURITY" },
    { name: "unindexed_foreign_keys", level: "INFO", categories: "PERFORMANCE" },
  ]);
  expect(autoLabels([{ categories: "PERFORMANCE" }], found[1]!.facts)).toBe(false);
  expect(autoLabels([{ categories: "PERFORMANCE" }], found[2]!.facts)).toBe(true);
  expect(JSON.parse(await lintMain([], fakeDb(() => [[], [], [], [lint("multiple_permissive_policies", "WARN", ["PERFORMANCE"])], []]).open)).facts.categories).toBe("PERFORMANCE,SECURITY");
  expect(found[1]!.key).toMatch(/^pg-lint:auth-rls-initplan:[0-9a-f]{16}$/);
  expect(found[1]!.title).toBe("Title auth_rls_initplan: Table `public.t` has a problem.");
  for (const s of ["**Title auth_rls_initplan** (WARN, PERFORMANCE, EXTERNAL)", "Remediation: https://supabase.com/docs/guides/database/database-linter?lint=auth_rls_initplan", 'Object: `{"schema":"public","name":"t"}`', "Splinter cache_key: `auth_rls_initplan_public_t`", "run splinter.sql against the local database"])
    expect(found[1]!.body).toContain(s);
  const [{ text, params, ca }] = db.seen as [any];
  expect([params, ca]).toEqual([undefined, "ca.pem"]);
  expect(text).toStartWith("begin transaction read only;\n-- Vendored from https://github.com/supabase/splinter/blob/");
  expect(text).toContain("set local search_path = '';");
  expect(text).toEndWith(";\nrollback;");
  expect(db.closed()).toBe(1);
  expect(parseCollect(await lintMain(["--min-level", "WARN"], db.open)).map((f) => f.facts.level)).toEqual(["ERROR", "WARN"]);
  await expect(lintMain(["--min-level", "LOUD"], db.open)).rejects.toThrow("--min-level: one of INFO, WARN, ERROR");
});

test("pg-lint: recheck is still while splinter reports the same cache_key, at any level", async () => {
  const l = lint("unused_index", "INFO", ["PERFORMANCE"]);
  let rows = [l];
  const db = fakeDb(() => [[], [], [], rows, []]);
  expect(parseRecheck(await lintMain(["--min-level", "ERROR", "--recheck", lintKey(l)], db.open))).toEqual({ state: "still", detail: "The lint still reports: Table `public.t` has a problem." });
  rows = [lint("unused_index", "INFO", ["PERFORMANCE"], "unused_index_public_other")];
  expect((parseRecheck(await lintMain(["--recheck", lintKey(l)], db.open))).state).toBe("gone");
});

test("pg-lint: the vendored splinter.sql names its pinned upstream commit and keeps its license", () => {
  const sql = readFileSync(join(import.meta.dir, "../intake/splinter.sql"), "utf8");
  expect(sql.split("\n")[0]).toMatch(/^-- Vendored from https:\/\/github\.com\/supabase\/splinter\/blob\/[0-9a-f]{40}\/splinter\.sql/);
  expect(sql).toContain("-- Copyright (c) 2024, Supabase");
  expect(sql).toContain("'SECURITY'");
});

const snap = (at: string, q: Snapshot["q"], reset: string | null = "r0"): Snapshot => ({ at, reset, users: [], q });
const MIN = { calls: 10, meanMs: 50 };

test("pg-slow: the delta over both thresholds, by total time; none across a reset; a query whose counters fell starts over", () => {
  const prev = snap("t0", { a: [100, 1000], b: [10, 100], c: [500, 99999], d: [0, 0] });
  const now = snap("t1", { a: [120, 3000], b: [30, 500], c: [100, 9000], d: [5, 5000], e: [20, 4000], f: [100, 1000] });
  expect(slow(prev, now, MIN)).toEqual([
    { queryid: "e", calls: 20, totalMs: 4000, meanMs: 200 },
    { queryid: "a", calls: 20, totalMs: 2000, meanMs: 100 },
  ]);
  expect(slow(prev, { ...now, reset: "r1" }, MIN)).toEqual([]);
  expect(slow(prev, { ...now, users: ["app"] }, MIN)).toEqual([]);
  expect(slow({ ...prev, users: undefined }, now, MIN)).toEqual([]);
});

const STATE = () => join(root, "slow.state");
function slowDb(reset: () => string, rows: () => { queryid: string | null; query: string; calls: number; total: number }[]) {
  return fakeDb((text) => (text.includes("pg_extension") ? [{ schema: 'ext"s' }] : text.includes("pg_stat_statements_info") ? [{ reset: reset() }] : rows()));
}

test("pg-slow: first run stores the baseline only; later runs file the delta and move it; non-DML and other roles' rows are left out", async () => {
  let rows = [
    { queryid: "-42", query: "/* app */ select * from t where id = $1", calls: 100, total: 1000 },
    { queryid: "7", query: "SET search_path = $1", calls: 100, total: 1000 },
  ];
  const db = slowDb(() => "r0", () => rows);
  const env = { TENDER_STATE: STATE() };
  const users = ["--user", "app", "--user", "web"];
  writeFileSync(STATE(), "");
  expect(await slowMain(users, env, db.open)).toBe("");
  const base = JSON.parse(readFileSync(STATE(), "utf8"));
  expect([base.reset, base.q]).toEqual(["r0", { "-42": [100, 1000] }]);
  expect(db.seen[1]!.text).toContain('from "ext""s".pg_stat_statements_info');
  expect(db.seen[2]!.params).toEqual([["app", "web"]]);
  rows = [{ ...rows[0]!, calls: 160, total: 13000 }, { ...rows[1]!, calls: 900, total: 900000 }];
  const [f, ...rest] = parseCollect(await slowMain(["--min-calls", "50", "--min-mean-ms", "100", ...users], env, db.open));
  expect(rest).toEqual([]);
  expect(f!.key).toBe("pg-slow:-42");
  expect(f!.facts).toEqual({ calls: 60, meanMs: 200, totalMs: 12000 });
  expect(f!.title).toBe("Slow query, 200 ms mean: /* app */ select * from t where id = $1");
  for (const s of ["60 calls, mean 200 ms, total 12000 ms (pg_stat_statements queryid -42)", "```sql\n/* app */ select * from t where id = $1\n```", "constants are $1, $2… placeholders", "EXPLAIN (ANALYZE, BUFFERS)", "before and after"]) expect(f!.body).toContain(s);
  expect(db.seen.at(-1)!.params).toEqual([["app", "web"]]);
  expect(JSON.parse(readFileSync(STATE(), "utf8")).q).toEqual({ "-42": [160, 13000] });
  expect(await slowMain(users, env, db.open)).toBe("");
  expect(db.closed()).toBe(3);
});

test("pg-slow: rows hidden for lack of pg_read_all_stats fail the run, naming the grant", async () => {
  const db = slowDb(() => "r0", () => [{ queryid: null, query: "<insufficient privilege>", calls: 5, total: 5 }]);
  writeFileSync(STATE(), "");
  await expect(slowMain([], { TENDER_STATE: STATE() }, db.open)).rejects.toThrow("grant pg_read_all_stats");
  expect(readFileSync(STATE(), "utf8")).toBe("");
});

test("pg-slow: a changed --user list files nothing and only stores the new baseline", async () => {
  let calls = 100;
  const db = slowDb(() => "r0", () => [{ queryid: "1", query: "select 1", calls, total: calls * 1000 }]);
  const env = { TENDER_STATE: STATE() };
  writeFileSync(STATE(), "");
  await slowMain([], env, db.open);
  calls = 200;
  expect(await slowMain(["--user", "app"], env, db.open)).toBe("");
  expect(JSON.parse(readFileSync(STATE(), "utf8")).users).toEqual(["app"]);
  calls = 300;
  expect(parseCollect(await slowMain(["--user", "app"], env, db.open))).toHaveLength(1);
});

test("pg-slow: a stats reset or an unreadable state files nothing and only stores the new baseline", async () => {
  let reset = "r0";
  let calls = 100;
  const db = slowDb(() => reset, () => [{ queryid: "1", query: "select 1", calls, total: calls * 1000 }]);
  const env = { TENDER_STATE: STATE() };
  writeFileSync(STATE(), "{not json");
  expect(await slowMain([], env, db.open)).toBe("");
  [reset, calls] = ["r1", 200];
  expect(await slowMain([], env, db.open)).toBe("");
  expect(JSON.parse(readFileSync(STATE(), "utf8"))).toMatchObject({ reset: "r1", q: { "1": [200, 200000] } });
  calls = 300;
  expect(parseCollect(await slowMain([], env, db.open))).toHaveLength(1);
});

test("pg-slow: recheck judges only the window since a snapshot taken after the merge, and fails rather than guess", async () => {
  let row = { queryid: "9", query: "select 9", calls: 200, total: 20000 };
  const db = slowDb(() => "r0", () => [row]);
  const env = (doneAt: string) => ({ TENDER_STATE: STATE(), TENDER_DONE_AT: doneAt });
  const recheck = async (doneAt = "2026-01-01T00:00:00Z") => parseRecheck(await slowMain(["--recheck", "pg-slow:9"], env(doneAt), db.open));
  writeFileSync(STATE(), JSON.stringify(snap("2026-01-02T00:00:00Z", { "9": [100, 1000] })));
  const r = await recheck();
  expect(r.state).toBe("still");
  expect(r.detail).toMatch(/^100 calls between 2026-01-02T00:00:00Z and .+, mean 190 ms\.$/);
  expect(JSON.parse(readFileSync(STATE(), "utf8")).q).toEqual({ "9": [100, 1000] });
  row = { ...row, calls: 200, total: 2000 };
  expect(await recheck()).toMatchObject({ state: "gone" });
  row = { ...row, calls: 120, total: 11000 };
  await expect(recheck()).rejects.toThrow("queryid 9 ran 20 times since the last snapshot, still slow but under --min-calls");
  row = { ...row, calls: 120, total: 1200 };
  expect(await recheck()).toMatchObject({ state: "gone" });
  row = { ...row, calls: 100, total: 1000 };
  expect((await recheck()).detail).toMatch(/^0 calls between .+: under the thresholds\.$/);
  await expect(recheck("2026-01-03T00:00:00Z")).rejects.toThrow("no snapshot since 2026-01-03T00:00:00Z yet");
  row = { ...row, calls: 5, total: 50 };
  await expect(recheck()).rejects.toThrow("queryid 9 restarted its counters");
  row = { ...row, queryid: "10" };
  await expect(recheck()).rejects.toThrow("queryid 9 left pg_stat_statements since the last snapshot");
  writeFileSync(STATE(), JSON.stringify(snap("2026-01-02T00:00:00Z", { "10": [1, 1] })));
  expect((await recheck()).detail).toMatch(/^0 calls between .+: under the thresholds\.$/);
  writeFileSync(STATE(), JSON.stringify(snap("2026-01-02T00:00:00Z", {}, "old")));
  await expect(recheck()).rejects.toThrow("pg_stat_statements was reset or --user changed");
  writeFileSync(STATE(), JSON.stringify({ ...snap("2026-01-02T00:00:00Z", {}), users: ["app"] }));
  await expect(recheck()).rejects.toThrow("pg_stat_statements was reset or --user changed");
  await expect(slowMain(["--recheck", "pg-slow:9"], { TENDER_STATE: STATE() }, db.open)).rejects.toThrow("needs TENDER_DONE_AT");
  await expect(slowMain(["--recheck", "other:9"], env("2026-01-01T00:00:00Z"), db.open)).rejects.toThrow("needs TENDER_DONE_AT");
});

test("pg: TLS is required with or without the tunnel, verified only with a CA, and the tunnel keeps the real host as the TLS name", () => {
  const url = "postgres://u:p@db.example.com:6543/postgres";
  const mode = (o: object) => (new SQL(o as any).options as any).sslMode;
  const direct = sqlOptions(url);
  expect(direct.tls).toEqual({ serverName: "db.example.com" });
  expect([direct.hostname, direct.port]).toEqual([undefined, undefined]);
  const tunneled = sqlOptions(url, "ca.pem", 40001);
  expect([tunneled.hostname, tunneled.port, tunneled.tls.serverName, tunneled.tls.ca?.name]).toEqual(["127.0.0.1", 40001, "db.example.com", "ca.pem"]);
  expect(mode(direct)).toBe(mode({ url, tls: "require" }));
  expect(mode(tunneled)).toBe(mode({ url, tls: "verify-full" }));
  expect(mode({ url })).toBe(mode({ url, tls: "disable" }));
});

test("pg scripts: run as executables, they fail without their secret or state", async () => {
  for (const [script, env] of [["pg-lint.ts", {}], ["pg-slow.ts", { TENDER_STATE: STATE() }]] as const) {
    writeFileSync(STATE(), "");
    const p = Bun.spawn([join(import.meta.dir, "../intake", script)], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect([code, out]).toEqual([1, ""]);
    expect(err).toContain("PG_INTAKE_URL is not set");
  }
});
