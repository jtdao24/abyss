import { useEffect, useState } from "react";

import { CostQualityScatter, LearningCurve, RepHeatmap } from "./results/charts";
import { AGENT_IDS, MARKET_COLOR, AGENT_COLOR, armColor, type ExperimentResults } from "./results/types";

type Load = { status: "loading" } | { status: "empty" } | { status: "error"; message: string } | { status: "ok"; data: ExperimentResults; file: string };

function dataBadge(data: ExperimentResults): { label: string; tone: string } {
  if (data.config.fake_llm) return { label: "FAKE DATA — not a real result", tone: "offline" };
  if (!data.config.real_models) return { label: "HAIKU TEST MODE", tone: "test" };
  return { label: "REAL MODELS", tone: "live" };
}

export function Results() {
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("results");
    (async () => {
      const index = (await (await fetch("/results/index.json")).json()) as string[];
      const file = requested ? `${requested}.json` : index[0];
      if (!file) return setLoad({ status: "empty" });
      const data = (await (await fetch(`/results/${file}`)).json()) as ExperimentResults;
      setLoad({ status: "ok", data, file });
    })().catch((error: unknown) => setLoad({ status: "error", message: String(error) }));
  }, []);

  if (load.status === "loading") return <main className="results"><p>Loading results…</p></main>;
  if (load.status === "error") return <main className="results"><p>Could not load results: {load.message}</p></main>;
  if (load.status === "empty") {
    return (
      <main className="results">
        <p>No experiment results yet. Run <code>python -m abyss.experiment</code>, then restart <code>npm run dev</code>.</p>
      </main>
    );
  }

  const { data, file } = load;
  const badge = dataBadge(data);
  const arms = [...data.arms].sort((a, b) => a.total_usd - b.total_usd);
  const opus = arms.find((a) => a.arm === "fixed:opus");
  const market = arms.filter((a) => a.fixed_agent_id === null);

  return (
    <main className="results">
      <header className="results-header">
        <div>
          <h1>Cost vs quality</h1>
          <p>{data.jobs.length} jobs · {file} · reviewer {data.config.reviewer_model}</p>
        </div>
        <span className={`mode-badge ${badge.tone}`}>{badge.label}</span>
      </header>

      {opus && market.length > 0 && (
        <section className="headline">
          {market.map((a) => (
            <div key={a.arm}>
              <strong>{a.arm}</strong>
              <span>{Math.round((a.total_usd / opus.total_usd) * 100)}% of all-Opus cost</span>
              <span>grade {a.mean_grade ?? "—"} vs {opus.mean_grade ?? "—"}</span>
            </div>
          ))}
        </section>
      )}

      <section>
        <h2>Every arm: total cost vs mean grade</h2>
        <div className="legend">
          <span><i className="dot" style={{ background: MARKET_COLOR }} />market (price weight 0 → 3, dashed)</span>
          {AGENT_IDS.map((id) => (
            <span key={id}><i className="square" style={{ background: AGENT_COLOR[id] }} />always {id}</span>
          ))}
        </div>
        <CostQualityScatter arms={arms} />
      </section>

      <section>
        <h2>Learning curve: grade by job (0–10)</h2>
        <div className="curves">
          {arms.map((a) => <LearningCurve key={a.arm} arm={a} />)}
        </div>
      </section>

      {market.length > 0 && (
        <section>
          <h2>Final reputation (red = overpromised, blue = over-delivered)</h2>
          <div className="curves">
            {market.map((a) => <RepHeatmap key={a.arm} arm={a} />)}
          </div>
        </section>
      )}

      <section>
        <h2>Table</h2>
        <table>
          <thead>
            <tr><th>Arm</th><th>Total $</th><th>Work $</th><th>Bid $</th><th>Review $</th><th>Mean grade</th><th>$/grade pt</th><th>Wins H/S/O</th></tr>
          </thead>
          <tbody>
            {arms.map((a) => (
              <tr key={a.arm}>
                <td><i className="square" style={{ background: armColor(a) }} /> {a.arm}</td>
                <td>{a.total_usd.toFixed(4)}</td>
                <td>{a.work_usd.toFixed(4)}</td>
                <td>{a.bid_usd.toFixed(4)}</td>
                <td>{a.review_usd.toFixed(4)}</td>
                <td>{a.mean_grade ?? "—"}</td>
                <td>{a.usd_per_grade_point ?? "—"}</td>
                <td>{AGENT_IDS.map((id) => Object.values(a.wins[id]).reduce((s, n) => s + n, 0)).join("/")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="footnote">Split cost (shared by all arms, paid once): ${data.split_usd.toFixed(4)} over {data.split_calls} calls.</p>
      </section>
    </main>
  );
}
