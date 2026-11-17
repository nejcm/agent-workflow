import { expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appJwt, NO_TOKEN, githubApp, importKey, REFRESH_MS, withApp } from "../src/github-app";
import { launcher, scopeUnit } from "../src/session/launcher";
import { github } from "../src/trackers/github";
import { config, fakeIo, gh, root, ticket, useTempRoot, web } from "./helpers";

useTempRoot();

const keys = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
const pem = (label: string, der: Uint8Array) => `-----BEGIN ${label}-----\n${Buffer.from(der).toString("base64").replace(/.{64}/g, "$&\n")}\n-----END ${label}-----\n`;
const pkcs8 = async (k: CryptoKeyPair) => new Uint8Array(await crypto.subtle.exportKey("pkcs8", k.privateKey));
// A 2048-bit PKCS#8 RSA key is PKCS#1 behind a fixed 26-byte header (outer SEQUENCE, version, AlgorithmIdentifier, OCTET STRING header).
const pkcs1 = async (k: CryptoKeyPair) => (await pkcs8(k)).slice(26);
const verify = async (k: CryptoKeyPair, jwt: string) => {
  const [h, p, s] = jwt.split(".");
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", k.publicKey, Buffer.from(s!, "base64url"), new TextEncoder().encode(`${h}.${p}`));
};
const part = (jwt: string, i: number) => JSON.parse(Buffer.from(jwt.split(".")[i]!, "base64url").toString());

test("github app: the JWT is RS256, backdated 60 s, 10 minutes long and verifies; PKCS#1 and PKCS#8 keys both sign", async () => {
  const k = await keys();
  const now = 1_700_000_000_500;
  for (const key of [pem("PRIVATE KEY", await pkcs8(k)), pem("RSA PRIVATE KEY", await pkcs1(k))]) {
    const jwt = await appJwt(42, await importKey(key), now);
    expect(part(jwt, 0)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(part(jwt, 1)).toEqual({ iat: 1_699_999_940, exp: 1_700_000_540, iss: 42 });
    expect(jwt).not.toContain("=");
    expect(await verify(k, jwt)).toBe(true);
  }
  expect(() => importKey("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----")).toThrow('not a "PRIVATE KEY" or "RSA PRIVATE KEY" PEM');
});

test("github app: mints a repo- and permission-limited token, reuses it until 20 minutes before expiry, writes it 0600", async () => {
  const k = await keys();
  const keyFile = join(root, "app.pem");
  writeFileSync(keyFile, pem("RSA PRIVATE KEY", await pkcs1(k)));
  let now = Date.parse("2026-01-01T00:00:00Z");
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/app")) return new Response(JSON.stringify({ slug: "Tender-Bot" }));
    return new Response(JSON.stringify({ token: calls.length === 1 ? "ghs_1" : "ghs_123_eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOjd9.c2ln-_", expires_at: new Date(now + 3_600_000).toISOString() }), { status: 201 });
  }) as any;
  const file = join(root, ".github-app-token");
  const app = githubApp({ appId: 7, installationId: 99, privateKeyFile: keyFile }, ["acme/web", "acme/api"], fetch, file, () => now);
  expect(await Promise.all([app.token(), app.token()])).toEqual(["ghs_1", "ghs_1"]);
  expect(calls).toHaveLength(1);
  const { url, init } = calls[0]!;
  expect(url).toBe("https://api.github.com/app/installations/99/access_tokens");
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual({ repositories: ["web", "api"], permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "read", actions: "read" } });
  const auth = (init.headers as Record<string, string>).authorization!;
  expect(auth).toStartWith("Bearer ");
  expect(await verify(k, auth.slice(7))).toBe(true);
  expect(part(auth.slice(7), 1).iss).toBe(7);
  expect(readFileSync(file, "utf8")).toBe("ghs_1");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  now += 3_600_000 - REFRESH_MS - 1000;
  expect(await app.token()).toBe("ghs_1");
  now += 2000;
  expect(await app.token()).toBe("ghs_123_eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOjd9.c2ln-_");
  expect(readFileSync(file, "utf8")).toBe("ghs_123_eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOjd9.c2ln-_");
  expect(await app.login()).toBe("tender-bot[bot]");
  expect(calls.at(-1)!.url).toBe("https://api.github.com/app");
  expect(calls.at(-1)!.init.method).toBe("GET");
});

