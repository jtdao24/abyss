// Panels for whoever the player walked up to. The Captain runs sessions
// (start a job, pick the AI, cap the spend, reopen past ones); the vendors can
// be steered. The terminal chat (python -m abyss.chat) still works alongside.
import { useEffect, useRef, useState, type ReactNode } from "react";

import { api, type Estimate, type Provider, type SessionRecord, type SessionSummary } from "../api";
import type { AgentId, ClientMsg, TaskType } from "../contract";
import { VENDOR, formatCents } from "../scene/model";
import type { InteractId } from "../scene/world";
import type { MarketState, TaskView } from "../state/reducer";
import { ResultView } from "./Deliverable";

const TYPES: TaskType[] = ["research", "writing", "checking"];

interface GameDialogProps {
  id: InteractId;
  state: MarketState;
  onClose(): void;
  /** Sends to the market; absent when replaying a recording. */
  send?: (message: ClientMsg) => boolean;
  /** AIs this machine has keys for, the default first. */
  providers?: Provider[];
  /** Saved sessions, newest first (they survive reloads). */
  sessions?: SessionSummary[];
}

const money = (usd: number) => `$${usd.toFixed(usd < 0.1 ? 4 : 2)}`;

/** The market's latest refusal of something this page sent (a non-fatal error). */
function useLastRefusal(state: MarketState): string | null {
  const last = [...state.log].reverse().find((e) => e.type === "error" && e.job_id === null);
  return last && last.type === "error" && !last.data.fatal ? last.data.message : null;
}

