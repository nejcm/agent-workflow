import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { budget, collectProof } from "../src/review/proof";
import { reconcileVerify, readVerified, runVerify } from "../src/review/verify";
import { ghAttaches } from "../tender";
import { config, fakeIo, root, useTempRoot } from "./helpers";

useTempRoot();

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("rest of a png")]);
const JPG = Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.from("jpeg body")]);
const SVG = '<?xml version="1.0"?>\n<!-- drawn -->\n<svg xmlns="http://www.w3.org/2000/svg"/>';
const box = (type: string, brand: string) => Buffer.concat([Buffer.from("00000018", "hex"), Buffer.from(type + brand + "rest", "latin1")]);
const WEBM = Buffer.concat([Buffer.from("1a45dfa3a34286810142f7810142f2810442f381084282847765626d", "hex"), Buffer.from("rest")]);
const HEAD = "a".repeat(40);
const PR = "https://github.com/acme/web/pull/7";
const put = (p: string, data: string | Buffer) => (mkdirSync(join(p, ".."), { recursive: true }), writeFileSync(p, data));
const check = (proof: string[], name = "e2e") => ({ name, run: "x", timeout: 60, proof });
const collect = (clone: string, globs: string[], b = budget(), name = "e2e") => {
  const out = join(root, "out");
  mkdirSync(out, { recursive: true });
  const logs: string[] = [];
  collectProof(clone, out, check(globs, name), b, (m) => logs.push(m));
  return { b, logs, out };
};

test("collect: copies only regular files whose content matches their type, under generated names, never through a symlink or into .git", () => {
  const clone = join(root, "clone");
  put(join(clone, ".tender/proof/a.png"), PNG);
  put(join(clone, ".tender/proof/b.png"), "not a png");
  put(join(clone, ".tender/proof/c.JPEG"), JPG);
  put(join(clone, ".tender/proof/empty.png"), "");
  put(join(clone, ".tender/proof/deep/d.png"), PNG);
  put(join(clone, "outside/secret.png"), PNG);
  symlinkSync(join(clone, "outside/secret.png"), join(clone, ".tender/proof/link.png"));
  symlinkSync(join(clone, "outside"), join(clone, ".tender/shots"));
  Bun.spawnSync(["mkfifo", join(clone, ".tender/proof/fifo.png")]);
  put(join(clone, "docs/x/y.svg"), SVG);
  put(join(clone, ".git/z.svg"), SVG);
  put(join(clone, ".git/w.png"), PNG);
  const { b, logs, out } = collect(clone, [".tender/proof/*.png", ".tender/proof/*.JPEG", ".tender/shots/*.png", "*.svg", ".tender/proof/*.png", ".git/*.png"]);
  expect(b.files).toEqual(["e2e-1.png", "e2e-2.jpg", "e2e-3.svg"]);
  expect(readdirSync(out).sort()).toEqual(b.files);
  expect(readFileSync(join(out, "e2e-1.png"))).toEqual(PNG);
  expect(readFileSync(join(out, "e2e-3.svg"), "utf8")).toBe(SVG);
  // b.png, empty.png, link.png and fifo.png; the symlinked .tender/shots is a link, never a dir to enter.
  expect(b.skipped).toBe(4);
  expect(logs.some((l) => l.includes("link.png skipped: not a regular file"))).toBe(true);
});

test("collect: content must really be the type; HTML is not SVG, a bare ftyp or EBML header is not MP4, MOV or WebM", () => {
  const clone = join(root, "clone");
  put(join(clone, "p/page.svg"), "<html><!-- <svg> --><body>hi</body></html>");
  put(join(clone, "p/ok.mp4"), box("ftyp", "isom"));
  put(join(clone, "p/qt.mp4"), box("ftyp", "qt  "));
  put(join(clone, "p/ok.mov"), box("ftyp", "qt  "));
  put(join(clone, "p/iso.mov"), box("ftyp", "isom"));
  put(join(clone, "p/ok.webm"), WEBM);
  put(join(clone, "p/mkv.webm"), Buffer.concat([Buffer.from("1a45dfa3", "hex"), Buffer.from("matroska")]));
  const { b, logs } = collect(clone, ["p/*.svg", "p/ok.mp4", "p/qt.mp4", "p/ok.mov", "p/iso.mov", "p/ok.webm", "p/mkv.webm"]);
  expect(b.files).toEqual(["e2e-1.mp4", "e2e-2.mov", "e2e-3.webm"]);
  expect(logs.filter((l) => l.includes("content is not")).length).toBe(4);
});

