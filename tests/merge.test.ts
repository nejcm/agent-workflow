import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addedLines, ESCAPE_HATCHES, escapeHatch, hatchInWorker } from "../src/review/hatch";
import { type PrFacts, isCritical, isTest, mergeDecision, parseAssessment, prMode } from "../src/review/merge";
import { openDb, recorder } from "../src/db";
import { pass } from "../src/pass";
import { rows } from "../src/ui/status";
import { configCache } from "../src/config/repo-config";
import { config, fakeIo, fakeTracker, repoFiles, root, ticket, useTempRoot, web, windowsOut, worktree } from "./helpers";

useTempRoot();

const ok = { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" };
const file = (filename: string, over: object = {}) => ({ filename, status: "modified", additions: 1, deletions: 0, ...over });
const prFacts = (over: Partial<PrFacts> = {}): PrFacts => {
  const files = over.files ?? Array.from({ length: over.changedFiles ?? 2 }, (_, i) => file(`src/${i}.ts`));
  return {
    state: "OPEN", isDraft: false, isCrossRepository: false, baseRefName: "main", mergeable: "MERGEABLE",
    additions: 10, deletions: 5, statusCheckRollup: [ok], labels: [], ...over, files, changedFiles: over.changedFiles ?? files.length,
  };
};
const assess = (over: object = {}) => ({ tested: true, confidence: "high" as const, critical: false, reviewed: true, reviewer: "gpt-5", reason: "small fix, tests pass", ...over });
const smart = { autoMerge: "intelligent" as const, ceiling: "all" as const, trust: [], escapeHatches: [], criticalPaths: [], testPaths: [], baseBranch: "main", intake: [] };
const medium = { additions: 200, deletions: 100, changedFiles: 8 };
const filesOut = (pr: PrFacts) => ({ out: pr.files!.map((f) => JSON.stringify(f)).join("\n") });

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
  expect(m({ files: [file(".github/workflows/ci.yml")] }).reason).toBe("touches critical path .github/workflows/ci.yml");
  expect(m({}, assess({ critical: true })).reason).toBe("agent marked it critical: small fix, tests pass");
  expect(m({}, assess({ confidence: "low" })).reason).toMatch(/^agent confidence is low/);
});

test("merge decision: all mode has no size, test or assessment gates; critical paths still hold it back", () => {
  const all = { ...smart, autoMerge: "all" as const };
  const big = { additions: 5000, statusCheckRollup: [] };
  expect(mergeDecision(prFacts({ ...big, files: [file("src/a.ts"), file("tests/a.test.ts", { deletions: 9 })] }), assess({ critical: true, confidence: "low" }), all)).toEqual({ merge: true, reason: "autoMerge all" });
  expect(mergeDecision(prFacts({ ...big, files: [file("package.json")] }), undefined, all).reason).toBe("touches critical path package.json");
});

test("merge decision: size tiers and their boundaries", () => {
  const m = (pr: Partial<PrFacts>, a?: object) => mergeDecision(prFacts(pr), a as any, smart);
  expect(m({ additions: 150, deletions: 0, changedFiles: 5, statusCheckRollup: [] })).toEqual({ merge: true, reason: "small change" });
  expect(m({ additions: 100, deletions: 50, changedFiles: 5 }, assess()).reason).toBe("small change; agent: small fix, tests pass");
  expect(m({ additions: 100, changedFiles: 1 }, assess({ tested: false, confidence: "medium" })).merge).toBe(true);
  expect(m({ additions: 151, deletions: 0, changedFiles: 1 }).reason).toBe("medium change without a valid .tender/run/merge.json");
  expect(m({ additions: 1, deletions: 0, changedFiles: 6 }).reason).toBe("medium change without a valid .tender/run/merge.json");
  expect(m({ additions: 500, deletions: 0, changedFiles: 15 }, assess())).toEqual({ merge: true, reason: "medium change; agent: small fix, tests pass" });
  expect(m({ ...medium, statusCheckRollup: [ok, { status: "QUEUED" }] }, assess()).merge).toBe("wait");
  expect(m({ ...medium, statusCheckRollup: [] }, assess()).reason).toBe("medium change with no successful check");
  expect(m(medium, assess({ tested: false })).reason).toMatch(/^medium change needs tested \+ high confidence/);
  for (const reviewed of [false, undefined]) expect(m(medium, assess({ reviewed, reviewer: undefined })).reason).toBe("medium change not reviewed by a model from another family: small fix, tests pass");
  expect(m({ additions: 100, changedFiles: 1 }, assess({ reviewed: false })).merge).toBe(true);
  expect(m(medium, assess({ confidence: "medium" })).merge).toBe(false);
  expect(m({ additions: 501, deletions: 0, changedFiles: 1 }, assess()).reason).toBe("too large (501 lines, 1 files)");
  expect(m({ additions: 1, deletions: 0, changedFiles: 16 }, assess()).merge).toBe(false);
});

test("critical paths: built-ins, case-insensitive, any depth without a slash, config extends", () => {
  for (const p of [".github/workflows/ci.yml", "Dockerfile", "svc/Dockerfile.dev", "docker-compose.yml", "db/migrations/001.sql", "q.SQL", "package.json", "web/package.json", "bun.lockb", "go.sum",
    "requirements-dev.txt", "src/auth/login.ts", "config/client_secret.json", ".env", "app/.env.local", "certs/x.pem", "id.key", "nono/tender-claude.json", "tender.json", "infra/main.tf", "ops/terraform/x", "deploy/run.sh", "SRC/Auth/x.ts"])
    expect([p, isCritical(p)]).toEqual([p, true]);
  for (const p of [".oxlintrc.json", ".c8rc.json", "nyc.config.js", "codecov.yaml", "Taskfile.dist.yml", "lefthook.yml", "turbo.json", "nx.json", "Rakefile", "phpunit.xml.dist", "jest.setup.ts", ".drone.yml", "appveyor.yml"]) expect([p, isCritical(p)]).toEqual([p, true]);
  for (const p of ["src/a.ts", "README.md", "docs/github.md", "src/authors.ts", "nono.md", "src/nono/x.ts", "keys.ts"]) expect([p, isCritical(p)]).toEqual([p, false]);
  expect(isCritical("src/billing/pay.ts")).toBe(false);
  expect(isCritical("src/billing/pay.ts", ["src/billing/**"])).toBe(true);
  expect(isCritical("lib/x.proto", ["*.proto"])).toBe(true);
  expect(isCritical("a.b", ["a?b"])).toBe(true);
  expect(isCritical("ab", ["a.b"])).toBe(false);
  for (const [g, p] of [["/infra/**", "infra/main.tf"], ["infra/", "infra/main.tf"], ["infra/", "ops/infra/x"], ["payments", "src/payments/x.ts"], ["/Makefile2", "Makefile2"]]) expect([g, p, isCritical(p, [g])]).toEqual([g, p, true]);
  expect(isCritical("ops/Makefile2", ["/Makefile2"])).toBe(false);
  for (const [g, p] of [["app/[id]/**", "app/[id]/page.tsx"], ["docs/**", "Docs/x.ts"]]) expect([g, p, isCritical(p, [g])]).toEqual([g, p, true]);
  expect(isCritical("app/i/page.tsx", ["app/[id]/**"])).toBe(false);
  expect([isCritical("notes.md/evil.ts", ["*.md"]), isCritical("docs/a.md/x.ts", ["docs/*.md"])]).toEqual([false, false]);
  const intake = (run: string, path: string) => mergeDecision(prFacts({ files: [file(path)] }), undefined, { ...smart, intake: [{ run }] } as any).reason;
  expect(intake("scripts/intake/sentry.ts", "scripts/intake/pg.ts")).toBe("touches critical path scripts/intake/pg.ts");
  expect(intake("sentry.ts", "sentry.ts")).toBe("touches critical path sentry.ts");
  expect(intake("sentry.ts", "src/sentry.ts")).toBe("small change");
  expect(mergeDecision(prFacts({ files: [file("src/billing/pay.ts")] }), undefined, { ...smart, criticalPaths: ["src/billing/**"] }).reason).toBe("touches critical path src/billing/pay.ts");
});

