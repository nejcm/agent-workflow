import { expect, test } from "bun:test";
import { allowedRepo } from "../src/config";
import { LINEAR_ISSUES, linear, linearRepo, linearTicket, type ProjectClaim, projectRepo } from "../src/trackers/linear";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeTracker, pass } from "../src/pass";
import { config, fakeIo, lin, noPr, phase, root, setBaseSha, src, two, useTempRoot, windowsOut, withLinearKey, writePhases } from "./helpers";

useTempRoot();

test("linear adapter: defaultHost takes unlabelled tickets, not other hosts'", async () => {
  const l = lin(config({ sources: [src({ tracker: "linear", team: "ENG" })] }));
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
  expect(bodies[0].query).toContain("project { id name }");
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
      issues.find((i) => i.id === variables.id).state = states.find((s) => s.id === variables.i.stateId)!.name;
      return Response.json({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes("issues(")) {
      const f = variables.f;
      const want = f.and.map((x: any) => x.labels.some.name.eq);
      const nodes = issues.filter((i) => i.state === f.state.name.eq && want.every((w: string) => i.labels.includes(w)));
      return Response.json({ data: { issues: { nodes: nodes.map((i) => ({ ...i, labels: { nodes: i.labels.map((name: string) => ({ name })) } })) } } });
    }
    return Response.json({ data: { viewer: { id: "me" } } });
  }) as any;
  writePhases("ENG-1", [phase("a", "in-progress"), phase("b", "done"), phase("c", "todo")]);
  await withLinearKey(async () => {
    await pass(c, io, makeTracker, "/tender");
    await pass(c, io, makeTracker, "/tender");
    const tr = linear(lin(c), "box", io, true);
    expect((await tr.listReady()).map((t) => t.id)).toEqual([]);
    expect((await tr.listInProgress()).map((t) => t.id)).toEqual(["ENG-1"]);
    prs = '[{"url":"https://pr/1","state":"OPEN"}]';
    await pass(c, io, makeTracker, "/tender");
  });
  expect(mutations).toEqual([
    { teamId: "team-1", parentId: "u-1", stateId: "s-todo", title: "ENG-1: Do a", description: "b" },
    { id: "u-2", i: { stateId: "s-prog" } },
    { teamId: "team-1", parentId: "u-1", stateId: "s-todo", title: "ENG-1: Do b", description: "b" },
    { id: "u-3", i: { stateId: "s-prog" } },
    { teamId: "team-1", parentId: "u-1", stateId: "s-todo", title: "ENG-1: Do c", description: "b" },
    { id: "u-3", i: { stateId: "s-done" } },
  ]);
});

test("linear repo resolution: label, then the first repo: line of the description", () => {
  expect(linearRepo(["agent", "Repo:acme/web"], "repo: acme/api")).toBe("acme/web");
  expect(linearRepo(["agent"], "intro\r\nrepo:  acme/api \r\nmore")).toBe("acme/api");
  expect(linearRepo([], "see the repo: acme/api")).toBeUndefined();
  expect(linearRepo([], null)).toBeUndefined();
  expect(linearRepo([])).toBeUndefined();
  const c = two();
  for (const bad of ["../x", "acme/..", "a/b;rm -rf", "a/b/c", "a//b", "/a/b", "-x/y", "a/b\nc", "a b/c", ""])
    expect(allowedRepo(c, linearRepo([], `repo: ${bad}`))).toBeUndefined();
  expect(linearRepo([], "repo: a/b;rm -rf\nrepo: acme/web")).toBe("a/b;rm -rf");
  expect(allowedRepo(c, "ACME/Web")).toBe("acme/web");
});

const issue = (identifier: string, labels: object[], description: string | null, project: object | null) => ({ id: identifier, identifier, title: "t", description, url: "u", labels: { nodes: labels }, project });
const named = (...names: string[]) => names.map((name) => ({ name }));

