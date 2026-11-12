import { expect, test } from "bun:test";
import { rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { State } from "../src/state";
import { dur, rows, table } from "../src/status";
import { claudeFile, config, phase, root, useTempRoot, worktree, writePhases } from "./helpers";

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
  const s = claudeFile(join(dir(), "PER-1"), "s.jsonl", '{"type":"assistant"}');
  writeFileSync(join(dir(), "PER-1.pr"), "https://github.com/acme/web/pull/4");
  utimesSync(s, T - 30, T - 30);
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

test("the PR comes from <ID>.pr for any agent; a forged or oversize one is ignored", () => {
  writePhases("PER-5", "[not json");
  for (const id of ["PER-4", "PER-6", "PER-8"]) worktree(id);
  writeFileSync(join(dir(), "PER-4.pr"), "https://github.com/acme/web/pull/4\n");
  writeFileSync(join(dir(), "PER-5.pr"), "https://evil.example/\x1b[2J");
  writeFileSync(join(dir(), "PER-6.pr"), `https://github.com/acme/web/pull/6${" ".repeat(600)}`);
  symlinkSync(join(dir(), "PER-4.pr"), join(dir(), "PER-8.pr"));
  const c = config({ repos: [{ name: "acme/web", path: join(root, "src-web"), agent: "codex" }] });
  expect(rows(c, new Map(), root, T * 1000).map((r) => [r.id, r.agent, r.pr])).toEqual([
    ["PER-4", "codex", "https://github.com/acme/web/pull/4"],
    ["PER-5", "codex", null],
    ["PER-6", "codex", null],
    ["PER-8", "codex", null],
  ]);
});

test("dur", () => {
  expect([null, 5_000, 125_000, 3_725_000, 90_000_000].map(dur)).toEqual(["-", "5s", "2m", "1h02m", "1d1h"]);
});

test("status skips a FIFO transcript and sanitizes table cells", () => {
  worktree("PER-6");
  worktree("PER-7");
  const fifo = claudeFile(join(dir(), "PER-6"), "s.jsonl");
  rmSync(fifo);
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const s7 = claudeFile(join(dir(), "PER-7"), "s.jsonl");
  const [r6, r7] = rows(config(), new Map(), root, T * 1000);
  expect(r6!.transcript).toBeNull();
  expect(r7!.transcript).toBe(s7);
  const t = table([{ ...r7!, repo: "\x1b]52;c;ZXZpbA==\x07acme/web" }]);
  expect(t).not.toMatch(/[\x00-\x09\x0b-\x1f]/);
});

test("an open question shows over idle only, and not once the ticket has a PR", () => {
  const states: Record<string, State> = { "PER-1": "idle", "PER-2": "unknown", "PER-3": "working", "PER-4": "waiting", "PER-5": "idle", "PER-6": "idle", "PER-7": "idle", "PER-8": "idle", "PER-9": "idle" };
  for (const id of Object.keys(states)) worktree(id);
  for (const id of ["PER-1", "PER-2", "PER-3", "PER-4", "PER-7", "PER-8", "PER-9"]) writeFileSync(join(dir(), `${id}.question`), JSON.stringify({ hash: "h", postedAt: 1 }));
  writeFileSync(join(dir(), "PER-5.question"), JSON.stringify({ hash: "h", postedAt: 1, answerId: "c1" }));
  writeFileSync(join(dir(), "PER-6.question"), "{broken");
  at(join(dir(), "PER-7.ended"), T);
  writeFileSync(join(dir(), "PER-8.pr"), "https://github.com/acme/web/pull/8");
  const feed = (wt: string) => ({ state: states[wt.slice(wt.lastIndexOf("/") + 1)]!, since: null, waitingFor: null });
  const rs = rows(config(), wins(...Object.keys(states).filter((id) => id !== "PER-9")), root, T * 1000, { claude: feed });
  expect(rs.map((r) => `${r.id}:${r.state}`)).toEqual(["PER-1:question", "PER-2:unknown", "PER-3:working", "PER-4:waiting", "PER-5:idle", "PER-6:idle", "PER-7:ended", "PER-8:idle", "PER-9:ended"]);
  expect(table(rs).split("\n").at(-1)).toMatch(/^PER-9\s+acme\/web\s+claude\s+orphan\s+orphan\s/);
});
