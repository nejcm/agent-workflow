import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkState } from "./merge";
import { agentPane, byOperator, paste } from "./question";
import type { State } from "./state";
import type { Io, Repo, Ticket, TicketComment, Tracker } from "./types";
import { put, read, writeAw } from "./util";

const DEBOUNCE_MS = 2 * 60_000;
export const MAX_ROUNDS = 3;
const MAX_RUNS = 3;
const LOG_LINES = 80;
const MAX_ITEM_CHARS = 8000;
export const FEEDBACK_POINTER = "There is new feedback on your PR: read .aw/feedback.md";

export interface FeedbackCursor {
  /** GitHub time of the newest delivered comment. */
  seenAt: number;
  /** Head SHAs already reported, newest last, at most 10 each. */
  ciShas?: string[];
  dirtyShas?: string[];
  rounds: number;
  capped?: boolean;
}

type Item = TicketComment & { on?: string };

/** Reviews with text (or changes requested), PR comments and line comments, as comments. */
export function prItems(pr: any, lines: any[]): Item[] {
  return [
    ...(pr.reviews ?? []).filter((r: any) => r.body?.trim() || r.state === "CHANGES_REQUESTED").map((r: any) => ({ id: String(r.id), body: r.body?.trim() || "(changes requested)", createdAt: r.submittedAt ?? "", author: r.author?.login })),
    ...(pr.comments ?? []).map((c: any) => ({ id: String(c.id), body: c.body ?? "", createdAt: c.createdAt ?? "", author: c.author?.login })),
    ...lines.map((c: any) => ({ id: String(c.id), body: c.body ?? "", createdAt: c.created_at ?? "", author: c.user?.login, on: `${c.path}:${c.line ?? c.original_line}` })),
  ];
}

const attr = (s: string) => s.replace(/[&"<]/g, (m) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;" })[m]!);
const esc = (s: string) => (s.length > MAX_ITEM_CHARS ? `${s.slice(0, MAX_ITEM_CHARS)}\n[truncated]` : s).replace(/<\/(feedback|comment|log)/gi, "&lt;/$1");

async function failedLog(io: Io, repo: string, run: string) {
  try {
    // tail streams, so a huge log is never buffered.
    const out = (await read(io, ["sh", "-c", `gh run view "$1" --repo "$2" --log-failed | tail -n ${LOG_LINES}`, "sh", run, repo])).trimEnd();
    return out || "(log unavailable)";
  } catch (e) {
    return `(log unavailable: ${(e as Error).message})`;
  }
}

