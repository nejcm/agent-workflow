import { canonical, sameRepo } from "../github";
import type { Check, GitHubSource, Io, Ticket, Tracker } from "../types";
import { hasLabel, labelPriority, nonEmpty, ours, read, write } from "../util";

export function parseGitHub(r: Record<string, any>, at: string, check: Check) {
  const s = { inProgressLabel: r.inProgressLabel ?? "in-progress", inReviewLabel: r.inReviewLabel ?? "in-review" };
  for (const [k, v] of Object.entries(s)) check(nonEmpty(v), `${at}.${k}: non-empty string`);
  return s;
}

export function github(l: GitHubSource, host: string, io: Io, defaultHost: boolean, repos: string[]): Tracker {
  const hostLabel = `host:${host}`;
  const listMine = (labels: string[], search?: string) =>
    defaultHost ? list(labels, search).then((r) => r.filter((t) => ours(t, host, true))) : list([...labels, hostLabel], search);
  // A failed repo is left out; nothing treats a missing ticket as gone (cleanup asks `closed`, limits count windows).
  const list = async (labels: string[], search?: string): Promise<Ticket[]> => {
    const all: Ticket[] = [];
    for (const repo of repos) {
      const name = await canonical(io, repo);
      if (!name || !sameRepo(name, repo)) continue;
      const argv = ["gh", "issue", "list", "--repo", repo, "--state", "open", "--limit", "100"];
      for (const x of labels) argv.push("--label", x);
      if (search) argv.push("--search", search);
      let issues: any[];
      try {
        issues = JSON.parse(await read(io, [...argv, "--json", "number,title,body,url,labels"]));
      } catch (e) {
        io.log(`repo ${repo}: issue list failed, skipped: ${(e as Error).message}`);
        continue;
      }
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
    globalIds: false,
    restartHint: () => `remove the ${l.inProgressLabel} label`,
    describe: () => "github (all repos)",
    // Excluded server-side too: claimed tickets keep the ready label and would otherwise fill the 100 limit.
    listReady: async () => (await listMine([l.readyLabel], skip.map((x) => `-label:${JSON.stringify(x)}`).join(" "))).filter((t) => !skip.some((x) => hasLabel(t.labels, x))),
    listInProgress: () => listMine([l.readyLabel, l.inProgressLabel]),
    listInReview: () => listMine([l.readyLabel, l.inReviewLabel]),
    async closed(id, repo) {
      const n = /^gh-(\d+)$/.exec(id)?.[1];
      if (!n) throw new Error(`not a github ticket id: ${id}`);
      const r = await io.run(["gh", "issue", "view", n, "--repo", repo, "--json", "state,stateReason"]);
      // A deleted issue: gh's GraphQL lookup finds no issue in a repo it can resolve.
      if (r.code !== 0 && r.err.includes("Could not resolve to an issue or pull request")) return "canceled";
      if (r.code !== 0) throw new Error(`gh issue view: ${r.err.trim() || `exit ${r.code}`}`);
      const i = JSON.parse(r.out);
      if (i.state === "CLOSED") return ["NOT_PLANNED", "DUPLICATE"].includes(i.stateReason) ? "canceled" : "done";
    },
    async claim(t) {
      await edit(t, l.inProgressLabel);
      // Best-effort: once the ticket is in progress the claim has succeeded; a throw would only report it as failed.
      await comment(t, `picked up on ${host}`).catch((e) => io.log(`${t.id}: picked-up comment failed: ${e.message}`));
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
