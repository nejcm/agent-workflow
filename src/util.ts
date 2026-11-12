import { chmodSync, closeSync, constants as C, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Io, Ticket } from "./types";

export const AW_DIR = dirname(import.meta.dir);

export async function read(io: Io, argv: string[], cwd?: string) {
  const r = await io.run(argv, cwd);
  if (r.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")}: ${r.err.trim() || `exit ${r.code}`}`);
  return r.out;
}

export async function write(io: Io, argv: string[], cwd?: string) {
  io.log(`${io.dry ? "dry: " : ""}${argv.join(" ")}`);
  return io.dry ? "" : read(io, argv, cwd);
}

export function put(io: Io, path: string, data: string, mode = 0o644) {
  io.log(`${io.dry ? "dry: " : ""}write ${path}`);
  if (io.dry) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, data);
  chmodSync(`${path}.tmp`, mode);
  renameSync(`${path}.tmp`, path);
}

// <wt>/.aw is agent-writable: pin it by fd (no symlink) so a swap can't redirect aw outside the worktree. Linux only.
export function inAw<T>(wt: string, fn: (dir: string) => T): T {
  const d = openSync(join(wt, ".aw"), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try {
    return fn(`/proc/self/fd/${d}`);
  } finally {
    closeSync(d);
  }
}

export function remove(io: Io, path: string) {
  if (!existsSync(path)) return;
  io.log(`${io.dry ? "dry: " : ""}rm ${path}`);
  if (!io.dry) rmSync(path);
}

// Ours if labelled host:<host>, or (defaultHost) if no host: label at all. Case-insensitive like GitHub's label filter.
export const ours = (t: Ticket, host: string, defaultHost: boolean) => {
  const hosts = (t.labels ?? []).map((x) => x.toLowerCase()).filter((x) => x.startsWith("host:"));
  return hosts.includes(`host:${host.toLowerCase()}`) || (defaultHost && !hosts.length);
};

export function readAw(wt: string, name: string, max: number): string | undefined {
  try {
    return inAw(wt, (d) => {
      const fd = openSync(`${d}/${name}.json`, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      try {
        const buf = Buffer.alloc(max + 1);
        const n = fstatSync(fd).isFile() ? readSync(fd, buf, 0, buf.length, 0) : buf.length;
        if (n > max) throw new Error(`${name}: must be a regular file under ${max / 1024} KiB`);
        return buf.toString("utf8", 0, n);
      } finally {
        closeSync(fd);
      }
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}
