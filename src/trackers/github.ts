import { canonical, sameRepo } from "../github";
import type { Check, GitHubSource, Io, Ticket, Tracker } from "../types";
import { hasLabel, labelPriority, nonEmpty, ours, read, write } from "../util";

export function parseGitHub(r: Record<string, any>, at: string, check: Check) {
  const s = { inProgressLabel: r.inProgressLabel ?? "in-progress", inReviewLabel: r.inReviewLabel ?? "in-review", readyToMergeLabel: r.readyToMergeLabel ?? "ready-to-merge" };
  for (const [k, v] of Object.entries(s)) check(nonEmpty(v), `${at}.${k}: non-empty string`);
  return s;
}

export function github(l: GitHubSource, host: string, io: Io, defaultHost: boolean, repos: string[]): Tracker {
  const hostLabel = `host:${host}`;
  let login: Promise<string> | undefined;
  const viewer = () =>
    (login ??= read(io, ["gh", "api", "user", "--jq", ".login"]).then((x) => {
      if (!x.trim()) throw new Error("gh api user: no login");
      return x.trim().toLowerCase();
    }));
  // GitHub allows several assignees: a ticket is someone else's only while the tender user is not among them.
  const otherAssignee = async (logins: string[]) => (logins.length && !logins.map((x) => x.toLowerCase()).includes(await viewer()) ? logins.join(", ") : undefined);
  const listMine = (labels: string[], search?: string, complete = false) =>
    defaultHost ? list(labels, search, complete).then((r) => r.filter((t) => ours(t, host, true))) : list([...labels, hostLabel], search, complete);
  // A failed repo is left out; nothing treats a missing ticket as gone (cleanup asks `closed`, limits count windows).
  const list = async (labels: string[], search?: string, complete = false): Promise<Ticket[]> => {
    const all: Ticket[] = [];
    for (const repo of repos) {
      const name = await canonical(io, repo);
      if (!name && complete) throw new Error(`repo ${repo}: lookup failed`);
      if (!name || !sameRepo(name, repo)) continue;
      const argv = ["gh", "issue", "list", "--repo", repo, "--state", "open", "--limit", "100"];
      for (const x of labels) argv.push("--label", x);
      if (search) argv.push("--search", search);
      let issues: any[];
      try {
        issues = JSON.parse(await read(io, [...argv, "--json", "number,title,body,url,labels,assignees"]));
      } catch (e) {
        if (complete) throw e;
        io.log(`repo ${repo}: issue list failed, skipped: ${(e as Error).message}`);
        continue;
      }
      if (complete && issues.length >= 100) throw new Error(`repo ${repo}: 100 issues listed, the rest unknown`);
      for (const i of issues)
        if (Number.isInteger(i.number)) {
          const labels: string[] = (i.labels ?? []).map((x: any) => x.name);
          const assignees = (i.assignees ?? []).map((x: any) => String(x.login));
          all.push({ id: `gh-${i.number}`, ref: String(i.number), title: i.title ?? "", body: i.body ?? "", url: i.url ?? "", labels, repo, priority: labelPriority(labels), otherAssignee: await otherAssignee(assignees) });
        }
    }
    return all;
  };
  const skip = [l.inProgressLabel, l.inReviewLabel, l.readyToMergeLabel, l.needsHumanLabel];
  const edit = (t: Ticket, add: string, ...more: string[]) => write(io, ["gh", "issue", "edit", t.ref, "--repo", t.repo!, "--add-label", add, ...more]);
  const create = (t: Ticket, title: string, body: string, extra: string[] = []) => write(io, ["gh", "issue", "create", "--repo", t.repo!, ...extra, "--title", title, "--body", body]);
  const comment = async (t: Ticket, body: string) => { await write(io, ["gh", "issue", "comment", t.ref, "--repo", t.repo!, "--body", `tender: ${body}`]); };
  return {
    globalIds: false,
    restartHint: () => `remove the ${l.inProgressLabel} label`,
    describe: () => "github (all repos)",
    // Excluded server-side too: claimed tickets keep the ready label and would otherwise fill the 100 limit.
    listReady: async () => (await listMine([l.readyLabel], skip.map((x) => `-label:${JSON.stringify(x)}`).join(" "))).filter((t) => !skip.some((x) => hasLabel(t.labels, x))),
    listInProgress: () => listMine([l.readyLabel, l.inProgressLabel]),
    // A ticket with both labels counts as Ready to merge.
    listInReview: async (complete) => [
      ...(await listMine([l.readyLabel, l.inReviewLabel], undefined, complete)).filter((t) => !hasLabel(t.labels, l.readyToMergeLabel)),
      ...(await listMine([l.readyLabel, l.readyToMergeLabel], undefined, complete)).map((t) => ({ ...t, readyToMerge: true })),
    ],
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
      await edit(t, l.inProgressLabel, "--add-assignee", "@me");
      // Best-effort: once the ticket is in progress the claim has succeeded; a throw would only report it as failed.
      await comment(t, `picked up on ${host}`).catch((e) => io.log(`${t.id}: picked-up comment failed: ${e.message}`));
    },
    async toReview(t, note) {
      await edit(t, l.inReviewLabel, "--remove-label", t.readyToMerge ? l.readyToMergeLabel : l.inProgressLabel);
      await comment(t, note);
    },
    async toReadyToMerge(t, note) {
      await edit(t, l.readyToMergeLabel, "--remove-label", l.inReviewLabel);
      await comment(t, note);
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
