#!/usr/bin/env bun
import { mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hostLogin } from "./src/claude-auth";
import { parseConfig } from "./src/config";
import { dashboard, watch } from "./src/dash";
import { events } from "./src/db";
import { handoff, shellLine, ticketClone, type Tool, TOOLS } from "./src/handoff";
import { cloneAll, resume } from "./src/launcher";
import { CRITICAL_PATHS, TEST_PATHS } from "./src/merge";
import { makeTracker, pass } from "./src/pass";
import { dirEntries, parseRepoConfig } from "./src/repo-config";
import { reviewLimit, snapshot, table } from "./src/status";
import { tail } from "./src/tail";
import type { Config, Io, RepoConfig, Run } from "./src/types";
import { passLocked, TENDER_DIR } from "./src/util";

async function status(cfg: Config, io: Io) {
  const full = reviewLimit(cfg);
  return [
    `max ${cfg.maxConcurrent} sessions${cfg.maxInReview === undefined ? "" : `, ${cfg.maxInReview} in review`}`,
    ...(full ? [full] : []),
    ...cfg.sources.map((s) => `source ${s.name}  ${makeTracker(s, cfg.host, io, cfg.defaultHost, Object.keys(cfg.repos)).describe()}`),
    ...Object.values(cfg.repos).map((r) => `${r.key}  ${r.sandbox}  max ${r.maxConcurrent ?? "-"}${r.maxInReview === undefined ? "" : `  review max ${r.maxInReview}`}  merge up to ${r.autoMerge}  ${r.path}`),
    "",
    table(await snapshot(cfg, io)),
  ].join("\n");
}

