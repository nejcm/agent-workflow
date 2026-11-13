import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoDir } from "./config";
import { canonical, findPr, sameRepo } from "./github";
import type { Config, Io, Repo, Ticket, Tracker } from "./types";
import { put, read, readAw, remove, write } from "./util";

const MAX_MERGE_BYTES = 4 * 1024;

export interface Assessment {
  tested: boolean;
  confidence: "high" | "medium" | "low";
  critical: boolean;
  reason: string;
}

/** Validates the agent-written merge file; it is untrusted, so anything off throws. */
export function parseAssessment(raw: string): Assessment {
  const a = JSON.parse(raw);
  const ok =
    a && typeof a === "object" && !Array.isArray(a) && Object.keys(a).every((k) => ["tested", "confidence", "critical", "reason"].includes(k)) &&
    typeof a.tested === "boolean" && typeof a.critical === "boolean" && ["high", "medium", "low"].includes(a.confidence) &&
    typeof a.reason === "string" && a.reason.trim().length > 0 && a.reason.length <= 300 && !/[\x00-\x1f\x7f]/.test(a.reason);
  if (!ok) throw new Error("merge: invalid");
  return { tested: a.tested, confidence: a.confidence, critical: a.critical, reason: a.reason.trim() };
}

export const CRITICAL_PATHS = [
  ".github/**", "**/Dockerfile*", "docker-compose*", "**/migrations/**", "**/*.sql",
  "package.json", "bun.lock*", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "pyproject.toml", "requirements*.txt",
  "**/auth/**", "**/*secret*", "**/*.env*", "**/*.pem", "**/*.key", "nono/**", "aw.json", "**/infra/**", "**/terraform/**", "**/deploy/**",
];

// gitignore-style: a pattern without "/" matches the file name at any depth.
const globRe = (g: string) =>
  new RegExp(`^${g.includes("/") ? "" : "(?:.*/)?"}${g.replace(/\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g, (m) => ({ "**/": "(?:.*/)?", "**": ".*", "*": "[^/]*", "?": "[^/]" })[m] ?? `\\${m}`)}$`, "is");
export const isCritical = (path: string, extra: string[] = []) => [...CRITICAL_PATHS, ...extra].some((g) => globRe(g).test(path));

export interface PrFacts {
  state: string;
  isDraft: boolean;
  isCrossRepository: boolean;
  baseRefName: string;
  mergeable: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: { path: string; changeType?: string }[];
  statusCheckRollup: any[];
  labels: { name: string }[];
  reviewDecision?: string;
}

const OPT_OUT = "no-automerge";

// CheckRun has status + conclusion; StatusContext has state.
export const checkState = (c: any) =>
  c?.state !== undefined
    ? c.state === "SUCCESS" ? "success" : ["PENDING", "EXPECTED"].includes(c.state) ? "pending" : "failed"
    : c?.status !== "COMPLETED" ? "pending" : c.conclusion === "SUCCESS" ? "success" : ["NEUTRAL", "SKIPPED"].includes(c.conclusion) ? "neutral" : "failed";

/** Whether aw may merge the PR now. The assessment is agent-written and untrusted: it can only hold a merge back. */
export function mergeDecision(pr: PrFacts, a: Assessment | undefined, s: Pick<Repo, "autoMerge" | "criticalPaths" | "baseBranch">, ticketLabels: string[] = []): { merge: boolean | "wait"; reason: string } {
  const no = (reason: string) => ({ merge: false, reason });
  if (s.autoMerge === "off") return no("autoMerge is off");
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
  const lines = pr.additions + pr.deletions;
  const tier = lines <= 150 && pr.changedFiles <= 5 ? "small" : lines <= 500 && pr.changedFiles <= 15 ? "medium" : "large";
  if (s.autoMerge === "intelligent") {
    const hit = pr.files.find((f) => isCritical(f.path, s.criticalPaths));
    if (hit) return no(`touches critical path ${hit.path}`);
    const moved = pr.files.find((f) => f.changeType === "RENAMED");
    if (moved) return no(`renames ${moved.path}; its old path is not checked`);
    if (tier === "large") return no(`too large (${lines} lines, ${pr.changedFiles} files)`);
    if (a?.critical) return no(`agent marked it critical: ${a.reason}`);
    if (a?.confidence === "low") return no(`agent confidence is low: ${a.reason}`);
    if (tier === "medium") {
      if (!a) return no("medium change without a valid .aw/merge.json");
      if (!a.tested || a.confidence !== "high") return no(`medium change needs tested + high confidence from the agent: ${a.reason}`);
      if (!checks.includes("success")) return no("medium change with no successful check");
    }
  }
  if (pr.mergeable !== "MERGEABLE" || checks.includes("pending")) return { merge: "wait", reason: "checks pending or mergeability unknown" };
  return { merge: true, reason: s.autoMerge === "all" ? "autoMerge all" : `${tier} change${a ? `; agent: ${a.reason}` : ""}` };
}

