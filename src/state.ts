export type State = "working" | "waiting" | "idle" | "ended" | "unknown";
export interface Live {
  state: State;
  /** ms epoch the state was recorded; null when the feed does not say. */
  since: number | null;
  waitingFor: string | null;
}

export const UNKNOWN: Live = { state: "unknown", since: null, waitingFor: null };
const ENDED: Live = { state: "ended", since: null, waitingFor: null };
export const STALE_MS = 10 * 60_000;

/** Ended/orphan sessions are ended; else the live feed, with a stale "working" (no transcript write either) as unknown. */
export function resolve(session: "running" | "ended" | "orphan", live: Live | undefined, idleMs: number | null, now: number): Live {
  if (session !== "running") return ENDED;
  if (!live) return UNKNOWN;
  const stale = live.state === "working" && live.since !== null && now - live.since > STALE_MS && (idleMs === null || idleMs > STALE_MS);
  return stale ? UNKNOWN : live;
}