test("critical paths: agent config, manifests and infra, dot dirs at any depth", () => {
  for (const p of ["AGENTS.md", "pkg/agents.md", "CLAUDE.md", "docs/CLAUDE.md", ".claude/settings.json", "web/.claude/commands/x.md", ".codex/config.toml", ".mcp.json", "svc/.mcp.json",
    "uv.lock", "poetry.lock", "Gemfile", "api/Gemfile.lock", "main.tf", "ops/net/vpc.TF", "k8s/deploy.yaml", "ops/k8s/a.yml", "charts/helm/values.yaml"])
    expect([p, isCritical(p)]).toEqual([p, true]);
  for (const p of ["src/claude.ts", "docs/agents/intro.md", "src/codex/run.ts", "mcp.json", "Gemfile.md", "x.tfstate.ts", "src/k8s.ts", "helmet/x.ts"]) expect([p, isCritical(p)]).toEqual([p, false]);
});

test("test paths: built-ins, config extends", () => {
  for (const p of ["src/a.test.ts", "web/b.spec.tsx", "tests/x.ts", "pkg/test/x.rb", "src/__tests__/a.js", "e2e/login.ts", "app/test_api.py", "srv/h_test.go", "m_test.py", "Tests/X.ts"])
    expect([p, isTest(p)]).toEqual([p, true]);
  for (const p of ["src/testing.ts", "src/latest.ts", "contest/x.ts", "test.py", "src/attest.go"]) expect([p, isTest(p)]).toEqual([p, false]);
  expect(isTest("qa/x.ts", ["qa/**"])).toBe(true);
});

test("merge decision: rewriting an existing test is held back, adding to one is not", () => {
  const m = (f: object, testPaths: string[] = []) => mergeDecision(prFacts({ files: [file("src/a.ts"), f as any] }), undefined, { ...smart, testPaths });
  expect(m(file("tests/a.test.ts", { status: "added", additions: 40 })).merge).toBe(true);
  expect(m(file("tests/a.test.ts", { additions: 20 })).merge).toBe(true);
  expect(m(file("tests/a.test.ts", { deletions: 3 })).reason).toBe("changes existing test tests/a.test.ts (modified, 3 deletions)");
  expect(m(file("tests/a.test.ts", { status: "removed", additions: 0, deletions: 0 })).reason).toBe("changes existing test tests/a.test.ts (removed, 0 deletions)");
  expect(m(file("tests/fixtures/a.png", { additions: 0, deletions: 0 })).reason).toBe("changes existing test tests/fixtures/a.png (modified, 0 deletions)");
  expect(m(file("tests/fixtures/a.png", { status: "added", additions: 0, deletions: 0 })).merge).toBe(true);
  expect(m(file("old/a.ts", { status: "renamed", previous_filename: "tests/a.test.ts", additions: 0 })).merge).toBe(false);
  expect(m(file("qa/a.ts", { deletions: 1 })).merge).toBe(true);
  expect(m(file("qa/a.ts", { deletions: 1 }), ["qa/**"]).merge).toBe(false);
  expect(mergeDecision(prFacts({ files: [file("tests/a.test.ts", { deletions: 9 })] }), undefined, { ...smart, autoMerge: "all" }).merge).toBe(true);
});

test("merge assessment: strict shape", () => {
  expect(parseAssessment(JSON.stringify(assess({ reason: "  ok  " })))).toEqual(assess({ reason: "ok" }));
  expect(parseAssessment(JSON.stringify(assess({ reviewed: undefined, reviewer: undefined })))).toEqual(assess({ reviewed: false, reviewer: undefined }));
  expect(parseAssessment(JSON.stringify(assess({ reviewed: false, reviewer: "gpt-5" }))).reviewed).toBe(false);
  for (const bad of [assess({ reviewed: "yes" }), assess({ reviewer: undefined }), assess({ reviewer: " " }), assess({ reviewer: "a\nb" }), assess({ reviewer: "x".repeat(101) }), assess({ tested: "yes" }), assess({ confidence: "certain" }), assess({ reason: "" }), assess({ reason: "a\nb" }), assess({ reason: "x".repeat(301) }), assess({ extra: 1 }), [assess()], null])
    expect(() => parseAssessment(JSON.stringify(bad))).toThrow("merge: invalid");
});

