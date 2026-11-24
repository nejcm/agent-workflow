import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unmention } from "./review/findings";
import { agentLabel, recordedAgentConfig } from "./session/agents";
import type { Io, Repo, Ticket } from "./types";
import { clean, GIT, Kept, mtime, put, read, readRun, strip, validBranch, write } from "./util";

export const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

export const canonCache = new Map<string, { name: string; branch?: string; at: number }>();
const CANON_TTL_MS = 5 * 60_000;

// GitHub serves a renamed/transferred repo under its old name, so the allowlist is checked against the name it resolves to.
export async function canonical(io: Io, key: string, fresh = false): Promise<string | undefined> {
  const hit = canonCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CANON_TTL_MS) return hit.name;
  try {
    const v = JSON.parse(await read(io, ["gh", "repo", "view", key, "--json", "nameWithOwner,defaultBranchRef"]));
    const name = v.nameWithOwner;
    if (typeof name !== "string") throw new Error("no nameWithOwner");
    const branch = v.defaultBranchRef?.name;
    canonCache.set(key, { name, branch: typeof branch === "string" && validBranch(branch) ? branch : undefined, at: Date.now() });
    if (!sameRepo(name, key)) io.log(`repo ${key}: GitHub resolves it to ${JSON.stringify(name.slice(0, 100))}, skipped`);
    return name;
  } catch (e) {
    io.log(`repo ${key}: lookup failed, skipped: ${(e as Error).message}`);
  }
}

/** `baseBranch` from tender.json, else the remote's default branch (cached with the repo's name). */
export async function baseBranch(io: Io, r: Repo) {
  if (r.baseBranch) return r.baseBranch;
  const branch = (await canonical(io, r.key)) && canonCache.get(r.key)?.branch;
  if (!branch) throw new Error(`${r.key}: default branch unknown`);
  return branch;
}

export const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The ticket's open or merged PR, recorded in `<dir>/<ID>.pr` for status. */
export async function findPr(repo: string, id: string, io: Io, dir: string): Promise<string | undefined> {
  const prs: any[] = JSON.parse(await read(io, ["gh", "pr", "list", "--repo", repo, "--head", `agent/${id}`, "--state", "all", "--json", "url,state,mergedAt,isCrossRepository"]));
  // `--head` also matches fork branches; a merge before this run's start (`<ID>.source`) is a reopened ticket's earlier run.
  const since = mtime(join(dir, `${id}.source`));
  const url: string | undefined = prs.find((p) => !p.isCrossRepository && (p.state === "OPEN" || (p.state === "MERGED" && !(since && Date.parse(p.mergedAt) < since))))?.url;
  const f = join(dir, `${id}.pr`);
  if (url && (!existsSync(f) || readFileSync(f, "utf8") !== url)) put(io, f, url);
  return url;
}

/** A problem with the agent's PR file or branch, so no PR will come of it until the agent acts. */
export class BadPr extends Kept {}

export const PR_TITLE_MAX = 120;
export const PR_BODY_MAX = 16_000;
export const labelCache = new Set<string>();

/** Title and body from the agent-written `pr.md`: first non-empty line is the title, the rest the body; both sanitized and capped. */
export function prText(raw: string) {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const at = lines.findIndex((l) => clean(l));
  const title = at < 0 ? "" : unmention(clean(lines[at]!).replace(/^#+\s*/, "").slice(0, PR_TITLE_MAX)).slice(0, PR_TITLE_MAX);
  const body = unmention(lines.slice(at + 1).map((l) => strip(l).trimEnd()).join("\n").trim()).slice(0, PR_BODY_MAX);
  return { title, body };
}

/** Opens the PR from the session's `.tender/run/pr.md` once per version of that file; the URL, or undefined if there is nothing to open (or a dry run). */
export async function openPr(r: Repo, t: Ticket & { repo: string }, io: Io, dir: string): Promise<string | undefined> {
  const bad = (m: string) => new BadPr(`pr.md: ${m}`, `${t.id}:pr:${m}`);
  let raw: string | undefined;
  try {
    raw = readRun(join(dir, t.id), "pr.md", 64 * 1024);
  } catch (e) {
    throw bad((e as Error).message);
  }
  if (raw === undefined) return;
  const mark = join(dir, `${t.id}.prfile`);
  const hash = createHash("sha256").update(raw).digest("hex");
  if (existsSync(mark) && readFileSync(mark, "utf8") === hash) return;
  const { title, body } = prText(raw);
  if (!title) throw bad("no title on its first line");
  const branch = `agent/${t.id}`;
  try {
    if (!sameRepo((await canonical(io, t.repo, true)) ?? "", t.repo)) throw new Error(`${t.repo} does not resolve to itself on GitHub`);
    if (!(await read(io, [...GIT, "-C", r.path, "ls-remote", "origin", `refs/heads/${branch}`])).trim()) throw bad(`${branch} is not pushed`);
    const a = recordedAgentConfig(dir, t.id);
    const closes = /^gh-(\d+)$/.exec(t.id)?.[1];
    const footer = ["---", `Ticket: ${t.url}`, ...(closes ? [`Closes #${closes}`] : []), `Opened by tender for ${t.id}${a ? ` with ${agentLabel(a.name, a.model)}` : ""}.`].join("\n");
    const argv = ["gh", "api", "-X", "POST", `repos/${t.repo}/pulls`, "-f", `title=${title}`, "-f", `head=${branch}`, "-f", `base=${await baseBranch(io, r)}`, "-f", `body=${body ? `${body}\n\n` : ""}${footer}`];
    io.log(`${io.dry ? "dry: " : ""}${argv.join(" ")}`);
    if (io.dry) return;
    const res = await io.run(argv);
    const exists = res.code !== 0 && /pull request already exists/i.test(res.out + res.err);
    if (res.code !== 0 && !exists) {
      const msg = `gh api pulls: ${res.err.trim() || `exit ${res.code}`}`;
      throw /HTTP 422/.test(res.err) ? bad(msg) : new Kept(msg, `${t.id}:pr:${msg}`);
    }
    let url: string | undefined;
    if (!exists) {
      url = JSON.parse(res.out).html_url;
      if (typeof url !== "string" || !PR_URL.test(url)) throw new Error("gh api pulls: no PR URL in the response");
    }
    put(io, mark, hash);
    if (url) put(io, join(dir, `${t.id}.pr`), url);
    url ??= await findPr(t.repo, t.id, io, dir);
    if (!url) throw new Error("gh api pulls: GitHub says the PR exists but does not list it yet");
    await label(io, t.repo, url.slice(url.lastIndexOf("/") + 1)).catch((e) => io.log(`${t.id}: tender label not added: ${(e as Error).message}`));
    return url;
  } catch (e) {
    throw e instanceof Kept ? e : new Kept((e as Error).message, `${t.id}:pr:${(e as Error).message}`);
  }
}

async function label(io: Io, repo: string, n: string) {
  if (!labelCache.has(repo) && (await io.run(["gh", "api", `repos/${repo}/labels/tender`])).code !== 0)
    await write(io, ["gh", "api", "-X", "POST", `repos/${repo}/labels`, "-f", "name=tender", "-f", "color=5319e7", "-f", "description=Opened by tender"]).catch(() => undefined);
  labelCache.add(repo);
  await write(io, ["gh", "api", "-X", "POST", `repos/${repo}/issues/${n}/labels`, "-f", "labels[]=tender"]);
}
