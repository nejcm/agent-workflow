import type { Database } from "bun:sqlite";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB_FILE, memoryDb, openDb } from "./db";
import { sanitized, unmention } from "./review/findings";
import { nonoRun } from "./session/launcher";
import { judgeRule } from "./judge";
import { guardrails } from "./guardrail";
import { makeTracker } from "./pass";
import { DURATION, loadSession, securityFact } from "./config/repo-config";
import type { Config, IntakeRule, Io, Session, Source, Target, Ticket, Tracker } from "./types";
import { clean, GIT, hasLabel, hasMarker, read, SLOW_SECS } from "./util";

export const LIMITS = { secs: 300, bytes: 1024 * 1024, lines: 100 };
const MAX_BODY = 4000;
const KEY = /^[A-Za-z0-9.:\/-]{1,128}$/;
const FACT = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const SHORT_ID = /^[A-Z0-9][A-Z0-9_-]{0,63}-[A-Z0-9]{1,32}$/;
const DAY = 86_400_000;
// The timer fires every 15 min with up to a minute of jitter, so a 1h rule must not slip to the next tick.
export const SLACK_MS = 2 * 60_000;

export type Facts = Record<string, string | number>;
export interface Finding {
  key: string;
  title: string;
  body: string;
  facts: Facts;
  /** An error tracker short ID the fix should close, e.g. Sentry's `WEB-1A2`. */
  fixes?: string;
}

interface Seen {
  key: string;
  ticket_url: string | null;
  filed_at: string | null;
  state: string;
  facts: string | null;
  commented_at: string | null;
  done_at: string | null;
}

export const ms = (d: string) => {
  const [, n, unit] = DURATION.exec(d)!;
  return Number(n) * { m: 60_000, h: 3_600_000, d: DAY }[unit as "m" | "h" | "d"];
};

/** The ready label, plus `host:<host>` unless this is the default host. */
export const readyLabels = (cfg: Config, s: Source) => [s.readyLabel, ...(cfg.defaultHost ? [] : [`host:${cfg.host}`])];

/** The source's workflow labels, which no intake or guardrail ticket may carry. */
export const ownLabels = (s: Source) => [s.readyLabel, s.needsHumanLabel, ...(s.tracker === "github" ? [s.inProgressLabel, s.inReviewLabel, s.readyToMergeLabel] : [])];

export const marker = (rule: string, key: string) => `tender-intake: ${rule}:${key}`;

const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

function parseFacts(v: unknown, at: string): Facts {
  if (v === undefined) return {};
  const ok = obj(v) && Object.keys(v).length <= 20 && Object.entries(v).every(([k, x]) => FACT.test(k) && (typeof x === "string" || Number.isFinite(x)));
  if (!ok) throw new Error(`${at}.facts: flat map of at most 20 numbers and strings`);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "string" ? clean(x, 200) : x]));
}

/** A script's collect output: at most 100 JSON lines of `{ key, title, body, facts?, fixes? }`; anything else throws. */
export function parseCollect(out: string): Finding[] {
  const lines = out.split("\n").filter((l) => l.trim());
  if (lines.length > LIMITS.lines) throw new Error(`${lines.length} lines, at most ${LIMITS.lines}`);
  const keys = new Set<string>();
  return lines.map((l, i) => {
    const at = `line ${i + 1}`;
    let o: unknown;
    try {
      o = JSON.parse(l);
    } catch {
      throw new Error(`${at}: not JSON`);
    }
    if (!obj(o) || !Object.keys(o).every((k) => ["key", "title", "body", "facts", "fixes"].includes(k))) throw new Error(`${at}: must be { key, title, body, facts?, fixes? }`);
    if (typeof o.key !== "string" || !KEY.test(o.key)) throw new Error(`${at}.key: [A-Za-z0-9.:/-], at most 128`);
    if (keys.has(o.key)) throw new Error(`${at}.key: ${o.key} repeated`);
    keys.add(o.key);
    if (typeof o.title !== "string" || !o.title.trim() || typeof o.body !== "string") throw new Error(`${at}: title must be a non-empty string, body a string`);
    if (o.fixes !== undefined && !(typeof o.fixes === "string" && SHORT_ID.test(o.fixes))) throw new Error(`${at}.fixes: an issue short ID like WEB-1A2`);
    return { key: o.key, title: o.title, body: o.body, facts: parseFacts(o.facts, at), ...(o.fixes !== undefined && { fixes: o.fixes }) };
  });
}

