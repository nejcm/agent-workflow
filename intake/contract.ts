#!/usr/bin/env -S bun --no-env-file
// tender intake example: one ticket per broken piece of the repo's tender contract. Needs only the clone: no network, no secrets.
// Copy to .tender/intake/contract.ts (executable) and add a rule with `labels: [contract]`; see docs/intake.md.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Item = { key: string; title: string; body: string; facts: Record<string, string> };

// tender's own parser, present when this runs from tender's checkout; a copy in a repo has none beside it.
export const PARSER = join(import.meta.dir, "../src/config/repo-config.ts");
const CONFIG_KEY = "contract:config:check";
const KEY = /^contract:(config:check|(criticalPaths|trust):[A-Za-z0-9./-]{0,60}-[0-9a-f]{8})$/;
// tender's collect cap (LIMITS.lines in src/intake.ts); more lines and the whole run files nothing.
const MAX_LINES = 100;

// Same as globRe in tender's src/review/merge.ts (a test keeps them equal): gitignore-style, a pattern without "/" matches at any depth, a literal last segment also covers everything under it.
export const globRe = (glob: string) => {
  const g = glob.replace(/\/+$/, "");
  return new RegExp(`^${g.includes("/") ? "" : "(?:.*/)?"}${g.replace(/^\//, "").replace(/\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g, (m) => ({ "**/": "(?:.*/)?", "**": ".*", "*": "[^/]*", "?": "[^/]" })[m] ?? `\\${m}`)}${/[*?][^/]*$/.test(g) ? "" : "(?:/.*)?"}$`, "is");
};

export const globKey = (field: string, glob: string) => `contract:${field}:${glob.replace(/[^A-Za-z0-9./-]/g, "-").slice(0, 60)}-${createHash("sha256").update(glob).digest("hex").slice(0, 8)}`;

// undefined when tender's parser is not beside this script: under tender, the rule ran only because the config parsed.
async function configError(dir: string, parser: string) {
  if (!existsSync(parser)) return undefined;
  const { dirEntries, parseRepoConfig } = await import(parser);
  try {
    parseRepoConfig(dirEntries(dir));
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

function trackedFiles(dir: string) {
  const r = Bun.spawnSync(["git", "-C", dir, "ls-files", "-z"], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ls-files exited ${r.exitCode}: ${r.stderr.toString().slice(0, 300)}`);
  return r.stdout.toString().split("\0").filter(Boolean);
}

function configGlobs(dir: string) {
  const file = join(dir, ".tender/config.yaml");
  const raw: any = existsSync(file) ? (Bun.YAML.parse(readFileSync(file, "utf8")) ?? {}) : {};
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const globs = new Map<string, [string, string]>();
  for (const g of strs(raw.criticalPaths)) globs.set(globKey("criticalPaths", g), ["criticalPaths", g]);
  for (const t of Array.isArray(raw.trust) ? raw.trust : []) for (const g of strs(t?.paths)) globs.set(globKey("trust", g), ["trust", g]);
  return globs;
}

function unmatched(dir: string, globs: Map<string, [string, string]>): Item[] {
  if (!globs.size) return [];
  const files = trackedFiles(dir);
  return [...globs].flatMap(([key, [field, glob]]) => {
    const re = globRe(glob);
    if (files.some((f) => re.test(f))) return [];
    const body = `\`${glob}\` in \`${field}\` of \`.tender/config.yaml\` matches no tracked file, so it protects or trusts nothing. Point it at the files it was meant for (they may have moved) or remove it. Proof in the PR: \`bun <tender>/tender.ts check .\` passes and the glob matches a file in \`git ls-files\`.`;
    return [{ key, title: `tender contract: ${field} glob ${glob} matches no file`, body, facts: { check: field, glob: glob.slice(0, 200) } }];
  });
}

/** stdout for `argv` (none, or `--recheck <key>`), checking the repo at `dir`. */
export async function main(argv: string[], dir = process.cwd(), parser = PARSER) {
  const recheck = argv[0] === "--recheck" && argv.length === 2 ? argv[1]! : undefined;
  if (argv.length && !KEY.test(recheck ?? "")) throw new Error("usage: contract.ts [--recheck contract:<check>:<subject>]");
  if (recheck === CONFIG_KEY && !existsSync(parser)) throw new Error(`--recheck ${CONFIG_KEY}: tender's parser is not at ${parser}`);
  const err = await configError(dir, parser);
  const config = err ? [{ key: CONFIG_KEY, title: "tender contract: .tender/ fails tender check", body: `\`bun <tender>/tender.ts check .\` reports:\n\n\`\`\`\n${err}\n\`\`\`\n\nUntil it passes on the base branch, tender starts no tickets in this repo.`, facts: { check: "config" } }] : [];
  let globs = new Map<string, [string, string]>();
  if (recheck !== CONFIG_KEY) {
    try {
      globs = configGlobs(dir);
    } catch (e) {
      // An unparseable config.yaml is already the config item; a recheck of a glob cannot be decided.
      if (!config.length || recheck !== undefined) throw e;
    }
  }
  const found = [...config, ...unmatched(dir, globs)];
  if (recheck === undefined) return found.slice(0, MAX_LINES).map((i) => JSON.stringify(i)).join("\n");
  const hit = found.find((i) => i.key === recheck);
  return JSON.stringify(hit ? { state: "still", detail: hit.title } : { state: "gone", detail: "the check passes, or its glob is no longer in the config" });
}

if (import.meta.main) console.log(await main(process.argv.slice(2)));