test("auto-merge pass: merges only when enabled, pinned to the head; not-merged comment once per SHA", async () => {
  let facts: any = { ...prFacts(), number: 7, url: "https://github.com/acme/web/pull/7", baseRefOid: "f".repeat(40), headRefOid: "a".repeat(40) };
  const respond = (a: string[]) =>
    a[1] === "pr" && a[2] === "list" ? { out: '[{"url":"https://github.com/acme/web/pull/7","state":"OPEN"}]' } : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(a.at(-1) === "state" ? { state: "MERGED" } : facts) }
    : a[1] === "api" && a[3] === "repos/acme/web/pulls/7/files?per_page=100" ? { out: facts.files.map((f: object) => JSON.stringify(f)).join("\n") } : undefined;
  const run = async (autoMerge: string, dry = false) => {
    const { tr, calls } = fakeTracker({ inReview: [ticket(1)] });
    const { io, cmds, logs } = fakeIo(respond, dry);
    const events: string[] = [];
    worktree("gh-1");
    await pass(config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge }] }), { ...io, event: (kind, repo, id, data) => void events.push(`${kind} ${repo}/${id} ${JSON.stringify(data ?? {})}`) }, () => tr, "/tender");
    return { calls, merges: [...cmds, ...logs].filter((x) => x.includes("gh pr merge")), cmds, events };
  };

  const off = await run("off");
  expect(off.cmds.filter((x) => x.startsWith("gh pr view"))).toHaveLength(1);
  expect(off.calls).toEqual([]);

  const dry = await run("all", true);
  expect(dry.merges).toEqual([`[web] dry: gh pr merge 7 --repo acme/web --squash --delete-branch --match-head-commit ${"a".repeat(40)}`]);

  const all = await run("all");
  expect(all.merges[0]).toBe(`gh pr merge 7 --repo acme/web --squash --delete-branch --match-head-commit ${"a".repeat(40)}`);
  expect(all.merges.join(" ")).not.toContain("--admin");
  expect(all.calls).toEqual(["comment gh-1 auto-merged https://github.com/acme/web/pull/7: autoMerge all", "done gh-1"]);
  expect(all.events).toEqual(['merged acme/web/gh-1 {"pr":"https://github.com/acme/web/pull/7","auto":true,"mode":"all","reason":"autoMerge all"}', 'done acme/web/gh-1 {"pr":"https://github.com/acme/web/pull/7"}']);
  const files = "gh api --paginate repos/acme/web/pulls/7/files?per_page=100 --jq .[] | {filename, previous_filename, status, additions, deletions}";
  const diff = `bash -c set -o pipefail; gh api -H "Accept: application/vnd.github.diff" "$1" | head -c "$2" bash repos/acme/web/compare/${"f".repeat(40)}...${"a".repeat(40)} 2097153`;
  expect(dry.cmds.filter((x) => x.includes("gh api"))).toEqual([files, diff]);
  // The diff is read once per head SHA.
  expect(all.cmds.filter((x) => x.includes("gh api"))).toEqual([files]);

  facts = { ...facts, files: [file("package.json")], changedFiles: 1 };
  const blocked = [await run("intelligent"), await run("intelligent")];
  expect(blocked.flatMap((r) => r.merges)).toEqual([]);
  expect(blocked.flatMap((r) => r.calls)).toEqual(["comment gh-1 not auto-merged: touches critical path package.json"]);
  facts = { ...facts, headRefOid: "b".repeat(40) };
  expect((await run("intelligent")).calls).toEqual(["comment gh-1 not auto-merged: touches critical path package.json"]);

  facts = { ...facts, statusCheckRollup: [{ status: "IN_PROGRESS" }], files: [file("src/a.ts")], changedFiles: 1, headRefOid: "c".repeat(40) };
  const waiting = await run("intelligent");
  expect([waiting.calls, waiting.merges]).toEqual([[], []]);

  facts = { ...facts, statusCheckRollup: [ok], files: [file("src/a.ts"), file("old.ts", { status: "renamed", previous_filename: "package.json" })], changedFiles: 2, headRefOid: "d".repeat(40) };
  const shadowBlocked = [await run("shadow"), await run("shadow")];
  expect([shadowBlocked.flatMap((r) => r.calls), shadowBlocked.flatMap((r) => r.merges)]).toEqual([["comment gh-1 not auto-merged: touches critical path package.json"], []]);
  facts = { ...facts, files: [file("src/a.ts")], changedFiles: 1, headRefOid: "e".repeat(40) };
  const shadow = [await run("shadow"), await run("shadow")];
  expect([shadow.flatMap((r) => r.calls), shadow.flatMap((r) => r.merges)]).toEqual([["comment gh-1 would auto-merge: small change"], []]);
  expect(shadow.flatMap((r) => r.events)).toEqual([`gate acme/web/gh-1 {"pr":"https://github.com/acme/web/pull/7","head":"${"e".repeat(40)}","mode":"shadow","merge":true,"reason":"small change"}`]);

  facts = { ...facts, state: "MERGED" };
  expect((await run("intelligent")).calls).toEqual(["done gh-1"]);
});

test("a merge queue rejecting --delete-branch is retried without it, which enqueues the PR", async () => {
  const facts: any = { ...prFacts(), number: 7, url: "https://github.com/acme/web/pull/7", baseRefOid: "f".repeat(40), headRefOid: "a".repeat(40) };
  const { io, cmds } = fakeIo((a) =>
    a[1] === "pr" && a[2] === "list" ? { out: '[{"url":"https://github.com/acme/web/pull/7","state":"OPEN"}]' }
    : a[1] === "pr" && a[2] === "merge" && a.includes("--delete-branch") ? { code: 1, err: "X Cannot use `-d` or `--delete-branch` when merge queue enabled" }
    : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(facts) }
    : a[1] === "api" ? filesOut(facts) : undefined);
  const f = fakeTracker({ inReview: [ticket(1)] });
  worktree("gh-1");
  await pass(config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "all" }] }), io, () => f.tr, "/tender");
  expect(cmds.filter((x) => x.startsWith("gh pr merge"))).toEqual([
    `gh pr merge 7 --repo acme/web --squash --delete-branch --match-head-commit ${"a".repeat(40)}`,
    `gh pr merge 7 --repo acme/web --squash --match-head-commit ${"a".repeat(40)}`,
  ]);
  expect(f.calls).toEqual([]);
});

test("a merge whose done fails is recorded once, as tender's, when the next poll completes it", async () => {
  const facts: any = { ...prFacts(), number: 7, url: "https://github.com/acme/web/pull/7", baseRefOid: "f".repeat(40), headRefOid: "a".repeat(40) };
  let merged = false;
  const { io, logs } = fakeIo((a) =>
    a[1] === "pr" && a[2] === "list" ? { out: '[{"url":"https://github.com/acme/web/pull/7","state":"OPEN"}]' }
    : a[1] === "pr" && a[2] === "merge" ? void (merged = true)
    : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(merged ? { ...facts, state: "MERGED" } : facts) }
    : a[1] === "api" ? filesOut(facts) : undefined);
  const event = recorder(join(root, "tender.db"), "box", (m) => logs.push(m));
  const f = fakeTracker({ inReview: [ticket(1)] });
  const done = f.tr.done;
  f.tr.done = async () => {
    throw new Error("done failed");
  };
  worktree("gh-1");
  const c = config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "all" }] });
  await pass(c, { ...io, event }, () => f.tr, "/tender");
  f.tr.done = done;
  await pass(c, { ...io, event }, () => f.tr, "/tender");
  expect(f.calls.filter((x) => x.startsWith("done"))).toEqual(["done gh-1"]);
  const db = openDb(join(root, "tender.db"));
  expect(db.query<{ kind: string; data: string }, []>("SELECT kind, data FROM events").all().map((e) => [e.kind, JSON.parse(e.data).auto])).toEqual([["merged", true], ["done", undefined]]);
  db.close();
});

