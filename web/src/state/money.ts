// Money and tokens, in one place: what a job cost, where the spend went, and
// what it would have cost to hand every task straight to the priciest stall's
// model (no auction). Every screen that shows a cost formats it here.
import type { AgentId, StatsData } from "../contract";
import type { MarketState } from "./reducer";

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

export interface TopModelComparison {
  /** Display name of the model the baseline uses, e.g. "GPT-5". */
  topName: string;
  topModel: string;
  /** What Abyss has spent on this job so far. */
  abyss: number;
  /** Estimated cost of the same job with the top model doing every task. */
  baseline: number;
  /** Work calls only: the market's winners vs the top model on the same tokens. */
  work: { abyss: number; baseline: number };
  /** Bid calls, which only the market pays for. */
  bidding: number;
  /** Split, review and packaging: the same in both. */
  shared: number;
  tasksPriced: number;
  /** (abyss - baseline) / baseline: negative means Abyss was cheaper. */
  delta: number;
}

type Prices = Record<string, [number, number]>;

function priceOf(prices: Prices, model: string, input: number, output: number): number {
  const [pin, pout] = prices[model];
  return (input * pin + output * pout) / 1_000_000;
}

/** The stall whose model costs the most per token (the premium tier). */
function topStall(state: MarketState, prices: Prices): { model: string; name: string } | null {
  let best: { model: string; name: string; rate: number } | null = null;
  for (const agentId of ["haiku", "sonnet", "opus"] as AgentId[]) {
    const agent = state.agents[agentId];
    if (!agent || !prices[agent.model]) continue;
    const [pin, pout] = prices[agent.model];
    // >= so a tie goes to the later (premium) stall.
    if (!best || pin + pout >= best.rate) best = { model: agent.model, name: agent.display_name, rate: pin + pout };
  }
  return best && { model: best.model, name: best.name };
}

/** Null until prices are known and at least one task has finished its work. */
export function compareToTopModel(state: MarketState): TopModelComparison | null {
  const prices = state.config?.prices;
  if (!prices || !state.stats) return null;
  const top = topStall(state, prices);
  if (!top) return null;

  let workAbyss = 0;
  let workBaseline = 0;
  let tasksPriced = 0;
  for (const taskId of state.taskOrder) {
    const usage = state.tasks[taskId]?.workUsage;
    if (!usage) continue;
    workAbyss += usage.cost_usd;
    workBaseline += priceOf(prices, top.model, usage.input_tokens, usage.output_tokens);
    tasksPriced += 1;
  }
  if (tasksPriced === 0) return null;

  const purpose = state.stats.by_purpose;
  const bidding = purpose.bid.cost_usd;
  const shared = purpose.split.cost_usd + purpose.review.cost_usd + purpose.assemble.cost_usd;
  // Work comes from the tasks' own `done` usage on both sides: a `done` lands just
  // before the `stats` that counts it, and the two sides must price the same tasks.
  const abyss = shared + bidding + workAbyss;
  const baseline = shared + workBaseline;
  return {
    topName: top.name,
    topModel: top.model,
    abyss,
    baseline,
    work: { abyss: workAbyss, baseline: workBaseline },
    bidding,
    shared,
    tasksPriced,
    delta: baseline > 0 ? (abyss - baseline) / baseline : 0,
  };
}

export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  const abs = Math.abs(usd);
  const sign = usd < 0 ? "-" : "";
  if (abs < 0.0001) return `${sign}<$0.0001`;
  return `${sign}$${abs < 1 ? abs.toFixed(4) : abs.toFixed(2)}`;
}

/** 950, 1.2k, 3.4M. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** "28% cheaper" / "12% pricier" / "same cost". */
export function describeDelta(delta: number): { text: string; tone: "better" | "worse" | "even" } {
  const pct = Math.round(Math.abs(delta) * 100);
  if (pct === 0) return { text: "same cost", tone: "even" };
  return delta < 0 ? { text: `${pct}% cheaper`, tone: "better" } : { text: `${pct}% pricier`, tone: "worse" };
}
