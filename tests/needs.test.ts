import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSession, parseRepoConfig } from "../src/config/repo-config";
import { pass } from "../src/pass";
import { reconcileVerify, runVerify, startVerify, verifyUnit } from "../src/review/verify";
import { launcher, scopeUnit } from "../src/session/launcher";
import { allocatePorts, checkMappings, composeProject, portFree, requireLandlock } from "../src/session/needs";
import type { AgentName, Config } from "../src/types";
import { Kept } from "../src/util";
import { check } from "../tender";
import { config, fakeIo, fakeTracker, noPr, repoFiles, root, ticket, useTempRoot, web, windowsOut, worktree } from "./helpers";

useTempRoot();

const file = (name: string, text: string) => ({ name, regular: true, size: Buffer.byteLength(text), text });
const ses = (c: Config, agent: AgentName = "claude") => ({ ...web(c), agent });
const VERIFY = "checks:\n  - { name: unit, run: bun test }\n  - { name: smoke, run: ./smoke.sh, timeout: 60, needs: { ports: 2, compose: dev/compose.yaml } }\n";
const mapping = (ports: object[], extra: object = {}) => JSON.stringify({ services: { db: { image: "postgres", ports, ...extra } } });
const loop = (p: number) => ({ host_ip: "127.0.0.1", target: 5432, published: String(p), protocol: "tcp" });

test("needs: on a verify check, validated like a type's; each compose file becomes a critical path", () => {
  const c = parseRepoConfig([file("verify.yaml", VERIFY)]);
  expect(c.verify!.checks.map((x) => x.needs)).toEqual([undefined, { ports: 2, compose: "dev/compose.yaml" }]);
  expect(c.criticalPaths).toEqual(["dev/compose.yaml"]);
  expect(() => parseRepoConfig([file("verify.yaml", "checks:\n  - { name: a, run: x, needs: { compose: /etc/c.yaml } }\n")])).toThrow("verify.checks[0] (a).needs.ports: integer 1-10\n  verify.checks[0] (a).needs.compose: a path inside the repo");
});

