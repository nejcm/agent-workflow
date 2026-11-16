import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENTS, agentOf, type Lookup } from "../session/agents";
import { repoDir } from "../config/config";
import { PR_URL } from "../github";
import { handedOff, windows, winName } from "../session/launcher";
import { IN_REVIEW_FILE, readReady, worktreeIds } from "../pass";
import { phaseProgress, type PhaseStatus } from "../review/phases";
import { openQuestion } from "../session/question";
import { resolve, type State } from "../session/state";
import { transcript, withFile } from "./tail";
import type { AgentName, Config, Io } from "../types";
import { clean, mtime } from "../util";

export interface Row {
  id: string;
  repo: string;
  agent: AgentName;
  /** tmux/marker view: `running` has a window, `ended` an `<ID>.ended`, `orphan` neither. */
  session: "running" | "ended" | "handoff" | "orphan";
  state: State;
  stateSince: number | null;
  waitingFor: string | null;
  runtimeMs: number | null;
  idleMs: number | null;
  startedAt: number | null;
  phases: { done: number; total: number; items: PhaseItem[] } | null;
  pr: string | null;
  /** "held": tender already commented on the PR's current head, refused or, in shadow, would merge (the `<ID>.merge` marker). */
  merge: "held" | null;
  /** tender moved the ticket to Ready to merge (the `<ID>.ready` marker, once the move is confirmed). */
  ready: boolean;
  transcript: string | null;
  /** tmux window id (`@3`) while `running`. */
  window: string | null;
}

export interface PhaseItem {
  key: string;
  title: string;
  status: PhaseStatus;
}

function progress(dir: string, id: string) {
  const p = phaseProgress(dir, id);
  return p && { ...p, items: p.items.map((x) => ({ key: clean(x.key, 40), title: clean(x.title, 120), status: x.status })) };
}

const MAX_PR_BYTES = 512;

function savedPr(dir: string, id: string) {
  const url = withFile(join(dir, `${id}.pr`), (fd, st) => (st.size <= MAX_PR_BYTES ? readFileSync(fd, "utf8").trim() : undefined));
  return url && PR_URL.test(url) ? url : null;
}

/** `feeds`: each agent's state lookup (missing: that agent's running rows are unknown). */
export function rows(cfg: Config, wins: Map<string, string>, home = homedir(), now = Date.now(), feeds: Partial<Record<AgentName, Lookup>> = {}): Row[] {
  return Object.values(cfg.repos).flatMap((r) => {
    const dir = repoDir(cfg, r.key);
    return worktreeIds(dir).sort().map((id): Row => {
      const wt = join(dir, id);
      const started = mtime(join(dir, `${id}.sh`)) ?? mtime(wt);
      const ended = mtime(join(dir, `${id}.ended`));
      const agent = agentOf(dir, id);
      const t = transcript(wt, agent, home, started) ?? null;
      const session = ended !== undefined ? "ended" : wins.has(winName(r.key, id)) ? "running" : handedOff(dir, id) ? "handoff" : "orphan";
      const idleMs = t ? Math.max(0, now - (mtime(t) ?? now)) : null;
      const resolved = resolve(session, feeds[agent]?.(wt, started ?? 0, now), idleMs, now);
      const pr = savedPr(dir, id);
      // Answers are only delivered before a PR exists, so an open question after it is not news.
      const live = resolved.state === "idle" && !pr && openQuestion(dir, id) ? { ...resolved, state: "question" as const } : resolved;
      return {
        id,
        repo: r.key,
        agent,
        session,
        state: live.state,
        stateSince: live.since,
        waitingFor: live.waitingFor,
        startedAt: started ?? null,
        runtimeMs: started === undefined ? null : Math.max(0, (ended ?? now) - started),
        idleMs,
        phases: progress(dir, id),
        pr,
        merge: existsSync(join(dir, `${id}.merge`)) ? "held" : null,
        ready: readReady(join(dir, `${id}.ready`))?.step === "moved",
        transcript: t,
        window: session === "running" ? wins.get(winName(r.key, id)) ?? null : null,
      };
    });
  });
}

/** Rows with live state; prepares an agent's feed (once) for the worktrees of its repos that have a tmux window. */
export async function snapshot(cfg: Config, io: Io, home = homedir(), now = Date.now(), prepare = (a: AgentName, wts: string[]) => AGENTS[a].live(home, wts)) {
  const wins = await windows(cfg, io);
  const up = new Map<AgentName, string[]>();
  for (const w of wins.keys()) {
    const key = w.slice(0, w.lastIndexOf("/"));
    const [dir, id] = [repoDir(cfg, key), w.slice(key.length + 1)];
    if (cfg.repos[key]) up.set(agentOf(dir, id), [...(up.get(agentOf(dir, id)) ?? []), join(dir, id)]);
  }
  return rows(cfg, wins, home, now, Object.fromEntries(await Promise.all([...up].map(async ([a, wts]) => [a, await prepare(a, wts)]))));
}

export const dur = (ms: number | null) => {
  if (ms === null) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
};

/** `state`, except a session with neither tmux window nor `.ended` marker shows as `handoff` (with `<ID>.handoff`) or `orphan`. */
export const label = (r: Pick<Row, "session" | "state">) => (r.session === "orphan" || r.session === "handoff" ? r.session : r.state);

export const prLabel = (r: Row) => [r.pr && `#${/\d+$/.exec(r.pr)![0]}`, r.merge, r.ready && "ready"].filter(Boolean).join(" ") || "-";

/** Each `maxInReview` the last pass found reached, as one line; undefined when none is. */
export function reviewLimit(cfg: Config) {
  let counts: Record<string, unknown> = {};
  try {
    counts = JSON.parse(readFileSync(join(cfg.workspaceRoot, IN_REVIEW_FILE), "utf8"));
  } catch {}
  const n = (k?: string) => (k === undefined ? Object.values(counts) : [counts[k]]).reduce((a: number, b) => a + (Number(b) || 0), 0);
  const full = [
    ...(cfg.maxInReview !== undefined && n() >= cfg.maxInReview ? [`${n()}/${cfg.maxInReview} on this host`] : []),
    ...Object.values(cfg.repos).flatMap((r) => (r.maxInReview !== undefined && n(r.key) >= r.maxInReview ? [`${n(r.key)}/${r.maxInReview} in ${r.key}`] : [])),
  ];
  return full.length ? `maxInReview reached, no new starts: ${full.join(", ")}` : undefined;
}

export function table(rs: Row[]) {
  if (!rs.length) return "no worktrees";
  const cells = rs.map((r) => [
    r.id,
    r.repo,
    r.agent,
    r.session,
    r.waitingFor ? `${r.state}: ${r.waitingFor}` : label(r),
    dur(r.runtimeMs),
    dur(r.idleMs),
    r.phases ? `${r.phases.done}/${r.phases.total}` : "-",
    prLabel(r),
  ]);
  const all = [["ID", "REPO", "AGENT", "SESSION", "STATE", "RUNTIME", "IDLE", "PHASES", "PR"], ...cells].map((c) => c.map((x, i) => clean(x, i === 4 ? 30 : 80)));
  const w = all[0]!.map((_, i) => Math.max(...all.map((c) => c[i]!.length)));
  return all.map((c) => c.map((x, i) => x.padEnd(w[i]!)).join("  ").trimEnd()).join("\n");
}
