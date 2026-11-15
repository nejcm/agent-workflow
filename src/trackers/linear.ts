import type { Check, Io, LinearSource, Ticket, Tracker } from "../types";
import { hasLabel, nonEmpty, ours } from "../util";

export function parseLinear(r: Record<string, any>, at: string, check: Check) {
  const s = { team: r.team, todo: r.todo ?? "Todo", inProgress: r.inProgress ?? "In Progress", inReview: r.inReview ?? "In Review", readyToMerge: r.readyToMerge, done: r.done ?? ["Done"] };
  for (const k of ["todo", "inProgress", "inReview"] as const) check(nonEmpty(s[k]), `${at}.${k}: non-empty string`);
  check(s.readyToMerge === undefined || nonEmpty(s.readyToMerge), `${at}.readyToMerge: non-empty string`);
  check(Array.isArray(s.done) && s.done.length > 0 && s.done.every(nonEmpty), `${at}.done: non-empty string array`);
  check(/^[A-Z0-9]+$/.test(s.team ?? ""), `${at}.team: Linear team key, e.g. ENG`);
  return s;
}

const REPO_LINE = /^repo:[ \t]*([^\r\n]*?)[ \t\r]*$/im;

const repoLabel = (labels: string[]) => labels.find((x) => /^repo:/i.test(x))?.slice(5).trim();
const repoLine = (t?: string | null) => REPO_LINE.exec(t ?? "")?.[1];

/** Untrusted repo string named by the ticket itself: its `repo:` label, else the first `repo:` line of its description. */
export const linearRepo = (labels: string[], description?: string | null) => repoLabel(labels) ?? repoLine(description);

/** A repo's `tracker.linear` from its `.tender/config.yaml`. */
export type ProjectClaim = { repo: string; project: string; team?: string };

// Project id to the claim it last resolved to alone, so a project renamed in Linear keeps its repo.
// shortcut: in memory, so a rename is forgotten on restart; persist it if that bites.
const knownIds = new Map<string, ProjectClaim>();
const logged = new Set<string>();

/** The repo whose config claims project `p`: the one it resolved to before while that repo still claims it, else by name (case-insensitive); none if two repos claim it. */
export function projectRepo(claims: ProjectClaim[], team: string, p: { id: string; name?: string }, log: (m: string) => void) {
  const once = (key: string, msg: string) => {
    if (!logged.has(key)) log(msg);
    logged.add(key);
  };
  const known = knownIds.get(p.id);
  const name = typeof p.name === "string" ? p.name.toLowerCase() : undefined;
  const hits = claims.filter((c) => c.project.toLowerCase() === name || (c.repo === known?.repo && c.project.toLowerCase() === known.project.toLowerCase()));
  const repos = hits.map((h) => h.repo).join(", ");
  if (hits.length > 1) once(`${p.id} ${repos}`, `linear project ${JSON.stringify(String(p.name).slice(0, 100))} is claimed by ${repos}; its tickets need a repo: label or description line`);
  const hit = hits[0];
  if (!hit || hits.length > 1) return;
  knownIds.set(p.id, hit);
  if (hit.team && hit.team !== team) once(`${p.id} ${hit.repo} ${team}`, `linear project ${JSON.stringify(hit.project)} is claimed by ${hit.repo} for team ${hit.team}, but routes a ${team} ticket`);
  return hit.repo;
}

// A label inside a Linear label group is named `<group>:<name>`, so a `repo` group holding `owner/name` reads `repo:owner/name`.
const labelNames = (c: any): string[] => (c?.nodes ?? []).map((x: any) => (x.parent?.name ? `${x.parent.name}:${x.name}` : x.name));

export const LINEAR_ISSUES = `query($f: IssueFilter) { issues(filter: $f, first: 100) { nodes { id identifier title description url priority labels { nodes { name parent { name } } } project { id name } assignee { id name } } } }`;

export function linearTicket(i: any): Ticket {
  const labels = labelNames(i.labels);
  const priority = [1, 2, 3, 4].includes(i.priority) ? i.priority : undefined;
  return { id: i.identifier, ref: i.id, title: i.title ?? "", body: i.description ?? "", url: i.url ?? "", labels, repo: linearRepo(labels, i.description), priority };
}

