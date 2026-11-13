import type { Check, Io, Source, Tracker } from "../types";
import { github, parseGitHub } from "./github";
import { linear, parseLinear } from "./linear";

export type Adapter<S extends Source> = {
  make(s: S, host: string, io: Io, defaultHost: boolean, repos: string[]): Tracker;
  /** The source's tracker-specific fields with defaults; every returned key is one the source may set. */
  parse(raw: Record<string, any>, at: string, check: Check): Omit<S, "name" | "tracker" | "readyLabel" | "needsHumanLabel">;
};

export const TRACKERS: { [K in Source["tracker"]]: Adapter<Extract<Source, { tracker: K }>> } = {
  github: { make: github, parse: parseGitHub },
  linear: { make: linear, parse: parseLinear },
};
