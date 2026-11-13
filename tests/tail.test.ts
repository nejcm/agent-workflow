import { expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeDir, claudeHome, codexHome } from "../src/agents";
import { argSummary, events, lastSay, newest, tail, transcript, worktreesFor } from "../src/tail";
import { clean } from "../src/util";
import { claudeFile, config, root, useTempRoot, worktree } from "./helpers";

useTempRoot();

const ts = "2026-11-12T05:43:42.667Z";
const claudeText = JSON.stringify({ type: "assistant", timestamp: ts, cwd: "/w/PER-10", message: { role: "assistant", content: [{ type: "text", text: "Failures — check whether they're pre-existing." }] } });
const claudeTool = JSON.stringify({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "bun test 2>&1 | head" } }] } });
const claudeOk = JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "secret output", is_error: false }] } });
const claudeErr = JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "Exit code 1\nboom" }], is_error: true }] } });
const claudePrompt = JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: "You are working on ticket PER-10" } });
const prLink = JSON.stringify({ type: "pr-link", sessionId: "f8f5", prNumber: 4, prUrl: "https://github.com/nejcm/agent-workflow/pull/4", prRepository: "nejcm/agent-workflow", timestamp: ts });
const cwdLine = (wt: string) => JSON.stringify({ type: "user", timestamp: ts, cwd: wt, message: { role: "user", content: "go" } });
const say = (text: string) => JSON.stringify({ type: "assistant", timestamp: ts, message: { content: [{ type: "text", text }] } });
const run = async (target: string, n = 20, follow = false, wait?: () => Promise<boolean>) => {
  const out: string[] = [];
  await tail(config(), target, n, follow, root, (s) => out.push(s), wait);
  return out;
};
const codexMeta = (cwd: string) => JSON.stringify({ type: "session_meta", timestamp: ts, payload: { id: "01a1", cwd, base_instructions: { text: "You are Codex" } } });
const codexSay = JSON.stringify({ type: "response_item", timestamp: ts, payload: { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "rc=1\nrc2=0" }] } });
const codexDev = JSON.stringify({ type: "response_item", timestamp: ts, payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex" }] } });
const codexCustom = JSON.stringify({ type: "response_item", timestamp: ts, payload: { type: "custom_tool_call", name: "exec", call_id: "call_69", status: "completed", input: 'const r = await tools.exec_command({cmd:"touch x"})' } });
const codexFn = JSON.stringify({ type: "response_item", timestamp: ts, payload: { type: "function_call", name: "exec_command", call_id: "call_1", arguments: '{"cmd":"ls -la"}' } });
const codexOut = JSON.stringify({ type: "response_item", timestamp: ts, payload: { type: "custom_tool_call_output", call_id: "call_69", output: "secret output" } });

test("claude lines: text, tool use, tool error; tool output, thinking and prompts are skipped", () => {
  expect(events(claudeText)[0]).toEndWith("say    Failures — check whether they're pre-existing.");
  expect(events(claudeTool)).toHaveLength(1);
  expect(events(claudeTool)[0]).toEndWith("Bash   bun test 2>&1 | head");
  expect(events(claudeErr)[0]).toEndWith("ERROR  Exit code 1 boom");
  for (const l of [claudeOk, claudePrompt, prLink]) expect(events(l)).toEqual([]);
});

test("codex lines: assistant text and tool calls; developer messages and outputs are skipped", () => {
  expect(events(codexSay)[0]).toEndWith("say    rc=1 rc2=0");
  expect(events(codexCustom)[0]).toContain("exec   const r = await tools.exec_command");
  expect(events(codexFn)[0]).toEndWith("exec_… ls -la");
  expect(events(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "漢字テスト", input: {} }] } }))[0]).toBe("--:--:-- 漢字…  {}");
  for (const l of [codexMeta("/w"), codexDev, codexOut]) expect(events(l)).toEqual([]);
});

test("malformed and unknown lines yield nothing", () => {
  for (const l of ["", "{", "null", "42", '"x"', "[]", '{"type":"assistant"}', '{"type":"assistant","message":{"content":"str"}}', '{"type":"response_item","payload":null}', '{"type":"assistant","message":{"content":[null,{"type":"tool_use"}]}}'])
    expect(events(l)).toEqual([]);
  expect(events(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }))[0]).toStartWith("--:--:-- say");
});

