import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTO_MERGE } from "./config";
import { baseBranch } from "./github";
import type { AutoMerge, Io, Repo, RepoConfig, Session } from "./types";
import { GIT, hasLabel, read, TENDER_DIR, write } from "./util";

const MAX_FILE = 64 * 1024;
const PROMPT = /^[a-z0-9-]+\.md$/;
const KEYS = ["agent", "testCmd", "planStep", "autoMerge", "criticalPaths", "testPaths", "prompts", "tracker"];

/** A file under `.tender/`, `name` relative to it (`.` for `.tender` itself); `text` only for a regular file within the size cap. */
export interface Entry {
  name: string;
  regular: boolean;
  size: number;
  text?: string;
}

const wanted = (name: string) => name === "config.yaml" || (name.startsWith("prompts/") && PROMPT.test(name.slice(8)));

/** Validates a repo's `.tender/config.yaml` and prompts; throws listing every problem. */
export function parseRepoConfig(entries: Entry[]): RepoConfig {
  const errs: string[] = [];
  const check = (ok: unknown, msg: string) => ok || errs.push(msg);
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
  const files: Record<string, string> = {};
  let yaml: string | undefined;
  for (const e of entries) {
    if (e.name === ".") errs.push(".tender: must be a directory");
    else if (!wanted(e.name)) errs.push(e.name.startsWith("prompts/") ? `${e.name}: prompt files must be named [a-z0-9-]+.md` : `${e.name}: not expected here`);
    else if (!e.regular) errs.push(`${e.name}: must be a regular file`);
    else if (e.size > MAX_FILE || e.text === undefined) errs.push(`${e.name}: over 64 KiB`);
    else if (e.name === "config.yaml") yaml = e.text;
    else files[e.name.slice(8)] = e.text;
  }
  let raw: any = {};
  try {
    raw = yaml === undefined ? {} : (Bun.YAML.parse(yaml) ?? {});
  } catch (e) {
    errs.push(`config.yaml: ${(e as Error).message}`);
  }
  check(obj(raw), "config.yaml: must be a mapping");
  raw = obj(raw) ? raw : {};
  for (const k of Object.keys(raw)) check(KEYS.includes(k), `${k}: unknown key`);
  const p = raw.prompts === undefined ? {} : raw.prompts;
  check(obj(p) && Object.keys(p).every((k) => ["default", "byLabel"].includes(k)), "prompts: mapping with default and byLabel");
  const byLabel = obj(p) && p.byLabel !== undefined ? p.byLabel : {};
  const c: RepoConfig = {
    agent: raw.agent === undefined ? "claude" : raw.agent,
    testCmd: raw.testCmd,
    planStep: raw.planStep === undefined ? "Plan and implement the ticket." : raw.planStep,
    autoMerge: raw.autoMerge,
    criticalPaths: raw.criticalPaths === undefined ? [] : raw.criticalPaths,
    testPaths: raw.testPaths === undefined ? [] : raw.testPaths,
    prompts: { default: obj(p) ? p.default : undefined, byLabel: obj(byLabel) ? byLabel : {} },
    tracker: raw.tracker,
    files,
  };
  check(["claude", "codex"].includes(c.agent), `agent: "claude" | "codex"`);
  check(c.testCmd === undefined || str(c.testCmd), "testCmd: non-empty string");
  check(str(c.planStep), "planStep: non-empty string");
  check(c.autoMerge === undefined || AUTO_MERGE.includes(c.autoMerge), `autoMerge: ${AUTO_MERGE.map((m) => `"${m}"`).join(" | ")}`);
  for (const k of ["criticalPaths", "testPaths"] as const) check(Array.isArray(c[k]) && c[k].every(str), `${k}: list of non-empty glob strings`);
  const known = (f: unknown) => str(f) && Object.hasOwn(files, f);
  check(c.prompts.default === undefined || known(c.prompts.default), `prompts.default: ${JSON.stringify(c.prompts.default)} is not a file in .tender/prompts/`);
  check(obj(byLabel), "prompts.byLabel: mapping of label to prompt file");
  for (const [l, f] of Object.entries(c.prompts.byLabel)) check(str(l) && known(f), `prompts.byLabel.${l}: ${JSON.stringify(f)} is not a file in .tender/prompts/`);
  const lt = obj(c.tracker) ? c.tracker.linear : undefined;
  check(c.tracker === undefined || (obj(c.tracker) && Object.keys(c.tracker).every((k) => k === "linear")), "tracker: mapping with linear");
  check(lt === undefined || (obj(lt) && Object.keys(lt).every((k) => ["project", "team"].includes(k))), "tracker.linear: mapping with project and team");
  if (obj(lt)) check(str(lt.project), "tracker.linear.project: non-empty string, the Linear project's name");
  if (obj(lt)) check(lt.team === undefined || (str(lt.team) && /^[A-Z0-9]+$/.test(lt.team)), "tracker.linear.team: Linear team key, e.g. ENG");
  if (errs.length) throw new Error(errs.join("\n  "));
  return c;
}