async function listed(nodes: object[], claims: ProjectClaim[], team = "ENG") {
  const { io, logs } = fakeIo();
  io.fetch = (async () => Response.json({ data: { issues: { nodes } } })) as any;
  const asked: number[] = [];
  const l = lin(config({ sources: [src({ tracker: "linear", team })] }));
  const got = await withLinearKey(() => linear(l, "box", io, true, [], async () => (asked.push(1), claims)).listReady());
  return { repos: got.map((t) => t.repo), logs, asked: asked.length };
}

test("linear routing: ticket label > description line > the repo claiming its project > none", async () => {
  const web = { id: "p-web", name: "Web app" };
  const claims = [{ repo: "acme/web", project: "web app" }, { repo: "acme/api", project: "API" }];
  const r = await listed(
    [
      issue("ENG-1", named("agent", "repo:acme/api"), "repo: acme/docs", web),
      issue("ENG-2", named("agent"), "x\nrepo: acme/api", web),
      issue("ENG-3", named("agent"), null, web),
      issue("ENG-4", [{ name: "acme/api", parent: { name: "repo" } }], null, web),
      issue("ENG-5", named("agent"), "no repo here", null),
    ],
    claims,
  );
  expect(r.repos).toEqual(["acme/api", "acme/api", "acme/web", "acme/api", undefined]);
  expect((await listed([issue("ENG-1", named("agent"), "repo: acme/api", web)], claims)).asked).toBe(0);
});

test("linear routing: a project no repo claims routes nowhere, its own text ignored; team is only checked", async () => {
  const other = { id: "p-other", name: "Other", description: "repo: acme/web", content: "repo: acme/web", labels: { nodes: named("repo:acme/web") } };
  expect((await listed([issue("ENG-1", named("agent"), null, other)], [{ repo: "acme/web", project: "Web app" }])).repos).toEqual([undefined]);
  const ops = await listed([issue("ENG-2", named("agent"), null, { id: "p-ops", name: "Ops" }), issue("ENG-3", named("agent"), null, { id: "p-ops", name: "Ops" })], [{ repo: "acme/api", project: "Ops", team: "OPS" }]);
  expect(ops.repos).toEqual(["acme/api", "acme/api"]);
  expect(ops.logs).toEqual(['linear project "Ops" is claimed by acme/api for team OPS, but routes a ENG ticket']);
  const both = await listed([issue("ENG-4", named("agent"), null, { id: "p-both", name: "Both" })], [{ repo: "acme/web", project: "Both", team: "ENG" }, { repo: "acme/api", project: "Both", team: "OPS" }]);
  expect(both.repos).toEqual([undefined]);
});

test("linear routing: a project two repos claim needs an explicit repo, logged once", async () => {
  const shared = { id: "p-shared", name: "Shared" };
  const claims = [{ repo: "acme/web", project: "Shared" }, { repo: "acme/api", project: "shared" }];
  const r = await listed([issue("ENG-1", named("agent"), null, shared), issue("ENG-2", named("agent"), null, shared), issue("ENG-3", named("agent", "repo:acme/api"), null, shared)], claims);
  expect(r.repos).toEqual([undefined, undefined, "acme/api"]);
  expect(r.logs).toEqual(['linear project "Shared" is claimed by acme/web, acme/api; its tickets need a repo: label or description line']);
  expect((await listed([issue("ENG-1", named("agent"), null, shared)], claims)).logs).toEqual([]);
});

