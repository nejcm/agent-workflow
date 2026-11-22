import { readdirSync, writeFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { holdLock, parseArgs, spawnRun } from "../tender";
import { raw, root, useTempRoot } from "./helpers";

useTempRoot();

test("parseArgs accepts known commands and flags", () => {
  expect(parseArgs(["status", "--json"])).toMatchObject({ cmd: "status", interval: 2, n: 20, path: resolve("tender.json") });
  expect(parseArgs(["watch", "--interval", "2", "--config", "x.json"])).toMatchObject({ cmd: "watch", interval: 2, path: resolve("x.json") });
  expect(parseArgs(["watch", "--plain"])).toMatchObject({ cmd: "watch", interval: 2 });
  expect(parseArgs(["watch", "--plain", "--interval", "7"])).toMatchObject({ cmd: "watch", interval: 7 });
  expect(parseArgs(["tail", "acme/web/PER-1", "-n", "5", "--no-follow"])).toMatchObject({ cmd: "tail", id: "acme/web/PER-1", n: 5 });
  expect(parseArgs(["once", "--dry-run"])).toMatchObject({ cmd: "once" });
  expect(parseArgs(["open", "PER-1"])).toMatchObject({ cmd: "open", id: "PER-1", tool: undefined });
  expect(parseArgs(["open", "acme/web/PER-1", "--tool", "editor", "--exec"])).toMatchObject({ cmd: "open", id: "acme/web/PER-1", tool: "editor" });
  expect(parseArgs(["resume", "PER-1"])).toMatchObject({ cmd: "resume", id: "PER-1" });
  expect(parseArgs(["intake"])).toMatchObject({ cmd: "intake", id: undefined });
  expect(parseArgs(["intake", "acme/web:errs", "--dry-run"])).toMatchObject({ cmd: "intake", id: "acme/web:errs" });
  expect(parseArgs(["prs", "--dry-run"])).toMatchObject({ cmd: "prs", id: undefined });
  expect(parseArgs(["stats", "--json"])).toMatchObject({ cmd: "stats", days: 90 });
  expect(parseArgs(["stats", "--days", "30"])).toMatchObject({ cmd: "stats", days: 30 });
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
    ["open"],
    ["resume"],
    ["verify", "acme/web"],
    ["open", "PER-1", "--tool", "vim"],
    ["open", "PER-1", "--tool"],
    ["resume", "PER-1", "--tool", "claude"],
    ["open", "PER-1", "--dry-run"],
    ["open", "PER-1", "--dry-run", "--exec"],
    ["resume", "PER-1", "--dry-run"],
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
    ["stats", "--days", "0"],
    ["stats", "--days", "1.5"],
    ["stats", "--days"],
    ["stats", "--dry-run"],
    ["stats", "acme/web"],
    ["prs", "--days", "7"],
    ["intake", "a", "b"],
    ["prs", "acme/web"],
    ["watch", "--json"],
    ["status", "-n", "5"],
    ["status", "--interval", "5"],
    ["status", "--plain"],
    ["tail", "PER-1", "--exec"],
    ["run", "--no-follow"],
  ])
    expect(parseArgs(argv)).toHaveProperty("error");
});

test("parseArgs says why the arguments are invalid", () => {
  expect(parseArgs(["status", "--bogus"])).toEqual({ error: "unknown flag --bogus" });
  expect(parseArgs(["tail"])).toEqual({ error: "tail needs an <ID>" });
  expect(parseArgs(["stats", "--days", "0"])).toEqual({ error: "--days must be an integer from 1 to 3650" });
  expect(parseArgs(["watch", "--json"])).toEqual({ error: "watch does not take --json" });
  expect(parseArgs(["status", "PER-1"])).toEqual({ error: "unexpected argument PER-1" });
  expect(parseArgs(["nope"])).toEqual({ error: "unknown command nope" });
  expect(parseArgs(["open", "PER-1", "--tool"])).toEqual({ error: "--tool needs a value" });
});

test("help prints usage to stdout and exits 0; bad arguments print a reason and exit 2", () => {
  const tender = resolve(import.meta.dir, "../tender.ts");
  for (const argv of [["--help"], ["-h"], ["help"], ["status", "--help"]]) {
    const r = Bun.spawnSync(["bun", tender, ...argv]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toStartWith("usage: bun tender.ts");
  }
  const bad = Bun.spawnSync(["bun", tender, "status", "--bogus"]);
  expect(bad.exitCode).toBe(2);
  expect(bad.stderr.toString()).toStartWith("unknown flag --bogus\nusage: bun tender.ts");
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
    // A Blob stdin from an earlier test file holds an fd until GC, which would shift the count.
    Bun.gc(true);
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
  const cfg = join(root, "tender.json");
  writeFileSync(cfg, JSON.stringify(raw()));
  const tender = resolve(import.meta.dir, "../tender.ts");
  const holder = Bun.spawn(["bun", "-e", `import { holdLock } from ${JSON.stringify(tender)}; console.log(holdLock(${JSON.stringify(join(root, ".lock"))})); await Bun.sleep(60_000);`], { stdout: "pipe" });
  try {
    expect((await holder.stdout.getReader().read()).value).toEqual(new TextEncoder().encode("true\n"));
    const second = Bun.spawnSync(["bun", tender, "once", "--config", cfg]);
    expect(second.exitCode).toBe(1);
    expect(second.stderr.toString()).toBe(`another tender run or once holds ${join(root, ".lock")}; stop it first\n`);
  } finally {
    holder.kill("SIGKILL");
    await holder.exited;
  }
  expect(holdLock(join(root, ".lock"))).toBe(true);
}, 15_000);

test("spawnRun drops repository-local GIT_* variables", () => {
  const script = `import { spawnRun } from "./tender"; console.log((await spawnRun(["sh", "-c", "echo \${GIT_DIR:-unset} \${GIT_INDEX_FILE:-unset} \${HOME:+home} \${GIT_CONFIG_COUNT:-unset}"])).out.trim());`;
  const r = Bun.spawnSync(["bun", "-e", script], { cwd: join(import.meta.dir, ".."), env: { ...process.env, GIT_DIR: "/x", GIT_INDEX_FILE: "/y", GIT_CONFIG_COUNT: "1" }, stdout: "pipe" });
  expect(r.stdout.toString().trim()).toBe("unset unset home 1");
});
