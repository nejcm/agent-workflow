import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type PrFacts, isCritical, mergeDecision, parseAssessment } from "../src/merge";
import { pass } from "../src/pass";
import { config, fakeIo, fakeTracker, root, ticket, useTempRoot, web, worktree } from "./helpers";

useTempRoot();

const ok = { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" };
const prFacts = (over: Partial<PrFacts> = {}): PrFacts => ({
  state: "OPEN", isDraft: false, isCrossRepository: false, baseRefName: "main", mergeable: "MERGEABLE",
  additions: 10, deletions: 5, changedFiles: 2, files: [{ path: "src/a.ts" }, { path: "src/b.ts" }], statusCheckRollup: [ok], labels: [], ...over,
});
const assess = (over: object = {}) => ({ tested: true, confidence: "high" as const, critical: false, reason: "small fix, tests pass", ...over });
const smart = { autoMerge: "intelligent" as const, criticalPaths: [], baseBranch: "main" };
const medium = { additions: 200, deletions: 100, changedFiles: 8 };

test("merge decision: hard blockers hold back any size and any mode but off", () => {
  const m = (pr: Partial<PrFacts>, a?: object, s: object = smart, labels: string[] = []) => mergeDecision(prFacts(pr), a as any, { ...smart, ...s }, labels);
  expect(m({}, undefined, { autoMerge: "off" })).toEqual({ merge: false, reason: "autoMerge is off" });
  for (const mode of ["intelligent", "all"]) {
    const s = { autoMerge: mode };
    expect(m({ isDraft: true }, undefined, s).reason).toBe("PR is a draft");
    expect(m({ state: "CLOSED" }, undefined, s).merge).toBe(false);
    expect(m({ isCrossRepository: true }, undefined, s).reason).toBe("PR is from a fork");
    expect(m({ baseRefName: "release" }, undefined, s).reason).toBe("PR targets release, not main");
    expect(m({ mergeable: "CONFLICTING" }, undefined, s).reason).toBe("PR has merge conflicts");
    expect(m({ reviewDecision: "CHANGES_REQUESTED" }, undefined, s).reason).toBe("changes requested in review");
    expect(m({ labels: [{ name: "No-AutoMerge" }] }, undefined, s).reason).toBe("labelled no-automerge");
    expect(m({}, undefined, s, ["no-automerge"]).reason).toBe("labelled no-automerge");
    expect(m({ statusCheckRollup: [ok, { status: "COMPLETED", conclusion: "FAILURE" }] }, undefined, s).reason).toBe("1 check(s) failed");
    expect(m({ statusCheckRollup: [{ __typename: "StatusContext", state: "ERROR" }] }, undefined, s).merge).toBe(false);
    expect(m({ statusCheckRollup: [ok, { status: "IN_PROGRESS", conclusion: "" }] }, undefined, s).merge).toBe("wait");
    expect(m({ statusCheckRollup: [{ state: "PENDING" }] }, undefined, s).merge).toBe("wait");
    expect(m({ mergeable: "UNKNOWN" }, undefined, s).merge).toBe("wait");
  }
  expect(m({ files: [{ path: ".github/workflows/ci.yml" }] }).reason).toBe("touches critical path .github/workflows/ci.yml");
  expect(m({}, assess({ critical: true })).reason).toBe("agent marked it critical: small fix, tests pass");
  expect(m({}, assess({ confidence: "low" })).reason).toMatch(/^agent confidence is low/);
});

test("merge decision: all mode has no size, path or assessment gates", () => {
  const d = mergeDecision(prFacts({ additions: 5000, changedFiles: 90, files: [{ path: "package.json" }], statusCheckRollup: [] }), assess({ critical: true, confidence: "low" }), { ...smart, autoMerge: "all" });
  expect(d).toEqual({ merge: true, reason: "autoMerge all" });
});

test("merge decision: size tiers and their boundaries", () => {
  const m = (pr: Partial<PrFacts>, a?: object) => mergeDecision(prFacts(pr), a as any, smart);
  expect(m({ additions: 150, deletions: 0, changedFiles: 5, statusCheckRollup: [] })).toEqual({ merge: true, reason: "small change" });
  expect(m({ additions: 100, deletions: 50, changedFiles: 5 }, assess()).reason).toBe("small change; agent: small fix, tests pass");
  expect(m({ additions: 100, changedFiles: 1 }, assess({ tested: false, confidence: "medium" })).merge).toBe(true);
  expect(m({ additions: 151, deletions: 0, changedFiles: 1 }).reason).toBe("medium change without a valid .aw/merge.json");
  expect(m({ additions: 1, deletions: 0, changedFiles: 6 }).reason).toBe("medium change without a valid .aw/merge.json");
  expect(m({ additions: 500, deletions: 0, changedFiles: 15 }, assess())).toEqual({ merge: true, reason: "medium change; agent: small fix, tests pass" });
  expect(m({ ...medium, statusCheckRollup: [ok, { status: "QUEUED" }] }, assess()).merge).toBe("wait");
  expect(m({ ...medium, statusCheckRollup: [] }, assess()).reason).toBe("medium change with no successful check");
  expect(m(medium, assess({ tested: false })).reason).toMatch(/^medium change needs tested \+ high confidence/);
  expect(m(medium, assess({ confidence: "medium" })).merge).toBe(false);
  expect(m({ additions: 501, deletions: 0, changedFiles: 1 }, assess()).reason).toBe("too large (501 lines, 1 files)");
  expect(m({ additions: 1, deletions: 0, changedFiles: 16 }, assess()).merge).toBe(false);
});

test("critical paths: built-ins, case-insensitive, any depth without a slash, config extends", () => {
  for (const p of [".github/workflows/ci.yml", "Dockerfile", "svc/Dockerfile.dev", "docker-compose.yml", "db/migrations/001.sql", "q.SQL", "package.json", "web/package.json", "bun.lockb", "go.sum",
    "requirements-dev.txt", "src/auth/login.ts", "config/client_secret.json", ".env", "app/.env.local", "certs/x.pem", "id.key", "nono/aw-claude.json", "aw.json", "infra/main.tf", "ops/terraform/x", "deploy/run.sh", "SRC/Auth/x.ts"])
    expect([p, isCritical(p)]).toEqual([p, true]);
  for (const p of ["src/a.ts", "README.md", "docs/github.md", "src/authors.ts", "nono.md", "src/nono/x.ts", "keys.ts"]) expect([p, isCritical(p)]).toEqual([p, false]);
  expect(isCritical("src/billing/pay.ts")).toBe(false);
  expect(isCritical("src/billing/pay.ts", ["src/billing/**"])).toBe(true);
  expect(isCritical("lib/x.proto", ["*.proto"])).toBe(true);
  expect(isCritical("a.b", ["a?b"])).toBe(true);
  expect(isCritical("ab", ["a.b"])).toBe(false);
  expect(mergeDecision(prFacts({ files: [{ path: "src/billing/pay.ts" }] }), undefined, { ...smart, criticalPaths: ["src/billing/**"] }).reason).toBe("touches critical path src/billing/pay.ts");
});

test("merge assessment: strict shape", () => {
  expect(parseAssessment(JSON.stringify(assess({ reason: "  ok  " })))).toEqual(assess({ reason: "ok" }));
  for (const bad of [assess({ tested: "yes" }), assess({ confidence: "certain" }), assess({ reason: "" }), assess({ reason: "a\nb" }), assess({ reason: "x".repeat(301) }), assess({ extra: 1 }), [assess()], null])
    expect(() => parseAssessment(JSON.stringify(bad))).toThrow("merge: invalid");
});

test("auto-merge pass: merges only when enabled, pinned to the head; not-merged comment once per SHA", async () => {
  let facts: any = { ...prFacts(), number: 7, url: "https://github.com/acme/web/pull/7", headRefOid: "a".repeat(40) };
  const respond = (a: string[]) =>
    a[1] === "pr" && a[2] === "list" ? { out: '[{"url":"https://github.com/acme/web/pull/7","state":"OPEN"}]' } : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(a.at(-1) === "state" ? { state: "MERGED" } : facts) } : undefined;
  const run = async (autoMerge: string, dry = false) => {
    const { tr, calls } = fakeTracker({ inReview: [ticket(1)] });
    const { io, cmds, logs } = fakeIo(respond, dry);
    worktree("gh-1");
    await pass(config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge }] }), io, () => tr, "/aw");
    return { calls, merges: [...cmds, ...logs].filter((x) => x.includes("gh pr merge")), cmds };
  };

  const off = await run("off");
  expect(off.cmds.some((x) => x.includes("gh pr view"))).toBe(false);
  expect(off.calls).toEqual([]);

  const dry = await run("all", true);
  expect(dry.merges).toEqual([`[web] dry: gh pr merge 7 --repo acme/web --squash --delete-branch --match-head-commit ${"a".repeat(40)}`]);

  const all = await run("all");
  expect(all.merges[0]).toBe(`gh pr merge 7 --repo acme/web --squash --delete-branch --match-head-commit ${"a".repeat(40)}`);
  expect(all.merges.join(" ")).not.toContain("--admin");
  expect(all.calls).toEqual(["comment gh-1 auto-merged https://github.com/acme/web/pull/7: autoMerge all", "done gh-1"]);

  facts = { ...facts, files: [{ path: "package.json" }] };
  const blocked = [await run("intelligent"), await run("intelligent")];
  expect(blocked.flatMap((r) => r.merges)).toEqual([]);
  expect(blocked.flatMap((r) => r.calls)).toEqual(["comment gh-1 not auto-merged: touches critical path package.json"]);
  facts = { ...facts, headRefOid: "b".repeat(40) };
  expect((await run("intelligent")).calls).toEqual(["comment gh-1 not auto-merged: touches critical path package.json"]);

  facts = { ...facts, statusCheckRollup: [{ status: "IN_PROGRESS" }], files: [{ path: "src/a.ts" }], headRefOid: "c".repeat(40) };
  const waiting = await run("intelligent");
  expect([waiting.calls, waiting.merges]).toEqual([[], []]);

  facts = { ...facts, state: "MERGED" };
  expect((await run("intelligent")).calls).toEqual(["done gh-1"]);
});