/** A script's `--recheck <key>` output: one JSON line `{ state: "gone" | "still", detail? }`. */
export function parseRecheck(out: string) {
  let o: unknown;
  try {
    o = JSON.parse(out.trim());
  } catch {
    throw new Error("recheck: not one JSON line");
  }
  if (!obj(o) || !["gone", "still"].includes(o.state) || !(o.detail === undefined || typeof o.detail === "string") || !Object.keys(o).every((k) => k === "state" || k === "detail"))
    throw new Error(`recheck: must be { "state": "gone" | "still", "detail"? }`);
  return { state: o.state as "gone" | "still", detail: clean(o.detail ?? "", 500) };
}

/** Whether any `autoLabel` rule holds for `facts`: `min<Fact>` is `facts.<fact> >= n`, any other key is equality; never for a SECURITY finding. */
export function autoLabels(rules: Facts[], facts: Facts) {
  if (securityFact(facts.categories)) return false;
  return rules.some((r) =>
    Object.entries(r).every(([k, v]) => {
      const min = /^min([A-Z])(\w*)$/.exec(k);
      if (!min) return facts[k] === v;
      const f = facts[min[1]!.toLowerCase() + min[2]];
      return typeof f === "number" && typeof v === "number" && f >= v;
    }),
  );
}

/** A fact added, dropped, a string changed, or a number moved by at least half. */
export function changed(old: Facts, now: Facts) {
  const keys = new Set([...Object.keys(old), ...Object.keys(now)]);
  return [...keys].some((k) => {
    const [a, b] = [old[k], now[k]];
    if (typeof a === "number" && typeof b === "number") return Math.abs(b - a) >= Math.max(1, Math.abs(a) / 2);
    return a !== b;
  });
}

const factLine = (f: Facts) => unmention(Object.entries(f).map(([k, v]) => `${k}=${v}`).join(", "));

/** The ticket behind a URL tender filed, or undefined if it is not one of the shapes trackers return. */
export function ticketAt(url: string, repo: string): Ticket | undefined {
  const gh = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)$/.exec(url);
  if (gh && gh[1]!.toLowerCase() === repo.toLowerCase()) return { id: `gh-${gh[2]}`, ref: gh[2]!, title: "", body: "", url, repo };
  const lin = /^https:\/\/linear\.app\/[\w-]+\/issue\/([A-Z0-9]+-\d+)(?:\/[\w-]*)?$/.exec(url)?.[1];
  if (lin) return { id: lin, ref: lin, title: "", body: "", url, repo };
}

/** The source a repo's intake tickets go to: a Linear one when the repo names a project (matching its team if set), else GitHub. */
export function intakeSource(cfg: Config, r: Session): Source {
  const lt = r.tracker?.linear;
  const fits = cfg.sources.filter((s) => (lt ? s.tracker === "linear" && (!lt.team || s.team === lt.team) : s.tracker === "github"));
  if (fits.length !== 1) throw new Error(`${fits.length} ${lt ? `linear sources${lt.team ? ` for team ${lt.team}` : ""}` : "github sources"} to file into, need exactly one`);
  return fits[0]!;
}

type Script = (args: string[], extra?: Record<string, string>) => Promise<string>;

