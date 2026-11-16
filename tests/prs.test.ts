import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentTicket, classify, prs, type Pr } from "../src/prs";
import type { Tracker } from "../src/types";
import { config, fakeIo, fakeTracker, raw, root, src, useTempRoot, windowsOut } from "./helpers";
import { parseConfig } from "../src/config/config";

useTempRoot();

const NOW = Date.parse("2026-06-01T00:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const pr = (n: number, over: Partial<Pr> = {}): Pr => ({
  number: n,
  title: `PR ${n} @bob`,
  url: `https://github.com/acme/web/pull/${n}`,
  author: { login: "alice" },
  headRefName: `feat/${n}`,
  isCrossRepository: false,
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  statusCheckRollup: [],
  createdAt: ago(1),
  updatedAt: ago(1),
  ...over,
});

function setup(list: Pr[], tracker: Parameters<typeof fakeTracker>[0] = {}, { dry = false, wins = [] as string[], over = {} as object, tr = undefined as Tracker | undefined } = {}) {
  const cfg = config(over);
  const { tr: fake } = fakeTracker(tracker);
  const { io, cmds, logs } = fakeIo((a) => (a[1] === "pr" && a[2] === "list" ? { out: JSON.stringify(list) } : a[0] === "tmux" && a[1] === "list-windows" ? windowsOut(wins) : undefined), dry);
  const events: unknown[][] = [];
  if (!dry) io.event = (...a) => void events.push(a);
  return { cmds, logs, events, wins, go: () => prs(cfg, io, { now: NOW, tracker: () => tr ?? fake }) };
}
const writes = (cmds: string[]) => cmds.filter((c) => /^gh (pr close|api -X|issue edit)/.test(c));

test("classify: conflicting, failing, stale, draft-stale, ready", () => {
  expect(classify(pr(1), 14, NOW)).toEqual([]);
  expect(classify(pr(1, { mergeable: "CONFLICTING", statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] }), 14, NOW)).toEqual(["conflicting", "failing"]);
  expect(classify(pr(1, { updatedAt: ago(15) }), 14, NOW)).toEqual(["stale"]);
  expect(classify(pr(1, { updatedAt: ago(15), isDraft: true }), 14, NOW)).toEqual(["draft-stale"]);
  expect(classify(pr(1, { mergeStateStatus: "CLEAN", createdAt: ago(20) }), 14, NOW)).toEqual(["ready"]);
  expect(classify(pr(1, { mergeStateStatus: "CLEAN", createdAt: ago(3) }), 14, NOW)).toEqual([]);
  expect(classify(pr(1, { statusCheckRollup: [{ status: "IN_PROGRESS" }] }), 14, NOW)).toEqual([]);
});

test("agentTicket: same-repo agent branches only", () => {
  expect(agentTicket(pr(1, { headRefName: "agent/gh-3" }))).toBe("gh-3");
  expect(agentTicket(pr(1, { headRefName: "agent/gh-3", isCrossRepository: true }))).toBeUndefined();
  expect(agentTicket(pr(1, { headRefName: "agent/../x" }))).toBeUndefined();
  expect(agentTicket(pr(1, { headRefName: "feat/gh-3" }))).toBeUndefined();
});

test("prs: closes an orphan agent PR, records it, deletes the branch, reports the rest", async () => {
  const s = setup([pr(1, { headRefName: "agent/gh-3" }), pr(2, { headRefName: "agent/gh-4" }), pr(5, { mergeable: "CONFLICTING" }), pr(6)], { done: ["gh-3"] });
  const report = await s.go();
  expect(writes(s.cmds)).toEqual(["gh pr close 1 --repo acme/web --comment tender: closed, ticket gh-3 is done", "gh api -X DELETE repos/acme/web/git/refs/heads/agent/gh-3"]);
  expect(s.events).toEqual([["pr-closed", "acme/web", "gh-3", { pr: pr(1).url, ticket: "done" }, pr(1).url]]);
  expect(report).toContain("4 open PRs, 1 orphans closed");
  expect(report).toContain("- [acme/web#1](https://github.com/acme/web/pull/1) orphan (ticket done), closed: PR 1 @​bob (@​alice)");
  expect(report).toContain("acme/web#5](https://github.com/acme/web/pull/5) conflicting:");
  expect(report).not.toContain("#2]");
  expect(report).not.toContain("#6]");
});

