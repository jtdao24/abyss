// Layout of the boardwalk art (web/public/art/boardwalk.png, 1672x941), in its
// pixel coordinates: where people stand, where the player may walk, and what
// can be clicked.
import type { AgentId } from "../contract";

export const WORLD = { w: 1672, h: 941 };

export type Point = { x: number; y: number };
export type Rect = [number, number, number, number]; // x0, y0, x1, y1

/** Each stall: centre x, its blank sign, and where its vendor stands. */
export const STALLS: Record<AgentId, { cx: number; sign: Point; home: Point; gather: Point }> = {
  opus: { cx: 435, sign: { x: 438, y: 270 }, home: { x: 435, y: 452 }, gather: { x: 290, y: 690 } },
  sonnet: { cx: 840, sign: { x: 845, y: 270 }, home: { x: 840, y: 452 }, gather: { x: 235, y: 650 } },
  haiku: { cx: 1250, sign: { x: 1253, y: 270 }, home: { x: 1250, y: 452 }, gather: { x: 290, y: 610 } },
};

/** The main agent stands on the boat by the gangway; the reviewer on the pier. */
export const MAIN_AGENT_POS: Point = { x: 505, y: 752 };
export const REVIEWER_POS: Point = { x: 160, y: 565 };
/** Where a vendor stands to hand work to the reviewer. */
export const REVIEW_SPOT: Point = { x: 225, y: 585 };
export const PLAYER_START: Point = { x: 640, y: 462 };

/** Walkable planks: the boardwalk and the pier. */
export const DECK: Rect = [20, 340, 1650, 472];
export const PIER: Rect = [112, 472, 330, 792];
const WALKABLE: Rect[] = [DECK, PIER];

/** Stall bodies with the flower barrels beside them, and the lamp posts at the deck's ends: nobody walks through these. */
export const BLOCKED: Rect[] = [
  [288, 245, 582, 430],
  [698, 245, 986, 430],
  [1103, 245, 1403, 430],
  [55, 410, 105, 472],
  [1615, 430, 1655, 472],
];
/** How far a walker's feet stay from anything blocked. */
const CLEARANCE = 8;
const BLOCKED_FEET: Rect[] = BLOCKED.map(([x0, y0, x1, y1]) => [x0 - CLEARANCE, y0 - CLEARANCE, x1 + CLEARANCE, y1 + CLEARANCE]);

export type InteractId = "main" | "reviewer" | "tasks" | `vendor:${AgentId}`;

export interface Interactable {
  id: InteractId;
  label: string;
  hit: Rect;
  approach: Point;
}

export const INTERACTABLES: Interactable[] = [
  { id: "main", label: "CAPTAIN - OPEN TERMINAL", hit: [445, 670, 575, 775], approach: { x: 312, y: 728 } },
  { id: "reviewer", label: "LIFEGUARD", hit: [118, 470, 205, 580], approach: { x: 205, y: 615 } },
  vendorAt("opus", "VENDOR 1", STALLS.opus.home),
  vendorAt("sonnet", "VENDOR 2", STALLS.sonnet.home),
  vendorAt("haiku", "VENDOR 3", STALLS.haiku.home),
];

/** The clickable box around a person standing with their feet at `p`. */
export function personBox(p: Point): Rect {
  return [p.x - 30, p.y - 92, p.x + 30, p.y + 8];
}

/** A vendor is clicked on their own body (wherever they are), and approached from their left. */
function vendorAt(agentId: AgentId, label: string, at: Point): Interactable {
  return { id: `vendor:${agentId}`, label, hit: personBox(at), approach: { x: at.x - 75, y: at.y + 14 } };
}

/** What the camera frames when the player talks to someone. */
export function focusRect(id: InteractId): Rect | null {
  if (id === "main") return [360, 560, 880, 860];
  if (id === "reviewer") return [60, 460, 400, 720];
  if (id.startsWith("vendor:")) {
    const { cx } = STALLS[id.slice("vendor:".length) as AgentId];
    return [cx - 200, 225, cx + 200, 520];
  }
  return null;
}

export function inside([x0, y0, x1, y1]: Rect, p: Point): boolean {
  return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
}

function clampTo([x0, y0, x1, y1]: Rect, p: Point): Point {
  return { x: Math.min(x1, Math.max(x0, p.x)), y: Math.min(y1, Math.max(y0, p.y)) };
}

export function walkable(p: Point): boolean {
  return WALKABLE.some((r) => inside(r, p)) && !BLOCKED_FEET.some((r) => inside(r, p));
}

/** Nearest place the player can stand for a click anywhere. */
export function standable(p: Point): Point {
  let best = clampTo(WALKABLE[0], p);
  for (const rect of WALKABLE) {
    const q = clampTo(rect, p);
    if (Math.hypot(q.x - p.x, q.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y)) best = q;
  }
  for (const rect of BLOCKED_FEET) {
    if (inside(rect, best)) best = { x: best.x, y: rect[3] + 8 };
  }
  return best;
}

