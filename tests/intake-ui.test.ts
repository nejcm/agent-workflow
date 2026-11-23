import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { utimesSync, writeFileSync } from "node:fs";
import { holdLock } from "../tender";
import { join } from "node:path";
import { MIGRATIONS, openDb } from "../src/db";
import { header, type Line, palette } from "../src/ui/dash-view";
import { type IntakeInfo, intakeChip, intakeInfo, intakeScreen, nextRun, tickAt } from "../src/ui/intake";
import { config, fakeIo, repoFiles, root, setBaseSha, useTempRoot } from "./helpers";

useTempRoot();

const RULES = "intake:\n  - name: errs\n    run: a.sh\n    every: 1h\n    autoLabel: [{ level: error }]\n  - name: deps\n    run: b.sh\n    every: 1d\n    judge: { minWorth: 0.5, minFixable: 0.5 }\n  - name: lint\n    run: c.sh\n";
const NOW = Date.parse("2026-01-01T12:07:00Z");
const MIN = 60_000;
const at = (t: number) => new Date(t).toISOString();
const hm = (t: number) => new Date(t).toTimeString().slice(0, 5);

function setup(over: object = {}) {
  repoFiles["config.yaml"] = RULES;
  const { io, cmds, logs } = fakeIo((a) => (a[3] === "symbolic-ref" ? { out: "origin/main\n" } : undefined));
  const cfg = config({ intake: { enabled: ["acme/web:errs", "acme/web:deps"], host: "box" }, ...over });
  return { io, cmds, logs, cfg, info: () => intakeInfo(cfg, io, NOW) };
}
const beat = (t: number) => (writeFileSync(join(root, ".intake.beat"), ""), utimesSync(join(root, ".intake.beat"), t / 1000, t / 1000));
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
  expect(i.rules[0]).toMatchObject({ ranAt: NOW - 30 * MIN, error: "boom", filed: 2, open: 1, reopened: 1, gone: 1, still: 0, due: false, next: tickAt(NOW + 28 * MIN, NOW - 5 * MIN) });
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

const scr = (...a: Parameters<typeof intakeScreen>) => intakeScreen(...a).lines;
const C = palette({});
const M = palette({ NO_COLOR: "1" });
const text = (l: Line) => l.map((x) => x.t).join("");
const INFO: IntakeInfo = {
  host: "box",
  here: true,
  timer: "ok",
  beat: NOW - 5 * MIN,
  judge: { agent: "claude", model: "opus", maxPerRun: 5, last: NOW - 3 * MIN },
  rules: [
    { id: "acme/web:errs", repo: "acme/web", name: "errs", enabled: true, every: "1h", mode: "auto", ranAt: NOW - 30 * MIN, error: "errs.sh exited 1: boom", next: NOW + 38 * MIN, due: false, filed: 3, open: 1, reopened: 1, gone: 1, still: 0 },
    { id: "acme/web:deps", repo: "acme/web", name: "deps", enabled: true, every: "1d", mode: "judge(off)", next: NOW + 8 * MIN, due: true },
    { id: "acme/web:lint", repo: "acme/web", name: "lint", enabled: false, every: "1h", mode: "shadow" },
  ],
  errors: 1,
};

