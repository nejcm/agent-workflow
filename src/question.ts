import type { TicketComment } from "./types";

/** The operator's answer: the earliest comment after postedAt (ms epoch) by a listed author that aw did not post. */
export function pickAnswer(comments: TicketComment[], postedAt: number, authors: string[]): TicketComment | undefined {
  const allowed = new Set(authors.map((a) => a.toLowerCase()));
  return comments
    .filter((c) => Date.parse(c.createdAt) > postedAt && !!c.author && allowed.has(c.author.toLowerCase()) && !/^\s*aw:/i.test(c.body))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
}
