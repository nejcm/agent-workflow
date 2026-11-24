import { createHash } from "node:crypto";
import { closeSync, constants as C, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { AGENTS, agentLabel, CLAUDE_TOKEN, claudeHome, codexHome, recordedAgentConfig, tmpHome } from "./agents";
import { checkLogin, findBun, readLogin } from "./claude-auth";
import { repoDir } from "../config/config";
import { canonical, sameRepo } from "../github";
import { typeFor } from "../config/profile";
import { configCache, loadSession, promptFor } from "../config/repo-config";
import type { AgentConfig, Config, Io, Repo, Session, Source, TaskType, Ticket, Tracker } from "../types";
import { GIT, inDir, inRun, passLocked, put, quote, read, remove, SLOW_SECS, SYSTEMD, write, writeRun } from "../util";
import { byOperator, historyFrame } from "./question";
import { allocatePorts, type ComposeJob, composeProject, portGrants, requireLandlock } from "./needs";

export const render = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);

const MAX_BODY = 24_000;
// The prompt is one argv string, which Linux caps at 128 KiB.
const MAX_PROMPT_KIB = 120;

export const nonoRun = (profile: string, tenderDir: string, grants: [string, string][], quote = (s: string) => s) =>
  ["nono", "run", "--no-rollback-prompt", "--profile", quote(join(tenderDir, "nono", `${profile}.json`)), ...grants.flatMap(([flag, path]) => [flag, quote(path)]), "--"];

export const scopePrefix = (cfg: Config) => `tender-${createHash("sha256").update(cfg.workspaceRoot).digest("hex").slice(0, 8)}`;

/** The session's systemd user scope, prefixed per workspace; ':' is in no repo key or ticket id, so names never collide. */
export const scopeUnit = (cfg: Config, key: string, id: string) => `${scopePrefix(cfg)}:${key.replace("/", ":")}:${id}.scope`;

