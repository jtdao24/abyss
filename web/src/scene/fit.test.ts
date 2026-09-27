import { describe, expect, it } from "vitest";

import { MAX_CROP, fitScale } from "./fit";

const W = 1672;
const H = 941;

describe("fitScale", () => {
  it("skips an empty (minimized) stage", () => {
    expect(fitScale(0, 0, W, H)).toBeNull();
    expect(fitScale(800, 0, W, H)).toBeNull();
  });

  it("fills an exact-aspect stage with no crop", () => {
    const fit = fitScale(W / 2, H / 2, W, H)!;
    expect(fit.scale).toBeCloseTo(0.5);
    expect(fit).toMatchObject({ x: 0, y: 0 });
  });

  it("covers a slightly wider stage completely", () => {
    const fit = fitScale(1340, 600, W, H)!;
    expect(W * fit.scale).toBeGreaterThanOrEqual(1340 - 1);
    expect(H * fit.scale).toBeGreaterThanOrEqual(600 - 1);
  });

  it("never crops more than MAX_CROP on very wide or tall stages", () => {
    for (const [w, h] of [[3000, 600], [500, 1200], [1920, 400]]) {
      const fit = fitScale(w, h, W, H)!;
      const shownW = Math.min(1, w / (W * fit.scale));
      const shownH = Math.min(1, h / (H * fit.scale));
      expect(shownW).toBeGreaterThanOrEqual(1 - MAX_CROP - 1e-9);
      expect(shownH).toBeGreaterThanOrEqual(1 - MAX_CROP - 1e-9);
    }
  });
});
