import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { allowedRepo, repoDir, validRepo } from "./config";
import { deliverFeedback, feedbackFields } from "./feedback";
import { fileFindings } from "./findings";
import { canonical, findPr, sameRepo } from "./github";
import { claim, nonoRun, scopeUnit, SLOW_SECS, start, stopScope, sweepScopes, windows, winName } from "./launcher";
import { autoMerge } from "./merge";
import { syncPhases } from "./phases";
import { agentPane, deliverAnswer, liveStates, syncQuestion } from "./question";
import { lastSay, transcript } from "./tail";
import { type Adapter, TRACKERS } from "./trackers";
import type { Config, Io, Repo, Source, Ticket, Tracker } from "./types";
import { AW_DIR, byPriority, diskRepos, GIT, hasLabel, mtime, put, read, remove, SAFE_ID, strip, subdirs, write } from "./util";

const sourceOf = (dir: string, id: string) => {
  const f = join(dir, `${id}.source`);
  return existsSync(f) ? readFileSync(f, "utf8").trim() : undefined;
};
const hasTrace = (cfg: Config, key: string, id: string) => existsSync(join(repoDir(cfg, key), id)) || existsSync(join(repoDir(cfg, key), `${id}.source`));
// Linear only: ids are unique per workspace (one LINEAR_API_KEY), so the marker is shared by all Linear sources.
const rejectFile = (cfg: Config, id: string) => join(cfg.workspaceRoot, ".rejected", id);

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
    await tr.comment(t, reason);
  } catch (e) {
    remove(io, f);
    throw e;
  }
}

