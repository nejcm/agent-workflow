import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS, openDb } from "../src/db";
import { LIMIT, MIN_MERGED, MIN_SHADOW, recommend, stats, statsTable } from "../src/stats";
import { config, fakeIo, repoFiles, root, useTempRoot } from "./helpers";

useTempRoot();

const NOW = Date.parse("2026-06-01T00:00:00Z");
const HOUR = 3_600_000;
const ago = (days: number, hours = 0) => new Date(NOW - days * 86_400_000 + hours * HOUR).toISOString();
const url = (n: number, repo = "acme/web") => `https://github.com/${repo}/pull/${n}`;
const pr = (n: number, over: object = {}) => ({
  number: n,
  url: url(n),
  state: "MERGED",
  headRefName: `agent/gh-${n}`,
  headRefOid: `sha${n}`,
  isCrossRepository: false,
  createdAt: ago(5),
  mergedAt: ago(5, 4),
  body: "",
  files: [{ path: "docs/a.md" }],
  ...over,
});
const revert = (n: number, of: string) => pr(n, { headRefName: `revert-${n}`, body: `Reverts ${of}\n\nmore`, files: [{ path: "src/x.ts" }] });

function setup(list: object[], seed: (ev: (kind: string, ticket: string, data?: object, at?: string, repo?: string) => void, db: ReturnType<typeof openDb>) => void = () => {}) {
  repoFiles["config.yaml"] = 'autoMerge: shadow\ntrust:\n  - { paths: ["docs/**"], autoMerge: intelligent }\n';
  const cfg = config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "all" }] });
  const db = openDb(join(root, "tender.db"));
  seed((kind, ticket, data, at = ago(1), repo = "acme/web") => db.run("INSERT INTO events (at, host, repo, ticket, kind, data) VALUES (?, 'box', ?, ?, ?, ?)", [at, repo, ticket, kind, data ? JSON.stringify(data) : null]), db);
  db.close();
  const { io, cmds, logs } = fakeIo((a) => (a[1] === "pr" && a[2] === "list" ? { out: JSON.stringify(list) } : undefined));
  return { cmds, logs, go: (days?: number) => stats(cfg, io, { now: NOW, days }) };
}

test("stats: merged, reverts, rounds and hours per trust path; only GitHub-button reverts of this repo's agent PRs count", async () => {
  const s = setup(
    [
      pr(1),
      pr(2, { mergedAt: ago(5, 10) }),
      pr(3, { files: [{ path: "src/a.ts" }] }),
      pr(4, { files: [{ path: "docs/a.md" }, { path: "src/a.ts" }] }),
      pr(8, { files: [{ path: "docs/b.md", changeType: "RENAMED" }] }),
      pr(9, { files: Array.from({ length: 100 }, (_, i) => ({ path: `docs/${i}.md` })) }),
      pr(12),
      pr(5, { state: "CLOSED", mergedAt: null }),
      pr(6, { headRefName: "feat/x" }),
      pr(7, { headRefName: "agent/gh-7", isCrossRepository: true }),
      revert(20, "acme/web#1"),
      revert(11, "acme/web#12"),
      revert(21, "acme/web#6"),
      revert(22, "acme/api#2"),
      { ...revert(23, "acme/web#3"), state: "OPEN" },
      pr(24, { headRefName: "revert-24", body: 'Revert "fix" by hand (#2)' }),
    ],
    (ev) => {
      ev("feedback-round", "gh-1");
      ev("feedback-round", "gh-1");
      ev("feedback-round", "gh-2");
      ev("feedback-round", "gh-3", {}, ago(1), "acme/api");
    },
  );
  const r = await s.go();
  expect(s.cmds).toContain(`gh pr list --repo acme/web --state all --search created:>=2026-03-03 --limit ${LIMIT} --json number,url,state,headRefName,headRefOid,isCrossRepository,createdAt,mergedAt,body,files`);
  expect(r.repos[0]!.paths).toEqual([
    { path: "docs/**", mode: "intelligent", merged: 3, reverted: 1, rounds: 1, medianHoursToMerge: 4, shadow: { agreed: 0, total: 0 }, recommend: undefined },
    { path: "(rest)", mode: "shadow", merged: 1, reverted: 0, rounds: 0, medianHoursToMerge: 4, shadow: { agreed: 0, total: 0 }, recommend: undefined },
    { path: "(mixed)", mode: null, merged: 3, reverted: 0, rounds: 0, medianHoursToMerge: 4, shadow: { agreed: 0, total: 0 }, recommend: undefined },
  ]);
});

