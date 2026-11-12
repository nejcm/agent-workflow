import { homedir } from "node:os";
import { join } from "node:path";
import { clean } from "./tail";
import { readAw } from "./util";

export type State = "working" | "waiting" | "idle" | "ended" | "unknown";
export interface Live {
  state: State;
  /** ms epoch the state was recorded; null when the feed does not say. */
  since: number | null;
  waitingFor: string | null;
}

export const UNKNOWN: Live = { state: "unknown", since: null, waitingFor: null };
const ENDED: Live = { state: "ended", since: null, waitingFor: null };
const CLAUDE = new Map<unknown, State>([["busy", "working"], ["waiting", "waiting"], ["idle", "idle"]]);
const HOOK_STATES = new Set<unknown>(["working", "waiting", "idle", "ended"]);
const MAX_OUT = 1 << 20;
const MAX_FILE = 4096;
export const STALE_MS = 10 * 60_000;

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
    o = JSON.parse(readAw(wt, "codex-state", MAX_FILE) ?? "");
  } catch {
    return undefined;
  }
  // The hook stamps whole seconds, so a state written in the launch second can predate the launcher's mtime.
  const ok = o && typeof o === "object" && HOOK_STATES.has(o.state) && typeof o.ts === "number" && o.ts >= since - 1000 && o.ts <= now + 60_000;
  return ok ? { state: o.state, since: o.ts, waitingFor: o.state === "waiting" ? "permission" : null } : undefined;
}

/** Ended/orphan sessions are ended; else the live feed, with a stale "working" (no transcript write either) as unknown. */
export function resolve(session: "running" | "ended" | "orphan", live: Live | undefined, idleMs: number | null, now: number): Live {
  if (session !== "running") return ENDED;
  if (!live) return UNKNOWN;
  const stale = live.state === "working" && live.since !== null && now - live.since > STALE_MS && (idleMs === null || idleMs > STALE_MS);
  return stale ? UNKNOWN : live;
}
