import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoDir } from "../config/config";
import type { Config, Io } from "../types";
import { GIT, Kept, read, SLOW_SECS, subdirs } from "../util";
import { scopePrefix } from "./launcher";

/** What `<ID>.compose/job.json` and a verify job record before `up`, so a crash still knows what to tear down. */
export type ComposeJob = { project: string; repo: string; sha: string; file: string; ports: number[] };

// Below Linux's ephemeral range (32768+), so an outgoing connection never takes one.
const FIRST = 20000;
const LAST = 29999;
const ENV = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "XDG_RUNTIME_DIR"];

/** The kernel's Landlock ABI, 0 without Landlock; TCP port rules need 4 (Linux 6.7). */
export function landlockAbi() {
  try {
    const { symbols, close } = dlopen("libc.so.6", { syscall: { args: [FFIType.i64, FFIType.u64, FFIType.u64, FFIType.u32], returns: FFIType.i64 } });
    // landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION); 444 on every architecture.
    const v = Number(symbols.syscall(444, 0, 0, 1));
    close();
    return v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

export const landlockProblem = (abi: number) => (abi >= 4 ? undefined : `Landlock ABI ${abi || "unavailable"}: port grants need ABI 4 or newer (Linux 6.7+)`);

/** Fails closed: without Landlock TCP rules nono cannot grant just these ports. */
export function requireLandlock(abi = landlockAbi()) {
  const p = landlockProblem(abi);
  if (p) throw new Kept(`${p}, so nothing that needs ports starts`);
}

export const portEnv = (ports: number[]) => Object.fromEntries(ports.map((p, i) => [`TENDER_PORT_${i}`, String(p)]));
/** nono grants per port, not per address: a granted port is reachable on any host, not only loopback. */
export const portGrants = (ports: number[]): [string, string][] => ports.map((p) => ["--open-port", String(p)]);

const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));

// A file removed since the scan held nothing: `tender verify` removes its run outside the pass lock.
const held = (f: string) => {
  try {
    return readJson(f).ports ?? [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
};

/** Every port a session (`<ID>.needs`) or a verify run (`<ID>.verify/job.json`) in this workspace holds; a file that cannot be read throws. */
export function reservedPorts(cfg: Config) {
  const used = new Set<number>();
  for (const r of Object.values(cfg.repos)) {
    const dir = repoDir(cfg, r.key);
    if (!existsSync(dir)) continue;
    const files = [...new Bun.Glob("*.needs").scanSync({ cwd: dir, onlyFiles: true })].map((f) => join(dir, f));
    for (const d of subdirs(dir)) if (d.endsWith(".verify")) files.push(join(dir, d, "job.json"));
    for (const f of files) for (const p of held(f)) used.add(p);
  }
  return used;
}

export function portFree(port: number) {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
}

/** `n` ports no session or verify run holds and nothing listens on now; call under the pass lock. */
export function allocatePorts(cfg: Config, n: number, free = portFree) {
  const used = reservedPorts(cfg);
  const out: number[] = [];
  for (let p = FIRST; p <= LAST && out.length < n; p++) if (!used.has(p) && free(p)) out.push(p);
  if (out.length < n) throw new Error(`no ${n} free ports in ${FIRST}-${LAST}`);
  return out;
}

/** Docker-safe and unique per workspace, repo, ticket and kind, with the ticket readable. */
export const composeProject = (cfg: Config, key: string, id: string, kind: "session" | "verify") =>
  `${scopePrefix(cfg)}-${id.toLowerCase()}-${createHash("sha256").update(`${key}\0${id}\0${kind}`).digest("hex").slice(0, 8)}${kind === "verify" ? "-verify" : ""}`;

const dockerEnv = (io: Io, ports: number[]) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: io.home, ...Object.fromEntries(ENV.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : []))), ...portEnv(ports) });

// cwd `/`: compose looks for a compose file in the cwd and its parents.
async function compose(io: Io, args: string[], secs: number, ports: number[] = []) {
  io.log(`${io.dry ? "dry: " : ""}docker compose ${args.join(" ")}`);
  if (io.dry) return "";
  const r = await io.run(["docker", "compose", ...args], "/", secs, { env: dockerEnv(io, ports) });
  if (r.code !== 0) throw new Error(`docker compose ${args.find((a) => ["config", "up", "down"].includes(a))}: ${r.err.trim().slice(-2000) || `exit ${r.code}`}`);
  return r.out;
}