test("auto-merge pass: parked tickets only get the merged-by-hand recovery; a fresh parked read gates the merge", async () => {
  let facts: any = { ...prFacts(), number: 7, url: "https://github.com/acme/web/pull/7", headRefOid: "a".repeat(40) };
  const run = async (labels: string[], parked?: () => Promise<boolean>) => {
    const f = fakeTracker({ inReview: [{ ...ticket(1), labels }] });
    if (parked) f.tr.parked = parked;
    const { io, cmds } = fakeIo((a) => (a[1] === "pr" && a[2] === "list" ? { out: '[{"url":"https://github.com/acme/web/pull/7","state":"OPEN"}]' } : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(facts) } : a[1] === "api" ? filesOut(facts) : undefined));
    worktree("gh-1");
    await pass(config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "all" }] }), io, () => f.tr, "/tender");
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
    await pass(c, fakeIo(respond).io, () => tr, "/tender");
    expect([existsSync(marker), calls]).toEqual([kept, []]);
  }
  facts.state = "MERGED";
  const { tr, calls } = fakeTracker({ inReview: [ticket(1)] });
  writeFileSync(marker, "a".repeat(40));
  await pass(c, fakeIo(respond).io, () => tr, "/tender");
  expect([existsSync(marker), calls]).toEqual([false, ["done gh-1"]]);
});

test("auto-merge pass: medium needs the agent's merge.json; a symlinked one is ignored", async () => {
  const facts = { ...prFacts(medium), number: 7, url: "https://github.com/acme/web/pull/7", headRefOid: "a".repeat(40) };
  const c = config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "intelligent" }] });
  const respond = (a: string[]) => (a[1] === "pr" && a[2] === "list" ? { out: '[{"url":"https://github.com/acme/web/pull/7","state":"OPEN"}]' } : a[2] === "view" && a[1] === "pr" ? { out: JSON.stringify(a.at(-1) === "state" ? { state: "MERGED" } : facts) }
    : a[1] === "api" ? { out: facts.files!.map((f) => JSON.stringify(f)).join("\n") } : undefined);
  worktree("gh-1");
  mkdirSync(join(root, "acme/web/gh-1/.tender/run"), { recursive: true });
  writeFileSync(join(root, "outside.json"), JSON.stringify(assess()));
  symlinkSync(join(root, "outside.json"), join(root, "acme/web/gh-1/.tender/run/merge.json"));
  const a = fakeTracker({ inReview: [ticket(1)] });
  const x = fakeIo(respond);
  await pass(c, x.io, () => a.tr, "/tender");
  expect(x.logs.some((l) => l.includes("merge gh-1: .tender/run/merge.json ignored: ELOOP"))).toBe(true);
  expect(a.calls).toEqual(["comment gh-1 not auto-merged: medium change without a valid .tender/run/merge.json"]);
  rmSync(join(root, "acme/web/gh-1/.tender/run/merge.json"));
  writeFileSync(join(root, "acme/web/gh-1/.tender/run/merge.json"), JSON.stringify(assess()));
  const b = fakeTracker({ inReview: [ticket(1)] });
  const y = fakeIo(respond);
  await pass(c, y.io, () => b.tr, "/tender");
  expect(y.cmds.some((l) => l.startsWith("gh pr merge 7"))).toBe(true);
  expect(b.calls).toEqual(["comment gh-1 auto-merged https://github.com/acme/web/pull/7: medium change; agent: small fix, tests pass", "done gh-1"]);
});

test("merge decision: a file list that disagrees with changedFiles holds back; an unfetched one skips the file gates", () => {
  expect(mergeDecision(prFacts({ changedFiles: 3, files: [file("src/a.ts")] }), undefined, smart).reason).toBe("file list has 1 of 3 files");
  expect(mergeDecision(prFacts({ changedFiles: 1, files: [] }), undefined, smart).reason).toBe("file list has 0 of 1 files");
  expect(mergeDecision({ ...prFacts({ files: [file("package.json")] }), files: undefined }, undefined, smart).merge).toBe(true);
  for (const p of ["CLAUDE.local.md", "GEMINI.md", ".cursor/rules/x.mdc", "bunfig.toml", "sub/vitest.config.ts", "conftest.py", ".husky/pre-commit"]) expect(isCritical(p)).toBe(true);
  for (const p of ["tsconfig.json", "web/tsconfig.build.json", "eslint.config.js", ".eslintrc.json", "biome.jsonc", "ruff.toml", "setup.cfg", "tox.ini", "mypy.ini", ".golangci.yml"]) expect(isCritical(p)).toBe(true);
  for (const p of [".eslintignore", "jsconfig.json", "deno.jsonc", ".flake8", ".pylintrc", "pyrightconfig.json", ".mypy.ini", "clippy.toml", "crates/x/.cargo/config.toml", "go.work", "vite.config.ts", "vitest.workspace.ts", "karma.conf.js", ".mocharc.yml", "cypress.config.ts", "noxfile.py", ".coveragerc", ".nycrc.json", "codecov.yml", "Justfile", "Taskfile.yaml", ".circleci/config.yml", ".buildkite/pipeline.yml", "azure-pipelines.yml", "Jenkinsfile", ".travis.yml", ".gitattributes", "node_modules/zod/index.js", "web/node_modules/x/package.json"]) expect([p, isCritical(p)]).toEqual([p, true]);
  for (const p of ["src/eslint-rules.ts", ".prettierignore", ".editorconfig", "rustfmt.toml", ".nvmrc", "src/vite.ts", "docs/justfile.md"]) expect([p, isCritical(p)]).toEqual([p, false]);
  expect(isTest("spec/models/user_spec.rb")).toBe(true);
});

