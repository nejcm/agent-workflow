import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENTS, agentOf, INBOX_WAITER, type Lookup } from "./agents";
import { resolve, type State } from "./state";
import type { AgentName, Io, Repo, Ticket, TicketComment, Tracker } from "../types";
import { INVISIBLE, mtime, put, read, readRun, removeRun, SYSTEMD, write, writeRun } from "../util";

const MAX_QUESTION_BYTES = 64 * 1024;
const MAX_QUESTION_CHARS = 8000;
const MAX_ANSWER_CHARS = 8000;
const MAX_HISTORY_CHARS = 32_000;
const OWN = /^\s*(aw|tender):\s*/i;
export const POINTER = "Your question was answered by the operator: read .tender/run/answer.md";
export const MESSAGE_POINTER = "The operator commented on the ticket: read .tender/run/message.md";

export interface QuestionSidecar {
  hash: string;
  postedAt: number;
  answerId?: string;
  /** Tracker time of the delivered answer: the next round only takes comments after it. */
  answeredAt?: number;
}

/** A comment by a listed author (case-insensitive) that tender (or aw, its old name) did not post. */
export function byOperator(authors: string[]) {
  const allowed = new Set(authors.map((a) => a.toLowerCase()));
  return (c: TicketComment) => !!c.author && allowed.has(c.author.toLowerCase()) && !/^\s*(aw|tender):/i.test(c.body);
}

/** The operator's answer: the earliest comment after postedAt (ms epoch) by a listed author that tender did not post. */
export function pickAnswer(comments: TicketComment[], postedAt: number, authors: string[]): TicketComment | undefined {
  const ok = byOperator(authors);
  return comments
    .filter((c) => Date.parse(c.createdAt) > postedAt && ok(c))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
}

export function readQuestionSidecar(file: string): QuestionSidecar | undefined {
  if (!existsSync(file)) return undefined;
  const o = JSON.parse(readFileSync(file, "utf8"));
  if (!o || typeof o.hash !== "string" || !Number.isFinite(o.postedAt) || (o.answerId !== undefined && typeof o.answerId !== "string") || (o.answeredAt !== undefined && !Number.isFinite(o.answeredAt))) throw new Error(`${file}: invalid`);
  return o;
}

function readSteer(file: string): number | undefined {
  if (!existsSync(file)) return undefined;
  const o = JSON.parse(readFileSync(file, "utf8"));
  if (!Number.isFinite(o?.seenAt)) throw new Error(`${file}: invalid`);
  return o.seenAt;
}

const readQuestion = (wt: string) => readRun(wt, "question.md", MAX_QUESTION_BYTES)?.replace(/\r\n?/g, "\n").trim();
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

/** A posted question still waiting for its answer; an unreadable sidecar counts as none. */
export function openQuestion(dir: string, id: string) {
  try {
    const q = readQuestionSidecar(join(dir, `${id}.question`));
    return !!q && q.answerId === undefined;
  } catch {
    return false;
  }
}

