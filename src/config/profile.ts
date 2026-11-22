import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { EFFORTS, MODEL } from "../session/agents";
import type { AgentConfig, AgentName, Check, Needs, Profile, TaskType } from "../types";
import { hasLabel, TENDER_DIR } from "../util";

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const KEYS = ["name", "match", "instructions", "agent", "needs", "output"];
const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

export function agentConfig(a: unknown, at: string, check: Check): AgentConfig {
  if (typeof a === "string") return (check(a === "claude" || a === "codex", `${at}: "claude" | "codex" or { name, model, effort }`), { name: a as AgentName });
  if (!obj(a)) return (check(false, `${at}: "claude" | "codex" or { name, model, effort }`), { name: "claude" });
  check(Object.keys(a).every((k) => ["name", "model", "effort"].includes(k)), `${at}: mapping with name, model and effort`);
  const known = a.name === "claude" || a.name === "codex";
  check(known, `${at}.name: "claude" | "codex"`);
  check(a.model === undefined || (typeof a.model === "string" && MODEL.test(a.model)), `${at}.model: model name like sonnet or gpt-5 ([A-Za-z0-9._:[]/-], at most 100 chars)`);
  if (known) check(a.effort === undefined || EFFORTS[a.name as AgentName].includes(a.effort), `${at}.effort: ${EFFORTS[a.name as AgentName].join(" | ")} for ${a.name}`);
  return { name: a.name, model: a.model, effort: a.effort };
}

export const repoPath = (p: unknown) => typeof p === "string" && p.length <= 200 && p.split("/").every((x) => /^[A-Za-z0-9_.-]+$/.test(x) && x !== "." && x !== "..") && !p.startsWith("-");

/** A type's `needs`. */
export function parseNeeds(v: unknown, at: string, check: Check): Needs | undefined {
  if (v === undefined) return undefined;
  const o: Record<string, any> = obj(v) ? v : {};
  check(obj(v) && Object.keys(v).every((k) => k === "ports" || k === "compose"), `${at}: mapping with ports and compose`);
  check(Number.isInteger(o.ports) && o.ports >= 1 && o.ports <= 10, `${at}.ports: integer 1-10`);
  check(o.compose === undefined || repoPath(o.compose), `${at}.compose: a path inside the repo`);
  return { ports: o.ports, ...(o.compose !== undefined && { compose: o.compose }) };
}

// realpath, so neither `..` nor a symlink reaches outside the profile.
function instructionFile(dir: string, p: unknown, at: string, check: Check) {
  const shaped = typeof p === "string" && p.length <= 200 && p.endsWith(".md") && p.split("/").every((x) => /^[A-Za-z0-9_.-]+$/.test(x) && x !== "." && x !== "..");
  let file: string | undefined;
  try {
    file = shaped ? realpathSync(join(dir, p)) : undefined;
  } catch {}
  check(file && !/^\.\.(\/|$)/.test(relative(realpathSync(dir), file)) && statSync(file).isFile(), `${at}: ${JSON.stringify(p)} is not a .md file in the profile ${dir}`);
  return file ?? "";
}

/** A `types` list, from a profile or a repo, with each `instructions` resolved in the profile at `dir`. */
export function parseTypes(raw: unknown, at: string, dir: string, check: Check): TaskType[] {
  check(Array.isArray(raw) && raw.length <= 50, `${at}: list of at most 50 types`);
  const types = (Array.isArray(raw) ? raw : []).map((t, i): TaskType => {
    const where = `${at}[${i}]${obj(t) && typeof t.name === "string" ? ` (${t.name})` : ""}`;
    check(obj(t), `${where}: mapping`);
    const o: Record<string, any> = obj(t) ? t : {};
    for (const k of Object.keys(o)) check(KEYS.includes(k), `${where}.${k}: unknown key`);
    check(typeof o.name === "string" && NAME.test(o.name), `${where}.name: required, [a-z0-9-]`);
    const m = o.match;
    if (o.name === "default") check(m === undefined, `${where}.match: default takes every ticket no other type matches, so it has no match`);
    else check(obj(m) && Object.keys(m).every((k) => k === "labels") && Array.isArray(m.labels) && m.labels.length > 0 && m.labels.length <= 20 && m.labels.every((l: unknown) => typeof l === "string" && l.trim() !== "" && l.length <= 100), `${where}.match: { labels: [label, …] }, 1-20 labels`);
    check(o.output === undefined || o.output === "pr", `${where}.output: "pr"`);
    return { name: o.name, ...(obj(m) && { match: { labels: m.labels } }), instructions: instructionFile(dir, o.instructions, `${where}.instructions`, check), ...(o.agent !== undefined && { agent: agentConfig(o.agent, `${where}.agent`, check) }), ...(o.needs !== undefined && { needs: parseNeeds(o.needs, `${where}.needs`, check) }), output: "pr" };
  });
  check(new Set(types.map((t) => t.name)).size === types.length, `${at}: names must be unique`);
  return types;
}

/** Reads and validates `<dir>/types.yaml`; throws listing every problem. */
export function loadProfile(dir: string): Profile {
  const errs: string[] = [];
  const check: Check = (ok, msg) => ok || errs.push(msg);
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(readFileSync(join(dir, "types.yaml"), "utf8"));
  } catch (e) {
    throw new Error(`profile ${dir}: ${(e as Error).message}`);
  }
  check(obj(raw) && Object.keys(raw).every((k) => k === "types"), "types.yaml: mapping with types");
  const types = parseTypes(obj(raw) ? raw.types : undefined, "types", dir, check);
  check(types.at(-1)?.name === "default", "types: default must be the last type");
  if (errs.length) throw new Error(`profile ${dir} is invalid:\n  ${errs.join("\n  ")}`);
  return { dir, types };
}

let shipped: Profile | undefined;
/** tender's own `profile/`. */
export const defaultProfile = () => (shipped ??= loadProfile(join(TENDER_DIR, "profile")));

/** A repo type replaces the profile's of the same name in place; a new one goes before `default`. */
export function mergeTypes(base: TaskType[], over: TaskType[]) {
  const kept = base.map((t) => over.find((o) => o.name === t.name) ?? t);
  return [...kept.slice(0, -1), ...over.filter((o) => !base.some((t) => t.name === o.name)), kept.at(-1)!];
}

/** The first type, in order, with a label the ticket has; `default` matches every ticket. */
export const typeFor = (types: TaskType[], labels: string[] = []) => types.find((t) => !t.match || t.match.labels.some((l) => hasLabel(labels, l)))!;
