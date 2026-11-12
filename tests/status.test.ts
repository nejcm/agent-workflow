import { expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dur, rows, table } from "../src/status";
import { claudeDir } from "../src/tail";
import { config, phase, root, useTempRoot, worktree, writePhases } from "./helpers";

useTempRoot();

const T = 1_000_000;
const at = (p: string, s: number) => (writeFileSync(p, ""), utimesSync(p, s, s));
const dir = () => join(root, "acme/web");
const wins = (...ids: string[]) => new Map(ids.map((id, i) => [`acme/web/${id}`, `@${i}`]));

test("running, ended and orphan rows with runtime, idle, phases and PR", () => {
  worktree("PER-1");
  worktree("PER-2");
  worktree("PER-3");
  at(join(dir(), "PER-1.sh"), T - 3600);
  at(join(dir(), "PER-2.sh"), T - 600);
  at(join(dir(), "PER-2.ended"), T - 60);
  writeFileSync(join(dir(), "PER-2.merge"), "abc123");
  const cd = claudeDir(root, join(dir(), "PER-1"));
  mkdirSync(cd, { recursive: true });
  const prLink = JSON.stringify({ type: "pr-link", sessionId: "s", prNumber: 4, prUrl: "https://github.com/acme/web/pull/4", prRepository: "acme/web", timestamp: "2026-11-12T05:43:59.187Z" });
  writeFileSync(join(cd, "s.jsonl"), `{"type":"user","cwd":"${join(dir(), "PER-1")}"}\n${prLink}\n{"type":"assistant"}\n`);
  utimesSync(join(cd, "s.jsonl"), T - 30, T - 30);
  writePhases("PER-1", [phase("a", "done", { title: "Fix ‮ bidi" }), phase("b", "in-progress"), phase("c", "todo")]);

  const rs = rows(config(), wins("PER-1", "PER-2"), root, T * 1000);
  expect(rs.map((r) => [r.id, r.session, r.state])).toEqual([["PER-1", "running", "unknown"], ["PER-2", "ended", "ended"], ["PER-3", "orphan", "ended"]]);
  const [a, b, c] = rs;
  expect(a).toMatchObject({ repo: "acme/web", agent: "claude", startedAt: (T - 3600) * 1000, runtimeMs: 3_600_000, idleMs: 30_000, phases: { done: 1, total: 3, items: [{ key: "a", title: "Fix bidi", status: "done" }, { key: "b", title: "Do b", status: "in-progress" }, { key: "c", title: "Do c", status: "todo" }] }, pr: "https://github.com/acme/web/pull/4", merge: null, window: "@0" });
  expect(b).toMatchObject({ runtimeMs: 540_000, idleMs: null, phases: null, pr: null, merge: "held", transcript: null, window: null });
  expect(c!.runtimeMs).toBeGreaterThanOrEqual(0);
  expect(JSON.parse(JSON.stringify(rs))).toEqual(rs);

  const t = table(rs).split("\n");
  expect(t[0]).toMatch(/^ID\s+REPO\s+AGENT\s+SESSION\s+STATE\s+RUNTIME\s+IDLE\s+PHASES\s+PR$/);
  expect(t[1]).toMatch(/^PER-1\s+acme\/web\s+claude\s+running\s+unknown\s+1h00m\s+30s\s+1\/3\s+#4$/);
  expect(t[2]).toMatch(/ended\s+ended\s+9m\s+-\s+-\s+held$/);
  expect(t[3]).toMatch(/^PER-3\s+acme\/web\s+claude\s+orphan\s+orphan\s/);
  expect(table([])).toBe("no worktrees");
});

test("phases fall back to the sidecar; an invalid agent file shows none; a forged pr-link url is ignored", () => {
  worktree("PER-4");
  writeFileSync(join(dir(), "PER-4.phases.json"), JSON.stringify({ a: { ref: "1", status: "done" }, b: { ref: "2", status: "in-progress" } }));
  writePhases("PER-5", "[not json");
  const cd = claudeDir(root, join(dir(), "PER-5"));
  mkdirSync(cd, { recursive: true });
  writeFileSync(join(cd, "s.jsonl"), JSON.stringify({ type: "pr-link", cwd: join(dir(), "PER-5"), prUrl: "https://evil.example/\x1b[2J" }));
  const [r4, r5] = rows(config(), new Map(), root, T * 1000);
  expect(r4!.phases).toEqual({ done: 1, total: 2, items: [{ key: "a", title: "a", status: "done" }, { key: "b", title: "b", status: "in-progress" }] });
  expect(r5!.phases).toBeNull();
  expect(r5!.pr).toBeNull();
});

test("dur", () => {
  expect([null, 5_000, 125_000, 3_725_000, 90_000_000].map(dur)).toEqual(["-", "5s", "2m", "1h02m", "1d1h"]);
});

test("status skips a FIFO transcript, scans only the tail for the PR, and sanitizes table cells", () => {
  worktree("PER-6");
  worktree("PER-7");
  const fifo = join(claudeDir(root, join(dir(), "PER-6")), "s.jsonl");
  mkdirSync(join(fifo, ".."), { recursive: true });
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const cd = claudeDir(root, join(dir(), "PER-7"));
  mkdirSync(cd, { recursive: true });
  const link = JSON.stringify({ type: "pr-link", cwd: join(dir(), "PER-7"), prUrl: "https://github.com/acme/web/pull/7" });
  writeFileSync(join(cd, "s.jsonl"), `${link}\n${JSON.stringify({ type: "user", pad: "x".repeat(300 * 1024) })}\n`);
  const [r6, r7] = rows(config(), new Map(), root, T * 1000);
  expect(r6!.transcript).toBeNull();
  expect(r7!.transcript).toBe(join(cd, "s.jsonl"));
  expect(r7!.pr).toBeNull();
  const t = table([{ ...r7!, repo: "\x1b]52;c;ZXZpbA==\x07acme/web" }]);
  expect(t).not.toMatch(/[\x00-\x09\x0b-\x1f]/);
});
