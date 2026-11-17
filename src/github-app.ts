import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Run } from "./types";

export type AppConfig = { appId: number; installationId: number; privateKeyFile: string };
export type GitHubApp = { token(): Promise<string>; login(): Promise<string> };

/** What tender's host `gh` calls and the sessions' push and `gh pr create` need; see docs/setup.md#github-app. */
export const APP_PERMISSIONS = { metadata: "read", contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "read", actions: "read" };
// nono caches the captured token for 900 s (cache_ttl_secs), so the file must never hold one that expires sooner.
export const REFRESH_MS = 20 * 60_000;

export const appTokenFile = (workspaceRoot: string) => join(workspaceRoot, ".github-app-token");

const b64url = (b: ArrayBuffer | string) => Buffer.from(typeof b === "string" ? b : new Uint8Array(b)).toString("base64url");
const len = (n: number) => (n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]);
const der = (tag: number, body: number[] | Uint8Array) => [tag, ...len(body.length), ...body];
// PrivateKeyInfo's version 0 and AlgorithmIdentifier { rsaEncryption, NULL }, which PKCS#1 lacks.
const RSA_ALG = [0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];

/** A signing key from a PKCS#8 or PKCS#1 (GitHub's download) PEM. */
export function importKey(pem: string) {
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END \1?PRIVATE KEY-----/.exec(pem);
  if (!m) throw new Error(`not a "PRIVATE KEY" or "RSA PRIVATE KEY" PEM`);
  const raw = Buffer.from(m[2]!.replace(/\s/g, ""), "base64");
  const pkcs8 = m[1] ? Uint8Array.from(der(0x30, [...RSA_ALG, ...der(0x04, raw)])) : raw;
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

/** The App's RS256 JWT, backdated 60 s for clock drift and valid for GitHub's 10-minute maximum. */
export async function appJwt(appId: number, key: CryptoKey, now = Date.now()) {
  const iat = Math.floor(now / 1000) - 60;
  const body = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat, exp: iat + 600, iss: appId }))}`;
  return `${body}.${b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body)))}`;
}

/** Installation tokens for `repos` (one owner), reused until REFRESH_MS before expiry; each new one also goes to `tokenFile` (0600) for nono. */
export function githubApp(c: AppConfig, repos: string[], fetch: typeof globalThis.fetch, tokenFile?: string, now = Date.now): GitHubApp {
  let cached: { token: string; expires: number } | undefined;
  let pending: Promise<string> | undefined;
  let login: Promise<string> | undefined;
  const api = async (path: string, body?: object) => {
    const jwt = await appJwt(c.appId, await importKey(readFileSync(c.privateKeyFile, "utf8")), now());
    const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${jwt}`, "x-github-api-version": "2022-11-28", ...(body && { "content-type": "application/json" }) };
    const r = await fetch(`https://api.github.com${path}`, { method: body ? "POST" : "GET", headers, ...(body && { body: JSON.stringify(body) }) });
    const text = await r.text();
    if (!r.ok) throw new Error(`github app ${path}: ${r.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  const mint = async () => {
    const r = await api(`/app/installations/${c.installationId}/access_tokens`, { repositories: repos.map((k) => k.slice(k.indexOf("/") + 1)), permissions: APP_PERMISSIONS });
    const expires = Date.parse(r?.expires_at);
    // Opaque (classic ghs_… or a dotted JWT); only checked to be safe in a file, an env var and a header.
    if (typeof r?.token !== "string" || !/^[\w.-]+$/.test(r.token) || !Number.isFinite(expires)) throw new Error("github app: unexpected access_tokens response");
    if (tokenFile) {
      const tmp = `${tokenFile}.${process.pid}`;
      rmSync(tmp, { force: true });
      writeFileSync(tmp, r.token, { mode: 0o600, flag: "wx" });
      renameSync(tmp, tokenFile);
    }
    cached = { token: r.token, expires };
    return r.token as string;
  };
  return {
    token: () => (cached && cached.expires - now() > REFRESH_MS ? Promise.resolve(cached.token) : (pending ??= mint().finally(() => (pending = undefined)))),
    login: () =>
      (login ??= api("/app").then((a) => {
        if (typeof a?.slug !== "string" || !a.slug) throw new Error("github app: GET /app returned no slug");
        return `${a.slug}[bot]`.toLowerCase();
      })),
  };
}

const usesGh = (argv: string[]) => argv[0] === "gh" || (/^(ba)?sh$/.test(argv[0]!) && argv[1] === "-c" && /\bgh /.test(argv[2] ?? ""));

// Not a secret: a gh call usesGh misses fails to authenticate instead of falling back to your own login.
export const NO_TOKEN = "tender-app-required";

/** `run` with the App's token as GH_TOKEN for `gh` (piped ones in `sh -c`/`bash -c` too), NO_TOKEN for the rest; `git` keeps your credentials. */
export const withApp =
  (run: Run, app: Pick<GitHubApp, "token">): Run =>
  async (argv, cwd, secs, opts = {}) => {
    if (argv[0] === "git") return run(argv, cwd, secs, opts);
    const token = usesGh(argv) ? await app.token().catch((e: Error) => e) : NO_TOKEN;
    if (token instanceof Error) return { code: 1, out: "", err: token.message };
    return run(argv, cwd, secs, { ...opts, env: { ...(opts.env ?? (process.env as Record<string, string>)), GH_TOKEN: token } });
  };
