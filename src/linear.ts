import type { Io, Source, Ticket, Tracker } from "./types";
import { hasLabel, ours } from "./util";

const REPO_LINE = /^repo:[ \t]*([^\r\n]*?)[ \t\r]*$/im;

const repoLabel = (labels: string[]) => labels.find((x) => /^repo:/i.test(x))?.slice(5).trim();
const repoLine = (t?: string | null) => REPO_LINE.exec(t ?? "")?.[1];

/** Untrusted repo string: ticket `repo:` label, `repo:` line in the description, project `repo:` label, then project summary and overview lines. */
export function linearRepo(labels: string[], texts: (string | null | undefined)[], projectLabels: string[] = []) {
  return repoLabel(labels) ?? repoLine(texts[0]) ?? repoLabel(projectLabels) ?? texts.slice(1).map(repoLine).find((x) => x !== undefined);
}

// A label inside a Linear label group is named `<group>:<name>`, so a `repo` group holding `owner/name` reads `repo:owner/name`.
const labelNames = (c: any): string[] => (c?.nodes ?? []).map((x: any) => (x.parent?.name ? `${x.parent.name}:${x.name}` : x.name));

export const LINEAR_ISSUES = `query($f: IssueFilter) { issues(filter: $f, first: 100) { nodes { id identifier title description url priority labels { nodes { name parent { name } } } project { description content labels { nodes { name parent { name } } } } } } }`;

export function linearTicket(i: any): Ticket {
  const labels = labelNames(i.labels);
  const repo = linearRepo(labels, [i.description, i.project?.description, i.project?.content], labelNames(i.project?.labels));
  const priority = [1, 2, 3, 4].includes(i.priority) ? i.priority : undefined;
  return { id: i.identifier, ref: i.id, title: i.title ?? "", body: i.description ?? "", url: i.url ?? "", labels, repo, priority };
}

export function linear(l: Source, host: string, io: Io, defaultHost = false): Tracker {
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
  const list = async (state: string, labels: string[]): Promise<Ticket[]> => {
    const filter = { team: { key: { eq: l.team } }, state: { name: { eq: state } }, and: labels.map((n) => ({ labels: { some: { name: { eq: n } } } })) };
    const d = await gql(LINEAR_ISSUES, { f: filter });
    return d.issues.nodes.filter((i: any) => /^[A-Z0-9]+-\d+$/.test(i.identifier)).map(linearTicket);
  };
  const comment = async (t: Ticket, body: string) => {
    await gql(`mutation($i: CommentCreateInput!) { commentCreate(input: $i) { success } }`, { i: { issueId: t.ref, body: `aw: ${body}` } }, true);
  };
  const move = async (ref: string, state: string) => {
    await gql(`mutation($id: String!, $s: String!) { issueUpdate(id: $id, input: { stateId: $s }) { success } }`, { id: ref, s: await stateId(state) }, true);
  };
  const create = async (input: object): Promise<{ id: string; url: string }> => {
    const todo = await stateId(l.todo);
    const d = await gql(`mutation($i: IssueCreateInput!) { issueCreate(input: $i) { issue { id url } } }`, { i: { teamId, stateId: todo, ...input } }, true);
    if (io.dry) return { id: "", url: "" };
    const i = d.issueCreate?.issue;
    if (typeof i?.id !== "string" || !i.id) throw new Error("linear issueCreate: no id returned");
    return { id: i.id, url: typeof i.url === "string" ? i.url : i.id };
  };
  const hostLabel = `host:${host}`;
  const listMine = (state: string, labels: string[]) => defaultHost ? list(state, labels).then((r) => r.filter((t) => ours(t, host, true))) : list(state, [...labels, hostLabel]);
  return {
    listReady: async () => (await listMine(l.todo, [l.readyLabel])).filter((t) => !hasLabel(t.labels, l.needsHumanLabel)),
    listInProgress: () => listMine(l.inProgress, [l.readyLabel]),
    listInReview: () => listMine(l.inReview, [l.readyLabel]),
    async closed(id) {
      const st = (await gql(`query($id: String!) { issue(id: $id) { state { name type } } }`, { id })).issue?.state;
      return st?.type === "canceled" || st?.type === "duplicate" ? "canceled" : l.done.includes(st?.name) ? "done" : undefined;
    },
    async claim(t) {
      await move(t.ref, l.inProgress);
      await comment(t, `picked up on ${host}`);
    },
    async toReview(t, prUrl) {
      await move(t.ref, l.inReview);
      await comment(t, `PR: ${prUrl}`);
    },
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