test("stats: the window bounds PRs and events, and a full page is flagged", async () => {
  const list = [pr(1), pr(2, { createdAt: ago(31) }), ...Array.from({ length: LIMIT - 2 }, (_, i) => pr(100 + i, { headRefName: "feat/x" }))];
  const s = setup(list, (ev) => {
    ev("feedback-round", "gh-1", {}, ago(40));
    ev("gate", "gh-1", { pr: url(1), head: "sha1", mode: "shadow", merge: true }, ago(40));
  });
  const r = await s.go(30);
  expect(s.cmds.find((c) => c.startsWith("gh pr list"))).toContain("created:>=2026-05-02");
  expect(r.repos[0]).toMatchObject({ truncated: true, paths: [{ path: "docs/**", merged: 1, rounds: 0, shadow: { agreed: 0, total: 0 } }] });
  expect(statsTable(r)).toContain(`acme/web: ${LIMIT} PRs listed, the limit, so older ones may be missing`);
});

test("stats: shadow agrees when would-merge was merged at that head, or not-merge was not", async () => {
  const s = setup(
    [pr(1), pr(2, { headRefOid: "pushed" }), pr(3, { state: "CLOSED", mergedAt: null }), pr(4), pr(5, { state: "CLOSED", mergedAt: null }), pr(6, { state: "OPEN", mergedAt: null }), pr(7), pr(8)],
    (ev) => {
      const gate = (n: number, merge: boolean, head = `sha${n}`, mode = "shadow") => ev("gate", `gh-${n}`, { pr: url(n), head, mode, merge, reason: "r" });
      gate(1, false);
      gate(1, true);
      gate(2, true, "sha2");
      gate(3, true);
      gate(4, false);
      gate(5, false);
      gate(6, true);
      gate(7, false, "sha7", "intelligent");
      gate(8, true);
      ev("merged", "gh-8", { pr: url(8), auto: true, mode: "intelligent" });
    },
  );
  expect((await s.go()).repos[0]!.paths[0]!.shadow).toEqual({ agreed: 2, total: 5 });
});

test("stats: judge verdicts against what happened next, and recheck reopens", async () => {
  const s = setup([], (ev, db) => {
    const rule = "acme/web:errs";
    for (const [n, state] of [[1, "open"], [2, "closed"], [3, "done"], [4, "open"], [5, "closed"], [7, "reopened"], [8, "reopening"]] as const)
      db.run("INSERT INTO intake_seen (rule, key, ticket_url, state) VALUES (?, ?, ?, ?)", [rule, `k${n}`, `https://github.com/acme/web/issues/${n}`, state]);
    ev("start", "gh-4", {}, ago(3));
    ev("judge", "gh-1", { rule, labels: ["agent"] }, ago(2));
    ev("start", "gh-1");
    ev("judge", "gh-2", { rule, labels: [] }, ago(2));
    ev("judge", "gh-3", { rule, labels: ["agent"] }, ago(2));
    ev("judge", "gh-4", { rule, labels: [] }, ago(2));
    ev("start", "gh-4");
    ev("judge", "gh-5", { rule, fromComment: true }, ago(2));
    ev("judge", "gh-6", { rule, labels: [] }, ago(2));
    ev("judge", "gh-7", { rule, labels: [] }, ago(2));
    ev("judge", "gh-8", { rule, labels: ["agent"] }, ago(2));
    ev("recheck", "gh-2", { rule, key: "k2", state: "gone" });
    ev("recheck", "gh-3", { rule, key: "k3", state: "still" });
    ev("recheck", "gh-9", { rule, key: "k9", state: "still" }, ago(1), "acme/api");
  });
  const r = (await s.go()).repos[0]!;
  expect(r.judge).toEqual({ agreed: 2, disagreed: 2, ignored: 3 });
  expect(r.recheck).toEqual({ rechecked: 2, reopened: 1 });
});

test("recommend: one mode up, only past every threshold, never from off or for a reverted path", () => {
  const ok = { mode: "shadow" as const, merged: MIN_MERGED, reverted: 0, shadow: { agreed: 19, total: MIN_SHADOW } };
  expect(recommend(ok)).toBe("intelligent");
  expect(recommend({ ...ok, shadow: { agreed: 18, total: MIN_SHADOW } })).toBeUndefined();
  expect(recommend({ ...ok, shadow: { agreed: MIN_SHADOW - 1, total: MIN_SHADOW - 1 } })).toBeUndefined();
  expect(recommend({ ...ok, merged: MIN_MERGED - 1 })).toBeUndefined();
  expect(recommend({ ...ok, reverted: 1 })).toBeUndefined();
  expect(recommend({ ...ok, mode: "intelligent" })).toBe("all");
  expect(recommend({ ...ok, mode: "off" })).toBeUndefined();
  expect(recommend({ ...ok, mode: "all" })).toBeUndefined();
});

