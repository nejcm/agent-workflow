import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkState, PR_FIELDS } from "../review/merge";
import { agentOf } from "./agents";
import { byOperator, deliveryPane, nudge } from "./question";
import type { State } from "./state";
import type { Verified } from "../review/verify";
import type { Io, Repo, Ticket, TicketComment, Tracker, VerifyContract } from "../types";
import { put, read, writeRun } from "../util";

const DEBOUNCE_MS = 2 * 60_000;
const MAX_RUNS = 3;
const LOG_LINES = 80;
const MAX_ITEM_CHARS = 8000;
export const FEEDBACK_POINTER = "There is new feedback on your PR: read .tender/run/feedback.md";

export interface FeedbackCursor {
  /** GitHub time of the newest delivered comment. */
  seenAt: number;
  /** Head SHAs already reported, newest last, at most 10 each. */
  ciShas?: string[];
  dirtyShas?: string[];
  rounds: number;
  /** Failed verify runs delivered, counted apart from `rounds`, and every head delivered, so each fails once; `endedSha`: the head whose failure was escalated with the window gone. */
  verifyRounds?: number;
  verifyShas?: string[];
  endedSha?: string;
  capped?: boolean;
}

type Item = TicketComment & { on?: string; cursorAt?: string };

// A line comment's created_at is its draft time; updated_at moves on review submission (and edit), so the cursor keys on it.
export function prItems(pr: any, lines: any[]): Item[] {
  return [
    ...(pr.reviews ?? []).filter((r: any) => r.body?.trim() || r.state === "CHANGES_REQUESTED").map((r: any) => ({ id: String(r.id), body: r.body?.trim() || "(changes requested)", createdAt: r.submittedAt ?? "", author: r.author?.login })),
    ...(pr.comments ?? []).map((c: any) => ({ id: String(c.id), body: c.body ?? "", createdAt: c.createdAt ?? "", author: c.author?.login })),
    ...lines.map((c: any) => ({ id: String(c.id), body: c.body ?? "", createdAt: c.created_at ?? "", cursorAt: c.updated_at, author: c.user?.login, on: `${c.path}:${c.line ?? c.original_line}` })),
  ];
}

/** A PR's line comments; past 10 pages it throws rather than return part of them. */
export async function lineComments(io: Io, repo: string, n: string) {
  const all: any[] = [];
  for (let page = 1; page <= 11; page++) {
    const got: any[] = JSON.parse(await read(io, ["gh", "api", `repos/${repo}/pulls/${n}/comments?per_page=100${page > 1 ? `&page=${page}` : ""}`]));
    if (page > 10 && got.length) break;
    all.push(...got);
    if (got.length < 100) return all;
  }
  throw new Error(`${repo}#${n}: over 1000 line comments`);
}

const attr = (s: string) => s.replace(/[&"<]/g, (m) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;" })[m]!);
const esc = (s: string) => (s.length > MAX_ITEM_CHARS ? `${s.slice(0, MAX_ITEM_CHARS)}\n[truncated]` : s).replace(/<\/(feedback|comment|log|failed-verify)/gi, "&lt;/$1");

async function failedLog(io: Io, repo: string, run: string) {
  try {
    // tail streams, so a huge log is never buffered.
    const out = (await read(io, ["sh", "-c", `gh run view "$1" --repo "$2" --log-failed | tail -n ${LOG_LINES}`, "sh", run, repo])).trimEnd();
    return out || "(log unavailable)";
  } catch (e) {
    return `(log unavailable: ${(e as Error).message})`;
  }
}

/** Fields deliverFeedback reads beyond autoMerge's view. */
export const feedbackFields = (r: Repo) => (r.feedbackAuthors.length ? ",reviews,comments" : "");

