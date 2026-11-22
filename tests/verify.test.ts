import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Entry, loadSession, parseRepoConfig } from "../src/config/repo-config";
import { mergeDecision, type PrFacts } from "../src/review/merge";
import { readVerified, reconcileVerify, runVerify, startVerify, stopVerify, verifiedAt, verifyBase, verifyUnit } from "../src/review/verify";
import { pass } from "../src/pass";
import { Kept } from "../src/util";
import { config, fakeIo, fakeTracker, repoFiles, root, setBaseSha, ticket, useTempRoot, web, windowsOut, worktree } from "./helpers";

useTempRoot();

const URL = "https://github.com/acme/web/pull/7";
const YAML = "checks:\n  - { name: test, run: bun test }\n";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const file = (name: string, text: string): Entry => ({ name, regular: true, size: Buffer.byteLength(text), text });
const contract = (yaml: string) => parseRepoConfig([file("verify.yaml", yaml)]).verify!;
const errors = (yaml: string) => {
  try {
    contract(yaml);
  } catch (e) {
    return (e as Error).message;
  }
};
const verified = (id: string, v: object) => writeFileSync(join(root, `acme/web/${id}.verified`), JSON.stringify({ digest: sha(YAML), ...v }));

test("verify.yaml: defaults, digest of the raw file, and every invalid shape rejected", () => {
  expect(contract(YAML)).toEqual({ checks: [{ name: "test", run: "bun test", timeout: 600, proof: [] }], maxRounds: 2, digest: sha(YAML) });
  expect(contract("maxRounds: 4\nchecks:\n  - name: e2e\n    run: bash .tender/checks/e2e.sh\n    timeout: 60\n    proof: [\"proof/*.png\", \"out/**/*.webm\"]\n")).toMatchObject({ maxRounds: 4, checks: [{ timeout: 60, proof: ["proof/*.png", "out/**/*.webm"] }] });
  expect(contract("checks:\n  - { name: a, run: x, proof: [a.svg, b.webp, c.JPG] }\n").checks[0]!.proof).toEqual(["a.svg", "b.webp", "c.JPG"]);
  expect(parseRepoConfig([]).verify).toBeUndefined();
  for (const bad of ["", "checks: []\n", "checks: x\n", "extra: 1\n" + YAML, "maxRounds: 0\n" + YAML, "maxRounds: 11\n" + YAML,
    "checks:\n  - { name: Test, run: x }\n", "checks:\n  - { name: a, run: x }\n  - { name: a, run: y }\n", "checks:\n  - { name: a, run: \" \" }\n", "checks:\n  - { name: a }\n",
    "checks:\n  - { name: a, run: x, timeout: 0 }\n", "checks:\n  - { name: a, run: x, timeout: 1801 }\n", "checks:\n  - { name: a, run: x, env: {} }\n",
    "checks:\n  - { name: a, run: x, proof: [a.txt] }\n", "checks:\n  - { name: a, run: x, proof: [../a.png] }\n", "checks:\n  - { name: a, run: x, proof: a.png }\n"])
    expect([bad, errors(bad)]).toEqual([bad, expect.stringContaining("verify")]);
});

test("verify.yaml is read from origin/<base> of the base clone, never the worktree; a new contract has a new digest", async () => {
  worktree("gh-1");
  mkdirSync(join(root, "acme/web/gh-1/.tender"), { recursive: true });
  writeFileSync(join(root, "acme/web/gh-1/.tender/verify.yaml"), "checks:\n  - { name: test, run: \"true\" }\n");
  const c = config({ repos: [{ name: "acme/web", path: join(root, "src-web") }] });
  const { io } = fakeIo();
  expect((await loadSession(io, web(c)))!.verify).toBeUndefined();
  repoFiles["verify.yaml"] = YAML;
  setBaseSha("b".repeat(40));
  const first = (await loadSession(io, web(c)))!.verify!;
  expect(first.checks[0]!.run).toBe("bun test");
  repoFiles["verify.yaml"] = YAML.replace("bun test", "bun test --bail");
  setBaseSha("c".repeat(40));
  const second = (await loadSession(io, web(c)))!.verify!;
  const pass = { head: "h", digest: first.digest, pass: true as const };
  expect([verifiedAt(pass, "h", first), verifiedAt(pass, "h", second), verifiedAt(pass, "other", first)]).toEqual([pass, undefined, undefined]);
});