// The cursor is recorded first: a crash or failure after it loses the paste, never repeats it. Text never goes through keys.
export async function deliverFeedback(r: Repo, t: Ticket, tr: Tracker, io: Io, dir: string, win: string | undefined, state: () => Promise<State>, warned: Set<string>) {
  const prFile = join(dir, `${t.id}.pr`);
  const url = existsSync(prFile) ? readFileSync(prFile, "utf8") : "";
  const n = /\/pull\/(\d+)$/.exec(url)?.[1];
  const file = join(dir, `${t.id}.feedback`);
  const saved: FeedbackCursor = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { seenAt: 0, rounds: 0 };
  if (!n || (win && !/^@\d+$/.test(win))) return;
  // A capped cursor on an unparked ticket means a human removed the label; confirm fresh (a failed read throws) before the rounds restart.
  if (saved.capped && (await tr.parked(t))) return;
  const cur: FeedbackCursor = saved.capped ? { ...saved, rounds: 0, capped: undefined } : saved;
  const talk = r.feedbackAuthors.length > 0;
  const pr = JSON.parse(await read(io, ["gh", "pr", "view", n, "--repo", r.key, "--json", `state,baseRefName,headRefOid,mergeStateStatus,statusCheckRollup${talk ? ",reviews,comments" : ""}`]));
  if (pr.state !== "OPEN") return;
  // shortcut: first 100 line comments only; paginate if a PR ever gets more.
  const lines = talk ? JSON.parse(await read(io, ["gh", "api", `repos/${r.key}/pulls/${n}/comments?per_page=100`])) : [];
  const ok = byOperator(r.feedbackAuthors);
  const items = prItems(pr, lines)
    .filter((c) => Date.parse(c.createdAt) > cur.seenAt && ok(c))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const newest = items.length ? Date.parse(items.at(-1)!.createdAt) : undefined;
  if (newest !== undefined && Date.now() - newest < DEBOUNCE_MS) return;
  const checks: any[] = pr.statusCheckRollup ?? [];
  const failed = !cur.ciShas?.includes(pr.headRefOid) && !checks.some((c) => checkState(c) === "pending") ? checks.filter((c) => checkState(c) === "failed") : [];
  const dirty = pr.mergeStateStatus === "DIRTY" && !cur.dirtyShas?.includes(pr.headRefOid);
  if (!items.length && !failed.length && !dirty) return;
  if (!win) {
    const seen = `${file}@${newest ?? cur.seenAt}@${pr.headRefOid}`;
    if (!warned.has(seen)) io.log(`${t.id}: PR feedback pending but the session's window is gone; restart it or act on ${url} by hand`);
    return void warned.add(seen);
  }
  if (cur.rounds >= MAX_ROUNDS) {
    // Label first: if adding it fails, this retries next poll instead of leaving a capped cursor that reads as resumed.
    await tr.park(t);
    put(io, file, JSON.stringify({ ...cur, capped: true } satisfies FeedbackCursor));
    return tr.comment(t, `PR feedback stopped after ${MAX_ROUNDS} rounds on ${url}: a human is needed`);
  }
  if ((await state()) !== "idle") return;
  const pane = await agentPane(io, win, `${join(dir, t.id)}.sh`);
  if (!pane) return;
  const runs = [...new Set(failed.map((c) => /\/actions\/runs\/(\d+)/.exec(c.detailsUrl ?? c.targetUrl ?? "")?.[1]).filter((x): x is string => !!x))].slice(0, MAX_RUNS);
  const logs = await Promise.all(runs.map((id) => failedLog(io, r.key, id)));
  put(io, file, JSON.stringify({ seenAt: newest ?? cur.seenAt, ciShas: failed.length ? [...(cur.ciShas ?? []), pr.headRefOid].slice(-10) : cur.ciShas, dirtyShas: dirty ? [...(cur.dirtyShas ?? []), pr.headRefOid].slice(-10) : cur.dirtyShas, rounds: cur.rounds + 1 } satisfies FeedbackCursor));
  const text = [
    `<feedback ticket="${t.id}" pr="${attr(url)}">`,
    ...items.map((c) => `<comment from="${attr(c.author!)}"${c.on ? ` on="${attr(c.on)}"` : ""}>\n${esc(c.body)}\n</comment>`),
    ...failed.map((c) => `<failed-check name="${attr(String(c.name ?? c.context ?? "?"))}" url="${attr(String(c.detailsUrl ?? c.targetUrl ?? ""))}"/>`),
    ...logs.map((l, i) => `<log run="${runs[i]}" lines="last ${LOG_LINES} of gh run view --log-failed">\n${esc(l)}\n</log>`),
    ...(dirty ? [`<conflict>The PR conflicts with origin/${attr(pr.baseRefName)}: rebase on it, resolve the conflicts, run the tests and push with --force-with-lease.</conflict>`] : []),
    "</feedback>\n",
  ].join("\n");
  const wt = join(dir, t.id);
  io.log(`${io.dry ? "dry: " : ""}feedback ${t.id} round ${cur.rounds + 1} to ${wt}/.aw/feedback.md`);
  if (!io.dry) writeAw(wt, "feedback.md", text);
  await paste(io, t.id, pane, FEEDBACK_POINTER);
}