const PR_FIELDS = "number,url,state,isDraft,isCrossRepository,baseRefName,mergeable,additions,deletions,changedFiles,files,statusCheckRollup,labels,headRefOid,reviewDecision";

// aw merges, pinned to the head it judged (the agent's token could too; see README). "Not merged" is commented once per head SHA.
// With `share`, the first view also fetches `share.fields` and lands in `share.pr`, so feedback need not view the PR again.
export async function autoMerge(cfg: Config, r: Repo, t: Ticket, tr: Tracker, io: Io, parked = false, share?: { fields: string; pr?: any }) {
  const dir = repoDir(cfg, r.key);
  const url = await findPr(r.key, t.id, io, dir);
  const n = url && /\/pull\/(\d+)$/.exec(url)?.[1];
  if (!n) return;
  const view = async (fields = PR_FIELDS) => JSON.parse(await read(io, ["gh", "pr", "view", n, "--repo", r.key, "--json", fields]));
  const ours = async () => {
    const name = await canonical(io, r.key, true);
    return !!name && sameRepo(name, r.key);
  };
  const pr = await view(PR_FIELDS + (share?.fields ?? ""));
  const f = join(dir, `${t.id}.merge`);
  const held = existsSync(f) && readFileSync(f, "utf8") === pr.headRefOid;
  if (!held) remove(io, f);
  if (pr.state === "MERGED" && !pr.isCrossRepository && pr.baseRefName === r.baseBranch && (await ours())) return tr.done(t);
  if (parked) return;
  let a: Assessment | undefined;
  try {
    const raw = readAw(join(dir, t.id), "merge.json", MAX_MERGE_BYTES);
    a = raw === undefined ? undefined : parseAssessment(raw);
  } catch (e) {
    io.log(`merge ${t.id}: .aw/merge.json ignored: ${(e as Error).message}`);
  }
  const d = mergeDecision(pr, a, r, t.labels);
  if (d.merge === "wait" || (!d.merge && held)) {
    // Shared only on these returns, with nothing awaited since the view, so feedback never reads a stale one.
    if (share) share.pr = pr;
    return;
  }
  if (d.merge) {
    if (!(await ours())) return;
    // gh pr merge can pin the head but not the base, so a retarget after this fresh view still races.
    const now = await view();
    // A marker kept as `held` names the old head.
    if (now.headRefOid !== pr.headRefOid) return remove(io, f);
    if (mergeDecision(now, a, r, t.labels).merge !== true) return;
    // The listing may predate a human parking it; a failed read throws, so no merge.
    if (await tr.parked(t)) return;
    await write(io, ["gh", "pr", "merge", n, "--repo", r.key, "--squash", "--delete-branch", "--match-head-commit", pr.headRefOid]);
    const state = io.dry ? "MERGED" : (await view("state")).state;
    if (state !== "MERGED") return io.log(`merge ${t.id}: ${pr.url} is ${state} after gh pr merge, rechecking next poll`);
    await tr.comment(t, `auto-merged ${pr.url}: ${d.reason}`);
    return tr.done(t);
  }
  put(io, f, pr.headRefOid);
  try {
    await tr.comment(t, `not auto-merged: ${d.reason}`);
  } catch (e) {
    remove(io, f);
    throw e;
  }
}
