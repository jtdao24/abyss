import type { Prices, SessionSummary, Usage } from "../api";
import type { AgentId } from "../contract";
import { VENDOR } from "../scene/model";
import { PURPOSE_LABEL, compareToTopModel, describeDelta, formatTokens as tokens, formatUsd as usd, purposeShares } from "../state/money";
import type { MarketState } from "../state/reducer";

const STALLS: AgentId[] = ["haiku", "sonnet", "opus"]; // VENDOR 3, 2, 1 (budget first)
const PURPOSE_COLOR: Record<string, string> = {
  split: "var(--abyss-teal)",
  bid: "var(--abyss-gold-deep)",
  work: "var(--abyss-research)",
  review: "var(--abyss-checking)",
  assemble: "var(--abyss-writing)",
};

/** Last jobs' cost as a sparkline, with what VENDOR 1 would have cost as a faint line. */
function Sparkline({ recent }: { recent: Usage["recent"] }) {
  if (recent.length < 2) return <p className="cost-note">The trend line appears after two sessions.</p>;
  const w = 260;
  const h = 56;
  const max = Math.max(...recent.map((j) => Math.max(j.cost_usd, j.premium_equiv_usd)), 1e-9);
  const x = (i: number) => (i / (recent.length - 1)) * (w - 4) + 2;
  const y = (v: number) => h - 3 - (v / max) * (h - 8);
  const line = (key: "cost_usd" | "premium_equiv_usd") => recent.map((j, i) => `${x(i).toFixed(1)},${y(j[key]).toFixed(1)}`).join(" ");
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Cost of the last ${recent.length} sessions`}>
      <polyline points={line("premium_equiv_usd")} className="ghost" />
      <polyline points={line("cost_usd")} className="actual" />
      {recent.map((j, i) => (
        <circle key={j.job_id} cx={x(i)} cy={y(j.cost_usd)} r={2.2}>
          <title>{`${usd(j.cost_usd)} (all VENDOR 1: ${usd(j.premium_equiv_usd)}) · ${j.job_text.slice(0, 60)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

export function CostPanel({
  state,
  prices,
  usage,
  sessions,
  onClose,
}: {
  state: MarketState;
  prices: Prices | null;
  usage: Usage | null;
  sessions: SessionSummary[];
  onClose(): void;
}) {
  const stats = state.final ? null : state.stats; // live numbers, else the final ones below
  const live = stats ?? state.stats;
  const jobId = state.currentJob?.jobId ?? null;
  const provider = sessions.find((s) => s.id === jobId)?.provider ?? prices?.default_provider ?? null;
  const budget = sessions.find((s) => s.id === jobId)?.budget_usd ?? null;
  const spent = state.final?.total_cost_usd ?? live?.total_cost_usd ?? 0;
  // The same comparison as the header strip: work repriced at the top stall's model, no bids.
  const cmp = compareToTopModel(state);
  const tasks = state.taskOrder.length;

  return (
    <aside className="cost-panel" aria-label="Costs and tokens">
      <header className="cost-head">
        <strong>Costs &amp; tokens</strong>
        <button type="button" onClick={onClose} aria-label="Hide costs">×</button>
      </header>

      <section className="cost-card">
        <h3>This session</h3>
        {!live ? (
          <p className="cost-note">Start a session from the Captain to see live spend here.</p>
        ) : (
          <>
            <div className="cost-big">
              {usd(spent)}
              {budget !== null && <small> of {usd(budget)} budget</small>}
            </div>
            {budget !== null && (
              <div className={`budget-bar ${spent >= budget ? "over" : ""}`} aria-label="Budget used">
                <i style={{ width: `${Math.min(100, (spent / budget) * 100)}%` }} />
              </div>
            )}
            <dl className="cost-stats">
              <div><dt>Tokens in</dt><dd>{tokens(live.input_tokens)}</dd></div>
              <div><dt>Tokens out</dt><dd>{tokens(live.output_tokens)}</dd></div>
              <div><dt>AI calls</dt><dd>{live.calls}</dd></div>
              <div><dt>Per task</dt><dd>{tasks ? usd(spent / tasks) : "—"}</dd></div>
              <div><dt>Grade</dt><dd>{state.final?.mean_grade != null ? `${state.final.mean_grade}/10` : "—"}</dd></div>
              <div><dt>AI</dt><dd>{provider === "meta" ? "Muse" : provider === "openai" ? "OpenAI" : "—"}</dd></div>
            </dl>
          </>
        )}
      </section>

      {live && (
        <section className="cost-card">
          <h3>Where it went</h3>
          <div className="stack-bar" role="img" aria-label="Spend by kind of call">
            {purposeShares(live).filter((s) => s.cost > 0).map((s) => (
              <i key={s.purpose} style={{ width: `${s.pct}%`, background: PURPOSE_COLOR[s.purpose] }} title={`${PURPOSE_LABEL[s.purpose]}: ${usd(s.cost)} (${s.calls} calls)`} />
            ))}
          </div>
          <ul className="legend">
            {purposeShares(live).map((s) => (
              <li key={s.purpose}>
                <b style={{ background: PURPOSE_COLOR[s.purpose] }} />
                {PURPOSE_LABEL[s.purpose]} <span>{usd(s.cost)} · {s.pct.toFixed(0)}%</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {live && (
        <section className="cost-card">
          <h3>By vendor</h3>
          <table className="vendor-table">
            <thead>
              <tr><th>Stall</th><th>Won</th><th>In / out</th><th>Spent</th><th>Per win</th></tr>
            </thead>
            <tbody>
              {STALLS.map((id) => {
                const a = live.by_agent[id];
                const model = provider ? prices?.tiers[provider]?.[id] : null;
                return (
                  <tr key={id}>
                    <td>
                      <span className="stall-dot" style={{ background: VENDOR[id].color }} />
                      {VENDOR[id].name}
                      {model && <small>{model}</small>}
                    </td>
                    <td>{a.tasks_won}</td>
                    <td>{tokens(a.input_tokens)} / {tokens(a.output_tokens)}</td>
                    <td>{usd(a.cost_usd)}</td>
                    <td>{a.tasks_won ? usd(a.cost_usd / a.tasks_won) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {cmp && (
        <section className={`cost-card savings ${cmp.delta <= 0 ? "good" : "bad"}`}>
          <h3>Market vs. {cmp.topName} for everything</h3>
          <div className="cost-big">
            {cmp.delta <= 0 ? `${usd(cmp.baseline - cmp.abyss)} saved` : `${usd(cmp.abyss - cmp.baseline)} more`}
            <small> ({describeDelta(cmp.delta).text})</small>
          </div>
          <p className="cost-note">
            {usd(cmp.abyss)} spent vs about {usd(cmp.baseline)} if {cmp.topName} had done every task
            {state.final?.mean_grade != null ? `, at an average grade of ${state.final.mean_grade}/10` : ""}. Estimate: the same
            work tokens at its rates, the same planning, review and packaging, and no bids.
          </p>
        </section>
      )}

      <section className="cost-card">
        <h3>All sessions</h3>
        {!usage || usage.totals.jobs === 0 ? (
          <p className="cost-note">Nothing yet. Every session's spend is added up here.</p>
        ) : (
          <>
            <dl className="cost-stats">
              <div><dt>Spent</dt><dd>{usd(usage.totals.cost_usd)}</dd></div>
              <div><dt>Sessions</dt><dd>{usage.totals.jobs}</dd></div>
              <div><dt>Per session</dt><dd>{usd(usage.totals.cost_usd / usage.totals.jobs)}</dd></div>
              <div><dt>Tokens</dt><dd>{tokens(usage.totals.input_tokens + usage.totals.output_tokens)}</dd></div>
              <div><dt>Avg grade</dt><dd>{usage.mean_grade != null ? `${usage.mean_grade.toFixed(1)}/10` : "—"}</dd></div>
              <div><dt>Saved</dt><dd>{usd(Math.max(0, usage.totals.premium_equiv_usd - usage.totals.cost_usd))}</dd></div>
            </dl>
            <Sparkline recent={usage.recent} />
            <ul className="legend">
              {Object.entries(usage.by_provider).map(([name, p]) => (
                <li key={name}>
                  <b style={{ background: name === "meta" ? "var(--abyss-checking)" : "var(--abyss-teal)" }} />
                  {name === "meta" ? "Muse" : name === "openai" ? "OpenAI" : name}
                  <span>{usd(p.cost_usd)} · {p.jobs} sessions</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </aside>
  );
}
