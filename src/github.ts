import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Io, Source, Ticket, Tracker } from "./types";
import { hasLabel, ours, put, read, write } from "./util";

export const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

export const canonCache = new Map<string, { name: string; at: number }>();
const CANON_TTL_MS = 5 * 60_000;

// GitHub serves a renamed/transferred repo under its old name, so the allowlist is checked against the name it resolves to.
export async function canonical(io: Io, key: string, fresh = false): Promise<string | undefined> {
  const hit = canonCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CANON_TTL_MS) return hit.name;
  try {
    const name = JSON.parse(await read(io, ["gh", "repo", "view", key, "--json", "nameWithOwner"])).nameWithOwner;
    if (typeof name !== "string") throw new Error("no nameWithOwner");
    canonCache.set(key, { name, at: Date.now() });
    if (!sameRepo(name, key)) io.log(`repo ${key}: GitHub resolves it to ${JSON.stringify(name.slice(0, 100))}, skipped`);
    return name;
  } catch (e) {
    io.log(`repo ${key}: lookup failed, skipped: ${(e as Error).message}`);
  }
}
export const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const PRIORITIES = ["urgent", "high", "medium", "low"];
/** Most urgent `priority:<urgent|high|medium|low>` label as a Linear-style rank, or undefined. */
export const labelPriority = (labels: string[]) => {
  const ranks = labels.map((x) => PRIORITIES.indexOf(/^priority:(\w+)$/i.exec(x)?.[1]?.toLowerCase() ?? "") + 1).filter((r) => r > 0);
  return ranks.length ? Math.min(...ranks) : undefined;
};
export const byPriority = (a: Ticket, b: Ticket) => (a.priority ?? 5) - (b.priority ?? 5);

export function github(l: Source, host: string, io: Io, defaultHost: boolean, repos: string[]): Tracker {
  const hostLabel = `host:${host}`;
  const listMine = (labels: string[], search?: string) =>
    defaultHost ? list(labels, search).then((r) => r.filter((t) => ours(t, host, true))) : list([...labels, hostLabel], search);
  const list = async (labels: string[], search?: string): Promise<Ticket[]> => {
    const all: Ticket[] = [];
    for (const repo of repos) {
      const name = await canonical(io, repo);
      if (!name || !sameRepo(name, repo)) continue;
      const argv = ["gh", "issue", "list", "--repo", repo, "--state", "open", "--limit", "100"];
      for (const x of labels) argv.push("--label", x);
      if (search) argv.push("--search", search);
      const issues: any[] = JSON.parse(await read(io, [...argv, "--json", "number,title,body,url,labels"]));
      for (const i of issues)
        if (Number.isInteger(i.number)) {
          const labels: string[] = (i.labels ?? []).map((x: any) => x.name);
          all.push({ id: `gh-${i.number}`, ref: String(i.number), title: i.title ?? "", body: i.body ?? "", url: i.url ?? "", labels, repo, priority: labelPriority(labels) });
        }
    }
    return all;
  };
  const skip = [l.inProgressLabel, l.inReviewLabel, l.needsHumanLabel];
  const edit = (t: Ticket, add: string, rm?: string) => write(io, ["gh", "issue", "edit", t.ref, "--repo", t.repo!, "--add-label", add, ...(rm ? ["--remove-label", rm] : [])]);
  const create = (t: Ticket, title: string, body: string, extra: string[] = []) => write(io, ["gh", "issue", "create", "--repo", t.repo!, ...extra, "--title", title, "--body", body]);
  const comment = async (t: Ticket, body: string) => { await write(io, ["gh", "issue", "comment", t.ref, "--repo", t.repo!, "--body", `aw: ${body}`]); };
  return {
    // Excluded server-side too: claimed tickets keep the ready label and would otherwise fill the 100 limit.
    listReady: async () => (await listMine([l.readyLabel], skip.map((x) => `-label:${JSON.stringify(x)}`).join(" "))).filter((t) => !skip.some((x) => hasLabel(t.labels, x))),
    listInProgress: () => listMine([l.readyLabel, l.inProgressLabel]),
    listInReview: () => listMine([l.readyLabel, l.inReviewLabel]),
    async closed(id, repo) {
      const n = /^gh-(\d+)$/.exec(id)?.[1];
      if (!n) throw new Error(`not a github ticket id: ${id}`);
      const i = JSON.parse(await read(io, ["gh", "issue", "view", n, "--repo", repo, "--json", "state,stateReason"]));
      if (i.state === "CLOSED") return ["NOT_PLANNED", "DUPLICATE"].includes(i.stateReason) ? "canceled" : "done";
    },
    async claim(t) {
      await edit(t, l.inProgressLabel);
      await comment(t, `picked up on ${host}`);
    },
    async toReview(t, prUrl) {
      await edit(t, l.inReviewLabel, l.inProgressLabel);
      await comment(t, `PR: ${prUrl}`);
    },
    done: (t) => write(io, ["gh", "issue", "close", t.ref, "--repo", t.repo!]).then(() => {}),
    park: (t) => edit(t, l.needsHumanLabel).then(() => {}),
    parked: async (t) => hasLabel((JSON.parse(await read(io, ["gh", "issue", "view", t.ref, "--repo", t.repo!, "--json", "labels"])).labels ?? []).map((x: any) => x.name), l.needsHumanLabel),
    comment,
    async comments(t) {
      const cs: any[] = JSON.parse(await read(io, ["gh", "issue", "view", t.ref, "--repo", t.repo!, "--json", "comments"])).comments ?? [];
      return cs.map((c) => ({ id: String(c.id), body: c.body ?? "", createdAt: c.createdAt ?? "", author: c.author?.login ?? undefined }));
    },
    async createPhase(parent, title, body) {
      const url = await create(parent, title, body, ["--parent", parent.ref]);
      if (io.dry) return "";
      const n = /\/issues\/(\d+)\s*$/.exec(url)?.[1];
      if (!n) throw new Error(`gh issue create: unexpected output ${url.slice(0, 200)}`);
      return n;
    },
    createTicket: async (from, title, body) => (await create(from, title, body)).trim(),
    listPhases: async (parent) =>
      (JSON.parse(await read(io, ["gh", "api", `repos/${parent.repo}/issues/${parent.ref}/sub_issues?per_page=100`])) as any[]).map((i) => ({ ref: String(i.number), title: i.title })),
    setPhase: (parent, ref, status) =>
      write(io, status === "done" ? ["gh", "issue", "close", ref, "--repo", parent.repo!] : ["gh", "issue", "edit", ref, "--repo", parent.repo!, "--add-label", l.inProgressLabel]).then(() => {}),
  };
}

/** The ticket's open or merged PR, recorded in `<dir>/<ID>.pr` for status. */
export async function findPr(repo: string, id: string, io: Io, dir: string): Promise<string | undefined> {
  const prs: any[] = JSON.parse(await read(io, ["gh", "pr", "list", "--repo", repo, "--head", `agent/${id}`, "--state", "all", "--json", "url,state"]));
  const url: string | undefined = prs.find((p) => p.state !== "CLOSED")?.url;
  const f = join(dir, `${id}.pr`);
  if (url && (!existsSync(f) || readFileSync(f, "utf8") !== url)) put(io, f, url);
  return url;
}
