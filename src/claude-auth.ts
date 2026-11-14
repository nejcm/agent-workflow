import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { Io, Run } from "./types";
import { AW_DIR, nonEmpty } from "./util";

/** The host login aw keeps fresh, relative to home. */
export const CREDENTIALS = ".claude/.credentials.json";
const WINDOW_MS = 300_000;
const DAY_MS = 86_400_000;

const CAPTURE_JS =
  'try{const f=require("node:fs"),d=process.env.HOME+"/.claude/",w=Date.now()+3000;while(f.existsSync(d+".oauth_refresh.lock")&&Date.now()<w)Bun.sleepSync(50);const c=JSON.parse(f.readFileSync(d+".credentials.json","utf8"));const o=c!==null&&typeof c==="object"&&!Array.isArray(c)&&Object.hasOwn(c,"claudeAiOauth")?c.claudeAiOauth:null;const t=o?.accessToken,e=o?.expiresAt;if(typeof t==="string"&&/^[A-Za-z0-9._-]+$/.test(t)&&Number.isSafeInteger(e)&&e>Date.now()+30000){process.stdout.write(t);process.exit(0)}}catch{}process.exit(1)';
/** nono's capture for the anthropic_oauth route, exactly as in the profiles; -p skips bash env imports, the lock wait a rotation in flight. */
export const CAPTURE_COMMAND = ["/bin/sh", "-p", "-c", 'cd / && exec /usr/bin/env -i HOME="$HOME" "$AW_BUN" --no-env-file -e "$1"', "sh", CAPTURE_JS];

const WRAPPER = /\/mise\/(shims|command-wrappers)\//;
const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
const writableBy = (paths: string[], writable: string[]) => paths.some((p) => writable.flatMap((w) => [w, real(w)]).some((w) => under(p, w)));

/** realpath of an executable aw runs on the host; throws for a mise wrapper or a path sessions can write. */
export function hostExe(name: string, path: string | null | undefined, writable: string[]) {
  if (!path) throw new Error(`${name}: not found`);
  const r = realpathSync(path);
  if ([path, r].some((p) => WRAPPER.test(p)) || writableBy([path, r], writable) || basename(r) === "mise") throw new Error(`${name}: ${path} resolves to ${r}, a mise wrapper or a path sessions can write`);
  return r;
}

/** The real Claude executable: `mise which` when mise exists, else PATH. */
export async function findClaude(run: Run, writable: string[], which: (cmd: string) => string | null = Bun.which) {
  const viaMise = which("mise") ? await run(["mise", "which", "claude"], AW_DIR) : undefined;
  return hostExe("claude", viaMise?.code === 0 ? viaMise.out.trim() : which("claude"), writable);
}

export const findBun = (writable: string[]) => hostExe("bun", process.execPath, writable);

/** Caches `find`, resolving again once the path is gone (a Claude upgrade removes the old version dir). */
export function cached(find: () => Promise<string>) {
  let path: string | undefined;
  return async () => (path && existsSync(path) ? path : (path = await find()));
}

export interface Login {
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  scopes: unknown[];
  refreshToken: boolean;
}

const int = (v: unknown) => (Number.isSafeInteger(v) ? (v as number) : undefined);

/** Expiry and scope metadata of the host login, never its tokens; undefined if the file is missing. */
export function readLogin(home: string): Login | undefined {
  const file = join(home, CREDENTIALS);
  let c: any;
  try {
    c = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    // A parse error can quote the file, tokens included.
    throw new Error(`${file} is unreadable or not JSON`);
  }
  const o = c?.claudeAiOauth;
  return { expiresAt: int(o?.expiresAt), refreshTokenExpiresAt: int(o?.refreshTokenExpiresAt), scopes: Array.isArray(o?.scopes) ? o.scopes : [], refreshToken: nonEmpty(o?.refreshToken) };
}

/** Claude refreshes only inside its own 5-minute window. */
export const needsRefresh = (expiresAt: number, now: number) => expiresAt - now < WINDOW_MS;

/** Throws for a login sessions cannot use; returns a warning for one that may soon need `claude auth login`. */
export function checkLogin(l: Login | undefined, now: number): string | undefined {
  const fix = "run `claude auth login`";
  if (!l) throw new Error(`~/${CREDENTIALS} is missing: ${fix}`);
  if (!l.refreshToken) throw new Error(`the Claude login has no refresh token: ${fix}`);
  if (!l.scopes.includes("user:inference")) throw new Error(`the Claude login lacks the user:inference scope: ${fix}`);
  if (l.expiresAt === undefined) throw new Error(`the Claude login has no valid expiresAt: ${fix}`);
  if (l.refreshTokenExpiresAt === undefined) return `the Claude login's time limit is unknown; if sessions start failing, ${fix}`;
  const left = l.refreshTokenExpiresAt - now;
  if (left <= 0) throw new Error(`the Claude login reached its time limit: ${fix}`);
  if (left < 3 * DAY_MS) return `the Claude login ends in ${Math.floor(left / 3_600_000)}h: ${fix} before then`;
}

const REFRESH = ["-p", "/cost", "--safe-mode", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence"];

/** A single-flight check that runs Claude's own refresh of the host login inside its window, with a clean env. */
export function refresher(claude: () => Promise<string>, home: string, log: (msg: string) => void, now = Date.now) {
  let inFlight: Promise<void> | undefined;
  let ended = false;
  const check = async () => {
    const l = readLogin(home);
    const before = l?.expiresAt;
    if (before === undefined || !needsRefresh(before, now())) return;
    const over = l!.refreshTokenExpiresAt !== undefined && l!.refreshTokenExpiresAt <= now();
    if (over && !ended) log("claude login reached its time limit, not refreshing: run `claude auth login`");
    if ((ended = over)) return;
    // timeout kills the whole child group and still fires if aw dies.
    const argv = ["/usr/bin/timeout", "-k", "5", "60", await claude(), ...REFRESH];
    const code = await Bun.spawn(argv, { cwd: AW_DIR, env: { HOME: home, PATH: "/usr/local/bin:/usr/bin:/bin" }, stdio: ["ignore", "ignore", "ignore"] }).exited;
    const after = readLogin(home)?.expiresAt ?? 0;
    log(`claude login refresh ${after > before ? "ok" : code === 0 ? "unchanged" : "failed"}, exit ${code}`);
  };
  return () => (inFlight ??= check()
    .catch((e) => log(`claude login refresh failed: ${e.message}`))
    .finally(() => (inFlight = undefined)));
}

/** Startup check for nono lanes: throws for an unsafe host, only logs login problems; unless dry, runs one refresh check and returns it for a timer. */
export async function hostLogin(io: Io, writable: string[], now = Date.now, find = findClaude) {
  // The refresh runs with aw's dir as cwd, and Claude reads that dir's settings and git config.
  if (writableBy([AW_DIR, real(AW_DIR)], writable)) throw new Error(`aw's dir ${AW_DIR} is under a path sessions can write`);
  findBun(writable);
  const login = readLogin(io.home);
  try {
    const warn = checkLogin(login, now());
    if (warn) io.log(warn);
  } catch (e) {
    io.log((e as Error).message);
  }
  if (io.dry) return void io.log("dry: refresh the claude login when it expires within 5 minutes");
  const claude = cached(() => find(io.run, writable));
  // Without a login, Codex-only hosts may have no claude at all; the refresher resolves it once a login appears.
  if (login) await claude();
  const check = refresher(claude, io.home, io.log, now);
  await check();
  return check;
}
