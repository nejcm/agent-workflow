import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Io, Ticket, Tracker } from "./types";
import { clean, put, readAw, readIn, strip } from "./util";

export interface Finding {
  title: string;
  body: string;
}
export const MAX_FINDINGS = 5;
const MAX_FINDINGS_BYTES = 64 * 1024;

const MAX_FILED_BYTES = 16 * 1024;

// What a URL parser sees: %XX decoded (repeatedly), NFKC, default-ignorables dropped, ideographic dots as `.`.
const asHost = (w: string) => {
  for (let p = ""; p !== w; ) [p, w] = [w, w.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))];
  return w.normalize("NFKC").replace(/\p{DI}/gu, "").replace(/[\u3002\uff0e\uff61]/g, ".");
};
// Linear turns its profile URLs into mentions: any word that resolves to linear.app gets `[.]` for its dots, which no parser
// or linkifier accepts in a host. Zero-width space after `@`. So filing pings no one.
const unmention = (s: string) =>
  s.replace(/\S+/g, (w) => (/linear\.app/i.test(asHost(w)) ? asHost(w).replace(/\./g, "[.]") : w)).replace(/(?<!\w)@(?=\w)/g, "@\u200b");

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

const HASH = /^[0-9a-f]{64}$/;
const issueUrl = (u: string, origin: string) =>
  u.startsWith(`${origin}/`) && /^\/[\w.-]+\/(?:[\w.-]+\/issues\/\d+|issue\/[A-Za-z0-9]+-\d+(?:\/[\w-]*)?)$/.test(u.slice(origin.length));

// The sidecar is aw-written and outside the sandbox; still, anything off throws, so nothing is filed or posted (fail closed).
function readFiled(dir: string, id: string, origin: string): Filed[] {
  const raw = readIn(dir, `${id}.findings`, MAX_FILED_BYTES);
  if (raw === undefined) return [];
  const a = JSON.parse(raw);
  const ok = (r: any) =>
    (typeof r === "string" && HASH.test(r)) ||
    (r && typeof r.h === "string" && HASH.test(r.h) && typeof r.title === "string" && r.title.length <= 120 && (r.url === null || (typeof r.url === "string" && issueUrl(r.url, origin))) && typeof r.posted === "boolean");
  if (!Array.isArray(a) || a.length > MAX_FINDINGS || !a.every(ok)) throw new Error(`${id}.findings: invalid`);
  // Older sidecars hold bare hashes, already linked.
  return a.map((r) => (typeof r === "string" ? { h: r, title: "", url: null, posted: true } : r));
}

const hashOf = (f: Finding) => createHash("sha256").update(`${f.title}\n${f.body}`).digest("hex");

// Each entry is recorded before its create and never removed: a crash or lost response loses a finding rather than filing it twice.
export async function fileFindings(t: Ticket, tr: Tracker, io: Io, dir: string) {
  const file = join(dir, `${t.id}.findings`);
  const origin = new URL(t.url).origin;
  const filed = readFiled(dir, t.id, origin);
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
      const url = await tr.createTicket(t, f.title, body);
      if (issueUrl(url, origin)) r.url = url;
      else io.log(`findings ${t.id}: unexpected ticket URL ${clean(url)}, recorded as not filed`);
      put(io, file, JSON.stringify(filed));
    }
  } finally {
    if (filed.some((r) => !r.posted)) await postLinks(t, tr, io, file, filed);
  }
}

// The marker line lets a retry see a comment that posted though its response or the sidecar write was lost.
async function postLinks(t: Ticket, tr: Tracker, io: Io, file: string, filed: Filed[]) {
  const seen = new Set(
    (await tr.comments(t, 0)).filter((c) => /^\s*aw:/i.test(c.body)).flatMap((c) => [...c.body.matchAll(/^aw-findings((?: [0-9a-f]{12})+)[ \t]*$/gm)].flatMap((m) => m[1]!.trim().split(" "))),
  );
  for (const r of filed) if (seen.has(r.h.slice(0, 12))) r.posted = true;
  const pending = filed.filter((r) => !r.posted);
  if (pending.length) {
    const lines = pending.map((r) => `- ${r.url ? `${r.url} ` : "not filed (create failed): "}${unmention(clean(r.title, 120))}`);
    const marker = `aw-findings ${pending.map((r) => r.h.slice(0, 12)).join(" ")}`;
    await tr.comment(t, `out-of-scope findings from this session, filed as new tickets (not picked up automatically):\n${lines.join("\n")}\n\n${marker}`);
    for (const r of pending) r.posted = true;
  }
  put(io, file, JSON.stringify(filed));
}
