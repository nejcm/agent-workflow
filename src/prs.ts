import { repoDir } from "./config/config";
import { canonical, sameRepo } from "./github";
import { unmention } from "./review/findings";
import { checkState } from "./review/merge";
import { handedOff, windows, winName } from "./session/launcher";
import { makeTracker, sourceOf } from "./pass";
import type { Config, Io, Source, Tracker } from "./types";
import { clean, passLocked, read, SAFE_ID, write } from "./util";

const DAY = 86_400_000;
// shortcut: only the first 200 open PRs per repo are swept; page with `gh api` if a repo ever has more.
const LIMIT = 200;
const FIELDS = "number,title,url,author,headRefName,isCrossRepository,isDraft,mergeable,mergeStateStatus,statusCheckRollup,createdAt,updatedAt";
// One argv string is capped at 128 KiB; 30k chars stay under it even at 4 bytes each.
const MAX_DIGEST = 30_000;
// Per command under the poll lock; the runner adds at most 10 s to kill and drain, so a close holds the lock under 90 s.
const TMUX_SECS = 5;
const GH_SECS = 20;

export interface Pr {
  number: number;
  title: string;
  url: string;
  author?: { login?: string };
  headRefName: string;
  isCrossRepository: boolean;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  statusCheckRollup: any[] | null;
  createdAt: string;
  updatedAt: string;
}

/** Report classes of an open PR; `ready` is GitHub's CLEAN merge state, so only a human merge is missing. */
export function classify(pr: Pr, staleDays: number, now: number) {
  const old = (at: string) => now - Date.parse(at) > staleDays * DAY;
  const c: string[] = [];
  if (pr.mergeable === "CONFLICTING") c.push("conflicting");
  if ((pr.statusCheckRollup ?? []).some((x) => checkState(x) === "failed")) c.push("failing");
  if (old(pr.updatedAt)) c.push(pr.isDraft ? "draft-stale" : "stale");
  if (!pr.isDraft && pr.mergeStateStatus === "CLEAN" && old(pr.createdAt)) c.push("ready");
  return c;
}

/** The ticket id of a same-repo `agent/<ID>` PR, else undefined. */
export const agentTicket = (pr: Pr) => {
  const id = /^agent\/(.+)$/.exec(pr.headRefName)?.[1];
  return !pr.isCrossRepository && id && SAFE_ID.test(id) ? id : undefined;
};

// The source that started it when its sidecar is still there; else every source that could own the id.
function owners(cfg: Config, key: string, id: string) {
  const named = sourceOf(repoDir(cfg, key), id);
  if (named !== undefined) return cfg.sources.filter((s) => s.name === named);
  if (/^gh-\d+$/.test(id)) return cfg.sources.filter((s) => s.tracker === "github");
  return cfg.sources.filter((s) => s.tracker === "linear" && s.team === id.slice(0, id.lastIndexOf("-")));
}

// Done or canceled only when every owning tracker says so; none, an open state or an error is unknown.
async function ticketEnd(trs: Tracker[], id: string, key: string) {
  if (!trs.length) return;
  const ends = await Promise.all(trs.map((t) => t.closed(id, key)));
  return ends.every(Boolean) ? ends[0] : undefined;
}

