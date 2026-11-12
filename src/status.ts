import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoDir } from "./config";
import { winName } from "./launcher";
import { worktreeIds } from "./pass";
import { readPhases } from "./phases";
import { clean, lines, mtime, transcript, withFile } from "./tail";
import type { Config, Repo } from "./types";

export interface Row {
  id: string;
  repo: string;
  agent: Repo["agent"];
  state: "running" | "ended" | "orphan";
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

export function rows(cfg: Config, wins: Map<string, string>, home = homedir(), now = Date.now()): Row[] {
  return Object.values(cfg.repos).flatMap((r) => {
    const dir = repoDir(cfg, r.key);
    return worktreeIds(dir).sort().map((id): Row => {
      const wt = join(dir, id);
      const started = mtime(join(dir, `${id}.sh`)) ?? mtime(wt);
      const ended = mtime(join(dir, `${id}.ended`));
      const t = transcript(wt, r.agent, home, started) ?? null;
      return {
        id,
        repo: r.key,
        agent: r.agent,
        state: ended !== undefined ? "ended" : wins.has(winName(r.key, id)) ? "running" : "orphan",
        runtimeMs: started === undefined ? null : Math.max(0, (ended ?? now) - started),
        idleMs: t ? Math.max(0, now - (mtime(t) ?? now)) : null,
        phases: progress(wt, join(dir, `${id}.phases.json`)),
        pr: t ? prOf(t) : null,
        merge: existsSync(join(dir, `${id}.merge`)) ? "held" : null,
        transcript: t,
      };
    });
  });
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
    r.state,
    dur(r.runtimeMs),
    dur(r.idleMs),
    r.phases ? `${r.phases.done}/${r.phases.total}` : "-",
    [r.pr && `#${/\d+$/.exec(r.pr)![0]}`, r.merge].filter(Boolean).join(" ") || "-",
  ]);
  const all = [["ID", "REPO", "AGENT", "STATE", "RUNTIME", "IDLE", "PHASES", "PR"], ...cells].map((c) => c.map((x) => clean(x, 80)));
  const w = all[0]!.map((_, i) => Math.max(...all.map((c) => c[i]!.length)));
  return all.map((c) => c.map((x, i) => x.padEnd(w[i]!)).join("  ").trimEnd()).join("\n");
}
