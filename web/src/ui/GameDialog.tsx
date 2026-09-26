// RPG-style dialog for whatever the player walked up to and clicked.
import { useEffect, useState, type ReactNode } from "react";

import type { AgentId, TaskType } from "../contract";
import { VENDOR, formatCents } from "../scene/model";
import type { InteractId } from "../scene/world";
import type { MarketState, TaskView } from "../state/reducer";
import { ResultView } from "./Deliverable";

const DEFAULT_JOB =
  "Write a short explainer (under 150 words) on why most coasts get two high tides a day, and fact-check it.";
const TYPES: TaskType[] = ["research", "writing", "checking"];

interface GameDialogProps {
  id: InteractId;
  state: MarketState;
  live: boolean;
  pending: boolean;
  onClose(): void;
  onPostJob(job: string, priceWeight: number): void;
  onReset(): void;
  onCollect(): void;
}

function Shell({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose(): void; children: ReactNode }) {
  return (
    <div className="rpg-dialog" role="dialog" aria-label={title} onPointerDown={(e) => e.stopPropagation()}>
      <header>
        <div>
          <strong>{title}</strong>
          {subtitle && <small>{subtitle}</small>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </header>
      <div className="rpg-body">{children}</div>
    </div>
  );
}

function vendorName(agentId: AgentId | null): string {
  return agentId ? VENDOR[agentId].name : "—";
}

function TaskRow({ task }: { task: TaskView }) {
  return (
    <li className={`task-line status-${task.status}`}>
      <span className={`type-chip ${task.type}`}>{task.type}</span>
      <strong>{task.task_id.toUpperCase()} · {task.title}</strong>
      <em>{task.status}{task.winner ? ` · ${vendorName(task.winner)}` : ""}{task.grade !== null ? ` · ${task.grade}/10` : ""}</em>
    </li>
  );
}

function MainAgentDialog(props: GameDialogProps) {
  const { state, live, pending, onClose, onPostJob, onReset, onCollect } = props;
  const [job, setJob] = useState(DEFAULT_JOB);
  const [priceWeight, setPriceWeight] = useState(state.config?.price_weight ?? 1);
  // Talking to the main agent while a result waits hands it over. Remember
  // that it was waiting when this dialog opened, so collecting doesn't flip
  // the view straight to the job form.
  const [handingOver] = useState(state.final !== null && !state.resultCollected);
  useEffect(() => {
    if (handingOver) onCollect();
  }, [handingOver, onCollect]);

  if (handingOver && state.final) {
    return (
      <Shell title="Main Agent" subtitle="Your job is done! Here's what the market delivered." onClose={onClose}>
        <ResultView final={state.final} agents={state.agents} />
        {live && <p className="rpg-hint">Talk to me again to post another job.</p>}
      </Shell>
    );
  }

  if (state.jobActive || pending) {
    return (
      <Shell title="Main Agent" subtitle={pending && !state.jobActive ? "Splitting your job into tasks..." : "On it! The market is working."} onClose={onClose}>
        {state.currentJob && <p className="job-quote">"{state.currentJob.jobText}"</p>}
        <ul className="task-lines">
          {state.taskOrder.map((id) => <TaskRow key={id} task={state.tasks[id]} />)}
        </ul>
        <p className="rpg-hint">The vendors come to my boat for each task. I'll have your result here once every task is graded.</p>
      </Shell>
    );
  }

  if (!live) {
    return (
      <Shell title="Main Agent" subtitle="This is a replay of a recorded job." onClose={onClose}>
        <p>Open <code>?source=ws</code> with the backend running to post your own jobs.</p>
        {state.final && <ResultView final={state.final} agents={state.agents} />}
        <PastJobs state={state} />
      </Shell>
    );
  }

  const trimmed = job.trim();
  return (
    <Shell title="Main Agent" subtitle="What job do you need done? I'll split it into tasks and the vendors will bid for them." onClose={onClose}>
      <form
        className="job-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed && state.connected) onPostJob(trimmed, priceWeight);
        }}
      >
        <textarea value={job} onChange={(e) => setJob(e.target.value)} rows={3} maxLength={2000} aria-label="Job" autoFocus />
        <label className="price-weight">
          <span>How much should price matter? {priceWeight.toFixed(2)}</span>
          <input type="range" min={0} max={5} step={0.25} value={priceWeight} onChange={(e) => setPriceWeight(Number(e.target.value))} />
        </label>
        <div className="job-actions">
          <button type="submit" disabled={!trimmed || !state.connected}>Post job</button>
          <button type="button" className="secondary" disabled={!state.connected} onClick={onReset}>Reset reputations</button>
        </div>
      </form>
      <PastJobs state={state} />
    </Shell>
  );
}

