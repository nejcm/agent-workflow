#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface Lane {
  name: string;
  tracker: "github" | "linear";
  repo: string;
  repoPath: string;
  baseBranch: string;
  agent: "claude" | "codex";
  sandbox: "nono" | "none";
  maxConcurrent: number;
  testCmd: string;
  prompt: string;
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
  tmuxSession: string;
  lanes: Lane[];
}

export interface Ticket {
  id: string;
  ref: string;
  title: string;
  body: string;
  url: string;
  labels?: string[];
}

export interface Tracker {
  listReady(): Promise<Ticket[]>;
  listInProgress(): Promise<Ticket[]>;
  isDone(id: string): Promise<boolean>;
  claim(t: Ticket): Promise<void>;
  toReview(t: Ticket, prUrl: string): Promise<void>;
  comment(t: Ticket, body: string): Promise<void>;
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

const expand = (p: string, base: string) => resolve(base, p.replace(/^~(?=$|\/)/, homedir()));

export function parseConfig(raw: any, base: string): Config {
  const errs: string[] = [];
  const check = (ok: unknown, msg: string) => ok || errs.push(msg);
  const str = (v: unknown) => typeof v === "string" && v.length > 0;
  check(raw && typeof raw === "object", "config must be a JSON object");
  raw ??= {};
  check(str(raw.host) && /^[A-Za-z0-9._-]+$/.test(raw.host), "host: required, [A-Za-z0-9._-]");
  const defaultHost = raw.defaultHost ?? false;
  check(typeof defaultHost === "boolean", "defaultHost: boolean");
  const pollIntervalMs = raw.pollIntervalMs ?? 60000;
  check(Number.isInteger(pollIntervalMs) && pollIntervalMs >= 5000, "pollIntervalMs: integer >= 5000");
  const tmuxSession = raw.tmuxSession ?? "aw";
  check(NAME.test(tmuxSession), "tmuxSession: [a-z0-9-]");
  check(Array.isArray(raw.lanes) && raw.lanes.length > 0, "lanes: non-empty array required");
  const lanes: Lane[] = (Array.isArray(raw.lanes) ? raw.lanes : []).map((r: any, i: number) => {
    const at = `lanes[${i}]${str(r?.name) ? ` (${r.name})` : ""}`;
    r ??= {};
    const l: Lane = {
      name: r.name,
      tracker: r.tracker,
      repo: r.repo,
      repoPath: str(r.repoPath) ? expand(r.repoPath, base) : "",
      baseBranch: r.baseBranch ?? "main",
      agent: r.agent,
      sandbox: r.sandbox,
      maxConcurrent: r.maxConcurrent ?? 2,
      testCmd: r.testCmd,
      prompt: expand(r.prompt ?? join(AW_DIR, "prompts/default.md"), base),
      readyLabel: r.readyLabel ?? "agent",
      inProgressLabel: r.inProgressLabel ?? "in-progress",
      inReviewLabel: r.inReviewLabel ?? "in-review",
      team: r.team,
      todo: r.todo ?? "Todo",
      inProgress: r.inProgress ?? "In Progress",
      inReview: r.inReview ?? "In Review",
      done: r.done ?? ["Done", "Canceled", "Duplicate"],
    };
    check(NAME.test(l.name ?? ""), `${at}.name: required, [a-z0-9-]`);
    check(["github", "linear"].includes(l.tracker), `${at}.tracker: "github" | "linear"`);
    check(/^[\w.-]+\/[\w.-]+$/.test(l.repo ?? ""), `${at}.repo: "owner/name"`);
    check(l.repoPath, `${at}.repoPath: required`);
    check(/^[\w./-]+$/.test(l.baseBranch) && !l.baseBranch.includes(".."), `${at}.baseBranch: invalid`);
    check(["claude", "codex"].includes(l.agent), `${at}.agent: "claude" | "codex"`);
    check(["nono", "none"].includes(l.sandbox), `${at}.sandbox: "nono" | "none"`);
    check(Number.isInteger(l.maxConcurrent) && l.maxConcurrent > 0, `${at}.maxConcurrent: positive integer`);
    check(str(l.testCmd), `${at}.testCmd: required`);
    check(existsSync(l.prompt), `${at}.prompt: ${l.prompt} not found`);
    for (const k of ["readyLabel", "inProgressLabel", "inReviewLabel", "todo", "inProgress", "inReview"] as const)
      check(str(l[k]), `${at}.${k}: non-empty string`);
    check(Array.isArray(l.done) && l.done.length > 0 && l.done.every(str), `${at}.done: non-empty string array`);
    if (l.tracker === "linear") check(/^[A-Z0-9]+$/.test(l.team ?? ""), `${at}.team: Linear team key, e.g. ENG`);
    return l;
  });
  const names = lanes.map((l) => l.name);
  check(new Set(names).size === names.length, "lane names must be unique");
  if (errs.length) throw new Error(`invalid config:\n  ${errs.join("\n  ")}`);
  return { host: raw.host, defaultHost, pollIntervalMs, workspaceRoot: expand(raw.workspaceRoot ?? "~/agent-ws", base), tmuxSession, lanes };
}

async function read(io: Io, argv: string[], cwd?: string) {
  const r = await io.run(argv, cwd);
  if (r.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")}: ${r.err.trim() || `exit ${r.code}`}`);
  return r.out;
}

async function write(io: Io, argv: string[], cwd?: string) {
  io.log(`${io.dry ? "dry: " : ""}${argv.join(" ")}`);
  if (!io.dry) await read(io, argv, cwd);
}

function put(io: Io, path: string, data: string, mode = 0o644) {
  io.log(`${io.dry ? "dry: " : ""}write ${path}`);
  if (io.dry) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  chmodSync(path, mode);
}

function remove(io: Io, path: string) {
  if (!existsSync(path)) return;
  io.log(`${io.dry ? "dry: " : ""}rm ${path}`);
  if (!io.dry) rmSync(path);
}

// Ours if labelled host:<host>, or (defaultHost) if no host: label at all.
const ours = (t: Ticket, host: string, defaultHost: boolean) =>
  !!t.labels?.includes(`host:${host}`) || (defaultHost && !t.labels?.some((x) => x.startsWith("host:")));

export function github(l: Lane, host: string, io: Io, defaultHost = false): Tracker {
  const hostLabel = `host:${host}`;
  const listMine = (labels: string[]) => defaultHost ? list(labels).then((r) => r.filter((t) => ours(t, host, true))) : list([...labels, hostLabel]);
  const list = async (labels: string[]): Promise<Ticket[]> => {
    const argv = ["gh", "issue", "list", "--repo", l.repo, "--state", "open", "--limit", "100"];
    for (const x of labels) argv.push("--label", x);
    const issues: any[] = JSON.parse(await read(io, [...argv, "--json", "number,title,body,url,labels"]));
    return issues
      .filter((i) => Number.isInteger(i.number))
      .map((i) => ({ id: `gh-${i.number}`, ref: String(i.number), title: i.title ?? "", body: i.body ?? "", url: i.url ?? "", labels: (i.labels ?? []).map((x: any) => x.name) }));
  };
  const edit = (t: Ticket, add: string, rm?: string) => write(io, ["gh", "issue", "edit", t.ref, "--repo", l.repo, "--add-label", add, ...(rm ? ["--remove-label", rm] : [])]);
  const comment = (t: Ticket, body: string) => write(io, ["gh", "issue", "comment", t.ref, "--repo", l.repo, "--body", body]);
  return {
    listReady: async () => (await listMine([l.readyLabel])).filter((t) => ![l.inProgressLabel, l.inReviewLabel].some((x) => t.labels?.includes(x))),
    listInProgress: () => listMine([l.readyLabel, l.inProgressLabel]),
    async isDone(id) {
      const n = /^gh-(\d+)$/.exec(id)?.[1];
      if (!n) throw new Error(`not a github ticket id: ${id}`);
      return JSON.parse(await read(io, ["gh", "issue", "view", n, "--repo", l.repo, "--json", "state"])).state === "CLOSED";
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
  };
}

export function linear(l: Lane, host: string, io: Io, defaultHost = false): Tracker {
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
  const stateId = async (name: string) => {
    states ??= new Map(
      (await gql(`query($t: String!) { workflowStates(filter: { team: { key: { eq: $t } } }) { nodes { id name } } }`, { t: l.team })).workflowStates.nodes.map(
        (s: any) => [s.name, s.id],
      ),
    );
    const id = states!.get(name);
    if (!id) throw new Error(`linear state "${name}" not found in team ${l.team}`);
    return id;
  };
  const list = async (state: string, labels: string[]): Promise<Ticket[]> => {
    const filter = { team: { key: { eq: l.team } }, state: { name: { eq: state } }, and: labels.map((n) => ({ labels: { some: { name: { eq: n } } } })) };
    const d = await gql(`query($f: IssueFilter) { issues(filter: $f, first: 100) { nodes { id identifier title description url labels { nodes { name } } } } }`, { f: filter });
    return d.issues.nodes
      .filter((i: any) => /^[A-Z0-9]+-\d+$/.test(i.identifier))
      .map((i: any) => ({ id: i.identifier, ref: i.id, title: i.title ?? "", body: i.description ?? "", url: i.url ?? "", labels: (i.labels?.nodes ?? []).map((x: any) => x.name) }));
  };
  const comment = async (t: Ticket, body: string) => {
    await gql(`mutation($i: CommentCreateInput!) { commentCreate(input: $i) { success } }`, { i: { issueId: t.ref, body } }, true);
  };
  const move = async (t: Ticket, state: string) => {
    await gql(`mutation($id: String!, $s: String!) { issueUpdate(id: $id, input: { stateId: $s }) { success } }`, { id: t.ref, s: await stateId(state) }, true);
  };
  const hostLabel = `host:${host}`;
  const listMine = (state: string, labels: string[]) => defaultHost ? list(state, labels).then((r) => r.filter((t) => ours(t, host, true))) : list(state, [...labels, hostLabel]);
  return {
    listReady: () => listMine(l.todo, [l.readyLabel]),
    listInProgress: () => listMine(l.inProgress, [l.readyLabel]),
    async isDone(id) {
      const d = await gql(`query($id: String!) { issue(id: $id) { state { name } } }`, { id });
      return l.done.includes(d.issue?.state?.name);
    },
    async claim(t) {
      await move(t, l.inProgress);
      await comment(t, `picked up on ${host}`);
    },
    async toReview(t, prUrl) {
      await move(t, l.inReview);
      await comment(t, `PR: ${prUrl}`);
    },
    comment,
  };
}

export const render = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function launcher(l: Lane, t: Ticket, wt: string, promptFile: string, awDir = AW_DIR) {
  const prompt = `"$(cat ${q(promptFile)})"`;
  const nono = l.sandbox === "nono";
  const wrap = nono ? ["nono", "run", "--profile", q(join(awDir, "nono", `aw-${l.agent}.json`)), "--allow", q(wt), "--allow", q(join(l.repoPath, ".git")), "--"] : [];
  const title = t.title.replace(/[^\w .,:()#-]/g, "").slice(0, 60).trim();
  const [env, cmd] =
    l.agent === "claude"
      ? ['export CLAUDE_CONFIG_DIR="$HOME/.claude-aw"', ["claude", "--remote-control", q(`${t.id}: ${title}`), "--permission-mode", "bypassPermissions", prompt]]
      : ['export CODEX_HOME="$HOME/.codex-aw"', ["codex", ...(nono ? ["--no-daemon"] : []), "--sandbox", "danger-full-access", "--ask-for-approval", "never", "-C", q(wt), prompt]];
  return `#!/usr/bin/env bash\ncd ${q(wt)} || exit 1\nunset LINEAR_API_KEY\n${env}\nexec ${[...wrap, ...cmd].join(" ")}\n`;
}

async function windows(cfg: Config, io: Io) {
  const r = await io.run(["tmux", "list-windows", "-t", `=${cfg.tmuxSession}`, "-F", "#{window_id} #{window_name}"]);
  const m = new Map<string, string>();
  if (r.code === 0) for (const line of r.out.split("\n").filter(Boolean)) m.set(line.slice(line.indexOf(" ") + 1), line.split(" ")[0]);
  return m;
}

async function findPr(l: Lane, id: string, io: Io): Promise<string | undefined> {
  const prs: any[] = JSON.parse(await read(io, ["gh", "pr", "list", "--repo", l.repo, "--head", `agent/${id}`, "--state", "all", "--json", "url,state"]));
  return prs.find((p) => p.state !== "CLOSED")?.url;
}

async function start(cfg: Config, l: Lane, t: Ticket, tr: Tracker, io: Io, awDir: string) {
  const dir = join(cfg.workspaceRoot, l.name);
  const wt = join(dir, t.id);
  const branch = `agent/${t.id}`;
  const promptFile = join(dir, `${t.id}.prompt.md`);
  const script = join(dir, `${t.id}.sh`);
  await tr.claim(t);
  remove(io, join(dir, `${t.id}.ended`));
  await write(io, ["git", "-C", l.repoPath, "fetch", "origin", l.baseBranch]);
  if (existsSync(wt)) io.log(`reuse ${wt}`);
  else {
    const hasBranch = (await io.run(["git", "-C", l.repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
    await write(io, ["git", "-C", l.repoPath, "worktree", "add", wt, ...(hasBranch ? [branch] : ["-b", branch, `origin/${l.baseBranch}`])]);
  }
  const vars = { id: t.id, title: t.title, body: t.body, url: t.url, branch, base: l.baseBranch, testCmd: l.testCmd, repo: l.repo };
  put(io, promptFile, render(readFileSync(l.prompt, "utf8"), vars));
  put(io, script, launcher(l, t, wt, promptFile, awDir), 0o755);
  await write(io, ["tmux", "new-window", "-d", "-t", `=${cfg.tmuxSession}:`, "-n", `${l.name}/${t.id}`, script]);
}

export async function reconcileLane(cfg: Config, l: Lane, tr: Tracker, io: Io, awDir = AW_DIR) {
  const dir = join(cfg.workspaceRoot, l.name);
  const wins = await windows(cfg, io);
  const win = (id: string) => `${l.name}/${id}`;
  const step = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      io.log(`${what} failed: ${(e as Error).message}`);
    }
  };

  const worktrees = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && SAFE_ID.test(d.name)).map((d) => d.name) : [];
  for (const id of worktrees)
    await step(`cleanup ${id}`, async () => {
      if (!(await tr.isDone(id))) return;
      const w = wins.get(win(id));
      if (w) await write(io, ["tmux", "kill-window", "-t", w]);
      wins.delete(win(id));
      await write(io, ["git", "-C", l.repoPath, "worktree", "remove", join(dir, id)]);
      for (const ext of [".prompt.md", ".sh", ".ended"]) remove(io, join(dir, id + ext));
    });

  let running = [...wins.keys()].filter((n) => n.startsWith(`${l.name}/`)).length;
  if (running < l.maxConcurrent)
    await step("list ready", async () => {
      for (const t of await tr.listReady()) {
        if (running >= l.maxConcurrent) break;
        if (!SAFE_ID.test(t.id) || wins.has(win(t.id))) continue;
        await step(`start ${t.id}`, async () => {
          await start(cfg, l, t, tr, io, awDir);
          wins.set(win(t.id), "new");
          running++;
        });
      }
    });

  await step("list in-progress", async () => {
    for (const t of await tr.listInProgress())
      await step(`check ${t.id}`, async () => {
        if (!SAFE_ID.test(t.id)) return;
        const pr = await findPr(l, t.id, io);
        if (pr) return tr.toReview(t, pr);
        const ended = join(dir, `${t.id}.ended`);
        if (wins.has(win(t.id)) || existsSync(ended)) return;
        await tr.comment(t, "session ended without a PR");
        put(io, ended, new Date().toISOString());
      });
  });
}

export function makeTracker(l: Lane, host: string, io: Io, defaultHost = false) {
  return l.tracker === "github" ? github(l, host, io, defaultHost) : linear(l, host, io, defaultHost);
}

export async function pass(cfg: Config, io: Io, tracker = makeTracker, awDir = AW_DIR) {
  if ((await io.run(["tmux", "has-session", "-t", `=${cfg.tmuxSession}`])).code !== 0)
    await write(io, ["tmux", "new-session", "-d", "-s", cfg.tmuxSession]).catch((e) => io.log(`tmux: ${e.message}`));
  for (const l of cfg.lanes) {
    const lio = { ...io, log: (m: string) => io.log(`[${l.name}] ${m}`) };
    try {
      await reconcileLane(cfg, l, tracker(l, cfg.host, lio, cfg.defaultHost), lio, awDir);
    } catch (e) {
      lio.log(`lane failed: ${(e as Error).message}`);
    }
  }
}

async function status(cfg: Config, io: Io) {
  const wins = await windows(cfg, io);
  for (const l of cfg.lanes) {
    const dir = join(cfg.workspaceRoot, l.name);
    const wts = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
    const running = [...wins.keys()].filter((n) => n.startsWith(`${l.name}/`)).map((n) => n.slice(l.name.length + 1));
    console.log(`${l.name}  ${l.tracker} ${l.repo}  ${l.agent}/${l.sandbox}  max ${l.maxConcurrent}`);
    console.log(`  windows:   ${running.join(" ") || "-"}`);
    console.log(`  worktrees: ${wts.join(" ") || "-"}`);
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