/** The prompt template for a ticket: the first `byLabel` match, else the repo's default, else tender's. */
export function promptFor(c: RepoConfig, labels: string[] = []) {
  const name = Object.entries(c.prompts.byLabel).find(([l]) => hasLabel(labels, l))?.[1] ?? c.prompts.default ?? (Object.hasOwn(c.files, "default.md") ? "default.md" : undefined);
  return name ? c.files[name]! : readFileSync(join(TENDER_DIR, "prompts/default.md"), "utf8");
}

/** `.tender/` entries at commit `sha` of the clone at `path`. */
export async function gitEntries(io: Io, path: string, sha: string): Promise<Entry[]> {
  const top = await read(io, [...GIT, "-C", path, "ls-tree", "-z", sha, "--", ".tender"]);
  if (top && !top.startsWith("040000 tree ")) return [{ name: ".", regular: false, size: 0 }];
  const out = await read(io, [...GIT, "-C", path, "ls-tree", "-r", "-z", "--long", sha, "--", ".tender/config.yaml", ".tender/prompts"]);
  const entries: Entry[] = [];
  for (const line of out.split("\0").filter(Boolean)) {
    const m = /^(\d+) (\w+) ([0-9a-f]+) +(-|\d+)\t\.tender\/(.+)$/s.exec(line);
    if (!m) throw new Error(`git ls-tree: unexpected output ${JSON.stringify(line.slice(0, 100))}`);
    const [, mode, type, oid, size, name] = m;
    const e: Entry = { name: name!, regular: type === "blob" && ["100644", "100755"].includes(mode!), size: size === "-" ? 0 : Number(size) };
    if (e.regular && e.size <= MAX_FILE && wanted(e.name)) e.text = await read(io, [...GIT, "-C", path, "cat-file", "blob", oid!]);
    entries.push(e);
  }
  return entries;
}

/** `.tender/` entries in a working tree, for `tender check`. */
export function dirEntries(dir: string): Entry[] {
  const top = lstatSync(join(dir, ".tender"), { throwIfNoEntry: false });
  if (top && !top.isDirectory()) return [{ name: ".", regular: false, size: 0 }];
  const at = (name: string): Entry[] => {
    const st = lstatSync(join(dir, ".tender", name), { throwIfNoEntry: false });
    if (!st) return [];
    const ok = st.isFile() && st.size <= MAX_FILE && wanted(name);
    return [{ name, regular: st.isFile(), size: st.size, text: ok ? readFileSync(join(dir, ".tender", name), "utf8") : undefined }];
  };
  const prompts = lstatSync(join(dir, ".tender/prompts"), { throwIfNoEntry: false });
  const names = prompts?.isDirectory() ? readdirSync(join(dir, ".tender/prompts")).sort().map((n) => `prompts/${n}`) : prompts ? ["prompts"] : [];
  return [...at("config.yaml"), ...names.flatMap((n) => (n === "prompts" ? [{ name: n, regular: false, size: 0 }] : at(n)))];
}

export const configCache = new Map<string, { sha: string; config?: RepoConfig; error?: string; logged?: boolean }>();

/** The repo's `.tender/` at `origin/<base>` in its clone, never a worktree; re-read only when that commit moves. */
export async function repoConfig(io: Io, r: Repo, base: string) {
  const sha = (await read(io, [...GIT, "-C", r.path, "rev-parse", "--verify", `refs/remotes/origin/${base}^{commit}`])).trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`${r.key}: no origin/${base} in ${r.path}`);
  const hit = configCache.get(r.key);
  if (hit?.sha === sha) return hit;
  const entries = await gitEntries(io, r.path, sha);
  let c: NonNullable<typeof hit>;
  try {
    c = { sha, config: parseRepoConfig(entries) };
  } catch (e) {
    c = { sha, error: (e as Error).message };
  }
  configCache.set(r.key, c);
  return c;
}

const rank = (m: AutoMerge) => AUTO_MERGE.indexOf(m);

/** Host settings plus the repo's config: autoMerge is the lower of the repo's request and the host's ceiling; critical paths add up. */
export function combine(r: Repo, base: string, c: RepoConfig): Session {
  const { baseBranch: _, ...host } = r;
  return { ...host, ...c, baseBranch: base, criticalPaths: [...r.criticalPaths, ...c.criticalPaths], autoMerge: c.autoMerge !== undefined && rank(c.autoMerge) < rank(r.autoMerge) ? c.autoMerge : r.autoMerge };
}

/** Fetches `origin/<base>` into the clone, then the settings there; undefined if the repo's config is invalid, logged once per commit. */
export async function loadSession(io: Io, r: Repo, secs?: number): Promise<Session | undefined> {
  const base = await baseBranch(io, r);
  await write(io, [...GIT, "-C", r.path, "fetch", "origin", base], undefined, secs);
  const c = await repoConfig(io, r, base);
  if (c.config) return combine(r, base, c.config);
  if (!c.logged) io.log(`${r.key}: .tender/ on ${base} at ${c.sha.slice(0, 12)} is invalid, so no tickets start:\n  ${c.error}`);
  c.logged = true;
}
