import { bar, box, clip, helpOverlay, put, s, spread, TONE, wrap, type Line, type Look, type Model, type Palette } from "./dash-view";
import { dur, label, type Row } from "./status";
import { clean } from "../util";

export interface TreeNode {
  id: string;
  children: TreeNode[];
}

interface TreeCard extends TreeNode {
  name: string;
  subtitle: string;
  status: Look | "done";
  activity: string;
  progress: { done: number; total: number } | null;
  children: TreeCard[];
}

export interface TreeSelection {
  sel: number;
  detail: boolean;
}

interface Point {
  x: number;
  y: number;
}

interface CardRect extends Point {
  id: string;
  width: number;
  height: number;
}

interface ConnectorPath {
  from: string;
  to: string;
  points: Point[];
}

export function treeLayout(root: TreeNode, width: number) {
  const margin = width >= 10 ? 2 : 0;
  const room = Math.max(0, width - margin * 2);
  const columns = Math.max(1, Math.floor((room + 3) / 31));
  const cardW = Math.min(34, Math.floor((room - (columns - 1) * 3) / columns));
  const cardH = cardW >= 26 ? 7 : cardW >= 16 ? 5 : 4;
  const cards: CardRect[] = [];
  const connectors: ConnectorPath[] = [];
  let level: { node: TreeNode; parent?: CardRect }[] = [{ node: root }];
  let y = 0;
  while (level.length) {
    const next: typeof level = [];
    for (let start = 0; start < level.length; start += columns) {
      const row = level.slice(start, start + columns);
      const left = Math.floor((width - row.length * cardW - (row.length - 1) * 3) / 2);
      row.forEach(({ node, parent }, i) => {
        const rect = { id: node.id, x: left + i * (cardW + 3), y, width: cardW, height: cardH };
        cards.push(rect);
        if (parent) {
          const a = { x: parent.x + Math.floor(parent.width / 2), y: parent.y + parent.height - 1 };
          const b = { x: rect.x + Math.floor(cardW / 2), y };
          const bus = a.y + 2;
          connectors.push({ from: parent.id, to: node.id, points: [a, { x: a.x, y: bus }, ...(bus === y - 2 ? [] : [{ x: 0, y: bus }, { x: 0, y: y - 2 }]), { x: b.x, y: y - 2 }, b] });
        }
        next.push(...node.children.map((child) => ({ node: child, parent: rect })));
      });
      y += cardH + 3;
    }
    level = next;
  }
  return { cards, connectors, height: y - 3 };
}

export function treeMove(cards: CardRect[], sel: number, direction: "up" | "down" | "left" | "right") {
  const current = cards[sel];
  if (!current) return 0;
  const vertical = direction === "up" || direction === "down";
  const forward = direction === "down" || direction === "right" ? 1 : -1;
  const center = (r: CardRect) => r.x + r.width / 2;
  const candidates = cards.map((r, i) => ({ r, i })).filter(({ r }) => vertical ? (r.y - current.y) * forward > 0 : r.y === current.y && (r.x - current.x) * forward > 0);
  candidates.sort((a, b) => (vertical ? Math.abs(a.r.y - current.y) - Math.abs(b.r.y - current.y) : 0) || Math.abs(center(a.r) - center(current)) - Math.abs(center(b.r) - center(current)));
  return candidates[0]?.i ?? sel;
}

export function ticketTree(r: Row): TreeCard {
  const id = `${r.repo}/${r.id}`;
  const items = r.phases?.items ?? [];
  return {
    id,
    name: clean(r.id, 40),
    subtitle: `${r.agent} · ${r.type?.name ?? "ticket"}`,
    status: label(r),
    activity: clean(r.waitingFor ?? items.find((p) => p.status === "in-progress")?.title ?? (r.phases ? "No phase in progress" : "No phases reported"), 120),
    progress: r.phases,
    children: items.map((p) => ({
      id: `${id}/${p.key}`,
      name: clean(p.title, 120),
      subtitle: `phase · ${clean(p.key, 40)}`,
      status: p.status === "done" ? "done" : p.status === "in-progress" ? "working" : "idle",
      activity: p.status === "done" ? "Completed" : p.status === "in-progress" ? "In progress" : "Not started",
      progress: { done: p.status === "done" ? 1 : 0, total: 1 },
      children: [],
    })),
  };
}

