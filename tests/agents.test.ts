import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, claudeDir, claudeSessions, codexHome, codexState, INBOX_HOOK, INBOX_WAITER, parseAgents, recordedAgent, recordedAgentConfig } from "../src/session/agents";
import { root, session, useTempRoot } from "./helpers";

useTempRoot();

const NOW = 1_000_000_000;
const wt = (id: string) => join(root, "acme/web", id);
const agent = (o: object) => ({ pid: 1, cwd: "/w/a", kind: "interactive", startedAt: 1, sessionId: "s", name: "n", status: "busy", ...o });
const stateAt = (id: string) => join(wt(id), ".tender/run", "codex-state.json");
const hookFile = (id: string, o: unknown) => {
  mkdirSync(join(wt(id), ".tender/run"), { recursive: true });
  writeFileSync(stateAt(id), typeof o === "string" ? o : JSON.stringify(o));
};

test("claude transcript dir is in the ticket's own config dir and mirrors the cwd with non-alphanumerics as -", () => {
  expect(claudeDir("/home/u/agent-ws/acme/web.js/PER-10")).toBe("/home/u/agent-ws/acme/web.js/PER-10.claude/projects/-home-u-agent-ws-acme-web-js-PER-10");
  expect(claudeDir("/w/a-b").split("/").at(-1)).toBe(claudeDir("/w/a.b").split("/").at(-1));
});

test("transcripts lists regular .jsonl files only, never walking a symlinked dir", () => {
  const cd = claudeDir(wt("PER-1"));
  const sd = join(codexHome(wt("PER-1")), "sessions/2026/11");
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

test("codexState reads a fresh, well-formed <wt>/.tender/run/codex-state.json only", () => {
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

test("codexState skips a symlinked .tender or .tender/run, a symlinked or FIFO state file", () => {
  const real = join(root, "real");
  mkdirSync(real);
  writeFileSync(join(real, "codex-state.json"), JSON.stringify({ state: "idle", ts: NOW }));
  mkdirSync(join(wt("L1"), ".tender"), { recursive: true });
  symlinkSync(real, join(wt("L1"), ".tender/run"));
  expect(codexState(wt("L1"), 0, NOW)).toBeUndefined();
  mkdirSync(join(root, "parent/run"), { recursive: true });
  writeFileSync(join(root, "parent/run/codex-state.json"), JSON.stringify({ state: "idle", ts: NOW }));
  mkdirSync(wt("L0"), { recursive: true });
  symlinkSync(join(root, "parent"), join(wt("L0"), ".tender"));
  expect(codexState(wt("L0"), 0, NOW)).toBeUndefined();
  mkdirSync(join(wt("L2"), ".tender/run"), { recursive: true });
  symlinkSync(join(real, "codex-state.json"), stateAt("L2"));
  expect(codexState(wt("L2"), 0, NOW)).toBeUndefined();
  mkdirSync(join(wt("F"), ".tender/run"), { recursive: true });
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


const hook = (dir: string) => Bun.spawn(["sh", "-c", INBOX_HOOK], { stdin: new Blob(["{}"]), stdout: "ignore", stderr: "pipe", env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });

test("inbox hook: exits 2 with the inbox line and consumes it; exits 0 outside a tender clone or once a newer waiter starts", async () => {
  const wt = join(root, "wt");
  mkdirSync(join(wt, ".tender/run"), { recursive: true });
  writeFileSync(join(wt, ".tender/run/inbox"), "read .tender/run/answer.md\n");
  const fire = hook(wt);
  expect(await fire.exited).toBe(2);
  expect(await new Response(fire.stderr).text()).toBe("read .tender/run/answer.md\n");
  expect(existsSync(join(wt, ".tender/run/inbox"))).toBe(false);
  const none = hook(join(root, "none"));
  expect(await none.exited).toBe(0);
  await new Response(none.stderr).text();
  const old = hook(wt);
  while (readFileSync(join(wt, ".tender/run/inbox.pid"), "utf8").trim() !== String(old.pid)) await Bun.sleep(20);
  writeFileSync(join(wt, ".tender/run/inbox.pid"), "1\n");
  expect(await old.exited).toBe(0);
  expect(await new Response(old.stderr).text()).toBe("");
});

test("inbox waiter pattern matches the hook's shell, not Claude's own argv that carries the hook text", () => {
  const re = new RegExp(INBOX_WAITER);
  expect(re.test(`/bin/sh -c ${INBOX_HOOK}`)).toBe(true);
  const [, argv] = AGENTS.claude.launch("/w", "p", true);
  expect(re.test(`/usr/bin/claude ${argv.slice(1).join(" ")}`)).toBe(false);
  expect(re.test(`/home/u/.local/bin/nono run --profile x -- claude ${argv.slice(1).join(" ")}`)).toBe(false);
});

test("launch passes model and effort as quoted words: claude --model/--effort, codex -m and -c before -C", () => {
  const [, claude] = AGENTS.claude.launch("'/w'", "P", false, { model: "opus[1m]", effort: "max" });
  expect(claude.slice(-5)).toEqual(["--model", "'opus[1m]'", "--effort", "'max'", "P"]);
  const [, codex] = AGENTS.codex.launch("'/w'", "P", false, { model: "gpt-5", effort: "high" });
  expect(codex.slice(-7)).toEqual(["-m", "'gpt-5'", "-c", `'model_reasoning_effort="high"'`, "-C", "'/w'", "P"]);
  expect(AGENTS.codex.launch("'/w'", "P", false, {})).toEqual(AGENTS.codex.launch("'/w'", "P", false));
  expect(AGENTS.claude.launch("'/w'", "P", true, { model: "sonnet" })[1].slice(-3)).toEqual(["--model", "'sonnet'", "P"]);
});

test("recordedAgentConfig reads a plain name or JSON, and nothing invalid", () => {
  const dir = join(root, "acme/web");
  mkdirSync(dir, { recursive: true });
  const rec = (s: string) => (writeFileSync(join(dir, "gh-1.agent"), s), recordedAgentConfig(dir, "gh-1"));
  expect(rec("codex\n")).toEqual({ name: "codex", model: undefined, effort: undefined });
  expect(rec('{"name":"claude","model":"opus[1m]","effort":"max"}')).toEqual({ name: "claude", model: "opus[1m]", effort: "max" });
  expect(recordedAgent(dir, "gh-1")).toBe("claude");
  for (const bad of ["gpt", "{", "null", '{"name":"codex","effort":"max"}', '{"name":"claude","model":"a b"}', '{"name":"claude","model":7}']) expect(rec(bad)).toBeUndefined();
  expect(recordedAgentConfig(dir, "gh-2")).toBeUndefined();
});
