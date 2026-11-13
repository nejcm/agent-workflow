import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { AGENTS, CLAUDE_TOKEN, claudeHome, codexHome, tmpHome } from "./agents";
import { repoDir } from "./config";
import type { Config, Io, Repo, Source, Ticket, Tracker } from "./types";
import { AW_DIR, GIT, inAw, put, read, remove, write } from "./util";

export const render = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);

// Clone, fetch and checkout scale with repo size; everything else gets the runner's 60s default.
export const SLOW_SECS = 900;
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export const nonoRun = (profile: string, awDir: string, grants: [string, string][], quote = (s: string) => s) =>
  ["nono", "run", "--no-rollback-prompt", "--profile", quote(join(awDir, "nono", `${profile}.json`)), ...grants.flatMap(([flag, path]) => [flag, quote(path)]), "--"];

/** The session's systemd user scope; ':' is in no repo key or ticket id, so names never collide. */
export const scopeUnit = (key: string, id: string) => `aw-${key.replace("/", ":")}:${id}.scope`;

/** SIGKILLs the session's whole scope, setsid'd children included, which tmux kill-window leaves running; fails if systemd --user is unreachable. */
export const stopScope = (io: Io, key: string, id: string) =>
  write(io, ["systemctl", "--user", "kill", "--signal=KILL", scopeUnit(key, id)]).catch((e) => {
    if (!/ not loaded\.$/.test(e.message)) throw e;
  });

// The pane's own pty, resolved when the script runs; the profiles grant no other /dev/pts entry.
const PANE_TTY = `"$(tty)"`;

// A session clone only reads the base's objects (alternates).
export function launcher(l: Repo, wt: string, promptFile: string, awDir = AW_DIR) {
  const prompt = `"$(cat ${q(promptFile)})"`;
  const nono = l.sandbox === "nono";
  const git = join(l.path, ".git");
  const own = [...(l.agent === "claude" ? [claudeHome(wt)] : []), codexHome(wt)].map((p): [string, string] => ["--allow", p]);
  const tmp = tmpHome(wt);
  const grants: [string, string][] = [["--allow", wt], ["--allow-unix-socket-subtree-bind", wt], ["--allow", tmp], ["--allow-unix-socket-subtree-bind", tmp], ...own, ["--read", join(git, "objects")], ["--allow-file", PANE_TTY]];
  const wrap = nono ? nonoRun(`aw-${l.agent}`, awDir, grants, (s) => (s === PANE_TTY ? s : q(s))) : [];
  const [env, cmd] = AGENTS[l.agent].launch(q(wt), prompt, nono);
  // gh exits if it cannot read its config dir; <ID>.gh is never created, so gh runs on defaults plus nono's GH_TOKEN.
  // A private XDG cache: the host's ~/.cache (Claude's claude-cli-nodejs included) stays out of the sandbox.
  const gh = nono ? `export GH_CONFIG_DIR=${q(wt)}.gh XDG_CACHE_HOME=${q(join(tmp, "cache"))}\n` : "";
  const scope = ["systemd-run", "--user", "--scope", "--quiet", "--collect", "--unit", q(scopeUnit(l.key, basename(wt))), "--"];
  return `#!/usr/bin/env bash\ncd ${q(wt)} || exit 1\nunset LINEAR_API_KEY\nexport TMPDIR=${q(tmp)} TMP=${q(tmp)} TEMP=${q(tmp)}\n${gh}${env}\nexec ${[...scope, ...wrap, ...cmd].join(" ")}\n`;
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

// Fresh per start, so nothing a session left there carries over. Trust goes on the session clone.
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

/** The ChatGPT login sessions copy, relative to home; only the host holds and uses its refresh token. */
export const CODEX_AUTH = ".codex-aw/auth.json";
const REFRESH_MARGIN = 24 * 3600_000;
// app-server's `account/read` with `refreshToken` forces a refresh. flock: two concurrent refreshes of a rotating token invalidate the login.
// A login changed while waiting ($2 is the stamp aw read) was already refreshed; app-server never holds the lock.
const REFRESH = [
  'export CODEX_HOME="$1"',
  'exec {L}<"$CODEX_HOME" && flock -w 30 "$L" || exit 1',
  `[[ $(stat -c '%i %.9Y' "$CODEX_HOME/auth.json") == "$2" ]] || exit 0`,
  'coproc APP { exec {L}<&- codex app-server 2>/dev/null; }',
  `printf '%s\\n' '{"method":"initialize","id":0,"params":{"clientInfo":{"name":"aw","version":"1"}}}' '{"method":"initialized"}' '{"method":"account/read","id":1,"params":{"refreshToken":true}}' >&"\${APP[1]}"`,
  `while IFS= read -r l <&"\${APP[0]}"; do [[ $l == '{"id":1,'* ]] && { exec {APP[1]}>&-; wait; exit 0; }; done`,
  "exit 1",
].join("\n");
export const authStamp = (file: string) => {
  const s = statSync(file, { bigint: true, throwIfNoEntry: false });
  return s ? `${s.ino} ${s.mtimeNs / 1_000_000_000n}.${String(s.mtimeNs % 1_000_000_000n).padStart(9, "0")}` : "";
};
export const codexRefresh = (home: string, seen: string) => ["bash", "-c", REFRESH, "aw-codex-refresh", join(home, ".codex-aw"), seen];

const expiresAt = (o: any) => {
  try {
    const exp = JSON.parse(Buffer.from(String(o.tokens.access_token).split(".")[1]!, "base64url").toString()).exp;
    return Number.isFinite(exp) ? exp * 1000 : 0;
  } catch {
    return 0;
  }
};

/** The template's ChatGPT login with an empty refresh token (Codex rejects a missing one); refreshed on the host first when it expires within a day. */
export async function codexLogin(io: Io, now = Date.now()) {
  const file = join(io.home, CODEX_AUTH);
  const fix = `run \`CODEX_HOME=~/.codex-aw codex login\``;
  const load = () => {
    let o: any;
    try {
      o = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`${file} is missing or unreadable (${(e as Error).message}): ${fix}`);
    }
    if (typeof o?.tokens?.access_token !== "string" || typeof o.tokens.refresh_token !== "string") throw new Error(`${file} is not a ChatGPT login: ${fix}`);
    return o;
  };
  const seen = authStamp(file);
  let o = load();
  if (expiresAt(o) - now < REFRESH_MARGIN) {
    await write(io, codexRefresh(io.home, seen)).catch(() => undefined);
    if (!io.dry && expiresAt((o = load())) - now < REFRESH_MARGIN) throw new Error(`could not refresh the Codex login in ${file}: ${fix}`);
  }
  return JSON.stringify({ ...o, tokens: { ...o.tokens, refresh_token: "" } });
}

