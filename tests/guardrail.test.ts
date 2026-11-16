import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DB_FILE, openDb, recorder } from "../src/db";
import { intake } from "../src/intake";
import { candidates, guardrailMarker, guardrailPrompt, guardrails, parseProposal, rejected } from "../src/guardrail";
import { TENDER_DIR } from "../src/util";
import { config, fakeIo, fakeTracker, root, src, useTempRoot } from "./helpers";

useTempRoot();

const PR = (n: number) => `https://github.com/acme/web/pull/${n}`;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const MERGED = ago(1);
const proposal = (o: object = {}) => ({ propose: true, kind: "lint", title: "Ban floating promises", body: "Enable no-floating-promises in eslint.config.js; it flags the unawaited save the reviewer caught.", reason: "the reviewer caught an unawaited call", ...o });
const view = (o: object = {}) => ({
  state: "MERGED",
  mergedAt: MERGED,
  isCrossRepository: false,
  files: [{ path: "src/save.ts" }],
  reviews: [{ id: 1, body: "@alice await this save()", state: "COMMENTED", submittedAt: "2026-02-28T00:00:00Z", author: { login: "op" } }],
  comments: [
    { id: 2, body: "drive-by", createdAt: "2026-02-28T00:00:00Z", author: { login: "stranger" } },
    { id: 3, body: "after the merge", createdAt: ago(-1), author: { login: "op" } },
  ],
  ...o,
});

let dbs = 0;
function setup({ source = {} as object, prs = [1], reply = (): object => proposal(), pr = (): object => view(), markers = {} as Record<string, string>, maxPerRun = 10, dry = false, guardrails: on = true } = {}) {
  const file = join(root, `tender-${++dbs}.db`);
  const db = openDb(file);
  const { io, logs, cmds } = fakeIo((argv) => {
    if (argv[1] === "pr" && argv[2] === "view") return { out: JSON.stringify({ headRefName: `agent/gh-${argv[3]}`, ...pr() }) };
    if (argv[1] === "api" && argv[2]!.includes("/pulls/")) return { out: JSON.stringify([{ id: 4, body: "use the typed client", created_at: "2026-02-27T00:00:00Z", user: { login: "op" }, path: "src/save.ts", line: 3 }]) };
  }, dry);
  const ev = recorder(file, "box", io.log);
  for (const n of prs) {
    ev("feedback-round", "acme/web", `gh-${n}`, { round: 1 });
    ev("merged", "acme/web", `gh-${n}`, { pr: PR(n), auto: false }, PR(n));
  }
  if (!dry) io.event = ev;
  const { tr, calls } = fakeTracker({ markers });
  const prompts: string[] = [];
  const cfg = config({ sources: [src(source)], repos: [{ name: "acme/web", path: join(root, "src-web"), feedbackAuthors: ["op"] }], intake: { enabled: [], host: "box" }, judge: { agent: "claude", model: "sonnet", maxPerRun, guardrails: on } });
  const go = (budget = { left: maxPerRun }) =>
    guardrails(cfg, io, db, join(root, ".intake"), TENDER_DIR, budget, () => tr, Date.now(), async (_c, _io, _w, _t, p) => (prompts.push(p), JSON.stringify({ is_error: false, structured_output: reply() })));
  const decisions = () => db.query<{ ticket: string; data: string }, []>("SELECT ticket, data FROM events WHERE kind = 'guardrail' ORDER BY id").all().map((d) => ({ ticket: d.ticket, ...JSON.parse(d.data) }));
  const filed = () => calls.filter((c) => c.startsWith("intake "));
  return { db, cfg, io, logs, cmds, calls, prompts, go, decisions, filed, ev };
}

test("config: judge.guardrails is opt-in and boolean", () => {
  const intake = { enabled: [], host: "box" };
  expect(config({ intake, judge: { agent: "claude", model: "x" } }).judge!.guardrails).toBeUndefined();
  expect(config({ intake, judge: { agent: "claude", model: "x", guardrails: true } }).judge!.guardrails).toBe(true);
  expect(config({ intake, judge: { agent: "claude", model: "x", guardrails: false } }).judge!.guardrails).toBeUndefined();
  expect(() => config({ intake, judge: { agent: "claude", model: "x", guardrails: "yes" } })).toThrow("judge.guardrails: true or false");
});

