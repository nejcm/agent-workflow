export type AgentName = "claude" | "codex";
export interface AgentConfig {
  name: AgentName;
  model?: string;
  effort?: string;
}

/** Host-side settings for one allowlisted repo, from tender.json. */
export interface Repo {
  key: string;
  path: string;
  /** Unset: the remote's default branch. */
  baseBranch?: string;
  sandbox: "nono" | "none";
  maxConcurrent?: number;
  maxInReview?: number;
  /** The ceiling for the repo's own request. */
  autoMerge: AutoMerge;
  /** A floor: added to the built-in and the repo's critical paths. */
  criticalPaths: string[];
  feedbackAuthors: string[];
  stallMinutes: number;
  /** PR feedback rounds before the ticket is parked; the repo's `feedback.maxRounds` overrides it. */
  feedbackRounds: number;
  profile: Profile;
}

/** `instructions` is the resolved file inside the profile; only `default` has no `match`. */
export interface TaskType {
  name: string;
  match?: { labels: string[] };
  instructions: string;
  agent?: AgentConfig;
  needs?: Needs;
  output: "pr";
}
/** `ports` loopback TCP ports tender assigns and grants in nono; `compose` a file in the repo tender starts outside the sandbox, from the base commit. */
export interface Needs {
  ports: number;
  compose?: string;
}
/** A profile's types end with `default`. */
export interface Profile {
  dir: string;
  types: TaskType[];
}

/** A repo's `.tender/` at one base commit. */
export interface RepoConfig {
  agent: AgentName;
  model?: string;
  effort?: string;
  autoMerge?: AutoMerge;
  criticalPaths: string[];
  testPaths: string[];
  /** The first rule whose globs match a file sets its mode; capped by the host's `autoMerge`. */
  trust: { paths: string[]; autoMerge: AutoMerge }[];
  /** Regexes for added lines that hold a merge back, on top of the built-in ones. */
  escapeHatches: string[];
  /** The profile's types with the repo's `types` over them by name; the first that matches a ticket is its type. */
  types: TaskType[];
  /** The Linear project whose tickets go to this repo; `team` is only checked against the ticket's source. */
  tracker?: { linear?: { project: string; team?: string } };
  intake: IntakeRule[];
  feedbackRounds?: number;
}

/** One `intake` entry of a repo's `.tender/config.yaml`; durations are `<n>m|h|d`. */
export interface IntakeRule {
  name: string;
  run: string;
  /** Passed to `run` as argv on collect and `--recheck`, never through a shell. */
  args: string[];
  every: string;
  maxPerRun: number;
  secrets: string[];
  network: string[];
  /** A rule matches when every condition holds: `min<Fact>` is `facts.<fact> >= n`, any other key is equality. */
  autoLabel: Record<string, string | number>[];
  /** Added to every ticket the rule files, shadow or not. */
  labels: string[];
  recheck: boolean;
  recheckAfter: string;
  /** Files only into a private tracker: never a public GitHub repo. */
  private: boolean;
  /** The script gets its own network namespace with a usable loopback; egress still only through the `network` proxy. */
  loopback: boolean;
  /** Unset: the judge only scores and comments; set: a verdict meeting both floors adds the ready label. */
  judge?: { minWorth: number; minFixable: number };
}

/** Host and repo settings combined for one start or merge decision; `baseSha` is the origin/<base> commit `.tender/` was read at. */
export type Session = Omit<Repo, "baseBranch"> & Omit<RepoConfig, "autoMerge"> & { baseBranch: string; ceiling: AutoMerge; baseSha?: string };

export type AutoMerge = "off" | "shadow" | "intelligent" | "all";

interface SourceBase {
  name: string;
  readyLabel: string;
  needsHumanLabel: string;
}

export interface GitHubSource extends SourceBase {
  tracker: "github";
  inProgressLabel: string;
  inReviewLabel: string;
  readyToMergeLabel: string;
}

export interface LinearSource extends SourceBase {
  tracker: "linear";
  team: string;
  todo: string;
  inProgress: string;
  inReview: string;
  /** Unset: tickets stay In Review. */
  readyToMerge?: string;
  done: string[];
}

export type Source = GitHubSource | LinearSource;
export type Check = (ok: unknown, msg: string) => unknown;

export interface Config {
  host: string;
  defaultHost: boolean;
  pollIntervalMs: number;
  workspaceRoot: string;
  reposRoot: string;
  tmuxSession: string;
  maxConcurrent: number;
  maxInReview?: number;
  stallMinutes: number;
  /** The top-level `profile`, or tender's `profile/`. */
  profile: Profile;
  repos: Record<string, Repo>;
  sources: Source[];
  /** Rules as `owner/name:rule`; only `host` runs them. */
  intake?: { enabled: string[]; host: string };
  /** Scores shadow intake tickets during `tender intake`; off when unset. `guardrails` also proposes guardrail tickets from merged PRs' feedback. */
  judge?: { agent: AgentName; model: string; maxPerRun: number; guardrails?: true };
  /** `tender prs`; `digestIssue` is `owner/name#<n>` in a repo in `repos`. */
  prs: { staleDays: number; digestIssue?: string };
}

