import { expect, test } from "bun:test";
import { allowedRepo } from "../src/config";
import { LINEAR_ISSUES, linear, linearRepo, linearTicket } from "../src/linear";
import { pass } from "../src/pass";
import { config, fakeIo, phase, src, two, useTempRoot, windowsOut, withLinearKey, writePhases } from "./helpers";

useTempRoot();

test("linear adapter: defaultHost takes unlabelled tickets, not other hosts'", async () => {
  const l = config({ sources: [src({ tracker: "linear", team: "ENG" })] }).sources[0]!;
  const node = (identifier: string, ...labels: string[]) => ({ id: identifier, identifier, title: "t", description: null, url: "u", labels: { nodes: labels.map((name) => ({ name })) } });
  const bodies: any[] = [];
  const { io } = fakeIo();
  io.fetch = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ data: { issues: { nodes: [node("ENG-1", "agent"), node("ENG-2", "agent", "host:box"), node("ENG-3", "agent", "host:other")] } } });
  }) as any;
  const prev = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_KEY = "k";
  try {
    expect((await linear(l, "box", io, true).listReady()).map((t) => t.id)).toEqual(["ENG-1", "ENG-2"]);
  } finally {
    if (prev === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = prev;
  }
  expect(bodies[0].query).toContain("labels { nodes { name parent { name } } }");
  expect(bodies[0].query).toContain("project { description content labels");
  expect(JSON.stringify(bodies[0].variables)).not.toContain("host:");
});

