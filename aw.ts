#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { repoDir, parseConfig } from "./src/config";
import { windows } from "./src/launcher";
import { pass, worktreeIds } from "./src/pass";
import type { Config, Io, Run } from "./src/types";

async function status(cfg: Config, io: Io) {
  const wins = await windows(cfg, io);
  console.log(`max ${cfg.maxConcurrent} sessions`);
  for (const s of cfg.sources) console.log(`source ${s.name}  ${s.tracker === "linear" ? `linear ${s.team}` : "github (all repos)"}`);
  for (const r of Object.values(cfg.repos)) {
    const running = [...wins.keys()].filter((n) => n.startsWith(`${r.key}/`)).map((n) => n.slice(r.key.length + 1));
    console.log(`${r.key}  ${r.agent}/${r.sandbox}  max ${r.maxConcurrent ?? "-"}  merge ${r.autoMerge}  ${r.path}`);
    console.log(`  windows:   ${running.join(" ") || "-"}`);
    console.log(`  worktrees: ${worktreeIds(repoDir(cfg, r.key)).join(" ") || "-"}`);
  }
}

const spawnRun: Run = async (argv, cwd) => {
  const p = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
};

async function main(argv: string[]) {
  const ci = argv.indexOf("--config");
  const path = resolve(ci >= 0 ? argv[ci + 1] ?? "" : "aw.json");
  const cmd = argv.filter((a, i) => !a.startsWith("--") && !(ci >= 0 && i === ci + 1))[0];
  if (!["run", "once", "status"].includes(cmd ?? "")) {
    console.error("usage: bun aw.ts <run|once|status> [--dry-run] [--config aw.json]");
    process.exit(2);
  }
  let cfg: Config;
  try {
    cfg = parseConfig(JSON.parse(readFileSync(path, "utf8")), dirname(path));
  } catch (e) {
    console.error(`${path}: ${(e as Error).message}`);
    process.exit(1);
  }
  const io: Io = { run: spawnRun, fetch, dry: argv.includes("--dry-run"), log: (m) => console.log(`${new Date().toISOString()} ${m}`) };
  if (cmd === "status") return status(cfg, io);
  if (cmd === "once") return pass(cfg, io);
  for (;;) {
    await pass(cfg, io);
    await Bun.sleep(cfg.pollIntervalMs);
  }
}

if (import.meta.main) await main(Bun.argv.slice(2));