test("linear routing: a renamed project keeps the repo it resolved to while that repo still claims it; a competing claim is ambiguous", async () => {
  const p = (name: string) => ({ id: "p-store", name });
  const quiet = () => {};
  expect(projectRepo([{ repo: "acme/web", project: "Storefront" }], "ENG", p("STOREFRONT"), quiet)).toBe("acme/web");
  expect(projectRepo([{ repo: "acme/web", project: "Storefront" }], "ENG", p("Shop v2"), quiet)).toBe("acme/web");
  expect(projectRepo([{ repo: "acme/web", project: "Storefront" }], "ENG", { id: "p-never-seen", name: "Shop v2" }, quiet)).toBeUndefined();
  expect(projectRepo([{ repo: "acme/web", project: "Shop v2" }, { repo: "acme/api", project: "Storefront" }], "ENG", p("Shop v2"), quiet)).toBe("acme/web");
  expect(projectRepo([{ repo: "acme/web", project: "Shop v2" }, { repo: "acme/api", project: "Storefront" }], "ENG", p("Shop v2"), quiet)).toBe("acme/web");
  const logs: string[] = [];
  expect(projectRepo([{ repo: "acme/web", project: "Shop v2" }, { repo: "acme/api", project: "Shop v3" }], "ENG", p("Shop v3"), (m) => logs.push(m))).toBeUndefined();
  expect(logs).toEqual(['linear project "Shop v3" is claimed by acme/web, acme/api; its tickets need a repo: label or description line']);
  const q = (name: string) => ({ id: "p-case", name });
  expect(projectRepo([{ repo: "acme/web", project: "Storefront" }], "ENG", q("Storefront"), quiet)).toBe("acme/web");
  expect(projectRepo([{ repo: "acme/web", project: "storefront" }], "ENG", q("Shop"), quiet)).toBe("acme/web");
  expect(projectRepo([{ repo: "acme/web", project: "STOREFRONT" }, { repo: "acme/api", project: "Shop" }], "ENG", q("Shop"), quiet)).toBeUndefined();
  expect(LINEAR_ISSUES).toContain("project { id name }");
});

test("pass: the project map comes from every allowlisted repo's .tender/ on its base branch; allowlist and redirect checks still apply", async () => {
  const c = config({ maxConcurrent: 4, repos: [{ name: "acme/web", path: join(root, "src-web") }, { name: "acme/api", path: join(root, "src-api") }, { name: "acme/old", path: join(root, "src-old") }], sources: [src({ name: "lin", tracker: "linear", team: "ENG" })] });
  const yaml: Record<string, string> = { [join(root, "src-web")]: "tracker:\n  linear:\n    project: Web app\n", [join(root, "src-api")]: "tracker:\n  linear:\n    project: API\n    team: ENG\n" };
  const ready = [issue("ENG-1", named("agent"), null, { id: "p-web2", name: "web APP" }), issue("ENG-2", named("agent"), null, { id: "p-api", name: "API" }), issue("ENG-3", named("agent"), null, { id: "p-none", name: "Nobody" })];
  mkdirSync(join(root, "src-api"));
  const comments: string[] = [];
  const { io, cmds } = fakeIo((a) => {
    const y = a[0] === "git" ? yaml[a[2]!] : undefined;
    if (y !== undefined && a[3] === "ls-tree") return { out: a[4] === "-r" ? `100644 blob ${"1".repeat(40)} ${y.length}\t.tender/config.yaml\0` : `040000 tree ${"2".repeat(40)}\t.tender\0` };
    if (y !== undefined && a[3] === "cat-file") return { out: y };
    if (a[2] === "view" && a[3] === "acme/api") return { out: '{"nameWithOwner":"evil/api","defaultBranchRef":{"name":"main"}}' };
    if (a[2] === "view" && a[3] === "acme/old") return { out: '{"nameWithOwner":"acme/new","defaultBranchRef":{"name":"main"}}' };
    if (a[1] === "list-windows") return windowsOut([]);
    return a[5] === "--quiet" ? { code: 1 } : noPr(a);
  });
  io.fetch = (async (_url: string, init: any) => {
    const { query, variables } = JSON.parse(init.body);
    if (query.includes("issues(")) return Response.json({ data: { issues: { nodes: variables.f.state.name.eq === "Todo" ? ready : [] } } });
    if (query.includes("commentCreate")) return comments.push(`${variables.i.issueId} ${variables.i.body}`), Response.json({ data: { commentCreate: { success: true } } });
    if (query.includes("workflowStates")) return Response.json({ data: { workflowStates: { nodes: [{ id: "s", name: "In Progress", team: { id: "t" } }] } } });
    return Response.json({ data: { issueUpdate: { success: true }, viewer: { id: "me" } } });
  }) as any;
  await withLinearKey(() => pass(c, io, makeTracker, "/tender"));
  expect(cmds.filter((x) => x.includes(" new-window ")).map((x) => x.split(" ").at(-2))).toEqual(["acme/web/ENG-1"]);
  expect(cmds.filter((x) => x.startsWith("gh repo clone ")).map((x) => x.split(" ")[3])).toEqual(["acme/web"]);
  expect(comments).toEqual([
    "ENG-1 tender: picked up on box",
    "ENG-2 tender: repo acme/api now resolves to evil/api on GitHub, which is not in the tender allowlist",
    "ENG-3 tender: no repo set on this ticket: add a `repo:owner/name` label or a `repo: owner/name` line to its description, or have exactly one repo claim its Linear project in .tender/config.yaml",
  ]);
  expect(cmds.filter((x) => / fetch origin main$/.test(x)).map((x) => x.split(" ")[2]).sort()).toEqual([join(root, "src-api"), join(root, "src-web"), join(root, "src-web")]);
});

