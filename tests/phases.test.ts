import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { github } from "../src/trackers/github";
import { pass } from "../src/pass";
import { parsePhases, phaseProgress } from "../src/phases";
import { config, fakeIo, fakeTracker, noPr, phase, root, ticket, useTempRoot, windowsOut, worktree, writePhases } from "./helpers";

useTempRoot();

test("phases: validation rejects bad files", () => {
  expect(parsePhases(JSON.stringify([phase("a", "todo", { body: undefined })]))).toEqual([{ key: "a", title: "Do a", body: "", status: "todo" }]);
  const bad: unknown[] = [
    "not json",
    "{}",
    Array.from({ length: 21 }, (_, i) => phase(`p${i}`, "todo")),
    [phase("Bad_Key", "todo")],
    [phase("constructor", "todo"), phase("constructor", "done")],
    [phase("a", "blocked")],
    [phase("a", ["done"])],
    [phase("-a", "todo")],
    [phase("a", "todo", { title: "" })],
    [phase("a", "todo", { title: "x".repeat(121) })],
    [phase("a", "todo", { title: "two\nlines" })],
    [phase("a", "todo", { body: "x".repeat(4001) })],
    [phase("a", "todo", { body: "\u001b[2J" })],
    [phase("a", "todo", { id: "42" })],
    [null],
  ];
  for (const b of bad) expect(() => parsePhases(typeof b === "string" ? b : JSON.stringify(b))).toThrow();
});

test("phases: created once, status synced forward only, survives restart", async () => {
  const c = config();
  const { tr, calls } = fakeTracker({ inProgress: [ticket(1)] });
  const { io, logs } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/gh-1"]) : noPr(a)));
  writePhases("gh-1", [phase("a", "in-progress"), phase("b", "todo")]);
  await pass(c, io, () => tr, "/aw");
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["create gh-1 gh-1: Do a", "set sub-1 in-progress", "create gh-1 gh-1: Do b"]);
  calls.length = 0;
  writePhases("gh-1", [phase("a", "todo"), phase("b", "done"), phase("c", "todo")]);
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["set sub-3 in-progress", "create gh-1 gh-1: Do c"]);
  expect(logs.some((l) => l.includes("phase gh-1/a: ignoring in-progress -> todo"))).toBe(true);
  expect(JSON.parse(readFileSync(join(root, "acme/web/gh-1.phases.json"), "utf8"))).toEqual({
    a: { ref: "sub-1", status: "in-progress" },
    b: { ref: "sub-3", status: "in-progress" },
    c: { ref: "sub-2", status: "todo" },
  });
  expect(existsSync(join(root, "acme/web/gh-1.phases.json.tmp"))).toBe(false);
});

test("phases: done is held at in-progress until the PR exists, then closed before review", async () => {
  const c = config();
  const { tr, calls } = fakeTracker({ inProgress: [ticket(1)] });
  let prs = "[]";
  const { io } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/gh-1"]) : a[1] === "pr" ? { out: prs } : undefined));
  writePhases("gh-1", [phase("a", "done")]);
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["create gh-1 gh-1: Do a", "set sub-1 in-progress"]);
  prs = '[{"url":"https://pr/1","state":"OPEN"}]';
  await pass(c, io, () => tr, "/aw");
  expect(calls.slice(2)).toEqual(["set sub-1 done", "review gh-1 https://pr/1"]);
});

test("phases: tickets in review keep syncing until the final sync succeeds", async () => {
  const c = config();
  const { tr, calls } = fakeTracker({ inReview: [ticket(1)] });
  const { io } = fakeIo(noPr);
  writePhases("gh-1", [phase("a", "done"), phase("b", "done")]);
  writeFileSync(join(root, "acme/web/gh-1.phases.json"), JSON.stringify({ a: { ref: "sub-a", status: "in-progress" } }));
  await pass(c, io, () => tr, "/aw");
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["set sub-a done", "create gh-1 gh-1: Do b", "set sub-2 done"]);
});

test("phases: a sub-ticket created before a lost sidecar write is adopted, not duplicated", async () => {
  const c = config();
  const { tr, calls, subs } = fakeTracker({ inProgress: [ticket(1)] });
  subs.push({ ref: "sub-other", title: "gh-1: Something else" }, { ref: "sub-old", title: "gh-1: Do a" });
  const { io } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/gh-1"]) : noPr(a)));
  writePhases("gh-1", [phase("a", "in-progress"), phase("b", "todo")]);
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["set sub-old in-progress", "create gh-1 gh-1: Do b"]);
});

