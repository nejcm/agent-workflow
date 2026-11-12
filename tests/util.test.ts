import { expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAw, removeAw, writeAw } from "../src/util";
import { root, useTempRoot } from "./helpers";

useTempRoot();

test("writeAw / removeAw: write, overwrite and remove a file in .aw", () => {
  mkdirSync(join(root, ".aw"));
  writeAw(root, "answer.md", "long first answer");
  writeAw(root, "answer.md", "short");
  expect(readAw(root, "answer.md", 100)).toBe("short");
  removeAw(root, "answer.md");
  expect(existsSync(join(root, ".aw", "answer.md"))).toBe(false);
  removeAw(root, "answer.md");
  removeAw(join(root, "no-aw"), "answer.md");
  symlinkSync(join(root, "elsewhere"), join(root, ".aw", ".answer.md.tmp"));
  writeAw(root, "answer.md", "again");
  expect(readAw(root, "answer.md", 100)).toBe("again");
  expect(existsSync(join(root, "elsewhere"))).toBe(false);
});

test("writeAw / removeAw refuse a symlinked .aw or target; a hard-linked target is replaced, not written through", () => {
  const out = join(root, "outside");
  mkdirSync(out);
  writeFileSync(join(out, "answer.md"), "keep");
  mkdirSync(join(root, "a"));
  symlinkSync(out, join(root, "a", ".aw"));
  expect(() => writeAw(join(root, "a"), "answer.md", "x")).toThrow();
  expect(() => removeAw(join(root, "a"), "answer.md")).toThrow();
  mkdirSync(join(root, "b", ".aw"), { recursive: true });
  symlinkSync(join(out, "answer.md"), join(root, "b", ".aw", "answer.md"));
  expect(() => writeAw(join(root, "b"), "answer.md", "x")).toThrow();
  expect(() => removeAw(join(root, "b"), "answer.md")).toThrow();
  mkdirSync(join(root, "c", ".aw"), { recursive: true });
  linkSync(join(out, "answer.md"), join(root, "c", ".aw", "answer.md"));
  writeAw(join(root, "c"), "answer.md", "x");
  expect(readFileSync(join(root, "c", ".aw", "answer.md"), "utf8")).toBe("x");
  expect(readFileSync(join(out, "answer.md"), "utf8")).toBe("keep");
  expect(existsSync(join(root, "b", ".aw", "answer.md"))).toBe(true);
});