// timeout signals its whole group and still fires if tender is killed. The drain bound covers what outlives it holding the pipes;
// shortcut: a grandchild ignoring TERM keeps running (signalling after the reap could hit a reused group id).
export const spawnRun: Run = async (argv, cwd, secs = 60) => {
  const start = performance.now();
  const cmd = argv.slice(0, 3).join(" ");
  const p = Bun.spawn(["timeout", "-k", "5", String(secs), ...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const readers = [p.stdout.getReader(), p.stderr.getReader()];
  const text = async (r: ReadableStreamDefaultReader<Uint8Array>) => {
    const d = new TextDecoder();
    let s = "";
    for (let c = await r.read(); !c.done; c = await r.read()) s += d.decode(c.value, { stream: true });
    return s + d.decode();
  };
  const output = Promise.all(readers.map(text));
  const code = await p.exited;
  const timedOut = (code === 124 || code === 137) && performance.now() - start >= secs * 1000;
  let timer: number | undefined;
  const drained = await Promise.race([output, new Promise<undefined>((r) => (timer = setTimeout(r, 5000)))]).finally(() => clearTimeout(timer));
  if (!drained) {
    for (const r of readers) r.cancel().catch(() => {});
    return { code: code || 1, out: "", err: timedOut ? `${cmd} timed out after ${secs}s` : `${cmd} exited ${code} but left its output open` };
  }
  const [out, err] = drained;
  return { code, out, err: timedOut ? `${cmd} timed out after ${secs}s ${err.trim()}`.trim() : err };
};

/** Takes a kernel flock on `file` for the process lifetime; false if another process holds it. Released on any exit, SIGKILL included. */
export function holdLock(file: string) {
  mkdirSync(dirname(file), { recursive: true });
  // flock locks the open file description, which this process keeps open (close-on-exec) after the child exits.
  return Bun.spawnSync(["flock", "-n", "3"], { stdio: ["ignore", "ignore", "ignore", openSync(file, "a")] }).exitCode === 0;
}

const USAGE = `usage: bun tender.ts <command> [--config tender.json]
  run | once [--dry-run]
  status [--json]
  watch [--interval 2] [--plain]
  tail <ID | owner/repo/ID> [-n 20] [--no-follow]
  open <ID | owner/repo/ID> [--tool claude|codex|t3|editor] [--exec]
  resume <ID | owner/repo/ID>
  check [path]`;
const VALUED = ["--config", "--interval", "-n", "--tool"];
const FLAGS = [...VALUED, "--dry-run", "--json", "--no-follow", "--plain", "--exec"];
const TARGETED = ["tail", "open", "resume"];

/** Validates `<dir>/.tender/` from the working tree and prints the repo's settings with defaults filled in; false if invalid. */
export function check(dir: string, print = console.log, fail = console.error) {
  let c: RepoConfig;
  try {
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${dir}: not a directory`);
    c = parseRepoConfig(dirEntries(dir));
  } catch (e) {
    fail(`${join(dir, ".tender")}: invalid:\n  ${(e as Error).message}`);
    return false;
  }
  const { files, ...rest } = c;
  const prompt = (f?: string) => (f ? `.tender/prompts/${f}` : undefined);
  const prompts = { default: prompt(c.prompts.default ?? (Object.hasOwn(files, "default.md") ? "default.md" : undefined)) ?? "tender's prompts/default.md", byLabel: Object.fromEntries(Object.entries(c.prompts.byLabel).map(([l, f]) => [l, prompt(f)])) };
  print(JSON.stringify({ ...rest, testCmd: c.testCmd ?? null, tracker: c.tracker ?? null, autoMerge: c.autoMerge ? `${c.autoMerge} (capped by the host's autoMerge)` : "unset (the host's autoMerge)", criticalPaths: [...CRITICAL_PATHS, ...c.criticalPaths], testPaths: [...TEST_PATHS, ...c.testPaths], prompts }, null, 2));
  return true;
}

/** Command, ticket target and option values, or undefined for unknown flags, stray args or out-of-range numbers. */
export function parseArgs(argv: string[]) {
  const isValue = (i: number) => VALUED.includes(argv[i - 1] ?? "");
  const opt = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? "" : undefined);
  const [cmd, id, ...extra] = argv.filter((a, i) => !a.startsWith("-") && !isValue(i));
  const interval = Number(opt("--interval") ?? 2);
  const n = Number(opt("-n") ?? 20);
  const tool = opt("--tool");
  const ok =
    argv.every((a, i) => !a.startsWith("-") || isValue(i) || FLAGS.includes(a)) &&
    ["run", "once", "status", "watch", "check", ...TARGETED].includes(cmd ?? "") &&
    !extra.length &&
    (cmd === "check" || TARGETED.includes(cmd!) === (id !== undefined)) &&
    (tool === undefined || (cmd === "open" && TOOLS.includes(tool as Tool))) &&
    !(argv.includes("--dry-run") && ["open", "resume"].includes(cmd!)) &&
    Number.isFinite(interval) &&
    interval >= 1 &&
    Number.isInteger(n) &&
    n >= 1 &&
    n <= 10_000 &&
    opt("--config") !== "";
  return ok ? { cmd: cmd!, id, interval, n, tool: tool as Tool | undefined, path: resolve(opt("--config") ?? "tender.json") } : undefined;
}

async function main(argv: string[]) {
  const args = parseArgs(argv);
  if (!args) {
    console.error(USAGE);
    process.exit(2);
  }
  const { cmd, id, interval, n, tool, path } = args;
  if (cmd === "check") process.exit(check(resolve(id ?? ".")) ? 0 : 1);
  let cfg: Config;
  try {
    cfg = parseConfig(JSON.parse(readFileSync(path, "utf8")), dirname(path));
  } catch (e) {
    console.error(`${path}: ${(e as Error).message}`);
    process.exit(1);
  }
  const dry = argv.includes("--dry-run");
  const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
  const io: Io = { run: spawnRun, fetch, dry, log, home: homedir(), event: events(cfg, dry, log) };
  if (cmd === "status") return console.log(argv.includes("--json") ? JSON.stringify(await snapshot(cfg, io), null, 2) : await status(cfg, io));
  if (cmd === "watch")
    return watch({
      plain: argv.includes("--plain"),
      tty: !!process.stdout.isTTY && !!process.stdin.isTTY,
      dash: () => dashboard(cfg, io, interval),
      fallback: async () => {
        for (;;) {
          process.stdout.write(`\x1b[H\x1b[2J${new Date().toLocaleTimeString()}  every ${interval}s, Ctrl-C to stop\n\n${await status(cfg, io)}\n`);
          await Bun.sleep(interval * 1000);
        }
      },
    });
  if (cmd === "tail")
    return tail(cfg, id!, n, !argv.includes("--no-follow")).catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
  if (cmd === "open") {
    const env = process.env;
    const stores = { claude: env.CLAUDE_CONFIG_DIR || join(io.home, ".claude"), codex: env.CODEX_HOME || join(io.home, ".codex") };
    const err = (m: string) => console.error(m);
    const h = await handoff(cfg, { ...io, log: err, event: events(cfg, dry, err) }, id!, tool, stores, env.VISUAL || env.EDITOR).catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
    console.error(`${h.key}/${h.id} is handed off; \`tender resume ${h.key}/${h.id}\` gives it back`);
    if (!h.argv.length) return console.log(h.wt);
    if (!argv.includes("--exec")) return console.log(shellLine(h.wt, h.argv));
    const { LINEAR_API_KEY: _, ...rest } = env;
    process.exit(await Bun.spawn(h.argv, { cwd: h.wt, env: rest, stdio: ["inherit", "inherit", "inherit"] }).exited);
  }
  if (cmd === "resume")
    return (async () => resume(cfg, io, ticketClone(cfg, id!), TENDER_DIR))().catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
  // Dry runs change nothing, so the preflight in scripts/run.sh still works while the service runs.
  const lock = join(cfg.workspaceRoot, ".lock");
  if (!io.dry && !holdLock(lock)) {
    console.error(`another tender run or once holds ${lock}; stop it first`);
    process.exit(1);
  }
  const refresh = Object.values(cfg.repos).some((r) => r.sandbox === "nono")
    ? await hostLogin(io, [cfg.workspaceRoot]).catch((e) => {
        console.error(`claude login: ${e.message}`);
        process.exit(1);
      })
    : undefined;
  await cloneAll(cfg, io);
  const poll = () => (io.dry ? pass(cfg, io) : passLocked(cfg, io.log, () => pass(cfg, io)));
  if (cmd === "once") return poll();
  // Its own timer: a pass can block for minutes, longer than Claude's 5-minute refresh window.
  if (refresh) setInterval(refresh, 60_000);
  for (;;) {
    await poll();
    await Bun.sleep(cfg.pollIntervalMs);
  }
}

if (import.meta.main) await main(Bun.argv.slice(2));
