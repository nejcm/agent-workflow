import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseArgs } from "../aw";

test("parseArgs accepts known commands and flags", () => {
  expect(parseArgs(["status", "--json"])).toMatchObject({ cmd: "status", interval: 2, n: 20, path: resolve("aw.json") });
  expect(parseArgs(["watch", "--interval", "2", "--config", "x.json"])).toMatchObject({ cmd: "watch", interval: 2, path: resolve("x.json") });
  expect(parseArgs(["watch", "--plain"])).toMatchObject({ cmd: "watch", interval: 2 });
  expect(parseArgs(["watch", "--plain", "--interval", "7"])).toMatchObject({ cmd: "watch", interval: 7 });
  expect(parseArgs(["tail", "acme/web/PER-1", "-n", "5", "--no-follow"])).toMatchObject({ cmd: "tail", id: "acme/web/PER-1", n: 5 });
  expect(parseArgs(["once", "--dry-run"])).toMatchObject({ cmd: "once" });
});

test("parseArgs rejects unknown flags, stray args and out-of-range numbers", () => {
  for (const argv of [
    [],
    ["nope"],
    ["status", "--jsno"],
    ["run", "-x"],
    ["status", "PER-1"],
    ["tail"],
    ["tail", "PER-1", "PER-2"],
    ["watch", "--interval", "0"],
    ["watch", "--interval", "0.5"],
    ["watch", "--interval", "Infinity"],
    ["watch", "--interval", "NaN"],
    ["watch", "--interval"],
    ["watch", "--plan"],
    ["watch", "--plain=1"],
    ["watch", "plain"],
    ["tail", "PER-1", "-n", "0"],
    ["tail", "PER-1", "-n", "1.5"],
    ["tail", "PER-1", "-n", "100000"],
    ["tail", "PER-1", "-n", "-3"],
    ["status", "--config"],
  ])
    expect(parseArgs(argv)).toBeUndefined();
});
