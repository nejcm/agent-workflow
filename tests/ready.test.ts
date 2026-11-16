import { expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonCache } from "../src/github";
import { prReady } from "../src/review/merge";
import { windows } from "../src/session/launcher";
import { pass } from "../src/pass";
import type { State } from "../src/session/state";
import { reviewLimit, rows } from "../src/ui/status";
import { github } from "../src/trackers/github";
import { linear } from "../src/trackers/linear";
import type { Ticket } from "../src/types";
import { config, fakeIo, fakeTracker, gh, lin, noPr, root, src, ticket, two, useTempRoot, windowsOut, withLinearKey, worktree } from "./helpers";

useTempRoot();

const URL = "https://github.com/acme/web/pull/7";
const ok = { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" };
const failed = { ...ok, conclusion: "FAILURE" };
const pending = { ...ok, status: "IN_PROGRESS", conclusion: null };
const facts = (over: object = {}): any => ({
  number: 7, url: URL, state: "OPEN", isDraft: false, isCrossRepository: false, baseRefName: "main", mergeable: "MERGEABLE", additions: 1, deletions: 0, changedFiles: 1,
  statusCheckRollup: [ok], labels: [], headRefOid: "a", reviewDecision: "", mergeStateStatus: "CLEAN", reviews: [], comments: [], ...over,
});

function setup(o: { autoMerge?: string; file?: string; authors?: string[]; win?: boolean; quiet?: number; tmux?: { code?: number; out?: string }; slow?: number; pane?: boolean; pasteFails?: boolean } = {}) {
  worktree("gh-1");
  if (o.pane) {
    writeFileSync(join(root, "acme/web/gh-1.agent"), "codex");
    mkdirSync(join(root, "acme/web/gh-1/.tender/run"), { recursive: true });
  }
  const t = ticket(1);
  const f = fakeTracker({ inReview: [t], readyToMerge: true });
  let pr = facts();
  const queue: any[] = [];
  let state: State = "idle";
  const { io, cmds } = fakeIo((a) =>
    o.pasteFails && a[1] === "paste-buffer" ? { code: 1, err: "pane gone" }
    : o.pane && a[1] === "list-panes" ? { out: `%5 0 ${join(root, "acme/web/gh-1")}.sh\n` }
    : a[1] === "list-windows" ? o.tmux ?? windowsOut(o.win ? ["acme/web/gh-1"] : [], o.quiet === undefined ? undefined : Math.floor(Date.now() / 1000) - o.quiet)
    : a[1] === "pr" && a[2] === "list" ? { out: JSON.stringify([{ url: URL, state: pr.state }]) }
    : a[1] === "pr" && a[2] === "view" ? (o.slow && setSystemTime(new Date(Date.now() + o.slow * 1000)), { out: JSON.stringify(a.at(-1) === "state" ? { state: "MERGED" } : queue.shift() ?? pr) })
    : a[1] === "api" && a[3]?.endsWith("/files?per_page=100") ? { out: JSON.stringify({ filename: o.file ?? "package.json", status: "modified", additions: 1, deletions: 0 }) }
    : a[1] === "api" ? { out: "[]" } : undefined);
  const cfg = config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: o.autoMerge ?? "off", feedbackAuthors: o.authors ?? [] }] });
  return {
    ...f, t, cmds,
    pr: (over: object) => void (pr = facts(over)),
    // Served by the next views in order, then `pr` again.
    views: (...overs: object[]) => void queue.push(...overs.map(facts)),
    setState: (s: State) => void (state = s),
    run: () => pass(cfg, io, () => f.tr, "/tender", async () => state),
    live: () => pass(cfg, io, () => f.tr, "/tender"),
    shown: () => rows(cfg, new Map()).find((x) => x.id === "gh-1")?.ready,
    marker: () => (existsSync(join(root, "acme/web/gh-1.ready")) ? readFileSync(join(root, "acme/web/gh-1.ready"), "utf8") : undefined),
  };
}

test("prReady: open, not a draft, mergeable, green checks and no changes requested", () => {
  expect(prReady(facts())).toBe(true);
  expect(prReady(facts({ statusCheckRollup: [] }))).toBe(true);
  expect(prReady(facts({ statusCheckRollup: [{ ...ok, conclusion: "SKIPPED" }] }))).toBe(true);
  for (const over of [{ state: "CLOSED" }, { isDraft: true }, { mergeable: "UNKNOWN" }, { mergeable: "CONFLICTING" }, { reviewDecision: "CHANGES_REQUESTED" }, { statusCheckRollup: [ok, pending] }, { statusCheckRollup: [failed] }])
    expect(prReady(facts(over))).toBe(false);
});