test("pass: while any repo's claims cannot be read, project-routed tickets wait without a comment; explicit ones still start", async () => {
  const c = config({ maxConcurrent: 4, repos: [{ name: "acme/web", path: join(root, "src-web") }, { name: "acme/api", path: join(root, "src-api") }], sources: [src({ name: "lin", tracker: "linear", team: "ENG" })] });
  const yaml: Record<string, string> = { [join(root, "src-web")]: "tracker:\n  linear:\n    project: Shared\n", [join(root, "src-api")]: "tracker:\n  linear:\n    project: Shared\n" };
  const ready = [issue("ENG-1", named("agent"), null, { id: "p-shared2", name: "Shared" }), issue("ENG-2", named("agent", "repo:acme/web"), null, { id: "p-shared2", name: "Shared" })];
  let failApi: "fetch" | "yaml" | undefined = "fetch";
  const comments: string[] = [];
  const { io, cmds, logs } = fakeIo((a) => {
    if (a[0] === "git" && a[2] === join(root, "src-api") && failApi === "fetch" && a[3] === "fetch") return { code: 1, err: "network down" };
    const y = a[0] === "git" ? (failApi === "yaml" && a[2] === join(root, "src-api") ? "agent: gpt\n" : yaml[a[2]!]) : undefined;
    if (y !== undefined && a[3] === "ls-tree") return { out: a[4] === "-r" ? `100644 blob ${"1".repeat(40)} ${y.length}\t.tender/config.yaml\0` : `040000 tree ${"2".repeat(40)}\t.tender\0` };
    if (y !== undefined && a[3] === "cat-file") return { out: y };
    if (a[1] === "list-windows") return windowsOut([]);
    return a[5] === "--quiet" ? { code: 1 } : noPr(a);
  });
  io.fetch = (async (_url: string, init: any) => {
    const { query, variables } = JSON.parse(init.body);
    if (query.includes("issues(")) return Response.json({ data: { issues: { nodes: variables.f.state.name.eq === "Todo" ? ready : [] } } });
    if (query.includes("commentCreate")) return comments.push(`${variables.i.issueId} ${variables.i.body}`), Response.json({ data: { commentCreate: { success: true } } });
    if (query.includes("workflowStates")) return Response.json({ data: { workflowStates: { nodes: [{ id: "s", name: "In Progress", team: { id: "t" } }] } } });
    return Response.json({ data: { issueUpdate: { success: true }, viewer: { id: "me" } } });
  }) as any;
  await withLinearKey(() => pass(c, io, makeTracker, "/tender"));
  expect(cmds.filter((x) => x.includes(" new-window ")).map((x) => x.split(" ").at(-2))).toEqual(["acme/web/ENG-2"]);
  expect(comments).toEqual(["ENG-2 tender: picked up on box"]);
  expect(logs.some((l) => l.startsWith("acme/api: linear project map unavailable, project-routed tickets wait:"))).toBe(true);
  failApi = "yaml";
  ready.pop();
  await withLinearKey(() => pass(c, io, makeTracker, "/tender"));
  expect(comments).toHaveLength(1);
  expect(logs.some((l) => l.includes("acme/api: linear project map unavailable, project-routed tickets wait: invalid .tender/"))).toBe(true);
  failApi = undefined;
  setBaseSha("b".repeat(40));
  await withLinearKey(() => pass(c, io, makeTracker, "/tender"));
  expect(comments.at(-1)).toStartWith("ENG-1 tender: no repo set on this ticket");
  expect(logs.filter((l) => l.includes('linear project "Shared" is claimed by acme/web, acme/api'))).toHaveLength(1);
});