// A fresh --shared clone of origin/<base> per run, always under nono: the script can write only it, its temp dir and its state file.
async function sandbox(cfg: Config, io: Io, work: string, r: Session, id: string, rule: IntakeRule, tenderDir: string, secrets: Record<string, string>) {
  const dir = join(work, r.key, rule.name);
  const clone = join(dir, "clone");
  const tmp = join(dir, "tmp");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  // A dry run hands the script a copy, so its state moves only when tickets do.
  const kept = join(cfg.workspaceRoot, ".intake", r.key, `${rule.name}.state`);
  const state = io.dry ? join(dir, "state") : kept;
  if (io.dry && existsSync(kept)) copyFileSync(kept, state);
  else if (!existsSync(state)) writeFileSync(state, "");
  await read(io, [...GIT, "-c", "protocol.file.allow=always", "-c", "advice.detachedHead=false", "clone", "-q", "--shared", "--revision", `refs/remotes/origin/${r.baseBranch}`, "--", r.path, clone], undefined, SLOW_SECS);
  const profile = JSON.parse(readFileSync(join(tenderDir, "nono", "tender-intake.json"), "utf8"));
  profile.environment.allow_vars.push(...Object.keys(secrets));
  profile.network = rule.network.length ? { allow_domain: rule.network } : { block: true };
  if (rule.loopback) profile.linux.isolate = { network: true, loopback: true };
  mkdirSync(join(dir, "nono"));
  writeFileSync(join(dir, "nono", "tender-intake.json"), JSON.stringify(profile));
  const box = nonoRun("tender-intake", dir, [["--allow", clone], ["--allow", tmp], ["--allow-file", state], ["--read", join(r.path, ".git", "objects")]]);
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: io.home, LANG: "C.UTF-8", TMPDIR: tmp, TENDER_STATE: state, TENDER_RULE: id, ...secrets };
  const script: Script = async (args, extra) => {
    const res = await io.run([...box, join(clone, rule.run), ...rule.args, ...args], clone, LIMITS.secs, { env: { ...env, ...extra }, max: LIMITS.bytes });
    if (res.code !== 0) throw new Error(`${[rule.run, ...args].join(" ")} exited ${res.code}: ${clean(res.err, 300)}`);
    return res.out;
  };
  return { script, done: () => rmSync(dir, { recursive: true, force: true }) };
}

export const HEARTBEAT = ".intake.beat";

// Its own file: holdLock creates .intake.lock on any run, a named rule too. The dashboard reads its mtime.
function heartbeat(cfg: Config, now: number) {
  const f = join(cfg.workspaceRoot, HEARTBEAT);
  appendFileSync(f, "");
  utimesSync(f, now / 1000, now / 1000);
}

/** Runs every rule enabled for this host whose `every` has passed (`only`: that rule now, by `owner/name:rule` or rule name). */
export async function intake(cfg: Config, io: Io, tenderDir: string, { only, now = Date.now(), tracker = (s: Source) => makeTracker(s, cfg.host, io, cfg.defaultHost, Object.keys(cfg.repos)) }: { only?: string; now?: number; tracker?: (s: Source) => Tracker } = {}) {
  if (!cfg.intake) return io.log("intake: no intake in tender.json");
  if (cfg.intake.host !== cfg.host) return io.log(`intake: runs on ${cfg.intake.host}, not ${cfg.host}`);
  const ids = cfg.intake.enabled.filter((id) => only === undefined || only === id || only === id.slice(id.lastIndexOf(":") + 1));
  if (only !== undefined && !ids.length) return io.log(`intake: ${only} is not enabled in tender.json`);
  const file = join(cfg.workspaceRoot, DB_FILE);
  if (!io.dry) mkdirSync(cfg.workspaceRoot, { recursive: true });
  if (!io.dry && only === undefined) heartbeat(cfg, now);
  const db = io.dry ? memoryDb() : openDb(file);
  let work: string | undefined;
  try {
    // A dry run gets its own clones, so it cannot disturb a live run.
    work = io.dry ? mkdtempSync(join(tmpdir(), "tender-intake-dry-")) : join(cfg.workspaceRoot, ".intake");
    const vis = new Map<string, string>();
    const budget = { left: cfg.judge?.maxPerRun ?? 0 };
    for (const id of ids) await runRule(cfg, io, db, work, id, tenderDir, only !== undefined, now, tracker, vis, budget).catch((e) => io.log(`intake ${id}: failed: ${e.message}`));
    if (cfg.judge?.guardrails && only === undefined) await guardrails(cfg, io, db, work, tenderDir, budget, tracker, now).catch((e) => io.log(`guardrail: failed: ${e.message}`));
  } finally {
    if (io.dry && work) rmSync(work, { recursive: true, force: true });
    db.close();
  }
}

