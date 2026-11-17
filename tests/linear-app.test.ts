import { expect, test } from "bun:test";
import { parseConfig } from "../src/config/config";
import { LINEAR_SCOPES, linearApp, REFRESH_MS, SECRET_ENV } from "../src/linear-app";
import { LINEAR_ISSUES, linear } from "../src/trackers/linear";
import { config, fakeIo, lin, raw, root, src, useTempRoot, withLinearKey } from "./helpers";

useTempRoot();

async function withSecret<T>(v: string | undefined, fn: () => Promise<T>) {
  const prev = process.env[SECRET_ENV];
  v === undefined ? delete process.env[SECRET_ENV] : (process.env[SECRET_ENV] = v);
  try {
    return await fn();
  } finally {
    prev === undefined ? delete process.env[SECRET_ENV] : (process.env[SECRET_ENV] = prev);
  }
}

const tokenResponse = (n: number) => Response.json({ access_token: `lin_oauth_${n}`, token_type: "Bearer", expires_in: 2591999, scope: "read write" });

test("linear app: mints with client_credentials and basic auth, reuses the token until a day before expiry, one mint for concurrent callers, reset after a 401", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const calls: { url: string; init: any }[] = [];
  const fetch = (async (url: string, init: any) => (calls.push({ url, init }), tokenResponse(calls.length))) as any;
  const app = linearApp({ clientId: "cid" }, fetch, () => now);
  await withSecret("sec", async () => {
    expect(await Promise.all([app.token(), app.token()])).toEqual(["lin_oauth_1", "lin_oauth_1"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.linear.app/oauth/token");
    expect(calls[0]!.init.headers.authorization).toBe(`Basic ${Buffer.from("cid:sec").toString("base64")}`);
    expect(Object.fromEntries(calls[0]!.init.body)).toEqual({ grant_type: "client_credentials", scope: LINEAR_SCOPES });
    now += 2591999_000 - REFRESH_MS - 1000;
    expect(await app.token()).toBe("lin_oauth_1");
    now += 2000;
    expect(await app.token()).toBe("lin_oauth_2");
    app.reset();
    expect(await app.token()).toBe("lin_oauth_3");
  });
});

test("linear app: a missing secret, an error or an odd response throws", async () => {
  let res = (): Response => Response.json({ error: "Error", error_description: "Client does not support the client_credentials grant type" }, { status: 400 });
  const app = linearApp({ clientId: "cid" }, (async () => res()) as any);
  await withSecret(undefined, async () => await expect(app.token()).rejects.toThrow(`${SECRET_ENV} not set`));
  await withSecret("sec", async () => {
    await expect(app.token()).rejects.toThrow("linear app token: 400 Client does not support the client_credentials grant type");
    res = () => Response.json({ access_token: "a b", expires_in: 10 });
    await expect(app.token()).rejects.toThrow("linear app token: unexpected response");
    res = () => Response.json({ access_token: "ok" });
    await expect(app.token()).rejects.toThrow("linear app token: unexpected response");
  });
});

test("config: linearApp takes a client ID only and needs a linear source", () => {
  const linSrc = [src({ tracker: "linear", team: "ENG" })];
  expect(config({ sources: linSrc, linearApp: { clientId: "abc123" } }).linearApp).toEqual({ clientId: "abc123" });
  expect(config({ sources: linSrc }).linearApp).toBeUndefined();
  for (const [over, msg] of [
    [{ sources: linSrc, linearApp: { clientId: "abc", clientSecret: "x" } }, "linearApp: object with clientId"],
    [{ sources: linSrc, linearApp: { clientId: "a-b" } }, "linearApp.clientId"],
    [{ sources: linSrc, linearApp: {} }, "linearApp.clientId"],
    [{ linearApp: { clientId: "abc" } }, "linearApp: needs a linear source"],
  ] as const)
    expect(() => parseConfig(raw(over), root)).toThrow(msg);
});

const node = (identifier: string, owners: object) => ({ id: identifier, identifier, title: "t", description: null, url: "u", labels: { nodes: [{ name: "agent" }, { name: "host:box" }] }, project: null, ...owners });

function appIo(respond: (query: string, variables: any) => object) {
  const bodies: any[] = [];
  const auth: string[] = [];
  const { io, logs } = fakeIo();
  io.fetch = (async (_url: string, init: any) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    auth.push(init.headers.Authorization);
    return Response.json({ data: b.query.includes("viewer") ? { viewer: { id: "app-me" } } : respond(b.query, b.variables) });
  }) as any;
  io.linearApp = { token: async () => "tok", reset: () => {} };
  return { io, logs, bodies, auth };
}

test("linear as an app: the claim sets the delegate and leaves the assignee alone; viewer is the app user; the bearer token is used, never LINEAR_API_KEY", async () => {
  const l = lin(config({ sources: [src({ tracker: "linear", team: "ENG" })] }));
  const { io, bodies, auth } = appIo((q) => (q.includes("workflowStates") ? { workflowStates: { nodes: [{ id: "s-ip", name: "In Progress", team: { id: "team" } }] } } : q.includes("issueUpdate") ? { issueUpdate: { success: true } } : { commentCreate: { success: true } }));
  await withLinearKey(() => linear(l, "box", io).claim({ id: "ENG-1", ref: "u-1", title: "t", body: "", url: "u" }));
  expect(bodies[2].variables).toEqual({ id: "u-1", i: { stateId: "s-ip", delegateId: "app-me" } });
  expect(new Set(auth)).toEqual(new Set(["Bearer tok"]));
});

test("linear as an app: a human assignee is fine, another delegate is someone else's, the app's own delegation is ours", async () => {
  const l = lin(config({ sources: [src({ tracker: "linear", team: "ENG" })] }));
  const nodes = [
    node("ENG-1", { delegate: null }),
    node("ENG-2", { delegate: { id: "app-me", name: "tender" } }),
    node("ENG-3", { delegate: { id: "app-other", name: "Other agent" } }),
  ];
  const { io, bodies } = appIo(() => ({ issues: { nodes } }));
  expect((await linear(l, "box", io).listReady()).map((t) => [t.id, t.otherAssignee])).toEqual([["ENG-1", undefined], ["ENG-2", undefined], ["ENG-3", "Other agent"]]);
  const list = bodies.find((b) => b.query.includes("issues("))!.query;
  expect(list).toContain("delegate { id name }");
  expect(list).not.toContain("assignee");
  expect(LINEAR_ISSUES).toContain("assignee { id name }");
});

test("linear as an app: no token means no Linear call, even with LINEAR_API_KEY set; a 401 drops the cached token", async () => {
  const l = lin(config({ sources: [src({ tracker: "linear", team: "ENG" })] }));
  const { io } = fakeIo();
  let fetched = 0;
  io.fetch = (async () => (fetched++, new Response("{}", { status: 401 }))) as any;
  let resets = 0;
  io.linearApp = { token: async () => Promise.reject(new Error("LINEAR_CLIENT_SECRET not set")), reset: () => void resets++ };
  await withLinearKey(async () => await expect(linear(l, "box", io).listReady()).rejects.toThrow("LINEAR_CLIENT_SECRET not set"));
  expect(fetched).toBe(0);
  io.linearApp = { token: async () => "tok", reset: () => void resets++ };
  await expect(linear(l, "box", io).listReady()).rejects.toThrow("linear 401");
  expect(resets).toBe(1);
});
