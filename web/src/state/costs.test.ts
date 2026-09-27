import { describe, expect, it } from "vitest";

import fixture from "../../public/fixtures/fake_run.json";
import type { AbyssEvent } from "../contract";
import { compareToTopModel, describeDelta, formatUsd } from "./costs";
import { initialState, reduce } from "./reducer";

const events = fixture as AbyssEvent[];

describe("compareToTopModel", () => {
  it("reprices the fixture's work at GPT-6 Astra rates and drops the bids", () => {
    const cmp = compareToTopModel(events.reduce(reduce, initialState))!;

    expect(cmp.topModel).toBe("gpt-6-astra");
    expect(cmp.topName).toBe("GPT-6 Astra");
    expect(cmp.tasksPriced).toBe(3);
    expect(cmp.abyss).toBeCloseTo(0.062432, 6); // matches the ledger total once stats catch up
    expect(cmp.bidding).toBeCloseTo(0.000543, 6); // 7 quotes, all written by GPT-6 Luna
    expect(cmp.work.abyss).toBeCloseTo(0.043189, 6);
    // At $10 / $50 per M: t1 210 in / 455 out, t2 470 / 720, t3 430 / 610 (already on Astra).
    expect(cmp.work.baseline).toBeCloseTo(0.02485 + 0.0407 + 0.0348, 7);
    expect(cmp.shared).toBeCloseTo(0.00414 + 0.00786 + 0.0067, 6);
    expect(cmp.baseline).toBeCloseTo(cmp.shared + cmp.work.baseline, 6);
    expect(cmp.delta).toBeLessThan(0); // two of three tasks kept off Astra
  });

  it("prices the same tasks on both sides while stats lag a done event", () => {
    const firstDone = events.findIndex((ev) => ev.type === "done");
    const state = events.slice(0, firstDone + 1).reduce(reduce, initialState);
    expect(state.stats?.by_purpose.work.calls).toBe(0); // the stats snapshot hasn't counted it yet
    const cmp = compareToTopModel(state)!;
    expect(cmp.work.abyss).toBeCloseTo(0.000249, 6);
    expect(cmp.abyss).toBeCloseTo(cmp.shared + cmp.bidding + 0.000249, 6);
    expect(cmp.baseline).toBeCloseTo(cmp.shared + 0.02485, 7);
  });

  it("waits for prices and for the first finished task", () => {
    expect(compareToTopModel(initialState)).toBeNull();
    const firstDone = events.findIndex((ev) => ev.type === "done");
    expect(compareToTopModel(events.slice(0, firstDone).reduce(reduce, initialState))).toBeNull();
    const noPrices = events.map((ev) =>
      ev.type === "hello" ? { ...ev, data: { ...ev.data, config: { ...ev.data.config, prices: undefined } } } : ev,
    ) as AbyssEvent[];
    expect(compareToTopModel(noPrices.reduce(reduce, initialState))).toBeNull();
  });
});

describe("formatting", () => {
  it("formats money and deltas", () => {
    expect(formatUsd(0.04448)).toBe("$0.0445");
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.00001)).toBe("<$0.0001");
    expect(formatUsd(-0.0097)).toBe("-$0.0097");
    expect(describeDelta(-0.281)).toEqual({ text: "28% cheaper", tone: "better" });
    expect(describeDelta(0.28)).toEqual({ text: "28% pricier", tone: "worse" });
    expect(describeDelta(0.001)).toEqual({ text: "same cost", tone: "even" });
  });
});
