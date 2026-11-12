#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseConfig } from "./src/config";
import { dashboard, watch } from "./src/dash";
import { pass } from "./src/pass";
import { snapshot, table } from "./src/status";
import { tail } from "./src/tail";
import type { Config, Io, Run } from "./src/types";

async function status(cfg: Config, io: Io) {
  return [
    `max ${cfg.maxConcurrent} sessions`,
    ...cfg.sources.map((s) => `source ${s.name}  ${s.tracker === "linear" ? `linear ${s.team}` : "github (all repos)"}`),
    ...Object.values(cfg.repos).map((r) => `${r.key}  ${r.agent}/${r.sandbox}  max ${r.maxConcurrent ?? "-"}  merge ${r.autoMerge}  ${r.path}`),
    "",
    table(await snapshot(cfg, io)),
  ].join("\n");
}

const spawnRun: Run = async (argv, cwd) => {
  const p = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
};

const USAGE = `usage: bun aw.ts <command> [--config aw.json]
  run | once [--dry-run]
  status [--json]
  watch [--interval 2] [--plain]
  tail <ID | owner/repo/ID> [-n 20] [--no-follow]`;
const VALUED = ["--config", "--interval", "-n"];
const FLAGS = [...VALUED, "--dry-run", "--json", "--no-follow", "--plain"];

/** Command, ticket target and option values, or undefined for unknown flags, stray args or out-of-range numbers. */
export function parseArgs(argv: string[]) {
  const isValue = (i: number) => VALUED.includes(argv[i - 1] ?? "");
  const opt = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? "" : undefined);
  const [cmd, id, ...extra] = argv.filter((a, i) => !a.startsWith("-") && !isValue(i));
  const interval = Number(opt("--interval") ?? 2);
  const n = Number(opt("-n") ?? 20);
  const ok =
    argv.every((a, i) => !a.startsWith("-") || isValue(i) || FLAGS.includes(a)) &&
    ["run", "once", "status", "watch", "tail"].includes(cmd ?? "") &&
    !extra.length &&
    (cmd === "tail") === (id !== undefined) &&
    Number.isFinite(interval) &&
    interval >= 1 &&
    Number.isInteger(n) &&
    n >= 1 &&
    n <= 10_000 &&
    opt("--config") !== "";
  return ok ? { cmd: cmd!, id, interval, n, path: resolve(opt("--config") ?? "aw.json") } : undefined;
}

async function main(argv: string[]) {
  const args = parseArgs(argv);
  if (!args) {
    console.error(USAGE);
    process.exit(2);
  }
  const { cmd, id, interval, n, path } = args;
  let cfg: Config;
  try {
    cfg = parseConfig(JSON.parse(readFileSync(path, "utf8")), dirname(path));
  } catch (e) {
    console.error(`${path}: ${(e as Error).message}`);
    process.exit(1);
  }
  const io: Io = { run: spawnRun, fetch, dry: argv.includes("--dry-run"), log: (m) => console.log(`${new Date().toISOString()} ${m}`), home: homedir() };
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
  if (cmd === "once") return pass(cfg, io);
  for (;;) {
    await pass(cfg, io);
    await Bun.sleep(cfg.pollIntervalMs);
  }
}

if (import.meta.main) await main(Bun.argv.slice(2));
