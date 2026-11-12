import { closeSync, constants as C, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoDir, validRepo } from "./config";
import { diskRepos, SAFE_ID } from "./pass";
import type { Config, Repo } from "./types";

const MAX = 200;
const CHUNK = 256 * 1024;

export const mtime = (p: string) => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return undefined;
  }
};

// Untrusted text: drop ESC sequences and invisible chars, blank controls and bidi; ZWJ/ZWNJ stay (emoji, Persian, Indic).
export const clean = (s: string, max = MAX) =>
  s
    .replace(/\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)?|[@-_])?/g, "")
    .replace(/[\u00ad\u200b\u2060\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu, "")
    .replace(/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

// Transcript dirs are agent-writable: never follow a symlink or block on a FIFO; undefined if gone, unreadable or not a regular file.
export function withFile<T>(path: string, fn: (fd: number, st: Stats) => T): T | undefined {
  let fd: number;
  try {
    fd = openSync(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    return st.isFile() ? fn(fd, st) : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Complete lines in [pos, size) of the open file, capped to the last CHUNK bytes; `next` is where the following read starts. */
export function lines(fd: number, size: number, pos: number) {
  const from = Math.max(pos, size - CHUNK - 1);
  const buf = Buffer.alloc(size - from);
  const b = buf.subarray(0, readSync(fd, buf, 0, buf.length, from));
  const nl = b.indexOf(10);
  if (from > pos && nl < 0) return { text: "", next: pos };
  const begin = from > pos ? nl + 1 : 0;
  const end = Math.max(begin, b.lastIndexOf(10) + 1);
  return { text: b.toString("utf8", begin, end), next: from + end };
}

const prim = (v: unknown) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "");
const KEYS = ["command", "cmd", "file_path", "path", "pattern", "url", "query", "skill", "description", "prompt"];

export function argSummary(input: unknown): string {
  if (typeof input === "string") {
    const s = input;
    try {
      input = JSON.parse(s);
    } catch {
      return clean(s, 120);
    }
  }
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const k = KEYS.find((k) => o[k] !== undefined);
    const v = k ? o[k] : o;
    return clean(typeof v === "string" ? v : Array.isArray(v) ? v.map(prim).join(" ") : JSON.stringify(v), 120);
  }
  return clean(String(input ?? ""), 120);
}

const textOf = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (typeof b?.text === "string" ? b.text : "")).join(" ") : "");

const hhmmss = (ts: unknown) => {
  const d = new Date(typeof ts === "string" ? ts : NaN);
  return isNaN(d.getTime()) ? "--:--:--" : d.toTimeString().slice(0, 8);
};

/** Condensed one-line events (assistant text, tool calls, tool errors) from one Claude or Codex JSONL line; [] for anything else. */
export function events(line: string): string[] {
  try {
    return lineEvents(JSON.parse(line));
  } catch {
    return [];
  }
}

function lineEvents(o: any): string[] {
  if (!o || typeof o !== "object") return [];
  const at = hhmmss(o.timestamp);
  const ev = (kind: string, detail: string) => `${at} ${clean(kind, 24).padEnd(6)} ${detail}`;
  const out: string[] = [];
  const content = o.message?.content;
  if ((o.type === "assistant" || o.type === "user") && Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === "text" && o.type === "assistant" && typeof b.text === "string") out.push(ev("say", clean(b.text)));
      else if (b?.type === "tool_use" && typeof b.name === "string") out.push(ev(b.name, argSummary(b.input)));
      else if (b?.type === "tool_result" && b.is_error === true) out.push(ev("ERROR", clean(textOf(b.content))));
    }
  }
  const p = o.type === "response_item" ? o.payload : undefined;
  if (p?.type === "message" && p.role === "assistant") {
    const t = clean(textOf(p.content));
    if (t) out.push(ev("say", t));
  } else if ((p?.type === "function_call" || p?.type === "custom_tool_call") && typeof p.name === "string") out.push(ev(p.name, argSummary(p.arguments ?? p.input)));
  return out;
}

/** Claude Code's project dir name for a cwd: every non-alphanumeric char becomes "-". */
export const claudeDir = (home: string, wt: string) => join(home, ".claude-aw", "projects", wt.replace(/[^A-Za-z0-9]/g, "-"));

export function newest(paths: string[]) {
  return paths.map((p) => ({ p, m: mtime(p) ?? -1 })).filter((x) => x.m >= 0).sort((a, b) => b.m - a.m)[0]?.p;
}