// Same as seedClaude; `login` is codexLogin's copy, the session's own credential.
export function seedCodex(io: Io, dir: string, login: string | undefined) {
  const tpl = join(io.home, ".codex-aw");
  io.log(`${io.dry ? "dry: " : ""}seed ${dir} from ${tpl}`);
  if (io.dry) return;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of ["AGENTS.md", "skills"]) if (existsSync(join(tpl, f))) symlinkSync(realpathSync(join(tpl, f)), join(dir, f));
  // Copies, not links: Codex rewrites config.toml in place, and the template stays out of the sandbox.
  for (const f of ["config.toml", "hooks.json"]) if (existsSync(join(tpl, f))) copyFileSync(join(tpl, f), join(dir, f));
  if (login) writeFileSync(join(dir, "auth.json"), login, { mode: 0o600, flag: "wx" });
}

// Shares the base clone's objects (--shared): the session never writes the base, and aw never prunes it (maintenance.auto=false, gc.pruneExpire=never).
async function cloneSession(io: Io, r: Repo, wt: string, branch: string) {
  const old = await io.run([...GIT, "-C", r.path, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const url = (await read(io, [...GIT, "-C", r.path, "remote", "get-url", "origin"])).trim();
  const base = `refs/remotes/origin/${r.baseBranch}`;
  await write(io, [...GIT, "-C", r.path, "config", "gc.pruneExpire", "never"]);
  // Built beside wt and renamed, so a failed step never leaves a half-made clone to reuse; nothing else writes <ID>.tmp.
  const tmp = `${wt}.tmp`;
  if (!io.dry) rmSync(tmp, { recursive: true, force: true });
  try {
    // file:// only for this copy of aw's own clone; the session clone then pushes to the real origin.
    await write(io, [...GIT, "-c", "protocol.file.allow=always", "-c", "advice.detachedHead=false", "clone", "-q", "--shared", "--revision", base, "--", r.path, tmp], undefined, SLOW_SECS);
    for (const a of [["remote", "set-url", "origin", url], ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], ["config", "remote.origin.tagOpt", "--no-tags"], ["update-ref", base, "HEAD"]]) await write(io, [...GIT, "-C", tmp, ...a]);
    // A branch left in the base by a legacy worktree keeps its commits.
    await write(io, [...GIT, "-C", tmp, "switch", "-q", "-c", branch, ...(old.code === 0 && old.out.trim() ? [old.out.trim()] : [])], undefined, SLOW_SECS);
  } catch (e) {
    if (!io.dry) rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  io.log(`${io.dry ? "dry: " : ""}mv ${tmp} ${wt}`);
  if (!io.dry) renameSync(tmp, wt);
}

export async function start(cfg: Config, s: Source, r: Repo, t: Ticket, tr: Tracker, io: Io, awDir: string) {
  const dir = repoDir(cfg, r.key);
  const wt = join(dir, t.id);
  const branch = `agent/${t.id}`;
  const promptFile = join(dir, `${t.id}.prompt.md`);
  const script = join(dir, `${t.id}.sh`);
  const token = join(io.home, CLAUDE_TOKEN);
  if (r.agent === "claude" && !existsSync(token)) throw new Error(`${token} is missing: run \`claude setup-token\` and save the token it prints there (chmod 600)`);
  // No window means any scope left under this name is a stale session, still writing the clone it is about to share.
  await stopScope(io, r.key, t.id);
  // Claude sessions run Codex only as a helper, so a missing Codex login does not stop them.
  const login = r.agent === "codex" ? await codexLogin(io) : await codexLogin(io).catch(() => undefined);
  await ensureClone(cfg, io, r);
  seedCodex(io, codexHome(wt), login);
  io.log(`${io.dry ? "dry: " : ""}mkdir ${tmpHome(wt)}`);
  if (!io.dry) {
    rmSync(tmpHome(wt), { recursive: true, force: true });
    mkdirSync(join(tmpHome(wt), "cache"), { recursive: true, mode: 0o700 });
  }
  put(io, join(dir, `${t.id}.source`), s.name);
  remove(io, join(dir, `${t.id}.ended`));
  await write(io, [...GIT, "-C", r.path, "fetch", "origin", r.baseBranch], undefined, SLOW_SECS);
  if (existsSync(wt)) io.log(`reuse ${wt}`);
  else await cloneSession(io, r, wt, branch);
  if (r.agent === "claude") seedClaude(io, claudeHome(wt), existsSync(wt) ? realpathSync(wt) : wt);
  const vars = { id: t.id, title: t.title, body: t.body, url: t.url, branch, base: r.baseBranch, testCmd: r.testCmd, repo: r.key };
  io.log(`${io.dry ? "dry: " : ""}write ${join(wt, ".aw", ".gitignore")}`);
  if (!io.dry) {
    mkdirSync(join(wt, ".aw"), { recursive: true });
    // Unlink + exclusive create: never write through a symlink or hardlink the agent left there.
    inAw(wt, (d) => (rmSync(`${d}/.gitignore`, { force: true }), writeFileSync(`${d}/.gitignore`, "*\n", { flag: "wx" })));
  }
  put(io, promptFile, render(readFileSync(r.prompt, "utf8"), vars));
  put(io, script, launcher(r, wt, promptFile, awDir), 0o755);
  await write(io, ["tmux", "new-window", "-d", "-t", `=${cfg.tmuxSession}:`, "-n", winName(r.key, t.id), script]);
  // Claimed last so a failed start leaves the ticket ready for the next poll; the open window stops a double start.
  // claim throws only when the label or state change failed, so the ticket is still ready then.
  try {
    await tr.claim(t);
  } catch (e) {
    await stopScope(io, r.key, t.id).catch((k) => io.log(`${t.id}: claim failed and stopping its scope failed (${k.message}); run systemctl --user kill --signal=KILL ${scopeUnit(r.key, t.id)}`));
    await write(io, ["tmux", "kill-window", "-t", `=${cfg.tmuxSession}:=${winName(r.key, t.id)}`]).catch((k) => io.log(`${t.id}: claim failed and kill-window failed (${k.message}); kill window ${winName(r.key, t.id)} by hand`));
    throw e;
  }
}
