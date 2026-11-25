import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { capturePath, install, which, type Job, type Schedule } from "@nejcm/oncue";

const jobs: Record<string, { description: string; schedule: Schedule; hint: string }> = {
  run: {
    description: "tender: start agent sessions for ready tickets",
    schedule: { kind: "keepAlive", restart: "on-failure", delaySeconds: 30 },
    hint: "systemctl --user status tender-run; sessions: tmux attach -t tender",
  },
  intake: {
    description: "tender: run the intake rules enabled for this host",
    schedule: { kind: "interval", minutes: 15 },
    hint: "systemctl --user list-timers tender-intake; logs: journalctl --user -u tender-intake",
  },
  prs: {
    description: "tender: close orphan agent PRs, report the rest",
    schedule: { kind: "calendar", at: [{ weekday: "mon", hour: 9, minute: 0 }] },
    hint: "systemctl --user list-timers tender-prs; logs: journalctl --user -u tender-prs",
  },
};

const name = process.argv[2] ?? "";
const spec = Object.hasOwn(jobs, name) ? jobs[name] : undefined;
const bun = which("bun");
if (!spec || !bun) {
  console.error(spec ? "bun not found on PATH" : "usage: bun scripts/service.ts <run|intake|prs>");
  process.exit(1);
}
const mac = process.platform === "darwin";
// oncue creates the log directory only for a custom `log` path.
if (mac) mkdirSync(join(homedir(), "Library/Logs"), { recursive: true });

const tools = ["bun", "claude", "codex", "gh", "nono", "tmux", "git", ...(mac ? ["gtimeout", "flock"] : [])];
const job: Job = {
  namespace: "tender",
  name,
  description: spec.description,
  command: [bun, "tender.ts", name, "--config", "tender.json"],
  cwd: process.cwd(),
  env: { PATH: capturePath(tools) },
  schedule: spec.schedule,
  ...(name === "run" && { leaveChildrenOnStop: true }),
};

const { changed, warnings } = install(job);
for (const w of warnings) console.warn(`warning: ${w}`);
console.log(`tender-${name} changed: ${changed}`);
console.log(mac ? `log: ~/Library/Logs/tender-${name}.log` : spec.hint);