test("prs: canceled tickets close too; Linear ids ask the team's source", async () => {
  const s = setup([pr(1, { headRefName: "agent/ENG-7" })], { canceled: ["ENG-7"] }, { over: { sources: [src({ name: "lin", tracker: "linear", team: "ENG" })] } });
  expect(await s.go()).toContain("orphan (ticket canceled), closed");
  expect(writes(s.cmds)).toHaveLength(2);
  const other = setup([pr(1, { headRefName: "agent/OPS-7" })], { canceled: ["OPS-7"] }, { over: { sources: [src({ name: "lin", tracker: "linear", team: "ENG" })] } });
  await other.go();
  expect(writes(other.cmds)).toEqual([]);
});

test("prs: never closes with a live window, a hand-off, a fork, or an unknown ticket state", async () => {
  const live = setup([pr(1, { headRefName: "agent/gh-3" })], { done: ["gh-3"] }, { wins: ["acme/web/gh-3"] });
  expect(await live.go()).toContain("not closed: live session");
  expect(writes(live.cmds)).toEqual([]);

  const handed = setup([pr(1, { headRefName: "agent/gh-3" })], { done: ["gh-3"] });
  mkdirSync(join(root, "acme/web"), { recursive: true });
  writeFileSync(join(root, "acme/web", "gh-3.handoff"), "claude\n");
  expect(await handed.go()).toContain("not closed: handed off");
  expect(writes(handed.cmds)).toEqual([]);

  const fork = setup([pr(1, { headRefName: "agent/gh-3", isCrossRepository: true })], { done: ["gh-3"] });
  await fork.go();
  expect(writes(fork.cmds)).toEqual([]);

  const { tr } = fakeTracker({});
  tr.closed = async () => {
    throw new Error("tracker down");
  };
  const err = setup([pr(1, { headRefName: "agent/gh-3" })], {}, { tr });
  expect(await err.go()).toContain("ticket gh-3 state unknown");
  expect(writes(err.cmds)).toEqual([]);
});

test("prs: a missing tmux server or session allows a close; a tmux error or timeout does not", async () => {
  const cases: [{ code: number; err?: string }, number][] = [
    [{ code: 1, err: "no server running on /tmp/tmux-1000/default" }, 2],
    [{ code: 1, err: "can't find session: =tender" }, 2],
    [{ code: 1, err: "error connecting to /tmp/tmux-1000/default (No such file or directory)" }, 2],
    [{ code: 124, err: "tmux has-session timed out after 60s" }, 0],
    [{ code: 1, err: "error connecting to /tmp/tmux-1000/default (Permission denied)" }, 0],
    [{ code: 0 }, 0],
  ];
  for (const [has, n] of cases) {
    const { tr } = fakeTracker({ done: ["gh-3"] });
    const { io, cmds } = fakeIo((a) => (a[1] === "pr" && a[2] === "list" ? { out: JSON.stringify([pr(1, { headRefName: "agent/gh-3" })]) } : a[1] === "list-windows" ? { code: 1, err: "x" } : a[1] === "has-session" ? has : undefined));
    const report = await prs(config(), io, { now: NOW, tracker: () => tr });
    expect(writes(cmds)).toHaveLength(n);
    if (!n) expect(report).toContain("not closed: sessions unknown");
  }
});

test("prs: a resume or hand-off during the sweep's reads blocks the close", async () => {
  for (const during of ["window", "handoff"]) {
    const { tr } = fakeTracker({ done: ["gh-3"] });
    const s = setup([pr(1, { headRefName: "agent/gh-3" })], {}, { tr });
    tr.closed = async () => {
      if (during === "window") s.wins.push("acme/web/gh-3");
      else {
        mkdirSync(join(root, "acme/web"), { recursive: true });
        writeFileSync(join(root, "acme/web", "gh-3.handoff"), "claude\n");
      }
      return "done";
    };
    expect(await s.go()).toContain(during === "window" ? "not closed: live session" : "not closed: handed off");
    expect(writes(s.cmds)).toEqual([]);
  }
});

