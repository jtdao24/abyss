// Read-only panels for whoever the player walked up to. Jobs and steering
// happen in the terminal chat (python -m abyss.chat); this view only watches.
import { useState, type ReactNode } from "react";

import type { AgentId, TaskType } from "../contract";
import { VENDOR, formatCents } from "../scene/model";
import type { InteractId } from "../scene/world";
import type { MarketState, TaskView } from "../state/reducer";
import { ResultView } from "./Deliverable";

const TYPES: TaskType[] = ["research", "writing", "checking"];
const CHAT_COMMAND = "python -m abyss.chat";

interface GameDialogProps {
  id: InteractId;
  state: MarketState;
  onClose(): void;
}

function Shell({ title, subtitle, onClose, children, side = true }: { title: string; subtitle?: string; onClose(): void; children: ReactNode; side?: boolean }) {
  return (
    <div className={`rpg-dialog ${side ? "side" : ""}`} role="dialog" aria-label={title} onPointerDown={(e) => e.stopPropagation()}>
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

/** Notes steering the current job (the latest job's, while a new one is splitting). */
function currentNotes(state: MarketState, target: "job" | AgentId) {
  const jobId = state.currentJob?.jobId ?? state.steering.at(-1)?.jobId;
  return state.steering.filter((n) => n.jobId === jobId && n.target === target);
}

function Notes({ state, target, label }: { state: MarketState; target: "job" | AgentId; label: string }) {
  const notes = currentNotes(state, target);
  if (notes.length === 0) return null;
  return (
    <section className="steer-box">
      <h3>{label}</h3>
      <ul className="steer-notes">{notes.map((n, i) => <li key={i}>"{n.note}"</li>)}</ul>
    </section>
  );
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

/** Finished jobs this session, newest first; click one to see its file. */
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
              <strong>{entry.final.filename ?? entry.jobText ?? entry.jobId}</strong>
              <em>grade {entry.final.mean_grade ?? "—"} · ${entry.final.total_cost_usd.toFixed(4)}</em>
            </button>
            {open === entry.jobId && <ResultView final={entry.final} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function MainAgentDialog({ state, onClose }: GameDialogProps) {
  if (!state.currentJob && !state.jobActive) {
    return (
      <Shell title="Main Agent" subtitle="Give me jobs from the terminal chat." onClose={onClose}>
        <p>Open a terminal and run <code>{CHAT_COMMAND}</code>, then type what you need. I'll split it into tasks, the vendors will bid for them, and the finished file lands in your Downloads folder.</p>
        <PastJobs state={state} />
      </Shell>
    );
  }
  const job = state.currentJob;
  const subtitle = state.final
    ? state.final.filename ? `Done — sent ${state.final.filename} to your Downloads folder.` : "The job ended without a file."
    : state.assembled
      ? `Packaging everything into ${state.assembled.filename}...`
      : "On it! The market is working.";
  return (
    <Shell title="Main Agent" subtitle={subtitle} onClose={onClose}>
      {job && <p className="job-quote">"{job.jobText}"</p>}
      <ul className="task-lines">
        {state.taskOrder.map((id) => <TaskRow key={id} task={state.tasks[id]} />)}
      </ul>
      <Notes state={state} target="job" label="Your notes for everyone" />
      {state.final && <ResultView final={state.final} />}
      {!state.final && <p className="rpg-hint">The vendors come to my boat for each task. Steer them from the terminal with <code>/steer</code>.</p>}
      <PastJobs state={state} />
    </Shell>
  );
}

function vendorActivity(state: MarketState, agentId: AgentId): { line: string; task: TaskView | null } {
  const tasks = state.taskOrder.map((id) => state.tasks[id]);
  const working = tasks.find((t) => t.winner === agentId && (t.status === "working" || t.status === "assigned"));
  if (working) return { line: `Working on ${working.task_id.toUpperCase()} (${working.type})...`, task: working };
  const open = tasks.find((t) => t.status === "open");
  if (open) {
    const bid = open.bids[agentId];
    return { line: bid ? `Bid on ${open.task_id.toUpperCase()}, waiting for the result` : `At the boat, sizing up ${open.task_id.toUpperCase()}`, task: open };
  }
  const reviewed = [...tasks].reverse().find((t) => t.winner === agentId && (t.status === "done" || t.status === "graded"));
  if (reviewed) return { line: reviewed.status === "done" ? `Handed ${reviewed.task_id.toUpperCase()} to the reviewer` : `Finished ${reviewed.task_id.toUpperCase()}`, task: reviewed };
  return { line: state.jobActive ? "Waiting for the next task" : "Waiting for a job", task: null };
}

function VendorDialog({ state, onClose, agentId }: GameDialogProps & { agentId: AgentId }) {
  const agent = state.agents[agentId];
  const vendor = VENDOR[agentId];
  const stats = state.stats?.by_agent[agentId];
  const { line, task } = vendorActivity(state, agentId);
  const bid = task?.bids[agentId];
  const mine = state.taskOrder.map((id) => state.tasks[id]).filter((t) => t.winner === agentId);
  const number = vendor.name.split(" ")[1];
  return (
    <Shell title={`${vendor.name} · ${vendor.tier}`} subtitle={line} onClose={onClose}>
      {task && (
        <section className="now-card">
          <div className="board-head">
            <span className={`type-chip ${task.type}`}>{task.type}</span>
            <strong>{task.task_id.toUpperCase()} · {task.title}</strong>
            <em>{task.status}</em>
          </div>
          <p>{task.brief}</p>
          {bid && <p className="rpg-hint">{bid.ok ? `Bid: promises ${bid.promised_quality}/10 for ${formatCents(bid.predicted_cost_usd ?? 0)} — "${bid.pitch}"` : "Passed on this task."}</p>}
          {task.winner === agentId && task.status === "working" && <div className="working-bar"><i /></div>}
          {task.winner === agentId && task.output && (
            <details open={task.status !== "working"}>
              <summary>Output</summary>
              <p className="output-text">{task.output}</p>
            </details>
          )}
          {task.winner === agentId && task.grade !== null && <p className="grade">Graded {task.grade}/10 — {task.rationale}</p>}
        </section>
      )}
      <Notes state={state} target={agentId} label="Your notes for this vendor" />
      <p className="rpg-hint">Steer it from the terminal: <code>/steer {number} &lt;note&gt;</code></p>
      {mine.length > 0 && (
        <>
          <h3>This job</h3>
          <ul className="task-lines">{mine.map((t) => <TaskRow key={t.task_id} task={t} />)}</ul>
        </>
      )}
      <p className="rpg-hint">Spent ${(stats?.cost_usd ?? 0).toFixed(5)} on {stats?.calls ?? 0} calls this job.</p>
      <h3>Reputation</h3>
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
      <p className="rpg-hint">1.00 = delivers what it promises. Below 1 it overpromises.</p>
    </Shell>
  );
}

function TasksDialog({ state, onClose }: GameDialogProps) {
  const open = state.taskOrder.map((id) => state.tasks[id]);
  return (
    <Shell side={false} title="Tasks" subtitle={open.length ? `${open.length} tasks for the current job` : `No tasks yet. Give the Main Agent a job from the terminal (${CHAT_COMMAND}).`} onClose={onClose}>
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

export function GameDialog(props: GameDialogProps) {
  const { id } = props;
  if (id === "main") return <MainAgentDialog {...props} />;
  if (id === "tasks") return <TasksDialog {...props} />;
  if (id === "reviewer") return <ReviewerDialog {...props} />;
  return <VendorDialog {...props} agentId={id.slice("vendor:".length) as AgentId} />;
}
