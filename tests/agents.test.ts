import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, claudeDir, claudeSessions, codexState, parseAgents } from "../src/agents";
import { root, session, useTempRoot } from "./helpers";

useTempRoot();

const NOW = 1_000_000_000;
const wt = (id: string) => join(root, "acme/web", id);
const agent = (o: object) => ({ pid: 1, cwd: "/w/a", kind: "interactive", startedAt: 1, sessionId: "s", name: "n", status: "busy", ...o });
const stateAt = (id: string) => join(wt(id), ".aw", "codex-state.json");
const hookFile = (id: string, o: unknown) => {
  mkdirSync(join(wt(id), ".aw"), { recursive: true });
  writeFileSync(stateAt(id), typeof o === "string" ? o : JSON.stringify(o));
};

test("claude transcript dir is in the ticket's own config dir and mirrors the cwd with non-alphanumerics as -", () => {
  expect(claudeDir("/home/u/agent-ws/acme/web.js/PER-10")).toBe("/home/u/agent-ws/acme/web.js/PER-10.claude/projects/-home-u-agent-ws-acme-web-js-PER-10");
  expect(claudeDir("/w/a-b").split("/").at(-1)).toBe(claudeDir("/w/a.b").split("/").at(-1));
});

test("transcripts lists regular .jsonl files only, never walking a symlinked dir", () => {
  const cd = claudeDir(wt("PER-1"));
  const sd = join(root, ".codex-aw/sessions/2026/11");
  for (const d of [cd, sd]) mkdirSync(d, { recursive: true });
  for (const f of [join(cd, "a.jsonl"), join(cd, "b.txt"), join(sd, "r.jsonl")]) writeFileSync(f, "");
  symlinkSync(join(cd, "a.jsonl"), join(cd, "link.jsonl"));
  symlinkSync(root, join(sd, "loop"));
  expect(AGENTS.claude.transcripts(wt("PER-1"), root)).toEqual([join(cd, "a.jsonl")]);
  expect(AGENTS.codex.transcripts(wt("PER-1"), root)).toEqual([join(sd, "r.jsonl")]);
  expect(AGENTS.claude.transcripts(wt("PER-2"), root)).toEqual([]);
});

test("codex live state is the hook file lookup", async () => {
  hookFile("A", { state: "idle", ts: NOW });
  expect((await AGENTS.codex.live(root, []))(wt("A"), 0, NOW)).toEqual({ state: "idle", since: NOW, waitingFor: null });
});

test("parseAgents maps busy/waiting/idle by exact cwd, newest session wins", () => {
  const m = parseAgents([agent({ cwd: "/w/a", status: "idle", startedAt: 5 }), agent({ cwd: "/w/a", status: "busy", startedAt: 9 }), agent({ cwd: "/w/b", status: "waiting", waitingFor: "permission" }), agent({ cwd: "/w/c", status: "idle" })]);
  expect(Object.fromEntries(m)).toEqual({
    "/w/a": { state: "working", since: null, waitingFor: null },
    "/w/b": { state: "waiting", since: null, waitingFor: "permission" },
    "/w/c": { state: "idle", since: null, waitingFor: null },
  });
  expect(parseAgents([]).size).toBe(0);
});

test("parseAgents skips malformed records and neutralizes hostile strings", () => {
  const m = parseAgents(([1, null, "x", { cwd: 5, status: "busy" }, agent({ cwd: "/w/p", status: "__proto__" }), agent({ cwd: "/w/q", status: "waiting", waitingFor: "\x1b]52;c;ZXZpbA==\x07ok‮" + "y".repeat(500) }), agent({ cwd: "/w/r", status: "idle", waitingFor: "ignored" })]));
  expect([...m.keys()]).toEqual(["/w/p", "/w/q", "/w/r"]);
  expect(m.get("/w/p")!.state).toBe("unknown");
  expect(m.get("/w/q")!.waitingFor).toMatch(/^ok y+$/);
  expect(m.get("/w/q")!.waitingFor!.length).toBe(60);
  expect(m.get("/w/r")!.waitingFor).toBeNull();
});

test("codexState reads a fresh, well-formed <wt>/.aw/codex-state.json only", () => {
  const ok = { state: "waiting", ts: NOW - 5000 };
  hookFile("A", ok);
  expect(codexState(wt("A"), NOW - 60_000, NOW)).toEqual({ state: "waiting", since: NOW - 5000, waitingFor: "permission" });
  expect(codexState(wt("A"), NOW - 1000, NOW)).toBeUndefined();
  for (const o of [{ ...ok, state: "busy" }, { ...ok, state: "__proto__" }, { ...ok, ts: "1" }, { ...ok, ts: NOW + 3_600_000 }, [ok], "{", JSON.stringify(ok) + " ".repeat(5000)]) {
    hookFile("A", o);
    expect(codexState(wt("A"), NOW - 60_000, NOW)).toBeUndefined();
  }
  expect(codexState(wt("missing"), 0, NOW)).toBeUndefined();
});

test("codexState skips a symlinked .aw, a symlinked or FIFO state file", () => {
  const real = join(root, "real");
  mkdirSync(real);
  writeFileSync(join(real, "codex-state.json"), JSON.stringify({ state: "idle", ts: NOW }));
  mkdirSync(wt("L1"), { recursive: true });
  symlinkSync(real, join(wt("L1"), ".aw"));
  expect(codexState(wt("L1"), 0, NOW)).toBeUndefined();
  mkdirSync(join(wt("L2"), ".aw"), { recursive: true });
  symlinkSync(join(real, "codex-state.json"), stateAt("L2"));
  expect(codexState(wt("L2"), 0, NOW)).toBeUndefined();
  mkdirSync(join(wt("F"), ".aw"), { recursive: true });
  expect(Bun.spawnSync(["mkfifo", stateAt("F")]).exitCode).toBe(0);
  expect(codexState(wt("F"), 0, NOW)).toBeUndefined();
});

test("claudeSessions reads live <pid>.json records only, never through a symlink", () => {
  const dir = join(root, "c.claude");
  session(dir, { cwd: "/w/a", status: "idle" });
  const sessions = join(dir, "sessions");
  writeFileSync(join(sessions, "1.json"), JSON.stringify(agent({ pid: 1, procStart: "0" })));
  writeFileSync(join(sessions, "x.json"), JSON.stringify(agent({ pid: process.pid })));
  writeFileSync(join(sessions, "2.json"), "{");
  writeFileSync(join(root, "real.json"), JSON.stringify(agent({ pid: 3 })));
  symlinkSync(join(root, "real.json"), join(sessions, "3.json"));
  expect(claudeSessions(dir)).toEqual([expect.objectContaining({ pid: process.pid, cwd: "/w/a", status: "idle" })]);
  expect(claudeSessions(join(root, "none"))).toEqual([]);
  symlinkSync(sessions, join(root, "sessions"));
  mkdirSync(join(root, "d.claude"));
  symlinkSync(sessions, join(root, "d.claude", "sessions"));
  expect(claudeSessions(join(root, "d.claude"))).toEqual([]);
});

