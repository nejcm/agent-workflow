import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRepoConfig } from "../src/config/repo-config";
import { pass } from "../src/pass";
import { launcher, scopeUnit } from "../src/session/launcher";
import { allocatePorts, checkMappings, checkSources, composeProject, portFree, requireLandlock } from "../src/session/needs";
import type { AgentName, Config } from "../src/types";
import { Kept } from "../src/util";
import { check } from "../tender";
import { config, fakeIo, fakeTracker, noPr, repoFiles, root, ticket, useTempRoot, web, windowsOut, worktree } from "./helpers";

useTempRoot();

const file = (name: string, text: string) => ({ name, regular: true, size: Buffer.byteLength(text), text });
const ses = (c: Config, agent: AgentName = "claude") => ({ ...web(c), agent });
const TYPES = "types:\n  - { name: web, match: { labels: [web] }, instructions: instructions/default.md, needs: { ports: 2, compose: dev/compose.yaml } }\n";
const mapping = (ports: object[], extra: object = {}) => JSON.stringify({ services: { db: { image: "postgres", ports, ...extra } } });
const loop = (p: number) => ({ host_ip: "127.0.0.1", target: 5432, published: String(p), protocol: "tcp" });

test("needs: a type's compose file becomes a critical path", () => {
  expect(parseRepoConfig([file("config.yaml", TYPES)]).criticalPaths).toEqual(["dev/compose.yaml"]);
});

test("ports: skips every port a session holds and any in use; a held file that cannot be read fails closed", () => {
  const c = config();
  const dir = join(root, "acme/web");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "gh-1.needs"), JSON.stringify({ ports: [20000, 20002] }));
  writeFileSync(join(dir, "gh-2.needs"), JSON.stringify({ ports: [20003] }));
  expect(allocatePorts(c, 3, (p) => p !== 20004)).toEqual([20001, 20005, 20006]);
  expect(() => allocatePorts(c, 1, () => false)).toThrow("no 1 free ports in 20000-29999");
  writeFileSync(join(dir, "gh-3.needs"), "{");
  expect(() => allocatePorts(c, 1)).toThrow();
  const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  try {
    expect(portFree(l.port)).toBe(false);
  } finally {
    l.stop(true);
  }
  expect(portFree(l.port)).toBe(true);
});

test("Landlock below ABI 4 fails closed", () => {
  expect(() => requireLandlock(3)).toThrow(new Kept("Landlock ABI 3: port grants need ABI 4 or newer (Linux 6.7+), so nothing that needs ports starts"));
  expect(() => requireLandlock(0)).toThrow("Landlock ABI unavailable");
  expect(requireLandlock(4)).toBeUndefined();
});

test("compose project names are Docker-safe and unique per repo and ticket", () => {
  const c = config();
  const names = [["acme/web", "GH-1"], ["acme/Web", "GH-1"], ["acme/web", "GH-2"]].map(([k, id]) => composeProject(c, k!, id!));
  expect(names.every((n) => /^[a-z0-9][a-z0-9_-]*$/.test(n))).toBe(true);
  expect(new Set(names).size).toBe(3);
  expect(composeProject(c, "acme/web", "GH-1")).toBe(names[0]!);
});

test("compose mappings: only 127.0.0.1 on an assigned port, and never the host's network", () => {
  expect(() => checkMappings(mapping([loop(20001)]), [20000, 20001])).not.toThrow();
  expect(() => checkMappings(JSON.stringify({ services: { a: { image: "x" } } }), [])).not.toThrow();
  for (const [ports, extra, msg] of [
    [[{ ...loop(20001), host_ip: undefined }], {}, "publishes 0.0.0.0:20001"],
    [[{ ...loop(20001), host_ip: "0.0.0.0" }], {}, "publishes 0.0.0.0:20001"],
    [[loop(5432)], {}, "publishes 127.0.0.1:5432"],
    [[{ ...loop(0), published: undefined }], {}, "publishes 127.0.0.1:(random)"],
    [[{ ...loop(0), published: "20000-20001" }], {}, "publishes 127.0.0.1:20000-20001"],
    [[], { network_mode: "host" }, "network_mode: host"],
  ] as const)
    expect(() => checkMappings(mapping([...ports], extra), [20000, 20001])).toThrow(msg);
});

test("compose sources: a file that pulls in another is rejected, since only the declared one is critical", () => {
  expect(() => checkSources("services:\n  a: { image: x, extends: { service: b } }\n  b: { image: x }\n")).not.toThrow();
  expect(() => checkSources("include: [inc.yaml]\nservices:\n  a: { image: x }\n")).toThrow("include is not allowed");
  expect(() => checkSources("services:\n  a: { extends: { file: inc.yaml, service: root } }\n")).toThrow("service a extends another file");
});