/** SIGKILLs the session's scope, setsid'd children included (kill-window leaves them); throws if systemd --user is unreachable. */
export const stopScope = (cfg: Config, io: Io, key: string, id: string) =>
  !SYSTEMD ? Promise.resolve() : write(io, ["systemctl", "--user", "kill", "--signal=KILL", scopeUnit(cfg, key, id)]).catch((e) => {
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
  if (!SYSTEMD) return;
  // Units first: a scope listed already holds its pane's pid, so a session starting meanwhile is never taken for an orphan.
  const out = await read(io, ["systemctl", "--user", "list-units", "--type=scope", "--plain", "--no-legend", `${scopePrefix(cfg)}:*`]);
  const pids = await read(io, ["tmux", "list-panes", "-s", "-t", `=${cfg.tmuxSession}`, "-F", "#{pane_pid}"]);
  const live = new Set(pids.split("\n").filter(Boolean).map((pid) => /\/(tender-[^/]+\.scope)$/m.exec(cgroup(pid))?.[1]));
  for (const unit of out.split("\n").map((l) => l.trim().split(/\s+/)[0])) if (unit && !live.has(unit)) await write(io, ["systemctl", "--user", "kill", "--signal=KILL", unit]);
}

// Room for tsx's `/tsx-<uid>/<pid>.pipe`, the longest socket suffix seen under a session's TMPDIR.
const SOCKET_SUFFIX = 22;

/** A warning when a socket made in `tmp` would overflow sun_path (108 bytes with its NUL). */
export const socketWarning = (tmp: string) => {
  const n = Buffer.byteLength(tmp);
  if (n + SOCKET_SUFFIX > 107) return `${tmp} is ${n} bytes, so a Unix socket a tool makes there (tsx adds ~${SOCKET_SUFFIX}) can exceed the 108-byte sun_path limit: shorten workspaceRoot`;
};

/** `services`: the `<ID>.compose` dir whose project the script starts, on the host, before the agent. */
export function launcher(l: Pick<Session, "agent" | "sandbox" | "path" | "model" | "effort">, wt: string, promptFile: string, unit: string, tenderDir: string, bun: string, ports: number[] = [], services?: string, systemd = SYSTEMD) {
  const prompt = `"$(cat ${quote(promptFile)})"`;
  const nono = l.sandbox === "nono";
  const git = join(l.path, ".git");
  const own = [claudeHome(wt), codexHome(wt)].map((p): [string, string] => ["--allow", p]);
  const tmp = tmpHome(wt);
  const grants: [string, string][] = [["--allow", wt], ["--allow-unix-socket-subtree-bind", wt], ["--allow", tmp], ["--allow-unix-socket-subtree-bind", tmp], ...own, ["--read", join(git, "objects")], ...portGrants(ports)];
  const wrap = nono ? nonoRun(`tender-${l.agent}`, tenderDir, grants, quote) : [];
  const [env, cmd] = AGENTS[l.agent].launch(quote(wt), prompt, nono, l);
  // gh exits if it cannot read its config dir; <ID>.gh is never created, so gh runs on defaults plus nono's GH_TOKEN.
  // A private XDG cache: the host's ~/.cache (Claude's claude-cli-nodejs included) stays out of the sandbox.
  const box = nono ? `unset CLAUDE_CODE_OAUTH_TOKEN\nexport GH_CONFIG_DIR=${quote(wt)}.gh XDG_CACHE_HOME=${quote(join(tmp, "cache"))} TENDER_BUN=${quote(bun)}\n` : "";
  // systemd 258+ expands $$ and ${VAR} in a scope's argv (prompt, Stop hook); the flag exists only since 254. Dropped only when help works and lacks it.
  const expand = !systemd ? "" : `expand=--expand-environment=no; help=$(systemd-run --help 2>/dev/null) && [[ $help != *--expand-environment=* ]] && expand=\n`;
  const scope = !systemd ? [] : ["systemd-run", "--user", "--scope", "--quiet", "--collect", "$expand", "--unit", quote(unit), "--"];
  const vars = ports.length ? `export ${ports.map((p, i) => `TENDER_PORT_${i}=${p}`).join(" ")}\n` : "";
  const author = `export GIT_AUTHOR_NAME=${quote(`Tender ${agentLabel(l.agent, l.model)}`)} GIT_AUTHOR_EMAIL=tender@tender.invalid\n`;
  // From `/`, so bun reads no bunfig.toml or .env the agent wrote in the clone.
  const up = services ? `(cd / && exec ${quote(bun)} --no-env-file ${quote(join(tenderDir, "src/session/needs.ts"))} ${quote(services)}) || exit 1\n` : "";
  return `#!/usr/bin/env bash\ncd ${quote(wt)} || exit 1\nunset LINEAR_API_KEY\n${up}export TMPDIR=${quote(tmp)} TMP=${quote(tmp)} TEMP=${quote(tmp)}\n${vars}${box}${env}\n${author}${expand}exec ${[...scope, ...wrap, ...cmd].join(" ")}\n`;
}

/** Kills the session's scope, then its window, as for a canceled ticket; drops it from `wins`. */
export async function stopSession(cfg: Config, io: Io, key: string, id: string, wins: Map<string, string>) {
  await stopScope(cfg, io, key, id);
  const w = wins.get(winName(key, id));
  // Killing the scope usually closes the window first.
  if (w)
    await write(io, ["tmux", "kill-window", "-t", w]).catch((e) => {
      if (!/can't find window/.test(e.message)) throw e;
    });
  wins.delete(winName(key, id));
}

/** Window ids by name; `activity` is each window's last pane output in epoch seconds, as the tmux server saw it; `listed` only if every row parsed. */
export async function windows(cfg: Config, io: Io, secs?: number) {
  const r = await io.run(["tmux", "list-windows", "-t", `=${cfg.tmuxSession}`, "-F", "#{window_id} #{window_activity} #{window_name}"], undefined, secs);
  const m = new Map<string, string>();
  const activity = new Map<string, number>();
  let listed = r.code === 0;
  for (const l of listed ? r.out.split("\n").filter(Boolean) : []) {
    const [, id, at, name] = /^(@\d+) (\S*) (.*)$/.exec(l) ?? [];
    if (name === undefined) {
      listed = false;
      continue;
    }
    m.set(name, id!);
    activity.set(name, /^\d+$/.test(at!) ? Number(at) : NaN);
  }
  return Object.assign(m, { listed, activity });
}

export const winName = (key: string, id: string) => `${key}/${id}`;

/** Clones every allowlisted repo that has no clone yet and still resolves to itself; a failure is logged and retried at its next start. */
export async function cloneAll(cfg: Config, io: Io) {
  for (const r of Object.values(cfg.repos)) await cloned(cfg, io, r).catch((e) => io.log(`clone ${r.key} failed: ${e.message}`));
}

/** Clones `r` if it has no clone yet; false, not cloned, if GitHub now resolves it to another repo (logged by `canonical`). */
export async function cloned(cfg: Config, io: Io, r: Repo) {
  const name = existsSync(r.path) ? r.key : await canonical(io, r.key, true);
  if (!name) throw new Error(`${r.key}: GitHub lookup failed`);
  if (!sameRepo(name, r.key)) return false;
  await ensureClone(cfg, io, r);
  return true;
}

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

// An ancestor ~/.claude/CLAUDE.md counts as project memory once CLAUDE_CONFIG_DIR moves; its imports would block on a dialog.
const SESSION_PROJECT = { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true };

// Fresh per start, so nothing a session left there carries over. Account keys come from the host login's ~/.claude.json; trust goes on the session clone.
export function seedClaude(io: Io, dir: string, root: string) {
  const tpl = join(io.home, ".claude-tender");
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
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ ...pick(o, ACCOUNT), projects: { [root]: SESSION_PROJECT } }, null, 2), { mode: 0o600, flag: "wx" });
}

