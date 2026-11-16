import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoLabels, changed, intake, marker, parseCollect, parseRecheck, ticketAt } from "../src/intake";
import { MIGRATIONS, openDb, schemaVersion } from "../src/db";
import { parseRepoConfig } from "../src/repo-config";
import { TENDER_DIR } from "../src/util";
import { spawnRun } from "../tender";
import { config, fakeIo, fakeTracker, repoFiles, root, setBaseSha, useTempRoot } from "./helpers";

useTempRoot();

const RULE = "intake:\n  - name: errs\n    run: .tender/intake/errs.sh\n    maxPerRun: 2\n    autoLabel: [{ minEvents: 100, level: error }]\n";
const HOUR = 3_600_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");
const line = (key: string, facts: object = {}) => JSON.stringify({ key, title: `Err ${key} @alice`, body: "boom\x1b[31m red", facts });
const seen = () => {
  const db = new Database(join(root, "tender.db"));
  try {
    return db.query<{ key: string; state: string; ticket_url: string | null }, []>("SELECT key, state, ticket_url FROM intake_seen ORDER BY key").all();
  } finally {
    db.close();
  }
};

function setup(script: (argv: string[]) => { code?: number; out?: string; err?: string }, tracker: Parameters<typeof fakeTracker>[0] = {}, over: object = {}, yaml = RULE) {
  repoFiles["config.yaml"] = yaml;
  const runs: { argv: string[]; env?: Record<string, string>; profile?: any }[] = [];
  const { io, logs } = fakeIo((a) => (a.some((x) => x.endsWith("/clone/.tender/intake/errs.sh")) ? script(a) : undefined));
  const run = io.run;
  io.run = (argv, cwd, secs, opts) => {
    if (argv.some((x) => x.endsWith("/errs.sh"))) {
      const p = argv.indexOf("--profile");
      runs.push({ argv, env: opts?.env, profile: p > 0 ? JSON.parse(readFileSync(argv[p + 1]!, "utf8")) : undefined });
    }
    return run(argv, cwd, secs, opts);
  };
  const events: unknown[][] = [];
  io.event = (...a) => void events.push(a);
  const done = (tracker.done ??= []);
  const { tr, calls } = fakeTracker(tracker);
  const fail = new Set<string>();
  const once = (what: string) => {
    if (fail.delete(what)) throw new Error(`${what} failed`);
  };
  const { comment, reopen } = tr;
  tr.comment = async (t, b) => (once("comment"), comment(t, b));
  tr.comments = async (t) => calls.filter((c) => c.startsWith(`comment ${t.id} `)).map((c, i) => ({ id: String(i), body: c.slice(`comment ${t.id} `.length), createdAt: "" }));
  tr.reopen = async (t) => (once("reopen"), await reopen(t), void done.splice(0, done.length, ...done.filter((d) => d !== t.id)));
  const cfg = config({ intake: { enabled: ["acme/web:errs"], host: "box" }, ...over });
  return { io, logs, calls, runs, events, done, fail, cfg, go: (now = T0, only?: string) => intake(cfg, io, TENDER_DIR, { now, only, tracker: () => tr }) };
}

test("protocol: valid lines parse; bad JSON, extra keys, repeated keys, bad facts and over 100 lines fail", () => {
  expect(parseCollect(`${line("a", { events: 3, level: "error" })}\n\n${line("b")}\n`)).toEqual([
    { key: "a", title: "Err a @alice", body: "boom\x1b[31m red", facts: { events: 3, level: "error" } },
    { key: "b", title: "Err b @alice", body: "boom\x1b[31m red", facts: {} },
  ]);
  expect(() => parseCollect("{nope")).toThrow("line 1: not JSON");
  expect(() => parseCollect(JSON.stringify({ key: "a", title: "t", body: "", extra: 1 }))).toThrow("must be");
  expect(() => parseCollect(`${line("a")}\n${line("a")}`)).toThrow("repeated");
  expect(() => parseCollect(JSON.stringify({ key: "a b", title: "t", body: "" }))).toThrow("key");
  expect(() => parseCollect(JSON.stringify({ key: "a", title: "t", body: "", facts: { x: { y: 1 } } }))).toThrow("facts");
  expect(() => parseCollect(Array.from({ length: 101 }, (_, i) => line(`k${i}`)).join("\n"))).toThrow("101 lines");
  expect(parseRecheck('{"state":"still","detail":"3 new"}\n')).toEqual({ state: "still", detail: "3 new" });
  expect(() => parseRecheck('{"state":"maybe"}')).toThrow("recheck");
  expect(() => parseRecheck('{"state":"gone"}\n{"state":"gone"}')).toThrow("recheck");
});

