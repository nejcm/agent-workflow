import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pass } from "../src/pass";
import { pickAnswer } from "../src/question";
import type { TicketComment } from "../src/types";
import { config, fakeIo, fakeTracker, noPr, root, ticket, useTempRoot, windowsOut, worktree } from "./helpers";

useTempRoot();

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

const ask = (text: string) => {
  mkdirSync(join(root, "acme/web/gh-1/.aw"), { recursive: true });
  writeFileSync(join(root, "acme/web/gh-1/.aw/question.md"), text);
};
const sidecar = () => join(root, "acme/web/gh-1.question");
const setup = (open = ["acme/web/gh-1"], o: { dry?: boolean; pr?: boolean } = {}) => {
  worktree("gh-1");
  const f = fakeTracker({ inProgress: [ticket(1)] });
  const pr = (a: string[]) => (a[1] === "pr" ? { out: '[{"url":"https://github.com/acme/web/pull/1","state":"OPEN"}]' } : undefined);
  const { io, logs } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(open) : o.pr ? pr(a) : noPr(a)), o.dry);
  return { ...f, logs, run: () => pass(config(), io, () => f.tr, "/aw") };
};

test("question: posted once per content, again when it changes", async () => {
  const { calls, run } = setup();
  await run();
  expect(calls).toEqual([]);
  ask("Which DB?\n");
  await run();
  await run();
  ask("Which DB, really?");
  await run();
  expect(calls).toEqual(["comment gh-1 question from agent:\n\nWhich DB?", "comment gh-1 question from agent:\n\nWhich DB, really?"]);
  expect(JSON.parse(readFileSync(sidecar(), "utf8"))).toMatchObject({ hash: expect.any(String), postedAt: expect.any(Number) });
});

test("question: oversized is logged, not posted; no window means no post", async () => {
  const big = setup();
  ask("x".repeat(8001));
  await big.run();
  expect(big.calls).toEqual([]);
  expect(big.logs.some((l) => l.includes("question gh-1 failed: question.md: over 8000 chars"))).toBe(true);
  expect(existsSync(sidecar())).toBe(false);
  const gone = setup([]);
  ask("Which DB?");
  await gone.run();
  expect(gone.calls).toEqual(["comment gh-1 session ended without a PR"]);
  expect(existsSync(sidecar())).toBe(false);
});

test("question: sidecar is written before the comment, so a failed post is not retried", async () => {
  const { tr, run, logs } = setup();
  let posts = 0;
  tr.comment = async () => {
    posts++;
    expect(existsSync(sidecar())).toBe(true);
    throw new Error("api down");
  };
  ask("Which DB?");
  await run();
  await run();
  expect(posts).toBe(1);
  expect(logs.some((l) => l.includes("question gh-1 failed: api down"))).toBe(true);
});

test("question: control characters are logged and never posted; exactly 8000 chars is posted", async () => {
  const bad = setup();
  for (const text of ["Which\x1b[2J DB?", "Which\0 DB?", "Which\x9b DB?", "Which \u202eBD?", "Which \u2066DB\u2069?"]) {
    ask(text);
    await bad.run();
  }
  expect(bad.calls).toEqual([]);
  expect(existsSync(sidecar())).toBe(false);
  expect(bad.logs.filter((l) => l.includes("question gh-1 failed: question.md: control characters"))).toHaveLength(5);
  ask("tabs\tand\nnewlines ".padEnd(8000, "x"));
  await bad.run();
  expect(bad.calls).toHaveLength(1);
});

test("question: dry-run writes no sidecar; an open PR means no post", async () => {
  const dry = setup(undefined, { dry: true });
  ask("Which DB?");
  await dry.run();
  expect(existsSync(sidecar())).toBe(false);
  expect(dry.logs.some((l) => l.endsWith(`dry: write ${sidecar()}`))).toBe(true);
  const pr = setup(undefined, { pr: true });
  await pr.run();
  expect(pr.calls).toEqual(["review gh-1 https://github.com/acme/web/pull/1"]);
  expect(existsSync(sidecar())).toBe(false);
});

test("question: CRLF and CR line endings are posted as LF", async () => {
  const { calls, run } = setup();
  ask("Which DB?\r\nPostgres or\rSQLite?\r\n");
  await run();
  expect(calls).toEqual(["comment gh-1 question from agent:\n\nWhich DB?\nPostgres or\nSQLite?"]);
});