// The cursor is recorded first: a crash or failure after it loses the paste, never repeats it. Text never goes through keys.
// True when nothing is left to deliver, false when feedback is pending or was just delivered, undefined when not checked.
export async function deliverFeedback(r: Repo, t: Ticket, tr: Tracker, io: Io, dir: string, win: string | undefined, unit: string, state: () => Promise<State>, warned: Set<string>, share?: { fields: string; pr?: any }, verify?: VerifyContract & { result?: Verified; live?: () => Promise<boolean> }): Promise<boolean | undefined> {
  const prFile = join(dir, `${t.id}.pr`);
  const url = existsSync(prFile) ? readFileSync(prFile, "utf8") : "";
  const n = /\/pull\/(\d+)$/.exec(url)?.[1];
  const file = join(dir, `${t.id}.feedback`);
  const saved: FeedbackCursor = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { seenAt: 0, rounds: 0 };
  if (!n || (win && !/^@\d+$/.test(win))) return;
  // A capped cursor on an unparked ticket means a human removed the label; confirm fresh (a failed read throws) before the rounds restart.
  if (saved.capped && (await tr.parked(t))) return;
  const cur: FeedbackCursor = saved.capped ? { ...saved, rounds: 0, verifyRounds: undefined, capped: undefined } : saved;
  const talk = r.feedbackAuthors.length > 0;
  // A view taken before the parked read is stale; the fresh one is shared back, so the Ready to merge check judges the same.
  const pr = share?.pr?.url === url && !saved.capped ? share.pr : JSON.parse(await read(io, ["gh", "pr", "view", n, "--repo", r.key, "--json", share ? PR_FIELDS + share.fields : `state,baseRefName,headRefOid,mergeStateStatus,statusCheckRollup${talk ? ",reviews,comments" : ""}`]));
  if (share) share.pr = pr;
  if (pr.state !== "OPEN") return;
  const res = verify?.result;
  const current = res && !res.pass && res.head === pr.headRefOid && res.digest === verify.digest ? res : undefined;
  // A park or a spent round outlasts the poll, so a contract pushed since the fetch must not decide it; checked right before each.
  const live = async () => !verify?.live || (await verify.live());
  // Nobody is left to fix it: delivered or not, it goes to a human now, ahead of comments and their debounce, once per head.
  if (!win && current && cur.endedSha !== current.head) {
    if (!(await live())) return false;
    await tr.park(t);
    io.event?.("park", r.key, t.id, { why: "verify failed, session ended" });
    put(io, file, JSON.stringify({ ...cur, endedSha: current.head, capped: true } satisfies FeedbackCursor));
    await tr.comment(t, `verify check ${current.check} failed on ${url} and the session has ended: a human is needed`);
    return false;
  }
  const lines = talk ? await lineComments(io, r.key, n) : [];
  const ok = byOperator(r.feedbackAuthors);
  const at = (c: Item) => Date.parse(c.cursorAt ?? c.createdAt);
  const items = prItems(pr, lines)
    .filter((c) => at(c) > cur.seenAt && ok(c))
    .sort((a, b) => at(a) - at(b));
  const newest = items.length ? at(items.at(-1)!) : undefined;
  if (newest !== undefined && Date.now() - newest < DEBOUNCE_MS) return false;
  const checks: any[] = pr.statusCheckRollup ?? [];
  const failed = !cur.ciShas?.includes(pr.headRefOid) && !checks.some((c) => checkState(c) === "pending") ? checks.filter((c) => checkState(c) === "failed") : [];
  const dirty = pr.mergeStateStatus === "DIRTY" && !cur.dirtyShas?.includes(pr.headRefOid);
  // Once per head, as CI failures: a revised contract failing the same head is not another round.
  const vfail = current && !cur.verifyShas?.includes(current.head) ? current : undefined;
  const verifyShas = vfail ? [...(cur.verifyShas ?? []), vfail.head] : cur.verifyShas;
  const fb = items.length > 0 || failed.length > 0 || dirty;
  if (!fb && !vfail) return true;
  if (!win) {
    const seen = `${file}@${newest ?? cur.seenAt}@${pr.headRefOid}`;
    if (!warned.has(seen)) io.log(`${t.id}: PR feedback pending but the session's window is gone; restart it or act on ${url} by hand`);
    warned.add(seen);
    return false;
  }
  const vCapped = !!vfail && (cur.verifyRounds ?? 0) >= verify!.maxRounds;
  if ((fb && cur.rounds >= r.feedbackRounds) || vCapped) {
    if (vCapped && !(await live())) return false;
    // Label first: if adding it fails, this retries next poll instead of leaving a capped cursor that reads as resumed.
    await tr.park(t);
    io.event?.("park", r.key, t.id, { why: vCapped ? "verify rounds" : "feedback rounds" });
    put(io, file, JSON.stringify({ ...cur, capped: true } satisfies FeedbackCursor));
    await tr.comment(t, vCapped ? `verify failed after ${verify!.maxRounds} rounds on ${url}: a human is needed` : `PR feedback stopped after ${r.feedbackRounds} rounds on ${url}: a human is needed`);
    return false;
  }
  if ((await state()) !== "idle") return false;
  const pane = await deliveryPane(io, agentOf(dir, t.id), win, `${join(dir, t.id)}.sh`, unit);
  if (pane === undefined) return false;
  const runs = [...new Set(failed.map((c) => /\/actions\/runs\/(\d+)/.exec(c.detailsUrl ?? c.targetUrl ?? "")?.[1]).filter((x): x is string => !!x))].slice(0, MAX_RUNS);
  const logs = await Promise.all(runs.map((id) => failedLog(io, r.key, id)));
  if (vfail && !(await live())) return false;
  put(io, file, JSON.stringify({ seenAt: newest ?? cur.seenAt, ciShas: failed.length ? [...(cur.ciShas ?? []), pr.headRefOid].slice(-10) : cur.ciShas, dirtyShas: dirty ? [...(cur.dirtyShas ?? []), pr.headRefOid].slice(-10) : cur.dirtyShas, rounds: cur.rounds + (fb ? 1 : 0), verifyRounds: (cur.verifyRounds ?? 0) + (vfail ? 1 : 0) || undefined, verifyShas, endedSha: cur.endedSha } satisfies FeedbackCursor));
  io.event?.("feedback-round", r.key, t.id, { round: cur.rounds + (fb ? 1 : 0), comments: items.length, failedChecks: failed.length, conflict: dirty, ...(vfail && { failedVerify: vfail.check, verifyRound: (cur.verifyRounds ?? 0) + 1 }) });
  const text = [
    `<feedback ticket="${t.id}" pr="${attr(url)}">`,
    ...items.map((c) => `<comment from="${attr(c.author!)}"${c.on ? ` on="${attr(c.on)}"` : ""}>\n${esc(c.body)}\n</comment>`),
    ...failed.map((c) => `<failed-check name="${attr(String(c.name ?? c.context ?? "?"))}" url="${attr(String(c.detailsUrl ?? c.targetUrl ?? ""))}"/>`),
    ...logs.map((l, i) => `<log run="${runs[i]}" lines="last ${LOG_LINES} of gh run view --log-failed">\n${esc(l)}\n</log>`),
    ...(vfail ? [`<failed-verify name="${attr(vfail.check)}" head="${vfail.head}" lines="last ${LOG_LINES} of its output">\n${esc(vfail.tail)}\n</failed-verify>`] : []),
    ...(dirty ? [`<conflict>The PR conflicts with origin/${attr(pr.baseRefName)}: rebase on it, resolve the conflicts, run the tests and push with --force-with-lease.</conflict>`] : []),
    "</feedback>\n",
  ].join("\n");
  const wt = join(dir, t.id);
  const round = fb ? `round ${cur.rounds + 1}` : `verify round ${(cur.verifyRounds ?? 0) + 1}`;
  io.log(`${io.dry ? "dry: " : ""}feedback ${t.id} ${round} to ${wt}/.tender/run/feedback.md`);
  // The round is spent either way; false still tells Ready to merge to move it back.
  try {
    if (!io.dry) writeRun(wt, "feedback.md", text);
    await nudge(io, t.id, wt, pane, FEEDBACK_POINTER);
  } catch (e) {
    io.log(`feedback ${t.id} ${round} not delivered: ${(e as Error).message}`);
  }
  return false;
}
