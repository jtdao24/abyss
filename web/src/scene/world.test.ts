import { describe, expect, it } from "vitest";

import { INTERACTABLES, JUNCTION, STALLS, hitTest, route, standable, walkable } from "./world";

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

  it("routes between boardwalk and pier through the junction", () => {
    expect(route({ x: 1250, y: 452 }, { x: 290, y: 690 })).toEqual([JUNCTION, { x: 290, y: 690 }]);
    expect(route({ x: 435, y: 452 }, { x: 1250, y: 452 })).toEqual([{ x: 1250, y: 452 }]);
  });

  it("finds what was clicked", () => {
    expect(hitTest({ x: 510, y: 720 })?.id).toBe("main");
    expect(hitTest({ x: 840, y: 300 })?.id).toBe("vendor:sonnet");
    expect(hitTest({ x: 1000, y: 800 })).toBeNull();
  });
});