test("merge decision: with a contract only a pass at this head and digest merges; without one only small changes do", () => {
  const s = { autoMerge: "intelligent" as const, ceiling: "all" as const, trust: [], escapeHatches: [], criticalPaths: [], testPaths: [], baseBranch: "main", intake: [] };
  const v = contract(YAML);
  const pr = (over: Partial<PrFacts> = {}) => ({
    state: "OPEN", isDraft: false, isCrossRepository: false, baseRefName: "main", mergeable: "MERGEABLE", additions: 10, deletions: 5, changedFiles: 2,
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }], labels: [], headRefOid: "h", ...over,
  });
  const at = (o: object) => ({ head: "h", digest: v.digest, pass: true as const, ...o }) as any;
  expect(mergeDecision(pr(), undefined, { ...s, verify: v })).toEqual({ merge: "wait", reason: "verify pending for this head" });
  expect(mergeDecision(pr(), undefined, { ...s, verify: v }, [], at({}))).toEqual({ merge: true, reason: "small change" });
  expect(mergeDecision(pr(), undefined, { ...s, verify: v }, [], at({ pass: false, check: "test", tail: "x" }))).toEqual({ merge: false, reason: "verify failed: test" });
  expect(mergeDecision(pr(), undefined, { ...s, verify: v }, [], at({ head: "old" })).merge).toBe("wait");
  expect(mergeDecision(pr(), undefined, { ...s, verify: v }, [], at({ digest: "old" })).merge).toBe("wait");
  expect(mergeDecision(pr(), undefined, { ...s, autoMerge: "all", verify: v }, [], at({ pass: false, check: "test", tail: "x" })).reason).toBe("verify failed: test");
  expect(mergeDecision(pr(), undefined, s)).toEqual({ merge: true, reason: "small change" });
  for (const autoMerge of ["intelligent", "all"] as const) expect(mergeDecision(pr({ additions: 5000 }), undefined, { ...s, autoMerge }).reason).toBe("large change without a verify contract (.tender/verify.yaml)");
});

function scheduler(o: { head?: string; nono?: number } = {}) {
  repoFiles["verify.yaml"] = YAML;
  const c = config({ repos: [{ name: "acme/web", path: join(root, "src-web") }] });
  const x = fakeIo((a) => (a[0] === "nono" ? { code: o.nono ?? 0 } : a[3] === "rev-parse" && a.at(-1) === "FETCH_HEAD^{commit}" ? { out: `${o.head ?? "h"}\n` } : undefined));
  const pr = { number: 7, state: "OPEN", isCrossRepository: false, baseRefName: "main", headRefOid: "h" };
  return { c, ...x, pr, session: () => loadSession(x.io, web(c)).then((s) => s!) };
}

test("scheduler: one detached systemd-run per pass at a fetched head equal to the judged one; never waits for the run", async () => {
  const d = scheduler();
  const s = await d.session();
  const done = async () => true;
  for (const busy of [undefined, true]) await startVerify(d.c, d.io, s, "gh-1", d.pr, { busy }, done, "/tender");
  await startVerify(d.c, d.io, s, "gh-1", d.pr, { busy: false }, async () => false, "/tender");
  expect(d.cmds.some((x) => /refs\/pull|systemd-run/.test(x))).toBe(false);
  const v = { busy: false };
  await startVerify(d.c, d.io, s, "gh-1", d.pr, v, done, "/tender");
  await startVerify(d.c, d.io, s, "gh-2", d.pr, v, done, "/tender");
  const vdir = join(root, "acme/web/gh-1.verify");
  expect(d.cmds).toContain(`git -C ${root}/src-web fetch -q --no-tags origin refs/pull/7/head`);
  const runs = d.cmds.filter((x) => x.startsWith("systemd-run"));
  expect(runs).toEqual([expect.stringMatching(new RegExp(`^systemd-run --user --quiet --collect --unit ${verifyUnit(d.c)} --description=${vdir} -p RuntimeMaxSec=1510 --setenv=PATH=.* -- \\S+ /tender/src/review/verify.ts ${vdir}$`))]);
  expect(JSON.parse(readFileSync(join(vdir, "job.json"), "utf8"))).toEqual({ base: `${root}/src-web`, head: "h", digest: sha(YAML), checks: s.verify!.checks, tenderDir: "/tender" });
  expect([v.busy, existsSync(join(root, "acme/web/gh-2.verify"))]).toEqual([true, false]);
  verified("gh-3", { head: "h", pass: false, check: "test", tail: "x" });
  await startVerify(d.c, d.io, s, "gh-3", d.pr, { busy: false }, done, "/tender");
  expect(existsSync(join(root, "acme/web/gh-3.verify"))).toBe(false);
});