test("ports: skips every port a session or verify run holds and any in use; a held file that cannot be read fails closed", () => {
  const c = config();
  const dir = join(root, "acme/web");
  mkdirSync(join(dir, "gh-2.verify"), { recursive: true });
  writeFileSync(join(dir, "gh-1.needs"), JSON.stringify({ ports: [20000, 20002] }));
  writeFileSync(join(dir, "gh-2.verify/job.json"), JSON.stringify({ base: "b", ports: [20003] }));
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

test("compose project names are Docker-safe and unique per repo, ticket and kind", () => {
  const c = config();
  const names = [["acme/web", "GH-1", "session"], ["acme/web", "GH-1", "verify"], ["acme/Web", "GH-1", "session"], ["acme/web", "GH-2", "session"]].map(([k, id, kind]) => composeProject(c, k!, id!, kind as "session"));
  expect(names.every((n) => /^[a-z0-9][a-z0-9_-]*$/.test(n))).toBe(true);
  expect(new Set(names).size).toBe(4);
  expect(composeProject(c, "acme/web", "GH-1", "session")).toBe(names[0]!);
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
  expect(JSON.parse(readFileSync(join(dir, "gh-1.compose/job.json"), "utf8"))).toEqual({ project: composeProject(c, "acme/web", "gh-1", "session"), repo: `${root}/src-web`, sha: "a".repeat(40), file: "compose.yaml", ports });
  const script = readFileSync(join(dir, "gh-1.sh"), "utf8");
  expect(script).toContain(`'${dir}/gh-1.compose') || exit 1\n`);
  expect(script).toContain(`--open-port '${ports[0]}' --open-port '${ports[1]}' --`);
});

function verifyRun(respond: (a: string[]) => { code?: number; out?: string } | undefined = () => undefined) {
  const vdir = join(root, "acme/web/gh-1.verify");
  mkdirSync(vdir, { recursive: true });
  const checks = parseRepoConfig([file("verify.yaml", VERIFY)]).verify!.checks;
  writeFileSync(join(vdir, "job.json"), JSON.stringify({ base: join(root, "src-web"), head: "h", digest: "d", checks, tenderDir: "/tender", ports: [20007, 20008], project: "p-verify", baseSha: "b".repeat(40) }));
  const x = fakeIo((a) => {
    if (a[0] === "tar") mkdirSync(join(a.at(-1)!, "dev"), { recursive: true }), writeFileSync(join(a.at(-1)!, "dev/compose.yaml"), "services: {}\n");
    return respond(a) ?? (a[2] === "-p" && a.includes("config") ? { out: mapping([loop(20008)]) } : undefined);
  });
  const envs: Record<string, Record<string, string> | undefined> = {};
  const run = x.io.run;
  x.io.run = (a, ...r) => ((envs[a.join(" ")] = r[2]?.env as any), run(a, ...r));
  return { vdir, ...x, envs, result: () => JSON.parse(readFileSync(join(vdir, "result"), "utf8")) };
}

test("verify: a run gets its own ports and project, recorded in its job before it starts", async () => {
  repoFiles["verify.yaml"] = VERIFY;
  const c = config();
  const x = fakeIo((a) => (a[3] === "rev-parse" && a.at(-1) === "FETCH_HEAD^{commit}" ? { out: "h\n" } : undefined));
  mkdirSync(join(root, "acme/web"), { recursive: true });
  writeFileSync(join(root, "acme/web/gh-1.needs"), JSON.stringify({ ports: [20000, 20001] }));
  const s = (await loadSession(x.io, web(c)))!;
  await startVerify(c, x.io, s, "gh-1", { number: 7, state: "OPEN", isCrossRepository: false, baseRefName: "main", headRefOid: "h" }, { busy: false }, async () => true, "/tender");
  const job = JSON.parse(readFileSync(join(root, "acme/web/gh-1.verify/job.json"), "utf8"));
  expect(job).toMatchObject({ ports: [20002, 20003], project: composeProject(c, "acme/web", "gh-1", "verify"), baseSha: "a".repeat(40) });
  expect(x.cmds.find((l) => l.startsWith("systemd-run"))).toContain(`--unit ${verifyUnit(c)} `);
  expect(x.cmds.find((l) => l.startsWith("systemd-run"))).toContain(" -p RuntimeMaxSec=1640 ");
});

test("verify: a check's services start from the base tree with a clean env, and the check gets exactly its ports", async () => {
  const v = verifyRun();
  await runVerify(v.vdir, v.io);
  expect(v.result()).toEqual({ head: "h", digest: "d", pass: true });
  const docker = v.cmds.filter((l) => l.startsWith("docker ") || l.startsWith("tar ") || l.includes(" archive "));
  const tree = join(v.vdir, "compose/tree");
  expect(docker).toEqual([
    "docker compose -p p-verify down -v",
    `git -C ${root}/src-web archive --format=tar -o ${v.vdir}/compose/tree.tar ${"b".repeat(40)}`,
    `tar -x -f ${v.vdir}/compose/tree.tar -C ${tree}`,
    `docker compose -p p-verify --project-directory ${tree} -f ${tree}/dev/compose.yaml config --format json`,
    `docker compose -p p-verify --project-directory ${tree} -f ${tree}/dev/compose.yaml up -d --wait`,
  ]);
  const up = Object.entries(v.envs).find(([k]) => k.endsWith("up -d --wait"))![1]!;
  expect(Object.keys(up).sort()).toEqual(["HOME", "PATH", "TENDER_PORT_0", "TENDER_PORT_1", ...["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "XDG_RUNTIME_DIR"].filter((k) => process.env[k])].sort());
  const checks = Object.entries(v.envs).filter(([k]) => k.startsWith("bash -c"));
  expect(checks[0]![0]).not.toContain("--open-port");
  expect(checks[0]![1]!.TENDER_PORT_0).toBeUndefined();
  expect(checks[1]![0]).toContain("--open-port 20007 --open-port 20008 -- sh -c ./smoke.sh");
  expect(checks[1]![1]).toMatchObject({ TENDER_PORT_0: "20007", TENDER_PORT_1: "20008" });
});

test("verify: a mapping off loopback fails its check before anything is up; services that fail fail it too", async () => {
  const v = verifyRun((a) => (a.includes("config") ? { out: mapping([{ ...loop(20008), host_ip: "0.0.0.0" }]) } : undefined));
  await runVerify(v.vdir, v.io);
  expect(v.result()).toMatchObject({ pass: false, check: "smoke", tail: expect.stringContaining("publishes 0.0.0.0:20008") });
  expect(v.cmds.some((l) => l.endsWith("up -d --wait"))).toBe(false);
  const w = verifyRun((a) => (a.includes("up") ? { code: 1, out: "", err: "db is unhealthy" } as any : undefined));
  await runVerify(w.vdir, w.io);
  expect(w.result()).toMatchObject({ pass: false, check: "smoke", tail: "docker compose up: db is unhealthy" });
});

test("reconcile takes a run's services down before deleting it; a failed down keeps only that dir", async () => {
  const c = config();
  const dir = join(root, "acme/web");
  for (const id of ["gh-1", "gh-2"]) {
    mkdirSync(join(dir, `${id}.verify`), { recursive: true });
    writeFileSync(join(dir, `${id}.verify/job.json`), JSON.stringify({ base: "b", head: "h", digest: "d", checks: [], tenderDir: "/t", project: `p-${id}` }));
  }
  const x = fakeIo((a) => (a[0] === "docker" && a[3] === "p-gh-1" ? { code: 1, err: "daemon down" } : undefined));
  await reconcileVerify(c, x.io);
  expect(x.cmds.filter((l) => l.startsWith("docker") || l.startsWith("rm ")).sort()).toEqual(["docker compose -p p-gh-1 down -v", "docker compose -p p-gh-2 down -v", `rm -rf --one-file-system -- ${dir}/gh-2.verify`]);
  expect(x.logs).toContain("verify acme/web/gh-1: docker compose down: daemon down");
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
  writeFileSync(join(root, ".tender/verify.yaml"), VERIFY);
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
