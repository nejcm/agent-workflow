import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Io, Ticket, Tracker } from "./types";
import { clean, put, readAw, strip } from "./util";

export interface Finding {
  title: string;
  body: string;
}
export const MAX_FINDINGS = 5;
const MAX_FINDINGS_BYTES = 64 * 1024;

// Zero-width space after `@` so filing never pings a user or team.
const unmention = (s: string) => s.replace(/(?<!\w)@(?=\w)/g, "@​");

/** Validates the agent-written findings file and sanitizes each entry; it is untrusted, so a wrong shape throws. */
export function parseFindings(raw: string): Finding[] {
  const a = JSON.parse(raw);
  if (!Array.isArray(a) || a.length > MAX_FINDINGS) throw new Error(`findings: must be an array of at most ${MAX_FINDINGS}`);
  return a.flatMap((f, i) => {
    const ok = f && typeof f === "object" && Object.keys(f).every((k) => k === "title" || k === "body") && typeof f.title === "string" && typeof (f.body ?? "") === "string";
    if (!ok) throw new Error(`findings[${i}]: invalid`);
    const title = unmention(clean(f.title, Infinity)).slice(0, 120);
    const body = unmention((f.body ?? "").split("\n").map((l: string) => strip(l).trimEnd()).join("\n").trim()).slice(0, 4000);
    return title ? [{ title, body }] : [];
  });
}

function readFiled(file: string): string[] {
  if (!existsSync(file)) return [];
  const a = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(a) || !a.every((h) => typeof h === "string")) throw new Error(`${file}: invalid`);
  return a;
}

const hashOf = (f: Finding) => createHash("sha256").update(`${f.title}\n${f.body}`).digest("hex");

// Each hash is recorded before its ticket is created: a crash loses a finding rather than filing it twice.
export async function fileFindings(t: Ticket, tr: Tracker, io: Io, dir: string) {
  const raw = readAw(join(dir, t.id), "findings.json", MAX_FINDINGS_BYTES);
  if (raw === undefined) return;
  const file = join(dir, `${t.id}.findings`);
  const filed = readFiled(file);
  const links: string[] = [];
  try {
    for (const f of parseFindings(raw)) {
      const h = hashOf(f);
      if (filed.includes(h)) continue;
      if (filed.length >= MAX_FINDINGS) return io.log(`findings ${t.id}: ${MAX_FINDINGS} already filed, rest ignored`);
      filed.push(h);
      put(io, file, JSON.stringify(filed));
      const body = `${f.body}\n\n---\nFiled by aw from the agent session on ${t.id} (${t.url}): agent-written, not reviewed by a human.`.trimStart();
      try {
        links.push(`- ${await tr.createTicket(t, f.title, body)} ${f.title}`);
      } catch (e) {
        filed.pop();
        put(io, file, JSON.stringify(filed));
        throw e;
      }
    }
  } finally {
    if (links.length) await tr.comment(t, `out-of-scope findings from this session, filed as new tickets (not picked up automatically):\n${links.join("\n")}`);
  }
}