test("auto-merge pass: parked tickets only get the merged-by-hand recovery; a fresh parked read gates the merge", async () => {
  let facts: any = { ...prFacts(), number: 7, url: "https://github.com/acme/web/pull/7", headRefOid: "a".repeat(40) };
  const run = async (labels: string[], parked?: () => Promise<boolean>) => {
    const f = fakeTracker({ inReview: [{ ...ticket(1), labels }] });
    if (parked) f.tr.parked = parked;
    const { io, cmds } = fakeIo((a) => (a[1] === "pr" && a[2] === "list" ? { out: '[{"url":"https://github.com/acme/web/pull/7","state":"OPEN"}]' } : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(facts) } : undefined));
    worktree("gh-1");
    await pass(config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "all" }] }), io, () => f.tr, "/aw");
    return { calls: f.calls, merges: cmds.filter((x) => x.startsWith("gh pr merge")) };
  };
  expect(await run(["Needs-Human"])).toEqual({ calls: [], merges: [] });
  expect(await run(["agent"], async () => true)).toEqual({ calls: [], merges: [] });
  expect(await run(["agent"], () => Promise.reject(new Error("gh down")))).toEqual({ calls: [], merges: [] });
  expect((await run(["agent"])).merges).toHaveLength(1);
  facts = { ...facts, state: "MERGED" };
  expect(await run(["needs-human"])).toEqual({ calls: ["done gh-1"], merges: [] });
});

