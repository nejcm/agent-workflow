import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, claudeAgents, claudeDir, codexState, parseAgents } from "../src/agents";
import { root, useTempRoot } from "./helpers";

useTempRoot();

const NOW = 1_000_000_000;
const wt = (id: string) => join(root, "acme/web", id);
const agent = (o: object) => ({ pid: 1, cwd: "/w/a", kind: "interactive", startedAt: 1, sessionId: "s", name: "n", status: "busy", ...o });
const stateAt = (id: string) => join(wt(id), ".aw", "codex-state.json");
const hookFile = (id: string, o: unknown) => {
  mkdirSync(join(wt(id), ".aw"), { recursive: true });
  writeFileSync(stateAt(id), typeof o === "string" ? o : JSON.stringify(o));
};

test("claude transcript dir mirrors the cwd with non-alphanumerics as -, so a-b and a.b collide", () => {
  expect(claudeDir("/h", "/home/u/agent-ws/acme/web.js/PER-10")).toBe("/h/.claude-aw/projects/-home-u-agent-ws-acme-web-js-PER-10");
  expect(claudeDir(root, "/w/a-b")).toBe(claudeDir(root, "/w/a.b"));
});

test("transcripts lists regular .jsonl files only, never walking a symlinked dir", () => {
  const cd = claudeDir(root, wt("PER-1"));
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
  expect((await AGENTS.codex.live(root))(wt("A"), 0, NOW)).toEqual({ state: "idle", since: NOW, waitingFor: null });
});

test("parseAgents maps busy/waiting/idle by exact cwd, newest session wins", () => {
  const m = parseAgents(JSON.stringify([agent({ cwd: "/w/a", status: "idle", startedAt: 5 }), agent({ cwd: "/w/a", status: "busy", startedAt: 9 }), agent({ cwd: "/w/b", status: "waiting", waitingFor: "permission" }), agent({ cwd: "/w/c", status: "idle" })]))!;
  expect(Object.fromEntries(m)).toEqual({
    "/w/a": { state: "working", since: null, waitingFor: null },
    "/w/b": { state: "waiting", since: null, waitingFor: "permission" },
    "/w/c": { state: "idle", since: null, waitingFor: null },
  });
  expect(parseAgents("[]")!.size).toBe(0);
});

test("parseAgents rejects malformed or unexpected output and neutralizes hostile strings", () => {
  for (const bad of [undefined, "", "not json", "{}", '"x"', "null", `[${"1,".repeat(600_000)}1]`]) expect(parseAgents(bad)).toBeUndefined();
  const m = parseAgents(JSON.stringify([1, null, "x", { cwd: 5, status: "busy" }, agent({ cwd: "/w/p", status: "__proto__" }), agent({ cwd: "/w/q", status: "waiting", waitingFor: "\x1b]52;c;ZXZpbA==\x07ok‮" + "y".repeat(500) }), agent({ cwd: "/w/r", status: "idle", waitingFor: "ignored" })]))!;
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

test("claudeAgents returns stdout, and gives up at the deadline or the size cap, killing the whole group", async () => {
  expect(await claudeAgents(root, 2000, ["sh", "-c", "echo '[]'"])).toBe("[]\n");
  expect(await claudeAgents(root, 2000, ["sh", "-c", "exit 3"])).toBeUndefined();
  expect(await claudeAgents(root, 2000, ["/nonexistent/claude"])).toBeUndefined();
  const pidFile = join(root, "pid");
  for (const cmd of ["trap '' TERM; echo $$ > PID; sleep 30", "sleep 30 & echo $! > PID; echo '[]'"]) {
    const t = Date.now();
    expect(await claudeAgents(root, 300, ["sh", "-c", cmd.replace("PID", pidFile)])).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(1500);
    await Bun.sleep(100);
    expect(Bun.spawnSync(["kill", "-0", readFileSync(pidFile, "utf8").trim()]).exitCode).not.toBe(0);
  }
  const t = Date.now();
  expect(await claudeAgents(root, 5000, ["sh", "-c", "yes"])).toBeUndefined();
  expect(Date.now() - t).toBeLessThan(4000);
});

