import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURE_COMMAND, cached, checkLogin, CREDENTIALS, findClaude, hostExe, needsRefresh, readLogin, refresher } from "../src/claude-auth";
import { AW_DIR } from "../src/util";

let t: string;
beforeEach(() => (t = realpathSync(mkdtempSync(join(tmpdir(), "aw-auth-")))));
afterEach(() => rmSync(t, { recursive: true, force: true }));

const BUN = realpathSync(process.execPath);
const TOKEN = "sk-ant-oat01-Real_token.value-1";
const DECOY = "sk-ant-oat01-DECOY";
const NOW = Date.now();
const LATER = NOW + 3_600_000;

function file(path: string, text: string, mode = 0o644) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, { mode });
  return path;
}
const creds = (home: string, text: string) => file(join(home, CREDENTIALS), text);
const login = (o: object) => JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", scopes: ["user:inference"], ...o } });

test("hostExe returns the realpath and rejects mise wrappers and session-writable paths", () => {
  const bin = file(join(t, "installs/claude/2.1/claude"), "", 0o755);
  symlinkSync(join(t, "installs/claude/2.1"), join(t, "installs/claude/latest"));
  expect(hostExe("claude", join(t, "installs/claude/latest/claude"), [join(t, "ws")])).toBe(bin);
  expect(() => hostExe("claude", null, [])).toThrow("claude: not found");
  expect(() => hostExe("claude", join(t, "gone"), [])).toThrow();
  expect(() => hostExe("claude", file(join(t, "mise/command-wrappers/bin/claude"), ""), [])).toThrow("mise wrapper");
  expect(() => hostExe("bun", file(join(t, "mise/shims/bun"), ""), [])).toThrow("mise wrapper");
  symlinkSync(file(join(t, "usr/bin/mise"), ""), join(t, "claude"));
  expect(() => hostExe("claude", join(t, "claude"), [])).toThrow("mise wrapper");
  const ws = file(join(t, "ws/owner/repo/ID/claude"), "");
  expect(() => hostExe("claude", ws, [join(t, "ws")])).toThrow("sessions can write");
  symlinkSync(join(t, "ws"), join(t, "ws-link"));
  expect(() => hostExe("claude", ws, [join(t, "ws-link")])).toThrow("sessions can write");
  symlinkSync(bin, join(t, "ws/claude"));
  expect(() => hostExe("claude", join(t, "ws/claude"), [join(t, "ws")])).toThrow("sessions can write");
});

test("findClaude asks mise from aw's dir when mise exists, else PATH", async () => {
  const bin = file(join(t, "claude"), "", 0o755);
  const calls: [string[], string | undefined][] = [];
  const run = async (argv: string[], cwd?: string) => (calls.push([argv, cwd]), { code: 0, out: `${bin}\n`, err: "" });
  expect(await findClaude(run, [], (c) => (c === "mise" ? "/usr/bin/mise" : null))).toBe(bin);
  expect(calls).toEqual([[["mise", "which", "claude"], AW_DIR]]);
  expect(await findClaude(run, [], (c) => (c === "claude" ? bin : null))).toBe(bin);
  expect(calls).toHaveLength(1);
  const fail = async () => ({ code: 1, out: "", err: "" });
  await expect(findClaude(fail, [], (c) => (c === "mise" ? "/usr/bin/mise" : file(join(t, "mise/command-wrappers/bin/claude"), "")))).rejects.toThrow("mise wrapper");
});

test("cached resolves again only once the path is gone", async () => {
  const bin = file(join(t, "claude"), "");
  let n = 0;
  const get = cached(async () => (n++, bin));
  await get();
  await get();
  expect(n).toBe(1);
  unlinkSync(bin);
  await get();
  expect(n).toBe(2);
});

test("readLogin keeps metadata only and hides parse errors", () => {
  expect(readLogin(t)).toBeUndefined();
  creds(t, login({ expiresAt: 5, refreshTokenExpiresAt: "9" }));
  expect(readLogin(t)).toEqual({ expiresAt: 5, refreshTokenExpiresAt: undefined, scopes: ["user:inference"], refreshToken: true });
  creds(t, `{"claudeAiOauth":{"accessToken":"${TOKEN}"`);
  expect(() => readLogin(t)).toThrow(/^(?!.*sk-ant).*not JSON$/);
  creds(t, "[1]");
  expect(readLogin(t)).toEqual({ expiresAt: undefined, refreshTokenExpiresAt: undefined, scopes: [], refreshToken: false });
});

test("needsRefresh inside the 5-minute window only", () => {
  expect(needsRefresh(NOW + 299_999, NOW)).toBe(true);
  expect(needsRefresh(NOW - 1, NOW)).toBe(true);
  expect(needsRefresh(NOW + 300_000, NOW)).toBe(false);
});