test("auto-merge pass: a held marker for an older head is cleared while the new head waits", async () => {
  const facts = { ...prFacts({ statusCheckRollup: [{ status: "IN_PROGRESS" }] }), number: 7, url: "https://github.com/acme/web/pull/7", headRefOid: "b".repeat(40) };
  const respond = (a: string[]) => (a[1] === "pr" && a[2] === "list" ? { out: '[{"url":"https://github.com/acme/web/pull/7","state":"OPEN"}]' } : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(facts) } : undefined);
  const c = config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "intelligent" }] });
  const marker = join(root, "acme/web/gh-1.merge");
  worktree("gh-1");
  for (const [sha, kept] of [["a".repeat(40), false], ["b".repeat(40), true]] as const) {
    writeFileSync(marker, sha);
    const { tr, calls } = fakeTracker({ inReview: [ticket(1)] });
    await pass(c, fakeIo(respond).io, () => tr, "/aw");
    expect([existsSync(marker), calls]).toEqual([kept, []]);
  }
  facts.state = "MERGED";
  const { tr, calls } = fakeTracker({ inReview: [ticket(1)] });
  writeFileSync(marker, "a".repeat(40));
  await pass(c, fakeIo(respond).io, () => tr, "/aw");
  expect([existsSync(marker), calls]).toEqual([false, ["done gh-1"]]);
});