test("linear adapter: phases become child issues that are never picked up as work", async () => {
  const c = config({ defaultHost: true, sources: [src({ tracker: "linear", team: "ENG" })] });
  const states = [
    { id: "s-todo", name: "Todo" },
    { id: "s-prog", name: "In Progress" },
    { id: "s-done", name: "Done" },
  ].map((s) => ({ ...s, team: { id: "team-1" } }));
  const issues: any[] = [{ id: "u-1", identifier: "ENG-1", title: "t", description: "", url: "u", state: "In Progress", labels: ["agent", "repo:acme/web"] }];
  const mutations: any[] = [];
  let prs = "[]";
  const { io } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/ENG-1"]) : a[1] === "pr" ? { out: prs } : undefined));
  io.fetch = (async (_url: string, init: any) => {
    const { query, variables } = JSON.parse(init.body);
    if (query.includes("workflowStates")) return Response.json({ data: { workflowStates: { nodes: states } } });
    if (query.includes("children")) return Response.json({ data: { issue: { children: { nodes: issues.filter((i) => i.parentId === variables.id) } } } });
    if (query.includes("issueCreate")) {
      mutations.push(variables.i);
      const n = issues.length + 1;
      issues.push({ id: `u-${n}`, identifier: `ENG-${n}`, title: variables.i.title, description: "", url: "u", state: "Todo", labels: [], parentId: variables.i.parentId });
      return Response.json({ data: { issueCreate: { issue: { id: `u-${n}` } } } });
    }
    if (query.includes("issueUpdate")) {
      mutations.push(variables);
      issues.find((i) => i.id === variables.id).state = states.find((s) => s.id === variables.s)!.name;
      return Response.json({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes("issues(")) {
      const f = variables.f;
      const want = f.and.map((x: any) => x.labels.some.name.eq);
      const nodes = issues.filter((i) => i.state === f.state.name.eq && want.every((w: string) => i.labels.includes(w)));
      return Response.json({ data: { issues: { nodes: nodes.map((i) => ({ ...i, labels: { nodes: i.labels.map((name: string) => ({ name })) } })) } } });
    }
    return Response.json({ data: {} });
  }) as any;
  writePhases("ENG-1", [phase("a", "in-progress"), phase("b", "done"), phase("c", "todo")]);
  await withLinearKey(async () => {
    await pass(c, io, linear, "/aw");
    await pass(c, io, linear, "/aw");
    const tr = linear(c.sources[0]!, "box", io, true);
    expect((await tr.listReady()).map((t) => t.id)).toEqual([]);
    expect((await tr.listInProgress()).map((t) => t.id)).toEqual(["ENG-1"]);
    prs = '[{"url":"https://pr/1","state":"OPEN"}]';
    await pass(c, io, linear, "/aw");
  });
  expect(mutations).toEqual([
    { teamId: "team-1", parentId: "u-1", stateId: "s-todo", title: "ENG-1: Do a", description: "b" },
    { id: "u-2", s: "s-prog" },
    { teamId: "team-1", parentId: "u-1", stateId: "s-todo", title: "ENG-1: Do b", description: "b" },
    { id: "u-3", s: "s-prog" },
    { teamId: "team-1", parentId: "u-1", stateId: "s-todo", title: "ENG-1: Do c", description: "b" },
    { id: "u-3", s: "s-done" },
  ]);
});

test("linear repo resolution: label > description > project summary > project overview", () => {
  const texts = (d?: string, ps?: string, pc?: string) => [d, ps, pc];
  expect(linearRepo(["agent", "Repo:acme/web"], texts("repo: acme/api"))).toBe("acme/web");
  expect(linearRepo(["agent"], texts("intro\r\nrepo:  acme/api \r\nmore", "repo: acme/web"))).toBe("acme/api");
  expect(linearRepo([], texts("see the repo: acme/api", "repo: acme/web"))).toBe("acme/web");
  expect(linearRepo([], texts(undefined, "summary", "# Overview\nrepo: acme/api"))).toBe("acme/api");
  expect(linearRepo([], texts(null as any, ""))).toBeUndefined();
  expect(linearRepo([], texts())).toBeUndefined();
  const c = two();
  for (const bad of ["../x", "acme/..", "a/b;rm -rf", "a/b/c", "a//b", "/a/b", "-x/y", "a/b\nc", "a b/c", ""])
    expect(allowedRepo(c, linearRepo([], [`repo: ${bad}`]))).toBeUndefined();
  expect(linearRepo([], ["repo: a/b;rm -rf\nrepo: acme/web"])).toBe("a/b;rm -rf");
  expect(allowedRepo(c, "ACME/Web")).toBe("acme/web");
});

test("linear adapter: tickets carry the resolved repo from labels, description and project", async () => {
  const l = two().sources[1]!;
  const node = (identifier: string, labels: string[], description: string | null, project: object | null) => ({ id: identifier, identifier, title: "t", description, url: "u", labels: { nodes: labels.map((name) => ({ name })) }, project });
  const { io } = fakeIo();
  io.fetch = (async () =>
    Response.json({
      data: {
        issues: {
          nodes: [
            node("ENG-1", ["agent", "repo:acme/api"], "repo: acme/web", null),
            node("ENG-2", ["agent"], "x\nrepo: acme/api", { description: "repo: acme/web", content: null }),
            node("ENG-3", ["agent"], null, { description: "", content: "repo: ACME/API" }),
            node("ENG-4", ["agent"], null, null),
          ],
        },
      },
    })) as any;
  const got = await withLinearKey(() => linear(l, "box", io, true).listReady());
  expect(got.map((t) => t.repo)).toEqual(["acme/api", "acme/api", "ACME/API", undefined]);
});

test("linear repo: project label and label groups", () => {
  expect(linearRepo([], [undefined, "repo: acme/api"], ["repo:acme/web"])).toBe("acme/web");
  expect(linearRepo([], ["repo: acme/api"], ["repo:acme/web"])).toBe("acme/api");
  expect(linearRepo(["repo:acme/api"], [], ["repo:acme/web"])).toBe("acme/api");
  expect(linearRepo([], [], ["bug"])).toBeUndefined();
  const node = (labels: object[], projectLabels: object[]) => ({ id: "u", identifier: "PER-1", title: "t", description: null, url: "u", labels: { nodes: labels }, project: { description: "", content: null, labels: { nodes: projectLabels } } });
  const t = linearTicket(node([{ name: "agent", parent: null }], [{ name: "acme/web", parent: { name: "repo" } }]));
  expect(t.repo).toBe("acme/web");
  expect(t.labels).toEqual(["agent"]);
  expect(linearTicket(node([{ name: "acme/api", parent: { name: "repo" } }], [{ name: "acme/web", parent: { name: "repo" } }])).repo).toBe("acme/api");
  expect(linearTicket(node([], [{ name: "acme/web", parent: { name: "other" } }])).repo).toBeUndefined();
  expect(LINEAR_ISSUES).toContain("project { description content labels { nodes { name parent { name } } } }");
});

test("linear adapter: every comment starts with aw:", async () => {
  const l = config({ sources: [src({ tracker: "linear", team: "ENG" })] }).sources[0]!;
  const bodies: any[] = [];
  const { io } = fakeIo();
  io.fetch = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ data: { commentCreate: { success: true } } });
  }) as any;
  await withLinearKey(() => linear(l, "box", io, false).comment({ id: "ENG-1", ref: "u-1", title: "", body: "", url: "" }, "hi"));
  expect(bodies[0].variables.i).toEqual({ issueId: "u-1", body: "aw: hi" });
});