async function runRule(cfg: Config, io: Io, db: Database, work: string, id: string, tenderDir: string, force: boolean, now: number, tracker: (s: Source) => Tracker, vis: Map<string, string>, budget: { left: number }) {
  const host = cfg.repos[id.slice(0, id.lastIndexOf(":"))]!;
  const name = id.slice(id.lastIndexOf(":") + 1);
  const r = await loadSession(io, host, SLOW_SECS);
  if (!r) return;
  const rule = r.intake.find((x) => x.name === name);
  if (!rule) return io.log(`intake ${id}: no rule ${name} in .tender/config.yaml on ${r.baseBranch}`);
  const ran = db.query<{ ran_at: string }, [string]>("SELECT ran_at FROM intake_runs WHERE rule = ?").get(id)?.ran_at;
  if (force || !ran || now - Date.parse(ran) >= ms(rule.every) - SLACK_MS) await fileRule(cfg, io, db, work, id, tenderDir, now, tracker, vis, r, rule).catch((e) => {
      io.log(`intake ${id}: failed: ${e.message}`);
      if (!io.dry) db.run("UPDATE intake_runs SET error = ? WHERE rule = ?", [clean(e.message, 300), id]);
    });
  // Every run, not only when the rule is due, so tickets the cap or a failed call left over wait 15 minutes, not `every`.
  if (!cfg.judge) return;
  const s = intakeSource(cfg, r);
  await judgeRule(cfg, io, db, work, tenderDir, id, r, rule, s, tracker(s), budget);
}

async function fileRule(cfg: Config, io: Io, db: Database, work: string, id: string, tenderDir: string, now: number, tracker: (s: Source) => Tracker, vis: Map<string, string>, r: Session, rule: IntakeRule) {
  const save: Save = (sql, ...params) => void (io.dry || db.run(sql, params));
  // Marked before running: a failing script waits its interval like a working one.
  save("INSERT INTO intake_runs (rule, ran_at) VALUES (?, ?) ON CONFLICT (rule) DO UPDATE SET ran_at = excluded.ran_at, error = NULL", id, new Date(now).toISOString());
  const missing = rule.secrets.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`secrets not set in the host's environment (.env): ${missing.join(", ")}`);
  const s = intakeSource(cfg, r);
  const taken = rule.labels.filter((x) => hasLabel(ownLabels(s), x));
  if (taken.length) throw new Error(`labels: ${taken.join(", ")} ${taken.length > 1 ? "are" : "is"} tender's own; use autoLabel for the ready label`);
  // The fix PR lands on the GitHub repo whatever the tracker, so `private` checks it for Linear too.
  if (rule.private) {
    if (!vis.has(r.key)) vis.set(r.key, (await read(io, ["gh", "repo", "view", r.key, "--json", "visibility", "--jq", ".visibility"])).trim());
    const v = vis.get(r.key)!;
    if (!["PRIVATE", "INTERNAL"].includes(v)) throw new Error(`private: ${r.key} is ${/^[A-Z]{1,20}$/.test(v) ? v : "of unknown visibility"}, so this rule files nothing there`);
  }
  const tr = tracker(s);
  const box = await sandbox(cfg, io, work, r, id, rule, tenderDir, Object.fromEntries(rule.secrets.map((k) => [k, process.env[k]!])));
  try {
    await sweep(io, db, save, tr, r.key, id, rule, box.script, now);
    await collect(cfg, io, db, save, tr, s, { repo: r.key, project: r.tracker?.linear?.project }, id, rule, box.script, now);
  } finally {
    box.done();
  }
}