test("auto-merge pass: medium needs the agent's merge.json; a symlinked one is ignored", async () => {
  const facts = { ...prFacts(medium), number: 7, url: "https://github.com/acme/web/pull/7", headRefOid: "a".repeat(40) };
  const c = config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "intelligent" }] });
  const respond = (a: string[]) => (a[1] === "pr" && a[2] === "list" ? { out: '[{"url":"https://github.com/acme/web/pull/7","state":"OPEN"}]' } : a[2] === "view" && a[1] === "pr" ? { out: JSON.stringify(a.at(-1) === "state" ? { state: "MERGED" } : facts) } : undefined);
  worktree("gh-1");
  mkdirSync(join(root, "acme/web/gh-1/.aw"));
  writeFileSync(join(root, "outside.json"), JSON.stringify(assess()));
  symlinkSync(join(root, "outside.json"), join(root, "acme/web/gh-1/.aw/merge.json"));
  const a = fakeTracker({ inReview: [ticket(1)] });
  const x = fakeIo(respond);
  await pass(c, x.io, () => a.tr, "/aw");
  expect(x.logs.some((l) => l.includes("merge gh-1: .aw/merge.json ignored: ELOOP"))).toBe(true);
  expect(a.calls).toEqual(["comment gh-1 not auto-merged: medium change without a valid .aw/merge.json"]);
  rmSync(join(root, "acme/web/gh-1/.aw/merge.json"));
  writeFileSync(join(root, "acme/web/gh-1/.aw/merge.json"), JSON.stringify(assess()));
  const b = fakeTracker({ inReview: [ticket(1)] });
  const y = fakeIo(respond);
  await pass(c, y.io, () => b.tr, "/aw");
  expect(y.cmds.some((l) => l.startsWith("gh pr merge 7"))).toBe(true);
  expect(b.calls).toEqual(["comment gh-1 auto-merged https://github.com/acme/web/pull/7: medium change; agent: small fix, tests pass", "done gh-1"]);
});

test("merge decision: renames, newline paths and skipped-only checks are held back", () => {
  expect(isCritical("pkg\n/package.json")).toBe(true);
  expect(isCritical("x\n/infra/main.tf")).toBe(true);
  expect(mergeDecision(prFacts({ files: [{ path: "src/login.ts", changeType: "RENAMED" }] }), undefined, smart).reason).toBe("renames src/login.ts; its old path is not checked");
  expect(mergeDecision(prFacts({ files: [{ path: "src/login.ts", changeType: "RENAMED" }] }), undefined, { ...smart, autoMerge: "all" }).merge).toBe(true);
  const skipped = { status: "COMPLETED", conclusion: "SKIPPED" };
  const m = (statusCheckRollup: any[]) => mergeDecision(prFacts({ ...medium, statusCheckRollup }), assess(), smart);
  expect(m([skipped, { status: "COMPLETED", conclusion: "NEUTRAL" }]).reason).toBe("medium change with no successful check");
  expect(m([skipped, { state: "SUCCESS" }]).merge).toBe(true);
  expect(mergeDecision(prFacts({ statusCheckRollup: [skipped] }), undefined, smart).merge).toBe(true);
});

test("auto-merge pass: a head that moves before the merge re-check drops a held marker for the old head", async () => {
  const pr = { ...prFacts(), number: 7, url: "https://github.com/acme/web/pull/7", headRefOid: "a".repeat(40) };
  const views = [pr, { ...pr, headRefOid: "b".repeat(40) }];
  const { tr, calls } = fakeTracker({ inReview: [ticket(1)] });
  const { io, cmds } = fakeIo((a) =>
    a[1] === "pr" && a[2] === "list" ? { out: '[{"url":"https://github.com/acme/web/pull/7","state":"OPEN"}]' }
    : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(views.shift()) }
    : a[1] === "repo" && a[2] === "view" ? { out: JSON.stringify({ nameWithOwner: "acme/web" }) } : undefined);
  worktree("gh-1");
  const marker = join(root, "acme/web/gh-1.merge");
  writeFileSync(marker, "a".repeat(40));
  await pass(config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "all" }] }), io, () => tr, "/aw");
  expect([existsSync(marker), calls, cmds.some((x) => x.startsWith("gh pr merge"))]).toEqual([false, [], false]);
});