export function linear(l: LinearSource, host: string, io: Io, defaultHost = false, _repos: string[] = [], claims: () => Promise<ProjectClaim[]> = async () => []): Tracker {
  const gql = async (query: string, variables: object, mutate = false) => {
    if (mutate) io.log(`${io.dry ? "dry: " : ""}linear ${/\{\s*(\w+)/.exec(query)?.[1]} ${JSON.stringify(variables)}`);
    if (mutate && io.dry) return {};
    const key = process.env.LINEAR_API_KEY;
    if (!key) throw new Error("LINEAR_API_KEY not set");
    const r = await io.fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query, variables }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || j.errors) throw new Error(`linear ${r.status}: ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
    return j.data;
  };
  let states: Map<string, string> | undefined;
  let teamId = "";
  const stateId = async (name: string) => {
    if (!states) {
      const nodes = (await gql(`query($t: String!) { workflowStates(filter: { team: { key: { eq: $t } } }) { nodes { id name team { id } } } }`, { t: l.team })).workflowStates.nodes;
      states = new Map(nodes.map((s: any) => [s.name, s.id]));
      teamId = nodes[0]?.team?.id ?? "";
    }
    const id = states!.get(name);
    if (!id) throw new Error(`linear state "${name}" not found in team ${l.team}`);
    return id;
  };
  let me: Promise<string> | undefined;
  const viewer = () =>
    (me ??= gql(`query { viewer { id } }`, {}).then((d) => {
      if (typeof d?.viewer?.id !== "string" || !d.viewer.id) throw new Error("linear viewer: no id");
      return d.viewer.id;
    }));
  const unrouted = new WeakSet<Ticket>();
  const list = async (state: string, labels: string[], complete = false): Promise<Ticket[]> => {
    const filter = { team: { key: { eq: l.team } }, state: { name: { eq: state } }, and: labels.map((n) => ({ labels: { some: { name: { eq: n } } } })) };
    const d = await gql(LINEAR_ISSUES, { f: filter });
    if (complete && d.issues.nodes.length >= 100) throw new Error(`linear ${l.team} ${state}: 100 issues listed, the rest unknown`);
    const nodes = d.issues.nodes.filter((i: any) => /^[A-Z0-9]+-\d+$/.test(i.identifier));
    return Promise.all(
      nodes.map(async (i: any) => {
        const t = linearTicket(i);
        if (typeof i.assignee?.id === "string" && i.assignee.id !== (await viewer())) t.otherAssignee = String(i.assignee.name || i.assignee.id);
        if (t.repo === undefined && typeof i.project?.id === "string")
          t.repo = await claims().then(
            (c) => projectRepo(c, l.team, i.project, io.log),
            (e) => {
              if (complete) throw e;
              return void unrouted.add(t);
            },
          );
        return t;
      }),
    );
  };
  const comment = async (t: Ticket, body: string) => {
    const d = await gql(`mutation($i: CommentCreateInput!) { commentCreate(input: $i) { success } }`, { i: { issueId: t.ref, body: `tender: ${body}` } }, true);
    if (!io.dry && !d.commentCreate?.success) throw new Error(`linear commentCreate: not successful for ${t.id}`);
  };
  const move = async (ref: string, state: string, more: object = {}) => {
    const d = await gql(`mutation($id: String!, $i: IssueUpdateInput!) { issueUpdate(id: $id, input: $i) { success } }`, { id: ref, i: { stateId: await stateId(state), ...more } }, true);
    if (!io.dry && !d.issueUpdate?.success) throw new Error(`linear issueUpdate: not successful for ${ref}`);
  };
  const create = async (input: object): Promise<{ id: string; url: string }> => {
    const todo = await stateId(l.todo);
    const d = await gql(`mutation($i: IssueCreateInput!) { issueCreate(input: $i) { issue { id url } } }`, { i: { teamId, stateId: todo, ...input } }, true);
    if (io.dry) return { id: "", url: "" };
    const i = d.issueCreate?.issue;
    if (typeof i?.id !== "string" || !i.id) throw new Error("linear issueCreate: no id returned");
    return { id: i.id, url: i.url };
  };
  const hostLabel = `host:${host}`;
  const listMine = (state: string, labels: string[], complete = false) => defaultHost ? list(state, labels, complete).then((r) => r.filter((t) => ours(t, host, true))) : list(state, [...labels, hostLabel], complete);
  return {
    globalIds: true,
    restartHint: () => `move it to ${l.todo}`,
    describe: () => `linear ${l.team}`,
    // Unrouted: some repo's claims could not be read, so the ticket waits rather than start elsewhere or be rejected.
    listReady: async () => (await listMine(l.todo, [l.readyLabel])).filter((t) => !hasLabel(t.labels, l.needsHumanLabel) && !unrouted.has(t)),
    listInProgress: () => listMine(l.inProgress, [l.readyLabel]),
    listInReview: async (complete) => [
      ...(await listMine(l.inReview, [l.readyLabel], complete)),
      ...(l.readyToMerge ? (await listMine(l.readyToMerge, [l.readyLabel], complete)).map((t) => ({ ...t, readyToMerge: true })) : []),
    ],
    async closed(id) {
      const i = (await gql(`query($id: String!) { issue(id: $id) { trashed state { name type } } }`, { id })).issue;
      if (!i || i.trashed) return "canceled";
      const st = i.state;
      return st?.type === "canceled" || st?.type === "duplicate" ? "canceled" : l.done.includes(st?.name) ? "done" : undefined;
    },
    async claim(t) {
      await move(t.ref, l.inProgress, { assigneeId: await viewer() });
      // Best-effort: once the ticket is in progress the claim has succeeded; a throw would only report it as failed.
      await comment(t, `picked up on ${host}`).catch((e) => io.log(`${t.id}: picked-up comment failed: ${e.message}`));
    },
    async toReview(t, note) {
      await move(t.ref, l.inReview);
      await comment(t, note);
    },
    ...(l.readyToMerge && {
      async toReadyToMerge(t: Ticket, note: string) {
        await move(t.ref, l.readyToMerge!);
        await comment(t, note);
      },
    }),
    done: (t) => move(t.ref, l.done[0]!),
    async park(t) {
      const q = `query($n: String!, $t: String!) { issueLabels(filter: { name: { eqIgnoreCase: $n }, or: [{ team: { key: { eq: $t } } }, { team: { null: true } }] }) { nodes { id parent { name } } } }`;
      const nodes: any[] = (await gql(q, { n: l.needsHumanLabel, t: l.team })).issueLabels.nodes;
      // A grouped label lists as `<group>:<name>`, which the parked checks would not match.
      const id = nodes.find((x) => !x.parent)?.id;
      if (!id) throw new Error(`linear label "${l.needsHumanLabel}" ${nodes.length ? "is inside a label group; use an ungrouped label" : `not found in team ${l.team} or the workspace`}`);
      const d = await gql(`mutation($id: String!, $l: String!) { issueAddLabel(id: $id, labelId: $l) { success } }`, { id: t.ref, l: id }, true);
      if (!io.dry && !d.issueAddLabel?.success) throw new Error(`linear issueAddLabel: not successful for ${t.id}`);
    },
    parked: async (t) =>
      hasLabel(labelNames((await gql(`query($id: String!) { issue(id: $id) { labels { nodes { name parent { name } } } } }`, { id: t.ref })).issue?.labels), l.needsHumanLabel),
    comment,
    // Callers treat the list as complete, so past 20 pages it throws rather than return part of it.
    async comments(t, since) {
      const q = `query($id: String!, $since: DateTimeOrDuration!, $after: String) { issue(id: $id) { comments(filter: { createdAt: { gt: $since } }, first: 100, after: $after) { nodes { id body createdAt user { email } } pageInfo { hasNextPage endCursor } } } }`;
      const nodes: any[] = [];
      for (let page = 0, after: string | null = null; page < 20; page++) {
        const c: any = (await gql(q, { id: t.ref, since: new Date(since).toISOString(), after })).issue?.comments;
        nodes.push(...(c?.nodes ?? []));
        if (!c?.pageInfo?.hasNextPage) return nodes.map((c: any) => ({ id: String(c.id), body: c.body ?? "", createdAt: c.createdAt ?? "", author: c.user?.email ?? undefined }));
        after = c.pageInfo.endCursor;
      }
      throw new Error(`linear comments: more than 2000 on ${t.id}`);
    },
    createPhase: async (parent, title, description) => (await create({ parentId: parent.ref, title, description })).id,
    createTicket: async (_from, title, description) => (await create({ title, description })).url,
    listPhases: async (parent) =>
      (await gql(`query($id: String!) { issue(id: $id) { children(first: 100) { nodes { id title } } } }`, { id: parent.ref })).issue.children.nodes.map((i: any) => ({ ref: i.id, title: i.title })),
    setPhase: (_parent, ref, status) => move(ref, status === "done" ? l.done[0]! : l.inProgress),
  };
}
