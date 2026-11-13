import { expect, test } from "bun:test";
import { byPriority, github, labelPriority } from "../src/github";
import { LINEAR_ISSUES, linear, linearTicket } from "../src/linear";
import { pass } from "../src/pass";
import { config, fakeIo, phase, src, ticket, useTempRoot, web, windowsOut, withLinearKey, writePhases } from "./helpers";

useTempRoot();

test("github adapter: ready requires host label, skips claimed, edits labels", async () => {
  const l = config().sources[0]!;
  const issues = [
    { number: 7, title: "t", body: null, url: "u", labels: [{ name: "agent" }, { name: "priority:High" }] },
    { number: 8, title: "t", body: "", url: "u", labels: [{ name: "agent" }, { name: "in-progress" }] },
    { number: 9, title: "t", body: "", url: "u", labels: [{ name: "agent" }, { name: "in-review" }] },
    { number: 10, title: "t", body: "", url: "u", labels: [{ name: "agent" }, { name: "Needs-Human" }] },
  ];
  const { io, cmds } = fakeIo((a) => (a[2] === "list" ? { out: JSON.stringify(issues) } : a[1] === "issue" && a[2] === "view" ? { out: '{"state":"CLOSED"}' } : undefined));
  const tr = github(l, "box", io, false, ["acme/web"]);
  expect((await tr.listReady()).map((t) => [t.id, t.priority])).toEqual([["gh-7", 2]]);
  expect(cmds[0]).toBe("gh repo view acme/web --json nameWithOwner");
  expect(cmds[1]).toContain("--label agent --label host:box");
  expect(cmds[1]).toContain('-label:"needs-human"');
  await tr.claim((await tr.listReady())[0]!);
  expect(cmds).toContain("gh issue edit 7 --repo acme/web --add-label in-progress");
  expect(cmds).toContain("gh issue comment 7 --repo acme/web --body aw: picked up on box");
  await tr.park({ ...ticket(7), repo: "acme/web" });
  expect(cmds.at(-1)).toBe("gh issue edit 7 --repo acme/web --add-label needs-human");
  const { io: io2, cmds: cmds2 } = fakeIo(() => ({ out: JSON.stringify({ labels: [{ name: "NEEDS-HUMAN" }] }) }));
  expect(await github(l, "box", io2, false, ["acme/web"]).parked({ ...ticket(7), repo: "acme/web" })).toBe(true);
  expect(cmds2).toEqual(["gh issue view 7 --repo acme/web --json labels"]);
  expect(await tr.closed("gh-7", "acme/web")).toBe("done");
  expect(cmds).toContain("gh issue view 7 --repo acme/web --json state,stateReason");
  await expect(tr.closed("ENG-1", "acme/web")).rejects.toThrow();
});

test("github adapter: closed as not planned or duplicate is canceled, as completed is done, open is neither", async () => {
  const l = config().sources[0]!;
  for (const [state, stateReason, want] of [["CLOSED", "NOT_PLANNED", "canceled"], ["CLOSED", "DUPLICATE", "canceled"], ["CLOSED", "COMPLETED", "done"], ["CLOSED", "", "done"], ["OPEN", "REOPENED", undefined]]) {
    const { io } = fakeIo(() => ({ out: JSON.stringify({ state, stateReason }) }));
    expect(await github(l, "box", io, false, ["acme/web"]).closed("gh-7", "acme/web")).toBe(want as any);
  }
});

test("github adapter: polls every repo of the source and tags tickets with it", async () => {
  const c = config({ repos: [{ name: "acme/web", path: "/a" }, { name: "acme/api", path: "/b" }] });
  const { io, cmds } = fakeIo((a) => (a[2] === "list" ? { out: JSON.stringify([{ number: 12, title: "t", body: "", url: "u", labels: [] }]) } : undefined));
  const tickets = await github(c.sources[0]!, "box", io, false, Object.keys(c.repos)).listInProgress();
  expect(tickets.map((t) => `${t.repo}#${t.id}`)).toEqual(["acme/web#gh-12", "acme/api#gh-12"]);
  expect(cmds.filter((x) => x.startsWith("gh issue list")).map((x) => x.split(" ")[4])).toEqual(["acme/web", "acme/api"]);
  await github(c.sources[0]!, "box", io, false, []).comment(tickets[1]!, "hi");
  expect(cmds.at(-1)).toBe("gh issue comment 12 --repo acme/api --body aw: hi");
});

