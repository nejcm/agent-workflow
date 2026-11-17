export type LinearAppConfig = { clientId: string };
export type LinearApp = { token(): Promise<string>; reset(): void };

/** Fixed: Linear replaces the app's tokens when a request asks for different scopes; see docs/setup.md#linear-app. */
export const LINEAR_SCOPES = "read,write,app:assignable";
export const SECRET_ENV = "LINEAR_CLIENT_SECRET";
export const REFRESH_MS = 24 * 3600_000;

// shortcut: one token per process (intake's timer mints one per run), well under Linear's 1,000; cache it on disk if that grows.
/** client_credentials tokens (actor=app, 30 days), reused until REFRESH_MS before expiry or until reset() after a 401. */
export function linearApp(c: LinearAppConfig, fetch: typeof globalThis.fetch, now = Date.now): LinearApp {
  let cached: { token: string; expires: number } | undefined;
  let pending: Promise<string> | undefined;
  const mint = async () => {
    const secret = process.env[SECRET_ENV];
    if (!secret) throw new Error(`${SECRET_ENV} not set`);
    const r = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${c.clientId}:${secret}`).toString("base64")}` },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: LINEAR_SCOPES }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`linear app token: ${r.status} ${String(j.error_description ?? j.error ?? "").slice(0, 200)}`);
    if (typeof j.access_token !== "string" || !/^[\w.-]+$/.test(j.access_token) || !(j.expires_in > 0)) throw new Error("linear app token: unexpected response");
    cached = { token: j.access_token, expires: now() + j.expires_in * 1000 };
    return j.access_token as string;
  };
  return {
    token: () => (cached && cached.expires - now() > REFRESH_MS ? Promise.resolve(cached.token) : (pending ??= mint().finally(() => (pending = undefined)))),
    reset: () => void (cached = undefined),
  };
}