const STATUS: Record<TreeCard["status"], string> = { working: "Working", idle: "Idle", done: "✓ Done", waiting: "Waiting", question: "Question", unknown: "Unknown", handoff: "Handoff", orphan: "Orphan", ended: "Ended" };
const tone = (node: TreeCard) => node.status === "working" ? "blue" : node.status === "done" ? "ok" : TONE[node.status];

function card(node: TreeCard, rect: CardRect, selected: boolean, P: Palette): Line[] {
  const color = tone(node);
  const pill = s(P, color, ` ${STATUS[node.status]} `, { bg: P.badge, b: true });
  const n = Math.max(0, rect.width - 4);
  const p = node.progress;
  const name: Line = [s(P, "fg", node.name, { b: true })];
  const title = n >= 22 ? spread(clip(name, Math.max(1, n - Bun.stringWidth(pill.t) - 1)), [pill], n) : clip(name, n);
  const progress: Line = p ? [s(P, color, bar(p.done, p.total, Math.max(1, n - 8)).replace(/ /g, P.mono ? "░" : " "), { bg: P.track }), s(P, "dim", ` ${p.done} / ${p.total}`)] : [s(P, "dim", "Progress unavailable")];
  const content: Line[] = rect.height >= 7
    ? [title, [s(P, "dim", node.subtitle)], [], [s(P, "fg", node.activity)], progress]
    : rect.height >= 5
      ? [title, [pill], [s(P, "dim", node.activity)]]
      : [title, [pill]];
  return box({ title: [], focused: selected, pad: true }, content, rect.width, rect.height, P);
}

const JOINT: Record<number, string> = { 1: "│", 2: "─", 3: "╰", 4: "│", 5: "│", 6: "╭", 7: "├", 8: "─", 9: "╯", 10: "─", 11: "┴", 12: "╮", 13: "┤", 14: "┬", 15: "┼" };

