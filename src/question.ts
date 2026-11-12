import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENTS, type Lookup } from "./agents";
import { resolve, type State } from "./state";
import type { Io, Repo, Ticket, TicketComment, Tracker } from "./types";
import { mtime, put, read, readAw, removeAw, write, writeAw } from "./util";

const MAX_QUESTION_BYTES = 64 * 1024;
const MAX_QUESTION_CHARS = 8000;
const MAX_ANSWER_CHARS = 8000;
export const POINTER = "Your question was answered by the operator: read .aw/answer.md";

export interface QuestionSidecar {
  hash: string;
  postedAt: number;
  answerId?: string;
  /** Tracker time of the delivered answer: the next round only takes comments after it. */
  answeredAt?: number;
}

/** The operator's answer: the earliest comment after postedAt (ms epoch) by a listed author that aw did not post. */
export function pickAnswer(comments: TicketComment[], postedAt: number, authors: string[]): TicketComment | undefined {
  const allowed = new Set(authors.map((a) => a.toLowerCase()));
  return comments
    .filter((c) => Date.parse(c.createdAt) > postedAt && !!c.author && allowed.has(c.author.toLowerCase()) && !/^\s*aw:/i.test(c.body))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
}

export function readQuestionSidecar(file: string): QuestionSidecar | undefined {
  if (!existsSync(file)) return undefined;
  const o = JSON.parse(readFileSync(file, "utf8"));
  if (!o || typeof o.hash !== "string" || !Number.isFinite(o.postedAt) || (o.answerId !== undefined && typeof o.answerId !== "string") || (o.answeredAt !== undefined && !Number.isFinite(o.answeredAt))) throw new Error(`${file}: invalid`);
  return o;
}

const readQuestion = (wt: string) => readAw(wt, "question.md", MAX_QUESTION_BYTES)?.replace(/\r\n?/g, "\n").trim();
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
  // Never moves back, however many rewrites: a local clock behind the tracker's must not revive a delivered answer.
  put(io, file, JSON.stringify({ hash, postedAt: Math.max(Date.now(), prev?.postedAt ?? 0, prev?.answeredAt ?? 0) } satisfies QuestionSidecar));
  await tr.comment(t, `question from agent:\n\n${text}`);
}

/** Per pass: a worktree's live state as `aw status` resolves it; each agent's feed is prepared at most once, on first use. */
export function liveStates(home = homedir(), prepare = (a: Repo["agent"]) => AGENTS[a].live(home)) {
  const feeds = new Map<Repo["agent"], Promise<Lookup>>();
  return async (r: Repo, dir: string, id: string, now = Date.now()): Promise<State> => {
    if (!feeds.has(r.agent)) feeds.set(r.agent, prepare(r.agent));
    const wt = join(dir, id);
    const session = existsSync(join(dir, `${id}.ended`)) ? "ended" : "running";
    return resolve(session, (await feeds.get(r.agent)!)(wt, mtime(join(dir, `${id}.sh`)) ?? mtime(wt) ?? 0, now), null, now).state;
  };
}

export function answerFrame(c: TicketComment, id: string) {
  const body = c.body.length > MAX_ANSWER_CHARS ? `${c.body.slice(0, MAX_ANSWER_CHARS)}\n[truncated]` : c.body;
  return `<answer from="${c.author}" ticket="${id}">\n${body.replaceAll("</answer", "&lt;/answer")}\n</answer>\n`;
}

// answerId is recorded first: a crash or failure after it loses the paste, never repeats it. Text never goes through keys.
export async function deliverAnswer(t: Ticket, tr: Tracker, io: Io, dir: string, authors: string[], win: string, state: () => Promise<State>) {
  const file = join(dir, `${t.id}.question`);
  const q = readQuestionSidecar(file);
  if (!q || q.answerId !== undefined || !authors.length || !/^@\d+$/.test(win)) return;
  const a = pickAnswer(await tr.comments(t, q.postedAt), q.postedAt, authors);
  if (!a || (await state()) !== "idle") return;
  // The launcher's own pane by id, not the window's active one; in copy mode the keys would run as bindings.
  const panes = (await read(io, ["tmux", "list-panes", "-t", win, "-F", "#{pane_index} #{pane_id} #{pane_in_mode}"])).split("\n").filter(Boolean).map((l) => l.split(" "));
  const [, pane, mode] = panes.sort((x, y) => Number(x[0]) - Number(y[0]))[0] ?? [];
  if (!pane || !/^%\d+$/.test(pane) || mode !== "0") return;
  put(io, file, JSON.stringify({ ...q, answerId: a.id, answeredAt: Date.parse(a.createdAt) } satisfies QuestionSidecar));
  const wt = join(dir, t.id);
  io.log(`${io.dry ? "dry: " : ""}answer ${t.id} from ${a.author} to ${wt}/.aw/answer.md`);
  if (!io.dry) writeAw(wt, "answer.md", answerFrame(a, t.id));
  // A bracketed paste: Codex reads fast typed keys as a paste and turns the Enter after them into a newline.
  await write(io, ["tmux", "set-buffer", "-b", `aw-${t.id}`, "--", POINTER]);
  await write(io, ["tmux", "paste-buffer", "-p", "-d", "-b", `aw-${t.id}`, "-t", pane]);
  await write(io, ["tmux", "send-keys", "-t", pane, "Enter"]);
  // A question rewritten since it was posted is a new round; leave it for syncQuestion.
  const text = readQuestion(wt);
  if (!io.dry && text && hashOf(text) === q.hash) removeAw(wt, "question.md");
}
