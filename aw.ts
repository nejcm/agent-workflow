#!/usr/bin/env bun
import { chmodSync, closeSync, constants as C, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface Repo {
  key: string;
  path: string;
  baseBranch: string;
  agent: "claude" | "codex";
  sandbox: "nono" | "none";
  testCmd: string;
  prompt: string;
  maxConcurrent?: number;
}

export interface Source {
  name: string;
  tracker: "github" | "linear";
  readyLabel: string;
  inProgressLabel: string;
  inReviewLabel: string;
  team: string;
  todo: string;
  inProgress: string;
  inReview: string;
  done: string[];
}

export interface Config {
  host: string;
  defaultHost: boolean;
  pollIntervalMs: number;
  workspaceRoot: string;
  reposRoot: string;
  tmuxSession: string;
  maxConcurrent: number;
  repos: Record<string, Repo>;
  sources: Source[];
}

export interface Ticket {
  id: string;
  ref: string;
  title: string;
  body: string;
  url: string;
  labels?: string[];
  /** GitHub: the allowlisted repo it was listed from. Linear: the untrusted resolved string, if any. */
  repo?: string;
}

export interface Tracker {
  listReady(): Promise<Ticket[]>;
  listInProgress(): Promise<Ticket[]>;
  listInReview(): Promise<Ticket[]>;
  isDone(id: string, repo: string): Promise<boolean>;
  claim(t: Ticket): Promise<void>;
  toReview(t: Ticket, prUrl: string): Promise<void>;
  comment(t: Ticket, body: string): Promise<void>;
  /** Creates a sub-ticket of `parent` with no labels; returns its ref ("" in dry-run). */
  createPhase(parent: Ticket, title: string, body: string): Promise<string>;
  listPhases(parent: Ticket): Promise<{ ref: string; title: string }[]>;
  setPhase(parent: Ticket, ref: string, status: "in-progress" | "done"): Promise<void>;
}

export type Run = (argv: string[], cwd?: string) => Promise<{ code: number; out: string; err: string }>;

export interface Io {
  run: Run;
  fetch: typeof fetch;
  dry: boolean;
  log: (msg: string) => void;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const AW_DIR = import.meta.dir;

// Owner may not start with "-" (flag to gh/git) or "." (aw's own dirs in workspaceRoot); keys map 1:1 to <owner>/<name> dirs.
const REPO = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/;
export const validRepo = (s: unknown) => typeof s === "string" && REPO.test(s) && !s.includes("..") && !s.endsWith("/.") && !/\.git$/i.test(s);
/** Canonical allowlist key for an untrusted repo string, or undefined. */
export const allowedRepo = (cfg: Config, raw: unknown) => (validRepo(raw) ? Object.keys(cfg.repos).find((k) => k.toLowerCase() === (raw as string).toLowerCase()) : undefined);
const LANE_KEYS = ["repo", "repoPath", "baseBranch", "agent", "sandbox", "maxConcurrent", "testCmd", "prompt"];

const expand = (p: string, base: string) => resolve(base, p.replace(/^~(?=$|\/)/, homedir()));

export function parseConfig(raw: any, base: string): Config {
  const errs: string[] = [];
  const check = (ok: unknown, msg: string) => ok || errs.push(msg);
  const str = (v: unknown) => typeof v === "string" && v.length > 0;
  const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
  const posInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
  check(obj(raw), "config must be a JSON object");
  raw = obj(raw) ? raw : {};
  check(str(raw.host) && /^[A-Za-z0-9._-]+$/.test(raw.host), "host: required, [A-Za-z0-9._-]");
  const defaultHost = raw.defaultHost ?? false;
  check(typeof defaultHost === "boolean", "defaultHost: boolean");
  const pollIntervalMs = raw.pollIntervalMs ?? 60000;
  check(Number.isInteger(pollIntervalMs) && pollIntervalMs >= 5000, "pollIntervalMs: integer >= 5000");
  const tmuxSession = raw.tmuxSession ?? "aw";
  check(NAME.test(tmuxSession), "tmuxSession: [a-z0-9-]");
  const maxConcurrent = raw.maxConcurrent ?? 2;
  check(posInt(maxConcurrent), "maxConcurrent: positive integer");
  const reposRoot = expand(raw.reposRoot ?? "~/agent-repos", base);
  check(raw.lanes === undefined, "lanes: replaced by sources + repos + defaults (see README)");
  const defaults = raw.defaults ?? {};
  check(obj(defaults) && defaults.path === undefined, "defaults: object without path");

  const shape = `array of "owner/name" or { "name": "owner/name", …overrides }`;
  check(!obj(raw.repos), `repos: now an ${shape}; move each "owner/name": {…} entry to { "name": "owner/name", … } (see README)`);
  check(obj(raw.repos) || (Array.isArray(raw.repos) && raw.repos.length > 0), `repos: non-empty ${shape}`);
  const repos: Record<string, Repo> = {};
  const keys: string[] = [];
  for (const [i, e] of (Array.isArray(raw.repos) ? raw.repos : []).entries()) {
    const { name: key, ...o } = typeof e === "string" ? { name: e } : obj(e) ? e : { name: undefined };
    check(typeof e === "string" || obj(e), `repos[${i}]: ${shape}`);
    check(validRepo(key), `repos[${i}]${typeof e === "string" ? "" : ".name"}: must be "owner/name"`);
    if (!validRepo(key)) continue;
    const at = `repos[${i}] (${key})`;
    const v = { ...(obj(defaults) ? defaults : {}), ...o };
    for (const k of ["path", "baseBranch", "prompt"]) check(v[k] === undefined || str(v[k]), `${at}.${k}: non-empty string`);
    const r: Repo = {
      key,
      path: str(v.path) ? expand(v.path, base) : join(reposRoot, key),
      baseBranch: str(v.baseBranch) ? v.baseBranch : "main",
      agent: v.agent,
      sandbox: v.sandbox,
      testCmd: v.testCmd,
      prompt: expand(str(v.prompt) ? v.prompt : join(AW_DIR, "prompts/default.md"), base),
      maxConcurrent: v.maxConcurrent,
    };
    check(/^[\w./-]+$/.test(r.baseBranch) && !r.baseBranch.includes(".."), `${at}.baseBranch: invalid`);
    check(["claude", "codex"].includes(r.agent), `${at}.agent: "claude" | "codex" (here or in defaults)`);
    check(["nono", "none"].includes(r.sandbox), `${at}.sandbox: "nono" | "none" (here or in defaults)`);
    check(str(r.testCmd), `${at}.testCmd: required (here or in defaults)`);
    check(r.maxConcurrent === undefined || posInt(r.maxConcurrent), `${at}.maxConcurrent: positive integer`);
    check(existsSync(r.prompt), `${at}.prompt: ${r.prompt} not found`);
    repos[key] = r;
    keys.push(key);
  }
  check(new Set(keys.map((k) => k.toLowerCase())).size === keys.length, "repos: names must be unique ignoring case");
  check(new Set(Object.values(repos).map((r) => r.path)).size === keys.length, "repos: paths must be unique");

  check(Array.isArray(raw.sources) && raw.sources.length > 0, "sources: non-empty array required");
  const sources: Source[] = (Array.isArray(raw.sources) ? raw.sources : []).map((r: any, i: number) => {
    const at = `sources[${i}]${str(r?.name) ? ` (${r.name})` : ""}`;
    r = obj(r) ? r : {};
    for (const k of LANE_KEYS) check(r[k] === undefined, `${at}.${k}: moved to repos / defaults`);
    check(r.repos === undefined, `${at}.repos: removed; a GitHub source polls every repo in repos`);
    const s: Source = {
      name: r.name,
      tracker: r.tracker,
      readyLabel: r.readyLabel ?? "agent",
      inProgressLabel: r.inProgressLabel ?? "in-progress",
      inReviewLabel: r.inReviewLabel ?? "in-review",
      team: r.team,
      todo: r.todo ?? "Todo",
      inProgress: r.inProgress ?? "In Progress",
      inReview: r.inReview ?? "In Review",
      done: r.done ?? ["Done", "Canceled", "Duplicate"],
    };
    check(NAME.test(s.name ?? ""), `${at}.name: required, [a-z0-9-]`);
    check(["github", "linear"].includes(s.tracker), `${at}.tracker: "github" | "linear"`);
    for (const k of ["readyLabel", "inProgressLabel", "inReviewLabel", "todo", "inProgress", "inReview"] as const)
      check(str(s[k]), `${at}.${k}: non-empty string`);
    check(Array.isArray(s.done) && s.done.length > 0 && s.done.every(str), `${at}.done: non-empty string array`);
    if (s.tracker === "linear") check(/^[A-Z0-9]+$/.test(s.team ?? ""), `${at}.team: Linear team key, e.g. ENG`);
    return s;
  });
  const names = sources.map((s) => s.name);
  check(new Set(names).size === names.length, "source names must be unique");
  if (errs.length) throw new Error(`invalid config:\n  ${errs.join("\n  ")}`);
  return { host: raw.host, defaultHost, pollIntervalMs, workspaceRoot: expand(raw.workspaceRoot ?? "~/agent-ws", base), reposRoot, tmuxSession, maxConcurrent, repos, sources };
}

async function read(io: Io, argv: string[], cwd?: string) {
  const r = await io.run(argv, cwd);
  if (r.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")}: ${r.err.trim() || `exit ${r.code}`}`);
  return r.out;
}

async function write(io: Io, argv: string[], cwd?: string) {
  io.log(`${io.dry ? "dry: " : ""}${argv.join(" ")}`);
  return io.dry ? "" : read(io, argv, cwd);
}

function put(io: Io, path: string, data: string, mode = 0o644) {
  io.log(`${io.dry ? "dry: " : ""}write ${path}`);
  if (io.dry) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, data);
  chmodSync(`${path}.tmp`, mode);
  renameSync(`${path}.tmp`, path);
}

// <wt>/.aw is agent-writable: pin it by fd (no symlink) so a swap can't redirect aw outside the worktree. Linux only.
function inAw<T>(wt: string, fn: (dir: string) => T): T {
  const d = openSync(join(wt, ".aw"), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try {
    return fn(`/proc/self/fd/${d}`);
  } finally {
    closeSync(d);
  }
}

function remove(io: Io, path: string) {
  if (!existsSync(path)) return;
  io.log(`${io.dry ? "dry: " : ""}rm ${path}`);
  if (!io.dry) rmSync(path);
}

// Ours if labelled host:<host>, or (defaultHost) if no host: label at all. Case-insensitive like GitHub's label filter.
const ours = (t: Ticket, host: string, defaultHost: boolean) => {
  const hosts = (t.labels ?? []).map((x) => x.toLowerCase()).filter((x) => x.startsWith("host:"));
  return hosts.includes(`host:${host.toLowerCase()}`) || (defaultHost && !hosts.length);
};

export const canonCache = new Map<string, { name: string; at: number }>();
const CANON_TTL_MS = 5 * 60_000;

// GitHub serves a renamed/transferred repo under its old name, so the allowlist is checked against the name it resolves to.
async function canonical(io: Io, key: string, fresh = false): Promise<string | undefined> {
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
const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

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
        if (Number.isInteger(i.number))
          all.push({ id: `gh-${i.number}`, ref: String(i.number), title: i.title ?? "", body: i.body ?? "", url: i.url ?? "", labels: (i.labels ?? []).map((x: any) => x.name), repo });
    }
    return all;
  };
  const skip = [l.inProgressLabel, l.inReviewLabel];
  const edit = (t: Ticket, add: string, rm?: string) => write(io, ["gh", "issue", "edit", t.ref, "--repo", t.repo!, "--add-label", add, ...(rm ? ["--remove-label", rm] : [])]);
  const comment = async (t: Ticket, body: string) => { await write(io, ["gh", "issue", "comment", t.ref, "--repo", t.repo!, "--body", body]); };
  return {
    // Excluded server-side too: claimed tickets keep the ready label and would otherwise fill the 100 limit.
    listReady: async () => (await listMine([l.readyLabel], skip.map((x) => `-label:${JSON.stringify(x)}`).join(" "))).filter((t) => !skip.some((x) => t.labels?.includes(x))),
    listInProgress: () => listMine([l.readyLabel, l.inProgressLabel]),
    listInReview: () => listMine([l.readyLabel, l.inReviewLabel]),
    async isDone(id, repo) {
      const n = /^gh-(\d+)$/.exec(id)?.[1];
      if (!n) throw new Error(`not a github ticket id: ${id}`);
      return JSON.parse(await read(io, ["gh", "issue", "view", n, "--repo", repo, "--json", "state"])).state === "CLOSED";
    },
    async claim(t) {
      await edit(t, l.inProgressLabel);
      await comment(t, `picked up on ${host}`);
    },
    async toReview(t, prUrl) {
      await edit(t, l.inReviewLabel, l.inProgressLabel);
      await comment(t, `PR: ${prUrl}`);
    },
    comment,
    async createPhase(parent, title, body) {
      const url = await write(io, ["gh", "issue", "create", "--repo", parent.repo!, "--parent", parent.ref, "--title", title, "--body", body]);
      if (io.dry) return "";
      const n = /\/issues\/(\d+)\s*$/.exec(url)?.[1];
      if (!n) throw new Error(`gh issue create: unexpected output ${url.slice(0, 200)}`);
      return n;
    },
    listPhases: async (parent) =>
      (JSON.parse(await read(io, ["gh", "api", `repos/${parent.repo}/issues/${parent.ref}/sub_issues?per_page=100`])) as any[]).map((i) => ({ ref: String(i.number), title: i.title })),
    setPhase: (parent, ref, status) =>
      write(io, status === "done" ? ["gh", "issue", "close", ref, "--repo", parent.repo!] : ["gh", "issue", "edit", ref, "--repo", parent.repo!, "--add-label", l.inProgressLabel]).then(() => {}),
  };
}

const REPO_LINE = /^repo:[ \t]*([^\r\n]*?)[ \t\r]*$/im;

/** Untrusted repo string for a Linear issue: `repo:` label, then a `repo:` line in the description, project summary, then project overview. */
export function linearRepo(labels: string[], texts: (string | null | undefined)[]) {
  const label = labels.find((x) => /^repo:/i.test(x));
  if (label !== undefined) return label.slice(5).trim();
  for (const t of texts) {
    const m = REPO_LINE.exec(t ?? "");
    if (m) return m[1];
  }
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
    const d = await gql(`query($f: IssueFilter) { issues(filter: $f, first: 100) { nodes { id identifier title description url labels { nodes { name } } project { description content } } } }`, { f: filter });
    return d.issues.nodes
      .filter((i: any) => /^[A-Z0-9]+-\d+$/.test(i.identifier))
      .map((i: any) => {
        const labels: string[] = (i.labels?.nodes ?? []).map((x: any) => x.name);
        const repo = linearRepo(labels, [i.description, i.project?.description, i.project?.content]);
        return { id: i.identifier, ref: i.id, title: i.title ?? "", body: i.description ?? "", url: i.url ?? "", labels, repo };
      });
  };
  const comment = async (t: Ticket, body: string) => {
    await gql(`mutation($i: CommentCreateInput!) { commentCreate(input: $i) { success } }`, { i: { issueId: t.ref, body } }, true);
  };
  const move = async (ref: string, state: string) => {
    await gql(`mutation($id: String!, $s: String!) { issueUpdate(id: $id, input: { stateId: $s }) { success } }`, { id: ref, s: await stateId(state) }, true);
  };
  const hostLabel = `host:${host}`;
  const listMine = (state: string, labels: string[]) => defaultHost ? list(state, labels).then((r) => r.filter((t) => ours(t, host, true))) : list(state, [...labels, hostLabel]);
  return {
    listReady: () => listMine(l.todo, [l.readyLabel]),
    listInProgress: () => listMine(l.inProgress, [l.readyLabel]),
    listInReview: () => listMine(l.inReview, [l.readyLabel]),
    async isDone(id) {
      const d = await gql(`query($id: String!) { issue(id: $id) { state { name } } }`, { id });
      return l.done.includes(d.issue?.state?.name);
    },
    async claim(t) {
      await move(t.ref, l.inProgress);
      await comment(t, `picked up on ${host}`);
    },
    async toReview(t, prUrl) {
      await move(t.ref, l.inReview);
      await comment(t, `PR: ${prUrl}`);
    },
    comment,
    async createPhase(parent, title, description) {
      const todo = await stateId(l.todo);
      const d = await gql(
        `mutation($i: IssueCreateInput!) { issueCreate(input: $i) { issue { id } } }`,
        { i: { teamId, parentId: parent.ref, stateId: todo, title, description } },
        true,
      );
      if (io.dry) return "";
      const id = d.issueCreate?.issue?.id;
      if (typeof id !== "string" || !id) throw new Error("linear issueCreate: no id returned");
      return id;
    },
    listPhases: async (parent) =>
      (await gql(`query($id: String!) { issue(id: $id) { children(first: 100) { nodes { id title } } } }`, { id: parent.ref })).issue.children.nodes.map((i: any) => ({ ref: i.id, title: i.title })),
    setPhase: (_parent, ref, status) => move(ref, status === "done" ? l.done[0]! : l.inProgress),
  };
}

