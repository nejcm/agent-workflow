import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { allowedRepo, repoDir, validRepo } from "./config";
import { deliverFeedback, feedbackFields } from "./feedback";
import { fileFindings } from "./findings";
import { agentOf } from "./agents";
import { baseBranch, canonical, findPr, sameRepo } from "./github";
import { claim, cloned, handedOff, nonoRun, scopeUnit, start, stopSession, sweepScopes, windows, winName } from "./launcher";
import { autoMerge, checkState, PR_FIELDS, prMode, prReady, viewPr } from "./merge";
import { syncPhases } from "./phases";
import { agentPane, deliverAnswer, liveStates, syncQuestion } from "./question";
import { combine, loadSession, parseRepoConfig } from "./repo-config";
import { lastSay, transcript } from "./tail";
import { type Adapter, TRACKERS } from "./trackers";
import type { ProjectClaim } from "./trackers/linear";
import type { Config, Io, Repo, Session, Source, Ticket, Tracker } from "./types";
import { TENDER_DIR, byPriority, diskRepos, GIT, hasLabel, mtime, put, read, remove, SAFE_ID, SLOW_SECS, strip, subdirs, write } from "./util";

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

const NO_REPO = "no repo set on this ticket: add a `repo:owner/name` label or a `repo: owner/name` line to its description, or have exactly one repo claim its Linear project in .tender/config.yaml";

const notAllowed = (t: Ticket) => (!t.repo ? NO_REPO : validRepo(t.repo) ? `repo ${t.repo} is not in the tender allowlist` : `repo ${JSON.stringify(t.repo.slice(0, 100))} is not a valid owner/name`);

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
// even one since removed from tender.json (then left alone). Only the source recorded in <ID>.source may act on a worktree.
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

async function startReady(cfg: Config, s: Source, tr: Tracker, io: Io, t: Ticket, wins: Map<string, string>, running: Map<string, number>, reviewing: Map<string, number>, tenderDir: string) {
  if (!SAFE_ID.test(t.id)) return;
  // GitHub tickets always carry an allowlisted repo, so only Linear tickets are ever rejected.
  const key = allowedRepo(cfg, t.repo);
  if (!key) {
    if (tr.globalIds) await step(io, `reject ${t.id}`, () => reject(cfg, t, tr, io, notAllowed(t)));
    return;
  }
  const r = cfg.repos[key]!;
  if (wins.has(winName(key, t.id)) || handedOff(repoDir(cfg, key), t.id) || (running.get(key) ?? 0) >= (r.maxConcurrent ?? Infinity) || (reviewing.get(key) ?? 0) >= (r.maxInReview ?? Infinity)) return;
  const owner = sourceOf(repoDir(cfg, key), t.id);
  if (owner !== undefined && owner !== s.name) return io.log(`skip ${t.id}: ${key}/${t.id} belongs to source ${JSON.stringify(owner)}`);
  const other = tr.globalIds && startedElsewhere(cfg, key, t.id, wins);
  if (other) return io.log(`skip ${t.id}: already started in ${other}`);
  // Uncached: a transfer must stop new clones and starts at once, not after the listing cache expires.
  const name = await canonical(io, key, true);
  if (!name) return;
  if (!sameRepo(name, key)) {
    if (tr.globalIds) await step(io, `reject ${t.id}`, () => reject(cfg, t, tr, io, `repo ${key} now resolves to ${name} on GitHub, which is not in the tender allowlist`));
    return;
  }
  await step(io, `start ${t.id}`, async () => {
    if (!(await start(cfg, s, r, { ...t, repo: key }, tr, io, tenderDir))) return;
    wins.set(winName(key, t.id), "new");
    running.set(key, (running.get(key) ?? 0) + 1);
  });
}

