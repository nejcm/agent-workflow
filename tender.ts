#!/usr/bin/env bun
import { mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hostLogin } from "./src/session/claude-auth";
import { parseConfig } from "./src/config/config";
import { dashboard, watch } from "./src/ui/dash";
import { events } from "./src/db";
import { handoff, shellLine, ticketClone, type Tool, TOOLS } from "./src/session/handoff";
import { intake } from "./src/intake";
import { prs } from "./src/prs";
import { DEFAULT_DAYS, stats, statsTable } from "./src/stats";
import { cloned, cloneAll, resume } from "./src/session/launcher";
import { CRITICAL_PATHS, TEST_PATHS } from "./src/review/merge";
import { makeTracker, pass } from "./src/pass";
import { dirEntries, parseRepoConfig, STEPS } from "./src/config/repo-config";
import { reviewLimit, snapshot, table } from "./src/ui/status";
import { tail } from "./src/ui/tail";
import type { Config, Io, PromptText, RepoConfig, Run } from "./src/types";
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

// `git rev-parse --local-env-vars`: inherited, they would point every git call at another repository.
const LOCAL_GIT = new Set(["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR"]);

// timeout signals its whole group and still fires if tender is killed. The drain bound covers what outlives it holding the pipes;
// shortcut: a grandchild ignoring TERM keeps running (signalling after the reap could hit a reused group id).
export const spawnRun: Run = async (argv, cwd, secs = 60, { env, max = Infinity } = {}) => {
  const start = performance.now();
  const cmd = argv.slice(0, 3).join(" ");
  const clean = Object.fromEntries(Object.entries(env ?? process.env).filter(([k]) => !LOCAL_GIT.has(k)));
  const p = Bun.spawn(["timeout", "-k", "5", String(secs), ...argv], { cwd, env: clean, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const readers = [p.stdout.getReader(), p.stderr.getReader()];
  let over = false;
  const text = async (r: ReadableStreamDefaultReader<Uint8Array>) => {
    const d = new TextDecoder();
    let s = "";
    let bytes = 0;
    for (let c = await r.read(); !c.done; c = await r.read()) {
      bytes += c.value.length;
      if (bytes > max) {
        over = true;
        p.kill();
        r.cancel().catch(() => {});
        return "";
      }
      s += d.decode(c.value, { stream: true });
    }
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
  if (over) return { code: code || 1, out: "", err: `${cmd} printed over ${max} bytes` };
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
  intake [owner/repo:rule | rule] [--dry-run]
  prs [--dry-run]
  stats [--days 90] [--json]
  check [path]`;
const VALUED = ["--config", "--interval", "-n", "--tool", "--days"];
const CMD_FLAGS: Record<string, string[]> = {
  run: ["--dry-run"],
  once: ["--dry-run"],
  status: ["--json"],
  watch: ["--interval", "--plain"],
  tail: ["-n", "--no-follow"],
  open: ["--tool", "--exec"],
  resume: [],
  intake: ["--dry-run"],
  prs: ["--dry-run"],
  stats: ["--days", "--json"],
  check: [],
};
const FLAGS = ["--config", ...Object.values(CMD_FLAGS).flat()];
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
  const { files, prompt, byLabel, ...rest } = c;
  const from = (t?: PromptText) => (t === undefined ? undefined : typeof t !== "string" ? `.tender/prompts/${t.file}` : t.trim() ? "inline" : "disabled");
  const steps = { steps: Object.fromEntries(STEPS.map((n) => [n, from(prompt.steps[n]) ?? "tender's"])), append: from(prompt.append) ?? null };
  const labels = Object.fromEntries(Object.entries(byLabel).map(([l, e]) => [l, { prompt: e.prompt && { steps: Object.fromEntries(Object.entries(e.prompt.steps).map(([n, t]) => [n, from(t)])), append: from(e.prompt.append) }, agent: e.agent }]));
  print(JSON.stringify({ ...rest, testCmd: c.testCmd ?? null, tracker: c.tracker ?? null, autoMerge: c.autoMerge ? `${c.autoMerge} (capped by the host's autoMerge)` : "unset (the host's autoMerge)", criticalPaths: [...CRITICAL_PATHS, ...c.criticalPaths], testPaths: [...TEST_PATHS, ...c.testPaths], prompt: steps, byLabel: labels }, null, 2));
  return true;
}

/** Command, ticket target and option values, or the reason the arguments are invalid. */
export function parseArgs(argv: string[]) {
  const fail = (error: string) => ({ error });
  const pos: string[] = [];
  const vals = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("-")) pos.push(a);
    else if (!FLAGS.includes(a)) return fail(`unknown flag ${a}`);
    else if (!VALUED.includes(a)) vals.set(a, "");
    else if (!argv[i + 1]) return fail(`${a} needs a value`);
    else vals.set(a, argv[++i]!);
  }
  const [cmd, id, ...extra] = pos;
  if (!cmd) return fail("missing <command>");
  const allowed = CMD_FLAGS[cmd];
  if (!allowed) return fail(`unknown command ${cmd}`);
  const wrong = [...vals.keys()].find((f) => !allowed.includes(f) && (f !== "--config" || cmd === "check"));
  if (wrong) return fail(`${cmd} does not take ${wrong}`);
  if (TARGETED.includes(cmd) && id === undefined) return fail(`${cmd} needs an <ID>`);
  const stray = cmd === "check" || cmd === "intake" || TARGETED.includes(cmd) ? extra[0] : id;
  if (stray !== undefined) return fail(`unexpected argument ${stray}`);
  const tool = vals.get("--tool");
  if (tool !== undefined && !TOOLS.includes(tool as Tool)) return fail(`--tool must be one of ${TOOLS.join(", ")}`);
  const interval = Number(vals.get("--interval") ?? 2);
  if (!Number.isFinite(interval) || interval < 1) return fail("--interval must be a number of seconds, at least 1");
  const n = Number(vals.get("-n") ?? 20);
  if (!Number.isInteger(n) || n < 1 || n > 10_000) return fail("-n must be an integer from 1 to 10000");
  const days = Number(vals.get("--days") ?? DEFAULT_DAYS);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return fail("--days must be an integer from 1 to 3650");
  return { cmd, id, interval, n, days, tool: tool as Tool | undefined, path: resolve(vals.get("--config") ?? "tender.json") };
}

async function main(argv: string[]) {
  if (argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) return console.log(USAGE);
  const args = parseArgs(argv);
  if ("error" in args) {
    console.error(`${args.error}\n${USAGE}`);
    process.exit(2);
  }
  const { cmd, id, interval, n, days, tool, path } = args;
  if (cmd === "check") process.exit(check(resolve(id ?? ".")) ? 0 : 1);
  let cfg: Config;
  try {
    cfg = parseConfig(JSON.parse(readFileSync(path, "utf8")), dirname(path));
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    console.error(missing ? `${path}: not found; run from the directory with tender.json or pass --config <path>` : `${path}: ${(e as Error).message}`);
    process.exit(1);
  }
  const dry = argv.includes("--dry-run");
  const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
  const io: Io = { run: spawnRun, fetch, dry, log, home: homedir(), event: events(cfg, dry, log) };
  if (cmd === "stats") {
    const r = await stats(cfg, { ...io, log: (m) => console.error(m) }, { days });
    return console.log(argv.includes("--json") ? JSON.stringify(r, null, 2) : statsTable(r));
  }
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
    console.error(`${h.key}/${h.id} is handed off; \`bun tender.ts resume ${h.key}/${h.id}\` gives it back`);
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
  if (cmd === "intake") {
    const held = join(cfg.workspaceRoot, ".intake.lock");
    if (!io.dry && !holdLock(held)) {
      console.error(`another tender intake holds ${held}`);
      process.exit(1);
    }
    for (const key of new Set(cfg.intake?.host === cfg.host ? cfg.intake.enabled.map((e) => e.slice(0, e.lastIndexOf(":"))) : []))
      await cloned(cfg, io, cfg.repos[key]!).catch((e) => io.log(`clone ${key} failed: ${e.message}`));
    return intake(cfg, io, TENDER_DIR, { only: id });
  }
  if (cmd === "prs") {
    const held = join(cfg.workspaceRoot, ".prs.lock");
    if (!io.dry && !holdLock(held)) {
      console.error(`another tender prs holds ${held}`);
      process.exit(1);
    }
    return console.log(await prs(cfg, io));
  }
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
