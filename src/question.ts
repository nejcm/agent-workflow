import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Io, Ticket, TicketComment, Tracker } from "./types";
import { put, readAw } from "./util";

const MAX_QUESTION_BYTES = 64 * 1024;
const MAX_QUESTION_CHARS = 8000;

export interface QuestionSidecar {
  hash: string;
  postedAt: number;
  answerId?: string;
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
  if (!o || typeof o.hash !== "string" || !Number.isFinite(o.postedAt) || (o.answerId !== undefined && typeof o.answerId !== "string")) throw new Error(`${file}: invalid`);
  return o;
}

// Sidecar first: a crash or failed post loses the question rather than posting it twice.
export async function syncQuestion(t: Ticket, tr: Tracker, io: Io, dir: string, wt: string) {
  const text = readAw(wt, "question.md", MAX_QUESTION_BYTES)?.replace(/\r\n?/g, "\n").trim();
  if (!text) return;
  if (text.length > MAX_QUESTION_CHARS) throw new Error(`question.md: over ${MAX_QUESTION_CHARS} chars, not posted`);
  if (/[^\P{Cc}\n\t]|[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(text)) throw new Error("question.md: control characters, not posted");
  const hash = createHash("sha256").update(text).digest("hex");
  const file = join(dir, `${t.id}.question`);
  if (readQuestionSidecar(file)?.hash === hash) return;
  put(io, file, JSON.stringify({ hash, postedAt: Date.now() } satisfies QuestionSidecar));
  await tr.comment(t, `question from agent:\n\n${text}`);
}
