import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { combine, parseRepoConfig, repoConfig } from "./config/repo-config";
import { DB_FILE } from "./db";
import { baseBranch, canonical, sameRepo } from "./github";
import { ticketAt } from "./intake";
import { agentTicket } from "./prs";
import { prMode, trustRule } from "./review/merge";
import type { AutoMerge, Config, Io, Session } from "./types";
import { read } from "./util";

const DAY = 86_400_000;
export const DEFAULT_DAYS = 90;
// shortcut: at most 500 PRs opened in the window per repo (newest first); page with `gh api` if a repo opens more.
export const LIMIT = 500;
const FIELDS = "number,url,state,headRefName,headRefOid,isCrossRepository,createdAt,mergedAt,body,files";
// GitHub's revert button writes this line; a hand-made revert has no such line and is not counted.
const REVERTS = /^Reverts ([\w.-]+\/[\w.-]+)#(\d+)\b/m;
const REST = "(rest)";
const MIXED = "(mixed)";
/** A path is recommended one mode up only with this many merged PRs in the window and no revert. */
export const MIN_MERGED = 20;
/** Moving `shadow` to `intelligent` also needs this many shadow decisions, agreeing at this rate. */
export const MIN_SHADOW = 20;
export const MIN_AGREE = 0.95;

interface ListedPr {
  number: number;
  url: string;
  state: string;
  headRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
  createdAt: string;
  mergedAt: string | null;
  body: string;
  // GraphQL's list has no rename old path and stops at 100 files, so those PRs go under MIXED.
  files: { path: string; changeType?: string }[] | null;
}

export interface PathStats {
  path: string;
  /** Null for MIXED, whose PRs ran under no single path's mode. */
  mode: AutoMerge | null;
  merged: number;
  reverted: number;
  /** Mean feedback rounds per merged PR, from this host's events. */
  rounds: number | null;
  medianHoursToMerge: number | null;
  shadow: { agreed: number; total: number };
  recommend?: AutoMerge;
}

export interface RepoStats {
  repo: string;
  truncated: boolean;
  error?: string;
  /** Set when `.tender/` could not be read: paths assume no trust rules and no path is recommended. */
  configError?: string;
  paths: PathStats[];
  judge: { agreed: number; disagreed: number; ignored: number };
  recheck: { rechecked: number; reopened: number };
}

type Ev = { id: number; repo: string; ticket: string; kind: string; data: string | null };
type Seen = Map<string, string>;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return !s.length ? null : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const round1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

/** One mode up when the path's record clears the thresholds; never from `off` or past `all`. */
export function recommend(p: Pick<PathStats, "mode" | "merged" | "reverted" | "shadow">): AutoMerge | undefined {
  if (p.reverted || p.merged < MIN_MERGED) return;
  if (p.mode === "shadow" && p.shadow.total >= MIN_SHADOW && p.shadow.agreed / p.shadow.total >= MIN_AGREE) return "intelligent";
  if (p.mode === "intelligent") return "all";
}

// The trust rule every file falls under, REST when none matches any, else MIXED (several, or a file list that may be incomplete).
function pathOf(s: Session, pr: ListedPr) {
  const files = pr.files ?? [];
  if (!files.length || files.length >= 100 || files.some((f) => f.changeType === "RENAMED")) return MIXED;
  const rules = new Set(files.map((f) => trustRule(s, f.path)));
  const [only] = rules;
  return rules.size > 1 ? MIXED : only ? only.paths.join(", ") : REST;
}

async function session(io: Io, cfg: Config, key: string) {
  const r = cfg.repos[key]!;
  const base = await baseBranch(io, r);
  const c = await repoConfig(io, r, base).catch((e: Error) => ({ error: e.message, config: undefined }));
  if (!c.config) io.log(`stats ${key}: .tender/ unreadable, so paths are guessed and nothing is recommended: ${c.error}`);
  return { s: combine(r, base, c.config ?? parseRepoConfig([])), configError: c.config ? undefined : c.error };
}