test("view: every line is exactly n columns at any width, colour or not, and the selected rule's error is shown", () => {
  for (const P of [C, M])
    for (const n of [120, 80, 40, 20])
      for (const info of [INFO, { ...INFO, here: false, errors: 0 }, { ...INFO, timer: "late" as const }, undefined]) {
        const ls = scr(info, 0, "", NOW, n, 14, P);
        expect(ls).toHaveLength(14);
        for (const l of ls) expect(Bun.stringWidth(text(l))).toBe(n);
      }
  const wide = scr(INFO, 0, "", NOW, 120, 14, C).map(text);
  expect(wide[0]).toContain("on box (this host)");
  expect(wide[0]).toContain("timer ok");
  expect(wide.join("\n")).toContain("gone/still");
  expect(wide.slice(1, -1).join("\n")).toContain("errs: errs.sh exited 1: boom");
  expect(wide.find((l) => l.includes("acme/web:lint"))).toContain("not enabled");
  expect(wide.find((l) => l.includes("acme/web:deps"))).toContain(`due ~${hm(NOW + 8 * MIN)}`);
  expect(scr(INFO, 0, "", NOW, 120, 14, C).flat().some((x) => x.t.trim() === "✕" && x.fg === C.bad)).toBe(true);
  const narrow = scr(INFO, 0, "", NOW, 40, 14, C).map(text).join("\n");
  expect(narrow).not.toContain("mode");
  expect(scr(INFO, 1, "", NOW, 80, 14, C).map(text).at(-1)).toContain("i/esc back");
  expect(scr(INFO, 0, "", NOW, 120, 14, M).flat().some((x) => x.fg || x.bg)).toBe(false);
  const late = scr({ ...INFO, timer: "none" }, 0, "", NOW, 120, 14, C).map(text).join("\n");
  expect(late).toContain("timer not running");
  expect(late).toContain("due, timer not running");
  expect(late).toContain("in 38m if the timer runs");
  expect(scr({ ...INFO, here: false }, 0, "", NOW, 120, 14, C).map(text)[0]).toContain("intake runs on box");
});

test("chip: next run, errors or a stalled timer in warn; dropped before the clock on a narrow header", () => {
  const ok = { ...INFO, errors: 0, rules: INFO.rules.map((r) => ({ ...r, error: undefined })) };
  expect(text(intakeChip(ok, C))).toBe(` ⏲ intake ~${hm(NOW + 8 * MIN)} `);
  expect(intakeChip(INFO, C)[0]).toMatchObject({ t: " intake ✕1 ", fg: C.warn });
  expect(text(intakeChip({ ...ok, timer: "late" }, C))).toBe(" intake timer? ");
  expect(intakeChip(undefined, C)).toEqual([]);
  for (const n of [160, 60, 30]) {
    const top = text(header([], "box", "12:00:00", 2, n, C, undefined, intakeChip(ok, C)));
    expect(Bun.stringWidth(top)).toBe(n);
    expect(top.includes("intake")).toBe(n === 160);
  }
});

test("review: a named-rule run's .intake.lock is no heartbeat; render-path git never lazy-fetches", async () => {
  const s = setup();
  expect(holdLock(join(root, ".intake.lock"))).toBe(true);
  const envs: (Record<string, string> | undefined)[] = [];
  const run = s.io.run;
  s.io.run = (argv, cwd, secs, o) => (argv[0] === "git" && envs.push(o?.env), run(argv, cwd, secs, o));
  expect((await s.info())!.timer).toBe("none");
  expect(envs.length).toBeGreaterThan(1);
  for (const e of envs) expect([e?.GIT_NO_LAZY_FETCH, e?.GIT_ALLOW_PROTOCOL]).toEqual(["1", ""]);
  expect(envs[0]?.PATH).toBe(process.env.PATH!);
});

test("review: no column or timer state falls off at 50 and 40 columns", () => {
  for (const n of [50, 40]) {
    const ls = scr({ ...INFO, timer: "late" }, 0, "", NOW, n, 20, C).map(text);
    expect(ls[0]).toContain("timer late");
    const head = ls.find((l) => l.includes("rule"))!;
    expect(head).toContain("✕");
    if (n === 50) expect(head).toContain("o/f");
    expect(ls[ls.indexOf(head) + 1]).toContain("✕");
    expect(ls[ls.indexOf(head) + 1]).toContain(":errs");
    for (const l of ls) expect(Bun.stringWidth(l)).toBe(n);
  }
});