test("auto-merge pass: re-checks the PR right before merging, confirms it merged, guards the merged recovery", async () => {
  const pr = { ...prFacts(), number: 7, url: "https://github.com/acme/web/pull/7", headRefOid: "a".repeat(40) };
  const run = async (views: any[], state = "MERGED", owner = "acme/web") => {
    const { tr, calls } = fakeTracker({ inReview: [ticket(1)] });
    const { io, cmds, logs } = fakeIo((a) =>
      a[1] === "pr" && a[2] === "list" ? { out: '[{"url":"https://github.com/acme/web/pull/7","state":"MERGED"}]' }
      : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(a.at(-1) === "state" ? { state } : views.shift()) }
      : a[1] === "repo" && a[2] === "view" ? { out: JSON.stringify({ nameWithOwner: owner }) } : undefined);
    worktree("gh-1");
    await pass(config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "all" }] }), io, () => tr, "/aw");
    return { calls, logs, merged: cmds.some((x) => x.startsWith("gh pr merge")) };
  };
  for (const now of [{ baseRefName: "release" }, { headRefOid: "b".repeat(40) }, { isDraft: true }, { state: "CLOSED" }])
    expect(await run([pr, { ...pr, ...now }]).then((r) => [r.merged, r.calls])).toEqual([false, []]);
  const queued = await run([pr, pr], "OPEN");
  expect([queued.merged, queued.calls]).toEqual([true, []]);
  expect(queued.logs).toContain("[web] merge gh-1: https://github.com/acme/web/pull/7 is OPEN after gh pr merge, rechecking next poll");
  expect((await run([pr, pr])).calls).toEqual(["comment gh-1 auto-merged https://github.com/acme/web/pull/7: autoMerge all", "done gh-1"]);
  for (const over of [{ isCrossRepository: true }, { baseRefName: "release" }]) expect((await run([{ ...pr, ...over, state: "MERGED" }])).calls).not.toContain("done gh-1");
  expect((await run([{ ...pr, state: "MERGED" }], "MERGED", "evil/web")).calls).toEqual([]);
  expect((await run([{ ...pr, state: "MERGED" }])).calls).toEqual(["done gh-1"]);
});

test("in review: .pr comes from autoMerge's lookup, else its own lookup each poll when off; unchanged is not rewritten, dry run writes none", async () => {
  let url = "https://github.com/acme/web/pull/7";
  const f = join(root, "acme/web/gh-1.pr");
  const respond = (a: string[]) => (a[1] === "pr" && a[2] === "list" ? { out: JSON.stringify([{ url, state: "OPEN" }]) } : a[1] === "pr" ? { out: JSON.stringify({ ...prFacts(), number: 7, url, headRefOid: "a" }) } : undefined);
  const run = async (autoMerge: string, dry = false) => {
    const x = fakeIo(respond, dry);
    await pass(config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge }] }), x.io, () => fakeTracker({ inReview: [ticket(1)] }).tr, "/aw");
    return { lookups: x.cmds.filter((c) => c.startsWith("gh pr list")).length, writes: x.logs.filter((l) => l.endsWith(`write ${f}`)).length };
  };
  worktree("gh-1");
  expect(await run("all", true)).toMatchObject({ lookups: 1, writes: 1 });
  expect(existsSync(f)).toBe(false);
  expect(await run("off")).toEqual({ lookups: 1, writes: 1 });
  expect(readFileSync(f, "utf8")).toBe(url);
  expect(await run("off")).toEqual({ lookups: 1, writes: 0 });
  url = "https://github.com/acme/web/pull/9";
  expect(await run("off")).toEqual({ lookups: 1, writes: 1 });
  expect(readFileSync(f, "utf8")).toBe(url);
  expect(await run("intelligent")).toEqual({ lookups: 1, writes: 0 });
  url = "https://github.com/acme/web/pull/8";
  expect(await run("intelligent")).toEqual({ lookups: 1, writes: 1 });
  expect(readFileSync(f, "utf8")).toBe(url);
});
