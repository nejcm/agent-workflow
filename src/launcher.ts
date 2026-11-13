import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { AGENTS, CLAUDE_TOKEN, claudeHome } from "./agents";
import { repoDir } from "./config";
import type { Config, Io, Repo, Source, Ticket, Tracker } from "./types";
import { AW_DIR, GIT, inAw, put, remove, write } from "./util";

export const render = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);

// Clone, fetch and checkout scale with repo size; everything else gets the runner's 60s default.
const SLOW_SECS = 900;
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export const nonoRun = (l: Repo, awDir: string, grants: [string, string][], quote = (s: string) => s) =>
  ["nono", "run", "--no-rollback-prompt", "--profile", quote(join(awDir, "nono", `aw-${l.agent}.json`)), ...grants.flatMap(([flag, path]) => [flag, quote(path)]), "--"];

export function launcher(l: Repo, wt: string, promptFile: string, awDir = AW_DIR, admin = join(l.path, ".git", "worktrees", basename(wt))) {
  const prompt = `"$(cat ${q(promptFile)})"`;
  const nono = l.sandbox === "nono";
  const git = join(l.path, ".git");
  // Read-only .git: config, hooks and info stay out of reach; only what commits and pushes write is granted.
  const rw = [join(git, "objects"), join(git, "refs"), join(git, "logs"), admin].map((p): [string, string] => ["--allow", p]);
  const own: [string, string][] = l.agent === "claude" ? [["--allow", claudeHome(wt)]] : [];
  const wrap = nono ? nonoRun(l, awDir, [["--allow", wt], ...own, ["--read", git], ...rw], q) : [];
  const [env, cmd] = AGENTS[l.agent].launch(q(wt), prompt, nono);
  return `#!/usr/bin/env bash\ncd ${q(wt)} || exit 1\nunset LINEAR_API_KEY\n${env}\nexec ${[...wrap, ...cmd].join(" ")}\n`;
}

const gitFile = (p: string) => {
  if (!lstatSync(p).isFile()) throw new Error(`${p} is not a regular file`);
  return readFileSync(p, "utf8").trim();
};

// git names the admin dir <id>1 on a clash; trust it only if it sits in <clone>/.git/worktrees and links back to wt.
export function adminDir(l: Repo, wt: string) {
  const admin = realpathSync(resolve(wt, gitFile(join(wt, ".git")).replace(/^gitdir: /, "")));
  if (dirname(admin) !== realpathSync(join(l.path, ".git", "worktrees")) || realpathSync(resolve(admin, gitFile(join(admin, "gitdir")))) !== realpathSync(join(wt, ".git")))
    throw new Error(`${wt}/.git does not point to its own admin dir in ${l.path}/.git/worktrees`);
  return admin;
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
    const git = await io.run([...GIT, "-C", r.path, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    // Also rejects a subdirectory or linked worktree of another clone, which would share its .git.
    if (git.code !== 0 || git.out.trim() !== join(real, ".git")) throw new Error(`${r.path} is not the top of its own git clone (interrupted clone, subdirectory or worktree?); fix or remove it by hand`);
    const twin = Object.values(cfg.repos).find((o) => o !== r && existsSync(o.path) && realpathSync(o.path) === real);
    if (twin) throw new Error(`${r.path} is the same clone as ${twin.key}'s path`);
    return;
  }
  const tmp = `${r.path}.tmp-${process.pid}-${Date.now()}`;
  await write(io, ["gh", "repo", "clone", r.key, tmp], undefined, SLOW_SECS);
  io.log(`${io.dry ? "dry: " : ""}mv ${tmp} ${r.path}`);
  if (!io.dry) renameSync(tmp, r.path);
}

const TEMPLATE = ["settings.json", "CLAUDE.md", "AGENTS.md", "skills", "plugins"];
const ACCOUNT = ["hasCompletedOnboarding", "lastOnboardingVersion", "oauthAccount", "userID"];

// Fresh per start, so nothing a session left there carries over. Trust goes on the clone root, which covers its worktrees.
export function seedClaude(io: Io, dir: string, root: string) {
  const tpl = join(io.home, ".claude-aw");
  io.log(`${io.dry ? "dry: " : ""}seed ${dir} from ${tpl}`);
  if (io.dry) return;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of TEMPLATE) if (existsSync(join(tpl, f))) symlinkSync(realpathSync(join(tpl, f)), join(dir, f));
  let o: any = {};
  try {
    o = JSON.parse(readFileSync(join(tpl, ".claude.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const seed = Object.fromEntries(ACCOUNT.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ ...seed, projects: { [root]: { hasTrustDialogAccepted: true } } }, null, 2), { mode: 0o600, flag: "wx" });
}

export async function start(cfg: Config, s: Source, r: Repo, t: Ticket, tr: Tracker, io: Io, awDir: string) {
  const dir = repoDir(cfg, r.key);
  const wt = join(dir, t.id);
  const branch = `agent/${t.id}`;
  const promptFile = join(dir, `${t.id}.prompt.md`);
  const script = join(dir, `${t.id}.sh`);
  const token = join(io.home, CLAUDE_TOKEN);
  if (r.agent === "claude" && !existsSync(token)) throw new Error(`${token} is missing: run \`claude setup-token\` and save the token it prints there (chmod 600)`);
  await ensureClone(cfg, io, r);
  if (r.agent === "claude") seedClaude(io, claudeHome(wt), existsSync(r.path) ? realpathSync(r.path) : r.path);
  put(io, join(dir, `${t.id}.source`), s.name);
  remove(io, join(dir, `${t.id}.ended`));
  await write(io, [...GIT, "-C", r.path, "fetch", "origin", r.baseBranch], undefined, SLOW_SECS);
  if (existsSync(wt)) io.log(`reuse ${wt}`);
  else {
    const hasBranch = (await io.run([...GIT, "-C", r.path, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
    await write(io, [...GIT, "-C", r.path, "worktree", "add", wt, ...(hasBranch ? [branch] : ["-b", branch, `origin/${r.baseBranch}`])], undefined, SLOW_SECS);
  }
  const vars = { id: t.id, title: t.title, body: t.body, url: t.url, branch, base: r.baseBranch, testCmd: r.testCmd, repo: r.key };
  io.log(`${io.dry ? "dry: " : ""}write ${join(wt, ".aw", ".gitignore")}`);
  if (!io.dry) {
    mkdirSync(join(wt, ".aw"), { recursive: true });
    // Unlink + exclusive create: never write through a symlink or hardlink the agent left there.
    inAw(wt, (d) => (rmSync(`${d}/.gitignore`, { force: true }), writeFileSync(`${d}/.gitignore`, "*\n", { flag: "wx" })));
  }
  put(io, promptFile, render(readFileSync(r.prompt, "utf8"), vars));
  put(io, script, launcher(r, wt, promptFile, awDir, io.dry || r.sandbox !== "nono" ? undefined : adminDir(r, wt)), 0o755);
  await write(io, ["tmux", "new-window", "-d", "-t", `=${cfg.tmuxSession}:`, "-n", winName(r.key, t.id), script]);
  // Claimed last so a failed start leaves the ticket ready for the next poll; the open window stops a double start.
  try {
    await tr.claim(t);
  } catch (e) {
    await write(io, ["tmux", "kill-window", "-t", `=${cfg.tmuxSession}:=${winName(r.key, t.id)}`]).catch((k) => io.log(`${t.id}: claim failed and kill-window failed (${k.message}); kill window ${winName(r.key, t.id)} by hand`));
    throw e;
  }
}
