import { readdirSync, writeFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { holdLock, parseArgs, spawnRun } from "../aw";
import { raw, root, useTempRoot } from "./helpers";

useTempRoot();

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

test("spawnRun kills the whole process group at the deadline and keeps output", async () => {
  const mark = `${10_000 + (process.pid % 10_000)}.25`;
  const t0 = performance.now();
  const r = await spawnRun(["sh", "-c", `sleep ${mark} & echo partial; sleep ${mark}`], undefined, 1);
  expect(performance.now() - t0).toBeLessThan(4000);
  expect(r).toMatchObject({ code: 124, out: "partial\n", err: `sh -c sleep ${mark} & echo partial; sleep ${mark} timed out after 1s` });
  expect(Bun.spawnSync(["pgrep", "-f", `sleep ${mark}`]).exitCode).toBe(1);
});

test("spawnRun leaves normal commands unchanged", async () => {
  expect(await spawnRun(["sh", "-c", "echo out; echo err >&2; exit 3"])).toEqual({ code: 3, out: "out\n", err: "err\n" });
});

test("spawnRun returns at the deadline even when a TERM-ignoring grandchild holds the pipes", async () => {
  const mark = `${10_000 + (process.pid % 10_000)}.75`;
  const t0 = performance.now();
  try {
    const r = await spawnRun(["sh", "-c", `(trap '' TERM; sleep ${mark}) & echo partial; sleep ${mark}`], undefined, 1);
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(r).toMatchObject({ code: 124, err: `sh -c (trap '' TERM; sleep ${mark}) & echo partial; sleep ${mark} timed out after 1s` });
  } finally {
    Bun.spawnSync(["pkill", "-9", "-fx", `sleep ${mark}`]);
  }
}, 15_000);

const fds = () => readdirSync("/proc/self/fd").length;

test("spawnRun gives up on output a finished command left open, and releases its pipes", async () => {
  for (const [mark, prefix] of [[`${10_000 + (process.pid % 10_000)}.5`, ""], [`${10_000 + (process.pid % 10_000)}.6`, "setsid "]]) {
    const before = fds();
    const t0 = performance.now();
    try {
      const r = await spawnRun(["sh", "-c", `${prefix}sleep ${mark} & echo partial; exit 0`]);
      expect(performance.now() - t0).toBeLessThan(7000);
      expect(r).toMatchObject({ code: 1, err: `sh -c ${prefix}sleep ${mark} & echo partial; exit 0 exited 0 but left its output open` });
      expect(Bun.spawnSync(["pgrep", "-fx", `sleep ${mark}`]).exitCode).toBe(0);
      expect(fds()).toBe(before);
    } finally {
      Bun.spawnSync(["pkill", "-fx", `sleep ${mark}`]);
    }
  }
}, 20_000);

test("a second run or once on the same workspace is refused; the lock dies with its holder, SIGKILL included", async () => {
  const cfg = join(root, "aw.json");
  writeFileSync(cfg, JSON.stringify(raw()));
  const aw = resolve(import.meta.dir, "../aw.ts");
  const holder = Bun.spawn(["bun", "-e", `import { holdLock } from ${JSON.stringify(aw)}; console.log(holdLock(${JSON.stringify(join(root, ".lock"))})); await Bun.sleep(60_000);`], { stdout: "pipe" });
  try {
    expect((await holder.stdout.getReader().read()).value).toEqual(new TextEncoder().encode("true\n"));
    const second = Bun.spawnSync(["bun", aw, "once", "--config", cfg]);
    expect(second.exitCode).toBe(1);
    expect(second.stderr.toString()).toBe(`another aw run or once holds ${join(root, ".lock")}; stop it first\n`);
  } finally {
    holder.kill("SIGKILL");
    await holder.exited;
  }
  expect(holdLock(join(root, ".lock"))).toBe(true);
}, 15_000);
