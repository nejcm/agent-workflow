import type { Row } from "../src/ui/status";
import { afterEach, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_TOKEN, claudeDir } from "../src/session/agents";
import { CREDENTIALS } from "../src/session/claude-auth";
import { parseConfig } from "../src/config/config";
import { canonCache } from "../src/github";
import { hatchCache } from "../src/review/merge";
import { configCache } from "../src/config/repo-config";
import type { Config, GitHubSource, Io, LinearSource, Ticket, Tracker } from "../src/types";
import { TENDER_DIR, GIT, hasLabel } from "../src/util";

export let root: string;
/** What the fake git serves as `.tender/<name>` at `origin/<base>`; reset per test. */
export let repoFiles: Record<string, string> = {};
export let baseSha = "a".repeat(40);
export const setBaseSha = (sha: string) => void (baseSha = sha);
// Called per test file: bun shares this module across files, so top-level hooks would only bind to the first.
/** A Claude session record for this test process, as Claude writes it under `<dir>/sessions`. */
export function session(dir: string, o: object) {
  const stat = readFileSync("/proc/self/stat", "utf8");
  const procStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, procStart, kind: "interactive", startedAt: 1, ...o }));
}

export function useTempRoot() {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tender-test-"));
    mkdirSync(join(root, ".claude-tender"));
    writeFileSync(join(root, CLAUDE_TOKEN), "tok");
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, CREDENTIALS), JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000, refreshTokenExpiresAt: Date.now() + 7 * 86_400_000, scopes: ["user:inference"] } }));
    canonCache.clear();
    configCache.clear();
    hatchCache.clear();
    repoFiles = {};
    baseSha = "a".repeat(40);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
}

export const gh = (c: Config = config()) => c.sources[0] as GitHubSource;
export const lin = (c: Config, i = 0) => c.sources[i] as LinearSource;
export const src = (over: object = {}) => ({ name: "web", tracker: "github", ...over });
export const raw = (over: object = {}) => ({
  host: "box",
  workspaceRoot: root,
  defaults: { sandbox: "nono" },
  repos: [{ name: "acme/web", path: join(root, "src-web") }],
  sources: [src()],
  ...over,
});
export const config = (over: object = {}): Config => parseConfig(raw(over), TENDER_DIR);
export const web = (c: Config) => c.repos["acme/web"]!;
export const ticket = (n: number, repo = "acme/web"): Ticket => ({ id: `gh-${n}`, ref: String(n), title: `Fix thing ${n}`, body: "body; rm -rf ~ $(whoami)", url: `https://x/${n}`, repo });

export function fakeTracker(s: { ready?: Ticket[]; inProgress?: Ticket[]; inReview?: Ticket[]; done?: string[]; canceled?: string[]; deleted?: string[]; globalIds?: boolean; readyToMerge?: boolean; markers?: Record<string, string>; views?: Record<string, { title?: string; body?: string; labels?: string[]; open?: boolean }> }) {
  const calls: string[] = [];
  const subs: { ref: string; title: string; body?: string }[] = [];
  const tr: Tracker = {
    globalIds: s.globalIds ?? false,
    restartHint: () => "remove the in-progress label",
    describe: () => "fake",
    listReady: async () => s.ready ?? [],
    listInProgress: async () => s.inProgress ?? [],
    listInReview: async () => s.inReview ?? [],
    closed: async (id, repo) => {
      const has = (l?: string[]) => (l ?? []).some((d) => d === id || d === `${repo}#${id}`);
      return has(s.canceled) ? "canceled" : has(s.deleted) ? "deleted" : has(s.done) ? "done" : undefined;
    },
    claim: async (t) => void calls.push(`claim ${t.id}`),
    toReview: async (t, note) => {
      calls.push(`review ${t.id} ${note}`);
      for (const x of s.inReview ?? []) if (x.id === t.id) x.readyToMerge = undefined;
    },
    ...(s.readyToMerge && {
      toReadyToMerge: async (t: Ticket, note: string) => {
        calls.push(`ready ${t.id} ${note}`);
        for (const x of s.inReview ?? []) if (x.id === t.id) x.readyToMerge = true;
      },
    }),
    done: async (t) => void calls.push(`done ${t.id}`),
    park: async (t) => {
      calls.push(`park ${t.id}`);
      for (const x of [...(s.inProgress ?? []), ...(s.inReview ?? [])]) if (x.id === t.id) x.labels = [...(x.labels ?? []), "needs-human"];
    },
    parked: async (t) => [...(s.inProgress ?? []), ...(s.inReview ?? [])].some((x) => x.id === t.id && hasLabel(x.labels, "needs-human")),
    comment: async (t, b) => void calls.push(`comment ${t.id} ${b}`),
    comments: async () => [],
    createPhase: async (t, title, body) => (calls.push(`create ${t.id} ${title}`), subs.push({ ref: `sub-${calls.length}`, title, body }), `sub-${calls.length}`),
    createTicket: async (t, title, body) => (calls.push(`file ${t.id} ${title} | ${body}`), `https://x/acme/web/issues/${calls.length}`),
    fileTicket: async (target, title, body, labels) => (calls.push(`intake ${target.repo} ${title} [${labels}] | ${body}`), `https://github.com/${target.repo}/issues/${100 + calls.length}`),
    findMarker: async (_target, m) => s.markers?.[m],
    reopen: async (t) => void calls.push(`reopen ${t.id}`),
    view: async (t) => ({ title: `Ticket ${t.id}`, body: "body", labels: [], open: true, ...s.views?.[t.id] }),
    addLabels: async (t, labels) => void calls.push(`label ${t.id} [${labels}]`),
    listPhases: async () => subs.map((x) => ({ body: "", ...x })),
    setPhase: async (_t, ref, st) => void calls.push(`set ${ref} ${st}`),
  };
  return { tr, calls, subs };
}