test("protocol: output over the byte cap kills the command and fails it", async () => {
  const r = await spawnRun(["sh", "-c", "head -c 3000000 /dev/zero; echo done"], undefined, 10, { max: 1024 * 1024 });
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("printed over 1048576 bytes");
  expect((await spawnRun(["sh", "-c", "echo $X"], undefined, 10, { env: { X: "only" } })).out).toBe("only\n");
});

test("protocol: a failing or timed-out script fails its run and files nothing", async () => {
  const s = setup(() => ({ code: 124, err: "errs.sh timed out after 300s" }));
  await s.go();
  expect(s.logs.some((l) => l.includes("intake acme/web:errs: failed") && l.includes("timed out"))).toBe(true);
  expect(s.calls).toEqual([]);
  const bad = setup(() => ({ out: "not json" }));
  await bad.go(T0 + 2 * HOUR);
  expect(bad.logs.some((l) => l.includes("line 1: not JSON"))).toBe(true);
  expect(bad.calls).toEqual([]);
});

test("filing: caps in script order, autoLabel vs shadow, sanitized body with marker, seen rows and events", async () => {
  const s = setup(() => ({ out: [line("a", { events: 500, level: "error" }), line("b", { events: 5, level: "error" }), line("c")].join("\n") }));
  await s.go();
  const filed = s.calls.filter((c) => c.startsWith("intake "));
  expect(filed).toHaveLength(2);
  expect(filed[0]).toStartWith("intake acme/web Err a @​alice [agent,host:box] | Untrusted data from tender intake rule acme/web:errs");
  expect(filed[0]).toContain(`boom red\n\n${marker("acme/web:errs", "a")}`);
  expect(filed[0]).not.toContain("\x1b");
  expect(filed[1]).toContain("Err b @​alice [] |");
  expect(s.logs).toContain("intake acme/web:errs: maxPerRun 2 reached, c waits for the next run");
  expect(seen().map((r) => [r.key, r.state])).toEqual([["a", "open"], ["b", "open"]]);
  expect(s.events.map((e) => [e[0], e[1], (e[3] as any).key])).toEqual([["intake-filed", "acme/web", "a"], ["intake-filed", "acme/web", "b"]]);
});

test("dedupe: intake_seen alone stops a refile, and every gates the timer", async () => {
  const s = setup(() => ({ out: line("a") }));
  await s.go();
  await s.go(T0 + 10 * 60_000);
  expect(s.runs).toHaveLength(1);
  await s.go(T0 + 59 * 60_000);
  expect(s.runs.filter((r) => !r.argv.includes("--recheck"))).toHaveLength(2);
  expect(s.calls.filter((c) => c.startsWith("intake "))).toHaveLength(1);
});

test("dedupe: the tracker marker search alone stops a refile when the db is empty", async () => {
  const url = "https://github.com/acme/web/issues/9";
  const s = setup(() => ({ out: line("a") }), { markers: { [marker("acme/web:errs", "a")]: url } });
  await s.go();
  expect(s.calls).toEqual([]);
  expect(seen()).toEqual([{ key: "a", state: "open", ticket_url: url }]);
});

test("open tickets: last seen updates, at most one comment a day and only when facts change noticeably", async () => {
  let events = 10;
  const s = setup(() => ({ out: line("a", { events }) }));
  await s.go();
  events = 100;
  await s.go(T0 + 2 * HOUR, "errs");
  await s.go(T0 + 25 * HOUR, "errs");
  await s.go(T0 + 26 * HOUR, "errs");
  events = 105;
  await s.go(T0 + 50 * HOUR, "errs");
  expect(s.calls.filter((c) => c.startsWith("comment "))).toEqual(["comment gh-101 intake acme/web:errs still sees this: events=100"]);
  expect(s.calls.filter((c) => c.startsWith("intake "))).toHaveLength(1);
  expect(changed({ a: 10, s: "x" }, { a: 14, s: "x" })).toBe(false);
  expect(changed({ a: 10 }, { a: 15 })).toBe(true);
  expect(changed({ s: "x" }, { s: "y" })).toBe(true);
});