test("github adapter: defaultHost takes unlabelled tickets, not other hosts'", async () => {
  const l = config().sources[0]!;
  const lbl = (...n: string[]) => n.map((name) => ({ name }));
  const issues = [
    { number: 1, title: "t", body: "", url: "u", labels: lbl("agent") },
    { number: 2, title: "t", body: "", url: "u", labels: lbl("agent", "host:BOX") },
    { number: 3, title: "t", body: "", url: "u", labels: lbl("agent", "host:vm") },
  ];
  const { io, cmds } = fakeIo((a) => (a[2] === "list" ? { out: JSON.stringify(issues) } : undefined));
  expect((await github(l, "box", io, true, ["acme/web"]).listReady()).map((t) => t.id)).toEqual(["gh-1", "gh-2"]);
  expect(cmds[1]).not.toContain("host:");
  expect(cmds[1]).toContain('--search -label:"in-progress" -label:"in-review"');
});

test("github adapter: in-progress list needs the agent label (defaultHost)", async () => {
  const l = config().sources[0]!;
  const { io, cmds } = fakeIo((a) => (a[2] === "list" ? { out: "[]" } : undefined));
  await github(l, "box", io, true, ["acme/web"]).listInProgress();
  expect(cmds[1]).toContain("--label agent --label in-progress");
});

test("github adapter: phases become sub-issues that are never picked up as work", async () => {
  const c = config({ defaultHost: true });
  const issues: { number: number; title: string; body: string; url: string; labels: string[]; open: boolean; parent?: string }[] = [{ number: 1, title: "t", body: "", url: "u", labels: ["agent", "in-progress"], open: true }];
  let prs = "[]";
  const { io, cmds } = fakeIo((a) => {
    if (a[1] === "list-windows") return windowsOut(["acme/web/gh-1"]);
    if (a[1] === "pr") return { out: prs };
    if (a[1] === "api") return { out: JSON.stringify(issues.filter((x) => a[2] === `repos/acme/web/issues/${x.parent}/sub_issues?per_page=100`)) };
    const i = issues.find((x) => String(x.number) === a[3]);
    if (a[2] === "create") {
      issues.push({ number: issues.length + 1, title: a[a.indexOf("--title") + 1]!, body: "", url: "u", labels: [], open: true, parent: a[a.indexOf("--parent") + 1] });
      return { out: `https://github.com/acme/web/issues/${issues.length}\n` };
    }
    if (a[2] === "edit") {
      i!.labels.push(a[a.indexOf("--add-label") + 1]!);
      i!.labels = i!.labels.filter((x) => !a.includes("--remove-label") || x !== a[a.indexOf("--remove-label") + 1]);
    }
    if (a[2] === "close") i!.open = false;
    if (a[2] === "list") {
      const want = a.flatMap((x, k) => (a[k - 1] === "--label" ? [x] : []));
      return { out: JSON.stringify(issues.filter((x) => x.open && want.every((w) => x.labels.includes(w))).map((x) => ({ ...x, labels: x.labels.map((name) => ({ name })) }))) };
    }
  });
  writePhases("gh-1", [phase("a", "in-progress"), phase("b", "done")]);
  await pass(c, io, github, "/aw");
  expect(cmds).toContain("gh issue create --repo acme/web --parent 1 --title gh-1: Do a --body b");
  expect(cmds).toContain("gh issue edit 2 --repo acme/web --add-label in-progress");
  expect(cmds).toContain("gh issue edit 3 --repo acme/web --add-label in-progress");
  expect(issues[1]!.labels).toEqual(["in-progress"]);
  const before = cmds.length;
  await pass(c, io, github, "/aw");
  const second = cmds.slice(before);
  expect(second.filter((x) => /issue (create|edit|close|comment)|new-window/.test(x))).toEqual([]);
  const tr = github(c.sources[0]!, "box", io, true, ["acme/web"]);
  expect((await tr.listInProgress()).map((t) => t.id)).toEqual(["gh-1"]);
  expect(await tr.listReady()).toEqual([]);
  prs = '[{"url":"https://pr/1","state":"OPEN"}]';
  const at = cmds.length;
  await pass(c, io, github, "/aw");
  expect(cmds.slice(at).filter((x) => /issue (create|edit|close)/.test(x))).toEqual(["gh issue close 3 --repo acme/web", "gh issue edit 1 --repo acme/web --add-label in-review --remove-label in-progress"]);
  expect((await tr.listInReview()).map((t) => t.id)).toEqual(["gh-1"]);
});

