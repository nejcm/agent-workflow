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

// Zero-width space after `@`, and inside linear.app (Linear turns profile URLs into mentions), so filing never pings anyone.
const unmention = (s: string) => s.replace(/(?<!\w)@(?=\w)/g, "@​").replace(/linear(?=\.app)/gi, "$&​");

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

// url null: the create failed or its result was lost; posted: the linking comment listed it.
interface Filed {
  h: string;
  title: string;
  url: string | null;
  posted: boolean;
}

function readFiled(file: string): Filed[] {
  if (!existsSync(file)) return [];
  const a = JSON.parse(readFileSync(file, "utf8"));
  const ok = (r: any) => typeof r === "string" || (r && typeof r.h === "string" && typeof r.title === "string" && (r.url === null || typeof r.url === "string") && typeof r.posted === "boolean");
  if (!Array.isArray(a) || a.length > MAX_FINDINGS || !a.every(ok)) throw new Error(`${file}: invalid`);
  // Older sidecars hold bare hashes, already linked.
  return a.map((r) => (typeof r === "string" ? { h: r, title: "", url: "", posted: true } : r));
}

const hashOf = (f: Finding) => createHash("sha256").update(`${f.title}\n${f.body}`).digest("hex");

// Each entry is recorded before its create and never removed: a crash or lost response loses a finding rather than filing it twice.
export async function fileFindings(t: Ticket, tr: Tracker, io: Io, dir: string) {
  const file = join(dir, `${t.id}.findings`);
  const filed = readFiled(file);
  try {
    const raw = readAw(join(dir, t.id), "findings.json", MAX_FINDINGS_BYTES);
    for (const f of raw === undefined ? [] : parseFindings(raw)) {
      const h = hashOf(f);
      if (filed.some((r) => r.h === h)) continue;
      if (filed.length >= MAX_FINDINGS) return io.log(`findings ${t.id}: ${MAX_FINDINGS} already filed, rest ignored`);
      const r: Filed = { h, title: f.title, url: null, posted: false };
      filed.push(r);
      put(io, file, JSON.stringify(filed));
      const body = `${f.body}\n\n---\nFiled by aw from the agent session on ${t.id} (${t.url}): agent-written, not reviewed by a human.`.trimStart();
      r.url = await tr.createTicket(t, f.title, body);
      put(io, file, JSON.stringify(filed));
    }
  } finally {
    const pending = filed.filter((r) => !r.posted);
    if (pending.length) {
      const lines = pending.map((r) => (r.url ? `- ${r.url} ${r.title}` : `- not filed (create failed): ${r.title}`));
      await tr.comment(t, `out-of-scope findings from this session, filed as new tickets (not picked up automatically):\n${lines.join("\n")}`);
      for (const r of pending) r.posted = true;
      put(io, file, JSON.stringify(filed));
    }
  }
}