// Sidecar first: a crash or failed post loses the question rather than posting it twice.
export async function syncQuestion(t: Ticket, tr: Tracker, io: Io, dir: string, wt: string) {
  const text = readQuestion(wt);
  if (!text) return;
  if (text.length > MAX_QUESTION_CHARS) throw new Error(`question.md: over ${MAX_QUESTION_CHARS} chars, not posted`);
  if (/[^\P{Cc}\n\t]|[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(text)) throw new Error("question.md: control characters, not posted");
  const hash = hashOf(text);
  const file = join(dir, `${t.id}.question`);
  const prev = readQuestionSidecar(file);
  if (prev?.hash === hash && prev.answerId === undefined) return;
  // Never moves back, however many rewrites: a local clock behind the tracker's must not revive a delivered answer or message.
  const postedAt = Math.max(Date.now(), prev?.postedAt ?? 0, prev?.answeredAt ?? 0, readSteer(join(dir, `${t.id}.steer`)) ?? 0);
  put(io, file, JSON.stringify({ hash, postedAt, ...(prev?.answeredAt !== undefined && { answeredAt: prev.answeredAt }) } satisfies QuestionSidecar));
  await tr.comment(t, `question from agent:\n\n${text}`);
}

/** Per pass: a worktree's live state as `tender status` resolves it, or with `raw` the feed's own (a stale `working` stays); each feed is prepared at most once, on first use. */
export function liveStates(home = homedir(), prepare = (a: AgentName, wts: string[]) => AGENTS[a].live(home, wts)) {
  const feeds = new Map<string, Promise<Lookup>>();
  return async (dir: string, id: string, now = Date.now(), raw = false): Promise<State> => {
    const wt = join(dir, id);
    if (!feeds.has(wt)) feeds.set(wt, prepare(agentOf(dir, id), [wt]));
    const session = existsSync(join(dir, `${id}.ended`)) ? "ended" : "running";
    const live = (await feeds.get(wt)!)(wt, mtime(join(dir, `${id}.sh`)) ?? mtime(wt) ?? 0, now);
    return raw && session === "running" ? live?.state ?? "unknown" : resolve(session, live, null, now).state;
  };
}

/** The pane in `win` started by the ticket's launcher script, not pane order; none while in copy mode, where keys would run as bindings. */
export async function agentPane(io: Io, win: string, script: string) {
  const panes = (await read(io, ["tmux", "list-panes", "-t", win, "-F", "#{pane_id} #{pane_in_mode} #{pane_start_command}"])).split("\n").map((l) => /^(%\d+) (\d) (.*)$/.exec(l)).filter((m) => m?.[3] === script);
  return panes.length === 1 && panes[0]![2] === "0" ? panes[0]![1] : undefined;
}

// A bracketed paste: Codex reads fast typed keys as a paste and turns the Enter after them into a newline.
export async function paste(io: Io, id: string, pane: string, line: string) {
  await write(io, ["tmux", "set-buffer", "-b", `tender-${id}`, "--", line]);
  await write(io, ["tmux", "paste-buffer", "-p", "-d", "-b", `tender-${id}`, "-t", pane]);
  await write(io, ["tmux", "send-keys", "-t", pane, "Enter"]);
}

/** A pane gets the line pasted; null (a live Claude waiter) gets it through `.tender/run/inbox`, read even at an idle prompt. */
export async function nudge(io: Io, id: string, wt: string, pane: string | null, line: string) {
  if (pane) return paste(io, id, pane, line);
  io.log(`${io.dry ? "dry: " : ""}inbox ${id}: ${line}`);
  if (!io.dry) writeRun(wt, "inbox", `${line}\n`);
}

/** null when a Claude inbox waiter runs in the session's scope; otherwise the launcher's pane, undefined if missing or in copy mode. */
export async function deliveryPane(io: Io, agent: AgentName, win: string, script: string, unit: string) {
  return agent === "claude" && (await waiterLive(io, unit)) ? null : agentPane(io, win, script);
}

// Seen from the host: a session launched without the hook, or whose last turn ended without Stop, has no waiter and gets the paste.
async function waiterLive(io: Io, unit: string) {
  if (!SYSTEMD) return false;
  const cg = (await io.run(["systemctl", "--user", "show", "-P", "ControlGroup", unit])).out.trim();
  return cg.startsWith("/") && (await io.run(["pgrep", "-f", "--cgroup", cg, INBOX_WAITER])).code === 0;
}

export function answerFrame(c: TicketComment, id: string, tag: "answer" | "message" = "answer") {
  const body = c.body.length > MAX_ANSWER_CHARS ? `${c.body.slice(0, MAX_ANSWER_CHARS)}\n[truncated]` : c.body;
  return `<${tag} from="${c.author}" ticket="${id}">\n${body.replace(new RegExp(`</(${tag})`, "gi"), "&lt;/$1")}\n</${tag}>\n`;
}

/** A restarted ticket's comments by tender or an operator, oldest first, the newest kept under the cap. */
export function historyFrame(comments: TicketComment[], id: string, authors: string[]) {
  const ok = byOperator(authors);
  const at = (c: TicketComment) => Date.parse(c.createdAt) || 0;
  const items = comments.filter((c) => OWN.test(c.body) || ok(c)).sort((a, b) => at(a) - at(b)).map((c) => {
    const own = OWN.test(c.body);
    const raw = own ? c.body.replace(OWN, "") : c.body;
    const cut = raw.length > MAX_ANSWER_CHARS ? `${raw.slice(0, MAX_ANSWER_CHARS)}\n[truncated]` : raw;
    const body = cut.replace(new RegExp(`[${INVISIBLE}]`, "gu"), "").replace(/<(\s*\/?\s*)(history|operator|tender)\b/gi, "&lt;$1$2");
    const when = at(c) ? ` at="${new Date(at(c)).toISOString()}"` : "";
    return own ? `<tender${when}>\n${body}\n</tender>\n` : `<operator from="${c.author}"${when}>\n${body}\n</operator>\n`;
  });
  let n = items.length, size = 0;
  while (n && size + items[n - 1]!.length <= MAX_HISTORY_CHARS) size += items[--n]!.length;
  const omitted = n ? `[${n} earlier comment${n === 1 ? "" : "s"} omitted: read them on the ticket]\n` : "";
  return `<history ticket="${id}">\n${omitted}${items.slice(n).join("")}</history>\n`;
}

// answerId is recorded first: a crash or failure after it loses the paste, never repeats it. Text never goes through keys.
export async function deliverAnswer(r: Repo, t: Ticket, comments: (since: number) => Promise<TicketComment[]>, io: Io, dir: string, win: string, unit: string, state: () => Promise<State>) {
  const file = join(dir, `${t.id}.question`);
  const q = readQuestionSidecar(file);
  if (!q || q.answerId !== undefined || !r.feedbackAuthors.length || !/^@\d+$/.test(win)) return;
  const a = pickAnswer(await comments(q.postedAt), q.postedAt, r.feedbackAuthors);
  if (!a || (await state()) !== "idle") return;
  const pane = await deliveryPane(io, agentOf(dir, t.id), win, `${join(dir, t.id)}.sh`, unit);
  if (pane === undefined) return;
  put(io, file, JSON.stringify({ ...q, answerId: a.id, answeredAt: Date.parse(a.createdAt) } satisfies QuestionSidecar));
  const wt = join(dir, t.id);
  io.log(`${io.dry ? "dry: " : ""}answer ${t.id} from ${a.author} to ${wt}/.tender/run/answer.md`);
  if (!io.dry) writeRun(wt, "answer.md", answerFrame(a, t.id));
  await nudge(io, t.id, wt, pane, POINTER);
  // A question rewritten since it was posted is a new round; leave it for syncQuestion.
  const text = readQuestion(wt);
  if (!io.dry && text && hashOf(text) === q.hash) removeRun(wt, "question.md");
}

/** Operator comments after `<ID>.steer`'s cursor, up to an open question (its answer is deliverAnswer's); true when a delivery was attempted. */
export async function deliverMessages(r: Repo, t: Ticket, io: Io, dir: string, win: string, unit: string, state: () => Promise<State>, comments: (since: number) => Promise<TicketComment[]>) {
  const file = join(dir, `${t.id}.steer`);
  if (!r.feedbackAuthors.length || !/^@\d+$/.test(win) || !existsSync(file)) return false;
  const seenAt = readSteer(file)!;
  const q = readQuestionSidecar(join(dir, `${t.id}.question`));
  const from = Math.max(seenAt, q?.answeredAt ?? 0);
  const until = q && q.answerId === undefined ? q.postedAt : Infinity;
  if (from >= until || (await state()) !== "idle") return false;
  const ok = byOperator(r.feedbackAuthors);
  const due = (await comments(from))
    .filter((c) => Date.parse(c.createdAt) > from && Date.parse(c.createdAt) <= until && ok(c))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (!due.length) return false;
  const pane = await deliveryPane(io, agentOf(dir, t.id), win, `${join(dir, t.id)}.sh`, unit);
  if (pane === undefined) return false;
  // Cursor first, as answerId: a failure after it loses the delivery, never repeats it.
  put(io, file, JSON.stringify({ seenAt: Date.parse(due.at(-1)!.createdAt) }));
  const wt = join(dir, t.id);
  io.log(`${io.dry ? "dry: " : ""}message ${t.id} from ${[...new Set(due.map((c) => c.author))].join(", ")} to ${wt}/.tender/run/message.md`);
  try {
    if (!io.dry) writeRun(wt, "message.md", due.map((c) => answerFrame(c, t.id, "message")).join(""));
    await nudge(io, t.id, wt, pane, MESSAGE_POINTER);
  } catch (e) {
    io.log(`message ${t.id} not delivered: ${(e as Error).message}`);
  }
  return true;
}
