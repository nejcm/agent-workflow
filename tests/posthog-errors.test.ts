import { afterAll, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { parseCollect, parseRecheck } from "../src/intake";

const SCRIPT = join(import.meta.dir, "../intake/posthog-errors.ts");
const DONE = "2026-01-10T00:00:00Z";
const ID = "0190a3c4-0000-7000-8000-000000000007";
const uuid = (n: number) => `0190a3c4-0000-7000-8000-${String(n).padStart(12, "0")}`;
const issue = (n: number, occurrences: number, users: number) => ({ id: uuid(n), name: `TypeError ${n}`, description: `x is undefined ${n}`, status: "active", severity: n === 1 ? "high" : null, first_seen: "2026-01-01T00:00:00Z", last_seen: "2026-01-12T00:00:00Z", aggregations: { occurrences, users, sessions: users } });
const frames = Array.from({ length: 15 }, (_, n) => ({ in_app: n !== 3, source: `app/f${n}.ts`, mangled_name: `m${n}`, ...(n === 14 ? { resolved_name: "fn14" } : {}), line: n + 1 }));
const event = (release?: { version: string; timestamp: string }) => ({ uuid: "e", timestamp: "2026-01-11T00:00:00Z", properties: { ...(release ? { $exception_release: release } : {}) } });

let reqs: { path: string; body: any }[] = [];
let pages: any[][] = [];
let events: any[] = [];
let fail = false;
const server = Bun.serve({
  port: 0,
  async fetch(req): Promise<Response> {
    const u = new URL(req.url);
    const body = req.method === "POST" ? await req.json() : undefined;
    const path = u.pathname.replace("/api/projects/42/error_tracking/query", "");
    reqs.push({ path, body });
    if (fail || req.headers.get("authorization") !== "Bearer tok") return new Response("nope", { status: 403 });
    if (path === "/issues/") {
      const i = body.offset / 100;
      return Response.json({ results: pages[i] ?? [], hasMore: i + 1 < pages.length, limit: 100, offset: body.offset, ...(i + 1 < pages.length ? { nextOffset: body.offset + 100 } : {}) });
    }
    if (path === "/issue_events/" && body.include.includes("stacktrace"))
      return Response.json({ results: [{ properties: { $exception_level: "error", $exception_release: { version: "web@2", timestamp: "2026-01-02T00:00:00Z" }, $exception_list: [{ type: "TypeError", stacktrace: { frames } }] } }], hasMore: false, limit: 1, offset: 0 });
    if (path === "/issue_events/") {
      const page = events.slice(body.offset, body.offset + body.limit);
      const more = body.offset + body.limit < events.length;
      return Response.json({ results: page, hasMore: more, limit: body.limit, offset: body.offset, ...(more ? { nextOffset: body.offset + body.limit } : {}) });
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  reqs = [];
  pages = [];
  events = [];
  fail = false;
});

async function run(args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawn([SCRIPT, "--url", server.url.href, "--project", "42", ...args], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, POSTHOG_TOKEN: "tok", ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text(), r.exited]);
  return { code, out, err };
}

test("collect: thresholds filter, pages stop below minEvents, and only the top N fetch an event", async () => {
  pages = [[issue(1, 500, 40), issue(2, 300, 2), issue(3, 200, 9)], [issue(4, 50, 5), issue(5, 9, 100)], [issue(6, 8, 8)]];
  const r = await run(["--top", "2"]);
  expect(r.code).toBe(0);
  const found = parseCollect(r.out);
  expect(found.map((f) => f.key)).toEqual([`posthog:${uuid(1)}`, `posthog:${uuid(3)}`, `posthog:${uuid(4)}`]);
  expect(reqs.filter((q) => q.path === "/issue_events/").map((q) => q.body.issueId)).toEqual([uuid(1), uuid(3)]);
  const lists = reqs.filter((q) => q.path === "/issues/");
  expect(lists.map((q) => q.body.offset)).toEqual([0, 100]);
  expect(lists[0]!.body).toEqual({ status: "active", dateRange: { date_from: "-14d" }, orderBy: "occurrences", orderDirection: "DESC", limit: 100, offset: 0 });
  expect(reqs.find((q) => q.path === "/issue_events/")!.body).toEqual({ issueId: uuid(1), dateRange: { date_from: "-14d" }, include: ["exception", "stacktrace", "release"], limit: 1 });
  expect(found[0]!.facts).toEqual({ events: 500, users: 40, firstSeen: "2026-01-01T00:00:00Z", severity: "high", level: "error", release: "web@2" });
  expect(found[2]!.facts).toEqual({ events: 50, users: 5, firstSeen: "2026-01-01T00:00:00Z" });
  expect(found.every((f) => f.fixes === undefined)).toBe(true);
});

test("collect: argument thresholds apply and the body has the frames, counts, dates, release and link", async () => {
  pages = [[issue(1, 500, 40), issue(2, 30, 5)]];
  const [f, ...rest] = parseCollect((await run(["--min-events", "100", "--min-users", "10", "--period-days", "7"])).out);
  expect(rest).toEqual([]);
  expect(reqs[0]!.body.dateRange).toEqual({ date_from: "-7d" });
  expect(f!.title).toBe("PostHog: TypeError 1: x is undefined 1");
  const fr = f!.body.split("\n").filter((l) => l.startsWith("- `"));
  expect(fr).toHaveLength(10);
  expect(fr[0]).toBe("- `app/f14.ts:15` in `fn14`");
  expect(fr[1]).toBe("- `app/f13.ts:14` in `m13`");
  expect(fr.some((l) => l.includes("m3`"))).toBe(false);
  for (const s of ["**TypeError 1**", "Message: x is undefined 1", "500 events from 40 users in 7 days. First seen 2026-01-01T00:00:00Z, last seen 2026-01-12T00:00:00Z.", "Latest event's release: web@2", `PostHog: ${server.url.href.replace(/\/$/, "")}/project/42/error-tracking/${uuid(1)}`])
    expect(f!.body).toContain(s);
});

test("collect: a long name is capped in the body, and a malformed count fails the run", async () => {
  pages = [[{ ...issue(1, 500, 40), name: "N".repeat(5000) }]];
  const [f] = parseCollect((await run(["--top", "0"])).out);
  expect(f!.body.split("\n\n")[0]).toBe(`**${"N".repeat(300)}**`);
  for (const aggregations of [null, { occurrences: "500", users: 40 }, { occurrences: 500 }]) {
    pages = [[issue(1, 500, 40), { ...issue(2, 400, 40), aggregations }]];
    const r = await run([]);
    expect([r.code, r.out]).toEqual([1, ""]);
    expect(r.err).toContain(`issue ${uuid(2)}: aggregations.`);
  }
});

test("collect: output is capped at 100 lines", async () => {
  pages = [Array.from({ length: 100 }, (_, n) => issue(n + 1, 1000 - n, 50)), Array.from({ length: 20 }, (_, n) => issue(n + 200, 500, 50))];
  expect(parseCollect((await run(["--top", "0"])).out)).toHaveLength(100);
  expect(reqs.some((q) => q.path === "/issue_events/")).toBe(false);
});

const recheck = async () => parseRecheck((await run(["--recheck", `posthog:${ID}`], { TENDER_DONE_AT: DONE })).out);
const rel = (version: string, day: number) => ({ version, timestamp: `2026-01-${String(day).padStart(2, "0")}T00:00:00Z` });

test("recheck: still only for events on a release created after the merge", async () => {
  events = [event(rel("web@1", 1)), event(rel("web@2", 12))];
  expect(await recheck()).toEqual({ state: "still", detail: `New events on a release created after ${DONE}: web@2.` });
  expect(reqs[0]!.body).toEqual({ issueId: ID, dateRange: { date_from: "2026-01-10T00:00:00.000Z" }, include: ["release"], limit: 20, offset: 0 });
  events = [event(rel("web@1", 1)), event(rel("web@0", 9))];
  expect(await recheck()).toEqual({ state: "gone", detail: `2 events since ${DONE}, none on a release created after it.` });
  events = [];
  expect(await recheck()).toEqual({ state: "gone", detail: `No events since ${DONE}.` });
  events = [event(rel("web@1", 1)), event(), event()];
  expect(await recheck()).toEqual({ state: "gone", detail: `3 events since ${DONE}, none on a release created after it (2 without a release ignored).` });
  events = [event(), event(rel("web@2", 12))];
  expect((await recheck()).state).toBe("still");
  events = [event({ version: "web@3", timestamp: DONE })];
  expect((await recheck()).state).toBe("gone");
});

test("recheck: a release with an unreadable timestamp fails rather than guess", async () => {
  events = [event({ version: "web@3", timestamp: "soon" }), event(rel("web@4", 12))];
  const r = await run(["--recheck", `posthog:${ID}`], { TENDER_DONE_AT: DONE });
  expect([r.code, r.out]).toEqual([1, ""]);
  expect(r.err).toContain('release "web@3" has no readable timestamp; cannot decide');
});

test("recheck: later pages are searched, and over 10 pages of old-release events fails rather than guess", async () => {
  events = [...Array.from({ length: 45 }, () => event(rel("old", 2))), event(rel("new", 15))];
  expect((await recheck()).state).toBe("still");
  expect(reqs.map((q) => q.body.offset)).toEqual([0, 20, 40]);
  events = Array.from({ length: 201 }, () => event(rel("old", 2)));
  reqs = [];
  const r = await run(["--recheck", `posthog:${ID}`], { TENDER_DONE_AT: DONE });
  expect([r.code, r.out]).toEqual([1, ""]);
  expect(r.err).toContain(`over 200 events since ${DONE}, none on a release created after it; cannot decide`);
  expect(reqs).toHaveLength(10);
});

test("recheck: an event timestamp before the merge or unreadable fails rather than guess", async () => {
  for (const timestamp of ["2026-01-09T00:00:00Z", "later"]) {
    events = [{ ...event(rel("web@2", 12)), timestamp }];
    const r = await run(["--recheck", `posthog:${ID}`], { TENDER_DONE_AT: DONE });
    expect([r.code, r.out]).toEqual([1, ""]);
    expect(r.err).toContain(`is not after ${DONE}; cannot decide`);
  }
});

test("errors exit non-zero: an API error, a missing done time, a bad key or a missing token", async () => {
  fail = true;
  const r = await run([]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("403");
  expect(r.out).toBe("");
  expect((await run(["--recheck", `posthog:${ID}`], { TENDER_DONE_AT: DONE })).code).not.toBe(0);
  fail = false;
  expect((await run(["--recheck", `posthog:${ID}`])).code).not.toBe(0);
  expect((await run(["--recheck", "sentry:7"], { TENDER_DONE_AT: DONE })).code).not.toBe(0);
  expect((await run([], { POSTHOG_TOKEN: "" })).code).not.toBe(0);
});