export interface Ticket {
  id: string;
  ref: string;
  title: string;
  body: string;
  url: string;
  labels?: string[];
  /** GitHub: the allowlisted repo it was listed from. Linear: the untrusted resolved string, if any. */
  repo?: string;
  /** 1 (urgent) to 4 (low); undefined = no priority, started last. */
  priority?: number;
  /** Who it is assigned to when that is not the tender user; unset when unassigned or assigned to it. */
  otherAssignee?: string;
  /** Listed by listInReview from the Ready to merge status. */
  readyToMerge?: boolean;
}

export interface TicketComment {
  id: string;
  body: string;
  createdAt: string;
  author?: string;
}

export interface Tracker {
  /** Ticket ids are unique across the whole tracker, not per repo, so one ticket may name any repo. */
  globalIds: boolean;
  /** How a human requeues a ticket whose session ended, e.g. "remove the in-progress label". */
  restartHint(): string;
  /** One-line summary for `tender status`. */
  describe(): string;
  listReady(): Promise<Ticket[]>;
  listInProgress(): Promise<Ticket[]>;
  /** In Review and Ready to merge tickets; with `complete`, a listing that failed, filled its page or could not route a ticket throws instead of being skipped. */
  listInReview(complete?: boolean): Promise<Ticket[]>;
  /** Done or deleted (cleanup), canceled (stop, keep data) or still open. */
  closed(id: string, repo: string): Promise<"done" | "canceled" | "deleted" | undefined>;
  claim(t: Ticket): Promise<void>;
  /** Moves to In Review from In Progress or Ready to merge, then posts `note` best-effort. */
  toReview(t: Ticket, note: string): Promise<void>;
  /** Unset when the tracker has no Ready to merge status; `note` is best-effort, as for toReview. */
  toReadyToMerge?(t: Ticket, note: string): Promise<void>;
  done(t: Ticket): Promise<void>;
  /** Adds the needs-human label, which pauses start, feedback, auto-merge and the ended comment until a human removes it. */
  park(t: Ticket): Promise<void>;
  /** Whether the ticket has the needs-human label now, read fresh rather than from a listing. */
  parked(t: Ticket): Promise<boolean>;
  comment(t: Ticket, body: string): Promise<void>;
  /** Comments created after `since` (ms epoch); a tracker may return older ones too. */
  comments(t: Ticket, since: number): Promise<TicketComment[]>;
  /** Creates a sub-ticket of `parent` with no labels; returns its ref ("" in dry-run). */
  createPhase(parent: Ticket, title: string, body: string): Promise<string>;
  /** Creates a standalone ticket with no labels in `from`'s repo or team; returns its URL ("" in dry-run). */
  createTicket(from: Ticket, title: string, body: string): Promise<string>;
  /** Creates a ticket for a repo, in its Linear project when set; returns its URL ("" in dry-run). */
  fileTicket(target: Target, title: string, body: string, labels: string[]): Promise<string>;
  /** The URL of a ticket in any state whose body contains `marker`, if any. */
  findMarker(target: Target, marker: string): Promise<string | undefined>;
  /** Reopens a closed ticket (Linear: back to Todo) and removes the ready label. */
  reopen(t: Ticket): Promise<void>;
  /** The ticket's current title, body, labels and whether it is open, read fresh. */
  view(t: Ticket): Promise<{ title: string; body: string; labels: string[]; open: boolean }>;
  addLabels(t: Ticket, labels: string[]): Promise<void>;
  listPhases(parent: Ticket): Promise<{ ref: string; title: string; body: string }[]>;
  setPhase(parent: Ticket, ref: string, status: "in-progress" | "done"): Promise<void>;
}

export type Target = { repo: string; project?: string };

/** `env` replaces the inherited environment; output past `max` bytes on either stream kills the command. */
export type Run = (argv: string[], cwd?: string, secs?: number, opts?: { env?: Record<string, string>; max?: number }) => Promise<{ code: number; out: string; err: string }>;

export type EventKind = "start" | "claim" | "review" | "ready-to-merge" | "merged" | "done" | "park" | "stall" | "feedback-round" | "gate" | "handoff" | "intake-filed" | "judge" | "recheck" | "pr-closed" | "guardrail";

export interface Io {
  run: Run;
  fetch: typeof fetch;
  dry: boolean;
  log: (msg: string) => void;
  home: string;
  /** Appends to `tender.db`'s events, once per `once` key when given; unset in dry runs. Never throws. */
  event?: (kind: EventKind, repo: string, ticket: string, data?: object, once?: string) => void;
}
