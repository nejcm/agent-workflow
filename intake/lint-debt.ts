#!/usr/bin/env -S bun --no-env-file
// tender intake example: existing violations of one lint rule, in batches of files. Runs the lint command after `--`; needs no network unless --install.
// Copy to .tender/intake/lint-debt.ts (executable) and add a rule with `labels: [lint-debt]` and `args: [--rule, <name>, --, <lint command>]`; see docs/intake.md.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import { parseArgs } from "node:util";

type Run = (cmd: string[], env?: Record<string, string>) => { code: number; out: string; err: string };
type Batch = { key: string; files: string[] };

const LINE = /^(.+?):(\d+)(?::\d+)?: /;
const SAMPLES = 3;

const spawn: Run = (cmd, env) => {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
};

/** Violations per repo-relative file from `path:line[:col]: …` lines; other lines and paths outside the repo are ignored. */
export function parseLint(out: string, cwd: string) {
  const found = new Map<string, string[]>();
  for (const l of out.split("\n")) {
    const m = LINE.exec(l);
    if (!m) continue;
    const file = normalize(isAbsolute(m[1]!) ? relative(cwd, m[1]!) : m[1]!);
    if (file === ".." || file.startsWith("../") || isAbsolute(file)) continue;
    found.set(file, [...(found.get(file) ?? []), l.trim()]);
  }
  return found;
}

export const batchKey = (rule: string, files: string[]) => `lint-debt:${rule.replace(/[^A-Za-z0-9./-]/g, "-").slice(0, 60)}:${createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 16)}`;

/** Batches known from earlier runs keep their key while any file still fails; the other failing files form new batches in sorted order. */
export function batches(found: Map<string, string[]>, known: Record<string, string[]>, rule: string, size: number, max = 100): Batch[] {
  const out: Batch[] = Object.entries(known).flatMap(([key, files]) => (files.some((f) => found.has(f)) ? [{ key, files }] : []));
  // shortcut: a file failing again after its batch went clean stays under that filed key (one recheck sees it); give recurrences a new key if debt recurs.
  const claimed = new Set(Object.values(known).flat());
  const rest = [...found.keys()].filter((f) => !claimed.has(f)).sort();
  for (let i = 0; i < rest.length && out.length < max; i += size) {
    const files = rest.slice(i, i + size);
    out.push({ key: batchKey(rule, files), files });
  }
  return out.slice(0, max);
}

function lint(cmd: string[], install: boolean, run: Run) {
  if (install) {
    const r = run(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], { BUN_INSTALL_CACHE_DIR: join(process.env.TMPDIR ?? "/tmp", "bun-cache") });
    if (r.code !== 0) throw new Error(`bun install exited ${r.code}: ${r.err.slice(0, 300)}`);
  }
  const r = run(cmd);
  const found = parseLint(r.out, process.cwd());
  // Linters exit 1 when they report violations; 1 with nothing parsed, or anything else, is a failed run.
  if (r.code > 1 || (r.code === 1 && !found.size)) throw new Error(`${cmd[0]} exited ${r.code} with ${found.size} violations parsed: ${(r.err || r.out).slice(0, 300)}`);
  return found;
}

function readState(file: string): Record<string, string[]> {
  const text = readFileSync(file, "utf8");
  const o = text.trim() ? JSON.parse(text) : {};
  if (!o || typeof o !== "object" || Array.isArray(o) || !Object.values(o).every((v) => Array.isArray(v) && v.every((f) => typeof f === "string"))) throw new Error(`${file}: not a map of key to files`);
  return o;
}

/** stdout for `argv` (`--rule <name> [--batch n] [--install] -- <lint command…> [--recheck <key>]`). */
export function main(argv: string[], run: Run = spawn, state = process.env.TENDER_STATE ?? "") {
  // tender appends --recheck <key> after the rule's args, so after the lint command.
  const recheck = argv.at(-2) === "--recheck" ? argv.at(-1) : undefined;
  const args = recheck === undefined ? argv : argv.slice(0, -2);
  const sep = args.indexOf("--");
  const cmd = sep < 0 ? [] : args.slice(sep + 1);
  if (!cmd.length) throw new Error("the lint command goes after --");
  const { values: a } = parseArgs({ args: args.slice(0, sep), options: { rule: { type: "string" }, batch: { type: "string", default: "5" }, install: { type: "boolean", default: false } } });
  const size = Number(a.batch);
  const rule = a.rule;
  if (!rule) throw new Error("--rule is required");
  if (!Number.isInteger(size) || size < 1 || size > 50) throw new Error("--batch: integer 1-50");
  if (!state) throw new Error("TENDER_STATE is not set");
  const known = readState(state);
  if (recheck !== undefined && !known[recheck]) throw new Error(`--recheck ${recheck}: no such batch in ${state}`);
  const found = lint(cmd, a.install, run);
  if (recheck !== undefined) {
    const still = known[recheck]!.filter((f) => found.has(f));
    return JSON.stringify(still.length ? { state: "still", detail: `${rule} still fails in ${still.join(", ")}` } : { state: "gone", detail: `${rule} reports none of the ${known[recheck]!.length} files` });
  }
  const out = batches(found, known, rule, size);
  writeFileSync(state, JSON.stringify({ ...known, ...Object.fromEntries(out.map((b) => [b.key, b.files])) }));
  return out
    .map(({ key, files }) => {
      const failing = files.filter((f) => found.has(f));
      const list = failing.map((f) => `- \`${f}\` (${found.get(f)!.length}):\n${found.get(f)!.slice(0, SAMPLES).map((l) => `  - ${l}`).join("\n")}`);
      const body = [`Existing violations of the lint rule \`${rule}\` in ${failing.length} files. Fix only these files, in one PR, without disabling the rule:`, list.join("\n"), `Proof in the PR: \`${cmd.join(" ")}\` reports nothing in these files. The rule is the check.`];
      const title = `Lint debt: ${rule} in ${failing.length === 1 ? failing[0] : `${failing.length} files`}`;
      return JSON.stringify({ key, title, body: body.join("\n\n"), facts: { rule: rule.slice(0, 200), files: failing.length, violations: failing.reduce((n, f) => n + found.get(f)!.length, 0) } });
    })
    .join("\n");
}

if (import.meta.main) console.log(main(process.argv.slice(2)));