const STILL = (a: string[]) => (a.includes("--recheck") ? { out: '{"state":"still","detail":"@bob 3 new events tender-intake: acme/web:errs:b"}' } : { out: line("a") });
const RECHECKED = `comment gh-101 intake acme/web:errs still sees this after it was done, so it is reopened without the ready label. @\u200bbob 3 new events tender_intake: acme/web:errs:b\n\ntender-intake-recheck: acme/web:errs:a`;
const sideCalls = (s: { calls: string[] }) => s.calls.filter((c) => /^(reopen|comment) /.test(c));

test("recheck: a Done ticket still seen after recheckAfter is commented and reopened once and only once", async () => {
  const s = setup(STILL, { done: ["gh-101"] });
  await s.go();
  await s.go(T0 + 2 * HOUR);
  expect(seen()[0]!.state).toBe("done");
  await s.go(T0 + 20 * HOUR, "errs");
  expect(s.runs.some((r) => r.argv.includes("--recheck"))).toBe(false);
  await s.go(T0 + 27 * HOUR);
  expect(s.runs.find((r) => r.argv.includes("--recheck"))!.argv.slice(-2)).toEqual(["--recheck", "a"]);
  expect(seen()[0]!.state).toBe("reopened");
  s.done.push("gh-101");
  await s.go(T0 + 60 * HOUR);
  await s.go(T0 + 90 * HOUR);
  expect(sideCalls(s)).toEqual([RECHECKED, "reopen gh-101"]);
  expect(seen()[0]!.state).toBe("closed");
  expect(s.calls.filter((c) => c.startsWith("intake "))).toHaveLength(1);
});

const dropDb = () => {
  for (const f of ["tender.db", "tender.db-wal", "tender.db-shm"]) rmSync(join(root, f), { force: true });
};

test("recheck: a failed comment or reopen is retried next run, never doubled; no reopen before the marked comment lands", async () => {
  for (const what of ["comment", "reopen"]) {
    const s = setup(STILL, { done: ["gh-101"] });
    await s.go();
    await s.go(T0 + 2 * HOUR);
    s.fail.add(what);
    await s.go(T0 + 27 * HOUR);
    expect(s.logs.some((l) => l.includes(`${what} failed`))).toBe(true);
    expect(s.calls.some((c) => c.startsWith("reopen "))).toBe(false);
    expect(seen()[0]!.state).toBe("reopening");
    await s.go(T0 + 29 * HOUR);
    await s.go(T0 + 31 * HOUR);
    expect(sideCalls(s).map((c) => (c.startsWith("comment ") ? c.endsWith("\n\ntender-intake-recheck: acme/web:errs:a") : c)).sort()).toEqual(["reopen gh-101", true]);
    expect(seen()[0]!.state).toBe("reopened");
    dropDb();
  }
});

test("recheck: with the db lost after the marked comment but before the reopen, the ticket is never reopened twice", async () => {
  const s = setup(STILL, { done: ["gh-101"], markers: { [marker("acme/web:errs", "a")]: "https://github.com/acme/web/issues/101" } });
  await s.go();
  await s.go(T0 + 2 * HOUR);
  s.fail.add("reopen");
  await s.go(T0 + 27 * HOUR);
  dropDb();
  for (let h = 30; h <= 90; h += 10) await s.go(T0 + h * HOUR);
  expect(sideCalls(s)).toEqual([RECHECKED]);
  expect(seen()[0]!.state).toBe("closed");
});

test("recheck: a pending reopen is dropped once recheck is turned off or the ticket is canceled", async () => {
  for (const how of ["cancel", "policy"]) {
    const canceled: string[] = [];
    const s = setup(STILL, { done: ["gh-101"], canceled });
    await s.go();
    await s.go(T0 + 2 * HOUR);
    s.fail.add("reopen");
    await s.go(T0 + 27 * HOUR);
    if (how === "cancel") canceled.push("gh-101");
    else (repoFiles["config.yaml"] = RULE + "    recheck: false\n"), setBaseSha("c".repeat(40));
    await s.go(T0 + 29 * HOUR);
    expect(sideCalls(s)).toEqual([RECHECKED]);
    expect(seen()[0]!.state).toBe("closed");
    dropDb();
  }
});