test("merge decision: renames, newline paths and skipped-only checks are held back", () => {
  const renamed = (filename: string, previous_filename: string) => prFacts({ files: [file(filename, { previous_filename, status: "renamed", additions: 0 })] });
  expect(isCritical("pkg\n/package.json")).toBe(true);
  expect(isCritical("x\n/infra/main.tf")).toBe(true);
  expect(mergeDecision(renamed("src/login.ts", "src/auth/login.ts"), undefined, smart).reason).toBe("touches critical path src/auth/login.ts");
  expect(mergeDecision(renamed("src/auth/login.ts", "src/login.ts"), undefined, smart).reason).toBe("touches critical path src/auth/login.ts");
  expect(mergeDecision(renamed("src/session.ts", "src/login.ts"), undefined, smart)).toEqual({ merge: true, reason: "small change" });
  expect(mergeDecision(renamed("src/login.ts", "src/auth/login.ts"), undefined, { ...smart, autoMerge: "all" }).merge).toBe(false);
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
    : a[1] === "repo" && a[2] === "view" ? { out: JSON.stringify({ nameWithOwner: "acme/web", defaultBranchRef: { name: "main" } }) } : a[1] === "api" ? filesOut(pr) : undefined);
  worktree("gh-1");
  const marker = join(root, "acme/web/gh-1.merge");
  writeFileSync(marker, "a".repeat(40));
  await pass(config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "all" }] }), io, () => tr, "/tender");
  expect([existsSync(marker), calls, cmds.some((x) => x.startsWith("gh pr merge"))]).toEqual([false, [], false]);
});

test("auto-merge pass: re-checks the PR right before merging, confirms it merged, guards the merged recovery", async () => {
  const pr = { ...prFacts(), number: 7, url: "https://github.com/acme/web/pull/7", headRefOid: "a".repeat(40) };
  const run = async (views: any[], state = "MERGED", owner = "acme/web") => {
    const { tr, calls } = fakeTracker({ inReview: [ticket(1)] });
    const { io, cmds, logs } = fakeIo((a) =>
      a[1] === "pr" && a[2] === "list" ? { out: '[{"url":"https://github.com/acme/web/pull/7","state":"MERGED"}]' }
      : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(a.at(-1) === "state" ? { state } : views.shift()) }
      : a[1] === "repo" && a[2] === "view" ? { out: JSON.stringify({ nameWithOwner: owner, defaultBranchRef: { name: "main" } }) } : a[1] === "api" ? filesOut(pr) : undefined);
    worktree("gh-1");
    await pass(config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "all" }] }), io, () => tr, "/tender");
    return { calls, logs, merged: cmds.some((x) => x.startsWith("gh pr merge")) };
  };
  for (const now of [{ baseRefName: "release" }, { headRefOid: "b".repeat(40) }, { baseRefOid: "e".repeat(40) }, { isDraft: true }, { state: "CLOSED" }])
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
    await pass(config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge }] }), x.io, () => fakeTracker({ inReview: [ticket(1)] }).tr, "/tender");
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

test("in review: gh calls per ticket per poll; feedback reuses auto-merge's view", async () => {
  const url = "https://github.com/acme/web/pull/7";
  const respond = (a: string[]) =>
    a[1] === "pr" && a[2] === "list" ? { out: JSON.stringify([{ url, state: "OPEN" }]) }
    : a[1] === "pr" ? { out: JSON.stringify({ ...prFacts({ isDraft: true }), number: 7, url, headRefOid: "a", reviews: [], comments: [] }) }
    : a[1] === "api" ? { out: "[]" } : undefined;
  const run = async (autoMerge: string, feedbackAuthors: string[], win: boolean) => {
    const x = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(win ? ["acme/web/gh-1"] : []) : respond(a)));
    await pass(config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge, feedbackAuthors }] }), x.io, () => fakeTracker({ inReview: [ticket(1)] }).tr, "/tender", async () => "idle");
    return x.cmds.filter((c) => c.startsWith("gh "));
  };
  const list = "gh pr list --repo acme/web --head agent/gh-1 --state all --json url,state,mergedAt,isCrossRepository";
  const merge = "gh pr view 7 --repo acme/web --json number,url,state,isDraft,isCrossRepository,baseRefName,baseRefOid,mergeable,additions,deletions,changedFiles,statusCheckRollup,labels,headRefOid,reviewDecision,mergeStateStatus,updatedAt";
  worktree("gh-1");
  // The first poll comments "not auto-merged" and so shares nothing; count the held polls after it.
  expect(await run("intelligent", [], true)).toHaveLength(4);
  for (const win of [true, false]) {
    expect(await run("off", [], win)).toEqual([list, merge]);
    expect(await run("off", ["op"], win)).toHaveLength(3);
    expect(await run("intelligent", [], win)).toEqual([list, merge]);
    expect(await run("intelligent", ["op"], win)).toEqual([list, `${merge},reviews,comments`, "gh api repos/acme/web/pulls/7/comments?per_page=100"]);
  }
});

test("in review: a PR merged or closed during the merge recheck gets no feedback from the stale shared view", async () => {
  const url = "https://github.com/acme/web/pull/7";
  const comments = [{ id: "c1", author: { login: "op" }, body: "nit", createdAt: new Date(Date.now() - 600_000).toISOString() }];
  const run = async (states: string[], over: Partial<PrFacts> = {}) => {
    const { io, cmds } = fakeIo((a) =>
      a[1] === "list-windows" ? windowsOut(["acme/web/gh-1"])
      : a[1] === "list-panes" ? { out: `%5 0 ${join(root, "acme/web/gh-1")}.sh\n` }
      : a[1] === "pr" && a[2] === "list" ? { out: JSON.stringify([{ url, state: "OPEN" }]) }
      : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify({ ...prFacts(over), number: 7, url, headRefOid: "a", reviews: [], comments, state: states.shift() }) }
      : a[1] === "repo" ? { out: JSON.stringify({ nameWithOwner: "acme/web", defaultBranchRef: { name: "main" } }) }
      : a[1] === "api" && a[3]?.endsWith("/files?per_page=100") ? filesOut(prFacts(over))
      : a[1] === "api" ? { out: "[]" } : undefined);
    const { tr, calls } = fakeTracker({ inReview: [ticket(1)] });
    await pass(config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "all", feedbackAuthors: ["op"] }] }), io, () => tr, "/tender", async () => "idle");
    return { calls, pasted: cmds.some((c) => c.startsWith("tmux set-buffer")) };
  };
  worktree("gh-1");
  mkdirSync(join(root, "acme/web/gh-1/.tender/run"), { recursive: true });
  const merged = await run(["OPEN", "OPEN", "MERGED", "MERGED"]);
  expect(merged.calls).toContain("done gh-1");
  expect(merged.pasted).toBe(false);
  expect(await run(["OPEN", "CLOSED", "CLOSED"])).toEqual({ calls: [], pasted: false });
  // Closed while the "not auto-merged" comment was awaited.
  expect(await run(["OPEN", "CLOSED"], { isDraft: true })).toEqual({ calls: ["comment gh-1 not auto-merged: PR is a draft"], pasted: false });
  // Closed while a capped cursor's parked check was awaited.
  writeFileSync(join(root, "acme/web/gh-1.feedback"), JSON.stringify({ seenAt: 0, rounds: 3, capped: true }));
  const pending = { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null };
  expect((await run(["OPEN", "CLOSED"], { statusCheckRollup: [pending] as any })).pasted).toBe(false);
});

