import { afterAll, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { parseCollect, parseRecheck } from "../src/intake";

const SCRIPT = join(import.meta.dir, "../intake/sentry.ts");
const DONE = "2026-01-10T00:00:00Z";
const issue = (id: number, count: number, users: number) => ({ id: String(id), shortId: `WEB-${id}`, title: `Boom ${id}`, culprit: `app/x.ts in f${id}`, count: String(count), userCount: users, level: "error", firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-12T00:00:00Z", permalink: `https://acme.sentry.io/issues/${id}/` });
const frames = Array.from({ length: 15 }, (_, n) => ({ inApp: n !== 3, filename: `app/f${n}.ts`, function: `fn${n}`, lineNo: n + 1 }));

let reqs: URL[] = [];
let pages: any[][] = [];
let eventReleases: string[] = [];
let relPages: any[][] = [];
let fail = false;
const server = Bun.serve({
  port: 0,
  fetch(req): Response {
    const u = new URL(req.url);
    reqs.push(u);
    if (fail || req.headers.get("authorization") !== "Bearer tok") return new Response("nope", { status: 403 });
    const p = u.pathname.replace("/api/0/organizations/acme", "");
    const list = p === "/issues/" ? pages : p === "/releases/" ? relPages : undefined;
    if (list) {
      const i = Number(u.searchParams.get("cursor") ?? 0);
      const nextUrl = new URL(u);
      nextUrl.searchParams.set("cursor", String(i + 1));
      const next = i + 1 < list.length ? `<${nextUrl}>; rel="next"; results="true"; cursor="${i + 1}"` : `<x>; rel="next"; results="false"`;
      const all = p === "/releases/" && u.searchParams.get("status") !== "" ? (list[i] ?? []).filter((r) => !r.archived) : (list[i] ?? []);
      return Response.json(all, { headers: { link: next } });
    }
    if (/^\/issues\/\d+\/events\/latest\/$/.test(p)) return Response.json({ release: { version: "web@2" }, entries: [{ type: "exception", data: { values: [{ stacktrace: { frames } }] } }] });
    if (/^\/issues\/\d+\/events\/$/.test(p)) {
      const wanted: string[] = JSON.parse(/^release:(\[.*\])$/.exec(u.searchParams.get("query") ?? "")![1]!);
      return Response.json(eventReleases.filter((v) => wanted.includes(v)).map((v) => ({ tags: [{ key: "release", value: v }] })));
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  reqs = [];
  pages = [];
  eventReleases = [];
  relPages = [];
  fail = false;
});

async function run(args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawn([SCRIPT, "--url", server.url.href, "--org", "acme", "--project", "web", "--environment", "production", ...args], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, SENTRY_TOKEN: "tok", ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text(), r.exited]);
  return { code, out, err };
}

test("collect: thresholds filter, pages stop below minEvents, and only the top N fetch an event", async () => {
  pages = [[issue(1, 500, 40), issue(2, 300, 2), issue(3, 200, 9)], [issue(4, 50, 5), issue(5, 9, 100)], [issue(6, 8, 8)]];
  const r = await run(["--top", "2"]);
  expect(r.code).toBe(0);
  const found = parseCollect(r.out);
  expect(found.map((f) => f.key)).toEqual(["sentry:1", "sentry:3", "sentry:4"]);
  expect(reqs.filter((u) => u.pathname.endsWith("/latest/")).map((u) => u.pathname.split("/")[6])).toEqual(["1", "3"]);
  expect(reqs.filter((u) => u.pathname.endsWith("/organizations/acme/issues/"))).toHaveLength(2);
  const q = reqs[0]!.searchParams;
  expect(Object.fromEntries(q)).toEqual({ project: "web", environment: "production", statsPeriod: "14d", query: "is:unresolved", sort: "freq", limit: "100" });
  expect(found[0]!.facts).toEqual({ events: 500, users: 40, level: "error", firstSeen: "2026-01-01T00:00:00Z", release: "web@2" });
  expect(found[2]!.facts).toEqual({ events: 50, users: 5, level: "error", firstSeen: "2026-01-01T00:00:00Z" });
});

test("collect: argument thresholds apply and the body has the frames, counts, dates, release and link", async () => {
  pages = [[issue(1, 500, 40), issue(2, 30, 5)]];
  const [f, ...rest] = parseCollect((await run(["--min-events", "100", "--min-users", "10", "--period-days", "7"])).out);
  expect(rest).toEqual([]);
  expect(reqs[0]!.searchParams.get("statsPeriod")).toBe("7d");
  expect(f!.title).toBe("WEB-1: Boom 1");
  const lines = f!.body.split("\n");
  const fr = lines.filter((l) => l.startsWith("- `"));
  expect(fr).toHaveLength(10);
  expect(fr[0]).toBe("- `app/f14.ts:15` in `fn14`");
  expect(fr.some((l) => l.includes("fn3"))).toBe(false);
  for (const s of ["**Boom 1**", "Culprit: `app/x.ts in f1`", "500 events from 40 users in 7 days (production). First seen 2026-01-01T00:00:00Z, last seen 2026-01-12T00:00:00Z.", "Latest event's release: web@2", "Sentry: https://acme.sentry.io/issues/1/"])
    expect(f!.body).toContain(s);
});

test("collect: output is capped at 100 lines", async () => {
  pages = [Array.from({ length: 100 }, (_, n) => issue(n + 1, 1000 - n, 50)), Array.from({ length: 20 }, (_, n) => issue(n + 200, 500, 50))];
  expect(parseCollect((await run(["--top", "0"])).out)).toHaveLength(100);
  expect(reqs.some((u) => u.pathname.endsWith("/latest/"))).toBe(false);
});

const rel = (version: string, day: number) => ({ version, dateCreated: `2026-01-${String(day).padStart(2, "0")}T00:00:00Z` });
const recheck = async () => parseRecheck((await run(["--recheck", "sentry:7"], { TENDER_DONE_AT: DONE })).out);

test("recheck: still only for events on a release created after the merge", async () => {
  relPages = [[rel("web@3", 12), rel("web@2", 11), rel("web@1", 1)]];
  eventReleases = ["web@1", "web@2"];
  expect(await recheck()).toEqual({ state: "still", detail: `New events on a release created after ${DONE}: web@2.` });
  const q = reqs.find((u) => u.pathname.endsWith("/issues/7/events/"))!.searchParams;
  expect([q.get("start"), q.get("environment"), q.get("query")]).toEqual([DONE, "production", 'release:["web@3", "web@2"]']);
  eventReleases = ["web@1"];
  expect(await recheck()).toEqual({ state: "gone", detail: `No events since ${DONE} on the 2 releases created after it.` });
  relPages = [[rel("web@1", 1)]];
  reqs = [];
  expect(await recheck()).toEqual({ state: "gone", detail: `No release created since ${DONE}.` });
  expect(reqs.some((u) => u.pathname.includes("/events/"))).toBe(false);
});

test("recheck: newer releases on later pages and past the first 20 are all searched", async () => {
  relPages = [Array.from({ length: 100 }, (_, n) => rel(`a${n}`, 20)), [rel("b0", 15), rel("old", 2)], [rel("c0", 30)], [rel("d0", 30)]];
  eventReleases = ["b0"];
  expect((await recheck()).state).toBe("still");
  expect(reqs.filter((u) => u.pathname.endsWith("/releases/"))).toHaveLength(4);
  expect(reqs.filter((u) => u.pathname.endsWith("/events/"))).toHaveLength(6);
  eventReleases = ["a25"];
  expect((await recheck()).state).toBe("still");
});

test("recheck: an archived release created after the merge still counts", async () => {
  relPages = [[{ ...rel("web@2", 12), archived: true }, rel("web@1", 1)]];
  eventReleases = ["web@2"];
  expect((await recheck()).state).toBe("still");
  expect(Object.fromEntries(reqs.find((u) => u.pathname.endsWith("/releases/"))!.searchParams)).toEqual({ project: "web", per_page: "100", sort: "date", status: "" });
});

test("recheck: more than 10 pages of newer releases fails rather than guess either way", async () => {
  relPages = Array.from({ length: 11 }, (_, i) => Array.from({ length: 100 }, (_, n) => rel(`r${i}-${n}`, 20)));
  const r = await run(["--recheck", "sentry:7"], { TENDER_DONE_AT: DONE });
  expect([r.code, r.out]).toEqual([1, ""]);
  expect(r.err).toContain(`over 1000 releases created since ${DONE}; cannot decide`);
  expect(reqs.some((u) => u.pathname.includes("/events/"))).toBe(false);
});

test("errors exit non-zero: an API error, a missing done time, a bad key or a missing token", async () => {
  fail = true;
  const r = await run([]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("403");
  expect(r.out).toBe("");
  fail = false;
  expect((await run(["--recheck", "sentry:7"])).code).not.toBe(0);
  expect((await run(["--recheck", "other:7"], { TENDER_DONE_AT: DONE })).code).not.toBe(0);
  expect((await run([], { SENTRY_TOKEN: "" })).code).not.toBe(0);
});
