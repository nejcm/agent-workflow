import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allowedRepo, repoDir, validRepo } from "./config";
import { byPriority, canonical, findPr, github, sameRepo } from "./github";
import { start, windows, winName } from "./launcher";
import { linear } from "./linear";
import { autoMerge } from "./merge";
import { syncPhases } from "./phases";
import type { Config, Io, Source, Ticket, Tracker } from "./types";
import { AW_DIR, put, remove, write } from "./util";

export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

const sourceOf = (dir: string, id: string) => {
  const f = join(dir, `${id}.source`);
  return existsSync(f) ? readFileSync(f, "utf8").trim() : undefined;
};
const subdirs = (d: string) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
export const diskRepos = (cfg: Config) => subdirs(cfg.workspaceRoot).filter((o) => !o.startsWith(".")).flatMap((o) => subdirs(join(cfg.workspaceRoot, o)).map((n) => `${o}/${n}`));
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
    await tr.comment(t, `aw: ${reason}`);
  } catch (e) {
    remove(io, f);
    throw e;
  }
}

// GitHub ids are only unique per repo, so the listing repo decides; a Linear ticket keeps the repo it was started in,
// even one since removed from aw.json (then left alone). Only the source recorded in <ID>.source may act on a worktree.
function workRepo(cfg: Config, s: Source, t: Ticket) {
  const started = s.tracker === "linear" ? diskRepos(cfg).find((k) => hasTrace(cfg, k, t.id)) : undefined;
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
  const isLinear = s.tracker === "linear";
  const key = allowedRepo(cfg, t.repo);
  if (!key) {
    if (isLinear) await step(io, `reject ${t.id}`, () => reject(cfg, t, tr, io, notAllowed(t)));
    return;
  }
  const r = cfg.repos[key]!;
  if (wins.has(winName(key, t.id)) || (running.get(key) ?? 0) >= (r.maxConcurrent ?? Infinity)) return;
  const owner = sourceOf(repoDir(cfg, key), t.id);
  if (owner !== undefined && owner !== s.name) return io.log(`skip ${t.id}: ${key}/${t.id} belongs to source ${JSON.stringify(owner)}`);
  const other = isLinear && startedElsewhere(cfg, key, t.id, wins);
  if (other) return io.log(`skip ${t.id}: already started in ${other}`);
  // Uncached: a transfer must stop new clones and starts at once, not after the listing cache expires.
  const name = await canonical(io, key, true);
  if (!name) return;
  if (!sameRepo(name, key)) {
    if (isLinear) await step(io, `reject ${t.id}`, () => reject(cfg, t, tr, io, `repo ${key} now resolves to ${name} on GitHub, which is not in the aw allowlist`));
    return;
  }
  await step(io, `start ${t.id}`, async () => {
    await start(cfg, s, r, { ...t, repo: key }, tr, io, awDir);
    wins.set(winName(key, t.id), "new");
    running.set(key, (running.get(key) ?? 0) + 1);
  });
}

async function reconcileSource(cfg: Config, s: Source, tr: Tracker, io: Io, wins: Map<string, string>) {
  await step(io, "list in-progress", async () => {
    for (const t of await tr.listInProgress())
      await step(io, `check ${t.id}`, async () => {
        const key = SAFE_ID.test(t.id) && workRepo(cfg, s, t);
        if (!key) return;
        const w = { ...t, repo: key };
        const dir = repoDir(cfg, key);
        const pr = await findPr(key, t.id, io, dir);
        await step(io, `phases ${t.id}`, () => syncPhases(w, tr, io, dir, !!pr));
        if (pr) return tr.toReview(w, pr);
        const ended = join(dir, `${t.id}.ended`);
        if (wins.has(winName(key, t.id)) || existsSync(ended)) return;
        await tr.comment(w, "session ended without a PR");
        put(io, ended, new Date().toISOString());
      });
  });

  // Retries a final sync that failed when the parent moved to review; a no-op once in sync.
  await step(io, "list in-review", async () => {
    for (const t of await tr.listInReview()) {
      const key = SAFE_ID.test(t.id) && workRepo(cfg, s, t);
      if (!key) continue;
      const w = { ...t, repo: key };
      const dir = repoDir(cfg, key);
      await step(io, `phases ${t.id}`, () => syncPhases(w, tr, io, dir, true));
      if (cfg.repos[key]!.autoMerge !== "off") await step(io, `merge ${t.id}`, () => autoMerge(cfg, cfg.repos[key]!, w, tr, io));
      // autoMerge looks the PR up anyway; otherwise once, for tickets that reached review before aw recorded `.pr`.
      else if (!existsSync(join(dir, `${t.id}.pr`))) await step(io, `pr ${t.id}`, () => findPr(key, t.id, io, dir));
    }
  });
}

export const worktreeIds = (dir: string) => subdirs(dir).filter((d) => SAFE_ID.test(d));

export function makeTracker(s: Source, host: string, io: Io, defaultHost: boolean, repos: string[]) {
  return s.tracker === "github" ? github(s, host, io, defaultHost, repos) : linear(s, host, io, defaultHost);
}

const warned = new Set<string>();

export async function pass(cfg: Config, io: Io, tracker = makeTracker, awDir = AW_DIR) {
  if ((await io.run(["tmux", "has-session", "-t", `=${cfg.tmuxSession}`])).code !== 0)
    await write(io, ["tmux", "new-session", "-d", "-s", cfg.tmuxSession]).catch((e) => io.log(`tmux: ${e.message}`));
  const srcs = new Map(
    cfg.sources.map((s) => {
      const sio = { ...io, log: (m: string) => io.log(`[${s.name}] ${m}`) };
      return [s.name, { s, io: sio, tr: tracker(s, cfg.host, sio, cfg.defaultHost, Object.keys(cfg.repos)) }];
    }),
  );
  const wins = await windows(cfg, io);

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
        if (!(await x.tr.isDone(id, r.key))) return;
        const w = wins.get(winName(r.key, id));
        if (w) await write(x.io, ["tmux", "kill-window", "-t", w]);
        wins.delete(winName(r.key, id));
        await write(x.io, ["git", "-C", r.path, "worktree", "remove", join(dir, id)]);
        for (const ext of [".prompt.md", ".sh", ".ended", ".phases.json", ".merge", ".pr", ".source"]) remove(x.io, join(dir, id + ext));
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
    for (const x of srcs.values()) await step(x.io, "list ready", async () => void ready.push(...(await x.tr.listReady()).map((t) => ({ ...x, t }))));
    // Stable sort: equal priorities keep source order, then tracker order.
    ready.sort((a, b) => byPriority(a.t, b.t));
    for (const { s, io: sio, tr, t } of ready) {
      if (total() >= cfg.maxConcurrent) break;
      await step(sio, `ready ${t.id}`, () => startReady(cfg, s, tr, sio, t, wins, running, awDir));
    }
  }
  for (const { s, io: sio, tr } of srcs.values()) {
    try {
      await reconcileSource(cfg, s, tr, sio, wins);
    } catch (e) {
      sio.log(`source failed: ${(e as Error).message}`);
    }
  }
}