test("stats --json shape, the table and its recommendation line", async () => {
  const list = Array.from({ length: MIN_MERGED }, (_, i) => pr(i + 1));
  const s = setup(list);
  const r = await s.go();
  expect(Object.keys(r)).toEqual(["host", "days", "since", "limit", "shadowAssumes", "repos", "recommendations"]);
  expect(Object.keys(r.repos[0]!)).toEqual(["repo", "truncated", "paths", "judge", "recheck"]);
  expect(r.recommendations).toEqual([`acme/web docs/**: ${MIN_MERGED} merged, 0 reverts → consider \`all\` (now \`intelligent\`): thresholds met, but the sample cannot show how large changes, edited tests and unassessed medium changes fare, which \`all\` also merges`]);
  expect(statsTable(r)).toEndWith(`Note: ${r.shadowAssumes}.`);
  expect(JSON.parse(JSON.stringify(r))).toMatchObject({ host: "box", days: 90, limit: LIMIT, repos: [{ repo: "acme/web", paths: [{ path: "docs/**", mode: "intelligent", merged: MIN_MERGED, recommend: "all" }] }] });
  const table = statsTable(r);
  expect(table).toContain("  path     mode         merged  reverted  rounds  hours  shadow");
  expect(table).toContain("  docs/**  intelligent  20      0         0       4      -");
  expect(table).toContain("judge: 0 agreed, 0 disagreed, 0 not acted on; recheck: 0 of 0 reopened");
});

test("stats: a failed listing or a renamed repo is reported, never fatal; nothing is written", async () => {
  const cfg = config({ repos: [{ name: "acme/web", path: join(root, "src-web") }] });
  const { io, cmds } = fakeIo((a) => (a[1] === "pr" ? { code: 1, err: "nope" } : undefined));
  const r = await stats(cfg, io, { now: NOW });
  expect(r.repos[0]).toMatchObject({ repo: "acme/web", error: "gh pr list: nope", paths: [] });
  expect(statsTable(r)).toContain("acme/web: skipped, gh pr list: nope");
  expect(cmds.every((c) => /^(gh (repo view|pr list)|git -C \S+ (rev-parse|ls-tree|cat-file))/.test(c))).toBe(true);
});

test("stats: PRs under several trust rules, one of them off, never get a recommendation", async () => {
  const list = Array.from({ length: MIN_MERGED }, (_, i) => pr(i + 1, { files: [{ path: "private/a" }, { path: "src/a.ts" }] }));
  const s = setup(list);
  repoFiles["config.yaml"] = 'autoMerge: intelligent\ntrust:\n  - { paths: ["private/**"], autoMerge: off }\n';
  const r = await s.go();
  expect(r.repos[0]!.paths).toMatchObject([{ path: "(mixed)", mode: null, merged: MIN_MERGED }]);
  expect(r.recommendations).toEqual([]);
});

const content = () => readFileSync(join(root, "tender.db")).toString("hex");

test("stats never creates, migrates or writes tender.db's content, live or not", async () => {
  const none = setup([]);
  rmSync(join(root, "tender.db"));
  expect((await none.go()).repos[0]!.judge).toEqual({ agreed: 0, disagreed: 0, ignored: 0 });
  expect(existsSync(join(root, "tender.db"))).toBe(false);

  const old = new Database(join(root, "tender.db"));
  old.run(MIGRATIONS[0]!);
  old.run("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (1)");
  old.run("INSERT INTO events (at, host, repo, ticket, kind, data) VALUES (?, 'box', 'acme/web', 'gh-1', 'recheck', '{\"state\":\"still\"}')", [ago(1)]);
  old.close();
  const before = content();
  expect((await none.go()).repos[0]!.recheck).toEqual({ rechecked: 1, reopened: 1 });
  expect(content()).toBe(before);
  rmSync(join(root, "tender.db"));

  const writer = openDb(join(root, "tender.db"));
  writer.run("INSERT INTO events (at, host, repo, ticket, kind, data) VALUES (?, 'box', 'acme/web', 'gh-1', 'recheck', '{\"state\":\"gone\"}')", [ago(1)]);
  const live = [content(), readFileSync(join(root, "tender.db-wal")).toString("hex")];
  expect((await none.go()).repos[0]!.recheck).toEqual({ rechecked: 1, reopened: 0 });
  expect([content(), readFileSync(join(root, "tender.db-wal")).toString("hex")]).toEqual(live);
  writer.close();
});

test("stats: an unreadable .tender/ keeps the totals but recommends nothing, and says so", async () => {
  const cfg = config({ repos: [{ name: "acme/web", path: join(root, "src-web"), autoMerge: "intelligent" }] });
  const list = Array.from({ length: MIN_MERGED }, (_, i) => pr(i + 1));
  const { io } = fakeIo((a) => (a[1] === "pr" && a[2] === "list" ? { out: JSON.stringify(list) } : a[0] === "git" && a[3] === "rev-parse" ? { code: 1, err: "no clone" } : undefined));
  const r = await stats(cfg, io, { now: NOW });
  expect(r.repos[0]).toMatchObject({ configError: expect.stringContaining("no clone"), paths: [{ path: "(rest)", mode: "intelligent", merged: MIN_MERGED, recommend: undefined }] });
  expect(r.recommendations).toEqual([]);
  expect(statsTable(r)).toContain("  no recommendations: .tender/ unreadable, paths assume no trust rules:");
});