test("recheck: after the db is lost, the tracker's recheck comment stops a second reopen of an adopted ticket", async () => {
  const s = setup(STILL, { done: ["gh-101"], markers: { [marker("acme/web:errs", "a")]: "https://github.com/acme/web/issues/101" } });
  await s.go();
  await s.go(T0 + 2 * HOUR);
  await s.go(T0 + 27 * HOUR);
  s.done.push("gh-101");
  dropDb();
  for (let h = 30; h <= 90; h += 10) await s.go(T0 + h * HOUR);
  expect(sideCalls(s)).toEqual([RECHECKED, "reopen gh-101"]);
  expect(s.runs.filter((r) => r.argv.includes("--recheck"))).toHaveLength(1);
  expect(seen()[0]!.state).toBe("closed");
});

test("recheck: turning recheck off or a human reopening cancels a queued recheck", async () => {
  const s = setup(STILL, { done: ["gh-101"] });
  await s.go();
  await s.go(T0 + 2 * HOUR);
  s.done.length = 0;
  await s.go(T0 + 3 * HOUR);
  expect(seen()[0]!.state).toBe("open");
  s.done.push("gh-101");
  await s.go(T0 + 4 * HOUR);
  repoFiles["config.yaml"] = RULE + "    recheck: false\n";
  setBaseSha("b".repeat(40));
  await s.go(T0 + 40 * HOUR);
  expect(seen()[0]!.state).toBe("closed");
  expect(s.runs.some((r) => r.argv.includes("--recheck"))).toBe(false);
  expect(sideCalls(s)).toEqual([]);
});

test("recheck: the clock starts at the agent branch's merge, so an old merge first seen Done is rechecked on that run, with TENDER_DONE_AT set to it", async () => {
  const s = setup(STILL, { done: ["gh-101"] });
  const run = s.io.run;
  s.io.run = (argv, ...rest) => (argv.join(" ").startsWith("gh pr list --repo acme/web --head agent/gh-101") ? Promise.resolve({ code: 0, out: JSON.stringify([{ mergedAt: new Date(T0 - 48 * HOUR).toISOString() }]), err: "" }) : run(argv, ...rest));
  await s.go();
  await s.go(T0 + 2 * HOUR);
  expect(sideCalls(s)).toEqual([RECHECKED, "reopen gh-101"]);
  expect(s.runs.map((r) => r.env?.TENDER_DONE_AT)).toEqual([undefined, new Date(T0 - 48 * HOUR).toISOString(), undefined]);
  expect(s.runs[1]!.profile.environment.allow_vars).toContain("TENDER_DONE_AT");
});

test("recheck: gone closes the row without touching the ticket", async () => {
  const s = setup((a) => (a.includes("--recheck") ? { out: '{"state":"gone"}' } : { out: line("a") }), { done: ["gh-101"] });
  await s.go();
  await s.go(T0 + 2 * HOUR);
  await s.go(T0 + 30 * HOUR);
  expect(seen()[0]!.state).toBe("closed");
  expect(s.calls.filter((c) => !c.startsWith("intake "))).toEqual([]);
});