function lastMessage(dir: string, id: string) {
  const wt = join(dir, id);
  try {
    return lastSay(wt, agentOf(dir, id), mtime(`${wt}.sh`) ?? mtime(wt) ?? 0);
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
async function checkStall(cfg: Config, s: Source, t: Ticket, tr: Tracker, io: Io, dir: string, win: string, state: ReturnType<typeof liveStates>) {
  const now = Date.now();
  const wt = join(dir, t.id);
  const started = mtime(`${wt}.sh`) ?? mtime(wt) ?? now;
  const quiet = (since: number) => now - since >= cfg.stallMinutes * 60_000;
  if (!quiet(started) || (await state(dir, t.id, now, true)) !== "working") return;
  const tx = transcript(wt, agentOf(dir, t.id), io.home, started);
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

// Like a cancel, plus one comment per reassignment: `<ID>.reassigned` is marked before posting and removed if the post fails.
async function stopReassigned(cfg: Config, tr: Tracker, io: Io, t: Ticket & { repo: string }, wins: Map<string, string>) {
  const dir = repoDir(cfg, t.repo);
  const ended = join(dir, `${t.id}.ended`);
  const told = join(dir, `${t.id}.reassigned`);
  if (!existsSync(join(dir, t.id))) return;
  if (wins.has(winName(t.repo, t.id)) || !existsSync(ended)) {
    await stopSession(cfg, io, t.repo, t.id, wins);
    put(io, ended, new Date().toISOString());
    io.log(`stopped ${t.repo}/${t.id}: reassigned to ${JSON.stringify(t.otherAssignee)}; clone and files kept`);
  }
  if (existsSync(told)) return;
  put(io, told, t.otherAssignee!);
  try {
    await tr.comment(t, `stopped, reassigned to ${t.otherAssignee}`);
  } catch (e) {
    remove(io, told);
    throw e;
  }
}

async function reconcileSource(cfg: Config, s: Source, tr: Tracker, io: Io, wins: Map<string, string>, state: ReturnType<typeof liveStates>, sessions: Map<string, Promise<Session | undefined>>) {
  await step(io, "list in-progress", async () => {
    for (const t of await tr.listInProgress())
      await step(io, `check ${t.id}`, async () => {
        const key = SAFE_ID.test(t.id) && workRepo(cfg, s, tr, t);
        if (!key) return;
        const w = { ...t, repo: key };
        if (t.otherAssignee) return stopReassigned(cfg, tr, io, w, wins);
        const dir = repoDir(cfg, key);
        const parked = hasLabel(t.labels, s.needsHumanLabel) || handedOff(dir, t.id);
        const pr = await findPr(key, t.id, io, dir);
        await step(io, `phases ${t.id}`, () => syncPhases(w, tr, io, dir, !!pr));
        if (pr) {
          if (!parked) await step(io, `findings ${t.id}`, () => fileFindings(w, tr, io, dir));
          return tr.toReview(w, `PR: ${pr}`);
        }
        const ended = join(dir, `${t.id}.ended`);
        const win = wins.get(winName(key, t.id));
        if (win) {
          if (!parked) await step(io, `stall ${t.id}`, () => checkStall(cfg, s, w, tr, io, dir, win, state));
          await step(io, `question ${t.id}`, () => syncQuestion(w, tr, io, dir, join(dir, t.id)));
          return step(io, `answer ${t.id}`, () => deliverAnswer(cfg.repos[key]!, w, tr, io, dir, win, scopeUnit(cfg, key, t.id), () => state(dir, t.id)));
        }
        // The in-progress listing can lag a close that cleanup already acted on.
        if (parked) return;
        if (existsSync(ended)) {
          const seen = `${ended}@${statSync(ended).mtimeMs}`;
          if (warned.has(seen) || (await tr.closed(t.id, key))) return;
          warned.add(seen);
          return io.log(`${key}/${t.id}: session ended, ticket still in progress; ${tr.restartHint()} to start it again`);
        }
        if (await tr.closed(t.id, key)) return;
        await tr.comment(w, endedNotice(lastMessage(dir, t.id)));
        put(io, ended, new Date().toISOString());
      });
  });

  // Retries a final sync that failed when the parent moved to review; a no-op once in sync.
  await step(io, "list in-review", async () => {
    for (const t of await tr.listInReview()) {
      const key = SAFE_ID.test(t.id) && workRepo(cfg, s, tr, t);
      if (!key) continue;
      const w = { ...t, repo: key };
      if (t.otherAssignee) {
        await step(io, `reassigned ${t.id}`, () => stopReassigned(cfg, tr, io, w, wins));
        continue;
      }
      const dir = repoDir(cfg, key);
      const r = cfg.repos[key]!;
      const win = wins.get(winName(key, t.id));
      // A hand-off parks too, so its killed window never reads as a finished session for Ready to merge.
      const handoff = handedOff(dir, t.id);
      // checkStall marks w parked, so feedback and auto-merge stop in the same poll.
      if (win && !handoff && !hasLabel(w.labels, s.needsHumanLabel)) await step(io, `stall ${t.id}`, () => checkStall(cfg, s, w, tr, io, dir, win, state));
      const parked = handoff || hasLabel(w.labels, s.needsHumanLabel);
      await step(io, `phases ${t.id}`, () => syncPhases(w, tr, io, dir, true));
      if (!parked) await step(io, `findings ${t.id}`, () => fileFindings(w, tr, io, dir));
      const share: { fields: string; pr?: any } | undefined = parked ? undefined : { fields: feedbackFields(r) };
      let pr: any;
      // Fetched once per repo per pass, so a policy tightened on the base branch applies to PRs already in review.
      const fresh = r.autoMerge === "off" ? undefined : sessionOf(io, sessions, r);
      const ses = await fresh?.catch((e) => void io.log(`merge ${t.id} failed: ${e.message}`));
      if (ses && prMode(ses) !== "off") await step(io, `merge ${t.id}`, async () => void (pr = await autoMerge(cfg, ses, w, tr, io, parked, share)));
      // Invalid .tender/ or a failed fetch: no decision or comment, but a PR merged by hand still moves the ticket.
      else if (fresh && !ses) await step(io, `merge ${t.id}`, async () => void (pr = await autoMerge(cfg, combine(r, await baseBranch(io, r), parseRepoConfig([])), w, tr, io, true)));
      // autoMerge looks the PR up anyway; otherwise every poll too, so a replaced PR reaches `<ID>.pr` (and feedback).
      else
        await step(io, `pr ${t.id}`, async () => {
          const n = /\/pull\/(\d+)$/.exec((await findPr(key, t.id, io, dir)) ?? "")?.[1];
          if (n && share) pr = share.pr = await viewPr(io, key, n, PR_FIELDS + share.fields);
        });
      if (parked) continue;
      // A view taken before an awaited comment or files call is stale; a closed PR is not found, so its recorded one is viewed.
      const prFile = join(dir, `${t.id}.pr`);
      const n = pr ? (pr !== share!.pr ? String(pr.number) : undefined) : w.readyToMerge && existsSync(prFile) ? /\/pull\/(\d+)$/.exec(readFileSync(prFile, "utf8"))?.[1] : undefined;
      if (n) {
        pr = undefined;
        await step(io, `pr ${t.id}`, async () => void (pr = share!.pr = await viewPr(io, key, n, PR_FIELDS + share!.fields)));
      }
      let clear: boolean | undefined;
      await step(io, `feedback ${t.id}`, async () => void (clear = await deliverFeedback(r, w, tr, io, dir, win, scopeUnit(cfg, key, t.id), () => state(dir, t.id), warned, share)));
      pr &&= share!.pr;
      // Never from the live state, which the session writes: ended is a listing without the window, idle is tmux's own output clock.
      // Listed again with its clock at the decision, since a pass can outlast IDLE_SECS.
      const done = async () => {
        const now = await windows(cfg, io);
        const name = winName(key, t.id);
        return now.has(name) ? Date.now() / 1000 - now.activity.get(name)! >= IDLE_SECS : now.listed;
      };
      if (pr && tr.toReadyToMerge) await step(io, `ready ${t.id}`, () => syncReady(w, tr, io, dir, pr, clear, done));
    }
  });
}

// Promoted from GitHub's view and tender's own state only. `<ID>.ready` holds the head it was promoted at, so it can only demote.
async function syncReady(t: Ticket, tr: Tracker, io: Io, dir: string, pr: any, clear: boolean | undefined, done: () => Promise<boolean>) {
  const f = join(dir, `${t.id}.ready`);
  if (pr.state === "MERGED") return;
  if (t.readyToMerge) {
    // Moved there by hand: the head first seen counts. The listing confirms a pending move.
    const saved = existsSync(f) ? readFileSync(f, "utf8") : undefined;
    const at = saved?.replace(PENDING, "") ?? pr.headRefOid;
    if (saved !== at) put(io, f, at);
    const why =
      pr.state !== "OPEN" ? `PR is ${pr.state}`
      : pr.isDraft ? "PR is a draft"
      : at !== pr.headRefOid ? "new commits"
      : pr.mergeable === "CONFLICTING" ? "merge conflicts"
      : pr.statusCheckRollup.some((c: any) => checkState(c) === "failed") ? "a check failed"
      : pr.reviewDecision === "CHANGES_REQUESTED" ? "changes requested"
      : clear === false ? "new feedback"
      : undefined;
    if (!why) return;
    await tr.toReview(t, `back in review, ${why}: ${pr.url}`);
    return remove(io, f);
  }
  if (clear !== true || !prReady(pr) || !(await done())) return remove(io, f);
  // Before the move, so a move that lands without its comment still has a head to demote from.
  put(io, f, pr.headRefOid + PENDING);
  await tr.toReadyToMerge!(t, `ready to merge: ${pr.url}`);
  put(io, f, pr.headRefOid);
}

const IDLE_SECS = 5 * 60;
export const PENDING = " pending";

export const worktreeIds = (dir: string) => subdirs(dir).filter((d) => SAFE_ID.test(d));

export function makeTracker(s: Source, host: string, io: Io, defaultHost: boolean, repos: string[], claims: () => Promise<ProjectClaim[]> = async () => []) {
  return (TRACKERS[s.tracker] as Adapter<Source>).make(s, host, io, defaultHost, repos, claims);
}

const sessionOf = (io: Io, sessions: Map<string, Promise<Session | undefined>>, r: Repo) => sessions.get(r.key) ?? sessions.set(r.key, loadSession(io, r)).get(r.key)!;

const warned = new Set<string>();

function assignedElsewhere(io: Io, t: Ticket) {
  if (!t.otherAssignee) return false;
  const seen = `assigned ${t.repo}/${t.id}`;
  if (!warned.has(seen)) io.log(`skip ${t.id}: assigned to ${JSON.stringify(t.otherAssignee)}`);
  warned.add(seen);
  return true;
}

export const IN_REVIEW_FILE = ".in-review";

// This host's In Review plus Ready to merge tickets per repo, only when a limit is set (else an empty map); undefined if a listing failed.
async function countInReview(cfg: Config, io: Io, srcs: Map<string, { s: Source; io: Io; tr: Tracker }>) {
  const counts = new Map<string, number>();
  if (cfg.maxInReview === undefined && Object.values(cfg.repos).every((r) => r.maxInReview === undefined)) return counts;
  for (const x of srcs.values()) {
    try {
      for (const t of await x.tr.listInReview(true)) {
        // A ticket no repo claims is still this host's: it counts toward the host-wide limit only.
        const key = SAFE_ID.test(t.id) && (workRepo(cfg, x.s, x.tr, t) ?? (t.repo === undefined ? "(no repo)" : undefined));
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    } catch (e) {
      x.io.log(`list in-review failed, so no new starts: ${(e as Error).message}`);
      return;
    }
  }
  const f = join(cfg.workspaceRoot, IN_REVIEW_FILE);
  const json = JSON.stringify(Object.fromEntries(counts));
  if (!existsSync(f) || readFileSync(f, "utf8") !== json) put(io, f, json);
  return counts;
}

export async function pass(cfg: Config, io: Io, tracker = makeTracker, tenderDir = TENDER_DIR, state = liveStates()) {
  if ((await io.run(["tmux", "has-session", "-t", `=${cfg.tmuxSession}`])).code !== 0)
    await write(io, ["tmux", "new-session", "-d", "-s", cfg.tmuxSession]).catch((e) => io.log(`tmux: ${e.message}`));
  const sessions = new Map<string, Promise<Session | undefined>>();
  let claimed: Promise<ProjectClaim[]> | undefined;
  // Only when a ticket needs it, once per pass: every repo's `.tender/` at its freshly fetched base commit; any repo unread fails it all.
  // Settled before failing, so no clone outlives the map and races a start.
  const claims = () =>
    (claimed ??= Promise.allSettled(
      Object.values(cfg.repos).map(async (r): Promise<ProjectClaim[]> => {
        try {
          if (!(await cloned(cfg, io, r))) return [];
          const s = await sessionOf(io, sessions, r);
          if (!s) throw new Error("invalid .tender/");
          return s.tracker?.linear ? [{ repo: r.key, ...s.tracker.linear }] : [];
        } catch (e) {
          io.log(`${r.key}: linear project map unavailable, project-routed tickets wait: ${(e as Error).message}`);
          throw e;
        }
      }),
    ).then((x) => {
      const failed = x.find((r) => r.status === "rejected");
      if (failed) throw failed.reason;
      return x.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    }));
  const srcs = new Map(
    cfg.sources.map((s) => {
      const sio = { ...io, log: (m: string) => io.log(`[${s.name}] ${m}`) };
      return [s.name, { s, io: sio, tr: tracker(s, cfg.host, sio, cfg.defaultHost, Object.keys(cfg.repos), claims) }];
    }),
  );
  const wins = await windows(cfg, io);
  await step(io, "sweep scopes", () => sweepScopes(cfg, io));

  const lists = new Map<string, Promise<Ticket[]>>();
  const listReady = (x: { s: Source; io: Io; tr: Tracker }) => lists.get(x.s.name) ?? lists.set(x.s.name, x.tr.listReady().then((ts) => ts.filter((t) => !assignedElsewhere(x.io, t)))).get(x.s.name)!;
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
        if (!end && (wins.has(winName(r.key, id)) || handedOff(dir, id)) && existsSync(pending)) {
          // Only a ticket still ready is claimed, so a newer move by a human wins.
          const t = (await listReady(x)).find((k) => k.id === id && allowedRepo(cfg, k.repo) === r.key);
          if (t) await claim(x.io, x.tr, pending, { ...t, repo: r.key });
        }
        if (!end) return;
        const w = wins.get(winName(r.key, id));
        if (end === "canceled" && !w && existsSync(join(dir, `${id}.ended`))) return;
        await stopSession(cfg, x.io, r.key, id, wins);
        if (end === "canceled") {
          if (existsSync(join(dir, `${id}.ended`))) return;
          put(x.io, join(dir, `${id}.ended`), new Date().toISOString());
          return x.io.log(`stopped ${r.key}/${id}: ticket canceled; clone and files kept`);
        }
        const wt = join(dir, id);
        if (!lstatSync(join(wt, ".git"), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${wt}/.git is not a directory; left in place`);
        // The session controls its .git (config, filters, commondir), so git checks it sandboxed: read-only, no network, no credentials; tender then deletes without git.
        // A planted filter can block git; the runner's deadline kills its whole process group.
        const box = r.sandbox === "nono" ? nonoRun("tender-check", tenderDir, [["--read", wt], ["--read", join(r.path, ".git", "objects")]]) : [];
        // A fresh clone has no tags (--revision, tagOpt=--no-tags), so any tag, stash or note is the session's own.
        const checks = [["status", "--porcelain", "--ignore-submodules=none"], ["log", "--format=%h", "--branches", "--not", "--remotes"], ["for-each-ref", "--format=%(refname)", "refs/tags", "refs/stash", "refs/notes"]];
        for (const c of checks) if ((await write(x.io, [...box, ...GIT, "-C", wt, ...c])).trim()) throw new Error(`${wt} has uncommitted, untracked or unpushed work; left in place`);
        // rm never follows symlinks.
        await write(x.io, ["rm", "-rf", "--one-file-system", "--", wt], undefined, SLOW_SECS);
        // After the clone, so a delete that fails keeps the transcripts too.
        for (const ext of [".claude", ".codex", ".tmpdir", ".prompt.md", ".sh", ".ended", ".phases.json", ".merge", ".pr", ".question", ".feedback", ".stall", ".findings", ".claim", ".agent", ".source", ".reassigned", ".ready", ".handoff"]) remove(x.io, join(dir, id + ext));
      });
    }
  }

  const running = new Map<string, number>();
  for (const n of wins.keys()) {
    const k = n.slice(0, n.lastIndexOf("/"));
    if (Object.hasOwn(cfg.repos, k)) running.set(k, (running.get(k) ?? 0) + 1);
  }
  const total = () => [...running.values()].reduce((a, b) => a + b, 0);
  const reviewing = await countInReview(cfg, io, srcs);
  if (reviewing && total() < cfg.maxConcurrent && [...reviewing.values()].reduce((a, b) => a + b, 0) < (cfg.maxInReview ?? Infinity)) {
    const ready: { s: Source; io: Io; tr: Tracker; t: Ticket }[] = [];
    for (const x of srcs.values()) await step(x.io, "list ready", async () => void ready.push(...(await listReady(x)).map((t) => ({ ...x, t }))));
    // Stable sort: equal priorities keep source order, then tracker order.
    ready.sort((a, b) => byPriority(a.t, b.t));
    for (const { s, io: sio, tr, t } of ready) {
      if (total() >= cfg.maxConcurrent) break;
      await step(sio, `ready ${t.id}`, () => startReady(cfg, s, tr, sio, t, wins, running, reviewing, tenderDir));
    }
  }
  for (const { s, io: sio, tr } of srcs.values()) {
    try {
      await reconcileSource(cfg, s, tr, sio, wins, state, sessions);
    } catch (e) {
      sio.log(`source failed: ${(e as Error).message}`);
    }
  }
}
