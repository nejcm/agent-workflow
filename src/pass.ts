import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { allowedRepo, repoDir, validRepo } from "./config/config";
import { deliverFeedback, feedbackFields } from "./session/feedback";
import { fileFindings } from "./review/findings";
import { agentOf, codexHome } from "./session/agents";
import { baseBranch, canonical, findPr, sameRepo } from "./github";
import { authStamp, claim, cloned, CODEX_AUTH, codexIdentity, codexLogin, codexRecorded, handedOff, nonoRun, refreshCodexCopy, scopeUnit, start, stopSession, sweepScopes, windows, winName } from "./session/launcher";
import { autoMerge, checkState, policyBlocked, PR_FIELDS, prMode, prReady, viewPr } from "./review/merge";
import { syncPhases } from "./review/phases";
import { agentPane, deliverAnswer, liveStates, syncQuestion } from "./session/question";
import { combine, loadSession, parseRepoConfig } from "./config/repo-config";
import { lastSay, transcript } from "./ui/tail";
import { type Adapter, TRACKERS } from "./trackers";
import type { ProjectClaim } from "./trackers/linear";
import type { Config, Io, Repo, Session, Source, Ticket, Tracker } from "./types";
import { TENDER_DIR, byPriority, Kept, diskRepos, GIT, hasLabel, mtime, put, read, remove, SAFE_ID, SLOW_SECS, strip, subdirs, write } from "./util";

export const sourceOf = (dir: string, id: string) => {
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
    const msg = `${what} failed: ${(e as Error).message}`;
    if (e instanceof Kept && warned.has(e.key)) return;
    if (e instanceof Kept) warned.add(e.key);
    io.log(msg);
  }
}

const SCAN_CAP = 100_000;

// Old-form submodules, --separate-git-dir pointers, bare repos and other nested repos hold commits no check here sees.
function nestedGit(wt: string) {
  const dirs = [wt];
  let seen = 0;
  while (dirs.length) {
    const d = dirs.pop()!;
    const kinds = new Map<string, boolean>();
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (++seen > SCAN_CAP) return `more than ${SCAN_CAP} entries`;
      if (e.name === ".git" && d !== wt) return join(d, e.name);
      kinds.set(e.name, e.isDirectory());
      if (e.isDirectory() && e.name !== ".git") dirs.push(join(d, e.name));
    }
    // A bare repo has no .git.
    if (d !== wt && kinds.get("HEAD") === false && kinds.get("objects") && kinds.get("refs")) return d;
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
  const quiet = (since: number) => now - since >= cfg.repos[t.repo!]!.stallMinutes * 60_000;
  if (!quiet(started) || (await state(dir, t.id, now, true)) !== "working") return;
  const tx = transcript(wt, agentOf(dir, t.id), io.home, started);
  const at = Math.max(started, (tx ? mtime(tx) : undefined) ?? 0);
  const file = join(dir, `${t.id}.stall`);
  if (!quiet(at) || (existsSync(file) && readFileSync(file, "utf8").trim() === String(at)) || !/^@\d+$/.test(win)) return;
  // The launcher's own pane only: a human's split may hold secrets.
  const pane = await agentPane(io, win, `${wt}.sh`).catch(() => undefined);
  const lines = pane ? await read(io, ["tmux", "capture-pane", "-p", "-t", pane, "-S", "-20"]).catch(() => "") : "";
  await tr.park(t);
  io.event?.("stall", t.repo!, t.id, { quietMinutes: Math.floor((now - at) / 60_000) });
  io.event?.("park", t.repo!, t.id, { why: "stall" });
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
          await tr.toReview(w, `PR: ${pr}`);
          return io.event?.("review", key, t.id, { pr });
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
      let merging = false;
      if (ses && prMode(ses) !== "off") await step(io, `merge ${t.id}`, async () => void ((pr = await autoMerge(cfg, ses, w, tr, io, parked, share)), (merging = !!pr && prMode(ses, pr.files) !== "off")));
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
      // Loaded whatever the merge mode; an invalid config or failed fetch keeps the host's maxRounds.
      const rounds = (await sessionOf(io, sessions, r).catch((e) => void (fresh || io.log(`feedback ${t.id}: .tender/ unavailable, using the host's feedback rounds: ${e.message}`))))?.feedbackRounds ?? r.feedbackRounds;
      await step(io, `feedback ${t.id}`, async () => void (clear = await deliverFeedback({ ...r, feedbackRounds: rounds }, w, tr, io, dir, win, scopeUnit(cfg, key, t.id), () => state(dir, t.id), warned, share)));
      pr &&= share!.pr;
      // Never from the live state, which the session writes: ended is a listing without the window, idle is tmux's own output clock.
      // Listed again with its clock at the decision, since a pass can outlast IDLE_SECS.
      const done = async () => {
        const now = await windows(cfg, io);
        const name = winName(key, t.id);
        return now.has(name) ? Date.now() / 1000 - now.activity.get(name)! >= IDLE_SECS : now.listed;
      };
      // Auto-merge reports these as a hold; promoting too would post a second, contradicting verdict.
      const promote = !(merging && policyBlocked(pr));
      if (pr && tr.toReadyToMerge) await step(io, `ready ${t.id}`, () => syncReady(w, tr, io, dir, pr, clear, done, promote));
    }
  });
}

