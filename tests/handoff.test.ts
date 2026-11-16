import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { claudeDir, codexHome } from "../src/agents";
import { handoff, shellLine, ticketClone, toolArgv } from "../src/handoff";
import { resume, scopeUnit } from "../src/launcher";
import { passLocked } from "../src/util";
import { pass } from "../src/pass";
import { claudeFile, config, fakeIo, fakeTracker, noPr, root, ticket, useTempRoot, windowsOut, worktree } from "./helpers";

useTempRoot();

const SID = "0b5c2f0e-1d2a-4c3b-8e4f-5a6b7c8d9e0f";
const wt = () => join(root, "acme/web/gh-1");
const stores = () => ({ claude: join(root, "me/.claude"), codex: join(root, "me/.codex") });
const clone = (agent = "claude") => {
  worktree("gh-1");
  writeFileSync(join(root, "acme/web/gh-1.agent"), agent);
};
const tmux = (wins: string[] = ["acme/web/gh-1"]) => fakeIo((a) => (a[1] === "list-windows" ? windowsOut(wins) : noPr(a)));

test("argv per tool: a resume of the tool's own session, else a fresh session told the prompt; t3 runs nothing; editor from $VISUAL or $EDITOR", () => {
  expect(toolArgv("claude", SID, "p", undefined)).toEqual(["claude", "--resume", SID]);
  expect(toolArgv("claude", undefined, "p", undefined)).toEqual(["claude", "p"]);
  expect(toolArgv("codex", SID, "p", undefined)).toEqual(["codex", "resume", SID]);
  expect(toolArgv("codex", undefined, "p", undefined)).toEqual(["codex", "p"]);
  expect(toolArgv("t3", SID, "p", "vim")).toEqual([]);
  expect(toolArgv("editor", undefined, "p", "code -w")).toEqual(["sh", "-c", 'code -w "$@"', "sh", "."]);
  for (const e of [undefined, "", "  "]) expect(() => toolArgv("editor", undefined, "p", e)).toThrow("set $VISUAL or $EDITOR");
});

test("editor: a quoted path with spaces and its flags run as the shell reads $EDITOR, opened on the clone", () => {
  const bin = join(root, "My Editor");
  mkdirSync(bin);
  writeFileSync(join(bin, "ed"), '#!/bin/sh\nprintf "%s|" "$@"\n', { mode: 0o755 });
  const r = Bun.spawnSync(toolArgv("editor", undefined, "", `'${bin}/ed' -w`), { cwd: root });
  expect(r.stdout.toString()).toBe("-w|.|");
});

test("the printed line survives a POSIX shell: quotes, spaces, $() and newlines stay literal", () => {
  const dir = join(root, "it's a $(dir)");
  mkdirSync(dir);
  const args = ["a b", "it's", "$(touch pwned)", "`x`", "x\ny", "--resume", "", "plain-1.2/x"];
  const line = shellLine(dir, ["printf", "%s|", ...args]);
  expect(line.startsWith(`cd '${root}/it'\\''s a $(dir)' && printf '%s|' 'a b'`)).toBe(true);
  const r = Bun.spawnSync(["sh", "-c", line], { cwd: root });
  expect(r.stdout.toString()).toBe(args.map((a) => `${a}|`).join(""));
  expect(existsSync(join(dir, "pwned"))).toBe(false);
});

test("open refuses a ticket with no worktree before writing or stopping anything", async () => {
  const { io, cmds } = tmux();
  await expect(handoff(config(), io, "gh-1", "claude", stores())).rejects.toThrow("gh-1 has no worktree");
  await expect(handoff(config(), io, "acme/web/gh-1", "t3", stores())).rejects.toThrow("has no worktree");
  expect(() => ticketClone(config(), "../x")).toThrow("invalid");
  expect(existsSync(join(root, "acme/web/gh-1.handoff"))).toBe(false);
  expect(cmds).toEqual([]);
});

test("open: writes the hand-off, kills scope and window without keys, copies the transcript to the person's store and resumes it there", async () => {
  clone();
  const tx = claudeFile(wt(), `${SID}.jsonl`, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }));
  const { io, cmds, logs } = tmux();
  const h = await handoff(config(), io, "gh-1", undefined, stores());
  expect(h).toEqual({ key: "acme/web", id: "gh-1", wt: wt(), argv: ["claude", "--resume", SID] });
  expect(logs.some((l) => l.includes("written inside the sandbox"))).toBe(true);
  expect(readFileSync(join(root, "acme/web/gh-1.handoff"), "utf8")).toBe("claude\n");
  expect(cmds).toEqual(["tmux list-windows -t =tender -F #{window_id} #{window_activity} #{window_name}", `systemctl --user kill --signal=KILL ${scopeUnit(config(), "acme/web", "gh-1")}`, "tmux kill-window -t @0"]);
  const copy = join(stores().claude, "projects", basename(claudeDir(wt())), `${SID}.jsonl`);
  expect(readFileSync(copy, "utf8")).toBe(readFileSync(tx, "utf8"));
  writeFileSync(copy, "continued by hand");
  await handoff(config(), tmux([]).io, "gh-1", "claude", stores());
  expect(readFileSync(copy, "utf8")).toBe("continued by hand");
});