test("collect: SVG needs an svg root and rejects hostile preambles fast; WebM needs the header's DocType to be exactly webm", () => {
  const clone = join(root, "clone");
  const comments = "<!--a-->".repeat(8000);
  put(join(clone, "s/wrapped.svg"), '<!--lead--><html><body><!--note--><svg xmlns="http://www.w3.org/2000/svg"/></body></html>');
  put(join(clone, "s/hostile.svg"), comments + "<html>");
  put(join(clone, "s/unclosed.svg"), "<!--" + "-".repeat(60_000));
  put(join(clone, "s/bom.svg"), "\ufeff" + SVG);
  put(join(clone, "s/long.svg"), `<!--${"x".repeat(5000)}-->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg/>`);
  // An EBML Void element hiding a webm DocType inside a matroska header.
  put(join(clone, "w/void.webm"), Buffer.from("1a45dfa3954282886d6174726f736b61ec874282847765626d", "hex"));
  put(join(clone, "w/webmx.webm"), Buffer.from("1a45dfa3874282857765626d78", "hex"));
  put(join(clone, "w/late.webm"), Buffer.from("1a45dfa38e4286810142f781014282847765626d", "hex"));
  const t = performance.now();
  const { b } = collect(clone, ["s/*.svg", "w/*.webm"]);
  expect(performance.now() - t).toBeLessThan(200);
  expect(b.files).toEqual(["e2e-1.svg", "e2e-2.svg", "e2e-3.webm"]);
  expect(b.skipped).toBe(5);
});

test("collect: literal dirs match case-insensitively like the glob; each check gets its own copy of the same path", () => {
  const clone = join(root, "clone");
  put(join(clone, "shots/screen.png"), PNG);
  const b = budget();
  collect(clone, ["SHOTS/*.png"], b, "first");
  put(join(clone, "shots/screen.png"), Buffer.concat([PNG, Buffer.from("v2")]));
  const { out } = collect(clone, ["shots/*.png"], b, "second");
  expect(b.files).toEqual(["first-1.png", "second-2.png"]);
  expect(readFileSync(join(out, "second-2.png"))).toEqual(Buffer.concat([PNG, Buffer.from("v2")]));
});

test("collect: bounded by file count and per-file size", () => {
  const clone = join(root, "clone");
  for (let i = 0; i < 22; i++) put(join(clone, `p/${String(i).padStart(2, "0")}.png`), PNG);
  put(join(clone, "v/big.webm"), Buffer.concat([WEBM, Buffer.alloc(10 * 1024 * 1024)]));
  const { b, logs } = collect(clone, ["v/*.webm", "p/*.png"]);
  expect([b.files.length, b.skipped]).toEqual([20, 3]);
  expect(logs.some((l) => l.includes("big.webm skipped: over 10 MiB"))).toBe(true);
});

test("runner: a pass records its result, then posts one comment with its proof attached; a fail or a failed post posts nothing more", async () => {
  const dir = join(root, "acme/web");
  const job = (id: string) => {
    const vdir = join(dir, `${id}.verify`);
    put(join(vdir, "job.json"), JSON.stringify({ base: join(root, "src-web"), head: HEAD, digest: "d", checks: [check(["shots/*.png"]), check([], "test")], tenderDir: "/tender", pr: PR }));
    return vdir;
  };
  const runs: Record<string, string[]> = {};
  for (const [id, code, gh] of [["gh-1", 0, 0], ["gh-2", 1, 0], ["gh-3", 0, 1]] as const) {
    const vdir = job(id);
    const x = fakeIo((a) => (a[0] === "bash" ? (put(join(vdir, "clone/shots/one.png"), PNG), { code }) : a[0] === "gh" ? (expect(existsSync(join(vdir, "result"))).toBe(true), { code: gh, err: "upload failed" }) : undefined));
    await runVerify(vdir, x.io);
    runs[id] = x.cmds.filter((l) => l.startsWith("gh "));
    if (id === "gh-3") expect(x.logs.some((l) => l.startsWith("proof: not retried") && l.includes("upload failed"))).toBe(true);
  }
  const vdir = join(dir, "gh-1.verify");
  expect(runs).toEqual({ "gh-1": [`gh pr comment ${PR} --body tender: verified ${HEAD.slice(0, 12)}: e2e, test --attach ${vdir}/proof/e2e-1.png`], "gh-2": [], "gh-3": [runs["gh-3"]![0]!] });
  expect(readFileSync(join(vdir, "proof/e2e-1.png"))).toEqual(PNG);
  await reconcileVerify(config(), fakeIo().io);
  expect([readVerified(dir, "gh-1")?.pass, readVerified(dir, "gh-2")?.pass, readVerified(dir, "gh-3")?.pass]).toEqual([true, false, true]);
});

test("tender check: gh 2.99 or newer attaches", () => {
  expect(["gh version 2.98.3 (x)", "gh version 2.99.0 (x)", "gh version 2.102.1 (2026-10-21)", "gh version 3.0.0", ""].map(ghAttaches)).toEqual([false, true, true, true, false]);
});
