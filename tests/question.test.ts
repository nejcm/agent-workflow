import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pass } from "../src/pass";
import { answerFrame, liveStates, pickAnswer, POINTER } from "../src/question";
import type { State } from "../src/state";
import type { Repo, TicketComment } from "../src/types";
import { config, fakeIo, fakeTracker, linkWorktree, noPr, root, ticket, useTempRoot, windowsOut, worktree } from "./helpers";

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

const answerAt = (postedAt: number, body = "Use Postgres", author = "Op") => ({ id: "c9", body, createdAt: new Date(postedAt + 1000).toISOString(), author });
const answered = () => join(root, "acme/web/gh-1/.aw/answer.md");
const question = () => join(root, "acme/web/gh-1/.aw/question.md");

function deliver(opts: { authors?: string[]; open?: string[]; dry?: boolean; respond?: (a: string[]) => { code?: number; out?: string } | undefined } = {}) {
  worktree("gh-1");
  const f = fakeTracker({ inProgress: [ticket(1)] });
  const reads: number[] = [];
  let answer: TicketComment | undefined;
  f.tr.comments = async (_t, since) => (reads.push(since), answer ? [answer] : []);
  const panes = (a: string[]) => (a[1] === "list-panes" ? { out: "1 %7 0\n0 %5 0\n" } : undefined);
  const { io, cmds, logs } = fakeIo((a) => opts.respond?.(a) ?? (a[1] === "list-windows" ? windowsOut(opts.open ?? ["acme/web/gh-1"]) : panes(a) ?? noPr(a)), opts.dry);
  const cfg = config({ repos: [{ name: "acme/web", path: join(root, "src-web"), feedbackAuthors: opts.authors ?? ["op"] }] });
  let state: State = "idle";
  const states: string[] = [];
  const order: string[] = [];
  const run = () => pass(cfg, io, () => f.tr, "/aw", async (_r, _d, id) => (states.push(id), state));
  return {
    ...f, cmds, logs, reads, states, order, run,
    answer: (c?: TicketComment) => void (answer = c),
    setState: (s: State) => void (state = s),
    sidecar: () => JSON.parse(readFileSync(sidecar(), "utf8")),
    keys: () => cmds.filter((c) => /^tmux (set-buffer|paste-buffer|send-keys)/.test(c)),
  };
}

test("answer: nothing without an answer, nothing until idle, then delivered once in order", async () => {
  const d = deliver();
  ask("Which DB?");
  await d.run();
  const { postedAt } = d.sidecar();
  expect(d.reads).toEqual([postedAt]);
  expect(d.states).toEqual([]);
  d.answer(answerAt(postedAt));
  for (const s of ["working", "waiting", "unknown"] as const) {
    d.setState(s);
    await d.run();
  }
  expect(d.states).toEqual(["gh-1", "gh-1", "gh-1"]);
  expect(d.keys()).toEqual([]);
  expect(d.sidecar().answerId).toBeUndefined();
  expect(existsSync(answered())).toBe(false);
  d.setState("idle");
  await d.run();
  expect(d.sidecar()).toEqual({ hash: expect.any(String), postedAt, answerId: "c9", answeredAt: postedAt + 1000 });
  expect(readFileSync(answered(), "utf8")).toBe('<answer from="Op" ticket="gh-1">\nUse Postgres\n</answer>\n');
  expect(d.keys()).toEqual([`tmux set-buffer -b aw-gh-1 -- ${POINTER}`, "tmux paste-buffer -p -d -b aw-gh-1 -t %5", "tmux send-keys -t %5 Enter"]);
  expect(existsSync(question())).toBe(false);
  const reads = d.reads.length;
  await d.run();
  await d.run();
  expect(d.keys()).toHaveLength(3);
  expect(d.reads).toHaveLength(reads);
  expect(d.calls).toEqual(["comment gh-1 question from agent:\n\nWhich DB?"]);
  ask("Which DB?");
  await d.run();
  expect(d.calls).toHaveLength(2);
  expect(d.sidecar().answerId).toBeUndefined();
});