test("recheck: a failing or malformed --recheck changes nothing, is retried next run, and blocks neither collect nor other rows", async () => {
  let undecided = true;
  let keys = ["a", "b", "m"];
  const recheck = (key: string) => (key === "b" ? { out: '{"state":"gone"}' } : !undecided ? { out: '{"state":"gone"}' } : key === "a" ? { code: 1, err: "cannot decide" } : { out: "not json" });
  const s = setup((a) => (a.includes("--recheck") ? recheck(a.at(-1)!) : { out: keys.map((k) => line(k)).join("\n") }), {}, {}, RULE.replace("maxPerRun: 2", "maxPerRun: 3"));
  await s.go();
  s.done.push(...seen().map((r) => ticketAt(r.ticket_url!, "acme/web")!.id));
  await s.go(T0 + 2 * HOUR);
  keys = ["a", "b", "m", "c"];
  await s.go(T0 + 30 * HOUR);
  await s.go(T0 + 32 * HOUR);
  expect(s.logs.filter((l) => l.includes("recheck a failed") && l.includes("cannot decide"))).toHaveLength(2);
  expect(s.logs.filter((l) => l.includes("recheck m failed") && l.includes("not one JSON line"))).toHaveLength(2);
  expect(seen().map((r) => [r.key, r.state])).toEqual([["a", "done"], ["b", "closed"], ["c", "open"], ["m", "done"]]);
  expect(s.calls.filter((c) => c.startsWith("intake ")).map((c) => c.split(" | ")[0]!.split(" ").slice(2, 4).join(" "))).toEqual(["Err a", "Err b", "Err m", "Err c"]);
  expect(s.calls.filter((c) => /^(comment|reopen) /.test(c))).toEqual([]);
  undecided = false;
  await s.go(T0 + 34 * HOUR);
  expect(seen().map((r) => r.state)).toEqual(["closed", "closed", "open", "closed"]);
});

test("a disabled rule does not run, nor does any rule on another host", async () => {
  const off = setup(() => ({ out: line("a") }), {}, { intake: { enabled: [], host: "box" } });
  await off.go();
  expect(off.runs).toEqual([]);
  const other = setup(() => ({ out: line("a") }), {}, { intake: { enabled: ["acme/web:errs"], host: "laptop" } });
  await other.go();
  expect(other.runs).toEqual([]);
  expect(other.logs).toContain("intake: runs on laptop, not box");
  await other.go(T0, "errs");
  expect(other.runs).toEqual([]);
});