test("scheduler: a fetched head that moved starts nothing; no nono fails closed", async () => {
  const moved = scheduler({ head: "newer" });
  await startVerify(moved.c, moved.io, await moved.session(), "gh-1", moved.pr, { busy: false }, async () => true, "/tender");
  expect([moved.cmds.some((x) => x.startsWith("systemd-run")), existsSync(join(root, "acme/web/gh-1.verify"))]).toEqual([false, false]);
  expect(moved.logs.some((l) => l.includes("verify gh-1: fetched newer for PR #7, not the head h it was judged at"))).toBe(true);
  const none = scheduler({ nono: 127 });
  expect(startVerify(none.c, none.io, await none.session(), "gh-1", none.pr, { busy: false }, async () => true, "/tender")).rejects.toBeInstanceOf(Kept);
});

test("reconcile: a running verifier is left alone; an idle one has each result recorded and every <ID>.verify removed", async () => {
  const c = config();
  const dir = join(root, "acme/web");
  mkdirSync(join(dir, "gh-1.verify"), { recursive: true });
  mkdirSync(join(dir, "gh-2.verify"), { recursive: true });
  mkdirSync(join(dir, "gh_3.verify"), { recursive: true });
  writeFileSync(join(dir, "gh-1.verify/result"), JSON.stringify({ head: "h", digest: "d", pass: false, check: "test", tail: "boom" }));
  let state = "active";
  const x = fakeIo((a) => (a[2] === "list-units" ? { out: `${verifyUnit(c)} loaded ${state} running x\n` } : undefined));
  expect(await reconcileVerify(c, x.io)).toBe(true);
  expect(x.cmds.some((l) => l.startsWith("rm "))).toBe(false);
  state = "failed";
  expect(await reconcileVerify(c, x.io)).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, "gh-1.verified"), "utf8"))).toEqual({ head: "h", digest: "d", pass: false, check: "test", tail: "boom" });
  expect(x.cmds.filter((l) => l.startsWith("rm ")).sort()).toEqual([`rm -rf --one-file-system -- ${dir}/gh-1.verify`, `rm -rf --one-file-system -- ${dir}/gh-2.verify`]);
  expect(x.logs.some((l) => l.includes("verify acme/web/gh-2: ended without a result"))).toBe(true);
  const down = fakeIo((a) => (a[0] === "systemctl" ? { code: 1, err: "no bus" } : undefined));
  expect(reconcileVerify(c, down.io)).rejects.toThrow("no bus");
});

