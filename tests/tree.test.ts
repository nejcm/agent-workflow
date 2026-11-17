import { expect, test } from "bun:test";
import { palette, type Line, type Model } from "../src/ui/dash-view";
import { ticketTree, treeLayout, treeMove, treeScreen, type TreeNode } from "../src/ui/tree";
import { statusRow as row } from "./helpers";

const leaf = (id: string): TreeNode => ({ id, children: [] });
const text = (line: Line) => line.map((s) => s.t).join("");
const model = (over: Partial<Model> = {}): Model => ({ rs: [row()], sel: 0, pane: "list", max: false, help: false, back: 0, host: "box", at: "12:00:00", every: 2, msg: "", events: [], empty: "no transcript yet", ctx: { now: 0, wt: "/ws/acme/web/PER-1", home: "/home/u" }, ...over });

test("layout centers the root, layers descendants, and routes wrapped rows around cards", () => {
  const root = { id: "ticket", children: [{ id: "research", children: [leaf("search")] }, leaf("review"), leaf("docs")] };
  const wide = treeLayout(root, 120);
  expect(wide.cards).toEqual([
    { id: "ticket", x: 43, y: 0, width: 34, height: 7 },
    { id: "research", x: 6, y: 10, width: 34, height: 7 },
    { id: "review", x: 43, y: 10, width: 34, height: 7 },
    { id: "docs", x: 80, y: 10, width: 34, height: 7 },
    { id: "search", x: 43, y: 20, width: 34, height: 7 },
  ]);
  expect(wide.connectors.map(({ from, to }) => [from, to])).toEqual([["ticket", "research"], ["ticket", "review"], ["ticket", "docs"], ["research", "search"]]);
  const narrow = treeLayout(root, 40);
  expect(narrow.connectors[1]!.points).toContainEqual({ x: 0, y: 18 });
  for (const layout of [wide, narrow, treeLayout(root, 12)]) {
    for (const path of layout.connectors) {
      const parent = layout.cards.find((r) => r.id === path.from)!;
      const child = layout.cards.find((r) => r.id === path.to)!;
      expect(path.points[0]).toEqual({ x: parent.x + Math.floor(parent.width / 2), y: parent.y + parent.height - 1 });
      expect(path.points.at(-1)).toEqual({ x: child.x + Math.floor(child.width / 2), y: child.y });
      for (let i = 1; i < path.points.length; i++) {
        const a = path.points[i - 1]!;
        const b = path.points[i]!;
        expect(a.x === b.x || a.y === b.y).toBe(true);
        for (const rect of layout.cards) {
          const hits = a.x === b.x
            ? a.x >= rect.x && a.x < rect.x + rect.width && Math.max(a.y, b.y) > rect.y && Math.min(a.y, b.y) < rect.y + rect.height - 1
            : a.y > rect.y && a.y < rect.y + rect.height - 1 && Math.max(a.x, b.x) >= rect.x && Math.min(a.x, b.x) < rect.x + rect.width;
          expect(hits).toBe(false);
        }
      }
    }
  }
});

test("ticket data preserves session states and reports phases rather than invented agents or tokens", () => {
  const root = ticketTree(row());
  expect(root).toMatchObject({ name: "PER-1", subtitle: "claude · ticket", status: "working", activity: "Do b", progress: { done: 1, total: 3 } });
  expect(root.children.map((n) => [n.name, n.status, n.progress])).toEqual([
    ["Do a", "done", { done: 1, total: 1 }],
    ["Do b", "working", { done: 0, total: 1 }],
    ["Do c", "idle", { done: 0, total: 1 }],
  ]);
  expect(ticketTree(row({ phases: null, session: "ended", state: "ended" }))).toMatchObject({ status: "ended", activity: "No phases reported", progress: null, children: [] });
  expect(ticketTree(row({ state: "waiting", waitingFor: "permission" })).activity).toBe("permission");
});