test("clean strips escapes, controls and bidi, collapses whitespace and caps length", () => {
  expect(clean("a\x1b[31mred\x1b[0m\x1b]0;title\x07b\x07\x00c\r\nd‮e\x9bf")).toBe("aredb c d e f");
  expect(clean("x".repeat(500))).toHaveLength(200);
  const blanked = { c0: "\x01\x1f\x7f", c1: "\x80\x85\x9b\x9f", bidi: "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069" };
  const deleted = { zeroWidth: "\u200b\u2060\ufeff\u00ad", annotation: "\ufff9\ufffa\ufffb", tags: "\u{e0000}\u{e0001}\u{e0041}\u{e007f}" };
  for (const [name, chars] of Object.entries(blanked)) for (const c of chars) expect([name, clean(`a${c}b`)]).toEqual([name, "a b"]);
  for (const [name, chars] of Object.entries(deleted)) for (const c of chars) expect([name, clean(`a${c}b`)]).toEqual([name, "ab"]);
  // ZWJ and ZWNJ are kept on purpose: they join emoji and shape Persian and Indic text.
  for (const ok of ["👩\u200d💻", "می\u200cروم", "क्\u200dष", "❤\ufe0f"]) expect(clean(ok)).toBe(ok);
  expect(clean("PER-1  漢字 ok")).toBe("PER-1 漢字 ok");
  expect(events(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "\x1b[2JBash", input: { command: "rm\x1b[2J -rf" } }] } }))[0]).not.toContain("\x1b");
});

test("argSummary picks the telling field or falls back to JSON", () => {
  expect(argSummary({ file_path: "/a/b.ts", old_string: "x" })).toBe("/a/b.ts");
  expect(argSummary('{"command":["bash","-lc","ls"]}')).toBe("bash -lc ls");
  expect(argSummary({ other: 1 })).toBe('{"other":1}');
  expect(argSummary("not json")).toBe("not json");
});

test("newest picks the most recent existing file", () => {
  const [a, b] = ["a.jsonl", "b.jsonl"].map((f) => join(root, f));
  writeFileSync(a!, "");
  writeFileSync(b!, "");
  utimesSync(a!, 2000, 2000);
  utimesSync(b!, 1000, 1000);
  expect(newest([b!, a!, join(root, "missing")])).toBe(a!);
  expect(newest([])).toBeUndefined();
});

test("transcript finds the newest claude file, or the codex session whose meta cwd matches", () => {
  const wt = join(root, "acme/web/PER-1");
  const cd = claudeDir(wt);
  claudeFile(wt, "old.jsonl", claudeText);
  claudeFile(wt, "new.jsonl", claudeText);
  utimesSync(join(cd, "old.jsonl"), 1000, 1000);
  expect(transcript(wt, "claude", root)).toBe(join(cd, "new.jsonl"));

  const sd = join(codexHome(wt), "sessions/2026/11/12");
  mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, "rollout-other.jsonl"), `${codexMeta("/elsewhere")}\n${codexSay}\n`);
  writeFileSync(join(sd, "rollout-mine.jsonl"), `${codexMeta(wt)}\n${codexSay}\n`);
  writeFileSync(join(sd, "rollout-bad.jsonl"), "{not json");
  utimesSync(join(sd, "rollout-mine.jsonl"), 1000, 1000);
  expect(transcript(wt, "codex", root)).toBe(join(sd, "rollout-mine.jsonl"));
  symlinkSync(root, join(sd, "loop"));
  expect(transcript(wt, "codex", root)).toBe(join(sd, "rollout-mine.jsonl"));
  expect(transcript(wt, "codex", root, 5_000_000)).toBeUndefined();
  expect(transcript(wt, undefined, root)).toBe(join(cd, "new.jsonl"));
});

test("worktreesFor rejects traversal and unsafe ids, finds the worktree on disk, else falls back to configured repos", () => {
  const cfg = config();
  for (const id of ["../x", "a/b", ".", "", "-rf", "a b", "x".repeat(65)]) expect(() => worktreesFor(cfg, id)).toThrow("invalid ticket id");
  expect(worktreesFor(cfg, "PER-1")).toEqual([{ key: "acme/web", wt: join(root, "acme/web/PER-1") }]);
  worktree("PER-2", "web", "other/repo");
  expect(worktreesFor(cfg, "PER-2")).toEqual([{ key: "other/repo", wt: join(root, "other/repo/PER-2") }]);
});