export function treeScreen(m: Model, width: number, height: number, P: Palette, selection: TreeSelection) {
  if (height <= 0) return { lines: [] as Line[], maxBack: 0 };
  const r = m.rs[m.sel];
  const root = r ? ticketTree(r) : undefined;
  const L = root ? treeLayout(root, width) : undefined;
  const nodes = root ? [root] : [];
  for (const node of nodes) nodes.push(...node.children);
  const selected = Math.max(0, Math.min(nodes.length - 1, selection.sel));
  const rect = L?.cards[selected];
  const bodyH = Math.max(0, height - 2);
  const node = nodes[selected];
  let panel: Line[] | undefined;
  let bh = 0;
  const bw = Math.min(60, width);
  if (selection.detail && node && r && rect && width >= 10 && bodyH >= 5) {
    const content: Line[] = [
      [s(P, tone(node), `${node.subtitle} · ${STATUS[node.status]}`)],
      ...wrap(selected === 0 ? clean(`${r.repo}: ${node.activity}`, 240) : node.name, bw - 4).map((t) => [s(P, "fg", t)]),
      [s(P, "dim", node.progress ? `${selected ? "Completion" : "Phases"} ${node.progress.done} / ${node.progress.total}` : "Progress unavailable")],
      [s(P, "dim", `Session runtime ${dur(r.runtimeMs)}   Idle ${dur(r.idleMs)}`)],
      [s(P, "dim", `Session ${label(r)} · ${r.agent}`)],
      ...(selected === 0 && r.type ? wrap(`Type ${r.type.name} · ${r.type.instructions}`, bw - 4).map((t) => [s(P, "dim", t)]) : []),
    ];
    const keys = [...(r.window ? ["[a Attach]"] : []), ...(r.pr ? ["[o Open PR]"] : [])];
    const actions: Line = [...(keys.length ? [s(P, "blue", `${keys.join(" ")} `, { b: true })] : []), s(P, "fg", "[Enter Close]", { b: true })];
    bh = Math.min(bodyH, content.length + 4);
    panel = box({ title: [s(P, "fg", ` ${node.name} `, { b: true })], focused: true, pad: true }, [...content.slice(0, bh - 3), actions], bw, bh, P).map((line) => line.map((x) => ({ ...x, bg: P.head })));
  }
  const cx = Math.floor((width - bw) / 2);
  const spot = (sy: number) => rect && [{ x: cx, y: sy + rect.height }, { x: cx, y: sy - bh }, { x: rect.x + rect.width, y: Math.max(0, Math.min(sy, bodyH - bh)) }, { x: rect.x - bw, y: Math.max(0, Math.min(sy, bodyH - bh)) }].find(({ x, y }) => x >= 0 && y >= 0 && x + bw <= width && y + bh <= bodyH);
  const centre = (span: number) => rect ? Math.max(0, Math.min(rect.y - Math.floor((bodyH - span) / 2), Math.max(L!.height, rect.y + span) - bodyH)) : 0;
  let offset = centre(rect?.height ?? 0);
  // Scrolled to centre the card, the panel may fit nowhere; centre card + panel below instead.
  if (panel && rect && !spot(rect.y - offset) && rect.height + bh <= bodyH) offset = centre(rect.height + bh);
  const body: Line[] = Array.from({ length: bodyH }, () => clip([], width));
  if (L) {
    const masks = new Map<string, number>();
    const add = (x: number, y: number, bit: number) => {
      const key = `${x},${y}`;
      masks.set(key, (masks.get(key) ?? 0) | bit);
    };
    for (const path of L.connectors) {
      for (let i = 1; i < path.points.length; i++) {
        const a = path.points[i - 1]!;
        const b = path.points[i]!;
        const dx = Math.sign(b.x - a.x);
        const dy = Math.sign(b.y - a.y);
        for (let x = a.x, y = a.y; x !== b.x || y !== b.y; x += dx, y += dy) {
          add(x, y, dx > 0 ? 2 : dx < 0 ? 8 : dy > 0 ? 4 : 1);
          add(x + dx, y + dy, dx > 0 ? 8 : dx < 0 ? 2 : dy > 0 ? 1 : 4);
        }
      }
    }
    for (let y = 0; y < bodyH; y++) body[y] = [s(P, "faint", Array.from({ length: width }, (_, x) => JOINT[masks.get(`${x},${y + offset}`) ?? 0] ?? " ").join(""))];
    L.cards.forEach((rect, i) => {
      const lines = card(nodes[i]!, rect, i === selected, P);
      if (rect.width >= 6) {
        for (const y of [0, rect.height - 1]) {
          const x = rect.x + Math.floor(rect.width / 2);
          const mask = masks.get(`${x},${rect.y + y}`);
          if (mask) put(lines, Math.floor(rect.width / 2), y, [[s(P, i === selected ? "accent" : "faint", JOINT[mask | 10]!)]]);
        }
      }
      put(body, rect.x, rect.y - offset, lines);
    });
  } else if (bodyH) body[0] = clip([s(P, "dim", " no worktrees")], width);

  if (panel) {
    const { x, y } = spot(rect!.y - offset) ?? { x: cx, y: Math.floor((bodyH - bh) / 2) };
    put(body, x, y, panel);
  }

  const title = [s(P, "fg", ` ${clean(r ? `${r.id} · ${r.repo}` : "tender · tree", 160)} `, { b: true })];
  const agents = m.rs.filter((r) => r.session === "running").length;
  const counts: Line = [s(P, "blue", `${m.rs.filter((r) => label(r) === "working").length} working`), s(P, "dim", `  ${agents} agent${agents === 1 ? "" : "s"} `)];
  const countW = counts.reduce((n, x) => n + Bun.stringWidth(x.t), 0);
  const room = Math.max(0, width - countW - 1);
  const titleW = Math.min(Bun.stringWidth(title[0]!.t), room);
  const note: Line = m.note && room > titleW + 1 ? [s(P, "dim", " "), ...clip([s(P, "warn", clean(m.note, 120), { b: true })], room - titleW - 1)] : [];
  const header = spread(room ? [...clip(title, titleW), ...note] : title, counts, width);
  const footer: Line = [s(P, m.msg ? "warn" : "dim", m.msg ? ` ${clean(m.msg, 300)} ` : " ↑/↓/←/→ select  Enter detail  Tab ticket  t list  ? help  q quit")];
  const lines = [clip(header, width), ...body];
  if (height >= 2) lines.push(clip(footer, width));
  return { lines: m.help ? helpOverlay(lines, width, P, true) : lines, maxBack: 0 };
}