/** `<ID>.ready`: the head tender moved the ticket to Ready to merge at, or a move in flight, or a human's move back held at that head. */
export type ReadyMark = { head: string } & ({ step: "moved" | "pending" | "held" } | { step: "demote"; why: string });

export function readReady(f: string): ReadyMark | undefined {
  if (!existsSync(f)) return;
  const [head = "", step, ...why] = readFileSync(f, "utf8").split(" ");
  if (step === "demote") return { head, step, why: why.join(" ") };
  // An unknown suffix is never shown as ready nor held.
  return { head, step: step === undefined ? "moved" : step === "held" ? "held" : "pending" };
}

const writeReady = (io: Io, f: string, m: ReadyMark) => put(io, f, m.step === "moved" ? m.head : m.step === "demote" ? `${m.head} demote ${m.why}` : `${m.head} ${m.step}`);

// Promoted from GitHub's view and tender's own state only.
async function syncReady(t: Ticket, tr: Tracker, io: Io, dir: string, pr: any, clear: boolean | undefined, done: () => Promise<boolean>, promote: boolean) {
  const f = join(dir, `${t.id}.ready`);
  if (pr.state === "MERGED") return;
  const m = readReady(f);
  if (t.readyToMerge) {
    // Moved there by hand: the head first seen counts. The listing confirms a pending move.
    const at = !m?.head || m.step === "held" ? pr.headRefOid : m.head;
    const why =
      pr.state !== "OPEN" ? `PR is ${pr.state}`
      : pr.isDraft ? "PR is a draft"
      : at !== pr.headRefOid ? "new commits"
      : pr.mergeable === "CONFLICTING" ? "merge conflicts"
      : pr.statusCheckRollup.some((c: any) => checkState(c) === "failed") ? "a check failed"
      : pr.reviewDecision === "CHANGES_REQUESTED" ? "changes requested"
      : !promote ? (pr.reviewDecision === "REVIEW_REQUIRED" ? "needs review" : "blocked by branch protection")
      : clear === false ? "new feedback"
      // A failed move back after delivered feedback: this poll finds nothing left to deliver.
      : m?.step === "demote" ? m.why
      : undefined;
    if (!why) return void ((m?.step === "moved" && m.head === at) || writeReady(io, f, { head: at, step: "moved" }));
    writeReady(io, f, { head: at, step: "demote", why });
    await tr.toReview(t, `back in review, ${why}: ${pr.url}`);
    io.event?.("review", t.repo!, t.id, { pr: pr.url, why });
    return remove(io, f);
  }
  // Tender's own move back is marked `demote` first, so `moved` here means a human moved it back.
  if (m?.step === "held" && m.head === pr.headRefOid) return;
  if (m?.step === "moved" && m.head === pr.headRefOid) return writeReady(io, f, { head: m.head, step: "held" });
  if (!promote || clear !== true || !prReady(pr) || !(await done())) return remove(io, f);
  // Before the move, so a move that lands without its comment still has a head to demote from.
  writeReady(io, f, { head: pr.headRefOid, step: "pending" });
  await tr.toReadyToMerge!(t, `ready to merge: ${pr.url}`);
  io.event?.("ready-to-merge", t.repo!, t.id, { pr: pr.url, head: pr.headRefOid });
  writeReady(io, f, { head: pr.headRefOid, step: "moved" });
}

const IDLE_SECS = 5 * 60;

export const worktreeIds = (dir: string) => subdirs(dir).filter((d) => SAFE_ID.test(d));