test("tail prints the last n events and never tool output", async () => {
  const wt = join(root, "acme/web/PER-3");
  const cd = claudeDir(wt);
  mkdirSync(cd, { recursive: true });
  writeFileSync(join(cd, "s.jsonl"), [cwdLine(wt), claudePrompt, claudeText, claudeTool, claudeOk, "garbage", claudeErr, `${claudeText.slice(0, 20)}`].join("\n"));
  const out: string[] = [];
  await tail(config(), "PER-3", 2, false, root, (s) => out.push(s));
  expect(out).toHaveLength(3);
  expect(out[0]).toBe(`# ${join(cd, "s.jsonl")}`);
  expect(out[1]).toContain("Bash");
  expect(out[2]).toContain("ERROR");
  expect(out.join("\n")).not.toContain("secret output");
  await expect(tail(config(), "PER-404", 2, false, root, () => {})).rejects.toThrow("no transcript found");
});

test("tail header is sanitized: an OSC 52 file name never reaches the terminal", async () => {
  claudeFile(join(root, "acme/web/PER-6"), "\x1b]52;c;ZXZpbA==\x07x.jsonl", claudeText);
  const [header] = await run("PER-6");
  expect(header).toStartWith("# ");
  expect(header).not.toMatch(/[\x00-\x1f]/);
});

test("transcript skips symlinks and FIFOs and never blocks on them", () => {
  const wt = join(root, "acme/web/PER-7");
  const real = claudeFile(wt, "real.jsonl", claudeText);
  utimesSync(real, 1000, 1000);
  const outside = join(root, "outside.jsonl");
  writeFileSync(outside, `${cwdLine(wt)}\n`);
  symlinkSync(outside, join(claudeDir(wt), "link.jsonl"));
  expect(Bun.spawnSync(["mkfifo", join(claudeDir(wt), "fifo.jsonl")]).exitCode).toBe(0);
  expect(transcript(wt, "claude", root)).toBe(real);
});

test("an ID in several repos is refused; owner/repo/ID picks one; each segment is validated", async () => {
  for (const repo of ["acme/web", "other/repo"]) {
    worktree("PER-8", "web", repo);
    claudeFile(join(root, repo, "PER-8"), "s.jsonl", say(repo));
  }
  await expect(run("PER-8")).rejects.toThrow("PER-8 is in several repos (acme/web, other/repo); use aw tail <owner/repo>/PER-8");
  expect((await run("other/repo/PER-8")).at(-1)).toEndWith("say    other/repo");
  for (const t of ["../x/PER-8", "acme/web/../PER-8", "a/b/c/PER-8", "-x/y/PER-8", "acme/web/../../x"]) await expect(run(t)).rejects.toThrow(/invalid (repo|ticket id)/);
});

test("claude dir collisions (a-b vs a.b) are told apart by the recorded cwd; since applies to claude too", () => {
  const [ab, adot] = [join(root, "acme/a-b/PER-9"), join(root, "acme/a.b/PER-9")];
  const f = claudeFile(adot, "s.jsonl", claudeText);
  expect(transcript(ab, "claude", root)).toBeUndefined();
  expect(transcript(adot, "claude", root)).toBe(f);
  utimesSync(f, 1000, 1000);
  expect(transcript(adot, "claude", root, 5_000_000)).toBeUndefined();
});

test("follow prints appends and survives replacement, truncation and a vanished file", async () => {
  const wt = join(root, "acme/web/PER-11");
  const f = claudeFile(wt, "s.jsonl", say("zero"));
  const steps = [
    () => appendFileSync(f, `${say("one")}\n${say("half").slice(0, 10)}`),
    () => (writeFileSync(`${f}.new`, `${cwdLine(wt)}\n${say("two")}\n`), renameSync(`${f}.new`, f)),
    () => writeFileSync(f, `${say("3")}\n`),
    () => rmSync(f),
    () => writeFileSync(f, `${say("4")}\n`),
  ];
  const wait = async () => {
    const step = steps.shift();
    step?.();
    return !!step;
  };
  const out = await run("PER-11", 20, true, wait);
  expect(out.slice(1).map((l) => l.slice(16))).toEqual(["zero", "one", "two", "3", "4"]);
});

test("follow switches to a newer transcript (restart, /clear) and announces it", async () => {
  const wt = join(root, "acme/web/PER-13");
  const old = claudeFile(wt, "a.jsonl", say("first"));
  utimesSync(old, 1000, 1000);
  let fresh = "";
  const steps = [() => (fresh = claudeFile(wt, "b.jsonl", say("second"))), () => appendFileSync(fresh, `${say("third")}\n`)];
  const wait = async () => {
    const step = steps.shift();
    step?.();
    return !!step;
  };
  const out = await run("PER-13", 20, true, wait);
  expect(out.map((l) => (l.startsWith("#") ? l : l.slice(16)))).toEqual([`# ${old}`, "first", `# ${fresh}`, "second", "third"]);
});