test("arrows follow the nearest row and column without wrapping horizontally", () => {
  const root = { id: "ticket", children: [leaf("first"), leaf("middle"), leaf("last"), leaf("next-first"), leaf("next-last")] };
  const cards = treeLayout(root, 120).cards;
  expect(treeMove(cards, 0, "down")).toBe(2);
  expect(treeMove(cards, 1, "down")).toBe(4);
  expect(treeMove(cards, 4, "up")).toBe(1);
  expect(treeMove(cards, 3, "down")).toBe(5);
  expect(treeMove(cards, 2, "up")).toBe(0);
  expect(treeMove(cards, 2, "left")).toBe(1);
  expect(treeMove(cards, 2, "right")).toBe(3);
  expect(treeMove(cards, 3, "right")).toBe(3);
  expect(treeMove(cards, 4, "left")).toBe(4);
  expect(treeMove(cards, 0, "right")).toBe(0);
  const narrow = treeLayout(root, 40).cards;
  expect(treeMove(narrow, 1, "down")).toBe(2);
  expect(treeMove(narrow, 2, "up")).toBe(1);
  expect(treeMove(narrow, 2, "left")).toBe(2);
});

test("tree cards have rounded borders, shared connectors, status colors and phase progress", () => {
  const P = palette({});
  const lines = treeScreen(model(), 120, 24, P, { sel: 0, detail: false }).lines;
  const capture = lines.map(text).join("\n");
  expect(text(lines[0]!)).toContain("1 working  1 agent ");
  expect(capture).toContain("PER-1");
  expect(capture).toContain("claude · ticket");
  expect(capture).toContain("1 / 3");
  expect(capture).toContain("✓ Done");
  expect(capture).toContain("Working");
  expect(capture).toContain("Idle");
  expect(capture).toContain("╭");
  expect(capture).toContain("┬");
  expect(capture).toContain("┴");
  expect(capture).toContain("╰");
  expect(lines.flat().find((s) => s.t === " Working ")?.fg).toBe(P.blue);
  expect(lines.flat().find((s) => s.t === " ✓ Done ")?.fg).toBe(P.ok);
  expect(lines.flat().find((s) => s.t === " Idle ")?.fg).toBe(P.idle);
});

test("tree view fits tiny terminals, keeps the selected wrapped card visible and honors NO_COLOR", () => {
  const hostile = row({ id: "PER-2\x1b[2J", repo: "acme/web‮", waitingFor: "漢字👩‍💻".repeat(40), phases: { done: 0, total: 20, items: Array.from({ length: 20 }, (_, i) => ({ key: `p${i}`, title: `Phase ${i} 漢字👩‍💻`, status: "todo" })) } });
  for (const [width, height] of [[120, 24], [80, 20], [40, 12], [20, 8], [5, 4], [1, 1], [0, 4], [80, 0]])
    for (const P of [palette({}), palette({ NO_COLOR: "1" })])
      for (const detail of [false, true]) {
        const lines = treeScreen(model({ rs: [hostile] }), width!, height!, P, { sel: 20, detail }).lines;
        expect(lines).toHaveLength(height!);
        for (const line of lines) {
          expect(Bun.stringWidth(text(line))).toBe(width!);
          expect(text(line)).not.toMatch(/[\x00-\x1f\x7f-\x9f‪-‮]/);
        }
        if (P.mono) expect(lines.flat().some((s) => s.fg || s.bg)).toBe(false);
      }
  expect(treeScreen(model({ rs: [hostile] }), 40, 12, palette({}), { sel: 20, detail: false }).lines.map(text).join("\n")).toContain("Phase 19");
  expect(treeScreen(model({ rs: [] }), 40, 12, palette({}), { sel: 0, detail: false }).lines.map(text).join("\n")).toContain("no worktrees");
});

test("detail panel describes the selected phase with real session stats and available actions", () => {
  const capture = treeScreen(model(), 120, 24, palette({}), { sel: 2, detail: true }).lines.map(text).join("\n");
  expect(capture).toContain("phase · b · Working");
  expect(capture).toContain("Session runtime 1h00m");
  expect(capture).toContain("[a Attach]");
  expect(capture).toContain("[o Open PR]");
  expect(capture).toContain("[Enter Close]");
  const unavailable = treeScreen(model({ rs: [row({ window: null, pr: null })] }), 80, 20, palette({}), { sel: 0, detail: true }).lines.map(text).join("\n");
  expect(unavailable).not.toContain("[a Attach]");
  expect(unavailable).not.toContain("[o Open PR]");
});