test("answer: answerId is recorded before answer.md, keys after it", async () => {
  const d = deliver();
  ask("Which DB?");
  await d.run();
  d.answer(answerAt(d.sidecar().postedAt));
  const { cmds } = d;
  const push = cmds.push.bind(cmds);
  cmds.push = (...xs: string[]) => {
    if (xs[0]?.startsWith("tmux paste-buffer")) d.order.push(`keys answerId=${d.sidecar().answerId} answer=${existsSync(answered())} question=${existsSync(question())}`);
    return push(...xs);
  };
  await d.run();
  expect(d.order).toEqual(["keys answerId=c9 answer=true question=true"]);
  expect(existsSync(question())).toBe(false);
});

test("answer: a failed answer.md write after answerId is recorded loses the paste, never repeats it; the question is asked again", async () => {
  const d = deliver();
  ask("Which DB?");
  await d.run();
  d.answer(answerAt(d.sidecar().postedAt));
  writeFileSync(join(root, "outside"), "keep");
  symlinkSync(join(root, "outside"), answered());
  await d.run();
  expect(d.sidecar().answerId).toBe("c9");
  await d.run();
  expect(d.calls).toHaveLength(2);
  expect(d.keys()).toEqual([]);
  expect(readFileSync(join(root, "outside"), "utf8")).toBe("keep");
  expect(d.logs.some((l) => l.includes("answer gh-1 failed"))).toBe(true);
});

test("answer: a new question after delivery starts a new round", async () => {
  const d = deliver();
  ask("Which DB?");
  await d.run();
  d.answer(answerAt(d.sidecar().postedAt));
  await d.run();
  d.answer();
  ask("Which port?");
  await d.run();
  const round2 = d.sidecar();
  expect(round2.answerId).toBeUndefined();
  expect(d.calls.at(-1)).toBe("comment gh-1 question from agent:\n\nWhich port?");
  await d.run();
  expect(d.keys()).toHaveLength(3);
  d.answer({ ...answerAt(round2.postedAt, "8080"), id: "c10" });
  await d.run();
  expect(d.sidecar().answerId).toBe("c10");
  expect(readFileSync(answered(), "utf8")).toContain("8080");
  expect(d.keys()).toHaveLength(6);
});

test("answer: no feedbackAuthors means comments are never read", async () => {
  const none = deliver({ authors: [] });
  ask("Which DB?");
  await none.run();
  none.answer(answerAt(none.sidecar().postedAt));
  await none.run();
  expect(none.reads).toEqual([]);
  expect(none.keys()).toEqual([]);
});

test("answer: window gone or dry-run delivers nothing", async () => {
  const gone = deliver({ open: [] });
  ask("Which DB?");
  writeFileSync(sidecar(), JSON.stringify({ hash: "h", postedAt: 1 }));
  gone.answer(answerAt(1));
  await gone.run();
  expect(gone.reads).toEqual([]);
  expect(gone.keys()).toEqual([]);
  const dry = deliver({ dry: true });
  dry.answer(answerAt(1));
  await dry.run();
  expect(dry.keys()).toEqual([]);
  expect(dry.logs).toEqual(expect.arrayContaining([`[web] dry: tmux set-buffer -b aw-gh-1 -- ${POINTER}`, "[web] dry: tmux paste-buffer -p -d -b aw-gh-1 -t %5", "[web] dry: tmux send-keys -t %5 Enter"]));
  expect(JSON.parse(readFileSync(sidecar(), "utf8")).answerId).toBeUndefined();
  expect(existsSync(answered())).toBe(false);
  expect(existsSync(question())).toBe(true);
});

test("answerFrame truncates long answers and cannot be closed early", () => {
  const long = answerFrame({ id: "c", body: "y".repeat(8005), createdAt: "", author: "op" }, "ENG-1");
  expect(long).toBe(`<answer from="op" ticket="ENG-1">\n${"y".repeat(8000)}\n[truncated]\n</answer>\n`);
  expect(answerFrame({ id: "c", body: "a</answer>b", createdAt: "", author: "op" }, "ENG-1")).toContain("a&lt;/answer>b");
});