// Hand-walked: Bun's recursive readdir follows symlinked dirs, so a planted link could loop or walk the whole disk.
function jsonl(dir: string, recursive = false): string[] {
  try {
    if (!lstatSync(dir).isDirectory()) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      return recursive && e.isDirectory() ? jsonl(p, true) : e.isFile() && e.name.endsWith(".jsonl") ? [p] : [];
    });
  } catch {
    return [];
  }
}

const cwdOf = (o: any) => (o?.type === "session_meta" ? o.payload?.cwd : o?.cwd);

/** The first cwd recorded in a transcript's head (Codex session_meta, or any Claude entry). */
function headCwd(file: string) {
  return withFile(file, (fd) => {
    const buf = Buffer.alloc(CHUNK);
    for (const l of buf.toString("utf8", 0, readSync(fd, buf, 0, CHUNK, 0)).split("\n"))
      try {
        const c = cwdOf(JSON.parse(l));
        if (typeof c === "string") return c;
      } catch {}
  });
}

// Claude's dir mangling collides (a-b vs a.b) and Codex shares one dir, so both are matched on the recorded cwd.
const ownedBy = (files: string[], wt: string, since: number) =>
  files
    .map((p) => ({ p, m: mtime(p) ?? -1 }))
    .filter((x) => x.m >= since)
    .sort((a, b) => b.m - a.m)
    .find((x) => headCwd(x.p) === wt)?.p;

/** Newest transcript written for `wt` since `since` (ms) whose recorded cwd is `wt`. */
export function transcript(wt: string, agent?: Repo["agent"], home = homedir(), since = 0) {
  const claude = agent !== "codex" ? ownedBy(jsonl(claudeDir(home, wt)), wt, since) : undefined;
  const codex = agent !== "claude" ? ownedBy(jsonl(join(home, ".codex-aw", "sessions"), true), wt, since) : undefined;
  return newest([claude, codex].filter((p): p is string => !!p));
}

/** Worktree paths for a ticket id; falls back to configured repos so a finished ticket's transcript is still found. */
export function worktreesFor(cfg: Config, id: string) {
  if (!SAFE_ID.test(id)) throw new Error(`invalid ticket id ${JSON.stringify(id.slice(0, 70))}`);
  const onDisk = diskRepos(cfg).filter((k) => existsSync(join(repoDir(cfg, k), id)));
  return (onDisk.length ? onDisk : Object.keys(cfg.repos)).map((k) => ({ key: k, wt: join(repoDir(cfg, k), id) }));
}

/** Incremental event reader for one transcript: each call returns the events written since the last. */
export function reader(path: string) {
  let pos = 0;
  let file = "";
  return () =>
    withFile(path, (fd, st) => {
      // Replaced (new inode) or truncated: start over on the new content.
      if (`${st.dev}:${st.ino}` !== file || st.size < pos) [file, pos] = [`${st.dev}:${st.ino}`, 0];
      const r = lines(fd, st.size, pos);
      pos = r.next;
      return r.text.split("\n").flatMap(events);
    }) ?? [];
}

/** Prints the last `n` events of `<ID>` or `<owner/repo>/<ID>`'s newest transcript; with `follow`, keeps printing until `wait` resolves false. */
export async function tail(cfg: Config, target: string, n: number, follow: boolean, home = homedir(), print = (s: string) => console.log(s), wait = () => Bun.sleep(1000).then(() => true)) {
  const i = target.lastIndexOf("/");
  const [repo, id] = [i < 0 ? undefined : target.slice(0, i), target.slice(i + 1)];
  if (repo !== undefined && !validRepo(repo)) throw new Error(`invalid repo ${JSON.stringify(repo.slice(0, 70))}`);
  const all = worktreesFor(cfg, id);
  const candidates = repo ? [{ key: repo, wt: join(repoDir(cfg, repo), id) }] : all;
  const found = candidates.flatMap(({ key, wt }) => {
    const p = transcript(wt, cfg.repos[key]?.agent, home);
    return p ? [{ key, p }] : [];
  });
  if (found.length > 1) throw new Error(`${id} is in several repos (${found.map((f) => clean(f.key)).sort().join(", ")}); use aw tail <owner/repo>/${id}`);
  if (!found[0]) throw new Error(`no transcript found for ${clean(target)}`);
  const path = found[0].p;
  print(`# ${clean(path, 4096)}`);
  const next = reader(path);
  for (const e of next().slice(-n)) print(e);
  while (follow && (await wait())) for (const e of next()) print(e);
}