test("phases: bad or symlinked file is logged and the parent still moves to review", async () => {
  const c = config();
  const { tr, calls } = fakeTracker({ inProgress: [ticket(1), ticket(2), ticket(3)] });
  const { io, logs } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/gh-1", "acme/web/gh-2", "acme/web/gh-3"]) : a[1] === "pr" ? { out: '[{"url":"https://pr/1","state":"OPEN"}]' } : undefined));
  writePhases("gh-1", "x".repeat(70 * 1024));
  worktree("gh-2");
  mkdirSync(join(root, "outside"));
  writeFileSync(join(root, "outside/phases.json"), JSON.stringify([phase("a", "todo")]));
  symlinkSync(join(root, "outside"), join(root, "acme/web/gh-2/.aw"));
  writePhases("gh-3", "[]");
  rmSync(join(root, "acme/web/gh-3/.aw/phases.json"));
  symlinkSync(join(root, "outside/phases.json"), join(root, "acme/web/gh-3/.aw/phases.json"));
  await pass(c, io, () => tr, "/aw");
  expect(logs.some((l) => l.includes("phases gh-1 failed: phases.json: must be a regular file"))).toBe(true);
  expect(logs.some((l) => l.includes("phases gh-2 failed: ENOTDIR"))).toBe(true);
  expect(logs.some((l) => l.includes("phases gh-3 failed: ELOOP"))).toBe(true);
  expect(calls).toEqual(["review gh-1 https://pr/1", "review gh-2 https://pr/1", "review gh-3 https://pr/1"]);
});

test("phases: start git-ignores .aw; cleanup removes the sidecar", async () => {
  const c = config();
  const { tr } = fakeTracker({ ready: [ticket(1)], done: ["gh-2"] });
  worktree("gh-2");
  writeFileSync(join(root, "acme/web/gh-2.phases.json"), "{}");
  const { io } = fakeIo(noPr);
  await pass(c, io, () => tr, "/aw");
  expect(readFileSync(join(root, "acme/web/gh-1/.aw/.gitignore"), "utf8")).toBe("*\n");
  expect(existsSync(join(root, "acme/web/gh-2.phases.json"))).toBe(false);
});

test("phases: a FIFO phases file is rejected without blocking the poller", async () => {
  const c = config();
  const { tr } = fakeTracker({ inProgress: [ticket(1)] });
  const { io, logs } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/gh-1"]) : noPr(a)));
  worktree("gh-1");
  mkdirSync(join(root, "acme/web/gh-1/.aw"), { recursive: true });
  expect(Bun.spawnSync(["mkfifo", join(root, "acme/web/gh-1/.aw/phases.json")]).exitCode).toBe(0);
  await pass(c, io, () => tr, "/aw");
  expect(logs.some((l) => l.includes("phases gh-1 failed: phases.json: must be a regular file"))).toBe(true);
});

test("phases: dry-run creates nothing and writes no sidecar", async () => {
  const c = config();
  const { io, cmds, logs } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/gh-1"]) : a[2] === "list" ? { out: JSON.stringify([{ number: 1, title: "t", body: "", url: "u", labels: [] }]) } : a[1] === "api" ? { out: "[]" } : noPr(a)), true);
  writePhases("gh-1", [phase("a", "done")]);
  await pass(c, io, github, "/aw");
  expect(cmds.filter((x) => /issue (create|edit|close)/.test(x))).toEqual([]);
  expect(logs.some((l) => l.includes("dry: gh issue create --repo acme/web --parent 1"))).toBe(true);
  expect(logs.some((l) => l.includes("dry: gh issue close  --repo acme/web"))).toBe(true);
  expect(existsSync(join(root, "acme/web/gh-1.phases.json"))).toBe(false);
});

test("phaseProgress: agent file, sidecar fallback titled by key, invalid either way is null", () => {
  const dir = join(root, "acme/web");
  const side = (id: string, v: unknown) => writeFileSync(join(dir, `${id}.phases.json`), JSON.stringify(v));
  writePhases("gh-1", [phase("a", "done"), phase("b", "todo")]);
  side("gh-1", { z: { ref: "1", status: "done" } });
  expect(phaseProgress(dir, "gh-1")).toEqual({ done: 1, total: 2, items: [{ key: "a", title: "Do a", status: "done" }, { key: "b", title: "Do b", status: "todo" }] });
  worktree("gh-2");
  expect(phaseProgress(dir, "gh-2")).toBeNull();
  side("gh-2", { a: { ref: "1", status: "done" }, b: { ref: "2", status: "in-progress" } });
  expect(phaseProgress(dir, "gh-2")).toEqual({ done: 1, total: 2, items: [{ key: "a", title: "a", status: "done" }, { key: "b", title: "b", status: "in-progress" }] });
  for (const bad of [{ a: { ref: "1" } }, { a: { ref: "1", status: "blocked" } }, { "Bad key": { ref: "1", status: "done" } }, [], null]) {
    side("gh-2", bad);
    expect(phaseProgress(dir, "gh-2")).toBeNull();
  }
  writePhases("gh-3", "[not json");
  side("gh-3", { a: { ref: "1", status: "done" } });
  expect(phaseProgress(dir, "gh-3")).toBeNull();
});