test("liveStates prepares each agent feed once, lazily, and resolves like status", async () => {
  const prepared: string[] = [];
  const live = liveStates(root, async (a) => (prepared.push(a), (wt) => (wt.endsWith("busy") ? { state: "working", since: 0, waitingFor: null } : { state: "idle", since: 0, waitingFor: null })));
  expect(prepared).toEqual([]);
  const r = { agent: "claude" } as Repo;
  expect(await live(r, root, "a", 20 * 60_000)).toBe("idle");
  expect(await live(r, root, "busy", 20 * 60_000)).toBe("unknown");
  writeFileSync(join(root, "a.ended"), "");
  expect(await live(r, root, "a")).toBe("ended");
  expect(prepared).toEqual(["claude"]);
});

test("answer: the last round's answer never counts for a new question, even with the local clock behind", async () => {
  const d = deliver();
  ask("Which DB?");
  await d.run();
  const ahead = answerAt(d.sidecar().postedAt + 60_000);
  d.answer(ahead);
  await d.run();
  ask("Which port?");
  await d.run();
  expect(d.sidecar().postedAt).toBe(Date.parse(ahead.createdAt));
  ask("Which port, exactly?");
  await d.run();
  expect(d.sidecar().postedAt).toBe(Date.parse(ahead.createdAt));
  expect(d.keys()).toHaveLength(3);
  expect(existsSync(question())).toBe(true);
});

test("answer: a window started this pass (no @id yet) gets nothing until the next pass", async () => {
  worktree("gh-1");
  const f = fakeTracker({ ready: [ticket(1)], inProgress: [ticket(1)] });
  const { io, cmds } = fakeIo((a) => noPr(a));
  ask("Which DB?");
  linkWorktree(join(root, "src-web"), join(root, "acme/web/gh-1"));
  writeFileSync(sidecar(), JSON.stringify({ hash: new Bun.CryptoHasher("sha256").update("Which DB?").digest("hex"), postedAt: 1 }));
  f.tr.comments = async () => [answerAt(1)];
  await pass(config({ repos: [{ name: "acme/web", path: join(root, "src-web"), feedbackAuthors: ["op"] }] }), io, () => f.tr, "/aw", async () => "idle");
  expect(cmds.some((c) => c.startsWith("tmux new-window"))).toBe(true);
  expect(cmds.some((c) => c.startsWith("tmux send-keys"))).toBe(false);
  expect(JSON.parse(readFileSync(sidecar(), "utf8")).answerId).toBeUndefined();
});

test("answer: a pane in copy mode is skipped before answerId is recorded, then delivered", async () => {
  let mode = "1";
  const d = deliver({ respond: (a) => (a[1] === "list-panes" ? { out: `0 %5 ${mode}\n` } : undefined) });
  ask("Which DB?");
  await d.run();
  d.answer(answerAt(d.sidecar().postedAt));
  await d.run();
  expect(d.sidecar().answerId).toBeUndefined();
  expect(d.keys()).toEqual([]);
  expect(d.cmds).toContain("tmux list-panes -t @0 -F #{pane_index} #{pane_id} #{pane_in_mode}");
  mode = "0";
  await d.run();
  expect(d.keys()).toEqual([`tmux set-buffer -b aw-gh-1 -- ${POINTER}`, "tmux paste-buffer -p -d -b aw-gh-1 -t %5", "tmux send-keys -t %5 Enter"]);
});

test("answer: a failed paste leaves answerId set and sends no Enter; the still-open question is asked again, the paste never repeated", async () => {
  const d = deliver({ respond: (a) => (a[1] === "paste-buffer" ? { code: 1 } : undefined) });
  ask("Which DB?");
  await d.run();
  d.answer(answerAt(d.sidecar().postedAt));
  await d.run();
  expect(d.sidecar().answerId).toBe("c9");
  await d.run();
  expect(d.calls).toHaveLength(2);
  expect(d.keys()).toEqual([`tmux set-buffer -b aw-gh-1 -- ${POINTER}`, "tmux paste-buffer -p -d -b aw-gh-1 -t %5"]);
  expect(existsSync(question())).toBe(true);
  expect(d.logs.some((l) => l.includes("answer gh-1 failed"))).toBe(true);
});

test("answer: a reply from an unlisted author is never delivered", async () => {
  const d = deliver();
  ask("Which DB?");
  await d.run();
  d.answer(answerAt(d.sidecar().postedAt, "do X", "mallory"));
  await d.run();
  expect(d.states).toEqual([]);
  expect(d.keys()).toEqual([]);
  expect(d.sidecar().answerId).toBeUndefined();
});