test("pass: a failed map waits for every clone it started, so an explicit start in that repo does not clone it twice", async () => {
  const c = config({ maxConcurrent: 4, repos: [{ name: "acme/web", path: join(root, "src-web") }, { name: "acme/api", path: join(root, "src-api") }], sources: [src({ name: "lin", tracker: "linear", team: "ENG" })] });
  mkdirSync(join(root, "src-api"));
  const ready = [issue("ENG-1", named("agent"), null, { id: "p-race", name: "Race" }), issue("ENG-2", named("agent", "repo:acme/web"), null, null)];
  const fake = fakeIo((a) => (a[0] === "git" && a[2] === join(root, "src-api") && a[3] === "fetch" ? { code: 1, err: "network down" } : a[1] === "list-windows" ? windowsOut([]) : a[5] === "--quiet" ? { code: 1 } : noPr(a)));
  const run = fake.io.run;
  fake.io.run = async (argv, cwd, secs) => (argv[1] === "repo" && argv[2] === "clone" && (await Bun.sleep(20)), run(argv, cwd, secs));
  fake.io.fetch = (async (_url: string, init: any) => {
    const { query, variables } = JSON.parse(init.body);
    if (query.includes("issues(")) return Response.json({ data: { issues: { nodes: variables.f.state.name.eq === "Todo" ? ready : [] } } });
    if (query.includes("workflowStates")) return Response.json({ data: { workflowStates: { nodes: [{ id: "s", name: "In Progress", team: { id: "t" } }] } } });
    return Response.json({ data: { issueUpdate: { success: true }, commentCreate: { success: true }, viewer: { id: "me" } } });
  }) as any;
  await withLinearKey(() => pass(c, fake.io, makeTracker, "/tender"));
  expect(fake.cmds.filter((x) => x.startsWith("gh repo clone acme/web "))).toHaveLength(1);
  expect(fake.cmds.filter((x) => x.includes(" new-window ")).map((x) => x.split(" ").at(-2))).toEqual(["acme/web/ENG-2"]);
});

test("linear repo: label groups read as group:name", () => {
  const t = linearTicket(issue("PER-1", [{ name: "agent", parent: null }, { name: "acme/web", parent: { name: "repo" } }], null, null));
  expect(t.repo).toBe("acme/web");
  expect(t.labels).toEqual(["agent", "repo:acme/web"]);
  expect(linearTicket(issue("PER-1", [{ name: "acme/web", parent: { name: "other" } }], null, null)).repo).toBeUndefined();
});

