import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS, openDb } from "../src/db";
import { intakeInfo, nextRun, tickAt } from "../src/ui/intake";
import { config, fakeIo, repoFiles, root, setBaseSha, useTempRoot } from "./helpers";

useTempRoot();

const RULES = "intake:\n  - name: errs\n    run: a.sh\n    every: 1h\n    autoLabel: [{ level: error }]\n  - name: deps\n    run: b.sh\n    every: 1d\n    judge: { minWorth: 0.5, minFixable: 0.5 }\n  - name: lint\n    run: c.sh\n";
const NOW = Date.parse("2026-01-01T12:07:00Z");
const MIN = 60_000;
const at = (t: number) => new Date(t).toISOString();

function setup(over: object = {}) {
  repoFiles["config.yaml"] = RULES;
  const { io, cmds, logs } = fakeIo((a) => (a[3] === "symbolic-ref" ? { out: "origin/main\n" } : undefined));
  const cfg = config({ intake: { enabled: ["acme/web:errs", "acme/web:deps"], host: "box" }, ...over });
  return { io, cmds, logs, cfg, info: () => intakeInfo(cfg, io, NOW) };
}
const beat = (t: number) => (writeFileSync(join(root, ".intake.lock"), ""), utimesSync(join(root, ".intake.lock"), t / 1000, t / 1000));
const db = (fn: (d: Database) => void) => {
  const d = openDb(join(root, "tender.db"));
  fn(d);
  d.close();
};

test("nextRun: never ran is due at the next tick; every less the slack, rounded up to a quarter hour", () => {
  expect(nextRun(undefined, "1h", NOW)).toEqual({ at: Date.parse("2026-01-01T12:15:00Z"), due: true });
  expect(nextRun(NOW - 58 * MIN, "1h", NOW)).toEqual({ at: Date.parse("2026-01-01T12:15:00Z"), due: true });
  expect(nextRun(NOW - 57 * MIN, "1h", NOW)).toEqual({ at: Date.parse("2026-01-01T12:15:00Z"), due: false });
  expect(nextRun(NOW - 10 * MIN, "1h", NOW)).toEqual({ at: Date.parse("2026-01-01T13:00:00Z"), due: false });
  expect(tickAt(Date.parse("2026-01-01T12:15:00Z"))).toBe(Date.parse("2026-01-01T12:15:00Z"));
  expect(tickAt(NOW, NOW - 4 * MIN, false)).toBe(NOW + 11 * MIN);
  expect(tickAt(NOW, undefined, false)).toBe(Date.parse("2026-01-01T12:15:00Z"));
});

test("info: rules with mode, last run, error, next, counts; not-enabled rules listed; local git only", async () => {
  const s = setup({ judge: { agent: "claude", model: "opus", maxPerRun: 5 } });
  beat(NOW - 5 * MIN);
  db((d) => {
    d.run("INSERT INTO intake_runs (rule, ran_at, error) VALUES ('acme/web:errs', ?, 'boom\x1b[31m')", [at(NOW - 30 * MIN)]);
    d.run("INSERT INTO intake_seen (rule, key, ticket_url, state) VALUES ('acme/web:errs', 'a', 'u1', 'open'), ('acme/web:errs', 'b', 'u2', 'reopened'), ('acme/web:errs', 'c', NULL, 'filing')");
    d.run("INSERT INTO events (at, host, repo, ticket, kind, data) VALUES (?, 'box', 'acme/web', 'gh-1', 'recheck', '{\"rule\":\"acme/web:errs\",\"state\":\"gone\"}'), (?, 'box', 'acme/web', 'gh-2', 'judge', '{}')", [at(NOW - 60 * MIN), at(NOW - 3 * MIN)]);
  });
  const i = (await s.info())!;
  expect(i).toMatchObject({ host: "box", here: true, timer: "ok", judge: { agent: "claude", model: "opus", maxPerRun: 5, last: NOW - 3 * MIN }, errors: 1 });
  expect(i.guardrails).toBeUndefined();
  expect(i.rules.map((r) => [r.name, r.enabled, r.mode, r.every])).toEqual([["errs", true, "auto", "1h"], ["deps", true, "judge", "1d"], ["lint", false, "shadow", "1h"]]);
  expect(i.rules[0]).toMatchObject({ ranAt: NOW - 30 * MIN, error: "boom", filed: 2, open: 1, reopened: 1, gone: 1, still: 0, due: false, next: Date.parse("2026-01-01T12:45:00Z") });
  expect(i.rules[1]).toMatchObject({ due: true, ranAt: undefined });
  expect(i.rules[2]!.next).toBeUndefined();
  expect(s.cmds.some((c) => c.includes("fetch") || c.startsWith("gh "))).toBe(false);
  expect(s.cmds.some((c) => c.includes("symbolic-ref"))).toBe(true);
});

test("info: judge without a judge in tender.json is judge(off); stale or missing heartbeat; missing db", async () => {
  const s = setup();
  let i = (await s.info())!;
  expect(i.timer).toBe("none");
  expect(i.rules[1]!.mode).toBe("judge(off)");
  expect(i.rules[0]).toMatchObject({ due: true, ranAt: undefined, error: undefined });
  beat(NOW - 21 * MIN);
  i = (await s.info())!;
  expect(i.timer).toBe("late");
});

test("info: a db from before the error column still reads", async () => {
  const s = setup();
  const d = new Database(join(root, "tender.db"), { create: true });
  d.run("CREATE TABLE schema_version (version INTEGER NOT NULL)");
  for (const sql of MIGRATIONS.slice(0, 3)) d.run(sql);
  d.run("INSERT INTO intake_runs VALUES ('acme/web:errs', ?)", [at(NOW - 30 * MIN)]);
  d.close();
  const i = (await s.info())!;
  expect(i.rules[0]).toMatchObject({ ranAt: NOW - 30 * MIN, error: undefined });
  expect(i.errors).toBe(0);
});

test("info: another intake host shows definitions, never the local db", async () => {
  const s = setup({ intake: { enabled: ["acme/web:errs"], host: "other" } });
  beat(NOW);
  db((d) => d.run("INSERT INTO intake_runs (rule, ran_at, error) VALUES ('acme/web:errs', ?, 'x')", [at(NOW)]));
  const i = (await s.info())!;
  expect(i).toMatchObject({ host: "other", here: false, timer: "none", errors: 0 });
  expect(i.rules[0]).toEqual({ id: "acme/web:errs", repo: "acme/web", name: "errs", enabled: true, mode: "auto", every: "1h" });
});

test("info: an invalid config or a missing rule is a problem on the rule; no intake is undefined", async () => {
  const s = setup();
  repoFiles["config.yaml"] = "intake: [nope";
  setBaseSha("b".repeat(40));
  let i = (await s.info())!;
  expect(i.rules.map((r) => r.name)).toEqual(["errs", "deps"]);
  expect(i.rules[0]!.problem).toContain(".tender/ invalid");
  expect(i.errors).toBe(2);
  repoFiles["config.yaml"] = "intake:\n  - name: errs\n    run: a.sh\n";
  setBaseSha("c".repeat(40));
  i = (await s.info())!;
  expect(i.rules[1]!.problem).toBe("no rule deps in .tender/config.yaml");
  expect(await intakeInfo(config(), s.io, NOW)).toBeUndefined();
});
