import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Io } from "./types";
import { put, read } from "./util";

export const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

export const canonCache = new Map<string, { name: string; at: number }>();
const CANON_TTL_MS = 5 * 60_000;

// GitHub serves a renamed/transferred repo under its old name, so the allowlist is checked against the name it resolves to.
export async function canonical(io: Io, key: string, fresh = false): Promise<string | undefined> {
  const hit = canonCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CANON_TTL_MS) return hit.name;
  try {
    const name = JSON.parse(await read(io, ["gh", "repo", "view", key, "--json", "nameWithOwner"])).nameWithOwner;
    if (typeof name !== "string") throw new Error("no nameWithOwner");
    canonCache.set(key, { name, at: Date.now() });
    if (!sameRepo(name, key)) io.log(`repo ${key}: GitHub resolves it to ${JSON.stringify(name.slice(0, 100))}, skipped`);
    return name;
  } catch (e) {
    io.log(`repo ${key}: lookup failed, skipped: ${(e as Error).message}`);
  }
}
export const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The ticket's open or merged PR, recorded in `<dir>/<ID>.pr` for status. */
export async function findPr(repo: string, id: string, io: Io, dir: string): Promise<string | undefined> {
  const prs: any[] = JSON.parse(await read(io, ["gh", "pr", "list", "--repo", repo, "--head", `agent/${id}`, "--state", "all", "--json", "url,state"]));
  const url: string | undefined = prs.find((p) => p.state !== "CLOSED")?.url;
  const f = join(dir, `${id}.pr`);
  if (url && (!existsSync(f) || readFileSync(f, "utf8") !== url)) put(io, f, url);
  return url;
}