/** Sweeps open PRs in the allowlisted repos: closes orphan agent PRs, reports the rest, rewrites `prs.digestIssue`; returns the report. */
export async function prs(cfg: Config, io: Io, { now = Date.now(), tracker = (s: Source) => makeTracker(s, cfg.host, io, cfg.defaultHost, Object.keys(cfg.repos)) } = {}) {
  const trackers = new Map<string, Tracker>();
  const trackerOf = (s: Source) => trackers.get(s.name) ?? trackers.set(s.name, tracker(s)).get(s.name)!;
  const locked = <T>(fn: () => Promise<T>) => (io.dry ? fn() : passLocked(cfg, io.log, fn));
  const lines: string[] = [];
  let open = 0;
  let closed = 0;
  for (const key of Object.keys(cfg.repos)) {
    const name = await canonical(io, key);
    if (!name || !sameRepo(name, key)) continue;
    let list: Pr[];
    try {
      list = JSON.parse(await read(io, ["gh", "pr", "list", "--repo", key, "--state", "open", "--limit", String(LIMIT), "--json", FIELDS]));
    } catch (e) {
      io.log(`repo ${key}: pr list failed, skipped: ${(e as Error).message}`);
      lines.push(`- ${key}: PR list failed`);
      continue;
    }
    if (list.length >= LIMIT) lines.push(`- ${key}: over ${LIMIT} open PRs, only the first ${LIMIT} swept`);
    open += list.length;
    for (const pr of list) {
      const notes = classify(pr, cfg.prs.staleDays, now);
      const id = agentTicket(pr);
      if (id) {
        const trs = owners(cfg, key, id).map(trackerOf);
        const unknown = (e: Error) => {
          io.log(`${key}#${pr.number}: ticket ${id} state unknown: ${e.message}`);
          return "unknown";
        };
        const end = await ticketEnd(trs, id, key).catch(unknown);
        if (end === "unknown") notes.push(`ticket ${id} state unknown`);
        else if (end) {
          // Sessions are rechecked under the poll lock, so a start, resume or hand-off can't land between the check and the close.
          const outcome =
            (await ticketEnd(trs, id, key).catch(unknown)) !== end
              ? "not closed: ticket state changed"
              : await locked(async () => {
                  const busy = await blocker(cfg, io, key, id);
                  if (busy) return `not closed: ${busy}`;
                  return !(await close(io, key, pr, id, end)) ? "close failed" : io.dry ? "would close" : "closed";
                }).catch((e: Error) => `not closed: ${e.message}`);
          if (outcome === "closed") closed++;
          notes.push(`orphan (ticket ${end}), ${outcome}`);
        }
      }
      if (notes.length) lines.push(`- [${key}#${pr.number}](${pr.url}) ${notes.join(", ")}: ${literal(pr.title, 120)}${pr.author?.login ? ` (${literal(`@${pr.author.login}`, 40)})` : ""}`);
    }
  }
  const report = [`tender prs on ${cfg.host}, ${new Date(now).toISOString()}: ${open} open PRs, ${closed} orphans closed, stale after ${cfg.prs.staleDays} days`, "", ...(lines.length ? lines : ["Nothing to report."])].join("\n");
  if (cfg.prs.digestIssue) await digest(io, cfg.prs.digestIssue, report);
  return report;
}

// Zero-width spaces around each ":" and "." break the "scheme:", "www." and domain matches of GitHub's autolinker.
const literal = (s: string, max: number) => unmention(clean(s, max)).replace(/[:.]/g, "\u200b$&\u200b").replace(/[\\`*_[\]()<>!|~&#]/g, "\\$&");

// Only tmux's own "no server" or "no session" answer proves there is no window; a timeout or any other error does not.
const NO_SESSION = /^(can't find session|no server running on |error connecting to .* \(No such file or directory\))/;

async function blocker(cfg: Config, io: Io, key: string, id: string) {
  if (handedOff(repoDir(cfg, key), id)) return "handed off";
  const wins = await windows(cfg, io, TMUX_SECS);
  if (wins.has(winName(key, id))) return "live session";
  if (wins.listed) return;
  const r = await io.run(["tmux", "has-session", "-t", `=${cfg.tmuxSession}`], undefined, TMUX_SECS);
  if (r.code !== 1 || !NO_SESSION.test(r.err.trim())) return "sessions unknown";
}

async function close(io: Io, key: string, pr: Pr, id: string, end: string) {
  try {
    await write(io, ["gh", "pr", "close", String(pr.number), "--repo", key, "--comment", `tender: closed, ticket ${id} is ${end}`], undefined, GH_SECS);
    io.event?.("pr-closed", key, id, { pr: pr.url, ticket: end }, pr.url);
  } catch (e) {
    io.log(`${key}#${pr.number}: close failed: ${(e as Error).message}`);
    return false;
  }
  // Through the API rather than `--delete-branch`, which would also delete a local branch in the cwd's repo.
  await write(io, ["gh", "api", "-X", "DELETE", `repos/${key}/git/refs/heads/agent/${id}`], undefined, GH_SECS).catch((e) => io.log(`${key}#${pr.number}: branch agent/${id} not deleted: ${e.message}`));
  return true;
}

async function digest(io: Io, issue: string, report: string) {
  const [repo, n] = issue.split("#") as [string, string];
  const body = report.length > MAX_DIGEST ? `${report.slice(0, MAX_DIGEST)}\n\n…cut, see the journal for the rest` : report;
  if (io.dry) return io.log(`dry: rewrite ${issue}`);
  await read(io, ["gh", "issue", "edit", n, "--repo", repo, "--body", body]).catch((e) => io.log(`digest ${issue} not updated: ${e.message}`));
}