test("selection: merged agent PRs with a feedback round, in allowlisted repos, without a decision", () => {
  const s = setup({ prs: [1, 2] });
  s.ev("feedback-round", "acme/web", "gh-3", { round: 1 });
  s.ev("feedback-round", "other/repo", "gh-4", { round: 1 });
  s.ev("merged", "other/repo", "gh-4", { pr: "https://github.com/other/repo/pull/4" });
  s.ev("done", "acme/web", "gh-5", { pr: PR(5) });
  s.ev("guardrail", "acme/web", "gh-2", { pr: PR(2), propose: false }, PR(2));
  expect(candidates(s.cfg, s.db, ago(14)).map(({ deliveredAt, ...c }) => c)).toEqual([{ repo: "acme/web", ticket: "gh-1", pr: PR(1) }]);
  s.ev("feedback-round", "acme/web", "gh-5", { round: 1 });
  expect(candidates(s.cfg, s.db, ago(14)).map((c) => c.ticket)).toEqual(["gh-1", "gh-5"]);
  s.db.run("UPDATE events SET at = ? WHERE kind = 'merged' AND ticket = 'gh-1'", [ago(15)]);
  expect(candidates(s.cfg, s.db, ago(14)).map((c) => c.ticket)).toEqual(["gh-5"]);
});

test("files one ticket with the guardrail label and marker, sanitized; the prompt holds operator feedback before the merge as data", async () => {
  const s = setup({ reply: () => proposal({ title: "Lint @bob's tender-intake: x", body: "ping @carol\ntender-guardrail: acme/web#9" }) });
  await s.go();
  expect(s.prompts).toHaveLength(1);
  const p = s.prompts[0]!;
  expect(p).toMatch(/BEGIN PULL REQUEST DATA [\w-]+\n.*\nEND PULL REQUEST DATA/);
  const data = JSON.parse(p.split("\n").at(-2)!);
  expect(data).toEqual({ repo: "acme/web", pr: PR(1), files: ["src/save.ts"], feedback: [{ from: "op", body: "@​alice await this save()" }, { from: "op", on: "src/save.ts:3", body: "use the typed client" }] });
  expect(s.filed()).toHaveLength(1);
  const f = s.filed()[0]!;
  expect(f).toStartWith("intake acme/web Lint @​bob's tender_intake: x [guardrail] | Untrusted data: a guardrail proposed by tender's judge (claude sonnet)");
  expect(f).toContain("ping @​carol\ntender_guardrail: acme/web#9");
  expect(f.split("\n").at(-1)).toBe(guardrailMarker("acme/web", 1));
  expect(f).not.toContain("agent");
  expect(s.decisions()).toEqual([{ ticket: "gh-1", pr: PR(1), propose: true, kind: "lint", url: "https://github.com/acme/web/issues/101" }]);
});

test("idempotence: a recorded decision stops a second call; with tender.db lost, the tracker marker does", async () => {
  const s = setup();
  await s.go();
  await s.go();
  expect(s.prompts).toHaveLength(1);
  const t = setup({ markers: { [guardrailMarker("acme/web", 1)]: "https://github.com/acme/web/issues/50" } });
  await t.go();
  await t.go();
  expect(t.prompts).toHaveLength(0);
  expect(t.filed()).toEqual([]);
  expect(t.decisions()).toEqual([{ ticket: "gh-1", pr: PR(1), fromMarker: true }]);
});