test("sandbox: nono with the rule's network allowlist, only declared secrets, no tracker key, a state file", async () => {
  const yaml = "intake:\n  - name: errs\n    run: .tender/intake/errs.sh\n    secrets: [SENTRY_TOKEN]\n    network: [sentry.io]\n";
  const prev = { s: process.env.SENTRY_TOKEN, l: process.env.LINEAR_API_KEY };
  const missing = setup(() => ({ out: "" }), {}, {}, yaml);
  delete process.env.SENTRY_TOKEN;
  await missing.go();
  expect(missing.logs.some((l) => l.includes("secrets not set in the host's environment (.env): SENTRY_TOKEN"))).toBe(true);
  expect(missing.runs).toEqual([]);
  process.env.SENTRY_TOKEN = "s3cret";
  process.env.LINEAR_API_KEY = "lin";
  try {
    const s = setup(() => ({ out: "" }), {}, {}, yaml);
    await s.go(T0, "errs");
    const [r] = s.runs;
    expect(r!.argv.slice(0, 2)).toEqual(["nono", "run"]);
    expect(r!.argv).toContain(join(root, ".intake/acme/web/errs.state"));
    expect(r!.profile.network).toEqual({ allow_domain: ["sentry.io"] });
    expect(r!.profile.environment.allow_vars).toContain("SENTRY_TOKEN");
    expect(r!.env).toMatchObject({ SENTRY_TOKEN: "s3cret", TENDER_STATE: join(root, ".intake/acme/web/errs.state"), TENDER_RULE: "acme/web:errs" });
    expect(Object.keys(r!.env!).filter((k) => /LINEAR|GH_|GITHUB/.test(k))).toEqual([]);
  } finally {
    for (const [k, v] of [["SENTRY_TOKEN", prev.s], ["LINEAR_API_KEY", prev.l]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

test("sandbox: nono even for a repo whose sessions run without it", async () => {
  const s = setup(() => ({ out: "" }), {}, { defaults: { sandbox: "none" } });
  await s.go();
  expect(s.runs[0]!.argv.slice(0, 2)).toEqual(["nono", "run"]);
});

test("filing: the whole body stays within 4000 characters, and a marker in script text cannot pose as another key's", async () => {
  const body = `tender-intake: acme/web:errs:b\n${"x".repeat(5000)}`;
  const s = setup(() => ({ out: JSON.stringify({ key: "a", title: "t", body }) }));
  await s.go();
  const filed = s.calls.find((c) => c.startsWith("intake "))!.split(" | ").slice(1).join(" | ");
  expect(filed.length).toBeLessThanOrEqual(4000);
  expect(filed).toEndWith(`\n\n${marker("acme/web:errs", "a")}`);
  expect(filed).toContain("tender_intake: acme/web:errs:b");
});

const dryDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("tender-intake-dry-"));

test("dry run: no db is created, an old db keeps its schema, and the clone sits outside the live intake dir", async () => {
  const before = dryDirs();
  const s = setup(() => ({ out: line("a") }));
  s.io.dry = true;
  await s.go();
  expect(existsSync(join(root, "tender.db"))).toBe(false);
  expect(dryDirs()).toEqual(before);
  const { argv } = s.runs[0]!;
  expect(argv.filter((x) => x.startsWith(join(root, ".intake")))).toEqual([]);
  expect(argv.some((x) => x.endsWith("/clone/.tender/intake/errs.sh"))).toBe(true);
  const old = new Database(join(root, "tender.db"));
  old.run("CREATE TABLE schema_version (version INTEGER NOT NULL)");
  for (const sql of MIGRATIONS.slice(0, 2)) old.run(sql);
  old.run("INSERT INTO schema_version VALUES (2)");
  old.close();
  await s.go(T0 + 2 * HOUR);
  const after = new Database(join(root, "tender.db"));
  expect(schemaVersion(after)).toBe(2);
  after.close();
});

test("dry run: a current WAL db whose writer has closed is left byte for byte, with no -wal or -shm created", async () => {
  dropDb();
  const live = openDb(join(root, "tender.db"));
  live.run("INSERT INTO intake_seen (rule, key, state, ticket_url, filed_at, last_seen_at) VALUES ('acme/web:errs', 'a', 'open', 'https://github.com/acme/web/issues/7', '2026-01-01', '2026-01-01')");
  live.close();
  const listing = () => readdirSync(root).filter((n) => n.startsWith("tender.db")).map((n) => [n, readFileSync(join(root, n)).toString("base64")]);
  const before = listing();
  expect(before.map(([n]) => n)).toEqual(["tender.db"]);
  const s = setup(() => ({ out: line("a") }));
  s.io.dry = true;
  await s.go();
  expect(s.runs).toHaveLength(1);
  expect(listing()).toEqual(before);
});

test("autoLabel: min<Fact> is a floor, other keys equality, any rule matching labels", () => {
  expect(autoLabels([], { events: 1000 })).toBe(false);
  expect(autoLabels([{ minEvents: 100, level: "error" }], { events: 100, level: "error" })).toBe(true);
  expect(autoLabels([{ minEvents: 100, level: "error" }], { events: 99, level: "error" })).toBe(false);
  expect(autoLabels([{ level: "fatal" }, { minUsers: 3 }], { users: 4 })).toBe(true);
});

test("repo config: intake rules get defaults and every problem is listed", () => {
  const file = (text: string) => [{ name: "config.yaml", regular: true, size: text.length, text }];
  expect(parseRepoConfig(file(RULE)).intake).toEqual([{ name: "errs", run: ".tender/intake/errs.sh", every: "1h", maxPerRun: 2, secrets: [], network: [], autoLabel: [{ minEvents: 100, level: "error" }], recheck: true, recheckAfter: "24h" }]);
  const bad = "intake:\n  - name: Errs\n    run: ../x.sh\n    every: 1w\n    secrets: [GH_TOKEN, LINEAR_API_KEY]\n    network: [https://x.io]\n    maxPerRun: 0\n    nope: 1\n";
  expect(() => parseRepoConfig(file(bad))).toThrow(/name[\s\S]*run[\s\S]*every[\s\S]*maxPerRun[\s\S]*secrets[\s\S]*network/);
  expect(() => parseRepoConfig(file(bad))).toThrow("intake[0] (Errs).nope: unknown key");
});

test("host config: intake names repos in repos and one host", () => {
  expect(config({ intake: { enabled: ["acme/web:errs"], host: "box" } }).intake).toEqual({ enabled: ["acme/web:errs"], host: "box" });
  expect(() => config({ intake: { enabled: ["acme/api:errs"], host: "box" } })).toThrow("intake.enabled");
  expect(() => config({ intake: { enabled: [] } })).toThrow("intake.host");
  expect(config().intake).toBeUndefined();
});
