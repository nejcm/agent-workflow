import { lstatSync, opendirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Live, State } from "./state";
import type { Repo } from "./types";
import { clean, inDir, readAw, readIn } from "./util";

export type Lookup = (wt: string, since: number, now: number) => Live | undefined;

export interface Agent {
  /** The script's env line and command; every argument is already a shell word. */
  launch(wt: string, prompt: string, nono: boolean): [env: string, argv: string[]];
  /** The ticket's config dir and its subdir that holds every transcript of `wt`. */
  store(wt: string): [home: string, sub: string];
  /** Transcript files that may belong to `wt`; the caller matches them on the recorded cwd. */
  transcripts(wt: string, home: string): string[];
  /** The cwd a transcript line records, if any. */
  cwd(entry: any): unknown;
  /** Once per snapshot for the worktrees in `wts`; the lookup gives a worktree's live state. */
  live(home: string, wts: string[]): Promise<Lookup>;
}

const CLAUDE = new Map<unknown, State>([["busy", "working"], ["waiting", "waiting"], ["idle", "idle"]]);
const HOOK_STATES = new Set<unknown>(["working", "waiting", "idle", "ended"]);
const MAX_SESSION = 64 * 1024;
const MAX_FILE = 4096;

/** A `claude setup-token` token, relative to home; read by the launch script on the host, outside the sandbox. */
export const CLAUDE_TOKEN = ".claude-aw/oauth-token";
/** The ticket's own Claude config dir, a sidecar of its worktree. */
export const claudeHome = (wt: string) => `${wt}.claude`;
/** The ticket's own CODEX_HOME, a sidecar of its worktree; Claude sessions get one too, to run Codex. */
export const codexHome = (wt: string) => `${wt}.codex`;
/** The session's TMPDIR, made fresh on the host at each start; a sidecar, so nothing in it shows in the clone. */
export const tmpHome = (wt: string) => `${wt}.tmpdir`;

/** Claude Code's project dir name for a cwd: every non-alphanumeric char becomes "-". */
export const claudeDir = (wt: string) => join(claudeHome(wt), "projects", wt.replace(/[^A-Za-z0-9]/g, "-"));

// Hand-walked: Bun's recursive readdir follows symlinked dirs, so a planted link could loop or walk the whole disk.
function jsonl(dir: string, recursive = false): string[] {
  try {
    if (!lstatSync(dir).isDirectory()) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      return recursive && e.isDirectory() ? jsonl(p, true) : e.isFile() && e.name.endsWith(".jsonl") ? [p] : [];
    });
  } catch {
    return [];
  }
}

/** Claude's session records as live state by exact cwd, newest session wins. */
export function parseAgents(list: unknown[]): Map<string, Live> {
  const m = new Map<string, Live & { at: number }>();
  for (const a of list as any[]) {
    if (!a || typeof a !== "object" || typeof a.cwd !== "string" || a.cwd.length > 4096) continue;
    const at = typeof a.startedAt === "number" && Number.isFinite(a.startedAt) ? a.startedAt : 0;
    if ((m.get(a.cwd)?.at ?? -1) > at) continue;
    const state = CLAUDE.get(a.status) ?? "unknown";
    const waitingFor = state === "waiting" && typeof a.waitingFor === "string" ? clean(a.waitingFor, 60) || null : null;
    m.set(a.cwd, { state, since: null, waitingFor, at });
  }
  return new Map([...m].map(([cwd, { at, ...l }]) => [cwd, l]));
}

const startTime = (pid: number) => {
  const s = readFileSync(`/proc/${pid}/stat`, "utf8");
  return s.slice(s.lastIndexOf(")") + 2).split(" ")[19];
};

/** `<dir>/sessions/<pid>.json` records whose process is still running, the files `claude agents` reads; never runs the agent-writable config. */
export function claudeSessions(dir: string): unknown[] {
  const sessions = join(dir, "sessions");
  let names: string[];
  try {
    names = inDir(sessions, (d) => {
      const it = opendirSync(d);
      try {
        const out: string[] = [];
        // The session can flood its own dir; inspect a bounded number of entries.
        for (let e, n = 0; n < 1000 && (e = it.readSync()); n++) out.push(e.name);
        return out;
      } finally {
        it.closeSync();
      }
    });
  } catch {
    return [];
  }
  return names.filter((f) => /^[1-9]\d{0,9}\.json$/.test(f)).slice(0, 100).flatMap((f) => {
    try {
      const s = JSON.parse(readIn(sessions, f, MAX_SESSION) ?? "null");
      // The recorded start time tells a live session from a recycled pid.
      return s?.pid === Number.parseInt(f) && typeof s.procStart === "string" && s.procStart === startTime(s.pid) ? [s] : [];
    } catch {
      return [];
    }
  });
}

/** `<wt>/.aw/codex-state.json` as written by aw's Codex hooks, if well-formed and recorded since `since` (ms). */
export function codexState(wt: string, since: number, now: number): Live | undefined {
  let o: any;
  try {
    o = JSON.parse(readAw(wt, "codex-state.json", MAX_FILE) ?? "");
  } catch {
    return undefined;
  }
  // The hook stamps whole seconds, so a state written in the launch second can predate the launcher's mtime.
  const ok = o && typeof o === "object" && HOOK_STATES.has(o.state) && typeof o.ts === "number" && o.ts >= since - 1000 && o.ts <= now + 60_000;
  return ok ? { state: o.state, since: o.ts, waitingFor: o.state === "waiting" ? "permission" : null } : undefined;
}

export const AGENTS: Record<Repo["agent"], Agent> = {
  claude: {
    launch: (wt, prompt) => [`CLAUDE_CODE_OAUTH_TOKEN="$(cat "$HOME/${CLAUDE_TOKEN}")" || exit 1\nexport CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR=${claudeHome(wt)} CODEX_HOME=${codexHome(wt)} CLAUDE_CODE_TMPDIR=${tmpHome(wt)}`, ["claude", "--permission-mode", "bypassPermissions", prompt]],
    store: (wt) => [claudeHome(wt), "projects"],
    transcripts: (wt) => jsonl(claudeDir(wt)),
    cwd: (o) => o?.cwd,
    live: async (_home, wts) => {
      const ms = wts.map((wt) => parseAgents(claudeSessions(claudeHome(wt))));
      return (wt) => ms[wts.indexOf(wt)]?.get(wt);
    },
  },
  codex: {
    // Hook trust is keyed on the config file's path, so every fresh CODEX_HOME would skip the hooks aw seeds from the template.
    launch: (wt, prompt, nono) => [`export CODEX_HOME=${codexHome(wt)}`, ["codex", ...(nono ? ["--no-daemon"] : []), "--dangerously-bypass-hook-trust", "--sandbox", "danger-full-access", "--ask-for-approval", "never", "-C", wt, prompt]],
    store: (wt) => [codexHome(wt), "sessions"],
    transcripts: (wt) => jsonl(join(codexHome(wt), "sessions"), true),
    cwd: (o) => o?.type === "session_meta" && o.payload?.cwd,
    live: async () => codexState,
  },
};
