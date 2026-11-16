#!/usr/bin/env -S bun --no-env-file
// tender intake example: one ticket per frequent unresolved Sentry issue. Needs SENTRY_TOKEN (project:read, event:read) and the Sentry host in `network`.
// Copy to .tender/intake/sentry.ts (executable) and add a rule with `labels: [sentry]` and `args: [--org, <org>, --project, <project>]`; see docs/intake.md.
import { parseArgs } from "node:util";

const { values: a } = parseArgs({
  args: process.argv.slice(2),
  options: {
    org: { type: "string" },
    project: { type: "string" },
    environment: { type: "string" },
    url: { type: "string", default: "https://sentry.io" },
    "min-events": { type: "string", default: "10" },
    "min-users": { type: "string", default: "3" },
    "period-days": { type: "string", default: "14" },
    top: { type: "string", default: "10" },
    "no-fixes": { type: "boolean", default: false },
    recheck: { type: "string" },
  },
});
const num = (k: "min-events" | "min-users" | "period-days" | "top") => {
  const n = Number(a[k]);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${k}: non-negative integer`);
  return n;
};
if (!a.org || !a.project) throw new Error("--org and --project are required");
const token = process.env.SENTRY_TOKEN;
if (!token) throw new Error("SENTRY_TOKEN is not set");
const org = `${a.url.replace(/\/$/, "")}/api/0/organizations/${encodeURIComponent(a.org)}`;
const env: Record<string, string> = a.environment ? { environment: a.environment } : {};

async function get(path: string, q: Record<string, string> = {}) {
  const url = path.startsWith("http") ? path : `${org}${path}?${new URLSearchParams(q)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${res.status} from ${url.split("?")[0]}: ${(await res.text()).slice(0, 200)}`);
  const next = /<([^>]+)>;\s*rel="next";\s*results="true"/.exec(res.headers.get("link") ?? "")?.[1];
  return { body: (await res.json()) as any, next };
}

if (a.recheck !== undefined) {
  const id = /^sentry:(\d+)$/.exec(a.recheck)?.[1];
  const since = process.env.TENDER_DONE_AT;
  if (!id || !since || !Number.isFinite(Date.parse(since))) throw new Error("--recheck sentry:<issue id> needs TENDER_DONE_AT");
  const done = Date.parse(since);
  const say = (state: string, detail: string) => (console.log(JSON.stringify({ state, detail })), process.exit(0));
  // Newest first by dateCreated (sort=date); status="" includes archived releases, which the default hides.
  const newer: string[] = [];
  let page = await get("/releases/", { project: a.project, per_page: "100", sort: "date", status: "" });
  for (let pages = 1; ; pages++) {
    const fresh = (page.body as any[]).filter((r) => Date.parse(r.dateCreated) > done).map((r) => String(r.version));
    newer.push(...fresh);
    if (!fresh.length || !page.next) break;
    if (pages >= 10) throw new Error(`over ${newer.length} releases created since ${since}; cannot decide, so this recheck fails and is retried next run`);
    page = await get(page.next);
  }
  for (let i = 0; i < newer.length; i += 20) {
    const chunk = newer.slice(i, i + 20);
    const { body } = await get(`/issues/${id}/events/`, { start: since, end: new Date().toISOString(), per_page: "1", query: `release:[${chunk.map((v) => JSON.stringify(v)).join(", ")}]`, ...env });
    if (body.length) say("still", `New events on a release created after ${since}: ${body[0].tags?.find((t: any) => t.key === "release")?.value ?? chunk.join(", ")}.`);
  }
  say("gone", newer.length ? `No events since ${since} on the ${newer.length} releases created after it.` : `No release created since ${since}.`);
}

const [minEvents, minUsers, top] = [num("min-events"), num("min-users"), num("top")];
const issues: any[] = [];
let page = await get("/issues/", { project: a.project, ...env, statsPeriod: `${num("period-days")}d`, query: "is:unresolved", sort: "freq", limit: "100" });
for (let pages = 1; ; pages++) {
  issues.push(...page.body.filter((i: any) => Number(i.count) >= minEvents && i.userCount >= minUsers));
  const last = page.body.at(-1);
  if (issues.length >= 100 || !page.next || pages >= 10 || !last || Number(last.count) < minEvents) break;
  page = await get(page.next);
}

const frame = (f: any) => `- \`${f.module || f.filename || f.absPath || "?"}${f.lineNo ? `:${f.lineNo}` : ""}\` in \`${f.function || "?"}\``.slice(0, 200);
for (const [n, i] of issues.slice(0, 100).entries()) {
  const ev = n < top ? (await get(`/issues/${i.id}/events/latest/`, env)).body : undefined;
  const frames = (ev?.entries ?? []).filter((e: any) => e.type === "exception").flatMap((e: any) => e.data?.values ?? []).flatMap((v: any) => v.stacktrace?.frames ?? []);
  const inApp = frames.filter((f: any) => f.inApp).reverse().slice(0, 10);
  const release = ev?.release?.version ?? ev?.tags?.find((t: any) => t.key === "release")?.value;
  const body = [
    `**${i.title}**`,
    i.culprit && `Culprit: \`${i.culprit}\``,
    inApp.length ? `In-app frames, innermost first:\n${inApp.map(frame).join("\n")}` : ev ? "No in-app frames in the latest event." : undefined,
    `${i.count} events from ${i.userCount} users in ${num("period-days")} days${a.environment ? ` (${a.environment})` : ""}. First seen ${i.firstSeen}, last seen ${i.lastSeen}.`,
    release && `Latest event's release: ${release}`,
    i.permalink && `Sentry: ${i.permalink}`,
  ].filter(Boolean);
  const facts = { events: Number(i.count), users: i.userCount, level: String(i.level ?? "unknown"), firstSeen: String(i.firstSeen), ...(release ? { release } : {}) };
  const fixes = !a["no-fixes"] && /^[A-Z0-9][A-Z0-9_-]{0,63}-[A-Z0-9]{1,32}$/.test(i.shortId ?? "") ? { fixes: i.shortId } : {};
  console.log(JSON.stringify({ key: `sentry:${i.id}`, title: `${i.shortId ?? "Sentry"}: ${i.title}`, body: body.join("\n\n"), facts, ...fixes }));
}
