import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { budget, collectProof, deliverProof } from "../src/review/proof";
import { reconcileVerify, runVerify } from "../src/review/verify";
import { pass } from "../src/pass";
import { ghAttaches } from "../tender";
import { config, fakeIo, fakeTracker, root, useTempRoot, worktree } from "./helpers";

useTempRoot();

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("rest of a png")]);
const JPG = Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.from("jpeg body")]);
const SVG = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>';
const HEAD = "a".repeat(40);
const PR = "https://github.com/acme/web/pull/7";
const put = (p: string, data: string | Buffer) => (mkdirSync(join(p, ".."), { recursive: true }), writeFileSync(p, data));
const check = (proof: string[]) => ({ name: "e2e", run: "x", timeout: 60, proof });

test("collect: copies only regular files whose content matches their type, under generated names, never through a symlink", () => {
  const clone = join(root, "clone");
  const out = join(root, "out");
  mkdirSync(out);
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
  const b = budget();
  const logs: string[] = [];
  collectProof(clone, out, check([".tender/proof/*.png", ".tender/proof/*.JPEG", ".tender/shots/*.png", "*.svg", ".tender/proof/*.png"]), b, (m) => logs.push(m));
  expect(b.files).toEqual(["e2e-1.png", "e2e-2.jpg", "e2e-3.svg"]);
  expect(readdirSync(out).sort()).toEqual(b.files);
  expect(readFileSync(join(out, "e2e-1.png"))).toEqual(PNG);
  expect(readFileSync(join(out, "e2e-3.svg"), "utf8")).toBe(SVG);
  // b.png, empty.png, link.png, fifo.png and the symlinked .tender/shots; deep/ is below the glob, .git never walked.
  expect(b.skipped).toBe(5);
  expect(logs.some((l) => l.includes("link.png skipped: not a regular file"))).toBe(true);
  expect(logs.some((l) => l.includes("shots skipped: ENOTDIR"))).toBe(true);
});

test("collect: bounded by file count and per-file size", () => {
  const clone = join(root, "clone");
  const out = join(root, "out");
  mkdirSync(out);
  for (let i = 0; i < 22; i++) put(join(clone, `p/${String(i).padStart(2, "0")}.png`), PNG);
  put(join(clone, "v/big.webm"), Buffer.concat([Buffer.from("1a45dfa3", "hex"), Buffer.alloc(10 * 1024 * 1024)]));
  const b = budget();
  const logs: string[] = [];
  collectProof(clone, out, check(["v/*.webm", "p/*.png"]), b, (m) => logs.push(m));
  expect([b.files.length, b.skipped]).toEqual([20, 3]);
  expect(logs.some((l) => l.includes("big.webm skipped: over 10 MiB"))).toBe(true);
});

test("runner and reconcile: a pass stages its proof and a pending comment in <ID>.proof; a fail stages nothing", async () => {
  const dir = join(root, "acme/web");
  const job = (id: string) => {
    const vdir = join(dir, `${id}.verify`);
    put(join(vdir, "job.json"), JSON.stringify({ base: join(root, "src-web"), head: HEAD, digest: "d", checks: [check(["shots/*.png"]), { ...check([]), name: "test" }], tenderDir: "/tender", pr: PR }));
    return vdir;
  };
  for (const [id, code] of [["gh-1", 0], ["gh-2", 1]] as const) {
    const vdir = job(id);
    const x = fakeIo((a) => (a[0] === "bash" ? (put(join(vdir, "clone/shots/one.png"), PNG), { code }) : undefined));
    await runVerify(vdir, x.io);
  }
  await reconcileVerify(config(), fakeIo().io);
  expect(JSON.parse(readFileSync(join(dir, "gh-1.proof/pending.json"), "utf8"))).toEqual({ pr: PR, head: HEAD, checks: ["e2e", "test"], files: ["e2e-1.png"], skipped: 0 });
  expect(readFileSync(join(dir, "gh-1.proof/e2e-1.png"))).toEqual(PNG);
  expect(existsSync(join(dir, "gh-2.proof"))).toBe(false);
});

const stage = (id: string, o: object = {}) => {
  const p = join(root, "acme/web", `${id}.proof`);
  put(join(p, "e2e-1.png"), PNG);
  put(join(p, "pending.json"), JSON.stringify({ pr: PR, head: HEAD, checks: ["e2e", "test"], files: ["e2e-1.png"], skipped: 1, ...o }));
  return p;
};

test("deliver: one comment with the staged files attached, skipped when the PR already has it, 3 tries at most", async () => {
  const c = config();
  const p = stage("gh-1");
  let seen = "0";
  let fail = false;
  const x = fakeIo((a) => (a[1] !== "pr" ? undefined : a[2] === "view" ? { out: `${seen}\n` } : fail ? { code: 1, err: "upload failed" } : undefined));
  await deliverProof(c, x.io);
  const posts = () => x.cmds.filter((l) => l.startsWith("gh pr comment"));
  expect(x.cmds).toContain(`gh pr view ${PR} --json comments --jq [.comments[].body | select(contains("<!-- tender:verified ${HEAD} -->"))] | length`);
  expect(posts()).toEqual([`gh pr comment ${PR} --body tender: verified ${HEAD.slice(0, 12)}: e2e, test\n\n1 proof file skipped (not a regular file, wrong content, or over the size or count limits); the verifier's journal names them.\n\n<!-- tender:verified ${HEAD} --> --attach ${p}/e2e-1.png`]);
  expect(existsSync(p)).toBe(false);
  stage("gh-1");
  seen = "1";
  await deliverProof(c, x.io);
  expect([posts().length, existsSync(p)]).toEqual([1, false]);
  stage("gh-1");
  [seen, fail] = ["0", true];
  for (let i = 0; i < 3; i++) await deliverProof(c, x.io);
  expect([posts().length, existsSync(p)]).toEqual([4, true]);
  await deliverProof(c, x.io);
  expect([posts().length, existsSync(p)]).toEqual([4, false]);
  expect(x.logs.some((l) => l.includes("not posted after 3 tries"))).toBe(true);
  stage("gh-2", { files: ["../../../etc/passwd"] });
  await deliverProof(c, x.io);
  expect([posts().length, existsSync(join(root, "acme/web/gh-2.proof"))]).toEqual([4, false]);
});

test("done: the clone is kept until its verify comment is posted", async () => {
  worktree("gh-5");
  const p = stage("gh-5");
  const c = config();
  const { tr } = fakeTracker({ done: ["gh-5"] });
  let fail = true;
  const x = fakeIo((a) => (a[1] === "pr" && a[2] === "comment" && fail ? { code: 1, err: "boom" } : a[1] === "pr" && a[2] === "view" ? { out: "0\n" } : undefined));
  await pass(c, x.io, () => tr, "/tender");
  expect(x.logs.some((l) => l.includes("acme/web/gh-5: waiting for its verify comment to be posted"))).toBe(true);
  expect(x.cmds).not.toContain(`rm -rf --one-file-system -- ${root}/acme/web/gh-5`);
  fail = false;
  await pass(c, x.io, () => tr, "/tender");
  expect([existsSync(p), x.cmds.includes(`rm -rf --one-file-system -- ${root}/acme/web/gh-5`)]).toEqual([false, true]);
});

test("tender check: gh 2.99 or newer attaches", () => {
  expect(["gh version 2.98.3 (x)", "gh version 2.99.0 (x)", "gh version 2.102.1 (2026-10-21)", "gh version 3.0.0", ""].map(ghAttaches)).toEqual([false, true, true, true, false]);
});