// GitHub ids are only unique per repo, so the listing repo decides; a Linear ticket keeps the repo it was started in,
// even one since removed from aw.json (then left alone). Only the source recorded in <ID>.source may act on a worktree.
function workRepo(cfg: Config, s: Source, tr: Tracker, t: Ticket) {
  const started = tr.globalIds ? diskRepos(cfg).find((k) => hasTrace(cfg, k, t.id)) : undefined;
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

async function startReady(cfg: Config, s: Source, tr: Tracker, io: Io, t: Ticket, wins: Map<string, string>, running: Map<string, number>, awDir: string) {
  if (!SAFE_ID.test(t.id)) return;
  // GitHub tickets always carry an allowlisted repo, so only Linear tickets are ever rejected.
  const key = allowedRepo(cfg, t.repo);
  if (!key) {
    if (tr.globalIds) await step(io, `reject ${t.id}`, () => reject(cfg, t, tr, io, notAllowed(t)));
    return;
  }
  const r = cfg.repos[key]!;
  if (wins.has(winName(key, t.id)) || (running.get(key) ?? 0) >= (r.maxConcurrent ?? Infinity)) return;
  const owner = sourceOf(repoDir(cfg, key), t.id);
  if (owner !== undefined && owner !== s.name) return io.log(`skip ${t.id}: ${key}/${t.id} belongs to source ${JSON.stringify(owner)}`);
  const other = tr.globalIds && startedElsewhere(cfg, key, t.id, wins);
  if (other) return io.log(`skip ${t.id}: already started in ${other}`);
  // Uncached: a transfer must stop new clones and starts at once, not after the listing cache expires.
  const name = await canonical(io, key, true);
  if (!name) return;
  if (!sameRepo(name, key)) {
    if (tr.globalIds) await step(io, `reject ${t.id}`, () => reject(cfg, t, tr, io, `repo ${key} now resolves to ${name} on GitHub, which is not in the aw allowlist`));
    return;
  }
  await step(io, `start ${t.id}`, async () => {
    await start(cfg, s, r, { ...t, repo: key }, tr, io, awDir);
    wins.set(winName(key, t.id), "new");
    running.set(key, (running.get(key) ?? 0) + 1);
  });
}

function lastMessage(wt: string, agent: Repo["agent"]) {
  try {
    return lastSay(wt, agent, mtime(`${wt}.sh`) ?? mtime(wt) ?? 0);
  } catch {
    return undefined;
  }
}

const MAX_SAY = 1500;

/** `head`, then untrusted `text` as `label`: capped, sanitized and fenced so it cannot close the fence; just `head` when empty. */
export function quoted(head: string, label: string, text: string | undefined) {
  const cps = [...(text ?? "").split("\n").map((l) => strip(l).trimEnd()).join("\n").replace(/^\s*\n/, "").trimEnd()];
  if (!cps.length) return head;
  const body = (cps.length > MAX_SAY ? "…" : "") + cps.slice(-MAX_SAY).join("");
  const fence = "`".repeat(Math.max(3, ...(body.match(/`+/g) ?? []).map((r) => r.length + 1)));
  return `${head}. ${label}:\n\n${fence}\n${body}\n${fence}`;
}

export const endedNotice = (say: string | undefined) => quoted("session ended without a PR", "Last message", say);

// Transcript writes, not tmux activity: the agent's spinner redraws the pane while it is busy, even when stuck.
// `<ID>.stall` holds the activity stamp already reported, so one stall gets one comment; a failed comment retries once unparked.
async function checkStall(cfg: Config, s: Source, r: Repo, t: Ticket, tr: Tracker, io: Io, dir: string, win: string, state: ReturnType<typeof liveStates>) {
  const now = Date.now();
  const wt = join(dir, t.id);
  const started = mtime(`${wt}.sh`) ?? mtime(wt) ?? now;
  const quiet = (since: number) => now - since >= cfg.stallMinutes * 60_000;
  if (!quiet(started) || (await state(r, dir, t.id, now, true)) !== "working") return;
  const tx = transcript(wt, r.agent, io.home, started);
  const at = Math.max(started, (tx ? mtime(tx) : undefined) ?? 0);
  const file = join(dir, `${t.id}.stall`);
  if (!quiet(at) || (existsSync(file) && readFileSync(file, "utf8").trim() === String(at)) || !/^@\d+$/.test(win)) return;
  // The launcher's own pane only: a human's split may hold secrets.
  const pane = await agentPane(io, win, `${wt}.sh`).catch(() => undefined);
  const lines = pane ? await read(io, ["tmux", "capture-pane", "-p", "-t", pane, "-S", "-20"]).catch(() => "") : "";
  await tr.park(t);
  t.labels = [...(t.labels ?? []), s.needsHumanLabel];
  await tr.comment(t, quoted(`session working with no activity for ${Math.floor((now - at) / 60_000)} min; parked with ${s.needsHumanLabel}, left running`, "Last pane lines", lines));
  put(io, file, String(at));
}

async function reconcileSource(cfg: Config, s: Source, tr: Tracker, io: Io, wins: Map<string, string>, state: ReturnType<typeof liveStates>) {
  await step(io, "list in-progress", async () => {
    for (const t of await tr.listInProgress())
      await step(io, `check ${t.id}`, async () => {
        const key = SAFE_ID.test(t.id) && workRepo(cfg, s, tr, t);
        if (!key) return;
        const w = { ...t, repo: key };
        const dir = repoDir(cfg, key);
        const pr = await findPr(key, t.id, io, dir);
        await step(io, `phases ${t.id}`, () => syncPhases(w, tr, io, dir, !!pr));
        if (pr) {
          if (!hasLabel(t.labels, s.needsHumanLabel)) await step(io, `findings ${t.id}`, () => fileFindings(w, tr, io, dir));
          return tr.toReview(w, pr);
        }
        const ended = join(dir, `${t.id}.ended`);
        const win = wins.get(winName(key, t.id));
        if (win) {
          if (!hasLabel(t.labels, s.needsHumanLabel)) await step(io, `stall ${t.id}`, () => checkStall(cfg, s, cfg.repos[key]!, w, tr, io, dir, win, state));
          await step(io, `question ${t.id}`, () => syncQuestion(w, tr, io, dir, join(dir, t.id)));
          return step(io, `answer ${t.id}`, () => deliverAnswer(cfg.repos[key]!, w, tr, io, dir, win, scopeUnit(cfg, key, t.id), () => state(cfg.repos[key]!, dir, t.id)));
        }
        // The in-progress listing can lag a close that cleanup already acted on.
        if (hasLabel(t.labels, s.needsHumanLabel)) return;
        if (existsSync(ended)) {
          const seen = `${ended}@${statSync(ended).mtimeMs}`;
          if (warned.has(seen) || (await tr.closed(t.id, key))) return;
          warned.add(seen);
          return io.log(`${key}/${t.id}: session ended, ticket still in progress; ${tr.restartHint()} to start it again`);
        }
        if (await tr.closed(t.id, key)) return;
        await tr.comment(w, endedNotice(lastMessage(join(dir, t.id), cfg.repos[key]!.agent)));
        put(io, ended, new Date().toISOString());
      });
  });

  // Retries a final sync that failed when the parent moved to review; a no-op once in sync.
  await step(io, "list in-review", async () => {
    for (const t of await tr.listInReview()) {
      const key = SAFE_ID.test(t.id) && workRepo(cfg, s, tr, t);
      if (!key) continue;
      const w = { ...t, repo: key };
      const dir = repoDir(cfg, key);
      const r = cfg.repos[key]!;
      const win = wins.get(winName(key, t.id));
      // checkStall marks w parked, so feedback and auto-merge stop in the same poll.
      if (win && !hasLabel(w.labels, s.needsHumanLabel)) await step(io, `stall ${t.id}`, () => checkStall(cfg, s, r, w, tr, io, dir, win, state));
      const parked = hasLabel(w.labels, s.needsHumanLabel);
      await step(io, `phases ${t.id}`, () => syncPhases(w, tr, io, dir, true));
      if (!parked) await step(io, `findings ${t.id}`, () => fileFindings(w, tr, io, dir));
      const share: { fields: string; pr?: any } | undefined = parked ? undefined : { fields: feedbackFields(r) };
      if (r.autoMerge !== "off") await step(io, `merge ${t.id}`, () => autoMerge(cfg, r, w, tr, io, parked, share));
      // autoMerge looks the PR up anyway; otherwise every poll too, so a replaced PR reaches `<ID>.pr` (and feedback).
      else await step(io, `pr ${t.id}`, () => findPr(key, t.id, io, dir));
      if (!parked) await step(io, `feedback ${t.id}`, () => deliverFeedback(r, w, tr, io, dir, win, scopeUnit(cfg, key, t.id), () => state(r, dir, t.id), warned, share?.pr));
    }
  });
}

export const worktreeIds = (dir: string) => subdirs(dir).filter((d) => SAFE_ID.test(d));

export function makeTracker(s: Source, host: string, io: Io, defaultHost: boolean, repos: string[]) {
  return (TRACKERS[s.tracker] as Adapter<Source>).make(s, host, io, defaultHost, repos);
}

const warned = new Set<string>();

export async function pass(cfg: Config, io: Io, tracker = makeTracker, awDir = AW_DIR, state = liveStates()) {
  if ((await io.run(["tmux", "has-session", "-t", `=${cfg.tmuxSession}`])).code !== 0)
    await write(io, ["tmux", "new-session", "-d", "-s", cfg.tmuxSession]).catch((e) => io.log(`tmux: ${e.message}`));
  const srcs = new Map(
    cfg.sources.map((s) => {
      const sio = { ...io, log: (m: string) => io.log(`[${s.name}] ${m}`) };
      return [s.name, { s, io: sio, tr: tracker(s, cfg.host, sio, cfg.defaultHost, Object.keys(cfg.repos)) }];
    }),
  );
  const wins = await windows(cfg, io);
  await step(io, "sweep scopes", () => sweepScopes(cfg, io));

  const lists = new Map<string, Promise<Ticket[]>>();
  const listReady = (x: { s: Source; tr: Tracker }) => lists.get(x.s.name) ?? lists.set(x.s.name, x.tr.listReady()).get(x.s.name)!;
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
        const end = await x.tr.closed(id, r.key);
        const pending = join(dir, `${id}.claim`);
        if (!end && wins.has(winName(r.key, id)) && existsSync(pending)) {
          // Only a ticket still ready is claimed, so a newer move by a human wins.
          const t = (await listReady(x)).find((k) => k.id === id && allowedRepo(cfg, k.repo) === r.key);
          if (t) await claim(x.io, x.tr, pending, { ...t, repo: r.key });
        }
        if (!end) return;
        const w = wins.get(winName(r.key, id));
        if (end === "canceled" && !w && existsSync(join(dir, `${id}.ended`))) return;
        await stopScope(cfg, x.io, r.key, id);
        // Killing the scope usually closes the window first.
        if (w)
          await write(x.io, ["tmux", "kill-window", "-t", w]).catch((e) => {
            if (!/can't find window/.test(e.message)) throw e;
          });
        wins.delete(winName(r.key, id));
        if (end === "canceled") {
          if (existsSync(join(dir, `${id}.ended`))) return;
          put(x.io, join(dir, `${id}.ended`), new Date().toISOString());
          return x.io.log(`stopped ${r.key}/${id}: ticket canceled; clone and files kept`);
        }
        const wt = join(dir, id);
        if (!lstatSync(join(wt, ".git"), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${wt}/.git is not a directory; left in place`);
        // The session controls its .git (config, filters, commondir), so git checks it sandboxed: read-only, no network, no credentials; aw then deletes without git.
        // A planted filter can block git; the runner's deadline kills its whole process group.
        const box = r.sandbox === "nono" ? nonoRun("aw-check", awDir, [["--read", wt], ["--read", join(r.path, ".git", "objects")]]) : [];
        // A fresh clone has no tags (--revision, tagOpt=--no-tags), so any tag, stash or note is the session's own.
        const checks = [["status", "--porcelain", "--ignore-submodules=none"], ["log", "--format=%h", "--branches", "--not", "--remotes"], ["for-each-ref", "--format=%(refname)", "refs/tags", "refs/stash", "refs/notes"]];
        for (const c of checks) if ((await write(x.io, [...box, ...GIT, "-C", wt, ...c])).trim()) throw new Error(`${wt} has uncommitted, untracked or unpushed work; left in place`);
        // rm never follows symlinks.
        await write(x.io, ["rm", "-rf", "--one-file-system", "--", wt], undefined, SLOW_SECS);
        // After the clone, so a delete that fails keeps the transcripts too.
        for (const ext of [".claude", ".codex", ".tmpdir", ".prompt.md", ".sh", ".ended", ".phases.json", ".merge", ".pr", ".question", ".feedback", ".stall", ".findings", ".claim", ".source"]) remove(x.io, join(dir, id + ext));
      });
    }
  }

  const running = new Map<string, number>();
  for (const n of wins.keys()) {
    const k = n.slice(0, n.lastIndexOf("/"));
    if (Object.hasOwn(cfg.repos, k)) running.set(k, (running.get(k) ?? 0) + 1);
  }
  const total = () => [...running.values()].reduce((a, b) => a + b, 0);
  if (total() < cfg.maxConcurrent) {
    const ready: { s: Source; io: Io; tr: Tracker; t: Ticket }[] = [];
    for (const x of srcs.values()) await step(x.io, "list ready", async () => void ready.push(...(await listReady(x)).map((t) => ({ ...x, t }))));
    // Stable sort: equal priorities keep source order, then tracker order.
    ready.sort((a, b) => byPriority(a.t, b.t));
    for (const { s, io: sio, tr, t } of ready) {
      if (total() >= cfg.maxConcurrent) break;
      await step(sio, `ready ${t.id}`, () => startReady(cfg, s, tr, sio, t, wins, running, awDir));
    }
  }
  for (const { s, io: sio, tr } of srcs.values()) {
    try {
      await reconcileSource(cfg, s, tr, sio, wins, state);
    } catch (e) {
      sio.log(`source failed: ${(e as Error).message}`);
    }
  }
}
