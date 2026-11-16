import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batchKey, batches, main, parseLint } from "../intake/lint-debt";
import { parseCollect, parseRecheck } from "../src/intake";

const SCRIPT = join(import.meta.dir, "../intake/lint-debt.ts");
let dir: string;
let state: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lint-debt-"));
  state = join(dir, "state");
  writeFileSync(state, "");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ruff = (files: string[]) => files.map((f) => `${f}:1:8: F401 [*] \`os\` imported but unused`).join("\n") + `\nFound ${files.length} errors.\n`;
const fake = (out: string, code = out ? 1 : 0, cmds: string[][] = []) => (cmd: string[]) => (cmds.push(cmd), { code, out, err: "" });
const ARGS = ["--rule", "F401", "--batch", "2", "--", "ruff", "check", "--select", "F401", "--output-format", "concise", "."];

test("parses ESLint unix, Ruff concise, ShellCheck gcc and mypy lines; ignores summaries and paths outside the repo", () => {
  const out = [
    "/repo/src/a.ts:10:5: 'x' is assigned a value but never used. [Error/no-unused-vars]",
    "/repo/src/a.ts:12:1: 'y' is assigned a value but never used. [Error/no-unused-vars]",
    "",
    "2 problems",
    "app/b.py:1:8: F401 [*] `os` imported but unused",
    "Found 1 error.",
    "scripts/c.sh:3:6: warning: Double quote to prevent globbing and word splitting. [SC2086]",
    "./pkg/d.py:12: error: Incompatible return value type (got \"int\", expected \"str\")  [return-value]",
    "Found 1 error in 1 file (checked 3 source files)",
    "/elsewhere/e.ts:1:1: outside [Error/x]",
    "../f.py:1:1: F401 outside",
    "..generated.py:2:1: F401 inside",
  ].join("\n");
  const found = parseLint(out, "/repo");
  expect([...found.keys()]).toEqual(["src/a.ts", "app/b.py", "scripts/c.sh", "pkg/d.py", "..generated.py"]);
  expect(found.get("src/a.ts")).toHaveLength(2);
});

test("collect: batches in sorted order with stable keys, kept by known batches when others are fixed", () => {
  const first = parseCollect(main(ARGS, fake(ruff(["e.py", "a.py", "c.py", "b.py", "d.py"])), state));
  expect(first.map((f) => f.key)).toEqual([batchKey("F401", ["a.py", "b.py"]), batchKey("F401", ["c.py", "d.py"]), batchKey("F401", ["e.py"])]);
  expect(first[0]!.title).toBe("Lint debt: F401 in 2 files");
  expect(first[2]!.title).toBe("Lint debt: F401 in e.py");
  expect(first[0]!.facts).toEqual({ rule: "F401", files: 2, violations: 2 });
  expect(first[0]!.body).toContain("`ruff check --select F401 --output-format concise .` reports nothing in these files");
  // a.py and b.py fixed, f.py new: c/d and e keep their keys, f gets a new batch rather than shifting c and d.
  const second = parseCollect(main(ARGS, fake(ruff(["c.py", "d.py", "e.py", "f.py"])), state));
  expect(second.map((f) => f.key)).toEqual([first[1]!.key, first[2]!.key, batchKey("F401", ["f.py"])]);
  expect(Object.keys(JSON.parse(readFileSync(state, "utf8")))).toHaveLength(4);
  expect(main(ARGS, fake(""), state)).toBe("");
});

test("batches: at most max lines; new batches past it wait", () => {
  const found = new Map(Array.from({ length: 12 }, (_, i) => [`f${String(i).padStart(2, "0")}.ts`, ["x"]]));
  expect(batches(found, {}, "r", 5, 2).map((b) => b.files.length)).toEqual([5, 5]);
});

test("recheck: gone when the batch's files are clean, still otherwise, undecidable for an unknown key", () => {
  const [b] = parseCollect(main(ARGS, fake(ruff(["a.py", "b.py", "c.py"])), state));
  const cmds: string[][] = [];
  expect(parseRecheck(main([...ARGS, "--recheck", b!.key], fake(ruff(["b.py", "c.py"]), 1, cmds), state))).toEqual({ state: "still", detail: "F401 still fails in b.py" });
  expect(cmds).toEqual([ARGS.slice(5)]);
  expect(parseRecheck(main([...ARGS, "--recheck", b!.key], fake(ruff(["c.py"])), state)).state).toBe("gone");
  expect(() => main([...ARGS, "--recheck", "lint-debt:F401:0000"], fake(""), state)).toThrow("no such batch");
});

test("a failed lint command throws: exit 2, or exit 1 with nothing parsed", () => {
  expect(() => main(ARGS, fake("", 2), state)).toThrow("ruff exited 2");
  expect(() => main(ARGS, fake("error: config not found", 1), state)).toThrow("ruff exited 1 with 0 violations parsed");
  expect(() => main(["--rule", "x"], fake(""), state)).toThrow("the lint command goes after --");
  expect(() => main(["--", "ruff"], fake(""), state)).toThrow("--rule is required");
  expect(() => main(["--rule", "x", "--batch", "0", "--", "ruff"], fake(""), state)).toThrow("--batch");
  writeFileSync(state, "[1]");
  expect(() => main(ARGS, fake(""), state)).toThrow("not a map of key to files");
});

test("--install runs a frozen bun install before the lint", () => {
  const cmds: string[][] = [];
  main(["--install", ...ARGS], fake("", 0, cmds), state);
  expect(cmds[0]).toEqual(["bun", "install", "--frozen-lockfile", "--ignore-scripts"]);
});

test("as a script: exits non-zero when the lint command fails, prints lines otherwise", () => {
  const lint = join(dir, "lint.sh");
  writeFileSync(lint, `#!/bin/sh\nprintf 'a.py:1:1: F401 x\\n'\nexit "$LINT_CODE"\n`, { mode: 0o755 });
  const run = (code: string) => Bun.spawnSync([SCRIPT, "--rule", "F401", "--", lint], { cwd: dir, env: { ...process.env, TENDER_STATE: state, LINT_CODE: code } });
  const ok = run("1");
  expect(ok.exitCode).toBe(0);
  expect(parseCollect(ok.stdout.toString())).toHaveLength(1);
  expect(run("3").exitCode).not.toBe(0);
});
