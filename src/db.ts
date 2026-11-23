import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { Config, EventKind, Io } from "./types";

export const DB_FILE = "tender.db";

// Append only: version N is MIGRATIONS[N - 1]. Never edit one that has shipped.
export const MIGRATIONS = [
  "CREATE TABLE events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, host TEXT NOT NULL, repo TEXT NOT NULL, ticket TEXT NOT NULL, kind TEXT NOT NULL, data TEXT, once TEXT); CREATE UNIQUE INDEX events_once ON events (kind, repo, ticket, once) WHERE once IS NOT NULL",
  "CREATE TABLE intake_seen (rule TEXT NOT NULL, key TEXT NOT NULL, ticket_url TEXT, filed_at TEXT, last_seen_at TEXT, state TEXT, PRIMARY KEY (rule, key))",
  "ALTER TABLE intake_seen ADD COLUMN facts TEXT; ALTER TABLE intake_seen ADD COLUMN commented_at TEXT; ALTER TABLE intake_seen ADD COLUMN done_at TEXT; CREATE TABLE intake_runs (rule TEXT PRIMARY KEY, ran_at TEXT NOT NULL)",
  "ALTER TABLE intake_runs ADD COLUMN error TEXT",
];

// Short: under contention an event is dropped and logged rather than holding up ticket handling.
const BUSY_MS = 250;

export const schemaVersion = (db: Database) => db.query<{ v: number | null }, []>("SELECT max(version) AS v FROM schema_version").get()?.v ?? 0;

// Switching to WAL fails at once, without the busy timeout, while another process opens the same new file.
function walMode(db: Database) {
  for (let tries = 1; ; tries++) {
    try {
      const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get()?.journal_mode;
      if (mode === "wal") return;
      throw new Error(`journal_mode is ${mode}, not wal`);
    } catch (e) {
      if (tries * 20 >= BUSY_MS || !/locked|busy/i.test((e as Error).message)) throw e;
    }
    Bun.sleepSync(20);
  }
}

/** Opens `file` in WAL mode and migrates it to the current schema. */
export function openDb(file: string) {
  const db = new Database(file, { create: true });
  try {
    db.run(`PRAGMA busy_timeout = ${BUSY_MS}`);
    walMode(db);
    // IMMEDIATE: a second process migrating at the same time waits, then finds nothing left to run.
    db.transaction(() => {
      db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
      const v = schemaVersion(db);
      for (const sql of MIGRATIONS.slice(v)) db.run(sql);
      if (v < MIGRATIONS.length) db.run("INSERT INTO schema_version VALUES (?)", [MIGRATIONS.length]);
    }).immediate();
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

/** An empty in-memory db at the current schema, for a dry run that must not touch `tender.db` or its sidecars. */
export function memoryDb() {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.run(sql);
  return db;
}

/** An `Io.event` that appends to `file`, opened on first use; a failed write is logged, never thrown. An event with `once` is kept only the first time. */
export function recorder(file: string, host: string, log: (m: string) => void): NonNullable<Io["event"]> {
  let db: Database | undefined;
  let ino: number | undefined;
  return (kind: EventKind, repo: string, ticket: string, data?: object, once?: string) => {
    try {
      // A deleted or replaced file is reopened, so later events never land in an unlinked inode.
      if (!db || statSync(file, { throwIfNoEntry: false })?.ino !== ino) {
        db?.close();
        db = undefined;
        db = openDb(file);
        ino = statSync(file).ino;
      }
      db.run("INSERT OR IGNORE INTO events (at, host, repo, ticket, kind, data, once) VALUES (?, ?, ?, ?, ?, ?, ?)", [new Date().toISOString(), host, repo, ticket, kind, data ? JSON.stringify(data) : null, once ?? null]);
    } catch (e) {
      log(`event ${kind} ${repo}/${ticket} not recorded: ${(e as Error).message}`);
    }
  };
}

/** The CLI's `Io.event`: none in a dry run, which writes nothing. */
export const events = (cfg: Config, dry: boolean, log: (m: string) => void) => (dry ? undefined : recorder(join(cfg.workspaceRoot, DB_FILE), cfg.host, log));