async function repoStats(cfg: Config, io: Io, key: string, evs: Ev[], seen: Seen, since: number): Promise<RepoStats> {
  const mine = evs.filter((e) => e.repo === key);
  const data = (e: Ev) => JSON.parse(e.data ?? "{}");
  const judge = { agreed: 0, disagreed: 0, ignored: 0 };
  for (const v of mine.filter((e) => e.kind === "judge")) {
    const d = data(v);
    if (d.fromComment) continue;
    const worked = mine.some((e) => e.kind === "start" && e.ticket === v.ticket && e.id > v.id);
    const state = seen.get(`${d.rule}\0${v.ticket}`);
    const closed = !worked && (state === "done" || state === "closed");
    if (!worked && !closed) judge.ignored++;
    else if ((d.labels?.length > 0) === worked) judge.agreed++;
    else judge.disagreed++;
  }
  const rechecks = mine.filter((e) => e.kind === "recheck");
  const out: RepoStats = { repo: key, truncated: false, paths: [], judge, recheck: { rechecked: rechecks.length, reopened: rechecks.filter((e) => data(e).state === "still").length } };

  let list: ListedPr[];
  let s: Session;
  try {
    const name = await canonical(io, key);
    if (!name || !sameRepo(name, key)) throw new Error("GitHub resolves it to another repo");
    let configError: string | undefined;
    ({ s, configError } = await session(io, cfg, key));
    if (configError) out.configError = configError;
    const day = new Date(since).toISOString().slice(0, 10);
    list = JSON.parse(await read(io, ["gh", "pr", "list", "--repo", key, "--state", "all", "--search", `created:>=${day}`, "--limit", String(LIMIT), "--json", FIELDS]));
  } catch (e) {
    io.log(`stats ${key}: skipped: ${(e as Error).message}`);
    return { ...out, error: (e as Error).message };
  }
  out.truncated = list.length >= LIMIT;
  list = list.filter((p) => Date.parse(p.createdAt) >= since);
  const reverted = new Set(
    list.flatMap((p) => {
      const m = p.state === "MERGED" ? REVERTS.exec(p.body ?? "") : null;
      return m && sameRepo(m[1]!, key) && Number(m[2]) < p.number ? [Number(m[2])] : [];
    }),
  );
  const rounds = (id: string) => mine.filter((e) => e.kind === "feedback-round" && e.ticket === id).length;
  const auto = new Set(mine.filter((e) => e.kind === "merged" && data(e).auto).map((e) => data(e).pr));
  const shadow = new Map(mine.filter((e) => e.kind === "gate" && data(e).mode === "shadow").map((e) => [data(e).pr as string, data(e)]));
  const paths = new Map<string, { merged: ListedPr[]; shadow: { agreed: number; total: number } }>();
  for (const pr of list) {
    if (!agentTicket(pr)) continue;
    const path = pathOf(s, pr);
    const p = paths.get(path) ?? paths.set(path, { merged: [], shadow: { agreed: 0, total: 0 } }).get(path)!;
    if (pr.state === "MERGED") p.merged.push(pr);
    const g = shadow.get(pr.url);
    if (!g || pr.state === "OPEN" || auto.has(pr.url)) continue;
    const unchanged = pr.state === "MERGED" && pr.headRefOid === g.head;
    p.shadow.total++;
    if (g.merge === unchanged) p.shadow.agreed++;
  }
  const last = (x: string) => [REST, MIXED].indexOf(x);
  for (const [path, p] of [...paths].sort(([a], [b]) => last(a) - last(b) || a.localeCompare(b))) {
    const rule = s.trust.find((t) => t.paths.join(", ") === path);
    const st: PathStats = {
      path,
      mode: path === MIXED ? null : prMode({ autoMerge: rule?.autoMerge ?? s.autoMerge, ceiling: s.ceiling, trust: [] }),
      merged: p.merged.length,
      reverted: p.merged.filter((x) => reverted.has(x.number)).length,
      rounds: round1(p.merged.length ? p.merged.reduce((n, x) => n + rounds(agentTicket(x)!), 0) / p.merged.length : null),
      medianHoursToMerge: round1(median(p.merged.map((x) => (Date.parse(x.mergedAt!) - Date.parse(x.createdAt)) / 3_600_000))),
      shadow: p.shadow,
    };
    st.recommend = out.configError ? undefined : recommend(st);
    out.paths.push(st);
  }
  return out;
}

const UNSEEN = {
  intelligent: "hand-made reverts are not counted",
  all: "the sample cannot show how large changes, edited tests and unassessed medium changes fare, which `all` also merges",
};

