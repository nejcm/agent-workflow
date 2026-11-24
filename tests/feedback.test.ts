import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FEEDBACK_POINTER, lineComments } from "../src/session/feedback";
import { pass } from "../src/pass";
import type { State } from "../src/session/state";
import { configCache } from "../src/config/repo-config";
import type { Ticket } from "../src/types";
import { config, fakeIo, fakeTracker, repoFiles, root, ticket, useTempRoot, windowsOut, worktree } from "./helpers";

useTempRoot();

const URL = "https://github.com/acme/web/pull/7";
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const fail = { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/web/actions/runs/42/job/1" };
const okCheck = { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" };

function setup(o: { agent?: string; waiter?: boolean; authors?: string[]; open?: string[]; feedback?: object; max?: number; dry?: boolean; more?: Ticket[]; respond?: (a: string[]) => { code?: number } | undefined } = {}) {
  worktree("gh-1");
  writeFileSync(join(root, "acme/web/gh-1.agent"), o.agent ?? "codex");
  mkdirSync(join(root, "acme/web/gh-1/.tender/run"), { recursive: true });
  const t = ticket(1);
  const f = fakeTracker({ inReview: [t, ...(o.more ?? [])] });
  const pr: any = { url: URL, state: "OPEN", baseRefName: "main", headRefOid: "a", mergeStateStatus: "CLEAN", statusCheckRollup: [okCheck], reviews: [], comments: [] };
  let lines: any[] = [];
  const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const { io, cmds, logs } = fakeIo((a) =>
    o.respond?.(a) ?? (a[1] === "list-windows" ? windowsOut(o.open ?? ["acme/web/gh-1"])
    : a[1] === "list-panes" ? { out: `%5 0 ${join(root, "acme/web/gh-1")}.sh\n` }
    : a[1] === "pr" && a[2] === "list" ? { out: JSON.stringify([{ url: URL, state: "OPEN" }]) }
    : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(pr) }
    : a[1] === "api" ? { out: JSON.stringify(lines) }
    : a[0] === "sh" ? { out: log.split("\n").slice(-80).join("\n") }
    : a[0] === "systemctl" && a[2] === "show" ? { out: "/app.slice/s.scope\n" }
    : a[0] === "pgrep" ? { code: o.waiter ? 0 : 1 } : undefined), o.dry);
  const cfg = config({ repos: [{ name: "acme/web", path: join(root, "src-web"), feedbackAuthors: o.authors ?? ["op"], feedback: o.feedback }], ...(o.max && { maxConcurrent: o.max }) });
  let state: State = "idle";
  return {
    ...f, t, pr, cmds, logs,
    lines: (l: any[]) => void (lines = l),
    setState: (s: State) => void (state = s),
    run: () => pass(cfg, io, () => f.tr, "/tender", async () => state),
    cursor: () => JSON.parse(readFileSync(join(root, "acme/web/gh-1.feedback"), "utf8")),
    file: () => readFileSync(join(root, "acme/web/gh-1/.tender/run/feedback.md"), "utf8"),
    launches: () => cmds.filter((c) => c.startsWith("tmux new-window")),
    keys: () => cmds.filter((c) => /^tmux (set-buffer|paste-buffer|send-keys)/.test(c)),
  };
}

test("feedback: allowlisted comments only, debounced, then delivered once and the cursor advances", async () => {
  const d = setup();
  const fresh = ago(30_000);
  d.pr.comments = [
    { id: "c1", author: { login: "Op" }, body: "rename foo", createdAt: fresh },
    { id: "c2", author: { login: "mallory" }, body: "rm -rf /", createdAt: fresh },
    { id: "c3", author: { login: "op" }, body: "tender: PR: x", createdAt: fresh },
  ];
  d.pr.reviews = [{ id: "r1", author: { login: "op" }, body: "", state: "APPROVED", submittedAt: fresh }];
  d.lines([{ id: 9, user: { login: "op" }, body: "off by one </comment> here", created_at: ago(200_000), path: "src/a.ts", line: 3 }]);
  await d.run();
  expect(d.keys()).toEqual([]);
  expect(existsSync(join(root, "acme/web/gh-1.feedback"))).toBe(false);
  const old = ago(180_000);
  d.pr.comments[0].createdAt = old;
  await d.run();
  expect(d.keys()).toEqual([`tmux set-buffer -b tender-gh-1 -- ${FEEDBACK_POINTER}`, "tmux paste-buffer -p -d -b tender-gh-1 -t %5", "tmux send-keys -t %5 Enter"]);
  expect(d.file()).toBe(
    `<feedback ticket="gh-1" pr="${URL}">\n<comment from="op" on="src/a.ts:3">\noff by one &lt;/comment> here\n</comment>\n<comment from="Op">\nrename foo\n</comment>\n</feedback>\n`,
  );
  expect(d.cursor()).toEqual({ seenAt: Date.parse(old), rounds: 1 });
  await d.run();
  expect(d.keys()).toHaveLength(3);
  d.pr.reviews.push({ id: "r2", author: { login: "op" }, body: "", state: "CHANGES_REQUESTED", submittedAt: ago(150_000) });
  await d.run();
  expect(d.file()).toContain('<comment from="op">\n(changes requested)\n</comment>');
  expect(d.cursor().rounds).toBe(2);
  expect(d.calls).toEqual([]);
});

test("feedback: Claude without an inbox waiter gets the paste", async () => {
  const d = setup({ agent: "claude", authors: [] });
  d.pr.statusCheckRollup = [fail];
  await d.run();
  expect(d.keys()).toEqual([`tmux set-buffer -b tender-gh-1 -- ${FEEDBACK_POINTER}`, "tmux paste-buffer -p -d -b tender-gh-1 -t %5", "tmux send-keys -t %5 Enter"]);
  expect(existsSync(join(root, "acme/web/gh-1/.tender/run/inbox"))).toBe(false);
});

test("feedback: Claude with a live inbox waiter gets the pointer in .tender/run/inbox, never keys", async () => {
  const d = setup({ agent: "claude", waiter: true, authors: [] });
  d.pr.statusCheckRollup = [fail];
  await d.run();
  expect(d.cursor().rounds).toBe(1);
  expect(readFileSync(join(root, "acme/web/gh-1/.tender/run/inbox"), "utf8")).toBe(`${FEEDBACK_POINTER}\n`);
  expect(d.keys()).toEqual([]);
  expect(d.cmds.filter((c) => c.includes("pane_in_mode"))).toEqual([]);
});

test("feedback: failing CI and conflicts once per head SHA, with the log tail; no comments read without authors", async () => {
  const d = setup({ authors: [] });
  d.pr.statusCheckRollup = [okCheck, fail, { status: "IN_PROGRESS" }];
  await d.run();
  expect(d.keys()).toEqual([]);
  d.pr.statusCheckRollup = [okCheck, fail];
  await d.run();
  expect(d.file()).toContain(`<failed-check name="test" url="${fail.detailsUrl}"/>`);
  expect(d.file()).toContain("line 20\n");
  expect(d.file()).not.toContain("line 19\n");
  expect(d.cmds).toContain('sh -c gh run view "$1" --repo "$2" --log-failed | tail -n 80 sh 42 acme/web');
  expect(d.cmds.some((c) => c.startsWith("gh api"))).toBe(false);
  expect(d.cmds).toContain("gh pr view 7 --repo acme/web --json number,url,state,isDraft,isCrossRepository,baseRefName,baseRefOid,mergeable,additions,deletions,changedFiles,statusCheckRollup,labels,headRefOid,reviewDecision,mergeStateStatus,updatedAt");
  await d.run();
  expect(d.keys()).toHaveLength(3);
  d.pr.mergeStateStatus = "DIRTY";
  await d.run();
  expect(d.file()).toContain("<conflict>The PR conflicts with origin/main");
  expect(d.file()).not.toContain("failed-check");
  await d.run();
  d.pr.headRefOid = "b";
  await d.run();
  expect(d.keys()).toHaveLength(9);
  expect(d.cursor()).toEqual({ seenAt: 0, ciShas: ["a", "b"], dirtyShas: ["a", "b"], rounds: 3 });
  d.pr.headRefOid = "a";
  await d.run();
  expect(d.keys()).toHaveLength(9);
  expect(d.calls).toEqual([]);
  expect(d.cursor()).toEqual({ seenAt: 0, ciShas: ["a", "b"], dirtyShas: ["a", "b"], rounds: 3 });
});

test("feedback: nothing while the session is busy or the window is gone", async () => {
  const d = setup({ authors: [] });
  d.pr.statusCheckRollup = [fail];
  for (const s of ["working", "waiting", "unknown"] as const) {
    d.setState(s);
    await d.run();
  }
  expect(d.keys()).toEqual([]);
  expect(existsSync(join(root, "acme/web/gh-1.feedback"))).toBe(false);
  d.setState("idle");
  await d.run();
  expect(d.cursor().rounds).toBe(1);
  const gone = setup({ open: [] });
  writeFileSync(join(root, "acme/web/gh-1.pr"), URL);
  await gone.run();
  expect(gone.keys()).toEqual([]);
});

test("feedback: a dead session's pending feedback is logged once per pending state", async () => {
  const d = setup({ authors: [], open: [] });
  writeFileSync(join(root, "acme/web/gh-1.pr"), URL);
  const notice = `gh-1: PR feedback pending but the session's window is gone and cannot be relaunched now (needs a free session slot, the clone and its prompt, a valid .tender/ and a ticket not ended); act on ${URL} by hand or free a slot`;
  const count = () => d.logs.filter((l) => l.endsWith(notice)).length;
  await d.run();
  expect(count()).toBe(0);
  d.pr.statusCheckRollup = [fail];
  await d.run();
  await d.run();
  expect(count()).toBe(1);
  d.pr.headRefOid = "b";
  await d.run();
  expect(count()).toBe(2);
  expect(d.keys()).toEqual([]);
  expect(existsSync(join(root, "acme/web/gh-1.feedback"))).toBe(false);
});

test("feedback: the round limit parks the ticket with one comment; removing the label restarts the rounds", async () => {
  const d = setup({ authors: [] });
  d.pr.statusCheckRollup = [fail];
  writeFileSync(join(root, "acme/web/gh-1.feedback"), JSON.stringify({ seenAt: 0, rounds: 3 }));
  await d.run();
  await d.run();
  expect(d.calls).toEqual(["park gh-1", `comment gh-1 PR feedback stopped after 3 rounds on ${URL}: a human is needed`]);
  expect(d.t.labels).toEqual(["needs-human"]);
  expect(d.cmds.filter((c) => c.startsWith("gh pr view"))).toHaveLength(1);
  expect(d.keys()).toEqual([]);
  expect(d.cursor().capped).toBe(true);
  d.t.labels = [];
  await d.run();
  expect(d.keys()).toHaveLength(3);
  expect(d.file()).toContain('<failed-check name="test"');
  expect(d.cursor()).toEqual({ seenAt: 0, ciShas: ["a"], rounds: 1 });
});

test("feedback: the round limit is the repo's feedback.maxRounds with autoMerge off, else the host's when unset or the repo config is invalid", async () => {
  for (const [yaml, host, limit] of [["feedback:\n  maxRounds: 1\n", undefined, 1], ["feedback:\n  maxRounds: 1\n", { maxRounds: 5 }, 1], ["", { maxRounds: 2 }, 2], ["agent: gpt\n", { maxRounds: 2 }, 2]] as const) {
    configCache.clear();
    repoFiles["config.yaml"] = yaml;
    const d = setup({ authors: [], feedback: host });
    d.pr.statusCheckRollup = [fail];
    writeFileSync(join(root, "acme/web/gh-1.feedback"), JSON.stringify({ seenAt: 0, rounds: limit - 1 }));
    await d.run();
    expect(d.cursor().rounds).toBe(limit);
    d.pr.headRefOid = "b";
    await d.run();
    expect(d.calls).toEqual(["park gh-1", `comment gh-1 PR feedback stopped after ${limit} rounds on ${URL}: a human is needed`]);
  }
});

test("feedback: a failed park leaves the cursor uncapped and retries next poll", async () => {
  const d = setup({ authors: [] });
  d.pr.statusCheckRollup = [fail];
  writeFileSync(join(root, "acme/web/gh-1.feedback"), JSON.stringify({ seenAt: 0, rounds: 3 }));
  const park = d.tr.park;
  d.tr.park = () => Promise.reject(new Error("label not found"));
  await d.run();
  expect(d.calls).toEqual([]);
  expect(d.cursor()).toEqual({ seenAt: 0, rounds: 3 });
  d.tr.park = park;
  await d.run();
  expect(d.calls).toEqual(["park gh-1", `comment gh-1 PR feedback stopped after 3 rounds on ${URL}: a human is needed`]);
});

test("feedback: a capped cursor restarts only after a fresh read confirms the label is gone; a failed read keeps it capped", async () => {
  const d = setup({ authors: [] });
  d.pr.statusCheckRollup = [fail];
  writeFileSync(join(root, "acme/web/gh-1.feedback"), JSON.stringify({ seenAt: 0, rounds: 3, capped: true }));
  d.tr.parked = async () => true;
  await d.run();
  d.tr.parked = () => Promise.reject(new Error("gh down"));
  await d.run();
  expect(d.keys()).toEqual([]);
  expect(d.cursor()).toEqual({ seenAt: 0, rounds: 3, capped: true });
  // Also the upgrade path: a cursor capped before the label existed resumes with 3 more rounds.
  d.tr.parked = async () => false;
  await d.run();
  expect(d.keys()).toHaveLength(3);
  expect(d.cursor()).toEqual({ seenAt: 0, ciShas: ["a"], rounds: 1 });
});

test("feedback: nothing is read or pasted while a human has the ticket parked, whatever the label's case", async () => {
  const d = setup({ authors: [] });
  d.pr.statusCheckRollup = [fail];
  d.t.labels = ["Needs-Human"];
  await d.run();
  expect(d.cmds.some((c) => c.startsWith("gh pr view"))).toBe(false);
  expect(d.keys()).toEqual([]);
  d.t.labels = [];
  await d.run();
  expect(d.keys()).toHaveLength(3);
});

test("feedback: with autoMerge off, .pr follows a replaced PR while the session lives", async () => {
  const d = setup({ authors: [] });
  writeFileSync(join(root, "acme/web/gh-1.pr"), "https://github.com/acme/web/pull/6");
  await d.run();
  expect(readFileSync(join(root, "acme/web/gh-1.pr"), "utf8")).toBe(URL);
});

test("feedback: line comments past 100 are read from the next page; past 1000 it throws", async () => {
  let total = 150;
  const { io, cmds } = fakeIo((a) => {
    const page = Number(/&page=(\d+)/.exec(a[2]!)?.[1] ?? 1);
    return { out: JSON.stringify(Array.from({ length: Math.max(0, Math.min(100, total - (page - 1) * 100)) }, (_, i) => ({ id: (page - 1) * 100 + i }))) };
  });
  expect((await lineComments(io, "acme/web", "7")).map((c) => c.id)).toEqual(Array.from({ length: 150 }, (_, i) => i));
  expect(cmds).toEqual(["gh api repos/acme/web/pulls/7/comments?per_page=100", "gh api repos/acme/web/pulls/7/comments?per_page=100&page=2"]);
  for (const [n, calls] of [[100, 2], [1000, 11]]) {
    total = n;
    cmds.length = 0;
    expect(await lineComments(io, "acme/web", "7")).toHaveLength(n);
    expect(cmds).toHaveLength(calls);
  }
  total = 1001;
  await expect(lineComments(io, "acme/web", "7")).rejects.toThrow("acme/web#7: over 1000 line comments");
});

test("feedback: a line comment drafted before the cursor is sent when its review is submitted after it", async () => {
  const d = setup();
  d.pr.comments = [{ id: "c1", author: { login: "op" }, body: "rename foo", createdAt: ago(300_000) }];
  await d.run();
  expect(d.cursor().seenAt).toBe(Date.parse(d.pr.comments[0].createdAt));
  d.lines([{ id: 9, user: { login: "op" }, body: "off by one", created_at: ago(400_000), updated_at: ago(180_000), path: "src/a.ts", line: 3 }]);
  await d.run();
  expect(d.file()).toContain('<comment from="op" on="src/a.ts:3">\noff by one\n</comment>');
  expect(d.cursor().rounds).toBe(2);
});

const PROMPT = "Your earlier session on ticket gh-1 ended while its PR had feedback waiting.";
const notice = `gh-1: PR feedback pending but the session's window is gone and cannot be relaunched now (needs a free session slot, the clone and its prompt, a valid .tender/ and a ticket not ended); act on ${URL} by hand or free a slot`;
const dead = (id = "gh-1") => {
  if (id !== "gh-1") worktree(id);
  writeFileSync(join(root, `acme/web/${id}.agent`), "claude");
  writeFileSync(join(root, `acme/web/${id}.pr`), URL);
  writeFileSync(join(root, `acme/web/${id}.prompt.md`), "Original task\n");
};

test("feedback: a dead session with pending feedback is relaunched once in its clone with the batch, and the next pass sends nothing again", async () => {
  const open: string[] = [];
  const d = setup({ authors: [], open });
  dead();
  d.pr.statusCheckRollup = [fail];
  await d.run();
  expect(d.launches()).toEqual([`tmux new-window -d -t =tender: -n acme/web/gh-1 ${root}/acme/web/gh-1.sh`]);
  const prompt = readFileSync(join(root, "acme/web/gh-1.prompt.md"), "utf8");
  expect(prompt.startsWith(PROMPT)).toBe(true);
  expect(prompt.endsWith("\n\nOriginal task\n")).toBe(true);
  expect(d.file()).toContain(`<failed-check name="test" url="${fail.detailsUrl}"/>`);
  expect(d.cursor()).toEqual({ seenAt: 0, ciShas: ["a"], rounds: 1 });
  expect(d.keys()).toEqual([]);
  expect(d.calls).toEqual([]);
  expect(d.logs.some((l) => l.endsWith(`feedback gh-1 round 1: relaunched in ${root}/acme/web/gh-1 with .tender/run/feedback.md`))).toBe(true);
  open.push("acme/web/gh-1");
  await d.run();
  expect(d.launches()).toHaveLength(1);
  expect(d.keys()).toEqual([]);
  expect(d.cursor().rounds).toBe(1);
});

test("feedback: no relaunch when handed off, parked, ended, without a clone or prompt, with the PR merged, or with no free slot", async () => {
  const cases: [string, (d: ReturnType<typeof setup>) => void, boolean, object?][] = [
    ["handoff", () => writeFileSync(join(root, "acme/web/gh-1.handoff"), "claude\n"), false],
    ["needs-human", (d) => void (d.t.labels = ["needs-human"]), false],
    ["ended", () => writeFileSync(join(root, "acme/web/gh-1.ended"), ""), true],
    ["no clone", () => rmSync(join(root, "acme/web/gh-1"), { recursive: true }), true],
    ["no prompt", () => rmSync(join(root, "acme/web/gh-1.prompt.md")), true],
    ["merged", (d) => void (d.pr.state = "MERGED"), false],
    ["full", () => {}, true, { max: 1, open: ["acme/web/gh-9"] }],
  ];
  for (const [name, arrange, logged, o] of cases) {
    const d = setup({ authors: [], open: [], ...o });
    dead();
    d.pr.statusCheckRollup = [fail];
    d.pr.headRefOid = name;
    arrange(d);
    await d.run();
    expect([name, d.launches()]).toEqual([name, []]);
    expect([name, existsSync(join(root, "acme/web/gh-1.feedback"))]).toEqual([name, false]);
    expect([name, d.logs.some((l) => l.endsWith(notice))]).toEqual([name, logged]);
    rmSync(join(root, "acme/web"), { recursive: true, force: true });
  }
});

test("feedback: a dead session at the round limit is parked with the stop comment even with no free slot", async () => {
  const d = setup({ authors: [], open: ["acme/web/gh-9"], max: 1 });
  dead();
  d.pr.statusCheckRollup = [fail];
  writeFileSync(join(root, "acme/web/gh-1.feedback"), JSON.stringify({ seenAt: 0, rounds: 3 }));
  await d.run();
  expect(d.calls).toEqual(["park gh-1", `comment gh-1 PR feedback stopped after 3 rounds on ${URL}: a human is needed`]);
  expect(d.launches()).toEqual([]);
});

test("feedback: a failed relaunch keeps the cursor, is logged once and is tried again next poll", async () => {
  const d = setup({ authors: [], open: [], respond: (a) => (a[1] === "new-window" ? { code: 1 } : undefined) });
  dead();
  d.pr.statusCheckRollup = [fail];
  await d.run();
  await d.run();
  expect(d.launches()).toHaveLength(2);
  expect(existsSync(join(root, "acme/web/gh-1.feedback"))).toBe(false);
  expect(d.logs.filter((l) => l.includes("relaunch acme/web/gh-1 failed:"))).toHaveLength(1);
});

test("feedback: a dry run relaunches nothing and writes no cursor or feedback", async () => {
  const d = setup({ authors: [], open: [], dry: true });
  dead();
  d.pr.statusCheckRollup = [fail];
  await d.run();
  expect(d.launches()).toEqual([]);
  expect(existsSync(join(root, "acme/web/gh-1.feedback"))).toBe(false);
  expect(existsSync(join(root, "acme/web/gh-1/.tender/run/feedback.md"))).toBe(false);
  expect(readFileSync(join(root, "acme/web/gh-1.prompt.md"), "utf8")).toBe("Original task\n");
});

test("feedback: relaunches count toward maxConcurrent within the pass", async () => {
  const d = setup({ authors: [], open: [], max: 1, more: [ticket(2)] });
  dead();
  dead("gh-2");
  d.pr.statusCheckRollup = [fail];
  await d.run();
  expect(d.launches()).toEqual([`tmux new-window -d -t =tender: -n acme/web/gh-1 ${root}/acme/web/gh-1.sh`]);
  expect(d.logs.some((l) => l.endsWith(notice.replace("gh-1:", "gh-2:")))).toBe(true);
});