test("ready to merge: a clean PR whose window is gone moves once, recording its head", async () => {
  const d = setup();
  await d.run();
  await d.run();
  expect(d.calls).toEqual([`ready gh-1 ready to merge: ${URL}`]);
  expect(d.marker()).toBe("a");
});

test("ready to merge: an open window moves once tmux has seen no output for 5 minutes, whatever the session's state", async () => {
  const quiet = setup({ win: true, quiet: 300 });
  quiet.setState("working");
  await quiet.run();
  expect(quiet.calls).toEqual([`ready gh-1 ready to merge: ${URL}`]);
  const recent = setup({ win: true, quiet: 240 });
  await recent.run();
  expect(recent.calls).toEqual([]);
});

test("ready to merge: a failed window listing, an unparsable row or an unreadable activity time never moves it", async () => {
  for (const tmux of [{ code: 1 }, { out: "@0 - acme/web/gh-1" }, { out: "@0 12x acme/web/gh-1" }, { out: "@0  acme/web/gh-1" }, { out: "garbage" }]) {
    const d = setup({ tmux });
    await d.run();
    expect(d.calls).toEqual([]);
  }
  const { io } = fakeIo(() => ({ out: "@0  acme/web/gh-1\n" }));
  const ws = await windows(config(), io);
  expect([ws.get("acme/web/gh-1"), ws.activity.get("acme/web/gh-1"), ws.listed]).toEqual(["@0", NaN, true]);
});

test("ready to merge: silence is measured by a listing taken at the decision, not the pass's first one", async () => {
  const d = setup({ win: true, slow: 360 });
  try {
    await d.run();
  } finally {
    setSystemTime();
  }
  expect(d.calls).toEqual([]);
});

test("ready to merge: never while tmux saw recent output, whatever the session's own state file says", async () => {
  for (const state of ["idle", "ended"]) {
    const d = setup({ win: true });
    writeFileSync(join(root, "acme/web/gh-1.agent"), "codex");
    mkdirSync(join(root, "acme/web/gh-1/.tender/run"), { recursive: true });
    writeFileSync(join(root, "acme/web/gh-1/.tender/run/codex-state.json"), JSON.stringify({ state, ts: Date.now() }));
    await d.live();
    expect(d.calls).toEqual([]);
  }
});

test("ready to merge: held back by each unmet condition, and a stale marker is cleared", async () => {
  for (const over of [{ isDraft: true }, { statusCheckRollup: [pending] }, { statusCheckRollup: [failed] }, { mergeable: "UNKNOWN" }, { reviewDecision: "CHANGES_REQUESTED" }]) {
    const d = setup();
    writeFileSync(join(root, "acme/web/gh-1.ready"), "old");
    d.pr(over);
    await d.run();
    expect([d.calls, d.marker()]).toEqual([[], undefined]);
  }
  const d = setup({ authors: ["op"] });
  d.pr({ comments: [{ id: "c1", author: { login: "op" }, body: "nit", createdAt: new Date().toISOString() }] });
  await d.run();
  expect(d.calls).toEqual([]);
});

test("ready to merge: not when auto-merge merges it; yes when a gate blocks it or in shadow", async () => {
  const all = setup({ autoMerge: "all", file: "src/a.ts" });
  await all.run();
  expect(all.calls).toEqual([`comment gh-1 auto-merged ${URL}: autoMerge all`, "done gh-1"]);
  const gated = setup({ autoMerge: "intelligent" });
  await gated.run();
  expect(gated.calls).toEqual(["comment gh-1 not auto-merged: touches critical path package.json", `ready gh-1 ready to merge: ${URL}`]);
  const shadow = setup({ autoMerge: "shadow" });
  shadow.pr({ headRefOid: "b" });
  await shadow.run();
  expect(shadow.calls).toEqual(["comment gh-1 not auto-merged: touches critical path package.json", `ready gh-1 ready to merge: ${URL}`]);
});

