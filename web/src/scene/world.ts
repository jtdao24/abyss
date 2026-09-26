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
/** Where the boardwalk meets the pier: routes between the two pass through it. */
export const JUNCTION: Point = { x: 220, y: 470 };
export const PLAYER_START: Point = { x: 640, y: 462 };

/** Walkable planks: the boardwalk and the pier. */
export const DECK: Rect = [20, 340, 1650, 472];
export const PIER: Rect = [112, 472, 330, 792];
const WALKABLE: Rect[] = [DECK, PIER];

/** Stall bodies: the player can't stand inside them. */
export const BLOCKED: Rect[] = [
  [322, 245, 552, 428],
  [732, 245, 952, 428],
  [1138, 245, 1368, 428],
];

export type InteractId = "main" | "reviewer" | "tasks" | `vendor:${AgentId}`;

export interface Interactable {
  id: InteractId;
  label: string;
  hit: Rect;
  approach: Point;
}

export const INTERACTABLES: Interactable[] = [
  { id: "main", label: "MAIN AGENT - GIVE A JOB", hit: [445, 670, 575, 775], approach: { x: 312, y: 728 } },
  { id: "reviewer", label: "REVIEWER", hit: [122, 505, 200, 580], approach: { x: 200, y: 610 } },
  { id: "vendor:opus", label: "VENDOR 1", hit: [322, 245, 552, 478], approach: { x: 505, y: 465 } },
  { id: "vendor:sonnet", label: "VENDOR 2", hit: [732, 245, 952, 478], approach: { x: 910, y: 465 } },
  { id: "vendor:haiku", label: "VENDOR 3", hit: [1138, 245, 1368, 478], approach: { x: 1320, y: 465 } },
];

export function inside([x0, y0, x1, y1]: Rect, p: Point): boolean {
  return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
}

function clampTo([x0, y0, x1, y1]: Rect, p: Point): Point {
  return { x: Math.min(x1, Math.max(x0, p.x)), y: Math.min(y1, Math.max(y0, p.y)) };
}

export function walkable(p: Point): boolean {
  return WALKABLE.some((r) => inside(r, p)) && !BLOCKED.some((r) => inside(r, p));
}

/** Nearest place the player can stand for a click anywhere. */
export function standable(p: Point): Point {
  let best = clampTo(WALKABLE[0], p);
  for (const rect of WALKABLE) {
    const q = clampTo(rect, p);
    if (Math.hypot(q.x - p.x, q.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y)) best = q;
  }
  for (const rect of BLOCKED) {
    if (inside(rect, best)) best = { x: best.x, y: rect[3] + 16 };
  }
  return best;
}

/** Waypoints from a to b that stay on the planks (via the junction if needed). */
export function route(a: Point, b: Point): Point[] {
  const onPier = (p: Point) => inside(PIER, p) && p.y > DECK[3];
  if (onPier(a) !== onPier(b)) return [JUNCTION, b];
  return [b];
}

export function hitTest(p: Point): Interactable | null {
  return INTERACTABLES.find((it) => inside(it.hit, p)) ?? null;
}