test("github app: a refused mint is an error and nothing is cached or written", async () => {
  const k = await keys();
  writeFileSync(join(root, "app.pem"), pem("PRIVATE KEY", await pkcs8(k)));
  let ok = false;
  const fetch = (async () => (ok ? new Response(JSON.stringify({ token: "ghs_ok", expires_at: "2099-01-01T00:00:00Z" })) : new Response("Bad credentials", { status: 401 }))) as any;
  const file = join(root, ".github-app-token");
  const app = githubApp({ appId: 7, installationId: 99, privateKeyFile: join(root, "app.pem") }, ["acme/web"], fetch, file);
  await expect(app.token()).rejects.toThrow("github app /app/installations/99/access_tokens: 401 Bad credentials");
  expect(() => statSync(file)).toThrow();
  ok = true;
  expect(await app.token()).toBe("ghs_ok");
});

test("github app: gh commands get the token as GH_TOKEN, other commands an invalid one, git keeps yours; a failed mint fails the gh command", async () => {
  const seen: [string, Record<string, string> | undefined][] = [];
  const run = withApp(async (argv, _c, _s, o) => (seen.push([argv[0]!, o?.env]), { code: 0, out: "", err: "" }), { token: async () => "ghs_x" });
  await run(["gh", "issue", "list"], undefined, 5, { env: { PATH: "/bin" } });
  await run(["gh", "api", "user"]);
  await run(["git", "fetch"]);
  expect(seen[0]).toEqual(["gh", { PATH: "/bin", GH_TOKEN: "ghs_x" }]);
  expect(seen[1]![1]!.GH_TOKEN).toBe("ghs_x");
  expect(seen[1]![1]!.PATH).toBe(process.env.PATH!);
  expect(seen[2]).toEqual(["git", undefined]);
  await run(["git", "fetch"], undefined, 5, { env: { GH_TOKEN: "personal" } });
  expect(seen[3]).toEqual(["git", { GH_TOKEN: "personal" }]);
  seen.length = 0;
  // The shapes of src/session/feedback.ts failedLog and src/review/merge.ts prHatch.
  await run(["sh", "-c", `gh run view "$1" --repo "$2" --log-failed | tail -n 80`, "sh", "1", "acme/web"]);
  await run(["bash", "-c", 'set -o pipefail; gh api -H "Accept: application/vnd.github.diff" "$1" | head -c "$2"', "bash", "repos/acme/web/compare/a...b", "9"]);
  await run(["bash", "-c", "echo sigh "]);
  for (const argv of [["sh", "-c", "gh\tapi user"], ["/bin/sh", "-c", "gh api user"], ["bash", "-lc", "gh api user"], ["tmux", "list-windows"]]) await run(argv, undefined, 5, { env: { GH_TOKEN: "personal", GITHUB_TOKEN: "personal" } });
  expect(seen.map(([, env]) => env?.GH_TOKEN)).toEqual(["ghs_x", "ghs_x", NO_TOKEN, NO_TOKEN, NO_TOKEN, NO_TOKEN, NO_TOKEN]);
  const failing = withApp(async () => ({ code: 0, out: "", err: "" }), { token: () => Promise.reject(new Error("github app: 401")) });
  expect(await failing(["gh", "issue", "list"])).toEqual({ code: 1, out: "", err: "github app: 401" });
  expect(await failing(["sh", "-c", "gh run view 1 | tail"])).toEqual({ code: 1, out: "", err: "github app: 401" });
  expect((await failing(["bash", "-lc", "gh api user"])).code).toBe(0);
});

