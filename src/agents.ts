import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Live, State } from "./state";
import type { Repo } from "./types";
import { clean, readAw } from "./util";

export type Lookup = (wt: string, since: number, now: number) => Live | undefined;

export interface Agent {
  /** The script's env line and command; every argument is already a shell word. */
  launch(wt: string, name: string, prompt: string, nono: boolean): [env: string, argv: string[]];
  /** Transcript files that may belong to `wt`; the caller matches them on the recorded cwd. */
  transcripts(wt: string, home: string): string[];
  /** The cwd a transcript line records, if any. */
  cwd(entry: any): unknown;
  /** Once per snapshot; the lookup gives a worktree's live state. */
  live(home: string): Promise<Lookup>;
}

const CLAUDE = new Map<unknown, State>([["busy", "working"], ["waiting", "waiting"], ["idle", "idle"]]);
const HOOK_STATES = new Set<unknown>(["working", "waiting", "idle", "ended"]);
const MAX_OUT = 1 << 20;
const MAX_FILE = 4096;

/** Claude Code's project dir name for a cwd: every non-alphanumeric char becomes "-". */
export const claudeDir = (home: string, wt: string) => join(home, ".claude-aw", "projects", wt.replace(/[^A-Za-z0-9]/g, "-"));

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

/** `claude agents --json` output as live state by exact cwd; undefined if the output is unusable. */
export function parseAgents(out: string | undefined): Map<string, Live> | undefined {
  if (out === undefined || out.length > MAX_OUT) return undefined;
  let list: unknown;
  try {
    list = JSON.parse(out);
  } catch {
    return undefined;
  }
  if (!Array.isArray(list)) return undefined;
  const m = new Map<string, Live & { at: number }>();
  for (const a of list.slice(0, 1000)) {
    if (!a || typeof a !== "object" || typeof a.cwd !== "string" || a.cwd.length > 4096) continue;
    const at = typeof a.startedAt === "number" && Number.isFinite(a.startedAt) ? a.startedAt : 0;
    if ((m.get(a.cwd)?.at ?? -1) > at) continue;
    const state = CLAUDE.get(a.status) ?? "unknown";
    const waitingFor = state === "waiting" && typeof a.waitingFor === "string" ? clean(a.waitingFor, 60) || null : null;
    m.set(a.cwd, { state, since: null, waitingFor, at });
  }
  return new Map([...m].map(([cwd, { at, ...l }]) => [cwd, l]));
}

/** Raw `claude agents --json` stdout for aw's config dir; undefined on spawn failure, non-zero exit, oversize output or timeout. */
export async function claudeAgents(home = homedir(), ms = 3000, argv = ["claude", "agents", "--json"]): Promise<string | undefined> {
  let p: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    p = Bun.spawn(argv, { env: { ...process.env, CLAUDE_CONFIG_DIR: join(home, ".claude-aw") }, stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true });
  } catch {
    return undefined;
  }
  // Own process group, so a child ignoring SIGTERM or a grandchild holding stdout dies with it.
  const kill = () => {
    try {
      process.kill(-p.pid, "SIGKILL");
    } catch {}
  };
  const read = (async () => {
    const chunks: Uint8Array[] = [];
    let n = 0;
    for await (const c of p.stdout) {
      if ((n += c.length) > MAX_OUT) return undefined;
      chunks.push(c);
    }
    return (await p.exited) === 0 ? Buffer.concat(chunks).toString("utf8") : undefined;
  })().catch(() => undefined);
  let expire = () => {};
  const deadline = new Promise<undefined>((r) => (expire = () => r(undefined)));
  const timer = setTimeout(expire, ms);
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
    kill();
  }
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
    // Claude sessions run Codex too, so they get aw's CODEX_HOME as well.
    launch: (_wt, name, prompt) => ['export CLAUDE_CONFIG_DIR="$HOME/.claude-aw" CODEX_HOME="$HOME/.codex-aw" CLAUDE_CODE_TMPDIR="$HOME/.claude-aw/tmp"; mkdir -p "$CLAUDE_CODE_TMPDIR"', ["claude", "--remote-control", name, "--permission-mode", "bypassPermissions", prompt]],
    transcripts: (wt, home) => jsonl(claudeDir(home, wt)),
    cwd: (o) => o?.cwd,
    live: async (home) => {
      const m = parseAgents(await claudeAgents(home));
      return (wt) => m?.get(wt);
    },
  },
  codex: {
    launch: (wt, _name, prompt, nono) => ['export CODEX_HOME="$HOME/.codex-aw"', ["codex", ...(nono ? ["--no-daemon"] : []), "--sandbox", "danger-full-access", "--ask-for-approval", "never", "-C", wt, prompt]],
    transcripts: (_wt, home) => jsonl(join(home, ".codex-aw", "sessions"), true),
    cwd: (o) => o?.type === "session_meta" && o.payload?.cwd,
    live: async () => codexState,
  },
};