/** True when a straight walk from a to b stays on the planks (a itself isn't checked). */
export function clearLine(a: Point, b: Point): boolean {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    if (!walkable({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) return false;
  }
  return true;
}

/** Waypoints from a to b that stay on the planks and go around the stalls. */
export function route(a: Point, b: Point): Point[] {
  if (clearLine(a, b)) return [b];
  const path = gridPath(a, b);
  if (!path) return [b];
  // Keep only the corners: from each point, jump to the farthest one in plain sight.
  const out: Point[] = [];
  let from = a;
  for (let i = 0; i < path.length; ) {
    let j = path.length - 1;
    while (j > i && !clearLine(from, path[j])) j -= 1;
    out.push(path[j]);
    from = path[j];
    i = j + 1;
  }
  return out;
}

// A* over a coarse grid of the walkable planks (8 directions, no cutting corners).
const CELL = 10;
const COLS = Math.ceil(WORLD.w / CELL);
const ROWS = Math.ceil(WORLD.h / CELL);
let freeCells: Uint8Array | null = null;

function cellCentre(i: number): Point {
  return { x: (i % COLS) * CELL + CELL / 2, y: Math.floor(i / COLS) * CELL + CELL / 2 };
}

function isFree(i: number): boolean {
  if (!freeCells) {
    freeCells = new Uint8Array(COLS * ROWS);
    for (let c = 0; c < freeCells.length; c += 1) freeCells[c] = walkable(cellCentre(c)) ? 1 : 0;
  }
  return freeCells[i] === 1;
}

/** The free cell nearest to p (within a few cells). */
function nearestFreeCell(p: Point): number | null {
  const c0 = Math.min(COLS - 1, Math.max(0, Math.floor(p.x / CELL)));
  const r0 = Math.min(ROWS - 1, Math.max(0, Math.floor(p.y / CELL)));
  for (let ring = 0; ring < 8; ring += 1) {
    for (let r = r0 - ring; r <= r0 + ring; r += 1) {
      for (let c = c0 - ring; c <= c0 + ring; c += 1) {
        if (r < 0 || c < 0 || r >= ROWS || c >= COLS) continue;
        if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) === ring && isFree(r * COLS + c)) return r * COLS + c;
      }
    }
  }
  return null;
}

function gridPath(a: Point, b: Point): Point[] | null {
  const start = nearestFreeCell(a);
  const goal = nearestFreeCell(b);
  if (start === null || goal === null) return null;
  const goalAt = cellCentre(goal);
  const guess = (i: number) => {
    const p = cellCentre(i);
    return Math.hypot(p.x - goalAt.x, p.y - goalAt.y);
  };
  const cost = new Map<number, number>([[start, 0]]);
  const cameFrom = new Map<number, number>();
  const open = new MinHeap();
  open.push(start, guess(start));
  while (open.size > 0) {
    const current = open.pop();
    if (current === goal) {
      const cells = [goal];
      while (cameFrom.has(cells[0])) cells.unshift(cameFrom.get(cells[0])!);
      return [...cells.slice(1, -1).map(cellCentre), b];
    }
    const c = current % COLS;
    const r = Math.floor(current / COLS);
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        const nc = c + dc;
        const nr = r + dr;
        if ((!dr && !dc) || nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
        const next = nr * COLS + nc;
        if (!isFree(next)) continue;
        if (dr && dc && (!isFree(r * COLS + nc) || !isFree(nr * COLS + c))) continue;
        const g = cost.get(current)! + (dr && dc ? Math.SQRT2 : 1) * CELL;
        if (g < (cost.get(next) ?? Infinity)) {
          cost.set(next, g);
          cameFrom.set(next, current);
          open.push(next, g + guess(next));
        }
      }
    }
  }
  return null;
}

/** A small binary min-heap of grid cells keyed by priority. */
class MinHeap {
  private items: { cell: number; key: number }[] = [];

  get size(): number {
    return this.items.length;
  }

  push(cell: number, key: number): void {
    const items = this.items;
    items.push({ cell, key });
    for (let i = items.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (items[parent].key <= items[i].key) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop(): number {
    const items = this.items;
    const top = items[0].cell;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && items[l].key < items[m].key) m = l;
        if (r < items.length && items[r].key < items[m].key) m = r;
        if (m === i) break;
        [items[m], items[i]] = [items[i], items[m]];
        i = m;
      }
    }
    return top;
  }
}

/** What's under a click. Vendors are hit on their own body, wherever they stand right now. */
export function hitTest(p: Point, vendorsAt: Partial<Record<AgentId, Point>> = {}): Interactable | null {
  const current = INTERACTABLES.map((it) => {
    if (!it.id.startsWith("vendor:")) return it;
    const agentId = it.id.slice("vendor:".length) as AgentId;
    const at = vendorsAt[agentId];
    return at ? vendorAt(agentId, it.label, at) : it;
  });
  // People in front first: a vendor standing by the lifeguard is still the vendor.
  const isVendor = (it: Interactable) => it.id.startsWith("vendor:");
  return [...current.filter(isVendor), ...current.filter((it) => !isVendor(it))].find((it) => inside(it.hit, p)) ?? null;
}
