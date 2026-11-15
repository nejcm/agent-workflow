import { expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRun, removeRun, writeRun } from "../src/util";
import { root, useTempRoot } from "./helpers";

useTempRoot();

test("writeRun / removeRun: write, overwrite and remove a file in .tender/run", () => {
  mkdirSync(join(root, ".tender/run"), { recursive: true });
  writeRun(root, "answer.md", "long first answer");
  writeRun(root, "answer.md", "short");
  expect(readRun(root, "answer.md", 100)).toBe("short");
  removeRun(root, "answer.md");
  expect(existsSync(join(root, ".tender/run", "answer.md"))).toBe(false);
  removeRun(root, "answer.md");
  removeRun(join(root, "no-tender"), "answer.md");
  symlinkSync(join(root, "elsewhere"), join(root, ".tender/run", ".answer.md.tmp"));
  writeRun(root, "answer.md", "again");
  expect(readRun(root, "answer.md", 100)).toBe("again");
  expect(existsSync(join(root, "elsewhere"))).toBe(false);
});

test("writeRun / removeRun refuse a symlinked .tender, .tender/run or target; a hard-linked target is replaced, not written through", () => {
  const out = join(root, "outside");
  mkdirSync(out);
  writeFileSync(join(out, "answer.md"), "keep");
  mkdirSync(join(root, "a", ".tender"), { recursive: true });
  symlinkSync(out, join(root, "a", ".tender/run"));
  expect(() => writeRun(join(root, "a"), "answer.md", "x")).toThrow();
  expect(() => removeRun(join(root, "a"), "answer.md")).toThrow();
  mkdirSync(join(root, "p/run"), { recursive: true });
  writeFileSync(join(root, "p/run/answer.md"), "keep");
  mkdirSync(join(root, "d"));
  symlinkSync(join(root, "p"), join(root, "d", ".tender"));
  expect(() => writeRun(join(root, "d"), "answer.md", "x")).toThrow();
  expect(() => removeRun(join(root, "d"), "answer.md")).toThrow();
  expect(() => readRun(join(root, "d"), "answer.md", 100)).toThrow();
  expect(readFileSync(join(root, "p/run/answer.md"), "utf8")).toBe("keep");
  mkdirSync(join(root, "b", ".tender/run"), { recursive: true });
  symlinkSync(join(out, "answer.md"), join(root, "b", ".tender/run", "answer.md"));
  expect(() => writeRun(join(root, "b"), "answer.md", "x")).toThrow();
  expect(() => removeRun(join(root, "b"), "answer.md")).toThrow();
  mkdirSync(join(root, "c", ".tender/run"), { recursive: true });
  linkSync(join(out, "answer.md"), join(root, "c", ".tender/run", "answer.md"));
  writeRun(join(root, "c"), "answer.md", "x");
  expect(readFileSync(join(root, "c", ".tender/run", "answer.md"), "utf8")).toBe("x");
  expect(readFileSync(join(out, "answer.md"), "utf8")).toBe("keep");
  expect(existsSync(join(root, "b", ".tender/run", "answer.md"))).toBe(true);
});
