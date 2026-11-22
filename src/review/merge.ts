import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTO_MERGE, repoDir } from "../config/config";
import { canonical, findPr, sameRepo } from "../github";
import { hatchInWorker } from "./hatch";
import { readVerified, type Verified, verifiedAt } from "./verify";
import type { AutoMerge, Config, Io, Session, Ticket, Tracker } from "../types";
import { GIT, put, read, readRun, remove, write } from "../util";

const MAX_MERGE_BYTES = 4 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

export interface Assessment {
  confidence: "high" | "medium" | "low";
  critical: boolean;
  reviewed: boolean;
  reviewer?: string;
  reason: string;
}

/** Validates the agent-written merge file; it is untrusted, so anything off throws. */
export function parseAssessment(raw: string): Assessment {
  const a = JSON.parse(raw);
  const line = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
  const ok =
    a && typeof a === "object" && !Array.isArray(a) && Object.keys(a).every((k) => ["confidence", "critical", "reviewed", "reviewer", "reason"].includes(k)) &&
    typeof a.critical === "boolean" && ["high", "medium", "low"].includes(a.confidence) &&
    (a.reviewed === undefined || typeof a.reviewed === "boolean") && (a.reviewer === undefined ? a.reviewed !== true : line(a.reviewer, 100)) && line(a.reason, 300);
  if (!ok) throw new Error("merge: invalid");
  return { confidence: a.confidence, critical: a.critical, reviewed: a.reviewed === true, reviewer: a.reviewer?.trim(), reason: a.reason.trim() };
}

export const CRITICAL_PATHS = [
  ".github/**", "**/Dockerfile*", "docker-compose*", "**/migrations/**", "**/*.sql",
  "package.json", "bun.lock*", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "pyproject.toml", "requirements*.txt",
  "**/auth/**", "**/*secret*", "**/*.env*", "**/*.pem", "**/*.key", "nono/**", "tender.json", ".tender/**", "**/.agents/**", "**/SKILL.md", "**/infra/**", "**/terraform/**", "**/deploy/**",
  "AGENTS.md", "CLAUDE.md", "**/.claude/**", "**/.codex/**", ".mcp.json", "CLAUDE.local.md", "GEMINI.md", "**/.gemini/**", "**/.cursor/**", ".cursorrules", "uv.lock", "poetry.lock", "Gemfile", "Gemfile.lock", "**/*.tf", "**/k8s/**", "**/helm/**",
  ".npmrc", "bunfig.toml", ".gitmodules", "**/.husky/**", ".pre-commit-config.yaml", "Makefile",
  "conftest.py", "pytest.ini", "jest.config.*", "vitest.config.*", "playwright.config.*",
  "tsconfig*.json", "eslint.config.*", ".eslintrc*", "biome.json*", "ruff.toml", ".ruff.toml", "mypy.ini", "setup.cfg", "tox.ini", ".golangci.*",
  ".eslintignore", "jsconfig.json", "deno.json*", ".flake8", "pylintrc", ".pylintrc", "pyrightconfig.json", ".mypy.ini", "clippy.toml", ".clippy.toml", "**/.cargo/**", "go.work*",
  "vite.config.*", "vitest.workspace.*", "karma.conf.*", ".mocharc*", "cypress.config.*", "noxfile.py", ".coveragerc", ".nycrc*", "codecov.y*ml", ".codecov.y*ml", ".c8rc*", "nyc.config.*", "jest.setup.*", "vitest.setup.*", "phpunit.xml*", "justfile", "Taskfile*.y*ml", "Rakefile", "turbo.json", "nx.json", "lefthook*.yml", ".oxlintrc*",
  ".circleci/**", ".buildkite/**", "azure-pipelines*.yml", "Jenkinsfile", ".travis.yml", ".drone.yml", "appveyor.yml", ".appveyor.yml", ".gitattributes",
  "node_modules",
];

export const TEST_PATHS = ["**/*.test.*", "**/*.spec.*", "**/tests/**", "**/test/**", "**/__tests__/**", "**/e2e/**", "**/spec/**", "**/test_*.py", "**/*_test.go", "**/*_test.py"];