test("reconcile: a run that left no result records a (verifier) failure; a dir rm cannot remove is logged and holds only its own ticket", async () => {
  const c = config();
  const dir = join(root, "acme/web");
  mkdirSync(join(dir, "gh-1.verify"), { recursive: true });
  writeFileSync(join(dir, "gh-1.verify/job.json"), JSON.stringify({ base: "b", head: "h", digest: "d", checks: [], tenderDir: "/t" }));
  mkdirSync(join(dir, "gh-2.verify"), { recursive: true });
  const x = fakeIo((a) => (a[0] === "rm" && a.at(-1)!.endsWith("gh-1.verify") ? { code: 1, err: "rm: cannot remove 'ro': Permission denied" } : undefined));
  expect(await reconcileVerify(c, x.io)).toBe(false);
  expect(readVerified(dir, "gh-1")).toEqual({ head: "h", digest: "d", pass: false, check: "(verifier)", tail: expect.stringContaining("without a result") });
  expect(x.cmds.filter((l) => l.includes("gh-1.verify"))).toEqual([`chmod -R u+rwX -- ${dir}/gh-1.verify`, `rm -rf --one-file-system -- ${dir}/gh-1.verify`]);
  expect(x.cmds).toContain(`rm -rf --one-file-system -- ${dir}/gh-2.verify`);
  expect(x.logs.some((l) => l.startsWith("verify acme/web/gh-1: ") && l.includes("Permission denied"))).toBe(true);
  const big = join(dir, "gh-3.verify");
  mkdirSync(big, { recursive: true });
  writeFileSync(join(big, "job.json"), JSON.stringify({ base: "b", head: "h3", digest: "d", checks: [{ name: "a", run: "x".repeat(70_000), timeout: 60, proof: [] }], tenderDir: "/t" }));
  await reconcileVerify(c, x.io);
  expect(readVerified(dir, "gh-3")).toMatchObject({ head: "h3", check: "(verifier)" });
  const d = scheduler();
  const s = await d.session();
  rmSync(join(dir, "gh-2.verify"), { recursive: true });
  rmSync(big, { recursive: true });
  for (const id of ["gh-1", "gh-2"]) await startVerify(d.c, d.io, s, id, d.pr, { busy: false }, async () => true, "/tender");
  expect(d.cmds.filter((x) => x.startsWith("systemd-run")).map((x) => x.split(" ").at(-1))).toEqual([`${dir}/gh-2.verify`]);
});

test("done: its own running verifier is stopped without waiting, another ticket's never, and the clone is kept until its <ID>.verify is gone", async () => {
  worktree("gh-5");
  mkdirSync(join(root, "acme/web/gh-5.verify/clone"), { recursive: true });
  const c = config();
  const { tr } = fakeTracker({ done: ["gh-5"] });
  let state = "active";
  let running = "gh-2";
  const x = fakeIo((a) =>
    a[2] === "list-units" && a[3] === "--type=service" ? { out: `${verifyUnit(c)} loaded ${state} running x\n` }
    : a[2] === "show" ? { out: `Description=${root}/acme/web/${running}.verify\nActiveState=${state}\n` }
    : undefined);
  await pass(c, x.io, () => tr, "/tender");
  expect(x.cmds.some((l) => l.startsWith("systemctl --user stop"))).toBe(false);
  running = "gh-5";
  await pass(c, x.io, () => tr, "/tender");
  expect(x.cmds).toContain(`systemctl --user stop --no-block ${verifyUnit(c)}`);
  expect(x.cmds.some((l) => l.startsWith("rm "))).toBe(false);
  expect(x.logs.some((l) => l.includes("acme/web/gh-5: waiting for its verify run to stop"))).toBe(true);
  state = "inactive";
  await pass(c, x.io, () => tr, "/tender");
  expect(x.cmds).toContain(`rm -rf --one-file-system -- ${root}/acme/web/gh-5.verify`);
  // The fake runner does not delete; reconcile's rm would have.
  rmSync(join(root, "acme/web/gh-5.verify"), { recursive: true });
  await pass(c, x.io, () => tr, "/tender");
  expect(x.cmds).toContain(`rm -rf --one-file-system -- ${root}/acme/web/gh-5`);
});

test("runner: no host git or XDG config reaches a check; a huge failing output is kept as a bounded tail that reconcile still reads", async () => {
  const c = config();
  const vdir = join(root, "acme/web/gh-1.verify");
  mkdirSync(vdir, { recursive: true });
  writeFileSync(join(vdir, "job.json"), JSON.stringify({ base: join(root, "src-web"), head: "h", digest: "d", checks: [{ name: "test", run: "x", timeout: 60, proof: [] }], tenderDir: "/tender" }));
  const x = fakeIo((a) => (a[0] === "bash" ? { code: 1, out: "é\"".repeat(40_000), err: "last line" } : undefined));
  const run = x.io.run;
  const envs: any[] = [];
  x.io.run = (a, ...r) => (envs.push(r[2]?.env), run(a, ...r));
  await runVerify(vdir, x.io);
  expect(envs.filter(Boolean).every((e) => e.GIT_CONFIG_GLOBAL === "/dev/null" && e.GIT_CONFIG_NOSYSTEM === "1" && e.XDG_CONFIG_HOME.startsWith(vdir))).toBe(true);
  expect(readFileSync(join(vdir, "result")).length).toBeLessThan(64 * 1024);
  await reconcileVerify(c, fakeIo().io);
  const v = readVerified(join(root, "acme/web"), "gh-1");
  expect(v && !v.pass && v.tail.endsWith("last line") && v.tail.length).toBe(8000);
});