test("linear adapter: comments parsed, author is the user email, none for a null user", async () => {
  const l = config({ sources: [src({ tracker: "linear", team: "ENG" })] }).sources[0]!;
  const bodies: any[] = [];
  const { io } = fakeIo();
  io.fetch = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ data: { issue: { comments: { nodes: [{ id: "c1", body: "ok", createdAt: "2026-01-01T10:00:00Z", user: { email: "a@b.c" } }, { id: "c2", body: "bot", createdAt: "2026-01-01T11:00:00Z", user: null }] } } } });
  }) as any;
  const cs = await withLinearKey(() => linear(l, "box", io, false).comments({ id: "ENG-1", ref: "u-1", title: "", body: "", url: "" }, Date.parse("2026-01-01T09:00:00Z")));
  expect(cs).toEqual([
    { id: "c1", body: "ok", createdAt: "2026-01-01T10:00:00Z", author: "a@b.c" },
    { id: "c2", body: "bot", createdAt: "2026-01-01T11:00:00Z", author: undefined },
  ]);
  expect(bodies[0].variables).toEqual({ id: "u-1", since: "2026-01-01T09:00:00.000Z", after: null });
  expect(bodies[0].query).toContain("comments(filter: { createdAt: { gt: $since } }, first: 100, after: $after) { nodes { id body createdAt user { email } } pageInfo { hasNextPage endCursor } }");
});

test("linear adapter: comments are read across pages, so a marker past comment 100 is seen; past 20 pages it throws", async () => {
  const l = config({ sources: [src({ tracker: "linear", team: "ENG" })] }).sources[0]!;
  const t = { id: "ENG-1", ref: "u-1", title: "", body: "", url: "" };
  const afters: unknown[] = [];
  const { io } = fakeIo();
  let pages = 2;
  io.fetch = (async (_url: string, init: any) => {
    const { after } = JSON.parse(init.body).variables;
    afters.push(after);
    const n = afters.length;
    const nodes = Array.from({ length: n < pages ? 100 : 1 }, (_, i) => ({ id: `c${n}-${i}`, body: n === 2 ? "aw: x\n\naw-findings aaaaaaaaaaaa" : "hi", createdAt: "", user: null }));
    return Response.json({ data: { issue: { comments: { nodes, pageInfo: { hasNextPage: n < pages, endCursor: `p${n}` } } } } });
  }) as any;
  const cs = await withLinearKey(() => linear(l, "box", io, false).comments(t, 0));
  expect(cs).toHaveLength(101);
  expect(cs.at(-1)!.body).toContain("aw-findings aaaaaaaaaaaa");
  expect(afters).toEqual([null, "p1"]);
  afters.length = 0;
  pages = 99;
  await expect(withLinearKey(() => linear(l, "box", io, false).comments(t, 0))).rejects.toThrow("more than 2000");
  expect(afters).toHaveLength(20);
});

test("linear adapter: park adds an ungrouped team or workspace label, fails clearly otherwise; parked reads fresh labels", async () => {
  const l = config({ sources: [src({ tracker: "linear", team: "ENG" })] }).sources[0]!;
  let labels: any[] = [{ id: "l-eng", parent: null }];
  let success = true;
  const bodies: any[] = [];
  const { io } = fakeIo();
  io.fetch = (async (_url: string, init: any) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    if (b.query.includes("issueLabels")) return Response.json({ data: { issueLabels: { nodes: labels } } });
    if (b.query.includes("issueAddLabel")) return Response.json({ data: { issueAddLabel: { success } } });
    if (b.query.includes("issue(id")) return Response.json({ data: { issue: { labels: { nodes: [{ name: "Needs-Human" }] } } } });
    const node = (identifier: string, ...ls: string[]) => ({ id: identifier, identifier, title: "t", description: null, url: "u", labels: { nodes: ls.map((name) => ({ name })) } });
    return Response.json({ data: { issues: { nodes: [node("ENG-1", "agent", "host:box"), node("ENG-2", "agent", "host:box", "NEEDS-HUMAN")] } } });
  }) as any;
  const t = { id: "ENG-1", ref: "u-1", title: "t", body: "", url: "u" };
  await withLinearKey(async () => {
    const tr = linear(l, "box", io);
    expect((await tr.listReady()).map((x) => x.id)).toEqual(["ENG-1"]);
    await tr.park(t);
    expect(bodies.at(-2).query).toContain("or: [{ team: { key: { eq: $t } } }, { team: { null: true } }]");
    expect(bodies.at(-2).variables).toEqual({ n: "needs-human", t: "ENG" });
    expect(bodies.at(-1).variables).toEqual({ id: "u-1", l: "l-eng" });
    labels = [];
    await expect(tr.park(t)).rejects.toThrow('linear label "needs-human" not found in team ENG or the workspace');
    labels = [{ id: "g", parent: { name: "triage" } }];
    await expect(tr.park(t)).rejects.toThrow('linear label "needs-human" is inside a label group; use an ungrouped label');
    labels = [{ id: "l-eng", parent: null }];
    success = false;
    await expect(tr.park(t)).rejects.toThrow("linear issueAddLabel: not successful for ENG-1");
    expect(await tr.parked(t)).toBe(true);
  });
});
