import { expect, test } from "bun:test";
import { bar, card, chips, clip, counts, cut, detail, event, layout, type Line, type Model, palette, screen, scroll, segments, sortRows, tailView, wrap } from "../src/dash-view";
import { statusRow as row } from "./helpers";
import type { PhaseItem } from "../src/status";

const C = palette({});
const M = palette({ NO_COLOR: "1" });
const text = (l: Line) => l.map((x) => x.t).join("");
const W = (l: Line) => Bun.stringWidth(text(l));
const ctx = { now: Date.UTC(2026, 10, 12, 12), wt: "/home/u/agent-ws/acme/web/PER-1", home: "/home/u" };
const items = (n: number, done: number): PhaseItem[] => Array.from({ length: n }, (_, i) => ({ key: `p${i}`, title: `Phase ${i}`, status: i < done ? "done" : i === done ? "in-progress" : "todo" }));
const model = (over: Partial<Model> = {}): Model => ({ rs: [row()], sel: 0, pane: "list", max: false, help: false, back: 0, host: "box", at: "12:00:00", every: 2, msg: "", events: [], empty: "no transcript yet", ctx, ...over });

test("NO_COLOR drops every colour", () => {
  expect(C.mono).toBe(false);
  expect(C.accent).toMatch(/^#[0-9a-f]{6}$/);
  expect(M).toEqual({ mono: true });
  expect(palette({ NO_COLOR: "" }).mono).toBe(false);
  const all = screen(model({ help: true }), 120, 30, M).lines.flat();
  expect(all.some((x) => x.fg || x.bg)).toBe(false);
  expect(all.some((x) => x.r) && all.some((x) => x.d) && all.some((x) => x.b)).toBe(true);
});

test("bar fills eighth blocks and always spans exactly the width", () => {
  expect(bar(0, 5, 10)).toBe(" ".repeat(10));
  expect(bar(5, 5, 10)).toBe("█".repeat(10));
  expect(bar(1, 3, 10)).toBe("███▍      ");
  expect(bar(1, 20, 1)).toBe(" ");
  expect(bar(1, 2, 1)).toBe("▌");
  expect(bar(9, 3, 4)).toBe("████");
  expect(bar(-1, 3, 4)).toBe("    ");
  expect(bar(0, 0, 6)).toBe("      ");
  expect(bar(3, 5, 0)).toBe("");
  for (const [d, t, w] of [[1, 3, 7], [2, 7, 13], [19, 20, 18], [0, 0, 3]]) expect(Bun.stringWidth(bar(d!, t!, w!))).toBe(w!);
});

test("clip, cut and wrap work in display columns", () => {
  const l: Line = [{ t: "ab", fg: "#111111" }, { t: "漢字テスト" }];
  expect(text(clip(l, 7))).toBe("ab漢字…");
  expect(W(clip(l, 7))).toBe(7);
  expect(text(clip(l, 20))).toBe("ab漢字テスト" + " ".repeat(8));
  expect(clip(l, 0)).toEqual([]);
  expect(cut(l, 3).map(text)).toEqual(["ab ", " 字テスト"]);
  expect(cut(l, 4).map(text)).toEqual(["ab漢", "字テスト"]);
  expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
  expect(wrap("x".repeat(10), 4)).toEqual(["xxxx", "xxxx", "xx"]);
  expect(wrap("漢字テスト", 5)).toEqual(["漢字", "テス", "ト"]);
  expect(wrap("", 4)).toEqual([""]);
  expect(wrap("abc", 0)).toEqual([]);
});

test("sorting puts waiting then question first and orders by state then ID; counts label orphans apart", () => {
  const rs = [row({ id: "Q", state: "question" }), row({ id: "B", state: "ended", session: "ended" }), row({ id: "C", state: "ended", session: "orphan" }), row({ id: "Z", state: "waiting" }), row({ id: "A", state: "idle" }), row({ id: "B", state: "working" }), row({ id: "A", state: "working" }), row({ id: "U", state: "unknown" })];
  expect(sortRows(rs).map((r) => `${r.id}:${r.session === "orphan" ? "orphan" : r.state}`)).toEqual(["Z:waiting", "Q:question", "A:working", "B:working", "A:idle", "U:unknown", "C:orphan", "B:ended"]);
  expect(counts(rs)).toEqual({ waiting: 1, question: 1, working: 2, idle: 1, unknown: 1, orphan: 1, ended: 1 });
  expect(text(chips(rs, C, false))).toBe(" ◆ 1 waiting  ◇ 1 question  ● 2 working  ○ 1 idle  ? 1 unknown  ◌ 1 orphan  ✕ 1 ended ");
  expect(text(chips([], C, true))).toBe(" ◆0  ●0  ○0  ◌0  ✕0 ");
  expect(text(chips([row({ state: "question" })], C, true))).toBe(" ◆0  ◇1  ●0  ○0  ◌0  ✕0 ");
  const waiting = chips([row({ state: "waiting" })], C, false)[0]!;
  expect([waiting.bg, waiting.b]).toEqual([C.warn, true]);
});

test("cards are exactly the width in every variant, hostile text included", () => {
  const hostile = row({ id: "PER-2", repo: "\x1b]52;c;ZXZpbA==\x07acme/web‮", state: "waiting", waitingFor: "permission " + "漢".repeat(50) });
  const variants = [row(), hostile, row({ phases: null }), row({ session: "orphan", state: "ended" }), row({ session: "ended", state: "ended", phases: { done: 2, total: 2, items: items(2, 2) } }), row({ id: "漢字テスト漢字テスト漢字テスト" })];
  for (const r of variants)
    for (const n of [40, 36, 98, 20, 3])
      for (const two of [true, false])
        for (const sel of [true, false]) {
          const ls = card(r, n, two, sel, C, 8);
          expect(ls).toHaveLength(two ? 2 : 1);
          for (const l of ls) {
            expect(W(l)).toBe(n);
            expect(text(l)).not.toMatch(/[\x00-\x1f\x7f-\x9f‪-‮]/);
          }
        }
  const [a, b] = card(row(), 40, true, true, C, 6);
  expect(text(a!)).toMatch(/^▌● PER-1   acme\/web\s+claude $/);
  expect(text(b!)).toMatch(/^▌  █+[▏▎▍▌▋▊▉]? +1\/3 +5s · 1h00m $/);
  expect(a!.every((x) => x.bg === C.sel)).toBe(true);
  expect(text(card(row({ session: "orphan", state: "ended" }), 40, false, false, C)[0]!)).toStartWith(" ◌ PER-1");
  expect(text(card(row({ phases: null }), 40, false, false, C)[0]!)).toMatch(/ -  +$/);
  expect(card(row(), 40, true, true, M).flat().every((x) => !x.bg)).toBe(true);
});

test("card lines keep the exact pane width for every state and long idle/runtime strings", () => {
  const states = [{ state: "working" }, { state: "waiting", waitingFor: "permission" }, { state: "idle" }, { state: "unknown" }, { session: "orphan", state: "ended" }, { session: "ended", state: "ended" }] as const;
  const times = [[720_000, 7_200_000], [59_000, 360_000_000], [86_340_000, 8_639_000_000], [null, null]] as const;
  for (const st of states)
    for (const [idleMs, runtimeMs] of times)
      for (const n of [36, 37, 38, 39, 40, 98])
        for (const two of [true, false])
          for (const sel of [true, false])
            for (const l of card(row({ ...st, idleMs, runtimeMs, phases: { done: 3, total: 3, items: items(3, 3) } }), n, two, sel, C, 6)) expect(W(l)).toBe(n);
  expect(text(card(row({ idleMs: 720_000, runtimeMs: 7_200_000, phases: { done: 3, total: 3, items: items(3, 3) } }), 39, true, false, C, 6)[1]!)).toBe("   ████████████████ 3/3    12m · 2h00m ");
});

test("layout picks wide, narrow, tiny or max and never hands out more rows than the body", () => {
  expect(layout(160, 45, 7, false, 12)).toEqual({ mode: "wide", body: 43, listW: 42, listH: 43, detailH: 14, tailH: 29, cardH: 2 });
  expect(layout(120, 36, 7, false, 40)).toMatchObject({ mode: "wide", listW: 38, detailH: 20, tailH: 14 });
  expect(layout(120, 12, 7, false, 10).cardH).toBe(1);
  expect(layout(100, 30, 7, false, 12)).toMatchObject({ mode: "narrow", listH: 9, detailH: 12, tailH: 7 });
  expect(layout(40, 10, 7, false, 12)).toMatchObject({ mode: "tiny", listH: 4, tailH: 4 });
  expect(layout(160, 45, 7, true, 12)).toMatchObject({ mode: "max", tailH: 43 });
  for (const [w, h] of [[160, 45], [100, 30], [40, 10], [1, 1], [0, 0], [200, 3], [60, 13]]) {
    const l = layout(w!, h!, 3, false, 30);
    expect(l.mode === "wide" ? l.listH : l.listH + l.detailH + l.tailH).toBe(l.body);
    expect(Math.min(l.listH, l.detailH, l.tailH)).toBeGreaterThanOrEqual(0);
  }
  expect(scroll(0, 5, 3)).toBe(0);
  expect(scroll(4, 5, 3)).toBe(2);
  expect(scroll(2, 10, 3)).toBe(1);
});

test("detail shows title, meta, phase strip and checklist, and degrades to fit", () => {
  const r = row({ state: "waiting", waitingFor: "permission: Bash", merge: "held", startedAt: ctx.now - 3_600_000 });
  const full = detail(r, 80, Infinity, ctx, C).map(text);
  expect(full[0]).toBe("PER-1  acme/web   claude   ◆ waiting  permission: Bash");
  expect(full.join("\n")).toContain("PR       #4 held");
  expect(full.join("\n")).toContain("worktree ~/agent-ws/acme/web/PER-1");
  expect(full.join("\n")).toContain("branch   agent/PER-1");
  expect(full.slice(-5)).toEqual(["PHASES  1/3  33%", expect.stringMatching(/^━+ ━+ ━+$/), "✓ Do a", "◐ Do b", "○ Do c"]);
  expect(detail(r, 120, Infinity, ctx, C).length).toBeLessThan(full.length);
  const small = detail(r, 80, 4, ctx, C).map(text);
  expect(small).toEqual([full[0], "PHASES  1/3  33%", expect.stringMatching(/^━/), "+3 more"]);
  expect(detail(r, 80, 0, ctx, C)).toEqual([]);
  expect(detail(undefined, 80, 5, ctx, C).map(text)).toEqual(["no ticket selected"]);
  expect(detail(row({ phases: null }), 80, Infinity, ctx, C).map(text).at(-1)).toBe("PHASES  none reported");
  const one = detail(row({ phases: { done: 0, total: 1, items: items(1, 0) } }), 80, Infinity, ctx, C).map(text);
  expect(one.slice(-3)).toEqual(["PHASES  0/1  0%", "━".repeat(80), "◐ Phase 0"]);
  const orphan = detail(row({ session: "orphan", state: "ended" }), 80, 1, ctx, C).map(text);
  expect(orphan[0]).toContain("◌ orphan");
});

test("20 phases scroll the checklist to the current one with +N more", () => {
  const r = row({ phases: { done: 12, total: 20, items: items(20, 12) } });
  const ls = detail(r, 60, 12, ctx, C).map(text);
  expect(ls).toHaveLength(12);
  expect(ls.slice(-5)).toEqual(["✓ Phase 11", "◐ Phase 12", "○ Phase 13", "○ Phase 14", "+16 more (11 above, 5 below)"]);
  expect(detail(r, 60, 20, ctx, C).map(text).slice(-2)).toEqual(["○ Phase 19", "+8 more (8 above)"]);
  expect(detail(r, 60, 30, ctx, C).map(text).at(-1)).toBe("○ Phase 19");
  const strip = segments(items(20, 12), 60, C);
  expect(W(strip)).toBe(60);
  expect(strip.filter((x) => x.fg === C.ok)).toHaveLength(12);
  expect(strip.filter((x) => x.fg === C.accent)).toHaveLength(1);
  expect(W(segments(items(20, 12), 10, C))).toBe(10);
  expect(W(segments([], 10, C))).toBe(10);
  expect(segments(items(3, 1), 0, C)).toEqual([]);
  const long = row({ phases: { done: 0, total: 1, items: [{ key: "a", title: "漢字テスト".repeat(30), status: "todo" }] } });
  for (const l of detail(long, 41, Infinity, ctx, C)) expect(W(clip(l, 41))).toBe(41);
});

test("transcript events colour the kind column and wrap under the message", () => {
  const say = event("12:00:00 say    " + "word ".repeat(30).trim(), 60, C);
  expect(say.length).toBeGreaterThan(1);
  expect(text(say[1]!)).toStartWith(" ".repeat(16) + "word");
  for (const l of say) expect(W(l)).toBeLessThanOrEqual(60);
  const tool = event("12:00:00 exec_… ls -la", 60, C);
  expect(tool.map(text)).toEqual(["12:00:00 exec_… ls -la"]);
  expect(tool[0]![2]).toMatchObject({ t: "exec_…", fg: C.accent });
  expect(event("12:00:00 ERROR  boom", 60, C)[0]![2]).toMatchObject({ fg: C.bad, b: true });
  expect(event("12:00:00 漢字…  x", 60, C).map(text)).toEqual(["12:00:00 漢字…  x"]);
  expect(event("no events yet", 60, C).map(text)).toEqual(["no events yet"]);
  expect(event("12:00:00 say    " + "x".repeat(40), 30, C)).toHaveLength(1);
  const evs = Array.from({ length: 10 }, (_, i) => `12:00:0${i} say    m${i}`);
  expect(tailView(evs, 60, 3, 0, C).lines.map(text)).toEqual(["12:00:07 say    m7", "12:00:08 say    m8", "12:00:09 say    m9"]);
  expect(tailView(evs, 60, 3, 99, C)).toMatchObject({ maxBack: 7, back: 7 });
  expect(tailView([], 60, 3, 0, C)).toMatchObject({ lines: [], maxBack: 0 });
});

test("screen rows are exactly the terminal width at every size, including tiny and empty", () => {
  const rs = sortRows([row(), row({ id: "PER-2", state: "waiting", waitingFor: "x" }), row({ id: "PER-3", session: "orphan", state: "ended", phases: { done: 0, total: 20, items: items(20, 0) } })]);
  const evs = ["12:00:00 say    hello", "12:00:01 Bash   ls"];
  for (const [w, h] of [[160, 45], [120, 36], [100, 30], [40, 10], [20, 5], [1, 1], [5, 2], [80, 0]])
    for (const over of [{}, { max: true, pane: "tail" as const }, { help: true }, { rs: [] }, { msg: "hello 漢字" }, { events: evs }]) {
      const ls = screen(model({ rs, ...over }), w!, h!, C).lines;
      expect(ls).toHaveLength(h!);
      for (const l of ls) expect(W(l)).toBe(w!);
    }
  const wide = screen(model({ rs, events: evs }), 160, 45, C).lines.map(text);
  expect(wide[0]).toMatch(/^ aw  box  ◆ 1 waiting .* 12:00:00 · every 2s $/);
  expect(wide[1]).toMatch(/^╭─ tickets 3 ─+╮╭─ detail ─+╮$/);
  expect(wide[2]).toMatch(/^│▌◆ PER-2 /);
  expect(wide.at(-1)).toMatch(/^ j\/k select  tab transcript  ⏎ maximise  a attach  o open PR  r refresh  \? help  q quit/);
  expect(wide.join("\n")).toContain("12:00:01 Bash   ls");
  const narrow = screen(model({ rs }), 100, 30, C).lines.map(text);
  expect(narrow[1]).toMatch(/^╭─ tickets 3 ─+╮$/);
  expect(screen(model({ rs, pane: "tail" }), 160, 45, C).lines.at(-1)!.map((x) => x.t).join("")).toStartWith(" j/k scroll  g/G top/end  tab list");
  const help = screen(model({ rs, help: true }), 100, 30, C).lines.map(text).join("\n");
  expect(help).toContain("╭─ keys ─");
  expect(help).toContain("switch list ↔ transcript");
});