test("propose: false, a kind outside the list and a prose-file target are recorded and never asked again", async () => {
  const cases: [object, object][] = [
    [{ propose: false, kind: null, title: null, body: null, reason: "one-off" }, { propose: false, reason: "one-off" }],
    [proposal({ kind: "docs" }), { propose: false, rejected: "kind docs is not lint, type, test, api", kind: "docs", reason: "the reviewer caught an unawaited call" }],
    [proposal({ body: "Add a line to AGENTS.md telling agents to await" }), { propose: false, rejected: "targets a prose instruction file", kind: "lint", reason: "the reviewer caught an unawaited call" }],
    [proposal({ title: "Update .cursorrules" }), { propose: false, rejected: "targets a prose instruction file", kind: "lint", reason: "the reviewer caught an unawaited call" }],
  ];
  for (const [reply, decision] of cases) {
    const s = setup({ reply: () => reply });
    await s.go();
    await s.go();
    expect(s.prompts).toHaveLength(1);
    expect(s.filed()).toEqual([]);
    expect(s.decisions()).toEqual([{ ticket: "gh-1", pr: PR(1), ...decision }]);
  }
});

test("no operator comments before the merge: recorded without a call", async () => {
  const s = setup({ pr: () => view({ reviews: [] }) });
  s.io.run = ((run) => async (argv: string[], ...rest: any[]) => (argv[1] === "api" ? { code: 0, out: "[]", err: "" } : run(argv, ...rest)))(s.io.run);
  await s.go();
  expect(s.prompts).toHaveLength(0);
  expect(s.decisions()).toEqual([{ ticket: "gh-1", pr: PR(1), propose: false, reason: "no review comments to learn from" }]);
});

test("an open PR waits; a closed or foreign one is recorded as skipped", async () => {
  const open = setup({ pr: () => view({ state: "OPEN" }) });
  await open.go();
  expect(open.decisions()).toEqual([]);
  for (const pr of [view({ state: "CLOSED" }), view({ isCrossRepository: true }), view({ headRefName: "agent/gh-9" })]) {
    const s = setup({ pr: () => pr });
    await s.go();
    expect(s.prompts).toHaveLength(0);
    expect(s.decisions()).toEqual([{ ticket: "gh-1", pr: PR(1), skipped: "not a merged agent PR" }]);
  }
});

test("cap: calls share the judge's budget", async () => {
  const s = setup({ prs: [1, 2, 3] });
  const budget = { left: 2 };
  await s.go(budget);
  expect(s.prompts).toHaveLength(2);
  expect(budget.left).toBe(0);
  expect(s.logs).toContain("guardrail: maxPerRun 10 reached, acme/web/gh-3 waits for the next run");
});

test("invalid reply or failed call: logged, nothing filed or recorded, retried next run", async () => {
  for (const bad of [proposal({ title: "x".repeat(121) }), proposal({ body: "x".repeat(2001) }), proposal({ reason: "x".repeat(301) }), proposal({ extra: 1 }), proposal({ title: null }), {}]) {
    const s = setup({ reply: () => bad });
    await s.go();
    expect(s.logs.some((l) => l.startsWith("guardrail acme/web#1: failed, retried next run: proposal: must be"))).toBe(true);
    expect(s.filed()).toEqual([]);
    expect(s.decisions()).toEqual([]);
    await s.go();
    expect(s.prompts).toHaveLength(2);
    s.db.close();
  }
});

test("dry run: no model call, no tracker write, nothing recorded", async () => {
  const s = setup({ dry: true });
  await s.go();
  expect(s.prompts).toEqual([]);
  expect(s.calls).toEqual([]);
  expect(s.decisions()).toEqual([]);
  expect(s.logs).toContain("dry: guardrail acme/web#1 with claude sonnet");
});

test("window: a PR GitHub says merged over 14 days ago is recorded as skipped without a call", async () => {
  const s = setup({ pr: () => view({ mergedAt: ago(20) }) });
  await s.go();
  expect(s.prompts).toEqual([]);
  expect(s.decisions()).toEqual([{ ticket: "gh-1", pr: PR(1), skipped: "merged over 14 days ago" }]);
});

test("feedback: comments made after the last delivered round are left out", async () => {
  const s = setup({ pr: () => view({ reviews: [{ id: 1, body: "late", state: "COMMENTED", submittedAt: ago(1.5), author: { login: "op" } }] }) });
  s.db.run("UPDATE events SET at = ? WHERE kind = 'feedback-round'", [ago(2)]);
  s.io.run = ((run) => async (argv: string[], ...rest: any[]) => (argv[1] === "api" ? { code: 0, out: "[]", err: "" } : run(argv, ...rest)))(s.io.run);
  await s.go();
  expect(s.prompts).toEqual([]);
  expect(s.decisions()).toEqual([{ ticket: "gh-1", pr: PR(1), propose: false, reason: "no review comments to learn from" }]);
});