test("follow never goes back to an older transcript when the newer one turns unreadable or vanishes", async () => {
  const wt = join(root, "acme/web/PER-14");
  const old = claudeFile(wt, "a.jsonl", say("first"));
  utimesSync(old, 1000, 1000);
  let fresh = "";
  const steps = [
    () => (fresh = claudeFile(wt, "b.jsonl", say("second"))),
    () => chmodSync(fresh, 0),
    () => (chmodSync(fresh, 0o644), appendFileSync(fresh, `${say("third")}\n`)),
    () => rmSync(fresh),
  ];
  const wait = async () => {
    const step = steps.shift();
    step?.();
    return !!step;
  };
  const out = await run("PER-14", 20, true, wait);
  expect(out.map((l) => (l.startsWith("#") ? l : l.slice(16)))).toEqual([`# ${old}`, "first", `# ${fresh}`, "second", "third"]);
});

test("the initial view reads only the trailing chunk and drops its partial first line", async () => {
  const wt = join(root, "acme/web/PER-12");
  claudeFile(wt, "s.jsonl", say("too old"), say("x".repeat(300 * 1024)), say("recent"));
  const out = await run("PER-12");
  expect(out.slice(1).map((l) => l.slice(16))).toEqual(["recent"]);
});

test("hostile JSON shapes never crash formatting", () => {
  expect(argSummary({ command: [{ toString: null }, "ls", 1, null, ["x"]] })).toBe("ls 1");
  expect(argSummary(JSON.parse('{"command":[{"toString":null}]}'))).toBe("");
  const deep = `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"x","input":{"a":${"[".repeat(20000)}${"]".repeat(20000)}}}]}}`;
  expect(() => events(deep)).not.toThrow();
  expect(events(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: [{ toString: null }] } }] } }))).toHaveLength(1);
});

test("lastSay: the last non-empty claude assistant text, an unterminated final record included; undefined when missing", () => {
  const wt = join(root, "acme/web/PER-2");
  expect(lastSay(wt, "claude")).toBeUndefined();
  claudeFile(wt, "a.jsonl", say("first"), say("why I stopped"), claudeTool, claudeOk, claudePrompt, "{bad");
  expect(lastSay(wt, "claude")).toBe("why I stopped");
  appendFileSync(join(claudeDir(wt), "a.jsonl"), say("unterminated"));
  expect(lastSay(wt, "claude")).toBe("unterminated");
  appendFileSync(join(claudeDir(wt), "a.jsonl"), "\n" + say("  indented\n    more"));
  expect(lastSay(wt, "claude")).toBe("  indented\n    more");
  claudeFile(wt, "b.jsonl", claudeTool);
  expect(lastSay(wt, "claude")).toBeUndefined();
});

test("lastSay refuses a transcript that resolves outside the ticket's own config dir", () => {
  const wt = join(root, "acme/web/PER-3");
  const other = join(root, "acme/web/PER-4.claude");
  claudeFile(wt, "a.jsonl", say("not mine"));
  mkdirSync(other, { recursive: true });
  renameSync(join(claudeHome(wt), "projects"), join(other, "projects"));
  symlinkSync(join(other, "projects"), join(claudeHome(wt), "projects"));
  expect(transcript(wt, "claude", root)).toBeDefined();
  expect(lastSay(wt, "claude")).toBeUndefined();
});

test("lastSay reads codex assistant text from the ticket's own CODEX_HOME only", () => {
  const wt = join(root, "acme/web/PER-5");
  const sd = join(codexHome(wt), "sessions/2026/11/12");
  mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, "r.jsonl"), `${codexMeta(wt)}\n${codexSay}\n${codexFn}\n`);
  expect(lastSay(wt, "codex")).toBe("rc=1\nrc2=0");
  writeFileSync(join(sd, "r.jsonl"), `${codexMeta("/elsewhere")}\n${codexSay}\n`);
  expect(lastSay(wt, "codex")).toBeUndefined();
  const other = join(root, "acme/web/PER-6.codex");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(sd, "r.jsonl"), `${codexMeta(wt)}\n${codexSay}\n`);
  renameSync(join(codexHome(wt), "sessions"), join(other, "sessions"));
  symlinkSync(join(other, "sessions"), join(codexHome(wt), "sessions"));
  expect(lastSay(wt, "codex")).toBeUndefined();
});