test("verifyBase: the base's contract on the base commit through the verifier, never the shared slot; a stale run is taken down first", async () => {
  const c = config();
  const dir = join(root, "acme/web");
  mkdirSync(join(dir, "_base.verify"), { recursive: true });
  writeFileSync(join(dir, "_base.verify/job.json"), JSON.stringify({ project: "stale" }));
  let code = 0;
  let nono = 0;
  const x = fakeIo((a) => (a[0] === "nono" && a[1] === "--version" ? { code: nono } : a[0] === "bash" ? { code, out: "boom", err: "" } : undefined));
  await expect(verifyBase(c, x.io, web(c), "/tender")).rejects.toThrow("acme/web: no .tender/verify.yaml on origin/main");
  repoFiles["verify.yaml"] = YAML;
  setBaseSha("b".repeat(40));
  expect(await verifyBase(c, x.io, web(c), "/tender")).toEqual({ head: "b".repeat(40), digest: sha(YAML), pass: true });
  const vdir = join(dir, "_base.verify");
  expect(x.cmds.findIndex((l) => l === "docker compose -p stale down -v")).toBeLessThan(x.cmds.findIndex((l) => l.includes(`checkout -q --detach ${"b".repeat(40)}`)));
  expect([x.cmds.some((l) => l.startsWith("systemd-run")), x.cmds.at(-1)]).toEqual([false, `rm -rf --one-file-system -- ${vdir}`]);
  code = 1;
  expect(await verifyBase(c, x.io, web(c), "/tender")).toMatchObject({ pass: false, check: "test", tail: "boom" });
  rmSync(vdir, { recursive: true });
  const stuck = fakeIo((a) => (a[0] === "rm" ? { code: 1, err: "busy" } : undefined));
  expect(await verifyBase(c, stuck.io, web(c), "/tender")).toMatchObject({ pass: true });
  expect(stuck.logs.some((l) => l.includes(`acme/web: rm -rf --one-file-system: busy; ${vdir} stays until the next tender verify`))).toBe(true);
  const idle = fakeIo((a) => (a[2] === "list-units" ? { out: "" } : undefined));
  await reconcileVerify(c, idle.io);
  expect([idle.cmds.some((l) => l.includes("_base")), existsSync(join(dir, "_base.verified"))]).toEqual([false, false]);
  nono = 127;
  await expect(verifyBase(c, x.io, web(c), "/tender")).rejects.toThrow("nono is not installed");
});

test("stopVerify matches the run by the exact description tender gave it, also in a path with spaces", async () => {
  const c = config();
  const vdir = "/tmp/tender workspace/acme/web/gh-5.verify";
  const x = fakeIo((a) => (a[2] === "show" ? { out: `Description=${vdir}\nActiveState=active\n` } : undefined));
  await stopVerify(c, x.io, "/tmp/tender workspace/acme/web/gh-6.verify");
  expect(x.cmds.some((l) => l.startsWith("systemctl --user stop"))).toBe(false);
  await stopVerify(c, x.io, vdir);
  expect(x.cmds).toContain(`systemctl --user stop --no-block ${verifyUnit(c)}`);
});