export const SHADOW_ASSUMES = "shadow agreement assumes one host makes merge decisions per repo: another host's auto-merge counts as a human merge";

/** The recommendation line for one path, or undefined. */
export const advice = (repo: string, p: PathStats) =>
  p.recommend && `${repo} ${p.path}: ${p.merged} merged, ${p.reverted} reverts${p.shadow.total ? `, shadow agreed ${p.shadow.agreed}/${p.shadow.total}` : ""} → consider \`${p.recommend}\` (now \`${p.mode}\`): thresholds met, but ${UNSEEN[p.recommend as keyof typeof UNSEEN]}`;

// Read-only: never creates or migrates (SQLite may still create the WAL's -wal and -shm sidecars).
function history(file: string, since: string): { evs: Ev[]; seen: Seen } {
  if (!existsSync(file)) return { evs: [], seen: new Map() };
  const db = new Database(file, { readonly: true });
  try {
    const has = (t: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const evs = has("events") ? db.query<Ev, [string]>("SELECT id, repo, ticket, kind, data FROM events WHERE at >= ? ORDER BY id").all(since) : [];
    const rows = has("intake_seen") ? db.query<{ rule: string; ticket_url: string; state: string }, []>("SELECT rule, ticket_url, state FROM intake_seen WHERE ticket_url IS NOT NULL").all() : [];
    const seen: Seen = new Map(
      rows.flatMap((r) => {
        const t = ticketAt(r.ticket_url, r.rule.slice(0, r.rule.lastIndexOf(":")));
        return t ? [[`${r.rule}\0${t.id}`, r.state] as const] : [];
      }),
    );
    return { evs, seen };
  } finally {
    db.close();
  }
}

/** Read-only trust signals per repo and trust path over the last `days`: GitHub for PRs, `tender.db` for decisions. */
export async function stats(cfg: Config, io: Io, { days = DEFAULT_DAYS, now = Date.now() } = {}) {
  const since = now - days * DAY;
  const { evs, seen } = history(join(cfg.workspaceRoot, DB_FILE), new Date(since).toISOString());
  const repos: RepoStats[] = [];
  for (const key of Object.keys(cfg.repos)) repos.push(await repoStats(cfg, io, key, evs, seen, since));
  return { host: cfg.host, days, since: new Date(since).toISOString(), limit: LIMIT, shadowAssumes: SHADOW_ASSUMES, repos, recommendations: repos.flatMap((r) => r.paths.flatMap((p) => advice(r.repo, p) ?? [])) };
}

const cell = (x: number | null) => (x === null ? "-" : String(x));

/** The `stats` result as one table per repo, then the recommendations. */
export function statsTable(r: Awaited<ReturnType<typeof stats>>) {
  const head = ["path", "mode", "merged", "reverted", "rounds", "hours", "shadow"];
  const lines = [`tender stats on ${r.host}: agent PRs opened since ${r.since.slice(0, 10)} (${r.days} days), at most ${r.limit} PRs per repo`];
  for (const repo of r.repos) {
    lines.push("", repo.repo + (repo.error ? `: skipped, ${repo.error}` : repo.truncated ? `: ${r.limit} PRs listed, the limit, so older ones may be missing` : ""));
    const rows = [head, ...repo.paths.map((p) => [p.path, p.mode ?? "-", String(p.merged), String(p.reverted), cell(p.rounds), cell(p.medianHoursToMerge), p.shadow.total ? `${p.shadow.agreed}/${p.shadow.total}` : "-"])];
    const w = head.map((_, i) => Math.max(...rows.map((x) => x[i]!.length)));
    if (repo.paths.length) lines.push(...rows.map((x) => `  ${x.map((c, i) => c.padEnd(w[i]!)).join("  ").trimEnd()}`));
    if (repo.configError) lines.push(`  no recommendations: .tender/ unreadable, paths assume no trust rules: ${repo.configError}`);
    const j = repo.judge;
    lines.push(`  judge: ${j.agreed} agreed, ${j.disagreed} disagreed, ${j.ignored} not acted on; recheck: ${repo.recheck.reopened} of ${repo.recheck.rechecked} reopened`);
  }
  lines.push("", ...(r.recommendations.length ? r.recommendations : ["No recommendations."]), "", `Note: ${r.shadowAssumes}.`);
  return lines.join("\n");
}