test("open: codex resumes its rollout by id from the person's CODEX_HOME", async () => {
  clone("codex");
  const rel = `2026/11/16/rollout-2026-11-16T00-22-53-${SID}.jsonl`;
  mkdirSync(dirname(join(codexHome(wt()), "sessions", rel)), { recursive: true });
  writeFileSync(join(codexHome(wt()), "sessions", rel), JSON.stringify({ type: "session_meta", payload: { id: SID, cwd: wt() } }) + "\n");
  const h = await handoff(config(), tmux().io, "gh-1", "codex", stores());
  expect(h.argv).toEqual(["codex", "resume", SID]);
  expect(existsSync(join(stores().codex, "sessions", rel))).toBe(true);
});

test("open in another tool, or with no usable transcript, starts fresh with a prompt naming the task, transcript and run files", async () => {
  clone();
  const tx = claudeFile(wt(), `${SID}.jsonl`);
  const fresh = tmux();
  const h = await handoff(config(), fresh.io, "gh-1", "codex", stores());
  expect(fresh.logs.some((l) => l.includes("inside the sandbox"))).toBe(false);
  expect(h.argv[0]).toBe("codex");
  expect(h.argv[1]).toContain(join(root, "acme/web/gh-1.prompt.md"));
  expect(h.argv[1]).toContain(tx);
  expect(h.argv[1]).toContain(".tender/run/");
  expect(existsSync(stores().codex)).toBe(false);
  expect((await handoff(config(), tmux().io, "gh-1", "t3", stores())).argv).toEqual([]);
  expect(readFileSync(join(root, "acme/web/gh-1.handoff"), "utf8")).toBe("t3\n");
});

test("open never copies a transcript reached through a link the session planted", async () => {
  clone();
  const elsewhere = join(root, "elsewhere");
  mkdirSync(join(elsewhere, basename(claudeDir(wt()))), { recursive: true });
  writeFileSync(join(elsewhere, basename(claudeDir(wt())), `${SID}.jsonl`), JSON.stringify({ type: "user", cwd: wt() }) + "\n");
  mkdirSync(join(root, "acme/web/gh-1.claude"), { recursive: true });
  symlinkSync(elsewhere, join(root, "acme/web/gh-1.claude/projects"));
  const h = await handoff(config(), tmux().io, "gh-1", "claude", stores());
  expect(h.argv[0]).toBe("claude");
  expect(h.argv[1]).not.toBe("--resume");
  expect(existsSync(stores().claude)).toBe(false);
});

test("a handed-off ticket is parked: no ended-without-PR comment or stall check; the move to In Review and cleanup still run", async () => {
  clone();
  worktree("gh-2");
  mkdirSync(join(root, "src-web"), { recursive: true });
  for (const id of ["gh-1", "gh-2", "gh-3"]) writeFileSync(join(root, `acme/web/${id}.handoff`), "claude\n");
  worktree("gh-3");
  const { tr, calls } = fakeTracker({ inProgress: [ticket(1), ticket(3)], done: ["gh-2"] });
  const { io, cmds } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut([]) : a[1] === "pr" ? { out: a.includes("agent/gh-3") ? '[{"url":"https://pr/3","state":"OPEN"}]' : "[]" } : undefined));
  await pass(config(), io, () => tr, "/tender");
  expect(calls).toEqual(["review gh-3 PR: https://pr/3"]);
  expect(existsSync(join(root, "acme/web/gh-1.ended"))).toBe(false);
  expect(cmds).toContain(`rm -rf --one-file-system -- ${root}/acme/web/gh-2`);
  expect(existsSync(join(root, "acme/web/gh-2.handoff"))).toBe(false);
});