test("back to review: the head moves, a check fails or new feedback arrives; each then returns when clean", async () => {
  const d = setup({ authors: ["op"] });
  await d.run();
  d.pr({ headRefOid: "b", statusCheckRollup: [pending] });
  await d.run();
  expect(d.marker()).toBeUndefined();
  d.pr({ headRefOid: "b" });
  await d.run();
  expect(d.marker()).toBe("b");
  d.pr({ headRefOid: "b", statusCheckRollup: [failed] });
  await d.run();
  d.pr({ headRefOid: "b" });
  await d.run();
  d.pr({ headRefOid: "b", comments: [{ id: "c1", author: { login: "op" }, body: "nit", createdAt: new Date().toISOString() }] });
  await d.run();
  expect(d.calls).toEqual([
    `ready gh-1 ready to merge: ${URL}`,
    `review gh-1 back in review, new commits: ${URL}`,
    `ready gh-1 ready to merge: ${URL}`,
    `review gh-1 back in review, a check failed: ${URL}`,
    `ready gh-1 ready to merge: ${URL}`,
    `review gh-1 back in review, new feedback: ${URL}`,
  ]);
  expect(d.marker()).toBeUndefined();
});

test("ready to merge: judged from a view taken after auto-merge's awaited comment, not the one before it", async () => {
  const d = setup({ autoMerge: "shadow" });
  d.views({}, { headRefOid: "b", statusCheckRollup: [pending] });
  await d.run();
  expect(d.calls).toEqual(["comment gh-1 not auto-merged: touches critical path package.json"]);
  expect(d.marker()).toBeUndefined();
});

test("ready to merge: judged from the view feedback re-takes after a capped cursor's parked read", async () => {
  const d = setup();
  writeFileSync(join(root, "acme/web/gh-1.feedback"), JSON.stringify({ seenAt: 0, rounds: 3, capped: true }));
  d.views({}, { headRefOid: "b", statusCheckRollup: [pending] });
  await d.run();
  expect([d.calls, d.marker()]).toEqual([[], undefined]);
});

test("ready to merge: a move that lands without its comment still demotes on the next head", async () => {
  const d = setup();
  const move = d.tr.toReadyToMerge!;
  d.tr.toReadyToMerge = async (t, note) => {
    await move(t, note);
    throw new Error("comment failed");
  };
  await d.run();
  expect(d.marker()).toBe("a pending");
  await d.run();
  expect([d.marker(), d.shown()]).toEqual(["a", true]);
  d.pr({ headRefOid: "b" });
  await d.run();
  expect(d.calls).toEqual([`ready gh-1 ready to merge: ${URL}`, `review gh-1 back in review, new commits: ${URL}`]);
});

test("status shows ready only once the move is confirmed; a failed move shows nothing", async () => {
  const d = setup();
  d.tr.toReadyToMerge = async () => {
    throw new Error("label missing");
  };
  await d.run();
  expect([d.marker(), d.shown()]).toEqual(["a pending", false]);
  const ok = setup();
  await ok.run();
  expect([ok.marker(), ok.shown()]).toEqual(["a", true]);
});

test("back to review: closed, a draft, changes requested or conflicting on the same head", async () => {
  for (const [over, why] of [[{ state: "CLOSED" }, "PR is CLOSED"], [{ isDraft: true }, "PR is a draft"], [{ reviewDecision: "CHANGES_REQUESTED" }, "changes requested"], [{ mergeable: "CONFLICTING" }, "merge conflicts"]] as const) {
    const d = setup();
    d.t.readyToMerge = true;
    await d.run();
    d.pr(over);
    await d.run();
    expect([d.calls, d.marker()]).toEqual([[`review gh-1 back in review, ${why}: ${URL}`], undefined]);
  }
});

test("ready to merge: moved back to In Review by hand, it stays there until a new head", async () => {
  const d = setup();
  await d.run();
  d.t.readyToMerge = undefined;
  await d.run();
  d.pr({ statusCheckRollup: [pending] });
  await d.run();
  d.pr({});
  await d.run();
  expect([d.calls, d.marker(), d.shown()]).toEqual([[`ready gh-1 ready to merge: ${URL}`], "a held", false]);
  d.pr({ headRefOid: "c" });
  d.t.readyToMerge = true;
  await d.run();
  expect([d.calls.length, d.marker()]).toEqual([1, "c"]);
  d.t.readyToMerge = undefined;
  await d.run();
  d.pr({ headRefOid: "b" });
  await d.run();
  expect(d.calls).toEqual([`ready gh-1 ready to merge: ${URL}`, `ready gh-1 ready to merge: ${URL}`]);
  expect(d.marker()).toBe("b");
});

