import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { AGENTS, CLAUDE_TOKEN, claudeHome, codexHome, tmpHome } from "./agents";
import { checkLogin, findBun, readLogin } from "./claude-auth";
import { repoDir } from "./config";
import type { Config, Io, Repo, Source, Ticket, Tracker } from "./types";
import { GIT, inAw, put, read, remove, write } from "./util";

export const render = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);

// Clone, fetch and checkout scale with repo size; everything else gets the runner's 60s default.
export const SLOW_SECS = 900;
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export const nonoRun = (profile: string, awDir: string, grants: [string, string][], quote = (s: string) => s) =>
  ["nono", "run", "--no-rollback-prompt", "--profile", quote(join(awDir, "nono", `${profile}.json`)), ...grants.flatMap(([flag, path]) => [flag, quote(path)]), "--"];

const scopePrefix = (cfg: Config) => `aw-${createHash("sha256").update(cfg.workspaceRoot).digest("hex").slice(0, 8)}`;

/** The session's systemd user scope, prefixed per workspace; ':' is in no repo key or ticket id, so names never collide. */
export const scopeUnit = (cfg: Config, key: string, id: string) => `${scopePrefix(cfg)}:${key.replace("/", ":")}:${id}.scope`;

/** SIGKILLs the session's scope, setsid'd children included (kill-window leaves them); throws if systemd --user is unreachable. */
export const stopScope = (cfg: Config, io: Io, key: string, id: string) =>
  write(io, ["systemctl", "--user", "kill", "--signal=KILL", scopeUnit(cfg, key, id)]).catch((e) => {
    if (!/ not loaded\.$/.test(e.message)) throw e;
  });

const cgroupOf = (pid: string) => {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, "utf8");
  } catch {
    return "";
  }
};

/** Stops this workspace's scopes that hold no pane of its tmux session; must run before any start this pass. */
export async function sweepScopes(cfg: Config, io: Io, cgroup = cgroupOf) {
  // Units first: a scope listed already holds its pane's pid, so a session starting meanwhile is never taken for an orphan.
  const out = await read(io, ["systemctl", "--user", "list-units", "--type=scope", "--plain", "--no-legend", `${scopePrefix(cfg)}:*`]);
  const pids = await read(io, ["tmux", "list-panes", "-s", "-t", `=${cfg.tmuxSession}`, "-F", "#{pane_pid}"]);
  const live = new Set(pids.split("\n").filter(Boolean).map((pid) => /\/(aw-[^/]+\.scope)$/m.exec(cgroup(pid))?.[1]));
  for (const unit of out.split("\n").map((l) => l.trim().split(/\s+/)[0])) if (unit && !live.has(unit)) await write(io, ["systemctl", "--user", "kill", "--signal=KILL", unit]);
}

export function launcher(l: Repo, wt: string, promptFile: string, unit: string, awDir: string, bun: string) {
  const prompt = `"$(cat ${q(promptFile)})"`;
  const nono = l.sandbox === "nono";
  const git = join(l.path, ".git");
  const own = [claudeHome(wt), codexHome(wt)].map((p): [string, string] => ["--allow", p]);
  const tmp = tmpHome(wt);
  const grants: [string, string][] = [["--allow", wt], ["--allow-unix-socket-subtree-bind", wt], ["--allow", tmp], ["--allow-unix-socket-subtree-bind", tmp], ...own, ["--read", join(git, "objects")]];
  const wrap = nono ? nonoRun(`aw-${l.agent}`, awDir, grants, q) : [];
  const [env, cmd] = AGENTS[l.agent].launch(q(wt), prompt, nono);
  // gh exits if it cannot read its config dir; <ID>.gh is never created, so gh runs on defaults plus nono's GH_TOKEN.
  // A private XDG cache: the host's ~/.cache (Claude's claude-cli-nodejs included) stays out of the sandbox.
  const box = nono ? `unset CLAUDE_CODE_OAUTH_TOKEN\nexport GH_CONFIG_DIR=${q(wt)}.gh XDG_CACHE_HOME=${q(join(tmp, "cache"))} AW_BUN=${q(bun)}\n` : "";
  const scope = ["systemd-run", "--user", "--scope", "--quiet", "--collect", "--unit", q(unit), "--"];
  return `#!/usr/bin/env bash\ncd ${q(wt)} || exit 1\nunset LINEAR_API_KEY\nexport TMPDIR=${q(tmp)} TMP=${q(tmp)} TEMP=${q(tmp)}\n${box}${env}\nexec ${[...scope, ...wrap, ...cmd].join(" ")}\n`;
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
const pick = (o: any, keys: string[]) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));