test("linear adapter: every comment starts with tender:", async () => {
  const l = lin(config({ sources: [src({ tracker: "linear", team: "ENG" })] }));
  const bodies: any[] = [];
  const { io } = fakeIo();
  io.fetch = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ data: { commentCreate: { success: true } } });
  }) as any;
  await withLinearKey(() => linear(l, "box", io, false).comment({ id: "ENG-1", ref: "u-1", title: "", body: "", url: "" }, "hi"));
  expect(bodies[0].variables.i).toEqual({ issueId: "u-1", body: "tender: hi" });
});

test("linear adapter: a comment Linear reports as not successful throws", async () => {
  const l = lin(config({ sources: [src({ tracker: "linear", team: "ENG" })] }));
  const { io } = fakeIo();
  io.fetch = (async () => Response.json({ data: { commentCreate: { success: false } } })) as any;
  await expect(withLinearKey(() => linear(l, "box", io, false).comment({ id: "ENG-1", ref: "u-1", title: "", body: "", url: "" }, "hi"))).rejects.toThrow("not successful for ENG-1");
});

test("linear adapter: comments parsed, author is the user email, none for a null user", async () => {
  const l = lin(config({ sources: [src({ tracker: "linear", team: "ENG" })] }));
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
  const l = lin(config({ sources: [src({ tracker: "linear", team: "ENG" })] }));
  const t = { id: "ENG-1", ref: "u-1", title: "", body: "", url: "" };
  const afters: unknown[] = [];
  const { io } = fakeIo();
  let pages = 2;
  io.fetch = (async (_url: string, init: any) => {
    const { after } = JSON.parse(init.body).variables;
    afters.push(after);
    const n = afters.length;
    const nodes = Array.from({ length: n < pages ? 100 : 1 }, (_, i) => ({ id: `c${n}-${i}`, body: n === 2 ? "tender: x\n\ntender-findings aaaaaaaaaaaa" : "hi", createdAt: "", user: null }));
    return Response.json({ data: { issue: { comments: { nodes, pageInfo: { hasNextPage: n < pages, endCursor: `p${n}` } } } } });
  }) as any;
  const cs = await withLinearKey(() => linear(l, "box", io, false).comments(t, 0));
  expect(cs).toHaveLength(101);
  expect(cs.at(-1)!.body).toContain("tender-findings aaaaaaaaaaaa");
  expect(afters).toEqual([null, "p1"]);
  afters.length = 0;
  pages = 99;
  await expect(withLinearKey(() => linear(l, "box", io, false).comments(t, 0))).rejects.toThrow("more than 2000");
  expect(afters).toHaveLength(20);
});