type Save = (sql: string, ...params: (string | null)[]) => void;
const rows = (db: Database, id: string) => db.query<Seen, [string]>("SELECT * FROM intake_seen WHERE rule = ? AND ticket_url IS NOT NULL").all(id);

// Done tickets wait `recheckAfter` from their merge; a `still` reopens one once, ever: the recheck comment's marker is the tracker-side record.
async function sweep(io: Io, db: Database, save: Save, tr: Tracker, repo: string, id: string, rule: IntakeRule, script: Script, now: number) {
  const iso = new Date(now).toISOString();
  const set = (key: string, state: string, doneAt?: string) => save(`UPDATE intake_seen SET state = ?${doneAt ? ", done_at = ?" : ""} WHERE rule = ? AND key = ?`, state, ...(doneAt ? [doneAt] : []), id, key);
  for (const row of rows(db, id).filter((x) => ["open", "reopened", "done", "reopening"].includes(x.state))) {
    const t = ticketAt(row.ticket_url!, repo);
    if (!t) continue;
    const recorded = (state: "gone" | "still") => io.event?.("recheck", repo, t.id, { rule: id, key: row.key, state }, `${id}:${row.key}`);
    const st = await tr.closed(t.id, repo);
    if (!st) {
      if (row.state === "done") set(row.key, "open");
      // Open while reopening: tender's reopen may have landed; without its marked comment it never got that far, so a human reopened it.
      if (row.state === "reopening") {
        set(row.key, "reopened");
        if (await rechecked(tr, t, recheckMarker(id, row.key))) recorded("still");
      }
      continue;
    }
    if (st !== "done" || !rule.recheck || row.state === "reopened") {
      set(row.key, "closed");
      continue;
    }
    const m = recheckMarker(id, row.key);
    if (row.state === "reopening") {
      await reopenOnce(tr, t, m, id, "");
      set(row.key, "reopened");
      recorded("still");
      continue;
    }
    const doneAt = row.state === "done" ? row.done_at! : ((await mergedAt(io, repo, t.id)) ?? iso);
    if (row.state !== "done") set(row.key, "done", doneAt);
    if (now - Date.parse(doneAt) < ms(rule.recheckAfter)) continue;
    if (await rechecked(tr, t, m)) {
      set(row.key, "closed");
      continue;
    }
    // One failing row must not starve the others or collect; its state says where the next run resumes.
    try {
      const { state, detail } = parseRecheck(await script(["--recheck", row.key], { TENDER_DONE_AT: doneAt }));
      io.log(`intake ${id}: recheck ${row.key} (${t.id}): ${state}`);
      if (state === "gone") {
        set(row.key, "closed");
        recorded("gone");
        continue;
      }
      set(row.key, "reopening");
      await reopenOnce(tr, t, m, id, detail);
      set(row.key, "reopened");
      recorded("still");
    } catch (e) {
      io.log(`intake ${id}: recheck ${row.key} failed: ${(e as Error).message}`);
    }
  }
}

export const fixesMarker = (shortId: string) => `tender-intake-fixes: ${shortId}`;
export const recheckMarker = (rule: string, key: string) => `tender-intake-recheck: ${rule}:${key}`;
const rechecked = async (tr: Tracker, t: Ticket, m: string) => (await tr.comments(t, 0)).some((c) => hasMarker(c.body, m));
/** Untrusted text with `tender-intake` and `tender-guardrail` broken, so it cannot plant one of tender's markers. */
export const defang = (s: string) => s.replace(/tender-(intake|guardrail)/gi, "tender_$1");

// The marked comment is the tracker's once-ever record, so it must land before the reopen; with the db lost, its presence stops any retry.
// shortcut: a reopen that lands but reports failure, then a human close before the next run, gets reopened again; read the issue timeline if that bites.
async function reopenOnce(tr: Tracker, t: Ticket, m: string, id: string, detail: string) {
  if (!(await rechecked(tr, t, m))) await tr.comment(t, `intake ${id} still sees this after it was done, so it is reopened without the ready label.${detail ? ` ${defang(unmention(detail))}` : ""}\n\n${m}`);
  await tr.reopen(t);
}

