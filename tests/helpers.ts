import type { Row } from "../src/status";
import { afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config";
import { canonCache } from "../src/github";
import type { Config, Io, Ticket, Tracker } from "../src/types";
import { AW_DIR } from "../src/util";

export let root: string;
// Called per test file: bun shares this module across files, so top-level hooks would only bind to the first.
export function useTempRoot() {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aw-test-"));
    canonCache.clear();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
}

export const src = (over: object = {}) => ({ name: "web", tracker: "github", ...over });
export const raw = (over: object = {}) => ({
  host: "box",
  workspaceRoot: root,
  defaults: { agent: "claude", sandbox: "nono", testCmd: "bun test" },
  repos: [{ name: "acme/web", path: join(root, "src-web") }],
  sources: [src()],
  ...over,
});
export const config = (over: object = {}): Config => parseConfig(raw(over), AW_DIR);
export const web = (c: Config) => c.repos["acme/web"]!;
export const ticket = (n: number, repo = "acme/web"): Ticket => ({ id: `gh-${n}`, ref: String(n), title: `Fix thing ${n}`, body: "body; rm -rf ~ $(whoami)", url: `https://x/${n}`, repo });

export function fakeTracker(s: { ready?: Ticket[]; inProgress?: Ticket[]; inReview?: Ticket[]; done?: string[] }) {
  const calls: string[] = [];
  const subs: { ref: string; title: string }[] = [];
  const tr: Tracker = {
    listReady: async () => s.ready ?? [],
    listInProgress: async () => s.inProgress ?? [],
    listInReview: async () => s.inReview ?? [],
    isDone: async (id, repo) => (s.done ?? []).some((d) => d === id || d === `${repo}#${id}`),
    claim: async (t) => void calls.push(`claim ${t.id}`),
    toReview: async (t, pr) => void calls.push(`review ${t.id} ${pr}`),
    done: async (t) => void calls.push(`done ${t.id}`),
    comment: async (t, b) => void calls.push(`comment ${t.id} ${b}`),
    createPhase: async (t, title) => (calls.push(`create ${t.id} ${title}`), subs.push({ ref: `sub-${calls.length}`, title }), `sub-${calls.length}`),
    listPhases: async () => subs,
    setPhase: async (_t, ref, st) => void calls.push(`set ${ref} ${st}`),
  };
  return { tr, calls, subs };
}

export function fakeIo(respond: (argv: string[]) => { code?: number; out?: string } | undefined = () => undefined, dry = false) {
  const cmds: string[] = [];
  const logs: string[] = [];
  const io: Io = {
    dry,
    fetch: (() => Promise.reject(new Error("no network"))) as any,
    log: (m) => logs.push(m),
    run: async (argv) => {
      cmds.push(argv.join(" "));
      const r =
        respond(argv) ??
        (argv[1] === "repo" && argv[2] === "view" ? { out: JSON.stringify({ nameWithOwner: argv[3] }) } : argv[5] === "--git-common-dir" ? { out: join(realpathSync(argv[2]!), ".git") + "\n" } : {});
      if (argv[1] === "repo" && argv[2] === "clone" && !r.code) mkdirSync(argv[4]!, { recursive: true });
      return { code: r.code ?? 0, out: r.out ?? "", err: r.code ? "boom" : "" };
    },
  };
  return { io, cmds, logs };
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
  writeFileSync(join(root, repo, `${id}.source`), source);
};
export const writePhases = (id: string, phases: unknown) => {
  worktree(id);
  mkdirSync(join(root, "acme/web", id, ".aw"), { recursive: true });
  writeFileSync(join(root, "acme/web", id, ".aw/phases.json"), typeof phases === "string" ? phases : JSON.stringify(phases));
};
export const phase = (key: string, status: unknown, over: object = {}) => ({ key, title: `Do ${key}`, body: "b", status, ...over });

export const windowsOut =(names: string[]) => ({ out: names.map((n, i) => `@${i} ${n}`).join("\n") });
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
  transcript: null,
  window: "@1",
  ...over,
});
