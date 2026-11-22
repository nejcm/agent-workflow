import { closeSync, constants as C, fstatSync, opendirSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Io, VerifyCheck } from "../types";
import { inDir, write } from "../util";
import { globRe } from "./merge";

export type Budget = { files: string[]; bytes: number; entries: number; skipped: number };

// GitHub's 10 MB image limit, also its video limit on free plans; gh takes up to 50 files per comment.
const MAX_FILES = 20;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL = 50 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const UPLOAD_SECS = 300;

const ascii = (b: Buffer, from: number, to: number) => b.toString("latin1", from, to);

// Linear on purpose: a backtracking regex took seconds per hostile file, inside the verifier's deadline.
function isSvg(b: Buffer) {
  const s = b.toString("utf8", 0, 64 * 1024);
  let i = 0;
  for (let first = true; ; first = false) {
    while (/\s/.test(s[i] ?? "")) i++;
    if (s.startsWith("<svg", i)) return /[\s>/]/.test(s[i + 4] ?? "");
    const end = s.startsWith("<!--", i) ? s.indexOf("-->", i + 4) + 3 : (first && s.startsWith("<?xml", i)) || s.startsWith("<!DOCTYPE svg", i) ? s.indexOf(">", i) + 1 : -1;
    if (end <= i) return false;
    i = end;
  }
}

// An EBML vint at b[i] as [value, length]; ids keep their length marker, sizes drop it.
function vint(b: Buffer, i: number, id: boolean): [number, number] {
  const first = b[i] ?? 0;
  const len = Math.clz32(first) - 23;
  if (len > 8) return [-1, 1];
  let v = id ? first : first & (0xff >> len);
  for (let k = 1; k < len; k++) v = v * 256 + (b[i + k] ?? 0);
  return [v, len];
}

function isWebm(b: Buffer) {
  const [id, a] = vint(b, 0, true);
  const [size, c] = vint(b, a, false);
  if (id !== 0x1a45dfa3 || size < 0) return false;
  for (let i = a + c, end = Math.min(i + size, b.length); i < end; ) {
    const [eid, n] = vint(b, i, true);
    const [len, m] = vint(b, i + n, false);
    if (eid < 0 || len < 0 || i + n + m + len > end) return false;
    if (eid === 0x4282) return ascii(b, i + n + m, i + n + m + len) === "webm";
    i += n + m + len;
  }
  return false;
}

const MEDIA: Record<string, (b: Buffer) => boolean> = {
  png: (b) => ascii(b, 0, 8) === "\x89PNG\r\n\x1a\n",
  jpg: (b) => ascii(b, 0, 3) === "\xff\xd8\xff",
  gif: (b) => /^GIF8[79]a$/.test(ascii(b, 0, 6)),
  webp: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP",
  svg: isSvg,
  mp4: (b) => ascii(b, 4, 8) === "ftyp" && /^(iso[m2-9]|mp4[12]|avc1|dash|M4VP?|mmp4|MSNV)$/.test(ascii(b, 8, 12).trimEnd()),
  mov: (b) => ascii(b, 4, 12) === "ftypqt  ",
  webm: isWebm,
};
const kind = (name: string) => name.toLowerCase().replace(/^.*\./, "").replace(/^jpeg$/, "jpg");

export const budget = (): Budget => ({ files: [], bytes: 0, entries: 0, skipped: 0 });

