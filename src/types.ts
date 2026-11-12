export interface Repo {
  key: string;
  path: string;
  baseBranch: string;
  agent: "claude" | "codex";
  sandbox: "nono" | "none";
  testCmd: string;
  prompt: string;
  maxConcurrent?: number;
  autoMerge: AutoMerge;
  criticalPaths: string[];
}

export type AutoMerge = "off" | "intelligent" | "all";

export interface Source {
  name: string;
  tracker: "github" | "linear";
  readyLabel: string;
  inProgressLabel: string;
  inReviewLabel: string;
  team: string;
  todo: string;
  inProgress: string;
  inReview: string;
  done: string[];
}

export interface Config {
  host: string;
  defaultHost: boolean;
  pollIntervalMs: number;
  workspaceRoot: string;
  reposRoot: string;
  tmuxSession: string;
  maxConcurrent: number;
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

export interface Tracker {
  listReady(): Promise<Ticket[]>;
  listInProgress(): Promise<Ticket[]>;
  listInReview(): Promise<Ticket[]>;
  isDone(id: string, repo: string): Promise<boolean>;
  claim(t: Ticket): Promise<void>;
  toReview(t: Ticket, prUrl: string): Promise<void>;
  done(t: Ticket): Promise<void>;
  comment(t: Ticket, body: string): Promise<void>;
  /** Creates a sub-ticket of `parent` with no labels; returns its ref ("" in dry-run). */
  createPhase(parent: Ticket, title: string, body: string): Promise<string>;
  listPhases(parent: Ticket): Promise<{ ref: string; title: string }[]>;
  setPhase(parent: Ticket, ref: string, status: "in-progress" | "done"): Promise<void>;
}

export type Run = (argv: string[], cwd?: string) => Promise<{ code: number; out: string; err: string }>;

export interface Io {
  run: Run;
  fetch: typeof fetch;
  dry: boolean;
  log: (msg: string) => void;
}