test("review: the selected rule stays in view and its full 300-char error is readable", () => {
  const rules = Array.from({ length: 22 }, (_, i) => ({ ...INFO.rules[1]!, id: `acme/web:r${i}`, name: `r${i}` }));
  const err = Array.from({ length: 60 }, (_, i) => `w${i}x`).join(" ").slice(0, 300);
  rules[21] = { ...rules[21]!, error: err };
  const ls = scr({ ...INFO, rules }, 21, "", NOW, 120, 16, C);
  const row = ls.find((l) => text(l).includes("acme/web:r21"));
  expect(row?.some((x) => x.bg === C.sel)).toBe(true);
  expect(ls.map(text).join(" ").replace(/\s+/g, " ")).toContain(`r21: ${err}`);
  const top = scr({ ...INFO, rules }, 0, "", NOW, 120, 16, C).map(text);
  expect(top.some((l) => l.includes("acme/web:r0"))).toBe(true);
  for (const l of ls) expect(Bun.stringWidth(text(l))).toBe(120);
});

test("review 2: next values and the timer state are never cut; the repo shrinks before the rule name", () => {
  for (const [n, timer, want] of [[50, "ok", `due ~${hm(NOW + 8 * MIN)}`], [50, "none", "in 38m?"], [40, "none", "due, no timer"], [80, "none", "in 38m if the timer runs"], [120, "late", "due, timer not running"]] as const) {
    const ls = scr({ ...INFO, timer }, 0, "", NOW, n, 20, C).map(text);
    expect(ls.join("\n")).toContain(want);
    expect(ls.join("\n")).not.toMatch(/(due|in) [^ ]*…/);
    expect(ls.some((l) => l.includes(":errs") && l.includes(":deps"))).toBe(false);
    expect(ls.filter((l) => /:(errs|deps|lint) /.test(l))).toHaveLength(3);
  }
});

test("review 2: the full error is reachable by scrolling its detail at 40x14 and 40x7; a lost db problem goes to the footer", () => {
  const err = Array.from({ length: 60 }, (_, i) => `w${i}x`).join(" ").slice(0, 300);
  const info = { ...INFO, rules: [{ ...INFO.rules[0]!, error: err }] };
  for (const h of [14, 7]) {
    expect(scr(info, 0, "", NOW, 40, h, C).map(text).at(-1)).toContain("⏎ full error");
    const { maxBack } = intakeScreen(info, 0, "", NOW, 40, h, C, 0);
    const rows: string[] = [];
    for (let d = 0; d <= maxBack; d++) scr(info, 0, "", NOW, 40, h, C, d).slice(1, -1).forEach((l, i) => (rows[d + i] = text(l)));
    const seen = rows.join(" ").replace(/\s+/g, " ");
    expect(seen).toContain(`errs: ${err}`);
    for (const l of scr(info, 0, "", NOW, 40, h, C, maxBack)) expect(Bun.stringWidth(text(l))).toBe(40);
  }
  expect(scr({ ...INFO, problem: "tender.db unreadable: locked" }, 1, "", NOW, 80, 7, C).map(text).at(-1)).toContain("tender.db unreadable");
});

test("review 3: same-named rules in different repos stay distinct at 50 and 40 columns", () => {
  const twin = (repo: string) => ({ ...INFO.rules[1]!, id: `${repo}:guardrails`, repo, name: "guardrails" });
  for (const repos of [["acme/a", "acme/b"], ["acme/web-long-name-a", "acme/web-long-name-b"], ["acme/web", "other/web"]]) {
    const info = { ...INFO, rules: repos.map(twin) };
    for (const n of [50, 40, 30]) {
      const ls = scr(info, 5, "", NOW, n, 12, C).map(text);
      const head = ls.findIndex((l) => l.includes("rule"));
      const rows = ls.slice(head + 1, head + 3);
      expect(rows[0]).not.toBe(rows[1]);
      expect(rows.every((l) => l.includes(":"))).toBe(true);
    }
  }
});
