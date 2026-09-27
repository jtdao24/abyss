import { compareToTopModel, describeDelta, formatUsd } from "../state/costs";
import type { MarketState } from "../state/reducer";

/** Header strip: what this job cost through Abyss vs the top model doing it all. */
export function CostCompare({ state }: { state: MarketState }) {
  const cmp = compareToTopModel(state);
  if (!cmp) {
    return (
      <div className="cost-compare idle">
        <span>Cost vs top model</span>
        <small>{state.config && !state.config.prices ? "no prices in this recording" : "after the first task"}</small>
      </div>
    );
  }
  const delta = describeDelta(cmp.delta);
  const share = cmp.baseline > 0 ? Math.min(100, (cmp.abyss / cmp.baseline) * 100) : 100;
  return (
    <div
      className="cost-compare"
      title={
        `Abyss has spent ${formatUsd(cmp.abyss)} on this job${state.final ? "" : " so far"}. ` +
        `${cmp.topName} doing every task alone: about ${formatUsd(cmp.baseline)} ` +
        `(same work tokens at ${cmp.topName} rates, same planning and review, no bidding).`
      }
    >
      <div className="cc-figures">
        <div className="cc-line">
          <span>This job</span>
          <strong>{formatUsd(cmp.abyss)}</strong>
          <span className="cc-vs">vs {cmp.topName} alone ≈{formatUsd(cmp.baseline)}</span>
        </div>
        <i className="cc-bar"><b style={{ width: `${share}%` }} /></i>
      </div>
      <em className={`cc-delta ${delta.tone}`}>{delta.text}</em>
    </div>
  );
}
