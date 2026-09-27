import { describe, expect, it } from "vitest";

import { daylightAt, daylightFor, oppositeTimeMode } from "./daylight";

describe("daylightAt", () => {
  it("leaves the art as painted at midday", () => {
    expect(daylightAt(12)).toEqual({ tint: "#ffffff", lamps: 0 });
  });

  it("is blue with the lamps on at night", () => {
    expect(daylightAt(2)).toEqual({ tint: "#4a5aa0", lamps: 1 });
    expect(daylightAt(23)).toEqual({ tint: "#4a5aa0", lamps: 1 });
  });

  it("turns gold at sunset and blends between keys", () => {
    expect(daylightAt(18.5)).toEqual({ tint: "#ffb070", lamps: 0.45 });
    const dusk = daylightAt(19.25);
    expect(dusk.lamps).toBeGreaterThan(0.45);
    expect(dusk.lamps).toBeLessThan(1);
  });

  it("wraps hours outside 0 to 24", () => {
    expect(daylightAt(26)).toEqual(daylightAt(2));
    expect(daylightAt(-12)).toEqual(daylightAt(12));
  });
});

describe("daylightFor", () => {
  it("pins day and night, and follows the clock on auto", () => {
    const evening = new Date(2026, 0, 1, 23, 0);
    const noon = new Date(2026, 0, 1, 12, 0);
    expect(daylightFor("day", evening).lamps).toBe(0);
    expect(daylightFor("night", noon).lamps).toBe(1);
    expect(daylightFor("auto", evening).lamps).toBe(1);
    expect(daylightFor("auto", noon).lamps).toBe(0);
  });

  it("offers the opposite manual light mode", () => {
    expect(oppositeTimeMode("night")).toBe("day");
    expect(oppositeTimeMode("day")).toBe("night");
    expect(oppositeTimeMode("auto", new Date(2026, 0, 1, 2))).toBe("day");
    expect(oppositeTimeMode("auto", new Date(2026, 0, 1, 12))).toBe("night");
  });
});
