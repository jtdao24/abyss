import { describe, expect, it } from "vitest";

import { INTERACTABLES, STALLS, type Point, clearLine, hitTest, route, standable, walkable } from "./world";

describe("boardwalk world", () => {
  it("keeps clicks on the planks, never in the water", () => {
    expect(walkable(standable({ x: 1000, y: 800 }))).toBe(true); // open water -> boardwalk edge
    expect(walkable(standable({ x: 5, y: 5 }))).toBe(true);
  });

  it("steps a click inside a stall out in front of it", () => {
    const p = standable({ x: 840, y: 330 });
    expect(walkable(p)).toBe(true);
    expect(p.y).toBeGreaterThan(428);
  });

  it("puts every approach point, vendor home and gather spot on the planks", () => {
    for (const it of INTERACTABLES) expect(walkable(it.approach), it.id).toBe(true);
    for (const [id, s] of Object.entries(STALLS)) {
      expect(walkable(s.home), `${id} home`).toBe(true);
      expect(walkable(s.gather), `${id} gather`).toBe(true);
    }
  });

  const staysOnPlanks = (from: Point, path: Point[]) =>
    path.every((p, i) => walkable(p) && clearLine(i === 0 ? from : path[i - 1], p));

  it("walks straight when nothing is in the way", () => {
    expect(route({ x: 435, y: 452 }, { x: 1250, y: 452 })).toEqual([{ x: 1250, y: 452 }]);
  });

  it("walks around a stall instead of through it", () => {
    const from = { x: 250, y: 400 }; // left of Vendor 1's stall
    const to = { x: 640, y: 400 }; // between Vendor 1's and Vendor 2's stalls
    expect(clearLine(from, to)).toBe(false);
    const path = route(from, to);
    expect(path.length).toBeGreaterThan(1);
    expect(path.at(-1)).toEqual(to);
    expect(staysOnPlanks(from, path)).toBe(true);
  });

  it("routes between boardwalk and pier on the planks", () => {
    const from = { x: 1250, y: 452 };
    const path = route(from, { x: 290, y: 690 });
    expect(staysOnPlanks(from, path)).toBe(true);
  });

  it("can't stand on a stall's flower barrels", () => {
    expect(walkable({ x: 300, y: 400 })).toBe(false); // Vendor 1's left barrel
    expect(walkable({ x: 960, y: 400 })).toBe(false); // Vendor 2's right barrel
  });

  it("clicks a vendor only on the vendor, and follows them when they move", () => {
    expect(hitTest({ x: 510, y: 720 })?.id).toBe("main");
    expect(hitTest({ x: 840, y: 420 })?.id).toBe("vendor:sonnet"); // on the vendor
    expect(hitTest({ x: 840, y: 300 })).toBeNull(); // the awning is just the stall
    expect(hitTest({ x: 760, y: 400 })).toBeNull(); // the counter beside them too
    const away = { sonnet: { x: 290, y: 650 } }; // gone to the pier to bid
    expect(hitTest({ x: 840, y: 420 }, away)).toBeNull();
    expect(hitTest({ x: 290, y: 620 }, away)?.id).toBe("vendor:sonnet");
    expect(hitTest({ x: 1000, y: 800 })).toBeNull();
  });
});