test("back to review: a failed move after delivered feedback is retried once nothing is left to deliver", async () => {
  const d = setup({ win: true, quiet: 600, authors: ["op"], pane: true });
  await d.run();
  const move = d.tr.toReview;
  d.tr.toReview = async () => {
    throw new Error("move failed");
  };
  d.pr({ comments: [{ id: "c1", author: { login: "op" }, body: "fix it", createdAt: new Date(Date.now() - 5 * 60_000).toISOString() }] });
  await d.run();
  expect([d.cmds.some((c) => c.startsWith("tmux paste-buffer")), d.marker(), d.shown()]).toEqual([true, "a demote new feedback", false]);
  d.tr.toReview = move;
  d.setState("working");
  await d.run();
  expect([d.calls, d.marker()]).toEqual([[`ready gh-1 ready to merge: ${URL}`, `review gh-1 back in review, new feedback: ${URL}`], undefined]);
});

test("back to review: feedback whose paste fails still moves it back", async () => {
  const d = setup({ win: true, quiet: 600, authors: ["op"], pane: true, pasteFails: true });
  await d.run();
  d.pr({ comments: [{ id: "c1", author: { login: "op" }, body: "fix it", createdAt: new Date(Date.now() - 5 * 60_000).toISOString() }] });
  await d.run();
  expect([d.calls, d.marker()]).toEqual([[`ready gh-1 ready to merge: ${URL}`, `review gh-1 back in review, new feedback: ${URL}`], undefined]);
});

test("ready to merge: a ticket moved there by hand keeps its head; a session going busy does not move it back", async () => {
  const d = setup({ win: true });
  d.t.readyToMerge = true;
  d.setState("working");
  await d.run();
  expect([d.calls, d.marker()]).toEqual([[], "a"]);
  d.pr({ headRefOid: "c" });
  await d.run();
  expect(d.calls).toEqual([`review gh-1 back in review, new commits: ${URL}`]);
});

test("merged by hand from ready to merge is done as from in review; parked tickets do not move", async () => {
  const d = setup({ autoMerge: "intelligent" });
  d.t.readyToMerge = true;
  d.pr({ state: "MERGED" });
  await d.run();
  expect(d.calls).toEqual(["done gh-1"]);
  const off = setup();
  off.t.readyToMerge = true;
  off.pr({ state: "MERGED" });
  await off.run();
  expect(off.calls).toEqual([]);
  const parked = setup();
  parked.t.labels = ["needs-human"];
  await parked.run();
  parked.t.readyToMerge = true;
  parked.pr({ headRefOid: "z" });
  await parked.run();
  expect(parked.calls).toEqual([]);
});

test("ready to merge: a hand-off parks the ticket, so its killed window never promotes it; a merge still moves it to Done", async () => {
  const d = setup();
  const file = join(root, "acme/web/gh-1.handoff");
  writeFileSync(file, "claude\n");
  await d.run();
  expect(d.calls).toEqual([]);
  expect(d.marker()).toBeUndefined();
  rmSync(file);
  await d.run();
  expect(d.calls).toEqual([`ready gh-1 ready to merge: ${URL}`]);
  const m = setup({ autoMerge: "intelligent" });
  writeFileSync(file, "claude\n");
  m.t.readyToMerge = true;
  m.pr({ state: "MERGED" });
  await m.run();
  expect(m.calls).toEqual(["done gh-1"]);
});