/** Throws unless every published port is on 127.0.0.1 and one of `ports`, and no service uses the host's network. */
export function checkMappings(json: string, ports: number[]) {
  const services: Record<string, any> = JSON.parse(json).services ?? {};
  for (const [name, s] of Object.entries(services)) {
    if (s.network_mode === "host") throw new Error(`compose: service ${name} uses network_mode: host; publish ports on 127.0.0.1 instead`);
    for (const p of s.ports ?? [])
      if (p.host_ip !== "127.0.0.1" || !ports.includes(Number(p.published))) throw new Error(`compose: service ${name} publishes ${p.host_ip ?? "0.0.0.0"}:${p.published ?? "(random)"}; publish each port as 127.0.0.1:\${TENDER_PORT_<n>} (${ports.join(", ")})`);
  }
}

/** Throws if the file pulls in another (`include`, `extends.file`): only the declared file is a critical path. */
export function checkSources(yaml: string) {
  const doc = Bun.YAML.parse(yaml) as Record<string, any> | null;
  if (doc?.include !== undefined) throw new Error("compose: include is not allowed; keep the services in the declared file");
  for (const [name, s] of Object.entries<any>(doc?.services ?? {})) if (s?.extends?.file !== undefined) throw new Error(`compose: service ${name} extends another file; keep the services in the declared file`);
}

/** Removes the project's containers, networks and volumes by name alone; a no-op when it has none. */
export const composeDown = (io: Io, project: string) => compose(io, ["-p", project, "down", "-v"], 120);

/** `docker compose up -d --wait` from the base commit's tree, never a session clone, with a clean env; the project is taken down first. */
export async function composeUp(io: Io, j: ComposeJob, dir: string, secs: number) {
  await composeDown(io, j.project);
  const tree = join(dir, "tree");
  const tar = join(dir, "tree.tar");
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  await read(io, [...GIT, "-C", j.repo, "archive", "--format=tar", "-o", tar, j.sha], undefined, SLOW_SECS);
  await read(io, ["tar", "-x", "-f", tar, "-C", tree], undefined, SLOW_SECS);
  rmSync(tar, { force: true });
  const file = join(tree, j.file);
  if (!existsSync(file) || !realpathSync(file).startsWith(`${realpathSync(tree)}/`) || !statSync(file).isFile()) throw new Error(`compose: ${j.file} is not a file in ${j.sha.slice(0, 12)}`);
  checkSources(readFileSync(file, "utf8"));
  // `--env-file /dev/null`: a committed `.env` is not critical, so it must not feed interpolation.
  const f = ["-p", j.project, "--project-directory", tree, "-f", file, "--env-file", "/dev/null"];
  checkMappings(await compose(io, [...f, "config", "--format", "json"], 60, j.ports), j.ports);
  await compose(io, [...f, "up", "-d", "--wait"], secs, j.ports);
}

/** Takes down a session's services and deletes `<ID>.compose`; throws, keeping it, if `down` fails. */
export async function composeTeardown(io: Io, dir: string) {
  if (!existsSync(join(dir, "job.json"))) return;
  await composeDown(io, (readJson(join(dir, "job.json")) as ComposeJob).project);
  // A container can leave root-owned files in a bind mount; that keeps only this dir.
  if (!io.dry) try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    io.log(`${dir}: ${(e as Error).message}`);
  }
}

/** Why a session's services did not start, as the launcher's `up` recorded it. */
export const composeError = (dir: string) => {
  try {
    return readFileSync(join(dir, "error"), "utf8").slice(0, 2000) || undefined;
  } catch {
    return undefined;
  }
};

if (import.meta.main) {
  const dir = process.argv[2]!;
  const { spawnRun } = await import("../../tender");
  rmSync(join(dir, "error"), { force: true });
  try {
    await composeUp({ run: spawnRun, fetch, dry: false, log: console.log, home: homedir() }, readJson(join(dir, "job.json")), dir, SLOW_SECS);
  } catch (e) {
    const msg = `tender: services did not start: ${(e as Error).message}`;
    writeFileSync(join(dir, "error"), msg);
    console.error(msg);
    process.exit(1);
  }
}