test("resume refuses a ticket not handed off, ended meanwhile, still windowed or in a repo not in tender.json", async () => {
  clone();
  const target = { key: "acme/web", id: "gh-1" };
  await expect(resume(config(), tmux([]).io, target, "/tender")).rejects.toThrow("not handed off");
  writeFileSync(join(root, "acme/web/gh-1.handoff"), "claude\n");
  await expect(resume(config(), tmux().io, target, "/tender")).rejects.toThrow("already has a tmux window");
  writeFileSync(join(root, "acme/web/gh-1.ended"), "");
  await expect(resume(config(), tmux([]).io, target, "/tender")).rejects.toThrow("ended");
  await expect(resume(config(), tmux([]).io, { key: "acme/api", id: "gh-1" }, "/tender")).rejects.toThrow("not in tender.json");
});

test("resume starts a new window in the same clone with a continue note before the original prompt, claims nothing and clears the hand-off", async () => {
  clone();
  const promptFile = join(root, "acme/web/gh-1.prompt.md");
  writeFileSync(promptFile, "Original task\n");
  for (let i = 0; i < 2; i++) {
    writeFileSync(join(root, "acme/web/gh-1.handoff"), "claude\n");
    const { io, cmds } = tmux([]);
    await resume(config(), io, { key: "acme/web", id: "gh-1" }, "/tender");
    expect(cmds).toContain(`tmux new-window -d -t =tender: -n acme/web/gh-1 ${root}/acme/web/gh-1.sh`);
    expect(cmds.some((c) => c.includes(" clone "))).toBe(false);
    expect(existsSync(join(root, "acme/web/gh-1.handoff"))).toBe(false);
  }
  const prompt = readFileSync(promptFile, "utf8");
  expect(prompt.match(/taking ticket gh-1 back/g)).toHaveLength(1);
  expect(prompt.endsWith("\n\nOriginal task\n")).toBe(true);
  expect(existsSync(join(root, "acme/web/gh-1.claim"))).toBe(false);
  rmSync(promptFile);
  writeFileSync(join(root, "acme/web/gh-1.handoff"), "claude\n");
  await expect(resume(config(), tmux([]).io, { key: "acme/web", id: "gh-1" }, "/tender")).rejects.toThrow("ENOENT");
  expect(existsSync(join(root, "acme/web/gh-1.handoff"))).toBe(true);
});

test("a handed-off ticket listed Ready is not started again, and its pending claim is still retried", async () => {
  clone();
  mkdirSync(join(root, "src-web"), { recursive: true });
  writeFileSync(join(root, "acme/web/gh-1.handoff"), "editor\n");
  writeFileSync(join(root, "acme/web/gh-1.claim"), "x");
  writeFileSync(join(root, "acme/web/gh-1.prompt.md"), "Original task\n");
  const { tr, calls } = fakeTracker({ ready: [ticket(1)] });
  const { io, cmds } = tmux([]);
  await pass(config(), io, () => tr, "/tender");
  expect(calls).toEqual(["claim gh-1"]);
  expect(cmds.some((c) => c.includes("new-window"))).toBe(false);
  expect(readFileSync(join(root, "acme/web/gh-1.prompt.md"), "utf8")).toBe("Original task\n");
  expect(existsSync(join(root, "acme/web/gh-1.claim"))).toBe(false);
});

async function holdPass() {
  let release!: () => void;
  let inside = false;
  const held = passLocked(config(), () => {}, () => ((inside = true), new Promise<void>((r) => (release = r))));
  while (!inside) await Bun.sleep(10);
  return async () => (release(), await held);
}

test("open waits for a running poll's lock, so a pass never acts on a hand-off it read before", async () => {
  clone();
  const release = await holdPass();
  const { io, cmds, logs } = tmux();
  const opening = handoff(config(), io, "gh-1", "t3", stores());
  await Bun.sleep(300);
  expect(existsSync(join(root, "acme/web/gh-1.handoff"))).toBe(false);
  expect(cmds).toEqual([]);
  expect(logs.some((l) => l.startsWith("waiting for the poll holding"))).toBe(true);
  await release();
  await opening;
  expect(existsSync(join(root, "acme/web/gh-1.handoff"))).toBe(true);
});

test("resume waits for a running poll's lock, so a pass never sees its window list go stale", async () => {
  clone();
  writeFileSync(join(root, "acme/web/gh-1.prompt.md"), "Original task\n");
  writeFileSync(join(root, "acme/web/gh-1.handoff"), "claude\n");
  const release = await holdPass();
  const { io, cmds } = tmux([]);
  const resuming = resume(config(), io, { key: "acme/web", id: "gh-1" }, "/tender");
  await Bun.sleep(300);
  expect(cmds).toEqual([]);
  await release();
  await resuming;
  expect(cmds.some((c) => c.includes("new-window"))).toBe(true);
  expect(existsSync(join(root, "acme/web/gh-1.handoff"))).toBe(false);
});
