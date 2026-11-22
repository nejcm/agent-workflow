import { closeSync, constants as C, existsSync, fstatSync, opendirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoDir } from "../config/config";
import type { Config, Io, VerifyCheck } from "../types";
import { inDir, put, read, remove, SAFE_ID, SLOW_SECS, subdirs, write } from "../util";
import { globRe } from "./merge";

/** `<ID>.proof/pending.json`: a pass whose comment is not posted yet, with the proof files staged next to it. */
export type Pending = { pr: string; head: string; checks: string[]; files: string[]; skipped: number; tries?: number };
export type Budget = { files: string[]; bytes: number; entries: number; skipped: number; seen: Set<string> };

// GitHub's 10 MB image limit, also its video limit on free plans; gh takes up to 50 files per comment.
const MAX_FILES = 20;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL = 50 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const TRIES = 3;

const ascii = (b: Buffer, from: number, to: number) => b.toString("latin1", from, to);
const MEDIA: Record<string, (b: Buffer) => boolean> = {
  png: (b) => ascii(b, 0, 8) === "\x89PNG\r\n\x1a\n",
  jpg: (b) => ascii(b, 0, 3) === "\xff\xd8\xff",
  gif: (b) => /^GIF8[79]a$/.test(ascii(b, 0, 6)),
  webp: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP",
  svg: (b) => ((s) => /^\s*</.test(s) && s.includes("<svg"))(b.toString("utf8", 0, 4096)),
  mp4: (b) => ascii(b, 4, 8) === "ftyp",
  mov: (b) => ["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(ascii(b, 4, 8)),
  webm: (b) => ascii(b, 0, 4) === "\x1a\x45\xdf\xa3",
};
const kind = (name: string) => name.toLowerCase().replace(/^.*\./, "").replace(/^jpeg$/, "jpg");

export const budget = (): Budget => ({ files: [], bytes: 0, entries: 0, skipped: 0, seen: new Set() });

/** Copies the files `c.proof` matches in `clone` into `out` as `<check>-<n>.<ext>`: regular files only, every dir pinned by fd, content matching the extension, within the size and count limits. */
export function collectProof(clone: string, out: string, c: VerifyCheck, b: Budget, log: (m: string) => void) {
  const skip = (rel: string, why: string) => void (b.skipped++, log(`proof ${c.name}: ${rel} skipped: ${why}`));
  const buf = Buffer.alloc(MAX_BYTES + 1);
  for (const glob of c.proof) {
    const re = globRe(glob);
    const segs = glob.replace(/^\//, "").split("/");
    const fixed = glob.includes("/") ? segs.slice(0, -1).findIndex((s) => /[*?]/.test(s)) : 0;
    const prefix = segs.slice(0, fixed < 0 ? segs.length - 1 : fixed);
    const deep = glob.includes("**") || !glob.includes("/");
    const walk = (d: string, rel: string[]) => {
      // Streamed: a check can leave a dir with millions of entries.
      const dh = opendirSync(d);
      try {
        for (let e; (e = dh.readSync()); ) {
          if (++b.entries > MAX_ENTRIES) return void (b.entries === MAX_ENTRIES + 1 && log(`proof ${c.name}: stopped after ${MAX_ENTRIES} entries`));
          const p = [...rel, e.name].join("/");
          if (e.isDirectory()) {
            if (e.name !== ".git" && (deep || rel.length + 2 <= segs.length)) pin(`${d}/${e.name}`, (x) => walk(x, [...rel, e.name]));
          } else if (re.test(p) && !b.seen.has(p)) {
            b.seen.add(p);
            if (!e.isFile()) skip(p, "not a regular file");
            else if (b.files.length >= MAX_FILES) skip(p, `over ${MAX_FILES} files`);
            else copy(`${d}/${e.name}`, p);
          }
        }
      } finally {
        dh.closeSync();
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
        if (!fstatSync(fd).isFile()) return skip(rel, "not a regular file");
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
    // Each prefix dir pinned in turn, so a symlink anywhere on the way is never followed.
    const pin = (path: string, fn: (d: string) => void) => {
      try {
        inDir(path, fn);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") skip(path.replace(/^\/proc\/self\/fd\/\d+\//, ""), code ?? (e as Error).message);
      }
    };
    const into = (d: string, i: number): void => (i < prefix.length ? pin(`${d}/${prefix[i]}`, (x) => into(x, i + 1)) : walk(d, prefix));
    try {
      inDir(clone, (d) => into(d, 0));
    } catch (e) {
      skip(glob, (e as Error).message);
    }
  }
}

const valid = (p: any): p is Pending => !!p && typeof p.pr === "string" && /\/pull\/\d+$/.test(p.pr) && typeof p.head === "string" && /^[0-9a-f]{40,64}$/.test(p.head) && Array.isArray(p.checks) && Array.isArray(p.files) && p.files.every((f: unknown) => typeof f === "string" && /^[a-z0-9-]+-\d+\.[a-z0-9]+$/.test(f));

/** Posts one `tender: verified` comment per staged pass, with its proof attached; once per PR and head, at most 3 tries, then the staging is dropped. */
export async function deliverProof(cfg: Config, io: Io) {
  for (const r of Object.values(cfg.repos)) {
    const dir = repoDir(cfg, r.key);
    for (const d of subdirs(dir)) {
      const id = d.endsWith(".proof") ? d.slice(0, -".proof".length) : "";
      if (SAFE_ID.test(id)) await deliver(io, join(dir, d)).catch((e) => io.log(`proof ${r.key}/${id}: ${e.message}`));
    }
  }
}

async function deliver(io: Io, pdir: string) {
  const f = join(pdir, "pending.json");
  let p: unknown;
  try {
    p = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
  } catch {}
  if (!valid(p)) return void (io.log(`${pdir}: no valid pending.json, removed`), remove(io, pdir));
  if ((p.tries ?? 0) >= TRIES) return void (io.log(`${pdir}: not posted after ${TRIES} tries, dropped`), remove(io, pdir));
  // Counted first: gh can post the comment and still exit non-zero when a later upload fails.
  put(io, f, JSON.stringify({ ...p, tries: (p.tries ?? 0) + 1 }));
  const marker = `<!-- tender:verified ${p.head} -->`;
  const posted = Number((await read(io, ["gh", "pr", "view", p.pr, "--json", "comments", "--jq", `[.comments[].body | select(contains("${marker}"))] | length`])).trim());
  if (!posted) {
    const skipped = p.skipped ? `\n\n${p.skipped} proof file${p.skipped === 1 ? "" : "s"} skipped (not a regular file, wrong content, or over the size or count limits); the verifier's journal names them.` : "";
    const body = `tender: verified ${p.head.slice(0, 12)}: ${p.checks.join(", ")}${skipped}\n\n${marker}`;
    await write(io, ["gh", "pr", "comment", p.pr, "--body", body, ...p.files.flatMap((x) => ["--attach", join(pdir, x)])], undefined, SLOW_SECS);
  }
  remove(io, pdir);
}
