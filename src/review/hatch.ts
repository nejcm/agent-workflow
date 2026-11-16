export const ESCAPE_HATCHES = ["eslint-disable", "@ts-ignore", "@ts-expect-error", "as any", "# type: ignore", "# noqa", "//nolint", "#[allow(", "@SuppressWarnings"];
const literal = (p: string) => new RegExp(p === "as any" ? "\\bas any\\b" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const HATCH_MS = 5000;

/** Added lines of a unified diff with their file; hunk counts decide what is content, so an added "+++ x" line is not a header. */
export function addedLines(diff: string) {
  const out: { file: string; line: string }[] = [];
  let file = "";
  let old = 0;
  let neu = 0;
  for (const l of diff.split("\n")) {
    if (old > 0 || neu > 0) {
      if (l.startsWith("+")) (neu--, out.push({ file, line: l.slice(1) }));
      else if (l.startsWith("-")) old--;
      else if (!l.startsWith("\\")) (old--, neu--);
      continue;
    }
    const h = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l);
    if (h) [old, neu] = [Number(h[1] ?? 1), Number(h[2] ?? 1)];
    else if (l.startsWith("+++ ")) file = l.slice(4).replace(/^b\//, "");
  }
  return out;
}

/** The first added line matching a built-in escape hatch or one of the repo's regexes, as a reason. */
export function escapeHatch(diff: string, extra: string[]) {
  const pats = [...ESCAPE_HATCHES.map((p) => [p, literal(p)] as const), ...extra.map((p) => [p, new RegExp(p)] as const)];
  for (const { file, line } of addedLines(diff)) {
    const hit = pats.find(([, re]) => re.test(line));
    if (hit) return `adds escape hatch ${JSON.stringify(hit[0])} in ${file}`;
  }
}

/** `escapeHatch` in a worker, so a backtracking repo regex is cut off after `ms`; "" when clean, and a cut-off holds the merge back. */
export function hatchInWorker(diff: string, extra: string[], ms = HATCH_MS) {
  const w = new Worker(new URL("./hatch.ts", import.meta.url).href);
  let timer: Timer | undefined;
  return new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`escape-hatch check timed out after ${ms / 1000}s`), ms);
    w.onmessage = (e) => resolve(e.data);
    w.onerror = (e) => resolve(`escape-hatch check failed: ${e.message}`);
    w.postMessage({ diff, extra });
  }).finally(() => (clearTimeout(timer), w.terminate()));
}

if (!Bun.isMainThread) self.onmessage = (e: MessageEvent) => postMessage(escapeHatch(e.data.diff, e.data.extra) ?? "");
