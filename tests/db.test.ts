import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS, openDb, recorder, schemaVersion } from "../src/db";
import { root, useTempRoot } from "./helpers";

useTempRoot();

const file = () => join(root, "tender.db");
const tables = (db: Database) => db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
const count = (db: Database) => db.query<{ n: number }, []>("SELECT count(*) AS n FROM events").get()!.n;

test("a new db is migrated to the current version in WAL mode", () => {
  const db = openDb(file());
  expect(schemaVersion(db)).toBe(MIGRATIONS.length);
  expect(tables(db)).toEqual(["events", "intake_runs", "intake_seen", "schema_version"]);
  expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!.journal_mode).toBe("wal");
  expect(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('intake_runs')").all().map((r) => r.name)).toEqual(["rule", "ran_at", "error"]);
  db.close();
  const again = openDb(file());
  expect(again.query("SELECT * FROM schema_version").all()).toEqual([{ version: MIGRATIONS.length }]);
  again.close();
});

test("a db at version 1 is migrated to current and keeps its events", () => {
  const old = new Database(file(), { create: true });
  old.run("CREATE TABLE schema_version (version INTEGER NOT NULL)");
  old.run(MIGRATIONS[0]!);
  old.run("INSERT INTO schema_version VALUES (1)");
  old.run("INSERT INTO events (at, host, repo, ticket, kind) VALUES ('t', 'box', 'acme/web', 'gh-1', 'start')");
  old.close();
  const db = openDb(file());
  expect(schemaVersion(db)).toBe(MIGRATIONS.length);
  expect(tables(db)).toContain("intake_seen");
  expect(count(db)).toBe(1);
  db.close();
});

test("two processes migrate and write at once while a reader reads", async () => {
  const script = (n: number) => `const { recorder } = await import(${JSON.stringify(join(import.meta.dir, "../src/db.ts"))}); const e = recorder(${JSON.stringify(file())}, "p${n}", (m) => { console.error(m); process.exit(1); }); for (let i = 0; i < 200; i++) e("start", "acme/web", "gh-" + i);`;
  const procs = [1, 2].map((n) => Bun.spawn(["bun", "-e", script(n)], { stderr: "pipe" }));
  const codes = await Promise.all(procs.map((p) => p.exited));
  expect(await Promise.all(procs.map((p) => new Response(p.stderr).text()))).toEqual(["", ""]);
  expect(codes).toEqual([0, 0]);
  const writer = openDb(file());
  const reader = new Database(file(), { readonly: true });
  writer.run("BEGIN IMMEDIATE");
  writer.run("INSERT INTO events (at, host, repo, ticket, kind) VALUES ('t', 'box', 'acme/web', 'gh-x', 'start')");
  expect(count(reader)).toBe(400);
  writer.run("COMMIT");
  expect(count(reader)).toBe(401);
  reader.close();
  writer.close();
});

test("an event under another process's held write lock is dropped and logged within the busy timeout", async () => {
  openDb(file()).close();
  const holder = Bun.spawn(["bun", "-e", `const { Database } = await import("bun:sqlite"); const db = new Database(${JSON.stringify(file())}); db.run("BEGIN IMMEDIATE"); console.log("held"); await Bun.sleep(5000);`], { stdout: "pipe" });
  try {
    await holder.stdout.getReader().read();
    const logs: string[] = [];
    const started = performance.now();
    recorder(file(), "box", (m) => logs.push(m))("start", "acme/web", "gh-1");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(logs).toEqual([expect.stringMatching(/^event start acme\/web\/gh-1 not recorded: .*locked/)]);
  } finally {
    holder.kill();
  }
});

test("a db deleted mid-run is recreated on the next event", () => {
  const logs: string[] = [];
  const event = recorder(file(), "box", (m) => logs.push(m));
  event("start", "acme/web", "gh-1");
  for (const f of ["", "-wal", "-shm"]) rmSync(file() + f, { force: true });
  event("claim", "acme/web", "gh-1", { x: 1 });
  const db = openDb(file());
  expect(db.query("SELECT host, repo, ticket, kind, data FROM events").all()).toEqual([{ host: "box", repo: "acme/web", ticket: "gh-1", kind: "claim", data: '{"x":1}' }]);
  db.close();
  expect(logs).toEqual([]);
});

test("a failed write is logged, never thrown", () => {
  mkdirSync(file());
  const logs: string[] = [];
  recorder(file(), "box", (m) => logs.push(m))("start", "acme/web", "gh-1");
  expect(logs).toEqual([expect.stringMatching(/^event start acme\/web\/gh-1 not recorded: /)]);
});
