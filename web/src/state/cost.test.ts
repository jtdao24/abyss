import { describe, expect, it } from "vitest";

import type { StatsData } from "../contract";
import { premiumPrice, purposeShares, savingsVsPremium } from "./cost";

const agent = (cost: number, input: number, output: number, won = 1) => ({
  cost_usd: cost, input_tokens: input, output_tokens: output, calls: 2, tasks_won: won,
});

function stats(): StatsData {
  return {
    total_cost_usd: 0.01,
    input_tokens: 5000,
    output_tokens: 3000,
    calls: 10,
    by_purpose: {
      split: { cost_usd: 0.001, calls: 1 },
      bid: { cost_usd: 0.002, calls: 3 },
      work: { cost_usd: 0.004, calls: 3 },
      review: { cost_usd: 0.002, calls: 2 },
      assemble: { cost_usd: 0.001, calls: 1 },
    },
    // bid + work tokens per vendor (the ledger's by_agent)
    by_agent: {
      haiku: agent(0.003, 2000, 1000),
      sonnet: agent(0.002, 1000, 500),
      opus: agent(0.001, 400, 100, 0),
    },
  };
}

describe("purposeShares", () => {
  it("adds up to 100%", () => {
    const total = purposeShares(stats()).reduce((sum, s) => sum + s.pct, 0);
    expect(total).toBeCloseTo(100);
    expect(purposeShares(stats()).find((s) => s.purpose === "work")?.pct).toBeCloseTo(40);
  });

  it("is all zero before anything is spent", () => {
    const empty = stats();
    for (const bucket of Object.values(empty.by_purpose)) bucket.cost_usd = 0;
    expect(purposeShares(empty).every((s) => s.pct === 0)).toBe(true);
  });
});

describe("savingsVsPremium", () => {
  it("reprices the vendors' tokens at VENDOR 1's model and keeps the rest", () => {
    const price: [number, number] = [1.25, 10]; // gpt-5
    const s = savingsVsPremium(stats(), price)!;
    const vendorPremium = (3400 * 1.25 + 1600 * 10) / 1_000_000;
    expect(s.premium).toBeCloseTo(0.01 - 0.006 + vendorPremium, 9);
    expect(s.saved).toBeCloseTo(s.premium - 0.01, 9);
    expect(s.pct).toBeGreaterThan(0);
  });

  it("shows nothing when the premium price is unknown", () => {
    expect(savingsVsPremium(stats(), null)).toBeNull();
    expect(premiumPrice(null, "openai")).toBeNull();
    expect(
      premiumPrice(
        { default_provider: "openai", fake: false, test_mode: false, tiers: { openai: { opus: "gpt-5" } }, prices: { "gpt-5": [1.25, 10] } },
        "openai",
      ),
    ).toEqual([1.25, 10]);
  });
});