function TasksDialog({ state, onClose }: GameDialogProps) {
  const open = state.taskOrder.map((id) => state.tasks[id]);
  return (
    <Shell title="Tasks" subtitle={open.length ? `${open.length} tasks for the current job` : "No tasks yet. Give the Main Agent (on the boat) a job."} onClose={onClose}>
      <ul className="board-list">
        {open.map((task) => (
          <li key={task.task_id}>
            <div className="board-head">
              <span className={`type-chip ${task.type}`}>{task.type}</span>
              <strong>{task.task_id.toUpperCase()} · {task.title}</strong>
              <em>{task.status}</em>
            </div>
            <p>{task.brief}</p>
            <div className="bid-row">
              {(Object.entries(task.bids) as [AgentId, NonNullable<TaskView["bids"][AgentId]>][]).map(([agentId, bid]) => (
                <span key={agentId} className={task.winner === agentId ? "won" : ""}>
                  {vendorName(agentId)}: {bid.ok ? `Q${bid.promised_quality} · ${formatCents(bid.predicted_cost_usd ?? 0)}` : "passed"}
                </span>
              ))}
            </div>
            {task.grade !== null && <p className="grade">Graded {task.grade}/10 — {task.rationale}</p>}
          </li>
        ))}
      </ul>
    </Shell>
  );
}

function VendorDialog({ state, onClose, agentId }: GameDialogProps & { agentId: AgentId }) {
  const agent = state.agents[agentId];
  const vendor = VENDOR[agentId];
  const stats = state.stats?.by_agent[agentId];
  const openTask = state.taskOrder.map((id) => state.tasks[id]).find((t) => t.status === "open");
  const bid = openTask?.bids[agentId];
  return (
    <Shell title={vendor.name} subtitle={`${vendor.tier} vendor`} onClose={onClose}>
      <h3>Reputation</h3>
      <p className="rpg-hint">1.00 means this vendor delivers exactly what it promises. Below 1 it overpromises.</p>
      <ul className="rep-lines">
        {TYPES.map((type) => {
          const rep = agent?.reputation[type] ?? 1;
          return (
            <li key={type}>
              <span className={`type-chip ${type}`}>{type}</span>
              <i><b style={{ width: `${Math.min(100, rep * 50)}%`, background: vendor.color }} /></i>
              <strong>{rep.toFixed(3)}</strong>
            </li>
          );
        })}
      </ul>
      <h3>This job</h3>
      <p>
        Tasks won: {stats?.tasks_won ?? 0} · Spent ${(stats?.cost_usd ?? 0).toFixed(5)} on {stats?.calls ?? 0} calls
      </p>
      {openTask && (
        <p>
          Bidding on {openTask.task_id.toUpperCase()}:{" "}
          {bid ? (bid.ok ? `promises ${bid.promised_quality}/10 for ${formatCents(bid.predicted_cost_usd ?? 0)} — "${bid.pitch}"` : "passed") : "thinking..."}
        </p>
      )}
    </Shell>
  );
}

function ReviewerDialog({ state, onClose }: GameDialogProps) {
  const graded = state.taskOrder.map((id) => state.tasks[id]).filter((t) => t.grade !== null);
  return (
    <Shell title="Reviewer" subtitle="I grade blind: I never know which vendor did the work." onClose={onClose}>
      {graded.length === 0 && <p>Nothing to review yet.</p>}
      <ul className="board-list">
        {graded.map((task) => {
          const promised = task.winner ? task.bids[task.winner]?.promised_quality ?? null : null;
          return (
            <li key={task.task_id}>
              <div className="board-head">
                <strong>{task.task_id.toUpperCase()} · {vendorName(task.winner)}</strong>
                <em>{task.grade}/10{promised !== null ? ` (promised ${promised})` : ""}</em>
              </div>
              <p>{task.rationale}</p>
            </li>
          );
        })}
      </ul>
    </Shell>
  );
}

/** Finished jobs this session, newest first; click one to see its result. */
function PastJobs({ state }: { state: MarketState }) {
  const [open, setOpen] = useState<string | null>(null);
  const jobs = [...state.history].reverse();
  if (jobs.length === 0) return null;
  return (
    <section className="past-jobs">
      <h3>Past jobs</h3>
      <ul className="board-list">
        {jobs.map((entry) => (
          <li key={entry.jobId}>
            <button type="button" className="archive-row" onClick={() => setOpen(open === entry.jobId ? null : entry.jobId)}>
              <strong>{entry.jobText || entry.jobId}</strong>
              <em>grade {entry.final.mean_grade ?? "—"} · ${entry.final.total_cost_usd.toFixed(4)}</em>
            </button>
            {open === entry.jobId && <ResultView final={entry.final} agents={state.agents} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function GameDialog(props: GameDialogProps) {
  const { id } = props;
  if (id === "main") return <MainAgentDialog {...props} />;
  if (id === "tasks") return <TasksDialog {...props} />;
  if (id === "reviewer") return <ReviewerDialog {...props} />;
  return <VendorDialog {...props} agentId={id.slice("vendor:".length) as AgentId} />;
}
