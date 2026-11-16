#!/usr/bin/env -S bun --no-env-file
// tender intake example: one ticket per `shortcut:` comment in the repo. Needs only the clone: no network, no secrets.
// Copy to .tender/intake/shortcuts.ts (executable) and add an intake rule; see docs/intake.md.
import { createHash } from "node:crypto";

const grep = Bun.spawnSync(["git", "grep", "-n", "-I", "-E", "(//|#) ?shortcut: ", "--", ".", ":!*.md", ":!intake/", ":!.tender/intake/"]);
// git grep exits 1 when nothing matches.
if (grep.exitCode > 1) throw new Error(grep.stderr.toString());

const found = grep.stdout
  .toString()
  .split("\n")
  .flatMap((l) => {
    const m = /^(.+?):(\d+):.*?(?:\/\/|#) ?shortcut: (.*)$/.exec(l);
    if (!m) return [];
    const [, file = "", line, text = ""] = m;
    const key = `${file.replace(/[^A-Za-z0-9./-]/g, "-").slice(-100)}:${createHash("sha256").update(`${file}\0${text.trim()}`).digest("hex").slice(0, 12)}`;
    return [{ key, title: `Shortcut in ${file}: ${text.trim()}`, body: `\`${file}:${line}\` records a known shortcut:\n\n> ${text.trim()}\n\nUpgrade it, or confirm it still holds and close this ticket.`, facts: { file } }];
  });

const recheck = process.argv.indexOf("--recheck");
if (recheck > 0) console.log(JSON.stringify({ state: found.some((f) => f.key === process.argv[recheck + 1]) ? "still" : "gone" }));
else for (const f of found.slice(0, 100)) console.log(JSON.stringify(f));
