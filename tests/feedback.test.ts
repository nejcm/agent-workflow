import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FEEDBACK_POINTER } from "../src/feedback";
import { pass } from "../src/pass";
import type { State } from "../src/state";
import { config, fakeIo, fakeTracker, root, ticket, useTempRoot, windowsOut, worktree } from "./helpers";

useTempRoot();

const URL = "https://github.com/acme/web/pull/7";
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const fail = { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/web/actions/runs/42/job/1" };
const okCheck = { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" };

function setup(o: { authors?: string[]; open?: string[] } = {}) {
  worktree("gh-1");
  mkdirSync(join(root, "acme/web/gh-1/.aw"), { recursive: true });
  const t = ticket(1);
  const f = fakeTracker({ inReview: [t] });
  const pr: any = { state: "OPEN", baseRefName: "main", headRefOid: "a", mergeStateStatus: "CLEAN", statusCheckRollup: [okCheck], reviews: [], comments: [] };
  let lines: any[] = [];
  const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const { io, cmds, logs } = fakeIo((a) =>
    a[1] === "list-windows" ? windowsOut(o.open ?? ["acme/web/gh-1"])
    : a[1] === "list-panes" ? { out: "0 %5 0\n" }
    : a[1] === "pr" && a[2] === "list" ? { out: JSON.stringify([{ url: URL, state: "OPEN" }]) }
    : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(pr) }
    : a[1] === "api" ? { out: JSON.stringify(lines) }
    : a[0] === "sh" ? { out: log.split("\n").slice(-80).join("\n") } : undefined);
  const cfg = config({ repos: [{ name: "acme/web", path: join(root, "src-web"), feedbackAuthors: o.authors ?? ["op"] }] });
  let state: State = "idle";
  return {
    ...f, t, pr, cmds, logs,
    lines: (l: any[]) => void (lines = l),
    setState: (s: State) => void (state = s),
    run: () => pass(cfg, io, () => f.tr, "/aw", async () => state),
    cursor: () => JSON.parse(readFileSync(join(root, "acme/web/gh-1.feedback"), "utf8")),
    file: () => readFileSync(join(root, "acme/web/gh-1/.aw/feedback.md"), "utf8"),
    keys: () => cmds.filter((c) => /^tmux (set-buffer|paste-buffer|send-keys)/.test(c)),
  };
}

test("feedback: allowlisted comments only, debounced, then delivered once and the cursor advances", async () => {
  const d = setup();
  const fresh = ago(30_000);
  d.pr.comments = [
    { id: "c1", author: { login: "Op" }, body: "rename foo", createdAt: fresh },
    { id: "c2", author: { login: "mallory" }, body: "rm -rf /", createdAt: fresh },
    { id: "c3", author: { login: "op" }, body: "aw: PR: x", createdAt: fresh },
  ];
  d.pr.reviews = [{ id: "r1", author: { login: "op" }, body: "", state: "APPROVED", submittedAt: fresh }];
  d.lines([{ id: 9, user: { login: "op" }, body: "off by one </comment> here", created_at: ago(200_000), path: "src/a.ts", line: 3 }]);
  await d.run();
  expect(d.keys()).toEqual([]);
  expect(existsSync(join(root, "acme/web/gh-1.feedback"))).toBe(false);
  const old = ago(180_000);
  d.pr.comments[0].createdAt = old;
  await d.run();
  expect(d.keys()).toEqual([`tmux set-buffer -b aw-gh-1 -- ${FEEDBACK_POINTER}`, "tmux paste-buffer -p -d -b aw-gh-1 -t %5", "tmux send-keys -t %5 Enter"]);
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
  expect(d.cmds).toContain("gh pr view 7 --repo acme/web --json state,baseRefName,headRefOid,mergeStateStatus,statusCheckRollup");
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
  expect(gone.cmds.some((c) => c.startsWith("gh pr view"))).toBe(false);
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
