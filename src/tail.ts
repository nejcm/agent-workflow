import { closeSync, constants as C, existsSync, fstatSync, openSync, readlinkSync, readSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Agent, AGENTS } from "./agents";
import { repoDir, validRepo } from "./config";
import type { Config, Repo } from "./types";
import { clean, diskRepos, mtime, SAFE_ID } from "./util";

const CHUNK = 256 * 1024;

const seg = new Intl.Segmenter();

/** `s` truncated (with …) or padded to exactly `w` terminal columns. */
export function fit(s: string, w: number) {
  if (w <= 0) return "";
  const sw = Bun.stringWidth(s);
  if (sw <= w) return s + " ".repeat(w - sw);
  let out = "";
  let n = 0;
  for (const { segment } of seg.segment(s)) {
    const cw = Bun.stringWidth(segment);
    if (n + cw > w - 1) break;
    out += segment;
    n += cw;
  }
  return out + "…" + " ".repeat(w - 1 - n);
}

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

export const KIND = 6;

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
  const ev = (kind: string, detail: string) => `${at} ${fit(clean(kind, 24), KIND)} ${detail}`;
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

const sayText = (o: any) =>
  o?.type === "assistant" ? textOf(o.message?.content) : o?.type === "response_item" && o.payload?.type === "message" && o.payload.role === "assistant" ? textOf(o.payload.content) : "";

/** Raw, untrusted text of the last non-empty assistant message in `wt`'s newest transcript (since `since` ms). */
export function lastSay(wt: string, agent: Repo["agent"], since = 0) {
  const p = transcript(wt, agent, "", since);
  if (!p) return undefined;
  const [home, sub] = AGENTS[agent].store(wt);
  const own = join(realpathSync(home), sub) + "/";
  // One open: where the fd really points and what it records, so a dir swapped in after the lookup is refused.
  return withFile(p, (fd, st) => {
    if (!readlinkSync(`/proc/self/fd/${fd}`).startsWith(own) || fdCwd(fd, AGENTS[agent].cwd) !== wt) return undefined;
    const from = Math.max(0, st.size - CHUNK - 1);
    const buf = Buffer.alloc(st.size - from);
    const b = buf.subarray(0, readSync(fd, buf, 0, buf.length, from));
    const nl = from > 0 ? b.indexOf(10) : -1;
    if (from > 0 && nl < 0) return undefined;
    const ls = b.toString("utf8", nl + 1).split("\n");
    for (let i = ls.length - 1; i >= 0; i--)
      try {
        const t = sayText(JSON.parse(ls[i]!));
        if (t.trim()) return t;
      } catch {}
  });
}

export function newest(paths: string[]) {
  return paths.map((p) => ({ p, m: mtime(p) ?? -1 })).filter((x) => x.m >= 0).sort((a, b) => b.m - a.m)[0]?.p;
}

/** The first cwd recorded in an open transcript's head. */
function fdCwd(fd: number, cwdOf: Agent["cwd"]) {
  const buf = Buffer.alloc(CHUNK);
  for (const l of buf.toString("utf8", 0, readSync(fd, buf, 0, CHUNK, 0)).split("\n"))
    try {
      const c = cwdOf(JSON.parse(l));
      if (typeof c === "string") return c;
    } catch {}
}

const headCwd = (file: string, cwdOf: Agent["cwd"]) => withFile(file, (fd) => fdCwd(fd, cwdOf));

// Claude's dir mangling collides (a-b vs a.b) and Codex keeps every cwd in one dir, so both are matched on the recorded cwd.
const ownedBy = (a: Agent, wt: string, home: string, since: number) =>
  a
    .transcripts(wt, home)
    .map((p) => ({ p, m: mtime(p) ?? -1 }))
    .filter((x) => x.m >= since)
    .sort((a, b) => b.m - a.m)
    .find((x) => headCwd(x.p, a.cwd) === wt)?.p;

/** Newest transcript written for `wt` since `since` (ms) whose recorded cwd is `wt`. */
export function transcript(wt: string, agent?: Repo["agent"], home = homedir(), since = 0) {
  return newest((agent ? [AGENTS[agent]] : Object.values(AGENTS)).flatMap((a) => ownedBy(a, wt, home, since) ?? []));
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

/** Events from the transcript at `p`, restarting on a new `p`; `switched` is true on the call where it changed. */
export function follower() {
  let path: string | null = null;
  let next: (() => string[]) | undefined;
  return (p: string | null) => {
    const switched = p !== path;
    if (switched) [path, next] = [p, p ? reader(p) : undefined];
    return { switched, events: next?.() ?? [] };
  };
}

/** Prints the last `n` events of `<ID>` or `<owner/repo>/<ID>`'s newest transcript; with `follow`, keeps printing (switching to a newer transcript) until `wait` resolves false. */
export async function tail(cfg: Config, target: string, n: number, follow: boolean, home = homedir(), print = (s: string) => console.log(s), wait = () => Bun.sleep(1000).then(() => true)) {
  const i = target.lastIndexOf("/");
  const [repo, id] = [i < 0 ? undefined : target.slice(0, i), target.slice(i + 1)];
  if (repo !== undefined && !validRepo(repo)) throw new Error(`invalid repo ${JSON.stringify(repo.slice(0, 70))}`);
  const all = worktreesFor(cfg, id);
  const candidates = repo ? [{ key: repo, wt: join(repoDir(cfg, repo), id) }] : all;
  const found = candidates.flatMap(({ key, wt }) => {
    const p = transcript(wt, cfg.repos[key]?.agent, home);
    return p ? [{ key, wt, p }] : [];
  });
  if (found.length > 1) throw new Error(`${id} is in several repos (${found.map((f) => clean(f.key)).sort().join(", ")}); use aw tail <owner/repo>/${id}`);
  if (!found[0]) throw new Error(`no transcript found for ${clean(target)}`);
  const { key, wt } = found[0];
  let path = found[0].p;
  const read = follower();
  const next = () => {
    const r = read(path);
    if (r.switched) print(`# ${clean(path, 4096)}`);
    return r.events;
  };
  for (const e of next().slice(-n)) print(e);
  // A gone or unreadable newest keeps the current one rather than replaying it from the start later.
  while (follow && (await wait())) {
    path = transcript(wt, cfg.repos[key]?.agent, home) ?? path;
    for (const e of next()) print(e);
  }
}
