import { chmodSync, closeSync, constants as C, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Io, Ticket } from "./types";

export const AW_DIR = dirname(import.meta.dir);

// Second layer for aw's own git calls: hook files, fsmonitor, auto-gc and risky transports only, not every config that runs code.
export const GIT = ["git", ...["core.hooksPath=/dev/null", "core.fsmonitor=false", "core.alternateRefsCommand=", "maintenance.auto=false", "protocol.ext.allow=never", "protocol.file.allow=never", "protocol.git.allow=never"].flatMap((c) => ["-c", c])];

// Untrusted text: drop ESC sequences and invisible chars, blank controls and bidi; ZWJ/ZWNJ stay (emoji, Persian, Indic).
export const clean = (s: string, max = 200) =>
  s
    .replace(/\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)?|[@-_])?/g, "")
    .replace(/[\u00ad\u200b\u2060\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu, "")
    .replace(/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

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

export const mtime = (p: string) => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return undefined;
  }
};

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

export function readAw(wt: string, file: string, max: number): string | undefined {
  try {
    return inAw(wt, (d) => {
      const fd = openSync(`${d}/${file}`, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      try {
        const buf = Buffer.alloc(max + 1);
        const n = fstatSync(fd).isFile() ? readSync(fd, buf, 0, buf.length, 0) : buf.length;
        if (n > max) throw new Error(`${file}: must be a regular file under ${max / 1024} KiB`);
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

// A fresh temp file renamed over the target: a hard link there is replaced, never written through.
export function writeAw(wt: string, file: string, text: string) {
  inAw(wt, (d) => {
    const target = `${d}/${file}`;
    const tmp = `${d}/.${file}.tmp`;
    const st = lstatSync(target, { throwIfNoEntry: false });
    if (st && !st.isFile()) throw new Error(`${file}: must be a regular file`);
    rmSync(tmp, { force: true });
    const fd = openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o644);
    try {
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  });
}

export function removeAw(wt: string, file: string) {
  try {
    inAw(wt, (d) => {
      if (!lstatSync(`${d}/${file}`).isFile()) throw new Error(`${file}: must be a regular file`);
      unlinkSync(`${d}/${file}`);
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
