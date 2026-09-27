// Panels for whoever the player walked up to. The Captain is a terminal (type a
// job or a /command); the vendors show live progress and can be steered. The
// terminal chat (python -m abyss.chat) still works alongside.
import type { ReactNode } from "react";

import type { Provider, SessionSummary } from "../api";
import type { AgentId, ClientMsg } from "../contract";
import { VENDOR, formatCents } from "../scene/model";
import type { InteractId } from "../scene/world";
import type { MarketState, TaskView } from "../state/reducer";
import { CaptainTerminal } from "./CaptainTerminal";
import { VendorPanel } from "./VendorPanel";

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
  if (id === "main") return <CaptainTerminal state={props.state} onClose={props.onClose} send={props.send} providers={props.providers} sessions={props.sessions} />;
  if (id === "tasks") return <TasksDialog {...props} />;
  if (id === "reviewer") return <ReviewerDialog {...props} />;
  return <VendorPanel agentId={id.slice("vendor:".length) as AgentId} state={props.state} onClose={props.onClose} send={props.send} />;
}