// gitignore-style: a pattern without "/" matches at any depth, a leading "/" anchors, a literal last segment also covers everything under it.
export const globRe = (glob: string) => {
  const g = glob.replace(/\/+$/, "");
  return new RegExp(`^${g.includes("/") ? "" : "(?:.*/)?"}${g.replace(/^\//, "").replace(/\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g, (m) => ({ "**/": "(?:.*/)?", "**": ".*", "*": "[^/]*", "?": "[^/]" })[m] ?? `\\${m}`)}${/[*?][^/]*$/.test(g) ? "" : "(?:/.*)?"}$`, "is");
};
export const isCritical = (path: string, extra: string[] = []) => [...CRITICAL_PATHS, ...extra].some((g) => globRe(g).test(path));
export const isTest = (path: string, extra: string[] = []) => [...TEST_PATHS, ...extra].some((g) => globRe(g).test(path));

type Trust = Pick<Session, "autoMerge" | "ceiling" | "trust">;
type PrFile = NonNullable<PrFacts["files"]>[number];
const rank = (m: AutoMerge) => AUTO_MERGE.indexOf(m);
const paths = (f: PrFile) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])];
export const trustRule = (s: Pick<Session, "trust">, path: string) => s.trust.find((t) => t.paths.some((g) => globRe(g).test(path)));

/** The lowest mode across the PR's files and old paths, capped by the host; without files, the highest any file could get. */
export function prMode(s: Trust, files?: PrFile[]): AutoMerge {
  const ranks = (files ?? []).flatMap(paths).map((p) => rank(trustRule(s, p)?.autoMerge ?? s.autoMerge));
  const r = !files ? Math.max(rank(s.autoMerge), ...s.trust.map((t) => rank(t.autoMerge))) : ranks.length ? Math.min(...ranks) : rank(s.autoMerge);
  return AUTO_MERGE[Math.min(r, rank(s.ceiling))]!;
}

export interface PrFacts {
  state: string;
  isDraft: boolean;
  isCrossRepository: boolean;
  baseRefName: string;
  mergeable: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** From the REST files endpoint, fetched only when everything else would merge. */
  files?: { filename: string; previous_filename?: string | null; status: string; additions: number; deletions: number }[];
  /** From the diff, read once the file gates pass: why it holds back, or "" if nothing does; undefined skips the gate. */
  hatch?: string;
  statusCheckRollup: any[];
  labels: { name: string }[];
  reviewDecision?: string;
  mergeStateStatus?: string;
  updatedAt?: string;
}

const OPT_OUT = "no-automerge";
// updatedAt moves on every push, so with zero checks it bounds how long CI had to register one.
const CI_GRACE_MS = 2 * 60_000;

// CheckRun has status + conclusion; StatusContext has state.
export const checkState = (c: any) =>
  c?.state !== undefined
    ? c.state === "SUCCESS" ? "success" : ["PENDING", "EXPECTED"].includes(c.state) ? "pending" : "failed"
    : c?.status !== "COMPLETED" ? "pending" : c.conclusion === "SUCCESS" ? "success" : ["NEUTRAL", "SKIPPED"].includes(c.conclusion) ? "neutral" : "failed";