function inReview(o: { win?: boolean; maxRounds?: number; ready?: boolean; autoMerge?: string } = {}) {
  repoFiles["verify.yaml"] = (o.maxRounds ? `maxRounds: ${o.maxRounds}\n` : "") + YAML;
  worktree("gh-1");
  writeFileSync(join(root, "acme/web/gh-1.agent"), "codex");
  mkdirSync(join(root, "acme/web/gh-1/.tender/run"), { recursive: true });
  const t = ticket(1);
  const f = fakeTracker({ inReview: [t], readyToMerge: o.ready });
  const pr: any = { number: 7, url: URL, state: "OPEN", isDraft: false, isCrossRepository: false, baseRefName: "main", mergeable: "MERGEABLE", additions: 1, deletions: 0, changedFiles: 1, labels: [], reviewDecision: "", headRefOid: "a", mergeStateStatus: "CLEAN", statusCheckRollup: [], reviews: [], comments: [] };
  const x = fakeIo((a) =>
    a[1] === "list-windows" ? windowsOut(o.win ? ["acme/web/gh-1"] : [], o.win ? Math.floor(Date.now() / 1000) - 3600 : undefined)
    : a[1] === "list-panes" ? { out: `%5 0 ${join(root, "acme/web/gh-1")}.sh\n` }
    : a[1] === "pr" && a[2] === "list" ? { out: JSON.stringify([{ url: URL, state: "OPEN" }]) }
    : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(pr) }
    : a[1] === "api" ? { out: "[]" }
    : a[3] === "rev-parse" && a.at(-1) === "FETCH_HEAD^{commit}" ? { out: `${pr.headRefOid}\n` }
    : a[0] === "pgrep" ? { code: 1 } : undefined);
  const c = config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: o.autoMerge ?? "off", feedbackAuthors: [] }] });
  return {
    ...f, t, pr, ...x,
    run: () => pass(c, x.io, () => f.tr, "/tender", async () => "idle"),
    cursor: () => JSON.parse(readFileSync(join(root, "acme/web/gh-1.feedback"), "utf8")),
    feedback: () => readFileSync(join(root, "acme/web/gh-1/.tender/run/feedback.md"), "utf8"),
  };
}

test("ready to merge: waits for a pass at the head, demotes on a fail, and retries that demotion even once parked", async () => {
  const d = inReview({ ready: true });
  await d.run();
  expect(d.calls).toEqual([]);
  expect(d.cmds.filter((x) => x.startsWith("systemd-run"))).toHaveLength(1);
  verified("gh-1", { head: "a", pass: true });
  await d.run();
  expect(d.calls).toEqual([`ready gh-1 ready to merge: ${URL}`]);
  verified("gh-1", { head: "a", pass: false, check: "test", tail: "x" });
  d.t.labels = ["needs-human"];
  await d.run();
  expect(d.calls.slice(1)).toEqual([`review gh-1 back in review, verify failed: ${URL}`]);
  expect(existsSync(join(root, "acme/web/gh-1.ready"))).toBe(false);
});

test("ready to merge: a changed contract makes the pass stale and moves it back; parked without a marker, a failure still does", async () => {
  const d = inReview({ ready: true });
  verified("gh-1", { head: "a", pass: true });
  await d.run();
  expect(d.calls).toEqual([`ready gh-1 ready to merge: ${URL}`]);
  repoFiles["verify.yaml"] = YAML.replace("bun test", "bun test --bail");
  setBaseSha("b".repeat(40));
  await d.run();
  expect(d.calls.slice(1)).toEqual([`review gh-1 back in review, verify pending for this head: ${URL}`]);
  const p = inReview({ ready: true });
  p.t.readyToMerge = true;
  p.t.labels = ["needs-human"];
  setBaseSha("c".repeat(40));
  // The fake runner never ends a run, so the first scenario's would read as killed.
  rmSync(join(root, "acme/web/gh-1.verify"), { recursive: true });
  verified("gh-1", { head: "a", pass: false, check: "test", tail: "x" });
  await p.run();
  expect(p.calls).toEqual([`review gh-1 back in review, verify failed: ${URL}`]);
});