// Fresh per start, so nothing a session left there carries over. Account keys come from the host login's ~/.claude.json; trust goes on the session clone.
export function seedClaude(io: Io, dir: string, root: string) {
  const tpl = join(io.home, ".claude-aw");
  io.log(`${io.dry ? "dry: " : ""}seed ${dir} from ${tpl}`);
  if (io.dry) return;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of TEMPLATE) if (existsSync(join(tpl, f))) symlinkSync(realpathSync(join(tpl, f)), join(dir, f));
  let o: any = {};
  try {
    o = JSON.parse(readFileSync(join(io.home, ".claude.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ ...pick(o, ACCOUNT), projects: { [root]: { hasTrustDialogAccepted: true } } }, null, 2), { mode: 0o600, flag: "wx" });
}

/** The ChatGPT login sessions copy, relative to home; only the host holds and uses its refresh token. */
export const CODEX_AUTH = ".codex-aw/auth.json";
const REFRESH_MARGIN = 24 * 3600_000;
// What an access-token ChatGPT login needs; API keys, PATs, Bedrock keys and anything newer stay on the host.
const LOGIN = ["auth_mode", "last_refresh"];
const TOKENS = ["id_token", "access_token", "account_id", "login_owner_id"];
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

/** The template's ChatGPT login, allowlisted, with an empty refresh token (Codex rejects a missing one); refreshed on the host first when it expires within a day. */
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
  return JSON.stringify({ ...pick(o, LOGIN), tokens: { ...pick(o.tokens, TOKENS), ...(o.tokens.oauth_provenance && { oauth_provenance: pick(o.tokens.oauth_provenance, ["issuer", "client_id"]) }), refresh_token: "" } });
}

const HOOK_MARKERS = ["# >>> aw state hooks (managed by scripts/codex-hooks.sh)", "# <<< aw state hooks"];

/** A warning when the template config lacks aw's Codex state hooks, without which answers and PR feedback are never delivered. */
export function codexHooksWarning(home: string) {
  const file = join(home, ".codex-aw/config.toml");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  if (!HOOK_MARKERS.every((m) => lines.includes(m))) return `${file} lacks aw's state hooks, so the session never reads idle and gets no answers or PR feedback: run \`scripts/codex-hooks.sh ~/.codex-aw/config.toml\``;
}

// Same as seedClaude; `login` is codexLogin's copy, the session's own credential.
export function seedCodex(io: Io, dir: string, login: string | undefined, root: string) {
  const tpl = join(io.home, ".codex-aw");
  io.log(`${io.dry ? "dry: " : ""}seed ${dir} from ${tpl}`);
  if (io.dry) return;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of ["AGENTS.md", "skills"]) if (existsSync(join(tpl, f))) symlinkSync(realpathSync(join(tpl, f)), join(dir, f));
  // Copies, not links: Codex rewrites config.toml in place, and the template stays out of the sandbox.
  for (const f of ["config.toml", "hooks.json"]) if (existsSync(join(tpl, f))) copyFileSync(join(tpl, f), join(dir, f));
  if (login) writeFileSync(join(dir, "auth.json"), login, { mode: 0o600, flag: "wx" });
  const cfg = join(dir, "config.toml");
  const old = existsSync(cfg) ? readFileSync(cfg, "utf8") : "";
  if (trusted(old, root)) return;
  // JSON escapes every character a TOML basic string forbids except DEL.
  const next = `${old}\n[projects.${JSON.stringify(root).replaceAll("\x7f", "\\u007F")}]\ntrust_level = "trusted"\n`;
  if (!trusted(next, root)) throw new Error(`${join(tpl, "config.toml")} cannot take a trust entry for ${root} (invalid TOML, an inline \`projects\` table, or that path already untrusted): fix it by hand`);
  writeFileSync(cfg, next);
}

const trusted = (toml: string, root: string) => {
  try {
    return (Bun.TOML.parse(toml) as any).projects?.[root]?.trust_level === "trusted";
  } catch {
    return false;
  }
};

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
  const nono = r.sandbox === "nono";
  const token = join(io.home, CLAUDE_TOKEN);
  if (r.agent === "claude" && !nono && !existsSync(token)) throw new Error(`${token} is missing: run \`claude setup-token\` and save the token it prints there (chmod 600)`);
  const warn = r.agent === "claude" && nono ? checkLogin(readLogin(io.home), Date.now()) : undefined;
  if (warn) io.log(warn);
  const bun = nono ? findBun([cfg.workspaceRoot]) : "";
  // No window means any scope left under this name is a stale session, still writing the clone it is about to share.
  await stopScope(cfg, io, r.key, t.id);
  // Claude sessions run Codex only as a helper, so a missing Codex login does not stop them.
  const login = r.agent === "codex" ? await codexLogin(io) : await codexLogin(io).catch(() => undefined);
  const noHooks = r.agent === "codex" ? codexHooksWarning(io.home) : undefined;
  if (noHooks) io.log(noHooks);
  await ensureClone(cfg, io, r);
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
  const root = existsSync(wt) ? realpathSync(wt) : wt;
  seedCodex(io, codexHome(wt), login, root);
  if (r.agent === "claude" || nono) seedClaude(io, claudeHome(wt), root);
  const vars = { id: t.id, title: t.title, body: t.body, url: t.url, branch, base: r.baseBranch, testCmd: r.testCmd, repo: r.key, planStep: r.planStep };
  io.log(`${io.dry ? "dry: " : ""}write ${join(wt, ".aw", ".gitignore")}`);
  if (!io.dry) {
    mkdirSync(join(wt, ".aw"), { recursive: true });
    // Unlink + exclusive create: never write through a symlink or hardlink the agent left there.
    inAw(wt, (d) => (rmSync(`${d}/.gitignore`, { force: true }), writeFileSync(`${d}/.gitignore`, "*\n", { flag: "wx" })));
  }
  put(io, promptFile, render(readFileSync(r.prompt, "utf8"), vars));
  put(io, script, launcher(r, wt, promptFile, scopeUnit(cfg, r.key, t.id), awDir, bun), 0o755);
  // Claimed last, so a failed start leaves the ticket ready; `<ID>.claim` goes first, so a claim lost to an error or a crash is retried while the window lives.
  const pending = join(dir, `${t.id}.claim`);
  put(io, pending, new Date().toISOString());
  await write(io, ["tmux", "new-window", "-d", "-t", `=${cfg.tmuxSession}:`, "-n", winName(r.key, t.id), script]);
  await claim(io, tr, pending, t).catch((e) => io.log(`${t.id}: claim failed, session left running and the claim retried next poll: ${e.message}`));
}

/** Claims a started session's ticket; `<ID>.claim` marks it unclaimed until the claim succeeds. */
export async function claim(io: Io, tr: Tracker, file: string, t: Ticket) {
  await tr.claim(t);
  remove(io, file);
}
