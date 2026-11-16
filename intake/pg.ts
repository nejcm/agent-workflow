// Shared by pg-lint.ts and pg-slow.ts: copy it next to them. Connects to PG_INTAKE_URL, a read-only role (see docs/intake.md#postgres-and-supabase).
import { SQL } from "bun";
import { request } from "node:http";
import { createServer, type AddressInfo } from "node:net";

/** Runs `text` with `params` as one statement, or without them as a simple query that may hold several. */
export type Query = (text: string, params?: unknown[]) => Promise<any[]>;
export type Open = (ca?: string) => Promise<{ q: Query; close: () => Promise<void> }>;

// nono's proxy is the sandbox's only way out and is host-filtered, so Postgres rides a CONNECT tunnel from a loopback port (needs `loopback: true`).
function tunnel(proxy: URL, target: string) {
  const auth = `Basic ${btoa(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`)}`;
  const server = createServer((c) => {
    const req = request({ host: proxy.hostname, port: proxy.port, method: "CONNECT", path: target, headers: { "proxy-authorization": auth } });
    req.on("connect", (res, up) => {
      if (res.statusCode !== 200) {
        console.error(`proxy refused ${target}: ${res.statusCode} ${res.statusMessage}; is the host in the rule's network?`);
        up.destroy();
        return void c.destroy();
      }
      up.on("error", () => c.destroy());
      c.on("error", () => up.destroy());
      up.pipe(c).pipe(up);
    });
    req.on("error", (e) => (console.error(`proxy: ${e.message}`), c.destroy()));
    req.end();
  });
  server.unref();
  return new Promise<number>((ok, bad) => server.once("error", (e) => bad(new Error(`cannot listen on loopback; does the rule set loopback: true? ${e.message}`))).listen(0, "127.0.0.1", () => ok((server.address() as AddressInfo).port)));
}

/** SQL options for `url`, through `local` (a tunnel port) if given; `ca` (a PEM file) verifies the server, else TLS is required but unverified, like `sslmode=require`. */
export function sqlOptions(url: string, ca?: string, local?: number) {
  const host = new URL(url).hostname;
  return { url, max: 1, prepare: false, tls: { serverName: host, ...(ca && { ca: Bun.file(ca) }) }, ...(local && { hostname: "127.0.0.1", port: local }) };
}

/** A one-connection client for PG_INTAKE_URL, tunneled through HTTPS_PROXY when set. */
export const open: Open = async (ca) => {
  const url = process.env.PG_INTAKE_URL;
  if (!url) throw new Error("PG_INTAKE_URL is not set");
  const proxy = process.env.HTTPS_PROXY;
  const u = new URL(url);
  const sql = new SQL(sqlOptions(url, ca, proxy ? await tunnel(new URL(proxy), `${u.hostname}:${u.port || 5432}`) : undefined));
  return { q: (text, params) => (params ? sql.unsafe(text, params) : sql.unsafe(text).simple()), close: () => sql.close() };
};