test("launcher: each assigned port is granted in nono and exported; services start on the host from `/` before the agent", () => {
  const c = config();
  const s = launcher(ses(c), "/ws/web/gh-1", "/ws/web/gh-1.prompt.md", scopeUnit(c, "acme/web", "gh-1"), "/tender", "/b/bun", [20001, 20002], "/ws/web/gh-1.compose");
  expect(s).toContain(`--read '${root}/src-web/.git/objects' --open-port '20001' --open-port '20002' -- claude`);
  expect(s).toContain("unset LINEAR_API_KEY\n(cd / && exec '/b/bun' --no-env-file '/tender/src/session/needs.ts' '/ws/web/gh-1.compose') || exit 1\nexport TMPDIR=");
  expect(s).toContain("\nexport TENDER_PORT_0=20001 TENDER_PORT_1=20002\n");
  const none = launcher(ses(config({ repos: [{ name: "acme/web", sandbox: "none" }] })), "/w", "/p", "u.scope", "/tender", "", [20001]);
  expect([none.includes("--open-port"), none.includes("TENDER_PORT_0=20001"), none.includes("needs.ts")]).toEqual([false, true, false]);
});

test("a start with a type that needs ports and services records both before the window, from the base commit", async () => {
  repoFiles["config.yaml"] = "types:\n  - { name: web, match: { labels: [web] }, instructions: instructions/default.md, needs: { ports: 2, compose: compose.yaml } }\n";
  const { tr } = fakeTracker({ ready: [{ ...ticket(1), labels: ["web"] }] });
  const { io } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut([]) : a[5] === "--quiet" ? { code: 1 } : noPr(a)));
  const c = config();
  await pass(c, io, () => tr, "/tender");
  const dir = join(root, "acme/web");
  const { ports } = JSON.parse(readFileSync(join(dir, "gh-1.needs"), "utf8"));
  expect(ports).toHaveLength(2);
  expect(JSON.parse(readFileSync(join(dir, "gh-1.compose/job.json"), "utf8"))).toEqual({ project: composeProject(c, "acme/web", "gh-1"), repo: `${root}/src-web`, sha: "a".repeat(40), file: "compose.yaml", ports });
  const script = readFileSync(join(dir, "gh-1.sh"), "utf8");
  expect(script).toContain(`'${dir}/gh-1.compose') || exit 1\n`);
  expect(script).toContain(`--open-port '${ports[0]}' --open-port '${ports[1]}' --`);
});

test("done: a session's services are taken down before its clone goes; a failed down keeps everything", async () => {
  worktree("gh-5");
  const dir = join(root, "acme/web");
  mkdirSync(join(dir, "gh-5.compose/tree"), { recursive: true });
  writeFileSync(join(dir, "gh-5.compose/job.json"), JSON.stringify({ project: "p5" }));
  const { tr } = fakeTracker({ done: ["gh-5"] });
  let down = 1;
  const x = fakeIo((a) => (a[0] === "docker" ? { code: down, err: "no daemon" } : undefined));
  await pass(config(), x.io, () => tr, "/tender");
  expect(x.cmds).toContain("docker compose -p p5 down -v");
  expect(x.cmds).not.toContain(`rm -rf --one-file-system -- ${dir}/gh-5`);
  expect(x.logs.some((l) => l.includes("acme/web/gh-5: services not taken down, so everything is kept: docker compose down: no daemon"))).toBe(true);
  down = 0;
  await pass(config(), x.io, () => tr, "/tender");
  expect(x.cmds).toContain(`rm -rf --one-file-system -- ${dir}/gh-5`);
  expect(existsSync(join(dir, "gh-5.compose"))).toBe(false);
});

test("check: needs fail on a kernel without Landlock TCP rules, without docker compose, or with a missing compose file", () => {
  mkdirSync(join(root, ".tender"));
  writeFileSync(join(root, ".tender/config.yaml"), TYPES);
  const run = (abi: number, compose: boolean) => {
    const out: string[] = [];
    return [check(root, () => {}, (s) => out.push(s), undefined, { abi: () => abi, compose: () => compose }), out.join("\n")] as const;
  };
  expect(run(4, true)).toEqual([false, `${root}/.tender: needs cannot run on this host:\n  dev/compose.yaml: no such compose file in ${root}`]);
  mkdirSync(join(root, "dev"));
  writeFileSync(join(root, "dev/compose.yaml"), "services: {}\n");
  expect(run(4, true)).toEqual([true, ""]);
  expect(run(3, false)).toEqual([false, `${root}/.tender: needs cannot run on this host:\n  Landlock ABI 3: port grants need ABI 4 or newer (Linux 6.7+)\n  \`docker compose\` is not installed, and a compose file is declared`]);
});
