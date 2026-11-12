import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoDir } from "./config";
import type { Config, Io, Repo, Source, Ticket, Tracker } from "./types";
import { AW_DIR, inAw, put, remove, write } from "./util";

export const render = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function launcher(l: Repo, t: Ticket, wt: string, promptFile: string, awDir = AW_DIR) {
  const prompt = `"$(cat ${q(promptFile)})"`;
  const nono = l.sandbox === "nono";
  const wrap = nono ? ["nono", "run", "--no-rollback-prompt", "--profile", q(join(awDir, "nono", `aw-${l.agent}.json`)), "--allow", q(wt), "--allow", q(join(l.path, ".git")), "--"] : [];
  const title = t.title.replace(/[^\w .,:()#-]/g, "").slice(0, 60).trim();
  const [env, cmd] =
    l.agent === "claude"
      ? ['export CLAUDE_CONFIG_DIR="$HOME/.claude-aw" CODEX_HOME="$HOME/.codex-aw" CLAUDE_CODE_TMPDIR="$HOME/.claude-aw/tmp"; mkdir -p "$CLAUDE_CODE_TMPDIR"', ["claude", "--remote-control", q(`${t.id}: ${title}`), "--permission-mode", "bypassPermissions", prompt]]
      : ['export CODEX_HOME="$HOME/.codex-aw"', ["codex", ...(nono ? ["--no-daemon"] : []), "--sandbox", "danger-full-access", "--ask-for-approval", "never", "-C", q(wt), prompt]];
  return `#!/usr/bin/env bash\ncd ${q(wt)} || exit 1\nunset LINEAR_API_KEY\n${env}\nexec ${[...wrap, ...cmd].join(" ")}\n`;
}

export async function windows(cfg: Config, io: Io) {
  const r = await io.run(["tmux", "list-windows", "-t", `=${cfg.tmuxSession}`, "-F", "#{window_id} #{window_name}"]);
  const m = new Map<string, string>();
  if (r.code === 0) for (const line of r.out.split("\n").filter(Boolean)) m.set(line.slice(line.indexOf(" ") + 1), line.split(" ")[0]);
  return m;
}

export const winName = (key: string, id: string) => `${key}/${id}`;

// Clone beside the target and rename, so an interrupted clone never looks finished; never deletes anything.
async function ensureClone(cfg: Config, io: Io, r: Repo) {
  if (existsSync(r.path)) {
    const real = realpathSync(r.path);
    const git = await io.run(["git", "-C", r.path, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    // Also rejects a subdirectory or linked worktree of another clone, which would share its .git.
    if (git.code !== 0 || git.out.trim() !== join(real, ".git")) throw new Error(`${r.path} is not the top of its own git clone (interrupted clone, subdirectory or worktree?); fix or remove it by hand`);
    const twin = Object.values(cfg.repos).find((o) => o !== r && existsSync(o.path) && realpathSync(o.path) === real);
    if (twin) throw new Error(`${r.path} is the same clone as ${twin.key}'s path`);
    return;
  }
  const tmp = `${r.path}.tmp-${process.pid}-${Date.now()}`;
  await write(io, ["gh", "repo", "clone", r.key, tmp]);
  io.log(`${io.dry ? "dry: " : ""}mv ${tmp} ${r.path}`);
  if (!io.dry) renameSync(tmp, r.path);
}

export async function start(cfg: Config, s: Source, r: Repo, t: Ticket, tr: Tracker, io: Io, awDir: string) {
  const dir = repoDir(cfg, r.key);
  const wt = join(dir, t.id);
  const branch = `agent/${t.id}`;
  const promptFile = join(dir, `${t.id}.prompt.md`);
  const script = join(dir, `${t.id}.sh`);
  await ensureClone(cfg, io, r);
  put(io, join(dir, `${t.id}.source`), s.name);
  await tr.claim(t);
  remove(io, join(dir, `${t.id}.ended`));
  await write(io, ["git", "-C", r.path, "fetch", "origin", r.baseBranch]);
  if (existsSync(wt)) io.log(`reuse ${wt}`);
  else {
    const hasBranch = (await io.run(["git", "-C", r.path, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
    await write(io, ["git", "-C", r.path, "worktree", "add", wt, ...(hasBranch ? [branch] : ["-b", branch, `origin/${r.baseBranch}`])]);
  }
  const vars = { id: t.id, title: t.title, body: t.body, url: t.url, branch, base: r.baseBranch, testCmd: r.testCmd, repo: r.key };
  io.log(`${io.dry ? "dry: " : ""}write ${join(wt, ".aw", ".gitignore")}`);
  if (!io.dry) {
    mkdirSync(join(wt, ".aw"), { recursive: true });
    // Unlink + exclusive create: never write through a symlink or hardlink the agent left there.
    inAw(wt, (d) => (rmSync(`${d}/.gitignore`, { force: true }), writeFileSync(`${d}/.gitignore`, "*\n", { flag: "wx" })));
  }
  put(io, promptFile, render(readFileSync(r.prompt, "utf8"), vars));
  put(io, script, launcher(r, t, wt, promptFile, awDir), 0o755);
  await write(io, ["tmux", "new-window", "-d", "-t", `=${cfg.tmuxSession}:`, "-n", winName(r.key, t.id), script]);
}
