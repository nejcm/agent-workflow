import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Io, Ticket, Tracker } from "./types";
import { put, readAw } from "./util";

export type PhaseStatus = "todo" | "in-progress" | "done";
export interface Phase {
  key: string;
  title: string;
  body: string;
  status: PhaseStatus;
}
const RANK: Record<PhaseStatus, number> = { todo: 0, "in-progress": 1, done: 2 };
const MAX_PHASES = 20;
const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Validates the agent-written phases file; it is untrusted, so anything off throws. */
export function parsePhases(raw: string): Phase[] {
  const a = JSON.parse(raw);
  if (!Array.isArray(a) || a.length > MAX_PHASES) throw new Error(`phases: must be an array of at most ${MAX_PHASES}`);
  const keys = new Set<string>();
  return a.map((p, i) => {
    const ok =
      p && typeof p === "object" && Object.keys(p).every((k) => ["key", "title", "body", "status"].includes(k)) &&
      typeof p.key === "string" && KEY.test(p.key) && !keys.has(p.key) &&
      typeof p.title === "string" && p.title.trim().length > 0 && p.title.length <= 120 && !/[\x00-\x1f\x7f]/.test(p.title) &&
      typeof (p.body ?? "") === "string" && (p.body ?? "").length <= 4000 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(p.body ?? "") &&
      typeof p.status === "string" && Object.hasOwn(RANK, p.status);
    if (!ok) throw new Error(`phases[${i}]: invalid`);
    keys.add(p.key);
    return { key: p.key, title: p.title.trim(), body: p.body ?? "", status: p.status };
  });
}

const MAX_PHASES_BYTES = 64 * 1024;

export function readPhases(wt: string): Phase[] | undefined {
  const raw = readAw(wt, "phases.json", MAX_PHASES_BYTES);
  return raw === undefined ? undefined : parsePhases(raw);
}

type Sidecar = Record<string, { ref: string; status: PhaseStatus }>;

function readSidecar(file: string): Sidecar | undefined {
  if (!existsSync(file)) return undefined;
  const o = JSON.parse(readFileSync(file, "utf8"));
  const ok = o && typeof o === "object" && !Array.isArray(o) &&
    Object.entries(o).every(([k, v]: [string, any]) => KEY.test(k) && v && typeof v.ref === "string" && typeof v.status === "string" && Object.hasOwn(RANK, v.status));
  if (!ok) throw new Error(`${file}: invalid`);
  return o;
}

/** Phase progress for `<dir>/<id>`: the agent's file, else the sidecar titled by key; null if none or invalid. */
export function phaseProgress(dir: string, id: string) {
  try {
    const live = readPhases(join(dir, id));
    const synced = live ? undefined : readSidecar(join(dir, `${id}.phases.json`));
    const all = live ?? (synced && Object.entries(synced).map(([key, s]) => ({ key, title: key, status: s.status })));
    if (!all) return null;
    const items = all.slice(0, MAX_PHASES).map(({ key, title, status }) => ({ key, title, status }));
    return { done: all.filter((p) => p.status === "done").length, total: all.length, items };
  } catch {
    return null;
  }
}

// `done` is held at in-progress until `final` (PR exists) so Linear's parent auto-close can't end the session mid-work.
export async function syncPhases(t: Ticket, tr: Tracker, io: Io, dir: string, final: boolean) {
  const phases = readPhases(join(dir, t.id));
  if (!phases) return;
  const sidecar = join(dir, `${t.id}.phases.json`);
  const synced = readSidecar(sidecar) ?? {};
  const save = () => put(io, sidecar, JSON.stringify(synced, null, 2));
  for (const p of phases) {
    let s = Object.hasOwn(synced, p.key) ? synced[p.key] : undefined;
    if (!s) {
      if (Object.keys(synced).length >= MAX_PHASES) throw new Error(`phases: more than ${MAX_PHASES} created for ${t.id}`);
      const title = `${t.id}: ${p.title}`;
      const known = new Set(Object.values(synced).map((x) => x.ref));
      // Adopt a sub-ticket created by a run that died before saving the sidecar instead of duplicating it.
      const orphan = (await tr.listPhases(t)).find((x) => x.title === title && !known.has(x.ref));
      s = synced[p.key] = { ref: orphan?.ref ?? (await tr.createPhase(t, title, p.body)), status: "todo" };
      save();
    }
    const want = !final && p.status === "done" ? "in-progress" : p.status;
    if (RANK[want] < RANK[s.status]) io.log(`phase ${t.id}/${p.key}: ignoring ${s.status} -> ${want}`);
    if (RANK[want] <= RANK[s.status]) continue;
    await tr.setPhase(t, s.ref, want as "in-progress" | "done");
    s.status = want;
    save();
  }
}
