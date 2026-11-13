import type { Io, Source, Tracker } from "../types";
import { github } from "./github";
import { linear } from "./linear";

export const TRACKERS: Record<Source["tracker"], { make(s: Source, host: string, io: Io, defaultHost: boolean, repos: string[]): Tracker }> = {
  github: { make: github },
  linear: { make: linear },
};