test("prs: a ticket reopened before the second state read is not closed", async () => {
  const { tr } = fakeTracker({});
  let calls = 0;
  tr.closed = async () => (calls++ ? undefined : "done");
  const s = setup([pr(1, { headRefName: "agent/gh-3" })], {}, { tr });
  expect(await s.go()).toContain("not closed: ticket state changed");
  expect(writes(s.cmds)).toEqual([]);
});

test("prs: titles are literal Markdown in the digest, bare URLs included", async () => {
  const z = "\u200b";
  const s = setup([pr(5, { mergeable: "CONFLICTING", title: "[Approved](https://evil) `code` <b>hi</b> @bob see www.evil.io or a@evil.io" })], {}, { over: { prs: { digestIssue: "acme/web#9" } } });
  expect(await s.go()).toContain(`: \\[Approved\\]\\(https${z}:${z}//evil\\) \\\`code\\\` \\<b\\>hi\\</b\\> @${z}bob see www${z}.${z}evil${z}.${z}io or a@evil${z}.${z}io (@${z}alice)`);
});

test("prs: commands under the poll lock are bounded; a timed-out close is not retried as a delete", async () => {
  const { tr } = fakeTracker({ done: ["gh-3"] });
  const { io, cmds } = fakeIo((a) => (a[1] === "pr" && a[2] === "list" ? { out: JSON.stringify([pr(1, { headRefName: "agent/gh-3" })]) } : a[1] === "pr" && a[2] === "close" ? { code: 124, err: "gh pr close timed out after 20s" } : undefined));
  const secs: Record<string, number | undefined> = {};
  const run = io.run;
  io.run = (argv, cwd, t, o) => ((secs[argv.slice(0, 3).join(" ")] = t), run(argv, cwd, t, o));
  expect(await prs(config(), io, { now: NOW, tracker: () => tr })).toContain("orphan (ticket done), close failed");
  expect(secs).toMatchObject({ "tmux list-windows -t": 5, "gh pr close": 20 });
  expect(writes(cmds)).toEqual(["gh pr close 1 --repo acme/web --comment tender: closed, ticket gh-3 is done"]);
});

test("prs --dry-run: no writes, says what it would close", async () => {
  const s = setup([pr(1, { headRefName: "agent/gh-3" })], { done: ["gh-3"] }, { dry: true, over: { prs: { digestIssue: "acme/web#9" } } });
  expect(await s.go()).toContain("orphan (ticket done), would close");
  expect(writes(s.cmds)).toEqual([]);
  expect(s.logs).toContain("dry: gh pr close 1 --repo acme/web --comment tender: closed, ticket gh-3 is done");
  expect(s.logs).toContain("dry: rewrite acme/web#9");
});

test("prs: rewrites the digest issue body with the report", async () => {
  const s = setup([pr(5, { mergeable: "CONFLICTING" })], {}, { over: { prs: { digestIssue: "acme/web#9" } } });
  const report = await s.go();
  expect(writes(s.cmds)).toEqual([`gh issue edit 9 --repo acme/web --body ${report}`]);
  expect(await setup([pr(6)]).go()).toContain("Nothing to report.");
});

test("config: prs defaults and validation", () => {
  expect(config().prs).toEqual({ staleDays: 14 });
  expect(config({ prs: { staleDays: 7, digestIssue: "acme/web#12" } }).prs).toEqual({ staleDays: 7, digestIssue: "acme/web#12" });
  const bad = (prs: unknown) => expect(() => parseConfig(raw({ prs }), root)).toThrow(/prs/);
  for (const p of [{ staleDays: 0 }, { staleDays: 1.5 }, { staleDays: "14" }, { digestIssue: "acme/web" }, { digestIssue: "acme/api#3" }, { digestIssue: "acme/web#0" }, { digestIssue: "https://github.com/acme/web/issues/3" }, { closeAfterDays: 14 }, "weekly"]) bad(p);
});