export const render = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function launcher(l: Repo, t: Ticket, wt: string, promptFile: string, awDir = AW_DIR) {
  const prompt = `"$(cat ${q(promptFile)})"`;
  const nono = l.sandbox === "nono";
  const wrap = nono ? ["nono", "run", "--no-rollback-prompt", "--profile", q(join(awDir, "nono", `aw-${l.agent}.json`)), "--allow", q(wt), "--allow", q(join(l.path, ".git")), "--"] : [];
  const title = t.title.replace(/[^\w .,:()#-]/g, "").slice(0, 60).trim();
  const [env, cmd] =
    l.agent === "claude"
      ? ['export CLAUDE_CONFIG_DIR="$HOME/.claude-aw" CODEX_HOME="$HOME/.codex-aw" CLAUDE_CODE_TMPDIR="$HOME/.claude-aw/tmp"; mkdir -p "$CLAUDE_CODE_TMPDIR"', ["claude", "--remote-control", q(`${t.id}: ${title}`), "--permission-mode", "bypassPermissions", prompt]]
      : ['export CODEX_HOME="$HOME/.codex-aw"', ["codex", ...(nono ? ["--no-daemon"] : []), "--sandbox", "danger-full-access", "--ask-for-approval", "never", "-C", q(wt), prompt]];
  return `#!/usr/bin/env bash\ncd ${q(wt)} || exit 1\nunset LINEAR_API_KEY\n${env}\nexec ${[...wrap, ...cmd].join(" ")}\n`;
}

async function windows(cfg: Config, io: Io) {
  const r = await io.run(["tmux", "list-windows", "-t", `=${cfg.tmuxSession}`, "-F", "#{window_id} #{window_name}"]);
  const m = new Map<string, string>();
  if (r.code === 0) for (const line of r.out.split("\n").filter(Boolean)) m.set(line.slice(line.indexOf(" ") + 1), line.split(" ")[0]);
  return m;
}

async function findPr(repo: string, id: string, io: Io): Promise<string | undefined> {
  const prs: any[] = JSON.parse(await read(io, ["gh", "pr", "list", "--repo", repo, "--head", `agent/${id}`, "--state", "all", "--json", "url,state"]));
  return prs.find((p) => p.state !== "CLOSED")?.url;
}

export type PhaseStatus = "todo" | "in-progress" | "done";
export interface Phase {
  key: string;
  title: string;
  body: string;
  status: PhaseStatus;
}
const RANK: Record<PhaseStatus, number> = { todo: 0, "in-progress": 1, done: 2 };
const MAX_PHASES = 20;

/** Validates the agent-written phases file; it is untrusted, so anything off throws. */
export function parsePhases(raw: string): Phase[] {
  const a = JSON.parse(raw);
  if (!Array.isArray(a) || a.length > MAX_PHASES) throw new Error(`phases: must be an array of at most ${MAX_PHASES}`);
  const keys = new Set<string>();
  return a.map((p, i) => {
    const ok =
      p && typeof p === "object" && Object.keys(p).every((k) => ["key", "title", "body", "status"].includes(k)) &&
      typeof p.key === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(p.key) && !keys.has(p.key) &&
      typeof p.title === "string" && p.title.trim().length > 0 && p.title.length <= 120 && !/[\x00-\x1f\x7f]/.test(p.title) &&
      typeof (p.body ?? "") === "string" && (p.body ?? "").length <= 4000 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(p.body ?? "") &&
      typeof p.status === "string" && Object.hasOwn(RANK, p.status);
    if (!ok) throw new Error(`phases[${i}]: invalid`);
    keys.add(p.key);
    return { key: p.key, title: p.title.trim(), body: p.body ?? "", status: p.status };
  });
}

const MAX_PHASES_BYTES = 64 * 1024;

function readPhases(wt: string): Phase[] | undefined {
  let raw: string;
  try {
    raw = inAw(wt, (d) => {
      const fd = openSync(`${d}/phases.json`, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      try {
        const buf = Buffer.alloc(MAX_PHASES_BYTES + 1);
        const n = fstatSync(fd).isFile() ? readSync(fd, buf, 0, buf.length, 0) : buf.length;
        if (n > MAX_PHASES_BYTES) throw new Error("phases: must be a regular file under 64 KiB");
        return buf.toString("utf8", 0, n);
      } finally {
        closeSync(fd);
      }
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  return parsePhases(raw);
}

// `done` is held at in-progress until `final` (PR exists) so Linear's parent auto-close can't end the session mid-work.
async function syncPhases(t: Ticket, tr: Tracker, io: Io, dir: string, final: boolean) {
  const phases = readPhases(join(dir, t.id));
  if (!phases) return;
  const sidecar = join(dir, `${t.id}.phases.json`);
  const synced: Record<string, { ref: string; status: PhaseStatus }> = existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, "utf8")) : {};
  const save = () => put(io, sidecar, JSON.stringify(synced, null, 2));
  for (const p of phases) {
    let s = Object.hasOwn(synced, p.key) ? synced[p.key] : undefined;
    if (!s) {
      if (Object.keys(synced).length >= MAX_PHASES) throw new Error(`phases: more than ${MAX_PHASES} created for ${t.id}`);
      const title = `${t.id}: ${p.title}`;
      const known = new Set(Object.values(synced).map((x) => x.ref));
      // Adopt a sub-ticket created by a run that died before saving the sidecar instead of duplicating it.
      const orphan = (await tr.listPhases(t)).find((x) => x.title === title && !known.has(x.ref));
      s = synced[p.key] = { ref: orphan?.ref ?? (await tr.createPhase(t, title, p.body)), status: "todo" };
      save();
    }
    const want = !final && p.status === "done" ? "in-progress" : p.status;
    if (RANK[want] < RANK[s.status]) io.log(`phase ${t.id}/${p.key}: ignoring ${s.status} -> ${want}`);
    if (RANK[want] <= RANK[s.status]) continue;
    await tr.setPhase(t, s.ref, want as "in-progress" | "done");
    s.status = want;
    save();
  }
}

const repoDir = (cfg: Config, key: string) => join(cfg.workspaceRoot, key);
const winName = (key: string, id: string) => `${key}/${id}`;
const sourceOf = (dir: string, id: string) => {
  const f = join(dir, `${id}.source`);
  return existsSync(f) ? readFileSync(f, "utf8").trim() : undefined;
};
const subdirs = (d: string) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
const diskRepos = (cfg: Config) => subdirs(cfg.workspaceRoot).filter((o) => !o.startsWith(".")).flatMap((o) => subdirs(join(cfg.workspaceRoot, o)).map((n) => `${o}/${n}`));
const hasTrace = (cfg: Config, key: string, id: string) => existsSync(join(repoDir(cfg, key), id)) || existsSync(join(repoDir(cfg, key), `${id}.source`));
// Linear only: ids are unique per workspace (one LINEAR_API_KEY), so the marker is shared by all Linear sources.
const rejectFile = (cfg: Config, id: string) => join(cfg.workspaceRoot, ".rejected", id);

// Clone beside the target and rename, so an interrupted clone never looks finished; never deletes anything.
async function ensureClone(cfg: Config, io: Io, r: Repo) {
  if (existsSync(r.path)) {
    const real = realpathSync(r.path);
    const git = await io.run(["git", "-C", r.path, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    // Also rejects a subdirectory or linked worktree of another clone, which would share its .git.
    if (git.code !== 0 || git.out.trim() !== join(real, ".git")) throw new Error(`${r.path} is not the top of its own git clone (interrupted clone, subdirectory or worktree?); fix or remove it by hand`);
    const twin = Object.values(cfg.repos).find((o) => o !== r && existsSync(o.path) && realpathSync(o.path) === real);
    if (twin) throw new Error(`${r.path} is the same clone as ${twin.key}'s path`);
    return;
  }
  const tmp = `${r.path}.tmp-${process.pid}-${Date.now()}`;
  await write(io, ["gh", "repo", "clone", r.key, tmp]);
  io.log(`${io.dry ? "dry: " : ""}mv ${tmp} ${r.path}`);
  if (!io.dry) renameSync(tmp, r.path);
}

async function start(cfg: Config, s: Source, r: Repo, t: Ticket, tr: Tracker, io: Io, awDir: string) {
  const dir = repoDir(cfg, r.key);
  const wt = join(dir, t.id);
  const branch = `agent/${t.id}`;
  const promptFile = join(dir, `${t.id}.prompt.md`);
  const script = join(dir, `${t.id}.sh`);
  await ensureClone(cfg, io, r);
  put(io, join(dir, `${t.id}.source`), s.name);
  await tr.claim(t);
  remove(io, join(dir, `${t.id}.ended`));
  await write(io, ["git", "-C", r.path, "fetch", "origin", r.baseBranch]);
  if (existsSync(wt)) io.log(`reuse ${wt}`);
  else {
    const hasBranch = (await io.run(["git", "-C", r.path, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
    await write(io, ["git", "-C", r.path, "worktree", "add", wt, ...(hasBranch ? [branch] : ["-b", branch, `origin/${r.baseBranch}`])]);
  }
  const vars = { id: t.id, title: t.title, body: t.body, url: t.url, branch, base: r.baseBranch, testCmd: r.testCmd, repo: r.key };
  io.log(`${io.dry ? "dry: " : ""}write ${join(wt, ".aw", ".gitignore")}`);
  if (!io.dry) {
    mkdirSync(join(wt, ".aw"), { recursive: true });
    // Unlink + exclusive create: never write through a symlink or hardlink the agent left there.
    inAw(wt, (d) => (rmSync(`${d}/.gitignore`, { force: true }), writeFileSync(`${d}/.gitignore`, "*\n", { flag: "wx" })));
  }
  put(io, promptFile, render(readFileSync(r.prompt, "utf8"), vars));
  put(io, script, launcher(r, t, wt, promptFile, awDir), 0o755);
  await write(io, ["tmux", "new-window", "-d", "-t", `=${cfg.tmuxSession}:`, "-n", winName(r.key, t.id), script]);
}

async function step(io: Io, what: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    io.log(`${what} failed: ${(e as Error).message}`);
  }
}

const NO_REPO = "no repo set on this ticket: add a `repo:owner/name` label or a `repo: owner/name` line to its description";

const notAllowed = (t: Ticket) => (!t.repo ? NO_REPO : validRepo(t.repo) ? `repo ${t.repo} is not in the aw allowlist` : `repo ${JSON.stringify(t.repo.slice(0, 100))} is not a valid owner/name`);

// One comment per ticket whatever the reason, ever. Marked before posting: a crash loses the comment rather than repeating it.
async function reject(cfg: Config, t: Ticket, tr: Tracker, io: Io, reason: string) {
  const f = rejectFile(cfg, t.id);
  if (existsSync(f)) return;
  put(io, f, reason);
  try {
    await tr.comment(t, `aw: ${reason}`);
  } catch (e) {
    remove(io, f);
    throw e;
  }
}

// GitHub ids are only unique per repo, so the listing repo decides; a Linear ticket keeps the repo it was started in,
// even one since removed from aw.json (then left alone). Only the source recorded in <ID>.source may act on a worktree.
function workRepo(cfg: Config, s: Source, t: Ticket) {
  const started = s.tracker === "linear" ? diskRepos(cfg).find((k) => hasTrace(cfg, k, t.id)) : undefined;
  if (started && !Object.hasOwn(cfg.repos, started)) return;
  const key = started ?? allowedRepo(cfg, t.repo);
  if (!key) return;
  const owner = sourceOf(repoDir(cfg, key), t.id);
  return (owner === undefined ? !existsSync(join(repoDir(cfg, key), t.id)) : owner === s.name) ? key : undefined;
}

// Linear ids are global: a ticket requeued with another repo must not start a second session.
const startedElsewhere = (cfg: Config, key: string, id: string, wins: Map<string, string>) =>
  [...wins.keys()].find((n) => n.endsWith(`/${id}`) && n !== winName(key, id))?.slice(0, -id.length - 1) ??
  diskRepos(cfg).find((k) => k !== key && hasTrace(cfg, k, id));

async function reconcileSource(cfg: Config, s: Source, tr: Tracker, io: Io, wins: Map<string, string>, running: Map<string, number>, awDir: string) {
  const total = () => [...running.values()].reduce((a, b) => a + b, 0);
  if (total() < cfg.maxConcurrent)
    await step(io, "list ready", async () => {
      for (const t of await tr.listReady()) {
        if (total() >= cfg.maxConcurrent) break;
        if (!SAFE_ID.test(t.id)) continue;
        // GitHub tickets always carry an allowlisted repo, so only Linear tickets are ever rejected.
        const isLinear = s.tracker === "linear";
        const key = allowedRepo(cfg, t.repo);
        if (!key) {
          if (isLinear) await step(io, `reject ${t.id}`, () => reject(cfg, t, tr, io, notAllowed(t)));
          continue;
        }
        const r = cfg.repos[key]!;
        if (wins.has(winName(key, t.id)) || (running.get(key) ?? 0) >= (r.maxConcurrent ?? Infinity)) continue;
        const owner = sourceOf(repoDir(cfg, key), t.id);
        if (owner !== undefined && owner !== s.name) {
          io.log(`skip ${t.id}: ${key}/${t.id} belongs to source ${JSON.stringify(owner)}`);
          continue;
        }
        const other = isLinear && startedElsewhere(cfg, key, t.id, wins);
        if (other) {
          io.log(`skip ${t.id}: already started in ${other}`);
          continue;
        }
        // Uncached: a transfer must stop new clones and starts at once, not after the listing cache expires.
        const name = await canonical(io, key, true);
        if (!name) continue;
        if (!sameRepo(name, key)) {
          if (isLinear) await step(io, `reject ${t.id}`, () => reject(cfg, t, tr, io, `repo ${key} now resolves to ${name} on GitHub, which is not in the aw allowlist`));
          continue;
        }
        await step(io, `start ${t.id}`, async () => {
          await start(cfg, s, r, { ...t, repo: key }, tr, io, awDir);
          wins.set(winName(key, t.id), "new");
          running.set(key, (running.get(key) ?? 0) + 1);
        });
      }
    });

  await step(io, "list in-progress", async () => {
    for (const t of await tr.listInProgress())
      await step(io, `check ${t.id}`, async () => {
        const key = SAFE_ID.test(t.id) && workRepo(cfg, s, t);
        if (!key) return;
        const w = { ...t, repo: key };
        const dir = repoDir(cfg, key);
        const pr = await findPr(key, t.id, io);
        await step(io, `phases ${t.id}`, () => syncPhases(w, tr, io, dir, !!pr));
        if (pr) return tr.toReview(w, pr);
        const ended = join(dir, `${t.id}.ended`);
        if (wins.has(winName(key, t.id)) || existsSync(ended)) return;
        await tr.comment(w, "session ended without a PR");
        put(io, ended, new Date().toISOString());
      });
  });

  // Retries a final sync that failed when the parent moved to review; a no-op once in sync.
  await step(io, "list in-review", async () => {
    for (const t of await tr.listInReview()) {
      const key = SAFE_ID.test(t.id) && workRepo(cfg, s, t);
      if (key) await step(io, `phases ${t.id}`, () => syncPhases({ ...t, repo: key }, tr, io, repoDir(cfg, key), true));
    }
  });
}

const worktreeIds = (dir: string) => subdirs(dir).filter((d) => SAFE_ID.test(d));

export function makeTracker(s: Source, host: string, io: Io, defaultHost: boolean, repos: string[]) {
  return s.tracker === "github" ? github(s, host, io, defaultHost, repos) : linear(s, host, io, defaultHost);
}

const warned = new Set<string>();

export async function pass(cfg: Config, io: Io, tracker = makeTracker, awDir = AW_DIR) {
  if ((await io.run(["tmux", "has-session", "-t", `=${cfg.tmuxSession}`])).code !== 0)
    await write(io, ["tmux", "new-session", "-d", "-s", cfg.tmuxSession]).catch((e) => io.log(`tmux: ${e.message}`));
  const srcs = new Map(
    cfg.sources.map((s) => {
      const sio = { ...io, log: (m: string) => io.log(`[${s.name}] ${m}`) };
      return [s.name, { s, io: sio, tr: tracker(s, cfg.host, sio, cfg.defaultHost, Object.keys(cfg.repos)) }];
    }),
  );
  const wins = await windows(cfg, io);

  for (const r of Object.values(cfg.repos)) {
    const dir = repoDir(cfg, r.key);
    for (const id of worktreeIds(dir)) {
      const x = srcs.get(sourceOf(dir, id) ?? "");
      if (!x) {
        if (!warned.has(join(dir, id))) io.log(`${r.key}/${id}: source ${JSON.stringify(sourceOf(dir, id) ?? "")} in ${id}.source is not configured; left alone`);
        warned.add(join(dir, id));
        continue;
      }
      await step(x.io, `cleanup ${r.key}/${id}`, async () => {
        if (!(await x.tr.isDone(id, r.key))) return;
        const w = wins.get(winName(r.key, id));
        if (w) await write(x.io, ["tmux", "kill-window", "-t", w]);
        wins.delete(winName(r.key, id));
        await write(x.io, ["git", "-C", r.path, "worktree", "remove", join(dir, id)]);
        for (const ext of [".prompt.md", ".sh", ".ended", ".phases.json", ".source"]) remove(x.io, join(dir, id + ext));
      });
    }
  }

  const running = new Map<string, number>();
  for (const n of wins.keys()) {
    const k = n.slice(0, n.lastIndexOf("/"));
    if (Object.hasOwn(cfg.repos, k)) running.set(k, (running.get(k) ?? 0) + 1);
  }
  for (const { s, io: sio, tr } of srcs.values()) {
    try {
      await reconcileSource(cfg, s, tr, sio, wins, running, awDir);
    } catch (e) {
      sio.log(`source failed: ${(e as Error).message}`);
    }
  }
}

async function status(cfg: Config, io: Io) {
  const wins = await windows(cfg, io);
  console.log(`max ${cfg.maxConcurrent} sessions`);
  for (const s of cfg.sources) console.log(`source ${s.name}  ${s.tracker === "linear" ? `linear ${s.team}` : "github (all repos)"}`);
  for (const r of Object.values(cfg.repos)) {
    const running = [...wins.keys()].filter((n) => n.startsWith(`${r.key}/`)).map((n) => n.slice(r.key.length + 1));
    console.log(`${r.key}  ${r.agent}/${r.sandbox}  max ${r.maxConcurrent ?? "-"}  ${r.path}`);
    console.log(`  windows:   ${running.join(" ") || "-"}`);
    console.log(`  worktrees: ${worktreeIds(repoDir(cfg, r.key)).join(" ") || "-"}`);
  }
}

const spawnRun: Run = async (argv, cwd) => {
  const p = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
};

async function main(argv: string[]) {
  const ci = argv.indexOf("--config");
  const path = resolve(ci >= 0 ? argv[ci + 1] ?? "" : "aw.json");
  const cmd = argv.filter((a, i) => !a.startsWith("--") && !(ci >= 0 && i === ci + 1))[0];
  if (!["run", "once", "status"].includes(cmd ?? "")) {
    console.error("usage: bun aw.ts <run|once|status> [--dry-run] [--config aw.json]");
    process.exit(2);
  }
  let cfg: Config;
  try {
    cfg = parseConfig(JSON.parse(readFileSync(path, "utf8")), dirname(path));
  } catch (e) {
    console.error(`${path}: ${(e as Error).message}`);
    process.exit(1);
  }
  const io: Io = { run: spawnRun, fetch, dry: argv.includes("--dry-run"), log: (m) => console.log(`${new Date().toISOString()} ${m}`) };
  if (cmd === "status") return status(cfg, io);
  if (cmd === "once") return pass(cfg, io);
  for (;;) {
    await pass(cfg, io);
    await Bun.sleep(cfg.pollIntervalMs);
  }
}

if (import.meta.main) await main(Bun.argv.slice(2));