test("github app: the claim keeps label and comment but adds no assignee; only a human assignee is someone else", async () => {
  const issue = (number: number, ...logins: string[]) => ({ number, title: "t", body: "", url: "u", labels: [{ name: "agent" }], assignees: logins.map((login) => ({ login })) });
  const { io, cmds } = fakeIo((a) => (a[2] === "list" ? { out: JSON.stringify([issue(1), issue(2, "alice")]) } : undefined));
  const tr = github(gh(), "box", { ...io, appLogin: async () => "tender-bot[bot]" }, true, ["acme/web"]);
  expect((await tr.listReady()).map((t) => [t.id, t.otherAssignee])).toEqual([["gh-1", undefined], ["gh-2", "alice"]]);
  expect(cmds.some((c) => c.startsWith("gh api user"))).toBe(false);
  await tr.claim({ ...ticket(1), repo: "acme/web" });
  expect(cmds.slice(-2)).toEqual(["gh issue edit 1 --repo acme/web --add-label in-progress", "gh issue comment 1 --repo acme/web --body tender: picked up on box"]);
});

test("github app: config validates the block and expands the key path; unset leaves config unchanged", () => {
  const app = { appId: 1, installationId: 2, privateKeyFile: "~/keys/app.pem" };
  expect(config({ githubApp: app }).githubApp).toEqual({ appId: 1, installationId: 2, privateKeyFile: join(process.env.HOME!, "keys/app.pem") });
  expect(config().githubApp).toBeUndefined();
  expect("githubApp" in config()).toBe(false);
  const err = (over: object) => {
    try {
      config(over);
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  expect(err({ githubApp: { ...app, key: "x" } })).toContain("githubApp: object with appId, installationId and privateKeyFile");
  expect(err({ githubApp: { ...app, appId: "1" } })).toContain("githubApp.appId: positive integer");
  expect(err({ githubApp: { ...app, installationId: 0 } })).toContain("githubApp.installationId: positive integer");
  expect(err({ githubApp: { ...app, privateKeyFile: "" } })).toContain("githubApp.privateKeyFile");
  expect(err({ githubApp: app, repos: ["acme/web", "other/api"] })).toContain("githubApp: every repo in repos must belong to one owner");
  expect(err({ githubApp: app, repos: ["acme/web", "ACME/api"] })).toBe("");
  expect(err({ githubApp: app, repos: Array.from({ length: 501 }, (_, i) => `acme/r${i}`) })).toContain("at most 500 repos");
  expect(err({ githubApp: app, repos: [{ name: "acme/web", sandbox: "none" }] })).toContain(`repos (acme/web).sandbox: "nono" while githubApp is set`);
});

test("github app: the nono launcher names the token file for nono's capture; without the App it does not", () => {
  const c = config();
  const s = (file?: string) => launcher({ ...web(c), agent: "claude" }, "/ws/web/gh-1", "/ws/p.md", scopeUnit(c, "acme/web", "gh-1"), "/tender", "/b/bun", file);
  expect(s("/ws/.github-app-token")).toContain("TENDER_BUN='/b/bun' TENDER_GH_TOKEN_FILE='/ws/.github-app-token'\n");
  expect(s()).not.toContain("TENDER_GH_TOKEN_FILE");
  for (const agent of ["claude", "codex"]) {
    const capture = JSON.parse(readFileSync(join(import.meta.dir, "..", "nono", `tender-${agent}.json`), "utf8")).credential_capture;
    expect(capture.github.command.at(-1)).toContain(`cat -- "$TENDER_GH_TOKEN_FILE"; else gh auth token`);
    expect(capture.github_git.command.at(-1)).toContain(`cat -- "$TENDER_GH_TOKEN_FILE"; else gh auth token`);
    expect(capture.github.cache_ttl_secs * 1000).toBeLessThan(REFRESH_MS);
  }
});