test("details leave the selected card visible when the panel fits above, below or beside it", () => {
  for (const [width, height, sel] of [[120, 24, 0], [120, 24, 2], [160, 12, 0]]) {
    const closed = treeScreen(model(), width!, height!, palette({}), { sel: sel!, detail: false }).lines;
    const opened = treeScreen(model(), width!, height!, palette({}), { sel: sel!, detail: true }).lines;
    const rect = treeLayout(ticketTree(row()), width!).cards[sel!]!;
    for (let y = rect.y + 1; y <= rect.y + rect.height; y++) {
      expect(text(opened[y]!).slice(rect.x, rect.x + rect.width)).toBe(text(closed[y]!).slice(rect.x, rect.x + rect.width));
    }
    expect(opened.map(text).join("\n")).toContain("[Enter Close]");
  }
  expect(treeScreen(model(), 80, 12, palette({}), { sel: 0, detail: true }).lines.map(text).join("\n")).toContain("[Enter Close]");
  for (const [width, height, total] of [[80, 24, 3], [80, 24, 8], [120, 24, 5], [120, 24, 8], [60, 22, 5], [34, 24, 5]]) {
    const phases = { done: 0, total: total!, items: Array.from({ length: total! }, (_, i) => ({ key: `p${i}`, title: `Step ${i}`, status: "todo" as const })) };
    for (let sel = 0; sel <= total!; sel++) {
      const name = sel ? `Step ${sel - 1}` : "PER-1";
      const opened = treeScreen(model({ rs: [row({ phases })] }), width!, height!, palette({}), { sel, detail: true }).lines.map(text);
      // Panel title and body name the card once each; a third copy is the card itself.
      expect(opened.join("\n").split(name).length - 1).toBeGreaterThanOrEqual(sel ? 3 : 2);
      expect(opened.join("\n")).toContain(width! >= 40 ? "[Enter Close]" : "[a Attach]");
    }
  }
});

test("detail actions fit a 40-column panel and the header keeps its padding", () => {
  const lines = treeScreen(model(), 40, 24, palette({}), { sel: 1, detail: true }).lines.map(text);
  expect(lines.join("\n")).toContain("[a Attach] [o Open PR] [Enter Close]");
  expect(lines[0]!.startsWith(" PER-1")).toBe(true);
});

test("help in tree view lists tree keys first", () => {
  const help = treeScreen(model({ help: true }), 80, 10, palette({}), { sel: 0, detail: false }).lines.map(text).join("\n");
  expect(help).toContain("next ticket in tree view");
  expect(help).not.toContain("switch list ↔ transcript");
});

test("review limit notes keep the ticket title and pluralised agent counts", () => {
  const note = "maxInReview reached, no new starts: 5/5 on this host";
  for (const width of [40, 80, 120]) {
    const header = text(treeScreen(model({ note }), width, 24, palette({}), { sel: 0, detail: false }).lines[0]!);
    expect(header).toContain("PER-1");
    expect(header).toContain("1 working  1 agent ");
  }
  const header = text(treeScreen(model({ note }), 80, 24, palette({}), { sel: 0, detail: false }).lines[0]!);
  expect(header).toContain("maxInReview");
  expect(header).toContain("…");
  expect(text(treeScreen(model({ rs: [row(), row({ id: "PER-2" })] }), 80, 24, palette({}), { sel: 0, detail: false }).lines[0]!)).toContain("2 agents");
});

test("NO_COLOR keeps empty progress tracks visible and secondary text dim", () => {
  const spans = treeScreen(model(), 120, 24, palette({ NO_COLOR: "1" }), { sel: 0, detail: false }).lines.flat();
  expect(spans.some((s) => s.t.includes("░"))).toBe(true);
  expect(spans.find((s) => s.t === "claude · ticket")?.d).toBe(true);
  expect(spans.find((s) => s.t.includes("1 / 3"))?.d).toBe(true);
});