/** The ChatGPT login sessions copy, relative to home; only the host holds and uses its refresh token. */
export const CODEX_AUTH = ".codex-tender/auth.json";
const REFRESH_MARGIN = 24 * 3600_000;
// What an access-token ChatGPT login needs; API keys, PATs, Bedrock keys and anything newer stay on the host.
const LOGIN = ["auth_mode", "last_refresh"];
const TOKENS = ["id_token", "access_token", "account_id", "login_owner_id"];
// app-server's `account/read` with `refreshToken` forces a refresh. flock: two concurrent refreshes of a rotating token invalidate the login.
// A login changed while waiting ($2 is the content hash tender read) was already refreshed; app-server never holds the lock.
const REFRESH = [
  'export CODEX_HOME="$1"',
  'exec {L}<"$CODEX_HOME" && flock -w 30 "$L" || exit 1',
  'h=$(sha256sum <"$CODEX_HOME/auth.json" 2>/dev/null); [[ ${h%% *} == "$2" ]] || exit 0',
  'coproc APP { exec {L}<&- codex app-server 2>/dev/null; }',
  `printf '%s\\n' '{"method":"initialize","id":0,"params":{"clientInfo":{"name":"tender","version":"1"}}}' '{"method":"initialized"}' '{"method":"account/read","id":1,"params":{"refreshToken":true}}' >&"\${APP[1]}"`,
  `while IFS= read -r l <&"\${APP[0]}"; do [[ $l == '{"id":1,'* ]] && { exec {APP[1]}>&-; wait; exit 0; }; done`,
  "exit 1",
].join("\n");
// A content hash, not mtime: uutils `stat` rounds `%.9Y`, so a time stamp never matched there.
export const authStamp = (file: string) => (existsSync(file) ? new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex") : "");
export const codexRefresh = (home: string, seen: string) => ["bash", "-c", REFRESH, "tender-codex-refresh", join(home, ".codex-tender"), seen];

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
  const fix = `run \`CODEX_HOME=~/.codex-tender codex login\``;
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


/** Host-owned record, beside the session-writable dir, of the account, user and token hash `dir`'s login was last written with. */
export const codexAccount = (dir: string) => `${dir}-account`;
const MAX_AUTH = 64 * 1024;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A login's ChatGPT account and user (its id_token `sub`), or undefined without both: account_id alone is a shared workspace. */
export function codexIdentity(o: any) {
  let user: unknown;
  try {
    user = JSON.parse(Buffer.from(String(o.tokens.id_token).split(".")[1]!, "base64url").toString()).sub;
  } catch {}
  const account = o?.tokens?.account_id;
  return typeof account === "string" && account && typeof user === "string" && user ? { account, user } : undefined;
}

/** `dir`'s record when it is for `id`'s account and user. */
export function codexRecorded(dir: string, id: { account: string; user: string }) {
  try {
    const r = JSON.parse(readFileSync(codexAccount(dir), "utf8"));
    return r.account === id.account && r.user === id.user && typeof r.token === "string" ? (r as { token: string; prev?: string }) : undefined;
  } catch {
    return undefined;
  }
}

function record(dir: string, id: { account: string; user: string }, token: string, prev?: string) {
  writeFileSync(`${codexAccount(dir)}.tmp`, JSON.stringify({ ...id, token: sha(token), ...(prev && { prev }) }), { mode: 0o600 });
  renameSync(`${codexAccount(dir)}.tmp`, codexAccount(dir));
}

/** Rewrites a session's existing Codex `auth.json` with `login` when it still holds the token tender last wrote for the same account and user, keeping its `agent_identity`. */
export function refreshCodexCopy(io: Io, dir: string, login: string): "written" | "same" | "changed" | "skipped" {
  const next = JSON.parse(login);
  const id = codexIdentity(next);
  const rec = id && codexRecorded(dir, id);
  if (io.dry || !rec) return "skipped";
  try {
    // Pinned no-follow: the session can write `dir`, so every path below goes through the fd.
    return inDir(dir, (d) => {
      if (statSync(d).uid !== process.getuid!()) throw new Error("not owned by this user");
      const read = () => {
        const fd = openSync(`${d}/auth.json`, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
        try {
          const st = fstatSync(fd);
          if (!st.isFile() || st.nlink !== 1 || st.size > MAX_AUTH) throw new Error("auth.json must be a regular file with one link under 64 KiB");
          const buf = Buffer.alloc(MAX_AUTH + 1);
          return JSON.parse(buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0)));
        } catch (e) {
          if (e instanceof SyntaxError) return {};
          throw e;
        } finally {
          closeSync(fd);
        }
      };
      const old = read();
      const token = old?.tokens?.access_token;
      const hash = typeof token === "string" ? sha(token) : "";
      if (token === next.tokens.access_token) {
        if (rec.token !== hash) record(dir, id, token);
        return "same";
      }
      if (hash !== rec.token && hash !== rec.prev) return "changed";
      const tmp = `${d}/auth.json.tmp`;
      rmSync(tmp, { force: true });
      const out = openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
      try {
        writeFileSync(out, JSON.stringify({ ...next, ...(old.agent_identity && { agent_identity: old.agent_identity }) }));
      } finally {
        closeSync(out);
      }
      // First, so a crash after the rename still finds the new token recorded; prev covers a lost rename.
      record(dir, id, next.tokens.access_token, hash);
      // shortcut: a session `codex login` landing between this re-read and the rename is overwritten; Bun has no flock to take Codex's lock.
      if (read()?.tokens?.access_token !== token) {
        rmSync(tmp, { force: true });
        return "changed";
      }
      renameSync(tmp, `${d}/auth.json`);
      return "written";
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "skipped";
    throw e;
  }
}

/** A warning when the template config lacks tender's Codex state hooks, without which answers and PR feedback are never delivered. */
export function codexHooksWarning(home: string) {
  const file = join(home, ".codex-tender/config.toml");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  // Same rule as scripts/codex-hooks.sh: exactly one begin line, then exactly one end line.
  const marks = lines.flatMap((l) => (l === "# >>> tender state hooks (managed by scripts/codex-hooks.sh)" ? "b" : l === "# <<< tender state hooks" ? "e" : [])).join("");
  if (marks !== "be") return `${file} lacks tender's state hooks or their markers are damaged, so the session never reads idle and gets no answers or PR feedback: remove any damaged markers, then run \`scripts/codex-hooks.sh ~/.codex-tender/config.toml\``;
}

// Same as seedClaude; `login` is codexLogin's copy, the session's own credential.
export function seedCodex(io: Io, dir: string, login: string | undefined, root: string) {
  const tpl = join(io.home, ".codex-tender");
  io.log(`${io.dry ? "dry: " : ""}seed ${dir} from ${tpl}`);
  if (io.dry) return;
  rmSync(dir, { recursive: true, force: true });
  rmSync(codexAccount(dir), { force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of ["AGENTS.md", "skills"]) if (existsSync(join(tpl, f))) symlinkSync(realpathSync(join(tpl, f)), join(dir, f));
  // Copies, not links: Codex rewrites config.toml in place, and the template stays out of the sandbox.
  for (const f of ["config.toml", "hooks.json"]) if (existsSync(join(tpl, f))) copyFileSync(join(tpl, f), join(dir, f));
  if (login) writeFileSync(join(dir, "auth.json"), login, { mode: 0o600, flag: "wx" });
  const id = login ? codexIdentity(JSON.parse(login)) : undefined;
  if (id) record(dir, id, JSON.parse(login!).tokens.access_token);
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

// Shares the base clone's objects (--shared): the session never writes the base, and tender never prunes it (maintenance.auto=false, gc.pruneExpire=never).
async function cloneSession(io: Io, r: Session, wt: string, branch: string) {
  const old = await io.run([...GIT, "-C", r.path, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const url = (await read(io, [...GIT, "-C", r.path, "remote", "get-url", "origin"])).trim();
  const base = `refs/remotes/origin/${r.baseBranch}`;
  await write(io, [...GIT, "-C", r.path, "config", "gc.pruneExpire", "never"]);
  // Built beside wt and renamed, so a failed step never leaves a half-made clone to reuse; nothing else writes <ID>.tmp.
  const tmp = `${wt}.tmp`;
  if (!io.dry) rmSync(tmp, { recursive: true, force: true });
  try {
    // file:// only for this copy of tender's own clone; the session clone then pushes to the real origin.
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

// The whole config, so a type that switches provider never inherits the repo's model or effort.
const withAgent = (r: Session, a?: AgentConfig): Session => (a ? { ...r, agent: a.name, model: a.model, effort: a.effort } : r);

/** Starts a session for `t`; false, with one comment per commit, when the repo's config on its base branch is invalid. */
export async function start(cfg: Config, s: Source, host: Repo, t: Ticket, tr: Tracker, io: Io, tenderDir: string) {
  const dir = repoDir(cfg, host.key);
  await ensureClone(cfg, io, host);
  // Can be slow after downtime; per-poll fetches keep the 60 s default so one hang cannot stall a pass.
  const r = await loadSession(io, host, SLOW_SECS);
  if (!r) {
    const { sha } = configCache.get(host.key)!;
    const marker = join(cfg.workspaceRoot, ".invalid-config", host.key);
    if (existsSync(marker) && readFileSync(marker, "utf8") === sha) return false;
    // Marked before posting: a crash loses the comment rather than repeating it; a failed post is retried.
    put(io, marker, sha);
    try {
      await tr.comment(t, `not started: ${host.key}'s .tender/ at ${sha.slice(0, 12)} is invalid; run \`bun tender.ts check <repo> --config <tender.json>\` for details`);
    } catch (e) {
      remove(io, marker);
      throw e;
    }
    return false;
  }
  const body = t.body.length > MAX_BODY ? `${t.body.slice(0, MAX_BODY)}\n[truncated: read the full ticket at its URL]` : t.body;
  const type = typeFor(r.types, t.labels);
  const ses = withAgent(r, type.agent);
  const t0 = Date.now();
  const cs = await tr.comments(t, 0);
  const rerun = existsSync(join(dir, t.id)) || cs.some((c) => /^\s*(aw|tender): picked up on /i.test(c.body));
  const history = rerun ? historyFrame(cs, t.id, host.feedbackAuthors) : undefined;
  // Past every included operator comment, so none is re-sent as a message even when the tracker's clock is ahead.
  const seenAt = cs.filter(byOperator(host.feedbackAuthors)).reduce((m, c) => Math.max(m, Date.parse(c.createdAt) || 0), t0);
  await launch(cfg, io, ses, t.id, (vars) => (history ? render(RESTART, vars) : "") + render(promptFor(type), { ...vars, title: t.title, body, url: t.url }), tenderDir, s.name, type, history, seenAt);
  io.event?.("start", host.key, t.id, { agent: ses.agent, source: s.name });
  await claim(io, tr, join(dir, `${t.id}.claim`), t).catch((e) => io.log(`${t.id}: claim failed, session left running and the claim retried next poll: ${e.message}`));
  return true;
}

const RESTART = "You are restarting ticket {{id}}: an earlier session worked on it. Before changing anything, read `.tender/run/history.md` and the rest of `.tender/run/`, `git status`, `git log origin/{{base}}..HEAD`, `origin/{{branch}}` after `git fetch origin` (continue from it if it holds earlier work) and the PR for branch {{branch}} (`gh api 'repos/{{repo}}/pulls?head={{owner}}:{{branch}}&state=all'`) if there is one, then do the task below from where it stands.\n\n";

const CONTINUE = "You are taking ticket {{id}} back after a human worked on it outside tender. Before changing anything, read `git status`, `git log origin/{{base}}..HEAD`, the PR for branch {{branch}} (`gh api 'repos/{{repo}}/pulls?head={{owner}}:{{branch}}&state=all'`) if there is one, and `.tender/run/`, then finish the task below from where it stands. Open the PR by writing `.tender/run/pr.md` (first line the title, the rest the body); `gh pr create` is not available.\n\n";

const RELAUNCH = "Your earlier session on ticket {{id}} ended while its PR had feedback waiting. Before changing anything, read `.tender/run/feedback.md`, `git status`, `git log origin/{{base}}..HEAD` and the PR for branch {{branch}} (`gh api 'repos/{{repo}}/pulls?head={{owner}}:{{branch}}&state=all'`), then address the feedback and push; the original task follows.\n\n";

/** Starts a new session in `<ID>`'s existing clone after a hand-off, with the original prompt behind a continue note. */
export const resume = (cfg: Config, io: Io, target: { key: string; id: string }, tenderDir: string) => passLocked(cfg, io.log, () => resumeLocked(cfg, io, target, tenderDir));

async function resumeLocked(cfg: Config, io: Io, { key, id }: { key: string; id: string }, tenderDir: string) {
  const dir = repoDir(cfg, key);
  const host = Object.hasOwn(cfg.repos, key) ? cfg.repos[key]! : undefined;
  if (!host) throw new Error(`${key} is not in tender.json`);
  if (!handedOff(dir, id)) throw new Error(`${key}/${id} is not handed off`);
  if (existsSync(join(dir, `${id}.ended`))) throw new Error(`${key}/${id} ended (canceled or reassigned) while handed off; not resumed`);
  const wins = await windows(cfg, io);
  if (!wins.listed) throw new Error("tmux windows unknown; not resumed");
  if (wins.has(winName(key, id))) throw new Error(`${key}/${id} already has a tmux window`);
  const r = await loadSession(io, host, SLOW_SECS);
  if (!r) throw new Error(`${key}'s .tender/ on its base branch is invalid; run \`bun tender.ts check <repo> --config <tender.json>\` for details`);
  await again(cfg, io, r, id, CONTINUE, tenderDir);
  remove(io, join(dir, `${id}.handoff`));
}

/** Starts a new session in `<ID>`'s existing clone whose window is gone, with `feedback` as `.tender/run/feedback.md` and the original prompt behind a relaunch note. */
export const relaunch = (cfg: Config, io: Io, r: Session, id: string, tenderDir: string, feedback: string) => again(cfg, io, r, id, RELAUNCH, tenderDir, feedback);

async function again(cfg: Config, io: Io, r: Session, id: string, note: string, tenderDir: string, feedback?: string) {
  const dir = repoDir(cfg, r.key);
  const old = readFileSync(join(dir, `${id}.prompt.md`), "utf8");
  await launch(cfg, io, withAgent(r, recordedAgentConfig(dir, id)), id, (vars) => {
    const notes = [CONTINUE, RELAUNCH].map((n) => render(n, vars));
    let task = old;
    let head: string | undefined;
    while ((head = notes.find((n) => task.startsWith(n)))) task = task.slice(head.length);
    return render(note, vars) + task;
  }, tenderDir, undefined, undefined, undefined, undefined, feedback);
}

export const handedOff = (dir: string, id: string) => existsSync(join(dir, `${id}.handoff`));

// `source` marks a fresh start: it records the owner, clears the end markers and the last question, starts the message cursor at `seenAt`, writes `history` on a restart and `<ID>.claim` for the caller's claim; `feedback` becomes `.tender/run/feedback.md`.
async function launch(cfg: Config, io: Io, r: Session, id: string, prompt: (vars: Record<string, string>) => string, tenderDir: string, source?: string, type?: TaskType, history?: string, seenAt = Date.now(), feedback?: string) {
  const dir = repoDir(cfg, r.key);
  const wt = join(dir, id);
  const branch = `agent/${id}`;
  const promptFile = join(dir, `${id}.prompt.md`);
  const script = join(dir, `${id}.sh`);
  const nono = r.sandbox === "nono";
  const text = prompt({ id, branch, base: r.baseBranch, verify: "the project's checks (find how they run: README, CI config, package or build files)", repo: r.key, owner: r.key.slice(0, r.key.indexOf("/")) });
  const kib = Buffer.byteLength(text) / 1024;
  if (kib > MAX_PROMPT_KIB) throw new Error(`${id}: prompt is ${Math.ceil(kib)} KiB, over ${MAX_PROMPT_KIB} KiB`);
  const token = join(io.home, CLAUDE_TOKEN);
  // An empty CLAUDE_CODE_OAUTH_TOKEN reads as unset, so the session would start logged out.
  if (r.agent === "claude" && !nono && !(existsSync(token) && readFileSync(token, "utf8").trim())) throw new Error(`${token} is missing or empty: run \`claude setup-token\` and save the token it prints there (chmod 600)`);
  const warn = r.agent === "claude" && nono ? checkLogin(readLogin(io.home), Date.now()) : undefined;
  if (warn) io.log(warn);
  const needsFile = join(dir, `${id}.needs`);
  // A fresh start gets new ports; a resume keeps the ones its session already had.
  if (source !== undefined) remove(io, needsFile);
  const want = type?.needs;
  const needs: { ports: number[]; compose?: string } | undefined = source === undefined ? (existsSync(needsFile) ? JSON.parse(readFileSync(needsFile, "utf8")) : undefined) : want && { ports: allocatePorts(cfg, want.ports), ...(want.compose && { compose: want.compose }) };
  const ports = needs?.ports ?? [];
  if (ports.length && nono) requireLandlock();
  if (needs?.compose && !r.baseSha) throw new Error(`${id}: no base commit to read ${needs.compose} from`);
  const bun = nono || needs?.compose ? findBun([cfg.workspaceRoot]) : "";
  // No window means any scope left under this name is a stale session, still writing the clone it is about to share.
  await stopScope(cfg, io, r.key, id);
  // Claude sessions run Codex only as a helper, so a missing Codex login does not stop them.
  const login = r.agent === "codex" ? await codexLogin(io) : await codexLogin(io).catch(() => undefined);
  const noHooks = r.agent === "codex" ? codexHooksWarning(io.home) : undefined;
  if (noHooks) io.log(noHooks);
  const long = socketWarning(tmpHome(wt));
  if (long) io.log(long);
  io.log(`${io.dry ? "dry: " : ""}mkdir ${tmpHome(wt)}`);
  if (!io.dry) {
    rmSync(tmpHome(wt), { recursive: true, force: true });
    mkdirSync(join(tmpHome(wt), "cache"), { recursive: true, mode: 0o700 });
  }
  if (existsSync(wt)) io.log(`reuse ${wt}`);
  else await cloneSession(io, r, wt, branch);
  // After the clone: a lone `<ID>.source` would route a Linear ticket to this repo with nothing to clean it up.
  if (source !== undefined) {
    put(io, join(dir, `${id}.source`), source);
    remove(io, join(dir, `${id}.ended`));
    remove(io, join(dir, `${id}.reassigned`));
    remove(io, join(dir, `${id}.question`));
    remove(io, join(dir, `${id}.prfile`));
    put(io, join(dir, `${id}.steer`), JSON.stringify({ seenAt }));
  }
  put(io, join(dir, `${id}.agent`), r.model || r.effort ? JSON.stringify({ name: r.agent, model: r.model, effort: r.effort }) : r.agent);
  if (type) put(io, join(dir, `${id}.type`), JSON.stringify({ name: type.name, instructions: type.instructions }));
  if (needs) put(io, needsFile, JSON.stringify(needs));
  const services = needs?.compose ? join(dir, `${id}.compose`) : undefined;
  if (services) put(io, join(services, "job.json"), JSON.stringify({ project: composeProject(cfg, r.key, id), repo: r.path, sha: r.baseSha!, file: needs!.compose!, ports } satisfies ComposeJob));
  const root = existsSync(wt) ? realpathSync(wt) : wt;
  seedCodex(io, codexHome(wt), login, root);
  if (r.agent === "claude" || nono) seedClaude(io, claudeHome(wt), root);
  io.log(`${io.dry ? "dry: " : ""}write ${join(wt, ".tender", "run", ".gitignore")}`);
  if (source !== undefined && history) io.log(`${io.dry ? "dry: " : ""}write ${join(wt, ".tender", "run", "history.md")}`);
  if (feedback !== undefined) io.log(`${io.dry ? "dry: " : ""}write ${join(wt, ".tender", "run", "feedback.md")}`);
  if (!io.dry) {
    mkdirSync(join(wt, ".tender"), { recursive: true });
    inDir(join(wt, ".tender"), (d) => mkdirSync(`${d}/run`, { recursive: true }));
    // Unlink + exclusive create: never write through a symlink or hardlink the agent left there.
    inRun(wt, (d) => (rmSync(`${d}/.gitignore`, { force: true }), writeFileSync(`${d}/.gitignore`, "*\n", { flag: "wx" })));
    // The last run's question was never asked by this session; its answer would be delivered to it.
    if (source !== undefined) inRun(wt, (d) => ["question.md", "answer.md", "message.md", "history.md", "pr.md"].forEach((f) => rmSync(`${d}/${f}`, { recursive: true, force: true })));
    if (source !== undefined && history) writeRun(wt, "history.md", history);
    if (feedback !== undefined) writeRun(wt, "feedback.md", feedback);
  }
  put(io, promptFile, text);
  put(io, script, launcher(r, wt, promptFile, scopeUnit(cfg, r.key, id), tenderDir, bun, ports, services), 0o755);
  // Claimed last, so a failed start leaves the ticket ready; `<ID>.claim` goes first, so a claim lost to an error or a crash is retried while the window lives.
  if (source !== undefined) put(io, join(dir, `${id}.claim`), new Date().toISOString());
  await write(io, ["tmux", "new-window", "-d", "-t", `=${cfg.tmuxSession}:`, "-n", winName(r.key, id), script]);
}

/** Claims a started session's ticket; `<ID>.claim` marks it unclaimed until the claim succeeds. */
export async function claim(io: Io, tr: Tracker, file: string, t: Ticket) {
  await tr.claim(t);
  io.event?.("claim", t.repo!, t.id);
  remove(io, file);
}
