#!/usr/bin/env -S bun --no-env-file
// tender intake example: one ticket per frequent active PostHog error tracking issue. Needs POSTHOG_TOKEN (personal API key, error_tracking:read only) and the PostHog host in `network`.
// Copy to .tender/intake/posthog-errors.ts (executable) and add a rule with `labels: [posthog]` and `args: [--project, <project id>]`; see docs/intake.md.
import { parseArgs } from "node:util";

const { values: a } = parseArgs({
  args: process.argv.slice(2),
  options: {
    project: { type: "string" },
    url: { type: "string", default: "https://us.posthog.com" },
    "min-events": { type: "string", default: "10" },
    "min-users": { type: "string", default: "3" },
    "period-days": { type: "string", default: "14" },
    top: { type: "string", default: "10" },
    recheck: { type: "string" },
  },
});
const num = (k: "min-events" | "min-users" | "period-days" | "top") => {
  const n = Number(a[k]);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${k}: non-negative integer`);
  return n;
};
if (!a.project) throw new Error("--project is required");
const token = process.env.POSTHOG_TOKEN;
if (!token) throw new Error("POSTHOG_TOKEN is not set");
const host = a.url.replace(/\/$/, "");
const base = `${host}/api/projects/${encodeURIComponent(a.project)}/error_tracking/query`;

async function post(path: "issues" | "issue_events", body: object) {
  const res = await fetch(`${base}/${path}/`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${res.status} from ${path}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as any;
}

if (a.recheck !== undefined) {
  const id = /^posthog:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(a.recheck)?.[1];
  const since = process.env.TENDER_DONE_AT;
  if (!id || !since || !Number.isFinite(Date.parse(since))) throw new Error("--recheck posthog:<issue id> needs TENDER_DONE_AT");
  const done = Date.parse(since);
  const say = (state: string, detail: string) => (console.log(JSON.stringify({ state, detail })), process.exit(0));
  let seen = 0, bare = 0;
  for (let offset = 0, pages = 0; ; pages++) {
    if (pages >= 10) throw new Error(`over ${seen} events since ${since}, none on a release created after it; cannot decide, so this recheck fails and is retried next run`);
    // A 404 (deleted issue, or a wrong --project) fails rather than closing every ticket as gone.
    const page = await post("issue_events", { issueId: id, dateRange: { date_from: new Date(done).toISOString() }, include: ["release"], limit: 20, offset });
    for (const e of page.results) {
      const at = Date.parse(e.timestamp);
      if (!Number.isFinite(at) || at < done) throw new Error(`event at ${JSON.stringify(e.timestamp)} is not after ${since}; cannot decide`);
      const rel = e.properties?.$exception_release;
      // Like sentry.ts: an event without a release may come from the old build, so it is no evidence.
      if (rel == null) {
        bare++;
        continue;
      }
      const created = Date.parse(rel.timestamp);
      if (!Number.isFinite(created)) throw new Error(`release ${JSON.stringify(rel.version)} has no readable timestamp; cannot decide, so this recheck fails and is retried next run`);
      if (created > done) say("still", `New events on a release created after ${since}: ${rel.version}.`);
    }
    seen += page.results.length;
    if (!page.hasMore) break;
    offset = page.nextOffset ?? offset + 20;
  }
  const ignored = bare ? ` (${bare} without a release ignored)` : "";
  say("gone", seen ? `${seen} events since ${since}, none on a release created after it${ignored}.` : `No events since ${since}.`);
}

const [minEvents, minUsers, days, top] = [num("min-events"), num("min-users"), num("period-days"), num("top")];
const dateRange = { date_from: `-${days}d` };
const count = (i: any, k: "occurrences" | "users") => {
  const n = i.aggregations?.[k];
  if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`issue ${i.id}: aggregations.${k} is not a number`);
  return n;
};
const issues: any[] = [];
for (let offset = 0, pages = 1; ; pages++) {
  const page = await post("issues", { status: "active", dateRange, orderBy: "occurrences", orderDirection: "DESC", limit: 100, offset });
  issues.push(...page.results.filter((i: any) => count(i, "occurrences") >= minEvents && count(i, "users") >= minUsers));
  const last = page.results.at(-1);
  if (issues.length >= 100 || !page.hasMore || pages >= 10 || !last || count(last, "occurrences") < minEvents) break;
  offset = page.nextOffset ?? offset + 100;
}

const frame = (f: any) => `- \`${f.source || "?"}${f.line ? `:${f.line}` : ""}\` in \`${f.resolved_name || f.mangled_name || "?"}\``.slice(0, 200);
for (const [n, i] of issues.slice(0, 100).entries()) {
  const ev = n < top ? (await post("issue_events", { issueId: i.id, dateRange, include: ["exception", "stacktrace", "release"], limit: 1 })).results[0] : undefined;
  const props = ev?.properties ?? {};
  const frames = (Array.isArray(props.$exception_list) ? props.$exception_list : []).flatMap((x: any) => x?.stacktrace?.frames ?? []);
  // Reversed like PostHog's own top_in_app_frame: the last frame of the list is the innermost.
  const inApp = frames.filter((f: any) => f.in_app === true).reverse().slice(0, 10);
  const release = typeof props.$exception_release?.version === "string" ? props.$exception_release.version : undefined;
  const level = typeof props.$exception_level === "string" ? props.$exception_level : undefined;
  const body = [
    `**${String(i.name ?? "Unnamed issue").slice(0, 300)}**`,
    i.description && `Message: ${i.description}`,
    inApp.length ? `In-app frames, innermost first:\n${inApp.map(frame).join("\n")}` : ev ? "No in-app frames in the latest event." : undefined,
    `${count(i, "occurrences")} events from ${count(i, "users")} users in ${days} days. First seen ${i.first_seen}, last seen ${i.last_seen}.`,
    release && `Latest event's release: ${release}`,
    `PostHog: ${host}/project/${encodeURIComponent(a.project)}/error-tracking/${i.id}`,
  ].filter(Boolean);
  const facts = { events: count(i, "occurrences"), users: count(i, "users"), firstSeen: String(i.first_seen), ...(typeof i.severity === "string" ? { severity: i.severity } : {}), ...(level ? { level } : {}), ...(release ? { release } : {}) };
  const title = `PostHog: ${[i.name, i.description].filter(Boolean).join(": ") || i.id}`.slice(0, 200);
  console.log(JSON.stringify({ key: `posthog:${i.id}`, title, body: body.join("\n\n"), facts }));
}