test("github: ready-to-merge label listed with in review, skipped as ready; moves swap the labels", async () => {
  const issues = [
    { number: 7, title: "t", body: "", url: "u", labels: [{ name: "agent" }, { name: "ready-to-merge" }] },
    { number: 8, title: "t", body: "", url: "u", labels: [{ name: "agent" }, { name: "in-review" }] },
  ];
  const { io, cmds } = fakeIo((a) => (a[2] === "list" ? { out: JSON.stringify(issues.filter((i) => ["in-review", "ready-to-merge"].every((l) => !a.includes(l) || i.labels.some((x) => x.name === l)))) } : undefined));
  const tr = github(gh(), "box", io, true, ["acme/web"]);
  expect(await tr.listReady()).toEqual([]);
  expect(cmds.find((c) => c.startsWith("gh issue list"))).toContain('-label:"ready-to-merge"');
  expect((await tr.listInReview()).map((t) => [t.id, t.readyToMerge])).toEqual([["gh-8", undefined], ["gh-7", true]]);
  const t = { ...ticket(8), repo: "acme/web" };
  await tr.toReadyToMerge!(t, "ready to merge: x");
  await tr.toReview({ ...t, readyToMerge: true }, "back in review, new commits: x");
  await tr.toReview(t, "PR: x");
  expect(cmds.filter((c) => /issue (edit|comment)/.test(c))).toEqual([
    "gh issue edit 8 --repo acme/web --add-label ready-to-merge --remove-label in-review",
    "gh issue comment 8 --repo acme/web --body tender: ready to merge: x",
    "gh issue edit 8 --repo acme/web --add-label in-review --remove-label ready-to-merge",
    "gh issue comment 8 --repo acme/web --body tender: back in review, new commits: x",
    "gh issue edit 8 --repo acme/web --add-label in-review --remove-label in-progress",
    "gh issue comment 8 --repo acme/web --body tender: PR: x",
  ]);
  const custom = config({ sources: [src({ readyToMergeLabel: "rtm" })] });
  expect(gh(custom).readyToMergeLabel).toBe("rtm");
});

test("linear: readyToMerge unset keeps tickets in review; set, it is a state listed with in review", async () => {
  const bare = lin(config({ sources: [src({ tracker: "linear", team: "ENG" })] }));
  expect(linear(bare, "box", fakeIo().io).toReadyToMerge).toBeUndefined();
  expect(() => config({ sources: [src({ tracker: "linear", team: "ENG", readyToMerge: "" })] })).toThrow("readyToMerge: non-empty string");
  const l = lin(config({ sources: [src({ tracker: "linear", team: "ENG", readyToMerge: "Ready to merge" })] }));
  const bodies: any[] = [];
  const { io } = fakeIo();
  io.fetch = (async (_url: string, init: any) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    if (b.query.includes("workflowStates")) return Response.json({ data: { workflowStates: { nodes: [{ id: "s-rtm", name: "Ready to merge", team: { id: "team" } }, { id: "s-rev", name: "In Review", team: { id: "team" } }] } } });
    if (b.query.includes("issueUpdate")) return Response.json({ data: { issueUpdate: { success: true } } });
    if (b.query.includes("commentCreate")) return Response.json({ data: { commentCreate: { success: true } } });
    const state = b.variables.f.state.name.eq;
    return Response.json({ data: { issues: { nodes: [{ id: `u-${state}`, identifier: state === "In Review" ? "ENG-1" : "ENG-2", title: "t", url: "u", labels: { nodes: [{ name: "agent" }, { name: "host:box" }] } }] } } });
  }) as any;
  await withLinearKey(async () => {
    const tr = linear(l, "box", io);
    expect((await tr.listInReview()).map((t) => [t.id, t.readyToMerge])).toEqual([["ENG-1", undefined], ["ENG-2", true]]);
    const t: Ticket = { id: "ENG-1", ref: "u-1", title: "t", body: "", url: "u" };
    await tr.toReadyToMerge!(t, "ready to merge: x");
    await tr.toReview(t, "back in review, new feedback: x");
  });
  expect(bodies.filter((b) => b.query.includes("issueUpdate")).map((b) => b.variables.i.stateId)).toEqual(["s-rtm", "s-rev"]);
});

test("maxInReview: host-wide and per repo, counting in review and ready to merge; unset lists nothing before starts", async () => {
  const ready = (n: number, repo = "acme/web") => ({ ...ticket(n, repo) });
  const run = async (over: object, repoOver: object = {}, inReview: Ticket[] = [ticket(1), { ...ticket(2), readyToMerge: true }]) => {
    const c = { ...two(repoOver), ...over };
    let listed = 0;
    const { tr, calls } = fakeTracker({ ready: [ready(3), ready(4, "acme/api")], inReview });
    const counted = { ...tr, listInReview: async () => (listed++, tr.listInReview()) };
    const { io } = fakeIo(noPr);
    await pass(c, io, (s) => (s.name === "gh" ? counted : fakeTracker({}).tr), "/tender");
    return { claims: calls.filter((x) => x.startsWith("claim")), listed, limit: reviewLimit(c) };
  };
  expect(await run({})).toEqual({ claims: ["claim gh-3", "claim gh-4"], listed: 1, limit: undefined });
  expect(await run({ maxInReview: 2 })).toEqual({ claims: [], listed: 2, limit: "maxInReview reached, no new starts: 2/2 on this host" });
  expect(await run({ maxInReview: 3 })).toMatchObject({ claims: ["claim gh-3", "claim gh-4"], limit: undefined });
  const perRepo = await run({}, {}, [ticket(1, "acme/api"), { ...ticket(2, "acme/api"), readyToMerge: true }]);
  expect(perRepo.claims).toEqual(["claim gh-3", "claim gh-4"]);
  const capped = await run({}, { maxInReview: 2 }, [ticket(1, "acme/api"), { ...ticket(2, "acme/api"), readyToMerge: true }]);
  expect(capped).toMatchObject({ claims: ["claim gh-3"], limit: "maxInReview reached, no new starts: 2/2 in acme/api" });
  expect(() => config({ maxInReview: 0 })).toThrow("maxInReview: positive integer");
  expect(() => config({ repos: [{ name: "acme/web", maxInReview: "2" }] })).toThrow("repos[0] (acme/web).maxInReview: positive integer");
  expect(config({ defaults: { sandbox: "nono", maxInReview: 4 } }).repos["acme/web"]!.maxInReview).toBe(4);
});

