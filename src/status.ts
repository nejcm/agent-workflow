import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENTS, type Lookup } from "./agents";
import { repoDir } from "./config";
import { PR_URL } from "./github";
import { windows, winName } from "./launcher";
import { worktreeIds } from "./pass";
import { phaseProgress, type PhaseStatus } from "./phases";
import { resolve, type State } from "./state";
import { transcript, withFile } from "./tail";
import type { Config, Io, Repo } from "./types";
import { clean, mtime } from "./util";

export interface Row {
  id: string;
  repo: string;
  agent: Repo["agent"];
  /** tmux/marker view: `running` has a window, `ended` an `<ID>.ended`, `orphan` neither. */
  session: "running" | "ended" | "orphan";
  state: State;
  stateSince: number | null;
  waitingFor: string | null;
  runtimeMs: number | null;
  idleMs: number | null;
  startedAt: number | null;
  phases: { done: number; total: number; items: PhaseItem[] } | null;
  pr: string | null;
  /** "held": aw decided not to auto-merge the PR's current head (the `<ID>.merge` marker). */
  merge: "held" | null;
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
export function rows(cfg: Config, wins: Map<string, string>, home = homedir(), now = Date.now(), feeds: Partial<Record<Repo["agent"], Lookup>> = {}): Row[] {
  return Object.values(cfg.repos).flatMap((r) => {
    const dir = repoDir(cfg, r.key);
    return worktreeIds(dir).sort().map((id): Row => {
      const wt = join(dir, id);
      const started = mtime(join(dir, `${id}.sh`)) ?? mtime(wt);
      const ended = mtime(join(dir, `${id}.ended`));
      const t = transcript(wt, r.agent, home, started) ?? null;
      const session = ended !== undefined ? "ended" : wins.has(winName(r.key, id)) ? "running" : "orphan";
      const idleMs = t ? Math.max(0, now - (mtime(t) ?? now)) : null;
      const live = resolve(session, feeds[r.agent]?.(wt, started ?? 0, now), idleMs, now);
      return {
        id,
        repo: r.key,
        agent: r.agent,
        session,
        state: live.state,
        stateSince: live.since,
        waitingFor: live.waitingFor,
        startedAt: started ?? null,
        runtimeMs: started === undefined ? null : Math.max(0, (ended ?? now) - started),
        idleMs,
        phases: progress(dir, id),
        pr: savedPr(dir, id),
        merge: existsSync(join(dir, `${id}.merge`)) ? "held" : null,
        transcript: t,
        window: session === "running" ? wins.get(winName(r.key, id)) ?? null : null,
      };
    });
  });
}

/** Rows with live state; prepares an agent's feed (once) only while one of its repos has a tmux window. */
export async function snapshot(cfg: Config, io: Io, home = homedir(), now = Date.now(), prepare = (a: Repo["agent"]) => AGENTS[a].live(home)) {
  const wins = await windows(cfg, io);
  const up = new Set([...wins.keys()].flatMap((w) => cfg.repos[w.slice(0, w.lastIndexOf("/"))]?.agent ?? []));
  return rows(cfg, wins, home, now, Object.fromEntries(await Promise.all([...up].map(async (a) => [a, await prepare(a)]))));
}

export const dur = (ms: number | null) => {
  if (ms === null) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
};

/** `state`, except a session with neither tmux window nor `.ended` marker shows as `orphan`. */
export const label = (r: Pick<Row, "session" | "state">) => (r.session === "orphan" ? "orphan" : r.state);

export const prLabel = (r: Row) => [r.pr && `#${/\d+$/.exec(r.pr)![0]}`, r.merge].filter(Boolean).join(" ") || "-";

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
