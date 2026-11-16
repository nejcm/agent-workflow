import type { Check, Io, LinearSource, Ticket, Tracker } from "../types";
import { hasLabel, hasMarker, nonEmpty, ours } from "../util";

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
  const labelId = async (name: string) => {
    const q = `query($n: String!, $t: String!) { issueLabels(filter: { name: { eqIgnoreCase: $n }, or: [{ team: { key: { eq: $t } } }, { team: { null: true } }] }) { nodes { id parent { name } } } }`;
    const nodes: any[] = (await gql(q, { n: name, t: l.team })).issueLabels.nodes;
    // A grouped label lists as `<group>:<name>`, which the label checks would not match.
    const id = nodes.find((x) => !x.parent)?.id;
    if (!id) throw new Error(`linear label "${name}" ${nodes.length ? "is inside a label group; use an ungrouped label" : `not found in team ${l.team} or the workspace`}`);
    return id as string;
  };
  const projectOf = async (name: string) => {
    const nodes: any[] = (await gql(`query($n: String!) { projects(filter: { name: { eqIgnoreCase: $n } }) { nodes { id } } }`, { n: name })).projects.nodes;
    if (nodes.length !== 1) throw new Error(`linear project ${JSON.stringify(name)}: ${nodes.length} found, need exactly one`);
    return nodes[0].id as string;
  };
  const addLabel = async (t: Ticket, name: string) => {
    const d = await gql(`mutation($id: String!, $l: String!) { issueAddLabel(id: $id, labelId: $l) { success } }`, { id: t.ref, l: await labelId(name) }, true);
    if (!io.dry && !d.issueAddLabel?.success) throw new Error(`linear issueAddLabel: not successful for ${t.id}`);
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
      await comment(t, note).catch((e) => io.log(`${t.id}: status comment failed: ${e.message}`));
    },
    ...(l.readyToMerge && {
      async toReadyToMerge(t: Ticket, note: string) {
        await move(t.ref, l.readyToMerge!);
        await comment(t, note).catch((e) => io.log(`${t.id}: status comment failed: ${e.message}`));
      },
    }),
    done: (t) => move(t.ref, l.done[0]!),
    park: (t) => addLabel(t, l.needsHumanLabel),
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
    async fileTicket(target, title, description, labels) {
      const projectId = target.project === undefined ? undefined : await projectOf(target.project);
      const labelIds = await Promise.all(labels.map(labelId));
      return (await create({ title, description, ...(projectId && { projectId }), ...(labelIds.length && { labelIds }) })).url;
    },
    async findMarker(_target, marker) {
      const q = `query($t: String!, $m: String!) { issues(filter: { team: { key: { eq: $t } }, description: { contains: $m } }, first: 100, includeArchived: true) { nodes { url description } pageInfo { hasNextPage } } }`;
      const { nodes, pageInfo } = (await gql(q, { t: l.team, m: marker })).issues;
      const url = nodes.find((i: any) => typeof i.description === "string" && hasMarker(i.description, marker))?.url;
      if (!url && pageInfo?.hasNextPage) throw new Error(`linear: over 100 issues mention ${marker}, none exactly; cannot rule out a duplicate`);
      return url;
    },
    // Label first: a ticket back in Todo that still had it could be claimed before the removal lands.
    async reopen(t) {
      const d = await gql(`mutation($id: String!, $l: String!) { issueRemoveLabel(id: $id, labelId: $l) { success } }`, { id: t.ref, l: await labelId(l.readyLabel) }, true);
      if (!io.dry && !d.issueRemoveLabel?.success) throw new Error(`linear issueRemoveLabel: not successful for ${t.id}`);
      await move(t.ref, l.todo);
    },
    async view(t) {
      const i = (await gql(`query($id: String!) { issue(id: $id) { title description trashed state { type } labels { nodes { name parent { name } } } } }`, { id: t.ref })).issue;
      if (!i) throw new Error(`linear issue ${t.id} not found`);
      return { title: String(i.title ?? ""), body: String(i.description ?? ""), labels: labelNames(i.labels), open: !i.trashed && !["completed", "canceled", "duplicate"].includes(i.state?.type) };
    },
    async addLabels(t, labels) {
      for (const x of labels) await addLabel(t, x);
    },
    listPhases: async (parent) =>
      (await gql(`query($id: String!) { issue(id: $id) { children(first: 100) { nodes { id title } } } }`, { id: parent.ref })).issue.children.nodes.map((i: any) => ({ ref: i.id, title: i.title })),
    setPhase: (_parent, ref, status) => move(ref, status === "done" ? l.done[0]! : l.inProgress),
  };
}