test("maxInReview: a failed in-review listing starts nothing", async () => {
  const { tr, calls } = fakeTracker({ ready: [ticket(3)] });
  const { io, logs } = fakeIo(noPr);
  await pass(config({ maxInReview: 5 }), io, () => ({ ...tr, listInReview: (complete) => (complete ? Promise.reject(new Error("down")) : tr.listInReview()) }), "/tender");
  expect(calls).toEqual([]);
  expect(logs).toContain("[web] list in-review failed, so no new starts: down");
});

test("maxInReview: a github listing that failed, lost its repo lookup or filled its page is unknown, not short", async () => {
  const page = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ number: i + 1, labels: [{ name: "host:other" }] })));
  const cases: [string, (a: string[]) => { code?: number; out?: string } | undefined][] = [
    ["boom", (a) => (a[2] === "list" ? (a.includes("in-review") ? { code: 1 } : { out: "[]" }) : undefined)],
    ["lookup failed", (a) => (a[1] === "repo" ? { code: 1 } : undefined)],
    ["100 issues listed", (a) => (a[2] === "list" ? { out: page } : undefined)],
  ];
  for (const [err, respond] of cases) {
    canonCache.clear();
    const tr = github(gh(), "box", fakeIo(respond).io, true, ["acme/web"]);
    await expect(tr.listInReview(true)).rejects.toThrow(err);
    expect(await tr.listInReview()).toEqual([]);
  }
});

test("maxInReview: a linear listing that filled its page is unknown, not short", async () => {
  const { io } = fakeIo();
  io.fetch = (async () => Response.json({ data: { issues: { nodes: Array.from({ length: 100 }, (_, i) => ({ id: `u${i}`, identifier: `ENG-${i + 1}`, labels: { nodes: [{ name: "host:other" }] } })) } } })) as any;
  await withLinearKey(async () => {
    const tr = linear(lin(config({ sources: [src({ tracker: "linear", team: "ENG" })] })), "box", io, true);
    await expect(tr.listInReview(true)).rejects.toThrow("100 issues listed");
    expect(await tr.listInReview()).toEqual([]);
  });
});

test("maxInReview: a ticket no repo claims counts toward the host limit; a failed project map is unknown, not short", async () => {
  const { tr, calls } = fakeTracker({ ready: [ticket(3)], inReview: [{ ...ticket(1), repo: undefined }] });
  const { io } = fakeIo(noPr);
  await pass(config({ maxInReview: 1 }), io, () => tr, "/tender");
  expect(calls).toEqual([]);
  const l = lin(config({ sources: [src({ tracker: "linear", team: "ENG" })] }));
  const lio = fakeIo().io;
  lio.fetch = (async () => Response.json({ data: { issues: { nodes: [{ id: "u1", identifier: "ENG-1", title: "t", url: "u", labels: { nodes: [{ name: "agent" }, { name: "host:box" }] }, project: { id: "p1", name: "Web" } }] } } })) as any;
  await withLinearKey(async () => {
    const tr = linear(l, "box", lio, false, [], () => Promise.reject(new Error("map down")));
    await expect(tr.listInReview(true)).rejects.toThrow("map down");
    expect((await tr.listInReview()).map((t) => [t.id, t.repo])).toEqual([["ENG-1", undefined]]);
  });
});