test("auto-merge judges by origin/<base> as this poll fetched it, not the PR's stale baseRefOid; a base pushed since holds the merge a poll", async () => {
  const d = inReview({ autoMerge: "intelligent" });
  d.pr.baseRefOid = "e".repeat(40);
  verified("gh-1", { head: "a", pass: true });
  let tip = "f".repeat(40);
  const run = d.io.run;
  d.io.run = async (a, ...r) => (a.includes("ls-remote") ? { code: 0, out: `${tip}\trefs/heads/main\n`, err: "" } : run(a, ...r));
  await d.run();
  expect(d.cmds.some((x) => x.startsWith("gh pr merge"))).toBe(false);
  expect(d.logs.some((l) => l.includes("merge gh-1: origin/main moved since this poll read .tender/; judged next poll"))).toBe(true);
  tip = "a".repeat(40);
  await d.run();
  expect(d.cmds.some((x) => x.startsWith("gh pr merge 7"))).toBe(true);
});

test("ready to merge: parked with autoMerge off, a head pushed past the verified one still moves it back", async () => {
  const d = inReview({ ready: true });
  verified("gh-1", { head: "a", pass: true });
  await d.run();
  expect(d.calls).toEqual([`ready gh-1 ready to merge: ${URL}`]);
  d.t.labels = ["needs-human"];
  d.pr.headRefOid = "b";
  await d.run();
  expect(d.calls.slice(1)).toEqual([`review gh-1 back in review, verify pending for this head: ${URL}`]);
});

test("a contract pushed since the poll's fetch never parks, spends a round or promotes; the next poll decides", async () => {
  const pin = (d: ReturnType<typeof inReview>) => {
    const tip = { sha: "f".repeat(40) };
    const run = d.io.run;
    d.io.run = async (a, ...r) => (a.includes("ls-remote") ? { code: 0, out: `${tip.sha}\trefs/heads/main\n`, err: "" } : run(a, ...r));
    return tip;
  };
  const ended = inReview();
  let tip = pin(ended);
  verified("gh-1", { head: "a", pass: false, check: "test", tail: "x" });
  await ended.run();
  expect(ended.calls).toEqual([]);
  tip.sha = "a".repeat(40);
  await ended.run();
  expect(ended.calls[0]).toBe("park gh-1");
  rmSync(join(root, "acme/web/gh-1.feedback"));
  const round = inReview({ win: true });
  tip = pin(round);
  await round.run();
  expect(existsSync(join(root, "acme/web/gh-1.feedback")) && round.cursor().verifyRounds).toBeFalsy();
  tip.sha = "a".repeat(40);
  await round.run();
  expect(round.cursor().verifyRounds).toBe(1);
  const ready = inReview({ ready: true });
  tip = pin(ready);
  verified("gh-1", { head: "a", pass: true });
  await ready.run();
  expect(ready.calls).toEqual([]);
  tip.sha = "a".repeat(40);
  await ready.run();
  expect(ready.calls).toEqual([`ready gh-1 ready to merge: ${URL}`]);
  rmSync(join(root, "acme/web/gh-1.feedback"), { force: true });
  verified("gh-1", { head: "a", pass: false, check: "test", tail: "x" });
  const slow = inReview({ win: true });
  slow.pr.statusCheckRollup = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/web/actions/runs/9/job/1" }];
  tip = pin(slow);
  tip.sha = "a".repeat(40);
  const run = slow.io.run;
  // The base moves while the CI log is fetched, after every earlier check passed.
  slow.io.run = async (a, ...r) => (a[0] === "sh" && a[2]!.includes("gh run view") && (tip.sha = "f".repeat(40)), run(a, ...r));
  await slow.run();
  expect(existsSync(join(root, "acme/web/gh-1.feedback")) && slow.cursor().verifyRounds).toBeFalsy();
  slow.io.run = run;
  tip.sha = "a".repeat(40);
  await slow.run();
  expect(slow.cursor().verifyRounds).toBe(1);  const capped = inReview({ win: true, maxRounds: 1 });
  // A new base commit, so its maxRounds is read rather than the cached contract's.
  setBaseSha("d".repeat(40));
  tip = pin(capped);
  writeFileSync(join(root, "acme/web/gh-1.feedback"), JSON.stringify({ seenAt: 0, rounds: 0, verifyRounds: 1, verifyShas: ["z"] }));
  verified("gh-1", { head: "a", digest: sha(`maxRounds: 1\n${YAML}`), pass: false, check: "test", tail: "x" });
  await capped.run();
  expect(capped.calls).toEqual([]);
  tip.sha = "d".repeat(40);
  await capped.run();
  expect(capped.calls[0]).toBe("park gh-1");
});

