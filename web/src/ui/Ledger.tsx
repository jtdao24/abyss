import type { AbyssEvent, AgentId, FinalData, Purpose, TaskType } from "../contract";
import { AGENT_ORDER, VENDOR, isStandby, vendorTitle } from "../scene/model";
import { compareToTopModel, describeDelta, formatUsd } from "../state/money";
import type { MarketState, TaskView } from "../state/reducer";

const PURPOSES: { key: Purpose; label: string }[] = [
  { key: "work", label: "Work" },
  { key: "review", label: "Grading" },
  { key: "split", label: "Planning" },
  { key: "assemble", label: "Packaging" },
  { key: "bid", label: "Bids" },
];

const TYPE_LABEL: Record<TaskType, string> = { research: "Research", writing: "Writing", checking: "Checking" };

const STATUS_LABEL: Record<TaskView["status"], string> = {
  pending: "Waiting",
  open: "Bidding",
  assigned: "Starting",
  working: "Working",
  done: "Grading",
  graded: "Graded",
  failed: "Failed",
};

const FINAL_LABEL: Record<FinalData["status"], string> = { ok: "Done", partial: "Partly done", error: "Failed" };

/** A vendor is slipping on a task type when it delivers under 90% of what it promises. */
const SLIPPING_BELOW = 0.9;

const vendorName = vendorTitle;

function Vendor({ agentId, state }: { agentId: AgentId; state: MarketState }) {
  return (
    <span className="lg-vendor">
      <i style={{ background: VENDOR[agentId].color }} />
      {vendorName(agentId)}
      {state.agents[agentId] && <small>{state.agents[agentId]!.display_name}</small>}
    </span>
  );
}

export function Ledger({ state }: { state: MarketState }) {
  return (
    <aside className="ledger" aria-label="Cost ledger">
      <header className="lg-header">
        <h1>Ledger</h1>
        <span className={`lg-pill ${state.connected ? "on" : ""}`}>
          <i />
          {state.final ? FINAL_LABEL[state.final.status] : state.jobActive ? "Running" : state.connected ? "Idle" : "Waiting"}
        </span>
      </header>

      {!state.currentJob ? (
        <p className="lg-empty">No job yet. Click the Main Agent on the boat to start one.</p>
      ) : (
        <>
          <Summary state={state} />
          <section>
            <h2>Tasks</h2>
            <ul className="lg-rows">
              {state.taskOrder.map((id) => <TaskRow key={id} task={state.tasks[id]} state={state} />)}
            </ul>
          </section>
        </>
      )}

      <Vendors state={state} />

      {state.final?.deliverable && (
        <details className="lg-card lg-details">
          <summary>Result{state.final.filename && <code>{state.final.filename}</code>}</summary>
          <pre className="lg-deliverable">{state.final.deliverable}</pre>
        </details>
      )}

      {state.currentJob && (
        <details className="lg-card lg-details">
          <summary>Details <small>bids, costs, event log</small></summary>
          <Details state={state} />
        </details>
      )}
    </aside>
  );
}

function Summary({ state }: { state: MarketState }) {
  const cmp = compareToTopModel(state);
  const spent = cmp?.abyss ?? state.stats?.total_cost_usd ?? 0;
  const grade = state.final?.mean_grade ?? null;
  const delta = cmp && describeDelta(cmp.delta);
  const max = cmp ? Math.max(cmp.abyss, cmp.baseline) : 1;
  return (
    <section className="lg-card lg-summary">
      <p className="lg-job">{state.currentJob!.jobText}</p>
      <div className="lg-big">
        <div>
          <small>{state.final ? "Cost" : "Cost so far"}</small>
          <strong>{formatUsd(spent)}</strong>
        </div>
        {grade !== null && (
          <div>
            <small>Grade</small>
            <strong>{grade.toFixed(1)}<em>/10</em></strong>
          </div>
        )}
      </div>
      {cmp && delta && (
        <div className="lg-compare">
          <div>
            <span>Abyss</span>
            <div className="lg-bar"><i className="abyss" style={{ width: `${(cmp.abyss / max) * 100}%` }} /></div>
            <b>{formatUsd(cmp.abyss)}</b>
          </div>
          <div>
            <span>{cmp.topName} alone</span>
            <div className="lg-bar"><i className="top" style={{ width: `${(cmp.baseline / max) * 100}%` }} /></div>
            <b>≈{formatUsd(cmp.baseline)}</b>
          </div>
          <p className={`lg-verdict ${delta.tone}`}>
            <strong>{delta.text}</strong> than giving every task to {cmp.topName}
          </p>
        </div>
      )}
    </section>
  );
}

function TaskRow({ task, state }: { task: TaskView; state: MarketState }) {
  const gradeTone = task.grade === null ? "" : task.grade >= 8 ? "better" : task.grade >= 6 ? "even" : "worse";
  return (
    <li className={`lg-row t-${task.type}`}>
      <div className="lg-row-top">
        <span className={`lg-chip t-${task.type}`}>{TYPE_LABEL[task.type]}</span>
        <strong>{task.title}</strong>
      </div>
      <div className="lg-row-bottom">
        {task.winner ? <Vendor agentId={task.winner} state={state} /> : <span className="muted">{STATUS_LABEL[task.status]}</span>}
        <span className={`lg-grade ${gradeTone}`}>
          {task.grade !== null ? `${task.grade}/10` : task.winner ? STATUS_LABEL[task.status] : ""}
        </span>
        <b>{task.workUsage ? formatUsd(task.workUsage.cost_usd) : ""}</b>
      </div>
    </li>
  );
}

