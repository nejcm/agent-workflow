import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoDir } from "./config";
import { windows, winName } from "./launcher";
import { worktreeIds } from "./pass";
import { readPhases } from "./phases";
import { claudeAgents, codexState, type Live, parseAgents, resolve, type State } from "./state";
import { clean, lines, mtime, transcript, withFile } from "./tail";
import type { Config, Io, Repo } from "./types";

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
  phases: { done: number; total: number } | null;
  pr: string | null;
  /** "held": aw decided not to auto-merge the PR's current head (the `<ID>.merge` marker). */
  merge: "held" | null;
  transcript: string | null;
}

function progress(wt: string, sidecar: string) {
  try {
    const live = readPhases(wt)?.map((p) => p.status);
    const st = live ?? (existsSync(sidecar) ? Object.values(JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, { status: string }>).map((s) => s.status) : undefined);
    return st ? { done: st.filter((s) => s === "done").length, total: st.length } : null;
  } catch {
    return null;
  }
}

// shortcut: scans only the transcript's last 256 KiB, so an older pr-link is missed; remember it per file if that bites.
function prOf(file: string) {
  const text = withFile(file, (fd, st) => lines(fd, st.size, 0).text) ?? "";
  const i = text.lastIndexOf('"type":"pr-link"');
  if (i < 0) return null;
  const end = text.indexOf("\n", i);
  try {
    const url = JSON.parse(text.slice(text.lastIndexOf("\n", i) + 1, end < 0 ? undefined : end)).prUrl;
    return typeof url === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url) ? url : null;
  } catch {
    return null;
  }
}

/** `claude`: live Claude sessions by cwd (undefined: feed unavailable, so Claude rows are unknown). */
export function rows(cfg: Config, wins: Map<string, string>, home = homedir(), now = Date.now(), claude?: Map<string, Live>): Row[] {
  return Object.values(cfg.repos).flatMap((r) => {
    const dir = repoDir(cfg, r.key);
    return worktreeIds(dir).sort().map((id): Row => {
      const wt = join(dir, id);
      const started = mtime(join(dir, `${id}.sh`)) ?? mtime(wt);
      const ended = mtime(join(dir, `${id}.ended`));
      const t = transcript(wt, r.agent, home, started) ?? null;
      const session = ended !== undefined ? "ended" : wins.has(winName(r.key, id)) ? "running" : "orphan";
      const idleMs = t ? Math.max(0, now - (mtime(t) ?? now)) : null;
      const live = resolve(session, r.agent === "claude" ? claude?.get(wt) : codexState(wt, started ?? 0, now), idleMs, now);
      return {
        id,
        repo: r.key,
        agent: r.agent,
        session,
        state: live.state,
        stateSince: live.since,
        waitingFor: live.waitingFor,
        runtimeMs: started === undefined ? null : Math.max(0, (ended ?? now) - started),
        idleMs,
        phases: progress(wt, join(dir, `${id}.phases.json`)),
        pr: t ? prOf(t) : null,
        merge: existsSync(join(dir, `${id}.merge`)) ? "held" : null,
        transcript: t,
      };
    });
  });
}

/** Rows with live state; asks `claude agents` (once) only while a Claude repo has a tmux window. */
export async function snapshot(cfg: Config, io: Io, agents = claudeAgents, home = homedir(), now = Date.now()) {
  const wins = await windows(cfg, io);
  const claudeUp = [...wins.keys()].some((w) => cfg.repos[w.slice(0, w.lastIndexOf("/"))]?.agent === "claude");
  return rows(cfg, wins, home, now, claudeUp ? parseAgents(await agents(home)) : undefined);
}

export const dur = (ms: number | null) => {
  if (ms === null) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
};

export function table(rs: Row[]) {
  if (!rs.length) return "no worktrees";
  const cells = rs.map((r) => [
    r.id,
    r.repo,
    r.agent,
    r.session,
    r.waitingFor ? `${r.state}: ${r.waitingFor}` : r.state,
    dur(r.runtimeMs),
    dur(r.idleMs),
    r.phases ? `${r.phases.done}/${r.phases.total}` : "-",
    [r.pr && `#${/\d+$/.exec(r.pr)![0]}`, r.merge].filter(Boolean).join(" ") || "-",
  ]);
  const all = [["ID", "REPO", "AGENT", "SESSION", "STATE", "RUNTIME", "IDLE", "PHASES", "PR"], ...cells].map((c) => c.map((x, i) => clean(x, i === 4 ? 30 : 80)));
  const w = all[0]!.map((_, i) => Math.max(...all.map((c) => c[i]!.length)));
  return all.map((c) => c.map((x, i) => x.padEnd(w[i]!)).join("  ").trimEnd()).join("\n");
}