// The latest merge of the ticket's agent branch; undefined when tender did not open one, so observed-Done time stands in.
async function mergedAt(io: Io, repo: string, id: string) {
  try {
    const prs: any[] = JSON.parse(await read(io, ["gh", "pr", "list", "--repo", repo, "--head", `agent/${id}`, "--state", "merged", "--json", "mergedAt"]));
    const at = Math.max(...prs.map((p) => Date.parse(p?.mergedAt)).filter(Number.isFinite));
    return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
  } catch (e) {
    io.log(`intake: merge time of ${repo}/${id} unknown, using now: ${(e as Error).message}`);
  }
}

async function collect(cfg: Config, io: Io, db: Database, save: Save, tr: Tracker, s: Source, target: Target, id: string, rule: IntakeRule, script: Script, now: number) {
  const iso = new Date(now).toISOString();
  const found = parseCollect(await script([]));
  let filed = 0;
  for (const f of found) {
    const m = marker(id, f.key);
    const row = db.query<Seen, [string, string]>("SELECT * FROM intake_seen WHERE rule = ? AND key = ?").get(id, f.key);
    if (row?.ticket_url) {
      const t = ticketAt(row.ticket_url, target.repo);
      const since = Date.parse(row.commented_at ?? row.filed_at ?? iso);
      const note = t && ["open", "reopened"].includes(row.state) && now - since >= DAY && changed(JSON.parse(row.facts ?? "{}"), f.facts);
      save(`UPDATE intake_seen SET last_seen_at = ?${note ? ", facts = ?, commented_at = ?" : ""} WHERE rule = ? AND key = ?`, iso, ...(note ? [JSON.stringify(f.facts), iso] : []), id, f.key);
      if (note && t) await tr.comment(t, `intake ${id} still sees this: ${defang(factLine(f.facts))}`);
      continue;
    }
    const upsert = (url: string | null, state: string) =>
      save(
        "INSERT INTO intake_seen (rule, key, ticket_url, filed_at, last_seen_at, state, facts) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (rule, key) DO UPDATE SET ticket_url = excluded.ticket_url, filed_at = excluded.filed_at, last_seen_at = excluded.last_seen_at, state = excluded.state, facts = excluded.facts",
        id, f.key, url, url ? iso : null, iso, state, JSON.stringify(f.facts),
      );
    if (filed >= rule.maxPerRun) {
      io.log(`intake ${id}: maxPerRun ${rule.maxPerRun} reached, ${f.key} waits for the next run`);
      continue;
    }
    const existing = await tr.findMarker(target, m);
    if (existing) {
      io.log(`intake ${id}: ${f.key} already filed as ${clean(existing)}`);
      upsert(ticketAt(existing, target.repo) ? existing : null, "open");
      continue;
    }
    filed++;
    // Script text is defanged, so only tender can write this line, and it sits before the truncatable body.
    const head = `Untrusted data from tender intake rule ${id}, not reviewed by a human.\n\n${f.fixes ? `${fixesMarker(f.fixes)}\n\n` : ""}`;
    const foot = `\n\n${m}`;
    const text = sanitized(f.title, f.body);
    const title = defang(text.title);
    const body = head + defang(text.body).slice(0, MAX_BODY - head.length - foot.length) + foot;
    const labels = [...rule.labels, ...(autoLabels(rule.autoLabel, f.facts) ? readyLabels(cfg, s) : [])];
    upsert(null, "filing");
    const url = await tr.fileTicket(target, title, body, labels);
    if (io.dry) continue;
    const t = ticketAt(url, target.repo);
    if (!t) {
      io.log(`intake ${id}: unexpected ticket URL ${clean(url)} for ${f.key}; the marker search finds it next run`);
      continue;
    }
    upsert(url, "open");
    io.event?.("intake-filed", target.repo, t.id, { rule: id, key: f.key, labels });
  }
}