test("trust: a file takes its first matching rule's mode, else autoMerge; the PR takes the lowest, capped by the host", () => {
  const trust = [{ paths: ["docs/**", "**/*.md"], autoMerge: "all" as const }, { paths: ["supabase/migrations/**", "**/auth/**"], autoMerge: "off" as const }, { paths: ["docs/**"], autoMerge: "off" as const }];
  const s = { autoMerge: "intelligent" as const, ceiling: "all" as const, trust };
  const mode = (...names: string[]) => prMode(s, names.map((n) => file(n)));
  expect(mode("docs/a.md", "README.md")).toBe("all");
  expect(mode("docs/a.md", "src/a.ts")).toBe("intelligent");
  expect(mode("docs/a.md", "src/auth/login.ts")).toBe("off");
  expect(mode("docs/x.txt")).toBe("all");
  expect(prMode(s, [file("docs/a.md", { previous_filename: "src/auth/a.ts" })])).toBe("off");
  expect(prMode({ ...s, autoMerge: "shadow" }, [])).toBe("shadow");
  expect(prMode(s)).toBe("all");
  expect(prMode({ ...s, ceiling: "intelligent" }, [file("docs/a.md")])).toBe("intelligent");
  expect(prMode({ autoMerge: "off", ceiling: "shadow", trust }, [file("docs/a.md")])).toBe("shadow");
  expect(prMode({ autoMerge: "off", ceiling: "off", trust })).toBe("off");
  const d = (names: string[], over: object = {}) => mergeDecision(prFacts({ files: names.map((n) => file(n)), additions: 5000 }), undefined, { ...smart, trust, ...over });
  expect(d(["docs/a.md"])).toEqual({ merge: true, reason: "autoMerge all" });
  expect(d(["docs/a.md", "src/a.ts"]).reason).toBe("too large (5005 lines, 2 files)");
  expect(d(["docs/a.md", "supabase/migrations/1.sql"]).reason).toBe("trust sets supabase/migrations/1.sql to off");
  expect(d(["docs/a.md"], { ceiling: "intelligent" }).reason).toBe("too large (5005 lines, 1 files)");
  expect(d(["AGENTS.md"]).reason).toBe("touches critical path AGENTS.md");
  expect(d([".agents/skills/x/SKILL.md"]).reason).toBe("touches critical path .agents/skills/x/SKILL.md");
  expect(d(["docs/SKILL.md"]).reason).toBe("touches critical path docs/SKILL.md");
});

