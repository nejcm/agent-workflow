export interface Repo {
  key: string;
  path: string;
  baseBranch: string;
  agent: "claude" | "codex";
  sandbox: "nono" | "none";
  testCmd: string;
  prompt: string;
  planStep: string;
  maxConcurrent?: number;
  autoMerge: AutoMerge;
  criticalPaths: string[];
  feedbackAuthors: string[];
}

export type AutoMerge = "off" | "intelligent" | "all";

interface SourceBase {
  name: string;
  readyLabel: string;
  needsHumanLabel: string;
}

export interface GitHubSource extends SourceBase {
  tracker: "github";
  inProgressLabel: string;
  inReviewLabel: string;
}

export interface LinearSource extends SourceBase {
  tracker: "linear";
  team: string;
  todo: string;
  inProgress: string;
  inReview: string;
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
  stallMinutes: number;
  repos: Record<string, Repo>;
  sources: Source[];
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
  /** One-line summary for `aw status`. */
  describe(): string;
  listReady(): Promise<Ticket[]>;
  listInProgress(): Promise<Ticket[]>;
  listInReview(): Promise<Ticket[]>;
  /** Done (cleanup), canceled (stop, keep data) or still open. */
  closed(id: string, repo: string): Promise<"done" | "canceled" | undefined>;
  claim(t: Ticket): Promise<void>;
  toReview(t: Ticket, prUrl: string): Promise<void>;
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
  listPhases(parent: Ticket): Promise<{ ref: string; title: string }[]>;
  setPhase(parent: Ticket, ref: string, status: "in-progress" | "done"): Promise<void>;
}

export type Run = (argv: string[], cwd?: string, secs?: number) => Promise<{ code: number; out: string; err: string }>;

export interface Io {
  run: Run;
  fetch: typeof fetch;
  dry: boolean;
  log: (msg: string) => void;
  home: string;
}
