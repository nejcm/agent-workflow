#!/usr/bin/env -S bun --no-env-file
// tender intake example: one ticket per Supabase database lint (splinter, the Supabase advisors' SQL). Needs PG_INTAKE_URL, the database host in `network`, and `loopback: true`.
// Copy with pg.ts and splinter.sql to .tender/intake/ (this file executable) and add a rule with `labels: [supabase]` and `private: true`; see docs/intake.md.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { open as openPg, type Open, type Query } from "./pg";

const LEVELS = ["INFO", "WARN", "ERROR"];

export interface Lint {
  name: string;
  title: string;
  level: string;
  facing: string;
  categories: string[];
  description: string;
  detail: string;
  remediation: string;
  metadata: unknown;
  cache_key: string;
}

export const lintKey = (l: Lint) => `pg-lint:${l.name.replace(/[^a-z0-9]/g, "-").slice(0, 60)}:${createHash("sha256").update(l.cache_key).digest("hex").slice(0, 16)}`;

// splinter.sql sets a transaction-local search_path and setting, so it runs inside a read-only transaction; its rows are the next-to-last result.
async function lints(q: Query): Promise<Lint[]> {
  const text = await Bun.file(join(import.meta.dir, "splinter.sql")).text();
  const results = await q(`begin transaction read only;\n${text};\nrollback;`);
  return results.at(-2) ?? [];
}

// splinter's format strings escape backticks, which reach the text as \`.
const md = (s: string) => s.replace(/\\`/g, "`");

function line(l: Lint) {
  const body = [
    `**${l.title}** (${l.level}, ${l.categories.join(", ")}, ${l.facing})`,
    md(l.detail),
    md(l.description),
    `Remediation: ${l.remediation}`,
    `Object: \`${JSON.stringify(l.metadata)}\``,
    `Splinter cache_key: \`${l.cache_key}\``,
    "Proof in the PR: run splinter.sql against the local database after the change and show this cache_key is gone.",
  ];
  return JSON.stringify({ key: lintKey(l), title: `${l.title}: ${md(l.detail)}`, body: body.join("\n\n"), facts: { name: l.name, level: l.level, categories: l.categories.join(",") } });
}

/** stdout for `argv`: one line per lint at or above `--min-level`, most severe first, or the `--recheck` verdict. */
export async function main(argv: string[], open: Open = openPg) {
  const { values: a } = parseArgs({ args: argv, options: { "min-level": { type: "string", default: "INFO" }, ca: { type: "string" }, recheck: { type: "string" } } });
  const min = LEVELS.indexOf(a["min-level"]);
  if (min < 0) throw new Error(`--min-level: one of ${LEVELS.join(", ")}`);
  const db = await open(a.ca);
  try {
    const all = await lints(db.q);
    if (a.recheck !== undefined) {
      const hit = all.find((l) => lintKey(l) === a.recheck);
      return JSON.stringify(hit ? { state: "still", detail: `The lint still reports: ${md(hit.detail)}` } : { state: "gone", detail: "The lint no longer reports this object." });
    }
    const keys = new Set<string>();
    const shown = all
      .filter((l) => LEVELS.indexOf(l.level) >= min && !keys.has(lintKey(l)) && keys.add(lintKey(l)))
      .sort((x, y) => LEVELS.indexOf(y.level) - LEVELS.indexOf(x.level));
    return shown.slice(0, 100).map(line).join("\n");
  } finally {
    await db.close();
  }
}

if (import.meta.main) console.log(await main(process.argv.slice(2)));