test("checkLogin fails or warns per the preflight rules", () => {
  const ok = { expiresAt: 1, refreshToken: true, scopes: ["user:inference"], refreshTokenExpiresAt: NOW + 4 * 86_400_000 };
  expect(checkLogin(ok, NOW)).toBeUndefined();
  expect(() => checkLogin(undefined, NOW)).toThrow("missing: run `claude auth login`");
  expect(() => checkLogin({ ...ok, refreshToken: false }, NOW)).toThrow("no refresh token");
  expect(() => checkLogin({ ...ok, expiresAt: undefined }, NOW)).toThrow("no valid expiresAt");
  expect(() => checkLogin({ ...ok, scopes: ["user:profile"] }, NOW)).toThrow("user:inference");
  expect(() => checkLogin({ ...ok, refreshTokenExpiresAt: NOW }, NOW)).toThrow("time limit");
  expect(checkLogin({ ...ok, refreshTokenExpiresAt: undefined }, NOW)).toContain("unknown");
  expect(checkLogin({ ...ok, refreshTokenExpiresAt: NOW + 2 * 86_400_000 }, NOW)).toContain("ends in 48h");
});

function fakeClaude(code: number, writes?: string, secs = 0) {
  const out = join(t, "calls");
  mkdirSync(out, { recursive: true });
  const next = writes ? file(join(t, "next.json"), writes) : "";
  const body = `#!/bin/sh\n{ env; echo ---; echo "cwd=$(pwd)"; printf 'arg=%s\\n' "$@"; } > ${out}/$$\nsleep ${secs}\n${next ? `cp ${next} "$HOME/${CREDENTIALS}"\n` : ""}exit ${code}\n`;
  return file(join(t, "bin/claude"), body, 0o755);
}
const calls = () => (existsSync(join(t, "calls")) ? readdirSync(join(t, "calls")).map((f) => readFileSync(join(t, "calls", f), "utf8")) : []);

test("refresher spawns only inside the window, with a clean env, aw's cwd and the hardened flags", async () => {
  const home = join(t, "home");
  const logs: string[] = [];
  const bin = fakeClaude(0, login({ expiresAt: NOW + 8 * 3_600_000 }));
  process.env.CLAUDE_CONFIG_DIR_LEAK = "1";
  creds(home, login({ expiresAt: LATER }));
  await refresher(async () => bin, home, (m) => logs.push(m), () => NOW)();
  expect(calls()).toEqual([]);
  creds(home, login({ expiresAt: NOW + 60_000 }));
  await refresher(async () => bin, home, (m) => logs.push(m), () => NOW)();
  delete process.env.CLAUDE_CONFIG_DIR_LEAK;
  const [call] = calls();
  const env = call!.split("\n---\n")[0]!.split("\n").filter((l) => !/^(PWD|SHLVL|_|OLDPWD)=/.test(l));
  expect(env).toEqual([`HOME=${home}`, "PATH=/usr/local/bin:/usr/bin:/bin"]);
  expect(call).toContain(`cwd=${AW_DIR}\n`);
  expect(call!.split("\n").filter((l) => l.startsWith("arg="))).toEqual(["arg=-p", "arg=/cost", "arg=--safe-mode", "arg=--setting-sources", "arg=", "arg=--strict-mcp-config", "arg=--no-session-persistence"]);
  expect(logs).toEqual(["claude login refresh ok, exit 0"]);
});

test("refresher logs unchanged and failed, and runs one refresh at a time", async () => {
  const home = join(t, "home");
  const logs: string[] = [];
  creds(home, login({ expiresAt: NOW }));
  await refresher(async () => fakeClaude(0), home, (m) => logs.push(m), () => NOW)();
  await refresher(async () => fakeClaude(3), home, (m) => logs.push(m), () => NOW)();
  await refresher(async () => join(t, "missing"), home, (m) => logs.push(m), () => NOW)();
  expect(logs).toEqual(["claude login refresh unchanged, exit 0", "claude login refresh failed, exit 3", "claude login refresh failed, exit 127"]);
  rmSync(join(t, "calls"), { recursive: true });
  const check = refresher(async () => fakeClaude(0, undefined, 0.3), home, () => {}, () => NOW);
  const a = check();
  expect(check()).toBe(a);
  await a;
  await check();
  expect(calls()).toHaveLength(2);
});