const hunk = (path: string, ...lines: string[]) => {
  const old = lines.filter((l) => !/^[+\\]/.test(l)).length;
  const neu = lines.filter((l) => !/^[-\\]/.test(l)).length;
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${old} +1,${neu} @@ fn\n${lines.join("\n")}\n`;
};

test("escape hatches: each built-in pattern and a repo pattern on an added line, named with its file", () => {
  const added = ["// eslint-disable-next-line no-console", "// @ts-ignore", "// @ts-expect-error", "// @ts-nocheck", "x = 1  # type: ignore[attr]", "import os  # noqa: F401", "# ruff: noqa: E501", "# flake8: noqa", "# mypy: ignore-errors", "x = 1  # pyright: ignore[reportX]", "#pylint:disable=foo", "# rubocop:disable Style/X", "f() //nolint:errcheck", "//lint:ignore SA1000 x", "//lint:file-ignore SA1000 x", "// biome-ignore lint/style: x", "// oxlint-disable", "// deno-lint-ignore-file", "# shellcheck disable=SC2086", "#[allow(dead_code)]", "#![allow(clippy::all)]", "#[expect(dead_code)]", "@SuppressWarnings(\"unchecked\")", "@Suppress(\"UNCHECKED_CAST\")", "@file:Suppress(\"X\")", "[SuppressMessage(\"a\", \"b\")]", "x = 1  # pragma: no cover", "x = 1  # pragma: no branch", "/* istanbul ignore next */", "/* c8 ignore next */", "/* v8 ignore start */", "const x = y as any;", "const x = y as unknown as Z;", "#[cfg_attr(test, allow(dead_code))]", "#pragma warning(disable: 4996)", "f(); // NOSONAR", "pytestmark = pytest.mark.skip", "pytest.skip(\"x\")", "@unittest.skip(\"x\")", "self.skipTest(\"x\")", "test.skip.each([1])(\"x\", f)", "xit(\"x\", f)", "t.Skipf(\"x\")", "#[ignore = \"slow\"]", "@Disabled", "@Ignore", "[Ignore(\"x\")]"];
  expect(added).toHaveLength(ESCAPE_HATCHES.length);
  ESCAPE_HATCHES.forEach((p, i) => expect(escapeHatch(hunk("src/a.ts", " ctx", `+${added[i]}`), [])).toBe(`adds escape hatch ${JSON.stringify(p)} in src/a.ts`));
  for (const line of ["it has anything", "as anyOf(x)", "eslint-config", "@ts-check", "Array<any>", "x as anyOf", "it.iter().skip(1)", "list.skip(2)", "process.exit(1)", "unittest.main()", "// don't. Skip it", '#[cfg_attr(feature = "serde", derive(Serialize))]', "SELECT a AS any_col", "roles.push(deny(a), allow(b))", "user@disabled.com", "this.skip(n)", "stream.skipIf(x)", "t.skip(1)", "treat as unknown asset", "noSonarCount", "#[ignored]", "model.fit(X, y)", "profit(x)", "contest.only(x)", "@IgnoreExtraProperties", "pytest.mark.skipped_reason", "items[Ignore]", "Use test.only to run a single test.", "items.Skip(5)", "x.t.Skip(1)", "test.skipped = true"]) expect(escapeHatch(hunk("src/a.ts", `+${line}`), [])).toBeUndefined();
  for (const line of ["x as \tany", "x = 1  #type:ignore", "// ESLINT-DISABLE", "import os  # NOQA", "// @TS-IGNORE", "# [ allow(dead_code)]", "// nolint", "// NOLINT", '@SuppressLint("X")', "it . only('x', f)", "it.concurrent.skip('x', f)", "test.describe.only('x', f)", "fdescribe('x', f)", "t.SkipNow()", "#[ignore]", "@pytest.mark.xfail", "@unittest.expectedFailure", "pytest.mark.skipif(x)", "pytest.importorskip('x')", "s.T().Skip('x')", "tt.Skip('x')", "[Test, Ignore('x')]"]) expect(escapeHatch(hunk("src/a.ts", `+${line}`), [])).toMatch(/^adds escape hatch/);
  expect(escapeHatch(hunk("lib/a.py", "+x = 1  # HACK: skip check"), ["HACK: ?skip"])).toBe('adds escape hatch "HACK: ?skip" in lib/a.py');
});

test("escape hatches: only added lines count, by hunk counts rather than by prefix", () => {
  expect(escapeHatch(hunk("src/a.ts", "-// @ts-ignore", " // eslint-disable kept", "+ok()"), [])).toBeUndefined();
  // An added line "++ b/x" shows as "+++ b/x"; it is content, not a header.
  const tricky = hunk("src/a.ts", "+++ b/innocent.ts", "+// @ts-ignore");
  expect(addedLines(tricky)).toEqual([{ file: "src/a.ts", line: "++ b/innocent.ts" }, { file: "src/a.ts", line: "// @ts-ignore" }]);
  expect(escapeHatch(tricky, [])).toBe('adds escape hatch "@ts-ignore" in src/a.ts');
  // As git writes it: the marker counts on neither side, so the added line after it is still in the hunk.
  const eof = "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-// @ts-ignore\n\\ No newline at end of file\n+y as any\n\\ No newline at end of file\n";
  expect(addedLines(eof)).toEqual([{ file: "b.ts", line: "y as any" }]);
  expect(escapeHatch(`${hunk("src/a.ts", "+ok()")}${eof}${hunk("src/c.ts", "+ok()")}`, [])).toBe('adds escape hatch "as any" in b.ts');
  expect(addedLines(`${hunk("src/a.ts", " x", "\\ No newline at end of file", "+ok()")}${hunk("src/c.ts", "+z()")}`).map((x) => x.file)).toEqual(["src/a.ts", "src/c.ts"]);
  expect(addedLines("diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-// @ts-ignore\n")).toEqual([]);
  const s = { ...smart, autoMerge: "all" as const };
  expect(mergeDecision(prFacts({ hatch: 'adds escape hatch "@ts-ignore" in src/a.ts' }), undefined, s).reason).toBe('adds escape hatch "@ts-ignore" in src/a.ts');
  expect(mergeDecision(prFacts({ hatch: "" }), undefined, s).merge).toBe(true);
});

test("escape hatches: repo regexes run in a worker cut off after its time limit, which holds the merge back", async () => {
  expect(await hatchInWorker(hunk("lib/a.py", "+x = 1 # HACK: skip check"), ["HACK: ?skip"])).toBe('adds escape hatch "HACK: ?skip" in lib/a.py');
  expect(await hatchInWorker(hunk("lib/a.py", "+ok()"), [])).toBe("");
  const start = performance.now();
  expect(await hatchInWorker(hunk("src/a.ts", `+${"a".repeat(40)}!`), ["(a+)+$"], 200)).toBe("escape-hatch check timed out after 0.2s");
  expect(performance.now() - start).toBeLessThan(2000);
});

test("auto-merge pass: the diff is read pinned to both SHAs once per base and head; over 2 MB or an escape hatch holds it back, shadow only reports", async () => {
  let diff = { code: 0, out: hunk("src/a.ts", "+// @ts-ignore") };
  let facts: any = { ...prFacts(), number: 7, url: "https://github.com/acme/web/pull/7", baseRefOid: "f".repeat(40), headRefOid: "a".repeat(40) };
  const run = async (autoMerge: string) => {
    const { tr, calls } = fakeTracker({ inReview: [ticket(1)] });
    const { io, cmds } = fakeIo((a) =>
      a[1] === "pr" && a[2] === "list" ? { out: '[{"url":"https://github.com/acme/web/pull/7","state":"OPEN"}]' }
      : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(a.at(-1) === "state" ? { state: "MERGED" } : facts) }
      : a[1] === "api" ? filesOut(facts)
      : a[0] === "bash" ? diff : undefined);
    worktree("gh-1");
    await pass(config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge }] }), io, () => tr, "/tender");
    return { calls, diffs: cmds.filter((x) => x.startsWith("bash")).length, merged: cmds.some((x) => x.startsWith("gh pr merge")) };
  };
  expect(await run("all")).toEqual({ calls: ['comment gh-1 not auto-merged: adds escape hatch "@ts-ignore" in src/a.ts'], diffs: 1, merged: false });
  expect(await run("all")).toEqual({ calls: [], diffs: 0, merged: false });
  // Same head on a new base: the merge base may have moved, so the diff is read again.
  diff = { code: 0, out: hunk("src/a.ts", "+ok()") };
  facts = { ...facts, baseRefOid: "e".repeat(40) };
  expect(await run("all")).toMatchObject({ diffs: 1, merged: true });
  diff = { code: 0, out: hunk("src/a.ts", "+// @ts-ignore") };
  facts = { ...facts, headRefOid: "b".repeat(40) };
  expect(await run("shadow")).toEqual({ calls: ['comment gh-1 not auto-merged: adds escape hatch "@ts-ignore" in src/a.ts'], diffs: 1, merged: false });
  facts = { ...facts, headRefOid: "c".repeat(40) };
  diff = { code: 141, out: "+".repeat(2 * 1024 * 1024 + 1) };
  expect(await run("intelligent")).toEqual({ calls: ["comment gh-1 not auto-merged: diff is over 2 MB"], diffs: 1, merged: false });
  facts = { ...facts, headRefOid: "d".repeat(40) };
  diff = { code: 1, out: "" };
  expect((await run("intelligent")).calls).toEqual([]);
  diff = { code: 0, out: hunk("src/a.ts", "-// @ts-ignore", "+ok()") };
  expect(await run("intelligent")).toMatchObject({ calls: ["comment gh-1 auto-merged https://github.com/acme/web/pull/7: small change", "done gh-1"], merged: true });
});

test("auto-merge pass: a trust rule above the repo's autoMerge lets a docs-only PR merge, up to the host's ceiling", async () => {
  const facts = { ...prFacts({ files: [file("docs/a.md")] }), number: 7, url: "https://github.com/acme/web/pull/7", baseRefOid: "f".repeat(40), headRefOid: "a".repeat(40) };
  const run = async (ceiling: string) => {
    const { tr, calls } = fakeTracker({ inReview: [ticket(1)] });
    const { io } = fakeIo((a) =>
      a[1] === "pr" && a[2] === "list" ? { out: '[{"url":"https://github.com/acme/web/pull/7","state":"OPEN"}]' }
      : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(a.at(-1) === "state" ? { state: "MERGED" } : facts) }
      : a[1] === "api" ? filesOut(facts) : undefined);
    worktree("gh-1");
    await pass(config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: ceiling }] }), io, () => tr, "/tender");
    return calls;
  };
  repoFiles["config.yaml"] = 'autoMerge: off\ntrust:\n  - { paths: ["docs/**"], autoMerge: all }\n';
  expect(await run("all")).toEqual(["comment gh-1 auto-merged https://github.com/acme/web/pull/7: autoMerge all", "done gh-1"]);
  expect(await run("shadow")).toEqual(["comment gh-1 would auto-merge: small change"]);
  configCache.clear();
  repoFiles["config.yaml"] = "autoMerge: off\n";
  expect(await run("all")).toEqual([]);
});

test("auto-merge pass: a held head comments again when its reason changes, once per reason", async () => {
  let facts: any = { ...prFacts({ isDraft: true, files: [file("package.json")] }), number: 7, url: "https://github.com/acme/web/pull/7", baseRefOid: "f".repeat(40), headRefOid: "a".repeat(40) };
  const respond = (a: string[]) => (a[1] === "pr" && a[2] === "list" ? { out: '[{"url":"https://github.com/acme/web/pull/7","state":"OPEN"}]' } : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(facts) } : a[1] === "api" ? filesOut(facts) : undefined);
  const c = config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "intelligent" }] });
  worktree("gh-1");
  const calls: string[] = [];
  const run = async () => {
    const f = fakeTracker({ inReview: [ticket(1)] });
    await pass(c, fakeIo(respond).io, () => f.tr, "/tender");
    calls.push(...f.calls);
  };
  await run();
  await run();
  facts = { ...facts, isDraft: false };
  await run();
  await run();
  facts = { ...facts, isDraft: true };
  await run();
  expect(calls).toEqual(["comment gh-1 not auto-merged: PR is a draft", "comment gh-1 not auto-merged: touches critical path package.json"]);
});

test("auto-merge pass: shadow comments again when the verdict flips on a held head, once per verdict", async () => {
  let facts: any = { ...prFacts({ files: [file("src/a.ts")] }), number: 7, url: "https://github.com/acme/web/pull/7", baseRefOid: "f".repeat(40), headRefOid: "a".repeat(40) };
  const respond = (a: string[]) => (a[1] === "pr" && a[2] === "list" ? { out: '[{"url":"https://github.com/acme/web/pull/7","state":"OPEN"}]' } : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(facts) } : a[1] === "api" ? filesOut(facts) : undefined);
  const c = config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "shadow" }] });
  worktree("gh-1");
  const calls: string[] = [];
  const merge: (string | null)[] = [];
  const gates: boolean[] = [];
  const run = async () => {
    const f = fakeTracker({ inReview: [ticket(1)] });
    await pass(c, { ...fakeIo(respond).io, event: (kind, _r, _i, d: any) => void (kind === "gate" && gates.push(d.merge)) }, () => f.tr, "/tender");
    calls.push(...f.calls);
    merge.push(rows(c, new Map(), root)[0]!.merge);
  };
  await run();
  await run();
  facts = { ...facts, isDraft: true };
  await run();
  await run();
  facts = { ...facts, isDraft: false };
  await run();
  expect(calls).toEqual(["comment gh-1 would auto-merge: small change", "comment gh-1 not auto-merged: PR is a draft"]);
  expect(merge).toEqual(["would", "would", "held", "held", "would"]);
  expect(gates).toEqual([true, false, true]);
  // A marker written before verdicts were tagged is not commented again.
  writeFileSync(join(root, "acme/web/gh-1.merge"), ["a".repeat(40), JSON.stringify("small change")].join("\n"));
  await run();
  expect(calls).toHaveLength(2);
  expect(merge.at(-1)).toBe("would");
  facts = { ...facts, files: [file("would fix/package.json")] };
  await run();
  await run();
  expect(calls.slice(2)).toEqual(["comment gh-1 not auto-merged: touches critical path would fix/package.json"]);
});

test("merge decision: zero checks wait until the head is old enough for CI to register; branch protection holds with a reason", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const m = (pr: Partial<PrFacts>, s: object = {}) => mergeDecision(prFacts(pr), undefined, { ...smart, ...s });
  for (const autoMerge of ["intelligent", "all"]) {
    expect(m({ statusCheckRollup: [], updatedAt: ago(30_000) }, { autoMerge }).merge).toBe("wait");
    expect(m({ statusCheckRollup: [], updatedAt: ago(180_000) }, { autoMerge }).merge).toBe(true);
    expect(m({ updatedAt: ago(30_000) }, { autoMerge }).merge).toBe(true);
    expect(m({ reviewDecision: "REVIEW_REQUIRED" }, { autoMerge })).toEqual({ merge: false, reason: "needs review" });
    expect(m({ mergeStateStatus: "BLOCKED" }, { autoMerge })).toEqual({ merge: false, reason: "blocked by branch protection" });
    expect(m({ mergeStateStatus: "BLOCKED", statusCheckRollup: [{ state: "PENDING" }] }, { autoMerge }).merge).toBe("wait");
  }
});

test("auto-merge pass: a PR that needs review is commented once and never sent to gh pr merge", async () => {
  const pr = { ...prFacts(), number: 7, url: "https://github.com/acme/web/pull/7", headRefOid: "a".repeat(40), reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED" };
  const { tr, calls } = fakeTracker({ inReview: [ticket(1)] });
  const { io, cmds } = fakeIo((a) =>
    a[1] === "pr" && a[2] === "list" ? { out: '[{"url":"https://github.com/acme/web/pull/7","state":"OPEN"}]' }
    : a[1] === "pr" && a[2] === "view" ? { out: JSON.stringify(pr) }
    : a[1] === "repo" && a[2] === "view" ? { out: JSON.stringify({ nameWithOwner: "acme/web", defaultBranchRef: { name: "main" } }) } : a[1] === "api" ? filesOut(pr) : undefined);
  worktree("gh-1");
  for (let i = 0; i < 2; i++) await pass(config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "all" }] }), io, () => tr, "/tender");
  expect([calls, cmds.some((x) => x.startsWith("gh pr merge"))]).toEqual([["comment gh-1 not auto-merged: needs review"], false]);
});

test("merge decision: a fresh head that branch protection blocks before its required check registers waits silently", () => {
  const pr = prFacts({ statusCheckRollup: [], updatedAt: new Date(Date.now() - 30_000).toISOString(), mergeStateStatus: "BLOCKED" });
  expect(mergeDecision(pr, undefined, smart).merge).toBe("wait");
  expect(mergeDecision(pr, undefined, { ...smart, autoMerge: "shadow" }).merge).toBe("wait");
});