export function makeTracker(s: Source, host: string, io: Io, defaultHost: boolean, repos: string[], claims: () => Promise<ProjectClaim[]> = async () => []) {
  return (TRACKERS[s.tracker] as Adapter<Source>).make(s, host, io, defaultHost, repos, claims);
}

const sessionOf = (io: Io, sessions: Map<string, Promise<Session | undefined>>, r: Repo) => sessions.get(r.key) ?? sessions.set(r.key, loadSession(io, r)).get(r.key)!;

const warned = new Set<string>();
let codexFailed = { stamp: "", until: 0 };
const once = (io: Io, msg: string) => void (warned.has(msg) || io.log(msg), warned.add(msg));
// Bun's parse errors can quote the token they choked on, so only the error's code or name is logged.
const errTag = (e: unknown) => (e as NodeJS.ErrnoException).code ?? (e as Error).name;

// A failed refresh spawns `codex app-server` each try, so the same template login waits an hour (in this process) before the next one.
async function refreshCodexCopies(cfg: Config, io: Io, wins: Map<string, string>, now = Date.now()) {
  try {
    const tpl = join(io.home, CODEX_AUTH);
    if (io.dry || !existsSync(tpl)) return;
    const id = codexIdentity(JSON.parse(readFileSync(tpl, "utf8")));
    if (!id) return;
    const live = Object.values(cfg.repos).flatMap((r) => worktreeIds(repoDir(cfg, r.key)).flatMap((t) => (wins.has(winName(r.key, t)) ? [{ win: winName(r.key, t), wid: wins.get(winName(r.key, t)), dir: codexHome(join(repoDir(cfg, r.key), t)) }] : [])));
    const bound = live.filter((s) => codexRecorded(s.dir, id));
    if (!bound.length) return;
    const stamp = authStamp(tpl);
    if (stamp === codexFailed.stamp && now < codexFailed.until) return;
    let login: string;
    try {
      login = await codexLogin(io, now);
    } catch (e) {
      codexFailed = { stamp, until: now + 3600_000 };
      return once(io, `Codex login copies not refreshed (${errTag(e)}): the template login is missing, not a ChatGPT login or could not be refreshed; run \`CODEX_HOME=~/.codex-tender codex login\``);
    }
    // The refresh can take a minute: a window closed or replaced meanwhile (ids are unique per tmux server) is an ended session.
    const still = await windows(cfg, io);
    for (const s of bound.filter((s) => still.listed && still.get(s.win) === s.wid)) {
      const file = join(s.dir, "auth.json");
      try {
        const r = refreshCodexCopy(io, s.dir, login);
        if (r === "written") io.log(`refreshed the Codex login in ${file}`);
        if (r === "changed") once(io, `${file} not refreshed: the session changed its login, so it is left as is`);
      } catch (e) {
        once(io, `${file} not refreshed (${errTag(e)}): it must be a regular file with one link under 64 KiB in a directory of this user`);
      }
    }
  } catch (e) {
    once(io, `Codex login copies not refreshed (${errTag(e)}): ${join(io.home, CODEX_AUTH)} is unreadable`);
  }
}

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
  // Every start, count and ended notice reads `wins`; an empty map from a failed listing would read as no live sessions.
  if (!wins.listed && !io.dry) return io.log("tmux windows unknown, so this pass is skipped");
  if (wins.listed) await step(io, "sweep scopes", () => sweepScopes(cfg, io));
  await refreshCodexCopies(cfg, io, wins);

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
          if (t) await claim(x.io, x.tr, pending, { ...t, repo: r.key }).catch((e) => Promise.reject(new Kept(e.message, `${r.key}/${id}: claim: ${e.message}`)));
        }
        if (!end) return;
        if (end === "done") {
          const pr = existsSync(join(dir, `${id}.pr`)) ? readFileSync(join(dir, `${id}.pr`), "utf8") : "";
          // Keyed like merge's: a cleanup retried every poll, or after tender's own done, records it once.
          x.io.event?.("done", r.key, id, pr ? { pr } : undefined, pr);
        }
        const w = wins.get(winName(r.key, id));
        if (end === "canceled" && !w && existsSync(join(dir, `${id}.ended`))) return;
        await stopSession(cfg, x.io, r.key, id, wins);
        if (end === "canceled") {
          if (existsSync(join(dir, `${id}.ended`))) return;
          put(x.io, join(dir, `${id}.ended`), new Date().toISOString());
          return x.io.log(`stopped ${r.key}/${id}: ticket canceled; clone and files kept`);
        }
        const wt = join(dir, id);
        if (!lstatSync(join(wt, ".git"), { throwIfNoEntry: false })?.isDirectory()) throw new Kept(`${wt}/.git is not a directory; left in place`);
        // The session controls its .git (config, filters, commondir), so git checks it sandboxed: read-only, no network, no credentials; tender then deletes without git.
        // A planted filter can block git; the runner's deadline kills its whole process group.
        const box = r.sandbox === "nono" ? nonoRun("tender-check", tenderDir, [["--read", wt], ["--read", join(r.path, ".git", "objects")]]) : [];
        const git = (...c: string[]) => write(x.io, [...box, ...GIT, "-c", "status.showUntrackedFiles=all", "-c", "core.commitGraph=false", `--git-dir=${join(wt, ".git")}`, `--work-tree=${wt}`, "-C", wt, ...c]);
        // Pushed means reachable from the real remote (its HEAD, the branch, the PR head) or the base's refs, never the clone's own refs/remotes.
        const pr = /\/pull\/(\d+)$/.exec(existsSync(join(dir, `${id}.pr`)) ? readFileSync(join(dir, `${id}.pr`), "utf8") : "")?.[1];
        const branch = await baseBranch(x.io, r);
        const advertised = await write(x.io, [...GIT, "-C", r.path, "ls-remote", "origin", "HEAD", "refs/heads/*", ...(pr ? [`refs/pull/${pr}/head`] : [])]);
        const remote = new Map(advertised.split("\n").map((l) => l.split("\t").reverse() as [string, string]));
        const known = await write(x.io, [...GIT, "-C", r.path, "for-each-ref", "--format=%(objectname)", `refs/remotes/origin/${branch}`]);
        const tips = ["HEAD", `refs/heads/${branch}`, `refs/heads/agent/${id}`, `refs/pull/${pr}/head`].map((k) => remote.get(k) ?? "");
        const pushed = [...new Set([...tips, ...known.split("\n")])].filter((h) => /^[0-9a-f]{40,64}$/.test(h));
        // A remote-tracking ref counts as pushed only while origin advertises it at the same SHA.
        const tracking = (await git("for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes")).split("\n").filter(Boolean).map((l) => l.split(" "));
        const unverified = tracking.filter(([sha, ref]) => remote.get(ref.replace(/^refs\/remotes\/origin\//, "refs/heads/")) !== sha).map(([, ref]) => `--exclude=${ref}`);
        // Grafts survive --no-replace-objects, commondir could move them out of reach, and linked worktrees and submodules are not checked.
        if (["info/grafts", "commondir", "worktrees", "modules"].some((f) => existsSync(join(wt, ".git", f)))) throw new Kept(`${wt} has a graft file, commondir, linked worktree or submodule; left in place`);
        // A fresh clone has no tags (--revision, tagOpt=--no-tags), so any tag, stash or note is the session's own.
        const checks = [["status", "--porcelain", "--ignore-submodules=none"], ["rev-list", "--ignore-missing", "--all", "--not", ...pushed, ...unverified, "--glob=refs/remotes/*"], ["for-each-ref", "--format=%(refname)", "refs/tags", "refs/stash", "refs/notes"], ["refs", "verify"]];
        for (const c of checks) if ((await git(...c)).trim()) throw new Kept(`${wt} has uncommitted, untracked or unpushed work; left in place`);
        // Last before rm, so a repo created during the git checks is still seen.
        let nested: string | undefined;
        try {
          nested = nestedGit(wt);
        } catch (e) {
          nested = `an unreadable path (${(e as Error).message})`;
        }
        if (nested) throw new Kept(`${wt} may hold a nested repository: ${nested}; left in place`);
        // rm never follows symlinks.
        await write(x.io, ["rm", "-rf", "--one-file-system", "--", wt], undefined, SLOW_SECS);
        // After the clone, so a delete that fails keeps the transcripts too.
        for (const ext of [".claude", ".codex", ".codex-account", ".tmpdir", ".prompt.md", ".sh", ".ended", ".phases.json", ".merge", ".pr", ".question", ".feedback", ".stall", ".findings", ".claim", ".agent", ".source", ".reassigned", ".ready", ".handoff"]) remove(x.io, join(dir, id + ext));
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
