const SUPPRESSIONS = ["eslint-disable", "@ts-ignore", "@ts-expect-error", "@ts-nocheck", "# type: ignore", "# noqa", "ruff: noqa", "flake8: noqa", "# mypy: ignore-errors", "# pyright: ignore", "# pylint: disable", "# rubocop:disable", "//nolint", "lint:ignore", "lint:file-ignore", "biome-ignore", "oxlint-disable", "deno-lint-ignore", "shellcheck disable", "#[allow(", "#![allow(", "#[expect(", "@SuppressWarnings", "@Suppress", "@file:Suppress", "SuppressMessage(", "# pragma: no cover", "# pragma: no branch", "istanbul ignore", "c8 ignore", "v8 ignore"];
const PY_SKIPS = ["pytest.mark.skip", "pytest.skip(", "pytest.mark.xfail", "unittest.skip", "unittest.expectedFailure", "skipTest("];
const escaped = (p: string) => p.replace(/[^\w ]/g, (c) => ` ${c.replace(/[.*+?^${}()|[\]\\]/, "\\$&")} `).trim().replace(/ +/g, "\\s*");
const literal = (p: string, flags: string) => [p, new RegExp((/^\w/.test(p) ? "\\b" : "") + escaped(p), flags)] as const;
// Comment directives ignore case like their tools do; test skips stay case-sensitive so `t.skip(1)` or `@disabled` in a template do not hold a merge.
const BUILTIN: (readonly [string, RegExp])[] = [
  ...SUPPRESSIONS.map((p) => literal(p, "i")),
  ["as any", /\bas\s+any\b/i],
  ["as unknown as", /\bas\s+unknown\s+as\b/i],
  ["cfg_attr(..., allow(", /#\s*!?\s*\[\s*cfg_attr\s*\(.*\ballow\s*\(/i],
  ["#pragma warning disable", /#\s*pragma\s+warning\s*\(?\s*disable/i],
  ["NOSONAR", /\bNOSONAR\b/],
  ...PY_SKIPS.map((p) => literal(p, "")),
  ["it/test/describe .skip or .only", /(?<![\w.$])(?:it|test|describe|context|suite)(?:\s*\.\s*\w+)*?\s*\.\s*(?:skip|only|skipIf|fails|failing|fixme)\b/],
  ["xit/fit/xdescribe/fdescribe", /(?<![\w.$])[fx](?:it|test|describe|context)\s*\(/],
  ["t.Skip", /\b[tb]\.Skip(?:f|Now)?\(/],
  ["#[ignore]", /#\s*\[\s*ignore\s*[\]=(]/],
  ["@Disabled", /@Disabled\b/],
  ["@Ignore", /@Ignore\b/],
  ["[Ignore]", /\[\s*Ignore\b/],
];
export const ESCAPE_HATCHES = BUILTIN.map(([p]) => p);
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
  const pats = [...BUILTIN, ...extra.map((p) => [p, new RegExp(p)] as const)];
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