test("priority: Linear field and GitHub priority:* labels map to one rank", () => {
  expect(LINEAR_ISSUES).toContain(" priority ");
  expect([0, 1, 2, 3, 4, undefined, null, 9].map((priority) => linearTicket({ identifier: "ENG-1", priority }).priority)).toEqual([undefined, 1, 2, 3, 4, undefined, undefined, undefined]);
  expect(labelPriority(["bug", "Priority:HIGH"])).toBe(2);
  expect(labelPriority(["priority:low", "priority:urgent"])).toBe(1);
  expect(labelPriority(["priority:medium"])).toBe(3);
  for (const l of [[], ["priority:p0"], ["p1"], ["prio:high"], ["priority: high"], ["priority:highest"]]) expect(labelPriority(l)).toBeUndefined();
});

test("priority: sort is stable with no priority last", () => {
  const t = (n: number, priority?: number) => ({ ...ticket(n), priority });
  expect([t(1), t(2, 4), t(3, 1), t(4), t(5, 4), t(6, 1)].sort(byPriority).map((x) => x.id)).toEqual(["gh-3", "gh-6", "gh-2", "gh-5", "gh-1", "gh-4"]);
});

test("trackers: done closes the GitHub issue, moves the Linear ticket to the first done state", async () => {
  const s = config().sources[0]!;
  const g = fakeIo();
  await github(s, "box", g.io, false, ["acme/web"]).done(ticket(3));
  expect(g.cmds).toEqual(["gh issue close 3 --repo acme/web"]);
  const bodies: any[] = [];
  const f = (async (_u: string, init: any) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    return Response.json({ data: b.query.includes("workflowStates") ? { workflowStates: { nodes: [{ id: "s-done", name: "Done", team: { id: "t" } }] } } : { issueUpdate: { success: true } } });
  }) as any;
  const l = config({ sources: [src({ tracker: "linear", team: "ENG" })] }).sources[0]!;
  await withLinearKey(() => linear(l, "box", { ...fakeIo().io, fetch: f }).done({ ...ticket(1), ref: "uuid-1" }));
  expect(bodies.at(-1).variables).toEqual({ id: "uuid-1", s: "s-done" });
});

test("github adapter: comments parsed from gh issue view, author is the login", async () => {
  const out = { comments: [{ id: "IC_1", body: "aw: picked up", createdAt: "2026-01-01T10:00:00Z", author: { login: "op" } }, { id: "IC_2", body: "yes", createdAt: "2026-01-01T11:00:00Z", author: null }] };
  const { io, cmds } = fakeIo((a) => (a[2] === "view" ? { out: JSON.stringify(out) } : undefined));
  expect(await github(config().sources[0]!, "box", io, false, []).comments(ticket(7), 0)).toEqual([
    { id: "IC_1", body: "aw: picked up", createdAt: "2026-01-01T10:00:00Z", author: "op" },
    { id: "IC_2", body: "yes", createdAt: "2026-01-01T11:00:00Z", author: undefined },
  ]);
  expect(cmds).toEqual(["gh issue view 7 --repo acme/web --json comments"]);
});