/** A note to one vendor, or to every remaining step of the session. */
function SteerBox({ state, send, target, label }: { state: MarketState; send?: GameDialogProps["send"]; target: "job" | AgentId; label: string }) {
  const [note, setNote] = useState("");
  if (!send) return null;
  const running = state.jobActive;
  return (
    <form
      className="steer-box"
      onSubmit={(e) => {
        e.preventDefault();
        if (note.trim() && send({ type: "steer", target, note: note.trim() })) setNote("");
      }}
    >
      <h3>{label}</h3>
      <textarea
        value={note}
        maxLength={500}
        rows={2}
        disabled={!running}
        placeholder={running ? "e.g. keep it under 150 words, cite sources" : "Steering opens while a session runs"}
        onChange={(e) => setNote(e.target.value)}
      />
      <button type="submit" disabled={!running || !note.trim()}>Send note</button>
    </form>
  );
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

function NewSession({ state, send, providers }: Pick<GameDialogProps, "state" | "send" | "providers">) {
  const [job, setJob] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [budget, setBudget] = useState("");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const refusal = useLastRefusal(state);
  const choices = providers ?? [];
  const provider = picked ?? choices[0]?.id ?? null;

  // What a typical session costs on the chosen AI (no AI calls).
  useEffect(() => {
    let live = true;
    api.estimate(provider).then((e) => live && setEstimate(e)).catch(() => live && setEstimate(null));
    return () => {
      live = false;
    };
  }, [provider]);

  if (!send) return <p className="rpg-hint">This is a replay, so new sessions can't start here.</p>;
  if (state.jobActive) return <p className="rpg-hint">The crew is on the current session. Start a new one when it finishes.</p>;
  const budgetUsd = budget.trim() ? Number(budget) : null;
  const budgetOk = budgetUsd === null || (Number.isFinite(budgetUsd) && budgetUsd > 0 && budgetUsd <= 100);
  const start = () => {
    const text = job.trim();
    if (!text || !state.connected || !budgetOk) return;
    const message: ClientMsg = {
      type: "start_job",
      job: text,
      ...(provider && choices.length > 1 ? { provider } : {}),
      ...(budgetUsd !== null ? { budget_usd: budgetUsd } : {}),
    };
    if (send(message)) setJob("");
  };
  const overBudget = estimate && budgetUsd !== null && budgetUsd < estimate.low_usd;
  return (
    <form
      className="session-form"
      onSubmit={(e) => {
        e.preventDefault();
        start();
      }}
    >
      <label htmlFor="session-job">What do you need?</label>
      <textarea
        id="session-job"
        value={job}
        maxLength={2000}
        rows={3}
        placeholder="e.g. Research the best beach cafes in Miami and write a 150-word guide"
        onChange={(e) => setJob(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            start();
          }
        }}
      />
      {choices.length > 1 && (
        <div className="segmented" role="radiogroup" aria-label="AI for this session">
          {choices.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={provider === p.id} className={provider === p.id ? "on" : ""} onClick={() => setPicked(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="budget-row">
        <label htmlFor="session-budget">Budget cap</label>
        <span className="money-input">
          $<input
            id="session-budget"
            inputMode="decimal"
            value={budget}
            placeholder="none"
            onChange={(e) => setBudget(e.target.value.replace(/[^0-9.]/g, ""))}
          />
        </span>
        {estimate && (
          <span className="estimate" title={`About ${estimate.calls} AI calls for ${estimate.tasks} tasks${estimate.test_mode ? ", test mode" : ""}`}>
            Estimated {estimate.high_usd - estimate.low_usd < 0.00005 ? `≈ ${money(estimate.low_usd)}` : `${money(estimate.low_usd)}–${money(estimate.high_usd)}`}
          </span>
        )}
      </div>
      {!budgetOk && <p className="form-error">A budget is between $0.0001 and $100.</p>}
      {overBudget && <p className="rpg-hint">That cap is below the usual cost, so the crew may stop after the first task.</p>}
      {budgetUsd !== null && budgetOk && (
        <p className="rpg-hint">Once the cap is reached no new task starts; the task in progress and the final packaging still finish.</p>
      )}
      <button type="submit" className="btn-primary" disabled={!job.trim() || !state.connected || !budgetOk}>
        {state.connected ? "Start session" : "Connecting…"}
      </button>
      {refusal && <p className="form-error" role="alert">{refusal}</p>}
    </form>
  );
}

function PastSession({ id }: { id: string }) {
  const [record, setRecord] = useState<SessionRecord | null | "error">(null);
  useEffect(() => {
    api.session(id).then(setRecord).catch(() => setRecord("error"));
  }, [id]);
  if (record === null) return <p className="rpg-hint">Loading…</p>;
  if (record === "error") return <p className="rpg-hint">Couldn't load this session.</p>;
  return (
    <>
      <p className="job-quote">"{record.job_text}"</p>
      {record.final ? <ResultView final={record.final} /> : <p className="rpg-hint">This session ended without a result ({record.status}).</p>}
    </>
  );
}

function MainAgentDialog({ state, onClose, send, providers, sessions }: GameDialogProps) {
  const current = state.currentJob;
  const [pick, setPick] = useState<string>(current ? current.jobId : "new");
  // A session that just started (from here or the terminal) opens on its own.
  const lastJob = useRef(current?.jobId ?? null);
  useEffect(() => {
    const id = current?.jobId ?? null;
    if (id && id !== lastJob.current) setPick(id);
    lastJob.current = id;
  }, [current?.jobId]);

  const past = (sessions ?? []).filter((s) => s.id !== current?.jobId);
  const view = pick === "new" || pick === current?.jobId || past.some((s) => s.id === pick) ? pick : "new";
  const subtitle =
    view === "new"
      ? "Ahoy! Got a job for the crew? The vendors bid for every task."
      : view === current?.jobId
        ? state.final
          ? state.final.filename ? `Done: ${state.final.filename}` : "The session ended without a file."
          : state.assembled
            ? `Packaging everything into ${state.assembled.filename}…`
            : "Aye aye! The crew is on it."
        : "A past session.";
  const clip = (text: string) => (text.length > 44 ? `${text.slice(0, 42)}…` : text);

  return (
    <Shell title="Captain · Sessions" subtitle={subtitle} onClose={onClose}>
      <nav className="session-list" aria-label="Sessions">
        <button type="button" className={view === "new" ? "on new" : "new"} onClick={() => setPick("new")}>+ New session</button>
        {current && (
          <button type="button" className={view === current.jobId ? "on" : ""} onClick={() => setPick(current.jobId)}>
            <i className={`session-dot ${state.jobActive ? "live" : "done"}`} />
            <span>{clip(current.jobText || "Current session")}</span>
          </button>
        )}
        {past.map((s) => (
          <button key={s.id} type="button" className={view === s.id ? "on" : ""} onClick={() => setPick(s.id)}>
            <i className={`session-dot ${s.status === "ok" ? "done" : "failed"}`} />
            <span>{clip(s.job_text || s.filename || s.id)}</span>
            <em>{money(s.cost_usd)}{s.mean_grade != null ? ` · ${s.mean_grade}/10` : ""}</em>
          </button>
        ))}
      </nav>

      {view === "new" && <NewSession state={state} send={send} providers={providers} />}
      {current && view === current.jobId && (
        <>
          <p className="job-quote">"{current.jobText}"</p>
          <ul className="task-lines">{state.taskOrder.map((id) => <TaskRow key={id} task={state.tasks[id]} />)}</ul>
          <Notes state={state} target="job" label="Your notes for the crew" />
          {state.jobActive && <SteerBox state={state} send={send} target="job" label="Steer the whole session" />}
          {state.final && <ResultView final={state.final} />}
        </>
      )}
      {view !== "new" && view !== current?.jobId && <PastSession key={view} id={view} />}
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

function VendorDialog({ state, onClose, agentId, send }: GameDialogProps & { agentId: AgentId }) {
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
      <SteerBox state={state} send={send} target={agentId} label={`Steer vendor ${number}`} />
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
    <Shell side={false} title="Tasks" subtitle={open.length ? `${open.length} tasks for the current job` : "No tasks yet. Click the Captain on the boat to start a session."} onClose={onClose}>
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
    <Shell title="Lifeguard" subtitle="I keep watch and grade blind: I never know which vendor did the work." onClose={onClose}>
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