function Vendors({ state }: { state: MarketState }) {
  const ids = [...AGENT_ORDER].reverse().filter((id) => state.agents[id]); // Vendor 1, 2, 3
  if (ids.length === 0) return null;
  return (
    <section>
      <h2>Vendors</h2>
      <ul className="lg-rows">
        {ids.map((agentId) => {
          const agent = state.agents[agentId]!;
          const won = state.stats?.by_agent[agentId]?.tasks_won ?? 0;
          const slipping = (Object.keys(TYPE_LABEL) as TaskType[]).filter((t) => agent.reputation[t] < SLIPPING_BELOW);
          return (
            <li className="lg-row lg-vendor-row" key={agentId}>
              <Vendor agentId={agentId} state={state} />
              <span className="lg-tags">
                {agentId === "opus" && <em className="tag">backup</em>}
                {slipping.length > 0 && (
                  <em className="tag warn" title="Delivers less than it promises here, so its promises count for less">
                    slipping: {slipping.map((t) => TYPE_LABEL[t].toLowerCase()).join(", ")}
                  </em>
                )}
              </span>
              <b>won {won}</b>
            </li>
          );
        })}
      </ul>
      <p className="lg-note">Vendor 1 is the priciest. It only bids when both cheaper vendors are slipping.</p>
    </section>
  );
}

function Details({ state }: { state: MarketState }) {
  const stats = state.stats;
  return (
    <div className="lg-details-body">
      <h3>Bids</h3>
      {state.taskOrder.map((id) => {
        const task = state.tasks[id];
        const bids = AGENT_ORDER.filter((a) => task.bids[a]).map((a) => [a, task.bids[a]!] as const);
        if (bids.length === 0) return null;
        return (
          <table className="lg-table lg-bids" key={id}>
            <caption>{task.title}</caption>
            <tbody>
              {bids.map(([agentId, bid]) => (
                <tr key={agentId} className={task.winner === agentId ? "won" : ""}>
                  <td><Vendor agentId={agentId} state={state} /></td>
                  {bid.ok ? (
                    <>
                      <td>promises {bid.promised_quality}/10</td>
                      <td>{formatUsd(bid.predicted_cost_usd ?? 0)}</td>
                    </>
                  ) : (
                    <td colSpan={2} className="muted">{isStandby(bid) ? "on standby" : "no bid"}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        );
      })}

      {stats && (
        <>
          <h3>Where the money went</h3>
          <table className="lg-table">
            <tbody>
              {PURPOSES.map(({ key, label }) => (
                <tr key={key}>
                  <td><i className={`lg-dot p-${key}`} />{label}</td>
                  <td>{stats.by_purpose[key].calls} calls</td>
                  <td>{formatUsd(stats.by_purpose[key].cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>Event log</h3>
      <ol className="lg-log">
        {state.log.filter((ev) => ev.type !== "stats").map((ev) => (
          <li key={`${ev.seq}-${ev.type}`}>
            <span>{(ev.t / 1000).toFixed(1)}s</span>
            {describeEvent(ev)}
          </li>
        ))}
      </ol>
    </div>
  );
}

function describeEvent(ev: AbyssEvent): string {
  switch (ev.type) {
    case "hello": return "Market opened";
    case "job_split": return `Split the job into ${ev.data.tasks.length} tasks`;
    case "task_posted": return `Posted: ${ev.data.title}`;
    case "bid":
      if (ev.data.ok) return `${vendorName(ev.data.agent_id)} bid ${ev.data.promised_quality}/10 for ${formatUsd(ev.data.predicted_cost_usd ?? 0)}`;
      return isStandby(ev.data) ? `${vendorName(ev.data.agent_id)} on standby` : `${vendorName(ev.data.agent_id)} couldn't bid`;
    case "won": return `${vendorName(ev.data.agent_id)} won ${ev.data.task_id.toUpperCase()}`;
    case "working": return `${vendorName(ev.data.agent_id)} started ${ev.data.task_id.toUpperCase()}`;
    case "done": return `${vendorName(ev.data.agent_id)} finished ${ev.data.task_id.toUpperCase()} for ${formatUsd(ev.data.usage.cost_usd)}`;
    case "graded": return `${ev.data.task_id.toUpperCase()} graded ${ev.data.grade}/10`;
    case "rep_update": return `${vendorName(ev.data.agent_id)} ${ev.data.task_type} trust ${ev.data.old.toFixed(2)} → ${ev.data.new.toFixed(2)}`;
    case "stats": return "Totals updated";
    case "final": return `Job finished: ${formatUsd(ev.data.total_cost_usd)}`;
    case "error": return `Problem: ${ev.data.message}`;
    case "assembled": return `Packaged ${ev.data.filename}`;
    case "steered": return `Steered ${ev.data.target === "job" ? "the job" : vendorName(ev.data.target)}: ${ev.data.note}`;
  }
}