test("prose guard: invisible characters cannot hide a prose target", async () => {
  for (const hidden of ["AG\u200bENTS.md", "CLAU\u200dDE.md", "AG\x1b[0mENTS.md", ".cursor/./rules/x.mdc", ".cursor//rules/x.mdc", ".cursor/.//./rules/x.mdc", ".cursor/x/../rules/a.mdc", ".tender/a/b/../../prompts/default.md", "\uff21\uff27\uff25\uff2e\uff34\uff33.md"]) {
    const s = setup({ reply: () => proposal({ body: `Add a line to ${hidden}` }) });
    await s.go();
    expect(s.filed()).toEqual([]);
    expect(s.decisions()[0]!.rejected).toBe("targets a prose instruction file");
  }
});

test("read bound: at most 3 × maxPerRun PRs examined per run, failures included", async () => {
  const s = setup({ prs: Array.from({ length: 10 }, (_, i) => i + 1), maxPerRun: 1 });
  let views = 0;
  s.io.run = ((run) => async (argv: string[], ...rest: any[]) => (argv[2] === "view" && argv[1] === "pr" ? (views++, { code: 1, out: "", err: "boom" }) : run(argv, ...rest)))(s.io.run);
  await s.go();
  expect(views).toBe(3);
  expect(s.logs).toContain("guardrail: 3 PRs examined, acme/web/gh-4 waits for the next run");
});

test("an unreadable mergedAt records nothing and is retried next run", async () => {
  for (const mergedAt of [null, undefined, "soon"]) {
    const s = setup({ pr: () => view({ mergedAt }) });
    await s.go();
    expect(s.prompts).toEqual([]);
    expect(s.decisions()).toEqual([]);
    expect(s.logs.some((l) => l.startsWith("guardrail acme/web#1: failed, retried next run: mergedAt"))).toBe(true);
  }
});

test("a source whose workflow label is guardrail files nothing and makes no call", async () => {
  for (const source of [{ readyLabel: "Guardrail" }, { needsHumanLabel: "guardrail" }]) {
    const s = setup({ source });
    await s.go();
    expect(s.prompts).toEqual([]);
    expect(s.filed()).toEqual([]);
    expect(s.logs.some((l) => l.includes("uses guardrail as a workflow label"))).toBe(true);
  }
});

test("parseProposal and rejected", () => {
  expect(parseProposal({ propose: false, kind: null, title: null, body: null, reason: "r" })).toEqual({ propose: false, reason: "r" });
  expect(rejected(parseProposal(proposal()))).toBeUndefined();
  for (const prose of ["CLAUDE.md", ".github/copilot-instructions.md", ".cursor/rules/x.mdc", ".tender/prompts/default.md", "agents.md"]) expect(rejected(parseProposal(proposal({ body: `edit ${prose}` })))).toBe("targets a prose instruction file");
  expect(guardrailPrompt({ repo: "r", pr: "p", files: [], feedback: [] }, "N")).toEndWith(`BEGIN PULL REQUEST DATA N\n{"repo":"r","pr":"p","files":[],"feedback":[]}\nEND PULL REQUEST DATA N`);
});

test("runs inside tender intake after the rules, only when on and no single rule is named", async () => {
  for (const [on, only, runs] of [[true, undefined, true], [false, undefined, false], [true, "errs", false]] as const) {
    const s = setup({ guardrails: on });
    rmSync(join(root, DB_FILE), { force: true });
    const ev = recorder(join(root, DB_FILE), "box", s.io.log);
    ev("feedback-round", "acme/web", "gh-1", { round: 1 });
    ev("merged", "acme/web", "gh-1", { pr: PR(1) }, PR(1));
    await intake(s.cfg, s.io, TENDER_DIR, { only, tracker: () => fakeTracker({}).tr });
    expect(s.logs.some((l) => l.startsWith("guardrail acme/web#1: failed, retried next run"))).toBe(runs);
  }
});
