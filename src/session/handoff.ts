import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENTS, agentOf } from "./agents";
import { repoDir, validRepo } from "../config/config";
import { stopSession, windows } from "./launcher";
import { transcript, withFile } from "../ui/tail";
import type { AgentName, Config, Io } from "../types";
import { diskRepos, passLocked, put, SAFE_ID } from "../util";

export const TOOLS = ["claude", "codex", "t3", "editor"] as const;
export type Tool = (typeof TOOLS)[number];

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Where each agent keeps a transcript under its store, relative to it; the capture is the id its resume takes.
const SHAPE: Record<AgentName, [sub: string, re: RegExp]> = {
  claude: ["projects", new RegExp(`^[^/]+/(${UUID})\\.jsonl$`)],
  codex: ["sessions", new RegExp(`^\\d{4}/\\d{2}/\\d{2}/rollout-[\\dT-]+-(${UUID})\\.jsonl$`)],
};

/** The repo and clone of `<ID>` or `<owner/repo>/<ID>`; throws unless exactly one clone exists. */
export function ticketClone(cfg: Config, target: string) {
  const i = target.lastIndexOf("/");
  const [repo, id] = [i < 0 ? undefined : target.slice(0, i), target.slice(i + 1)];
  if (repo !== undefined && !validRepo(repo)) throw new Error(`invalid repo ${JSON.stringify(repo.slice(0, 70))}`);
  if (!SAFE_ID.test(id)) throw new Error(`invalid ticket id ${JSON.stringify(id.slice(0, 70))}`);
  const keys = (repo ? [repo] : diskRepos(cfg)).filter((k) => lstatSync(join(repoDir(cfg, k), id), { throwIfNoEntry: false })?.isDirectory());
  if (keys.length > 1) throw new Error(`${id} is in several repos (${keys.sort().join(", ")}); use <owner/repo>/${id}`);
  if (!keys[0]) throw new Error(`${target} has no worktree`);
  return { key: keys[0], dir: repoDir(cfg, keys[0]), id, wt: join(repoDir(cfg, keys[0]), id) };
}

/** Copies `wt`'s newest `agent` transcript into the person's own store and returns its session id; an existing copy is kept, as they may have continued it. */
export function adopt(agent: AgentName, wt: string, store: string) {
  const p = transcript(wt, agent, "");
  if (!p) return;
  const [home, sub] = AGENTS[agent].store(wt);
  const own = join(realpathSync(home), sub) + "/";
  // One open: where the fd really points, so a link planted in the agent-writable store is refused.
  const found = withFile(p, (fd) => {
    const real = readlinkSync(`/proc/self/fd/${fd}`);
    const rel = real.startsWith(own) ? real.slice(own.length) : "";
    const id = SHAPE[agent][1].exec(rel)?.[1];
    return id ? { rel, id, data: readFileSync(fd) } : undefined;
  });
  if (!found) return;
  const dest = join(store, SHAPE[agent][0], found.rel);
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(dest, found.data, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return found.id;
}

/** What to run from the clone: a resume when `session` is the tool's own, a fresh session told about the earlier work otherwise; nothing for t3. */
export function toolArgv(tool: Tool, session: string | undefined, prompt: string, editor: string | undefined): string[] {
  if (tool === "claude") return session ? ["claude", "--resume", session] : ["claude", prompt];
  if (tool === "codex") return session ? ["codex", "resume", session] : ["codex", prompt];
  if (tool === "t3") return [];
  if (!editor?.trim()) throw new Error("set $VISUAL or $EDITOR");
  // Through sh, as git runs it: the value may quote a path with spaces or carry flags.
  return ["sh", "-c", `${editor} "$@"`, "sh", "."];
}

const word = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);
/** `argv` run from `cwd` as one line that is safe to paste into a POSIX shell. */
export const shellLine = (cwd: string, argv: string[]) => `cd ${word(cwd)} && ${argv.map(word).join(" ")}`;

/** Parks `<ID>` with `<ID>.handoff`, stops its session and returns what to run to continue it in `tool` (default: the agent it ran). */
export const handoff = (cfg: Config, io: Io, target: string, tool: Tool | undefined, stores: Record<AgentName, string>, editor?: string) =>
  passLocked(cfg, io.log, () => handoffLocked(cfg, io, target, tool, stores, editor));

async function handoffLocked(cfg: Config, io: Io, target: string, tool: Tool | undefined, stores: Record<AgentName, string>, editor?: string) {
  const { key, dir, id, wt } = ticketClone(cfg, target);
  const agent = agentOf(dir, id);
  const use = tool ?? agent;
  // A missing editor fails before anything is stopped.
  if (use === "editor") toolArgv(use, undefined, "", editor);
  put(io, join(dir, `${id}.handoff`), `${use}\n`);
  io.event?.("handoff", key, id, { tool: use });
  const wins = await windows(cfg, io);
  if (!wins.listed) throw new Error("tmux windows unknown; not handed off");
  await stopSession(cfg, io, key, id, wins);
  const session = use === agent ? adopt(agent, wt, stores[agent]) : undefined;
  if (session) io.log("this history was written inside the sandbox; resuming it runs with your own login, settings and permissions");
  const tx = transcript(wt, agent, "");
  const prompt = `Continue ticket ${id} in this clone, on branch agent/${id}. The task is in ${join(dir, `${id}.prompt.md`)}${tx ? `; the earlier session's transcript is ${tx}` : ""}; tender's run files are in .tender/run/. Check git status and git log first.`;
  return { key, id, wt, argv: toolArgv(use, session, prompt, editor) };
}