export function fakeIo(respond: (argv: string[]) => { code?: number; out?: string; err?: string } | undefined = () => undefined, dry = false) {
  const cmds: string[] = [];
  const logs: string[] = [];
  const io: Io = {
    dry,
    home: root,
    fetch: (() => Promise.reject(new Error("no network"))) as any,
    log: (m) => logs.push(m),
    run: async (full) => {
      if (full[0] === "git" && full.slice(0, GIT.length).join("\0") !== GIT.join("\0")) throw new Error(`git without the GIT prefix: ${full.join(" ")}`);
      const argv = full[0] === "git" ? ["git", ...full.slice(GIT.length)] : full;
      cmds.push(argv.join(" "));
      const r =
        respond(argv) ??
        (argv[1] === "repo" && argv[2] === "view" ? { out: JSON.stringify({ nameWithOwner: argv[3], defaultBranchRef: { name: "main" } }) } : gitTree(argv) ?? (argv[5] === "--git-common-dir" ? { out: join(realpathSync(argv[2]!), ".git") + "\n" } : argv[4] === "get-url" ? { out: "https://github.com/acme/web.git\n" } : {}));
      if (argv[1] === "repo" && argv[2] === "clone" && !r.code) mkdirSync(argv[4]!, { recursive: true });
      if (argv[0] === "git" && argv[5] === "clone" && !r.code) mkdirSync(join(argv.at(-1)!, ".git"), { recursive: true });
      return { code: r.code ?? 0, out: r.out ?? "", err: r.err ?? (r.code ? "boom" : "") };
    },
  };
  return { io, cmds, logs };
}

const oid = (name: string) => Buffer.from(name).toString("hex").padEnd(40, "0");
function gitTree(argv: string[]): { code?: number; out?: string; err?: string } | undefined {
  if (argv[0] !== "git") return;
  if (argv[3] === "rev-parse" && argv.at(-1)?.endsWith("^{commit}")) return { out: `${baseSha}\n` };
  if (argv[3] === "ls-remote") return { out: `${baseSha}\t${argv.at(-1)}\n` };
  if (argv[3] === "ls-tree" && argv[4] !== "-r") return { out: Object.keys(repoFiles).length ? `040000 tree ${oid(".tender")}\t.tender\0` : "" };
  if (argv[3] === "ls-tree") return { out: Object.entries(repoFiles).map(([n, t]) => `100644 blob ${oid(n)} ${Buffer.byteLength(t)}\t.tender/${n}\0`).join("") };
  if (argv[3] === "cat-file") return { out: Object.entries(repoFiles).find(([n]) => oid(n) === argv[5])?.[1] };
}

export async function withLinearKey<T>(fn: () => Promise<T>) {
  const prev = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_KEY = "k";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = prev;
  }
}

export const worktree = (id: string, source = "web", repo = "acme/web") => {
  mkdirSync(join(root, repo, id), { recursive: true });
  if (!existsSync(join(root, repo, id, ".git"))) mkdirSync(join(root, repo, id, ".git"));
  writeFileSync(join(root, repo, `${id}.source`), source);
};
export const claudeFile = (wt: string, name: string, ...lines: string[]) => {
  const cd = claudeDir(wt);
  mkdirSync(cd, { recursive: true });
  writeFileSync(join(cd, name), [JSON.stringify({ type: "user", cwd: wt }), ...lines, ""].join("\n"));
  return join(cd, name);
};
export const writePhases = (id: string, phases: unknown) => {
  worktree(id);
  mkdirSync(join(root, "acme/web", id, ".tender/run"), { recursive: true });
  writeFileSync(join(root, "acme/web", id, ".tender/run/phases.json"), typeof phases === "string" ? phases : JSON.stringify(phases));
};
export const phase = (key: string, status: unknown, over: object = {}) => ({ key, title: `Do ${key}`, body: "b", status, ...over });

// Activity defaults to now: a window with recent output, so never idle.
export const windowsOut = (names: string[], at = Math.floor(Date.now() / 1000)) => ({ out: names.map((n, i) => `@${i} ${at} ${n}`).join("\n") });
export const noPr = (argv: string[]) => (argv[1] === "pr" ? { out: "[]" } : undefined);

export const two = (over: object = {}) =>
  config({ maxConcurrent: 4, repos: [{ name: "acme/web", path: join(root, "src-web") }, { name: "acme/api", path: join(root, "src-api"), ...over }], sources: [src({ name: "gh" }), src({ name: "lin", tracker: "linear", team: "ENG" })] });

export const statusRow = (over: Partial<Row> = {}): Row => ({
  id: "PER-1",
  repo: "acme/web",
  agent: "claude",
  session: "running",
  state: "working",
  stateSince: null,
  waitingFor: null,
  startedAt: null,
  runtimeMs: 3_600_000,
  idleMs: 5_000,
  phases: { done: 1, total: 3, items: [{ key: "a", title: "Do a", status: "done" }, { key: "b", title: "Do b", status: "in-progress" }, { key: "c", title: "Do c", status: "todo" }] },
  pr: "https://github.com/acme/web/pull/4",
  merge: null,
  ready: false,
  transcript: null,
  window: "@1",
  ...over,
});