/** Whether tender may merge the PR now. The assessment is agent-written and untrusted: it can only hold a merge back. `verified` is tender's own last verify result. */
export function mergeDecision(pr: PrFacts & { headRefOid?: string }, a: Assessment | undefined, s: Pick<Session, "autoMerge" | "ceiling" | "trust" | "criticalPaths" | "testPaths" | "baseBranch" | "intake" | "verify">, ticketLabels: string[] = [], verified?: Verified): { merge: boolean | "wait"; reason: string } {
  const no = (reason: string) => ({ merge: false, reason });
  const mode = prMode(s, pr.files);
  const offAt = pr.files?.flatMap(paths).find((p) => trustRule(s, p)?.autoMerge === "off");
  if (mode === "off") return no(offAt ? `trust sets ${offAt} to off` : "autoMerge is off");
  if (pr.isCrossRepository) return no("PR is from a fork");
  if (pr.baseRefName !== s.baseBranch) return no(`PR targets ${pr.baseRefName}, not ${s.baseBranch}`);
  if (pr.state !== "OPEN") return no(`PR is ${pr.state}`);
  if (pr.isDraft) return no("PR is a draft");
  if ([...pr.labels.map((l) => l.name), ...ticketLabels].some((x) => x.toLowerCase() === OPT_OUT)) return no(`labelled ${OPT_OUT}`);
  if (pr.mergeable === "CONFLICTING") return no("PR has merge conflicts");
  if (pr.reviewDecision === "CHANGES_REQUESTED") return no("changes requested in review");
  const checks = pr.statusCheckRollup.map(checkState);
  const failed = checks.filter((x) => x === "failed").length;
  if (failed) return no(`${failed} check(s) failed`);
  if (pr.reviewDecision === "REVIEW_REQUIRED") return no("needs review");
  const lines = pr.additions + pr.deletions;
  const tier = lines <= 150 && pr.changedFiles <= 5 ? "small" : lines <= 500 && pr.changedFiles <= 15 ? "medium" : "large";
  if (pr.files) {
    if (pr.files.length !== pr.changedFiles) return no(`file list has ${pr.files.length} of ${pr.changedFiles} files`);
    // Intake scripts run on the base branch with the rule's secrets; their dir covers sibling imports.
    const intakeDirs = s.intake.map((i) => `/${i.run.includes("/") ? i.run.slice(0, i.run.lastIndexOf("/")) : i.run}`);
    const hit = pr.files.flatMap(paths).find((p) => isCritical(p, [...s.criticalPaths, ...intakeDirs]));
    if (hit) return no(`touches critical path ${hit}`);
  }
  if (pr.files && mode !== "all") {
    // A modified file with 0/0 lines is binary (or mode-only), so its deletions are uncountable.
    const rewritten = pr.files.find((f) => (f.deletions > 0 || ["removed", "renamed"].includes(f.status) || (f.status === "modified" && !f.additions)) && paths(f).some((p) => isTest(p, s.testPaths)));
    if (rewritten) return no(`changes existing test ${rewritten.filename} (${rewritten.status}, ${rewritten.deletions} deletions)`);
    if (tier === "large") return no(`too large (${lines} lines, ${pr.changedFiles} files)`);
    if (a?.critical) return no(`agent marked it critical: ${a.reason}`);
    if (a?.confidence === "low") return no(`agent confidence is low: ${a.reason}`);
    if (tier === "medium") {
      if (!a) return no("medium change without a valid .tender/run/merge.json");
      if (a.confidence !== "high") return no(`medium change needs high confidence from the agent: ${a.reason}`);
      if (!a.reviewed) return no(`medium change not reviewed by a model from another family: ${a.reason}`);
      if (!checks.includes("success")) return no("medium change with no successful check");
    }
  }
  // Even in `all`: only tender's own run of the base branch's contract stands in for tests on anything but a small change.
  if (!s.verify && tier !== "small") return no(`${tier} change without a verify contract (.tender/verify.yaml)`);
  if (pr.hatch) return no(pr.hatch);
  const v = verifiedAt(verified, pr.headRefOid, s.verify);
  if (v && !v.pass) return no(`verify failed: ${v.check}`);
  if (s.verify && !v) return { merge: "wait", reason: "verify pending for this head" };
  if (pr.mergeable !== "MERGEABLE" || checks.includes("pending")) return { merge: "wait", reason: "checks pending or mergeability unknown" };
  if (!checks.length && pr.updatedAt && Date.now() - Date.parse(pr.updatedAt) < CI_GRACE_MS) return { merge: "wait", reason: "no checks yet on a fresh head" };
  if (pr.mergeStateStatus === "BLOCKED") return no("blocked by branch protection");
  return { merge: true, reason: mode === "all" ? "autoMerge all" : `${tier} change${a ? `; agent: ${a.reason}` : ""}` };
}

/** Whether a PR is ready for a human to merge, from GitHub's view alone; nothing the agent writes counts. */
export const prReady = (pr: PrFacts) =>
  pr.state === "OPEN" && !pr.isDraft && pr.mergeable === "MERGEABLE" && pr.reviewDecision !== "CHANGES_REQUESTED" && pr.statusCheckRollup.every((c) => ["success", "neutral"].includes(checkState(c)));

/** GitHub refuses the merge until a review or another branch rule is satisfied. */
export const policyBlocked = (pr: PrFacts) => pr.reviewDecision === "REVIEW_REQUIRED" || pr.mergeStateStatus === "BLOCKED";

export const WOULD = "would ";

export const PR_FIELDS = "number,url,state,isDraft,isCrossRepository,baseRefName,baseRefOid,mergeable,additions,deletions,changedFiles,statusCheckRollup,labels,headRefOid,reviewDecision,mergeStateStatus,updatedAt";

