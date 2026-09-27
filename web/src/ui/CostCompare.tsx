import { compareToTopModel, describeDelta, formatUsd } from "../state/costs";
import type { MarketState } from "../state/reducer";

/** Header strip: what this job cost through Abyss vs the top model doing it all. */
export function CostCompare({ state }: { state: MarketState }) {
  const cmp = compareToTopModel(state);
  if (!cmp) {
    return (
      <div className="cost-compare idle">
        <span>vs top model</span>
        <small>{state.config && !state.config.prices ? "no prices in this recording" : "after the first task"}</small>
      </div>
    );
  }
  const delta = describeDelta(cmp.delta);
  const max = Math.max(cmp.abyss, cmp.baseline);
  return (
    <div
      className="cost-compare"
      title={
        `Abyss has spent ${formatUsd(cmp.abyss)} on this job${state.final ? "" : " so far"}. ` +
        `${cmp.topName} doing every task alone: about ${formatUsd(cmp.baseline)} ` +
        `(same work tokens at ${cmp.topName} rates, same planning and review, no bidding).`
      }
    >
      <div className="cc-rows">
        <div>
          <span>Abyss</span>
          <i><b className="abyss" style={{ width: `${(cmp.abyss / max) * 100}%` }} /></i>
          <strong>{formatUsd(cmp.abyss)}</strong>
        </div>
        <div>
          <span>{cmp.topName} only</span>
          <i><b className="top" style={{ width: `${(cmp.baseline / max) * 100}%` }} /></i>
          <strong>≈{formatUsd(cmp.baseline)}</strong>
        </div>
      </div>
      <em className={`cc-delta ${delta.tone}`}>{delta.text}</em>
    </div>
  );
}
