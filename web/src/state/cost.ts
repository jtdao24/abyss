// Cost and token maths for the dashboard (pure, so it's easy to test).
import type { Prices } from "../api";
import type { AgentId, StatsData } from "../contract";

export const PURPOSES = ["split", "bid", "work", "review", "assemble"] as const;
export type PurposeName = (typeof PURPOSES)[number];
export const PURPOSE_LABEL: Record<PurposeName, string> = {
  split: "Plan",
  bid: "Bids",
  work: "Work",
  review: "Review",
  assemble: "Package",
};

export interface PurposeShare {
  purpose: PurposeName;
  cost: number;
  calls: number;
  pct: number;
}

/** Each kind of call's share of the spend. Percentages sum to 100 (or are all 0). */
export function purposeShares(stats: StatsData): PurposeShare[] {
  const total = PURPOSES.reduce((sum, p) => sum + (stats.by_purpose[p]?.cost_usd ?? 0), 0);
  return PURPOSES.map((purpose) => {
    const bucket = stats.by_purpose[purpose];
    const cost = bucket?.cost_usd ?? 0;
    return { purpose, cost, calls: bucket?.calls ?? 0, pct: total > 0 ? (cost / total) * 100 : 0 };
  });
}

/** Price per million tokens of the model a provider's premium stall (VENDOR 1) runs on. */
export function premiumPrice(prices: Prices | null, provider: string | null): [number, number] | null {
  if (!prices || !provider) return null;
  const model = prices.tiers[provider]?.opus;
  return (model && prices.prices[model]) || null;
}

export interface Savings {
  actual: number;
  premium: number;
  saved: number;
  pct: number;
}

/**
 * What the session would have cost with VENDOR 1 doing every bid and task:
 * the vendors' own tokens (bid + work calls) repriced at the premium model,
 * plus the plan / review / package calls, which cost the same either way.
 * An estimate: a premium model wouldn't use exactly the same tokens.
 */
export function savingsVsPremium(stats: StatsData, price: [number, number] | null): Savings | null {
  if (!price) return null;
  const agents = Object.values(stats.by_agent) as StatsData["by_agent"][AgentId][];
  const vendorActual = agents.reduce((sum, a) => sum + a.cost_usd, 0);
  const vendorPremium = agents.reduce((sum, a) => sum + (a.input_tokens * price[0] + a.output_tokens * price[1]) / 1_000_000, 0);
  const actual = stats.total_cost_usd;
  const premium = actual - vendorActual + vendorPremium;
  const saved = premium - actual;
  return { actual, premium, saved, pct: premium > 0 ? (saved / premium) * 100 : 0 };
}

export const usd = (value: number): string => {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
};

export const tokens = (value: number): string =>
  value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