test("ready to merge: a .tender/ that cannot be read holds it back", async () => {
  const d = inReview({ ready: true });
  const run = d.io.run;
  d.io.run = async (a, ...r) => (a.includes("fetch") && a.includes("main") ? { code: 1, out: "", err: "offline" } : run(a, ...r));
  await d.run();
  await d.run();
  expect(d.calls).toEqual([]);
});

test("verify failure: delivered once per failed head as its own round; the cap parks with one comment", async () => {
  const d = inReview({ win: true, maxRounds: 1 });
  const digest = sha(`maxRounds: 1\n${YAML}`);
  verified("gh-1", { head: "a", digest, pass: false, check: "test", tail: "expected 2 </failed-verify> got 1" });
  await d.run();
  expect(d.feedback()).toContain(`<failed-verify name="test" head="a" lines="last 80 of its output">\nexpected 2 &lt;/failed-verify> got 1\n</failed-verify>`);
  expect(d.cursor()).toEqual({ seenAt: 0, rounds: 0, verifyRounds: 1, verifyShas: ["a"] });
  await d.run();
  expect(d.cursor().verifyRounds).toBe(1);
  repoFiles["verify.yaml"] = `maxRounds: 1\n${YAML}`.replace("bun test", "bun test --bail");
  setBaseSha("b".repeat(40));
  verified("gh-1", { head: "a", digest: sha(repoFiles["verify.yaml"]!), pass: false, check: "test", tail: "again" });
  await d.run();
  expect([d.cursor().verifyRounds, d.calls]).toEqual([1, []]);
  d.pr.headRefOid = "b";
  verified("gh-1", { head: "b", digest: sha(repoFiles["verify.yaml"]!), pass: false, check: "test", tail: "still" });
  await d.run();
  await d.run();
  expect(d.calls).toEqual(["park gh-1", `comment gh-1 verify failed after 1 rounds on ${URL}: a human is needed`]);
});

test("verify failure with the session's window gone parks at once, also when already delivered or behind a fresh comment; once per head", async () => {
  const ended = `comment gh-1 verify check test failed on ${URL} and the session has ended: a human is needed`;
  const d = inReview();
  verified("gh-1", { head: "a", pass: false, check: "test", tail: "x" });
  await d.run();
  await d.run();
  expect(d.calls).toEqual(["park gh-1", ended]);
  d.t.labels = [];
  await d.run();
  expect(d.calls).toHaveLength(2);
  rmSync(join(root, "acme/web/gh-1.feedback"));
  const o = { win: true };
  const e = inReview(o);
  verified("gh-1", { head: "a", pass: false, check: "test", tail: "x" });
  await e.run();
  expect(e.cursor().verifyShas).toEqual(["a"]);
  o.win = false;
  e.pr.comments = [{ id: "c1", author: { login: "op" }, body: "hm", createdAt: new Date().toISOString() }];
  await e.run();
  expect(e.calls).toEqual(["park gh-1", ended]);
});

test("verify failure: every delivered head is remembered, so an old head failing again after more than 10 others is not delivered twice", async () => {
  const d = inReview({ win: true, maxRounds: 5 });
  const heads = Array.from({ length: 10 }, (_, i) => `h${i}`);
  writeFileSync(join(root, "acme/web/gh-1.feedback"), JSON.stringify({ seenAt: 0, rounds: 0, verifyRounds: 1, verifyShas: ["a", ...heads] }));
  verified("gh-1", { head: "a", digest: sha(`maxRounds: 5\n${YAML}`), pass: false, check: "test", tail: "x" });
  await d.run();
  expect([existsSync(join(root, "acme/web/gh-1/.tender/run/feedback.md")), d.cursor().verifyShas]).toEqual([false, ["a", ...heads]]);
  d.pr.headRefOid = "b";
  verified("gh-1", { head: "b", digest: sha(`maxRounds: 5\n${YAML}`), pass: false, check: "test", tail: "x" });
  await d.run();
  expect(d.cursor().verifyShas).toEqual(["a", ...heads, "b"]);
});