/** Copies the files `c.proof` matches in `clone` into `out` as `<check>-<n>.<ext>`: regular files only, every dir pinned by fd, content matching the extension, within the size and count limits. */
export function collectProof(clone: string, out: string, c: VerifyCheck, b: Budget, log: (m: string) => void) {
  const skip = (rel: string, why: string) => void (b.skipped++, log(`proof ${c.name}: ${rel} skipped: ${why}`));
  const seen = new Set<string>();
  const buf = Buffer.alloc(MAX_BYTES + 1);
  const pin = (path: string, rel: string, fn: (d: string) => void) => {
    try {
      inDir(path, fn);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") skip(rel || ".", code ?? (e as Error).message);
    }
  };
  const copy = (src: string, rel: string) => {
    let fd: number;
    try {
      fd = openSync(src, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    } catch (e) {
      return skip(rel, (e as NodeJS.ErrnoException).code ?? "unreadable");
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return skip(rel, "not a regular file");
      if (!st.size || st.size > MAX_BYTES) return skip(rel, st.size ? "over 10 MiB" : "empty");
      let n = 0;
      let r = 0;
      while (n < buf.length && (r = readSync(fd, buf, n, buf.length - n, n)) > 0) n += r;
      const data = buf.subarray(0, n);
      const ext = kind(rel);
      if (!n || n > MAX_BYTES) return skip(rel, n ? "over 10 MiB" : "empty");
      if (b.bytes + n > MAX_TOTAL) return skip(rel, "over 50 MiB in all");
      if (!MEDIA[ext]?.(data)) return skip(rel, `content is not ${ext}`);
      const name = `${c.name}-${b.files.length + 1}.${ext}`;
      writeFileSync(join(out, name), data);
      b.files.push(name);
      b.bytes += n;
    } finally {
      closeSync(fd);
    }
  };
  for (const glob of c.proof) {
    const re = globRe(glob);
    const segs = glob.replace(/^\//, "").split("/");
    // Literal leading dirs narrow the walk, compared case-insensitively like globRe.
    const fixed = glob.includes("/") ? segs.slice(0, -1).findIndex((s) => /[*?]/.test(s)) : 0;
    const prefix = segs.slice(0, fixed < 0 ? segs.length - 1 : fixed).map((s) => s.toLowerCase());
    const deep = glob.includes("**") || !glob.includes("/");
    const walk = (d: string, rel: string[]) => {
      // Streamed: a check can leave a dir with millions of entries.
      const dh = opendirSync(d);
      try {
        for (let e; (e = dh.readSync()); ) {
          if (++b.entries > MAX_ENTRIES) return void (b.entries === MAX_ENTRIES + 1 && log(`proof ${c.name}: stopped after ${MAX_ENTRIES} entries`));
          const p = [...rel, e.name].join("/");
          const i = rel.length;
          if (e.isDirectory()) {
            if (e.name !== ".git" && (i < prefix.length ? e.name.toLowerCase() === prefix[i] : deep || i + 2 <= segs.length)) pin(`${d}/${e.name}`, p, (x) => walk(x, [...rel, e.name]));
          } else if (re.test(p) && !seen.has(p)) {
            seen.add(p);
            if (!e.isFile()) skip(p, "not a regular file");
            else if (b.files.length >= MAX_FILES) skip(p, `over ${MAX_FILES} files`);
            else copy(`${d}/${e.name}`, p);
          }
        }
      } finally {
        dh.closeSync();
      }
    };
    pin(clone, "", (d) => walk(d, []));
  }
}

/** One `tender: verified` comment with the collected files attached; best effort, never retried. */
export async function postProof(io: Io, pr: string, head: string, checks: string[], out: string, b: Budget) {
  const skipped = b.skipped ? `\n\n${b.skipped} proof file${b.skipped === 1 ? "" : "s"} skipped (not a regular file, wrong content, or over the size or count limits); the verifier's journal names them.` : "";
  try {
    await write(io, ["gh", "pr", "comment", pr, "--body", `tender: verified ${head.slice(0, 12)}: ${checks.join(", ")}${skipped}`, ...b.files.flatMap((f) => ["--attach", join(out, f)])], undefined, UPLOAD_SECS);
  } catch (e) {
    // gh still posts the files uploaded before a failed one, so a retry could post a second comment.
    io.log(`proof: not retried, the PR may have a comment with only some files: ${(e as Error).message}`);
  }
}