test("refresher logs a throw, never rejects, and runs again after it", async () => {
  const home = join(t, "home");
  const logs: string[] = [];
  creds(home, login({ expiresAt: NOW }));
  let first = true;
  const bin = fakeClaude(0);
  const check = refresher(async () => (first ? ((first = false), Promise.reject(new Error("claude: not found"))) : bin), home, (m) => logs.push(m), () => NOW);
  await check();
  await check();
  creds(home, "{");
  await check();
  expect(logs).toEqual(["claude login refresh failed: claude: not found", "claude login refresh unchanged, exit 0", `claude login refresh failed: ${join(home, CREDENTIALS)} is unreadable or not JSON`]);
  expect(calls()).toHaveLength(1);
});

// The ticket's cwd, PATH and env as nono hands them to the capture: a clone with a bunfig preload, a .env and planted binaries.
function hostile() {
  const home = join(t, "home");
  const clone = join(t, "clone");
  const marker = join(t, "PWNED");
  const evil = file(join(clone, "evil.ts"), `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x"); console.log("PRELOAD-RAN");`);
  file(join(clone, "bunfig.toml"), `preload = ["./evil.ts"]\n`);
  file(join(clone, ".env"), "AW_DOTENV=loaded\n");
  for (const b of ["bun", "env", "sh"]) file(join(clone, b), `#!/bin/sh\necho x >> ${marker}\n`, 0o755);
  const env = { HOME: home, PATH: clone, BUN_OPTIONS: `--preload ${evil}`, AW_BUN: BUN, CLAUDE_CONFIG_DIR: join(t, "ticket.claude") };
  return { home, clone, marker, env };
}

async function capture(text: string | undefined) {
  const h = hostile();
  if (text !== undefined) creds(h.home, text);
  const p = Bun.spawn(CAPTURE_COMMAND, { cwd: h.clone, env: h.env, stdio: ["ignore", "pipe", "pipe"] });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code, ran: existsSync(h.marker) };
}

const oauth = (o: object) => ({ accessToken: TOKEN, refreshToken: "r", expiresAt: LATER, ...o });

test.each([
  ["compact", JSON.stringify({ claudeAiOauth: oauth({}) })],
  ["pretty-printed", JSON.stringify({ claudeAiOauth: oauth({}) }, null, 2)],
  ["an mcpOAuth decoy listed first", JSON.stringify({ mcpOAuth: { s: { claudeAiOauth: oauth({ accessToken: DECOY }), accessToken: DECOY, expiresAt: LATER } }, claudeAiOauth: oauth({}) })],
  ["a decoy nested in the entry next to its own token", JSON.stringify({ claudeAiOauth: { nested: oauth({ accessToken: DECOY }), ...oauth({}) } })],
])("capture prints the root token: %s", async (_, text) => {
  expect(await capture(text)).toEqual({ out: TOKEN, err: "", code: 0, ran: false });
});

test.each([
  ["expired", JSON.stringify({ claudeAiOauth: oauth({ expiresAt: NOW - 1 }) })],
  ["within 30 s of expiry", JSON.stringify({ claudeAiOauth: oauth({ expiresAt: NOW + 20_000 }) })],
  ["no root accessToken, decoy only in mcpOAuth", JSON.stringify({ mcpOAuth: { s: { accessToken: DECOY, expiresAt: LATER } } })],
  ["claudeAiOauth only nested under mcpOAuth", JSON.stringify({ mcpOAuth: { s: { claudeAiOauth: oauth({ accessToken: DECOY }) } } })],
  ["a decoy nested in the entry, no token of its own", JSON.stringify({ claudeAiOauth: { nested: oauth({ accessToken: DECOY }), expiresAt: LATER } })],
  ["expiresAt 9999999999999e-20", `{"claudeAiOauth":{"accessToken":"${TOKEN}","expiresAt":9999999999999e-20}}`],
  ["expiresAt as a string", JSON.stringify({ claudeAiOauth: oauth({ expiresAt: String(LATER) }) })],
  ["a root array", JSON.stringify([{ claudeAiOauth: oauth({}) }])],
  ["truncated JSON", JSON.stringify({ claudeAiOauth: oauth({}) }).slice(0, -5)],
  ["a token with a shell metacharacter", JSON.stringify({ claudeAiOauth: oauth({ accessToken: `${TOKEN};id` }) })],
  ["a missing file", undefined],
])("capture exits 1 with no output: %s", async (_, text) => {
  expect(await capture(text)).toEqual({ out: "", err: "", code: 1, ran: false });
});

test("control: plain bun -e in the clone runs its preload and loads its .env", async () => {
  const h = hostile();
  const p = Bun.spawn([BUN, "-e", "console.log(process.env.AW_DOTENV)"], { cwd: h.clone, env: { HOME: h.home, PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "ignore"] });
  expect(await new Response(p.stdout).text()).toBe("PRELOAD-RAN\nloaded\n");
});