test("linear adapter: park adds an ungrouped team or workspace label, fails clearly otherwise; parked reads fresh labels", async () => {
  const l = lin(config({ sources: [src({ tracker: "linear", team: "ENG" })] }));
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

test("linear adapter: a canceled-type state is canceled whatever its name, a done name is done", async () => {
  const l = lin(config({ sources: [src({ tracker: "linear", team: "ENG", done: ["Done", "Canceled"] })] }));
  const { io } = fakeIo();
  let state: object | null = null;
  const queries: string[] = [];
  io.fetch = (async (_url: string, init: any) => (queries.push(JSON.parse(init.body).query), Response.json({ data: { issue: { state } } }))) as any;
  const tr = linear(l, "box", io);
  const cases: [object | null, string | undefined][] = [
    [{ name: "Canceled", type: "canceled" }, "canceled"],
    [{ name: "Won't do", type: "canceled" }, "canceled"],
    [{ name: "Duplicate", type: "duplicate" }, "canceled"],
    [{ name: "Done", type: "completed" }, "done"],
    [{ name: "In Progress", type: "started" }, undefined],
    [null, undefined],
  ];
  await withLinearKey(async () => {
    for (const [st, want] of cases) {
      state = st;
      expect(await tr.closed("ENG-1", "acme/web")).toBe(want as any);
    }
  });
  expect(queries[0]).toContain("state { name type }");
});

test("linear adapter: claim survives a failed pickup comment; a move Linear reports as not successful throws", async () => {
  const l = lin(config({ sources: [src({ tracker: "linear", team: "ENG" })] }));
  let moved = true;
  const bodies: any[] = [];
  const respond = (async (_url: string, init: any) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    if (b.query.includes("workflowStates")) return Response.json({ data: { workflowStates: { nodes: [{ id: "s-ip", name: "In Progress", team: { id: "team" } }] } } });
    if (b.query.includes("issueUpdate")) return Response.json({ data: { issueUpdate: { success: moved } } });
    if (b.query.includes("viewer")) return Response.json({ data: { viewer: { id: "user-me" } } });
    return Response.json({ data: { commentCreate: { success: false } } });
  }) as any;
  const { io, logs } = fakeIo();
  io.fetch = respond;
  const t = { id: "ENG-1", ref: "u-1", title: "t", body: "", url: "u" };
  await withLinearKey(async () => {
    await linear(l, "box", io).claim(t);
    expect(bodies.map((b) => b.query.match(/\{\s*(\w+)/)[1])).toEqual(["viewer", "workflowStates", "issueUpdate", "commentCreate"]);
    expect(bodies[2].variables).toEqual({ id: "u-1", i: { stateId: "s-ip", assigneeId: "user-me" } });
    expect(logs).toContain("ENG-1: picked-up comment failed: linear commentCreate: not successful for ENG-1");
    moved = false;
    await expect(linear(l, "box", io).claim(t)).rejects.toThrow("linear issueUpdate: not successful for u-1");
    const dry = fakeIo(undefined, true).io;
    dry.fetch = respond;
    await linear(l, "box", dry).claim(t);
  });
});

test("linear adapter: a trashed issue, or one missing from the response, is canceled", async () => {
  const l = lin(config({ sources: [src({ tracker: "linear", team: "ENG" })] }));
  let issue: object | null = null;
  const queries: string[] = [];
  const { io } = fakeIo();
  io.fetch = (async (_url: string, init: any) => (queries.push(JSON.parse(init.body).query), Response.json({ data: { issue } }))) as any;
  const tr = linear(l, "box", io);
  await withLinearKey(async () => {
    expect(await tr.closed("ENG-1", "acme/web")).toBe("canceled");
    issue = { trashed: true, state: { name: "In Progress", type: "started" } };
    expect(await tr.closed("ENG-1", "acme/web")).toBe("canceled");
    issue = { trashed: false, state: { name: "In Progress", type: "started" } };
    expect(await tr.closed("ENG-1", "acme/web")).toBeUndefined();
  });
  expect(queries[0]).toContain("trashed state { name type }");
});

test("linear adapter: a ticket assigned to another user carries their name; unassigned or the viewer's does not; the viewer is read once", async () => {
  const l = lin(config({ sources: [src({ tracker: "linear", team: "ENG" })] }));
  const nodes = [{ ...issue("ENG-1", named("agent", "host:box"), null, null), assignee: null }, { ...issue("ENG-2", named("agent", "host:box"), null, null), assignee: { id: "user-me", name: "Me" } }, { ...issue("ENG-3", named("agent", "host:box"), null, null), assignee: { id: "user-al", name: "Alice" } }];
  const queries: string[] = [];
  const { io } = fakeIo();
  io.fetch = (async (_url: string, init: any) => {
    const { query } = JSON.parse(init.body);
    queries.push(query);
    return Response.json({ data: query.includes("viewer") ? { viewer: { id: "user-me" } } : { issues: { nodes } } });
  }) as any;
  const tr = linear(l, "box", io);
  await withLinearKey(async () => {
    expect((await tr.listReady()).map((t) => [t.id, t.otherAssignee])).toEqual([["ENG-1", undefined], ["ENG-2", undefined], ["ENG-3", "Alice"]]);
    await tr.listInProgress();
  });
  expect(queries.filter((q) => q.includes("viewer"))).toHaveLength(1);
  expect(LINEAR_ISSUES).toContain("assignee { id name }");
});

test("linear adapter: intake files with rule labels resolved by name, and a missing label files nothing", async () => {
  const bodies: any[] = [];
  const { io } = fakeIo();
  io.fetch = (async (_url: string, init: any) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    if (b.query.includes("issueLabels")) return Response.json({ data: { issueLabels: { nodes: b.variables.n === "missing" ? [] : [{ id: `l-${b.variables.n}`, parent: null }] } } });
    if (b.query.includes("workflowStates")) return Response.json({ data: { workflowStates: { nodes: [{ id: "s-todo", name: "Todo" }] } } });
    if (b.query.includes("teams")) return Response.json({ data: { teams: { nodes: [{ id: "t-eng" }] } } });
    return Response.json({ data: { issueCreate: { issue: { id: "i-1", url: "https://linear.app/acme/issue/ENG-1/t" } } } });
  }) as any;
  await withLinearKey(async () => {
    const tr = linear(lin(config({ sources: [src({ tracker: "linear", team: "ENG" })] })), "box", io);
    expect(await tr.fileTicket({ repo: "acme/web" }, "T", "B", ["sentry", "agent"])).toBe("https://linear.app/acme/issue/ENG-1/t");
    expect(bodies.find((b) => b.query.includes("issueCreate")).variables.i.labelIds).toEqual(["l-sentry", "l-agent"]);
    bodies.length = 0;
    await expect(tr.fileTicket({ repo: "acme/web" }, "T", "B", ["missing"])).rejects.toThrow('linear label "missing" not found');
    expect(bodies.some((b) => b.query.includes("issueCreate"))).toBe(false);
  });
});

test("linear adapter: intake markers match whole lines only; reopen drops the ready label before Todo and stops if it cannot", async () => {
  const m = "tender-intake: acme/web:errs:a";
  let removed = true;
  let more = false;
  const bodies: any[] = [];
  const { io } = fakeIo();
  io.fetch = (async (_url: string, init: any) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    if (b.query.includes("description: { contains")) return Response.json({ data: { issues: { nodes: [{ url: "u-abc", description: `${m}bc` }, { url: "u-quoted", description: `see ${m}` }, ...(more ? [] : [{ url: "u-a", description: `x\n${m}` }])], pageInfo: { hasNextPage: more } } } });
    if (b.query.includes("issueLabels")) return Response.json({ data: { issueLabels: { nodes: [{ id: "l-agent", parent: null }] } } });
    if (b.query.includes("issueRemoveLabel")) return Response.json({ data: { issueRemoveLabel: { success: removed } } });
    if (b.query.includes("workflowStates")) return Response.json({ data: { workflowStates: { nodes: [{ id: "s-todo", name: "Todo" }] } } });
    return Response.json({ data: { issueUpdate: { success: true } } });
  }) as any;
  const t = { id: "ENG-1", ref: "ENG-1", title: "t", body: "", url: "u" };
  await withLinearKey(async () => {
    const tr = linear(lin(config({ sources: [src({ tracker: "linear", team: "ENG" })] })), "box", io);
    expect(await tr.findMarker({ repo: "acme/web" }, m)).toBe("u-a");
    more = true;
    await expect(tr.findMarker({ repo: "acme/web" }, m)).rejects.toThrow("cannot rule out a duplicate");
    more = false;
    await tr.reopen(t);
    const mutations = bodies.filter((b) => b.query.startsWith("mutation")).map((b) => /\{ (\w+)\(/.exec(b.query)![1]);
    expect(mutations).toEqual(["issueRemoveLabel", "issueUpdate"]);
    removed = false;
    bodies.length = 0;
    await expect(tr.reopen(t)).rejects.toThrow("issueRemoveLabel: not successful");
    expect(bodies.some((b) => b.query.includes("issueUpdate"))).toBe(false);
  });
});