// tender merges, pinned to the head it judged (the agent's token could too; see docs/auto-merge.md). "Not merged" and shadow's verdict are commented once per head SHA and reason.
// With `share`, the first view also fetches `share.fields` and lands in `share.pr`, so feedback need not view the PR again.
// Returns that view unless tender merged, or tried to merge, the PR.
export async function autoMerge(cfg: Config, r: Session, t: Ticket, tr: Tracker, io: Io, parked = false, share?: { fields: string; pr?: any }) {
  const dir = repoDir(cfg, r.key);
  const url = await findPr(r.key, t.id, io, dir);
  const n = url && /\/pull\/(\d+)$/.exec(url)?.[1];
  if (!n) return;
  const view = (fields = PR_FIELDS) => viewPr(io, r.key, n, fields);
  const ours = async () => {
    const name = await canonical(io, r.key, true);
    return !!name && sameRepo(name, r.key);
  };
  const pr = await view(PR_FIELDS + (share?.fields ?? ""));
  const f = join(dir, `${t.id}.merge`);
  // Head SHA, then one JSON line per reason already commented on that head, `would `-prefixed for a shadow "would auto-merge", latest last.
  const marker = existsSync(f) ? readFileSync(f, "utf8").split("\n") : [];
  const held = marker[0] === pr.headRefOid;
  if (!held) remove(io, f);
  if (pr.state === "MERGED" && !pr.isCrossRepository && pr.baseRefName === r.baseBranch && (await ours())) {
    await tr.done(t);
    // Keyed by PR: a retry after tender's own merge keeps the first, auto: true, event.
    io.event?.("merged", r.key, t.id, { pr: pr.url, auto: false }, pr.url);
    return void io.event?.("done", r.key, t.id, { pr: pr.url }, pr.url);
  }
  if (parked) return pr;
  let a: Assessment | undefined;
  try {
    const raw = readRun(join(dir, t.id), "merge.json", MAX_MERGE_BYTES);
    a = raw === undefined ? undefined : parseAssessment(raw);
  } catch (e) {
    io.log(`merge ${t.id}: .tender/run/merge.json ignored: ${(e as Error).message}`);
  }
  // Undefined skips the file gates and judges by the highest mode trust allows; only this pre-check may leave it unset.
  pr.files = undefined;
  const verified = readVerified(dir, t.id);
  let d = mergeDecision(pr, a, r, t.labels, verified);
  // File gates only refuse, so the files are fetched only when everything else would merge.
  // A policy hold also fetches them when trust could resolve the PR to off, so a human still gets it as Ready to merge.
  const offPossible = rank(r.autoMerge) === 0 || r.trust.some((t) => t.autoMerge === "off");
  const fetch = d.merge === true || (policyBlocked(pr) && offPossible);
  if (fetch) {
    // REST, not `gh pr view --json files`: it has a rename's old path and is not capped at 100 files.
    const out = await read(io, ["gh", "api", "--paginate", `repos/${r.key}/pulls/${n}/files?per_page=100`, "--jq", ".[] | {filename, previous_filename, status, additions, deletions}"]);
    pr.files = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    d = mergeDecision(pr, a, r, t.labels, verified);
    if (d.merge === true) {
      pr.hatch = await prHatch(io, r.key, pr, r.escapeHatches);
      d = mergeDecision(pr, a, r, t.labels, verified);
    }
  }
  const mode = prMode(r, pr.files);
  const line = `${d.merge === true && mode === "shadow" ? WOULD : ""}${JSON.stringify(d.reason)}`;
  const other = (l: string, i: number) => !i || (l.startsWith(WOULD) ? l.slice(WOULD.length) : l) !== JSON.stringify(d.reason);
  const seen = held && !marker.every(other);
  const gate = () => io.event?.("gate", r.key, t.id, { pr: pr.url, head: pr.headRefOid, mode, merge: d.merge, reason: d.reason });
  if (d.merge === "wait" || (held && (mode === "shadow" ? seen : !d.merge && (pr.state !== "OPEN" || seen)))) {
    // A verdict already commented on that comes back is not commented again, but status and stats follow it.
    if (seen && marker.at(-1) !== line) put(io, f, [...marker.filter(other), line].join("\n")), gate();
    // Shared only when nothing was awaited since the view, so feedback never reads a stale one.
    if (share && !fetch) share.pr = pr;
    return pr;
  }
  if (d.merge && mode !== "shadow") {
    if (!(await ours())) return;
    // gh pr merge can pin the head but not the base, so a retarget after this fresh view still races.
    const now = await view();
    // Files and diff are a function of the head and base, which are checked next.
    now.files = pr.files;
    now.hatch = pr.hatch;
    // A marker kept as `held` names the old head.
    if (now.headRefOid !== pr.headRefOid) return remove(io, f);
    if (now.baseRefOid !== pr.baseRefOid) return;
    if (mergeDecision(now, a, r, t.labels, readVerified(dir, t.id)).merge !== true) return;
    // The listing may predate a human parking it; a failed read throws, so no merge.
    if (await tr.parked(t)) return;
    // The PR's baseRefOid is the base at its last sync, not the live tip; a contract pushed since this pass's fetch is judged next poll.
    const tip = (await read(io, [...GIT, "-C", r.path, "ls-remote", "origin", `refs/heads/${r.baseBranch}`])).split("\t")[0];
    if (tip !== r.baseSha) return io.log(`merge ${t.id}: origin/${r.baseBranch} moved to ${tip.slice(0, 12) || "nothing"} since this poll read .tender/; judged next poll`);
    const merge = (...del: string[]) => write(io, ["gh", "pr", "merge", n, "--repo", r.key, "--squash", ...del, "--match-head-commit", pr.headRefOid]);
    // gh refuses -d on a merge-queue branch (cli/cli pkg/cmd/pr/merge canMerge); without it, gh enqueues the PR.
    await merge("--delete-branch").catch((e) => (/^gh pr merge: \S+ Cannot use `-d` or `--delete-branch` when merge queue enabled$/.test(e.message) ? merge() : Promise.reject(e)));
    const state = io.dry ? "MERGED" : (await view("state")).state;
    if (state !== "MERGED") return io.log(`merge ${t.id}: ${pr.url} is ${state} after gh pr merge, rechecking next poll`);
    io.event?.("merged", r.key, t.id, { pr: pr.url, auto: true, mode, reason: d.reason }, pr.url);
    await tr.comment(t, `auto-merged ${pr.url}: ${d.reason}`);
    await tr.done(t);
    return void io.event?.("done", r.key, t.id, { pr: pr.url }, pr.url);
  }
  const before = held ? marker : [pr.headRefOid];
  put(io, f, [...before, line].join("\n"));
  try {
    await tr.comment(t, `${d.merge ? "would auto-merge" : "not auto-merged"}: ${d.reason}`);
  } catch (e) {
    if (held) put(io, f, before.join("\n"));
    else remove(io, f);
    throw e;
  }
  gate();
  return pr;
}

