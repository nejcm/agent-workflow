import { expect, test } from "bun:test";
import { pickAnswer } from "../src/question";
import type { TicketComment } from "../src/types";

const at = Date.parse("2026-01-01T10:00:00Z");
const c = (id: string, createdAt: string, author: string | undefined, body = "go with B"): TicketComment => ({ id, body, createdAt, author });

test("pickAnswer: first listed, non-aw comment strictly after the question", () => {
  const authors = ["Octocat", "lead@acme.com"];
  expect(pickAnswer([], at, authors)).toBeUndefined();
  expect(pickAnswer([c("early", "2026-01-01T09:59:59Z", "octocat"), c("equal", "2026-01-01T10:00:00.000Z", "octocat")], at, authors)).toBeUndefined();
  expect(pickAnswer([c("x", "2026-01-01T10:01:00Z", "mallory")], at, authors)).toBeUndefined();
  expect(pickAnswer([c("x", "2026-01-01T10:01:00Z", undefined)], at, authors)).toBeUndefined();
  expect(pickAnswer([c("x", "2026-01-01T10:01:00Z", "octocat", "aw: question from agent")], at, authors)).toBeUndefined();
  expect(pickAnswer([c("x", "2026-01-01T10:01:00Z", "octocat", "  AW: picked up")], at, authors)).toBeUndefined();
  expect(pickAnswer([c("x", "garbage", "octocat")], at, authors)).toBeUndefined();
  expect(pickAnswer([c("x", "2026-01-01T10:01:00Z", "OCTOCAT")], at, authors)?.id).toBe("x");
  expect(pickAnswer([c("x", "2026-01-01T10:01:00Z", "Lead@Acme.com")], at, authors)?.id).toBe("x");
  expect(pickAnswer([c("x", "2026-01-01T10:01:00Z", "octocat")], at, [])).toBeUndefined();
  const later = c("later", "2026-01-01T12:00:00Z", "octocat");
  const first = c("first", "2026-01-01T11:00:00+01:00", "lead@acme.com");
  expect(pickAnswer([later, first], at, authors)?.id).toBe("later");
  expect(pickAnswer([later, c("first", "2026-01-01T10:30:00Z", "lead@acme.com")], at, authors)?.id).toBe("first");
});