export const hatchCache = new Map<string, { key: string; hatch: string }>();

// Pinned to both SHAs, so a head pushed after the view cannot land in the cache under it; `head` bounds what is buffered.
async function prHatch(io: Io, repo: string, pr: any, extra: string[]) {
  const range = `${pr.baseRefOid}...${pr.headRefOid}`;
  const key = `${range}\0${extra.join("\0")}`;
  const hit = hatchCache.get(`${repo}#${pr.number}`);
  if (hit?.key === key) return hit.hatch;
  const script = 'set -o pipefail; gh api -H "Accept: application/vnd.github.diff" "$1" | head -c "$2"';
  const r = await io.run(["bash", "-c", script, "bash", `repos/${repo}/compare/${range}`, String(MAX_DIFF_BYTES + 1)]);
  const over = Buffer.byteLength(r.out) > MAX_DIFF_BYTES;
  if (r.code !== 0 && !over) throw new Error(`gh api compare: ${r.err.trim() || `exit ${r.code}`}`);
  const hatch = over ? `diff is over ${MAX_DIFF_BYTES / 1024 / 1024} MB` : await hatchInWorker(r.out, extra);
  hatchCache.delete(`${repo}#${pr.number}`);
  hatchCache.set(`${repo}#${pr.number}`, { key, hatch });
  if (hatchCache.size > 256) hatchCache.delete(hatchCache.keys().next().value!);
  return hatch;
}

export const viewPr = async (io: Io, repo: string, n: string, fields = PR_FIELDS) => JSON.parse(await read(io, ["gh", "pr", "view", n, "--repo", repo, "--json", fields]));
