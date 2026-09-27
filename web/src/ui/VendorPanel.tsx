// The panel for a vendor you walked up to: who they are, what they're doing
// right now (live), a note box to steer them, and their track record.
import { useEffect, useState } from "react";

import { api, type VendorStats } from "../api";
import type { AbyssEvent, AgentId, ClientMsg, TaskType } from "../contract";
import { VENDOR, formatCents, isStandby } from "../scene/model";
import type { MarketState, TaskView } from "../state/reducer";

const TYPES: TaskType[] = ["research", "writing", "checking"];
const SPRITE: Record<AgentId, string> = { opus: "vendor1", sonnet: "vendor2", haiku: "vendor3" };
const STEPS = ["Bid", "Won", "Working", "Graded"] as const;
const QUICK_NOTES = ["Be concise", "Cite sources", "Double-check facts", "Simpler words", "More detail"];

type Phase = "idle" | "standby" | "thinking" | "bid" | "lost" | "won" | "working" | "grading" | "graded";

const PHASE_LABEL: Record<Phase, string> = {
  idle: "Waiting for work",
  standby: "On standby",
  thinking: "Pricing the task",
  bid: "Bid placed",
  lost: "Lost the bid",
  won: "Won the task!",
  working: "Working",
  grading: "Being graded",
  graded: "Done",
};

/** The task this vendor is involved in now (the latest one it bid on, won or sat out). */
function currentTask(state: MarketState, agentId: AgentId): TaskView | null {
  for (let i = state.taskOrder.length - 1; i >= 0; i -= 1) {
    const task = state.tasks[state.taskOrder[i]];
    if (task.status === "pending") continue;
    if (task.bids[agentId] || task.winner === agentId || task.status === "open") return task;
  }
  return null;
}

function lastWin(state: MarketState, agentId: AgentId): TaskView | null {
  const won = state.taskOrder.map((id) => state.tasks[id]).filter((t) => t.winner === agentId);
  return won.at(-1) ?? null;
}

function phaseOf(task: TaskView | null, agentId: AgentId): Phase {
  if (!task) return "idle";
  const bid = task.bids[agentId];
  if (task.status === "open") return !bid ? "thinking" : isStandby(bid) ? "standby" : "bid";
  if (bid && isStandby(bid)) return "standby";
  if (task.winner !== agentId) return "lost";
  if (task.status === "assigned") return "won";
  if (task.status === "working") return "working";
  if (task.status === "done") return "grading";
  return "graded";
}

/** How far along the Bid → Won → Working → Graded track this vendor is. */
function stepOf(phase: Phase): number {
  return { idle: -1, standby: -1, thinking: 0, bid: 0, lost: 0, won: 1, working: 2, grading: 3, graded: 4 }[phase];
}

const short = (id: string) => id.toUpperCase();

/** This vendor's moves in the current job, newest first. */
function feed(state: MarketState, agentId: AgentId): { key: string; text: string; tone: string }[] {
  const jobId = state.currentJob?.jobId;
  const items: { key: string; text: string; tone: string }[] = [];
  const mine = (ev: AbyssEvent) => ev.job_id === jobId && "agent_id" in ev.data && ev.data.agent_id === agentId;
  for (const ev of state.log) {
    const key = `${ev.seq}`;
    if (ev.type === "steered" && ev.job_id === jobId && ev.data.target === agentId) {
      items.push({ key, text: `You: "${ev.data.note}"`, tone: "note" });
    }
    if (!mine(ev)) continue;
    if (ev.type === "bid") {
      if (ev.data.ok) items.push({ key, text: `Bid ${ev.data.promised_quality}/10 for ${formatCents(ev.data.predicted_cost_usd ?? 0)} on ${short(ev.data.task_id)}`, tone: "bid" });
      else items.push({ key, text: isStandby(ev.data) ? `Sat out ${short(ev.data.task_id)} (standby)` : `Couldn't bid on ${short(ev.data.task_id)}`, tone: "muted" });
    } else if (ev.type === "won") items.push({ key, text: `Won ${short(ev.data.task_id)}!`, tone: "good" });
    else if (ev.type === "working") items.push({ key, text: `Started ${short(ev.data.task_id)}`, tone: "work" });
    else if (ev.type === "done") items.push({ key, text: `Finished ${short(ev.data.task_id)} · ${formatCents(ev.data.usage.cost_usd)}`, tone: "work" });
    else if (ev.type === "graded") items.push({ key, text: `Graded ${ev.data.grade}/10 on ${short(ev.data.task_id)}`, tone: ev.data.grade >= 8 ? "good" : "warn" });
    else if (ev.type === "rep_update" && Math.abs(ev.data.new - ev.data.old) >= 0.005) {
      const up = ev.data.new > ev.data.old;
      items.push({ key, text: `${ev.data.task_type} trust ${up ? "up" : "down"} to ${ev.data.new.toFixed(2)}`, tone: up ? "good" : "warn" });
    }
  }
  return items.reverse().slice(0, 4);
}

function useVendorStats(agentId: AgentId, live: boolean): VendorStats | null {
  const [stats, setStats] = useState<VendorStats | null>(null);
  useEffect(() => {
    if (!live) return;
    let on = true;
    api.vendors().then((all) => on && setStats(all.vendors[agentId] ?? null)).catch(() => undefined);
    return () => {
      on = false;
    };
  }, [agentId, live]);
  return stats;
}

interface Props {
  agentId: AgentId;
  state: MarketState;
  onClose(): void;
  send?: (message: ClientMsg) => boolean;
}

export function VendorPanel({ agentId, state, onClose, send }: Props) {
  const [tab, setTab] = useState<"now" | "steer" | "record">("now");
  const [ack, setAck] = useState<string | null>(null);
  const vendor = VENDOR[agentId];
  const agent = state.agents[agentId];
  // Once the job is over, show this vendor's own last task rather than the last auction.
  const over = !state.jobActive && state.final !== null;
  const task = over ? lastWin(state, agentId) : currentTask(state, agentId);
  const phase = over && !task ? "idle" : phaseOf(task, agentId);
  const step = stepOf(phase);
  const items = feed(state, agentId);

  // The portrait reacts for a moment (a nod and a bubble) when you poke or steer them.
  useEffect(() => {
    if (!ack) return;
    const t = setTimeout(() => setAck(null), 1400);
    return () => clearTimeout(t);
  }, [ack]);

  return (
    <div className="rpg-dialog side vendor-panel" role="dialog" aria-label={vendor.name} onPointerDown={(e) => e.stopPropagation()}>
      <div className="vp-head">
        <button
          type="button"
          className={`vp-portrait phase-${phase} ${ack ? "nod" : ""}`}
          style={{ ["--vendor" as string]: vendor.color }}
          onClick={() => setAck(phase === "working" ? "Busy busy!" : "Hi there!")}
          aria-label={`${vendor.name}, say hi`}
        >
          <i style={{ backgroundImage: `url(/art/characters/${SPRITE[agentId]}.png)` }} />
          {phase === "standby" && <span className="vp-zzz">z</span>}
          {phase === "working" && <span className="vp-dots"><b /><b /><b /></span>}
          {ack && <span className="vp-say">{ack}</span>}
        </button>
        <div className="vp-id">
          <strong>{vendor.name.replace("VENDOR", "Vendor")}</strong>
          <small>{agent?.display_name ?? ""} · {vendor.tier.toLowerCase()}</small>
          <span className={`vp-status phase-${phase}`}><i />{PHASE_LABEL[phase]}</span>
        </div>
        <button type="button" className="vp-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      {step >= 0 && (
        <ol className={`vp-steps ${phase === "lost" ? "lost" : ""}`} aria-label="Progress">
          {STEPS.map((label, i) => (
            <li key={label} className={i < step ? "done" : i === step ? "now" : ""}>
              <i />
              <span>{label}</span>
            </li>
          ))}
        </ol>
      )}

      <nav className="vp-tabs" role="tablist">
        {(["now", "steer", "record"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "now" ? "Now" : t === "steer" ? "Steer" : "Record"}
          </button>
        ))}
      </nav>

      <div className="vp-body" key={tab}>
        {tab === "now" && <NowTab task={task} agentId={agentId} phase={phase} items={items} state={state} />}
        {tab === "steer" && <SteerTab state={state} agentId={agentId} send={send} onSent={() => setAck("Got it!")} />}
        {tab === "record" && <RecordTab state={state} agentId={agentId} live={Boolean(send)} />}
      </div>
    </div>
  );
}

function NowTab({ task, agentId, phase, items, state }: { task: TaskView | null; agentId: AgentId; phase: Phase; items: ReturnType<typeof feed>; state: MarketState }) {
  const [showOutput, setShowOutput] = useState(false);
  const bid = task?.bids[agentId];
  const mine = task?.winner === agentId;
  return (
    <>
      {task ? (
        <div className="vp-task">
          <div className="vp-task-top">
            <span className={`type-chip ${task.type}`}>{task.type}</span>
            <strong>{task.title}</strong>
            {mine && task.grade !== null && <em className={`vp-grade ${task.grade >= 8 ? "good" : task.grade >= 6 ? "ok" : "bad"}`} title={task.rationale ?? ""}>{task.grade}/10</em>}
          </div>
          {bid?.ok && <p className="vp-pitch">"{bid.pitch}" · promised {bid.promised_quality}/10</p>}
          {phase === "lost" && task.winner && <p className="vp-pitch">{VENDOR[task.winner].name.replace("VENDOR", "Vendor")} won this one.</p>}
          {phase === "working" && <div className="working-bar"><i /></div>}
          {mine && task.output && (
            <>
              <button type="button" className="vp-link" onClick={() => setShowOutput((v) => !v)}>
                {showOutput ? "Hide output" : "Show output"}
              </button>
              {showOutput && <p className="vp-output">{task.output}</p>}
            </>
          )}
        </div>
      ) : (
        <p className="vp-empty">
          {state.jobActive ? "Waiting for the next task." : state.final ? "Didn't win a task this job." : "No job yet. Start one with the Captain."}
        </p>
      )}
      {items.length > 0 && (
        <ul className="vp-feed" aria-label="Latest moves" aria-live="polite">
          {items.map((it) => (
            <li key={it.key} className={it.tone}>{it.text}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function SteerTab({ state, agentId, send, onSent }: { state: MarketState; agentId: AgentId; send?: Props["send"]; onSent(): void }) {
  const [note, setNote] = useState("");
  const jobId = state.currentJob?.jobId;
  const notes = state.steering.filter((n) => n.jobId === jobId && n.target === agentId);
  const canSteer = Boolean(send) && state.jobActive;
  const submit = (text: string) => {
    const clean = text.trim();
    if (!clean || !send || !canSteer) return;
    if (send({ type: "steer", target: agentId, note: clean })) {
      setNote("");
      onSent();
    }
  };
  return (
    <div className="vp-steer">
      {!canSteer && <p className="vp-empty">{send ? "Steering opens while a session runs." : "Steering works in a live session, not a replay."}</p>}
      <div className="vp-chips">
        {QUICK_NOTES.map((q) => (
          <button key={q} type="button" disabled={!canSteer} onClick={() => submit(q)}>{q}</button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(note);
        }}
      >
        <input value={note} maxLength={500} disabled={!canSteer} placeholder="Or type your own note…" onChange={(e) => setNote(e.target.value)} />
        <button type="submit" disabled={!canSteer || !note.trim()}>Send</button>
      </form>
      {notes.length > 0 && (
        <ul className="vp-notes">
          {notes.map((n, i) => <li key={i}>{n.note}</li>)}
        </ul>
      )}
    </div>
  );
}

function RecordTab({ state, agentId, live }: { state: MarketState; agentId: AgentId; live: boolean }) {
  const agent = state.agents[agentId];
  const job = state.stats?.by_agent[agentId];
  const stats = useVendorStats(agentId, live);
  return (
    <div className="vp-record">
      <dl className="vp-mini">
        <div><dt>This job</dt><dd>won {job?.tasks_won ?? 0}</dd></div>
        <div><dt>Spent</dt><dd>{formatCents(job?.cost_usd ?? 0)}</dd></div>
        {stats?.win_rate != null && <div><dt>Win rate</dt><dd>{Math.round(stats.win_rate * 100)}%</dd></div>}
        {stats?.avg_grade != null && <div><dt>Avg grade</dt><dd>{stats.avg_grade.toFixed(1)}</dd></div>}
      </dl>
      <ul className="vp-trust" aria-label="Trust by task type">
        {TYPES.map((type) => {
          const rep = agent?.reputation[type] ?? 1;
          return (
            <li key={type}>
              <span>{type}</span>
              {/* 0 to 1.5, with a mark at 1.00 (keeps its promises) */}
              <div><b className={rep < 0.9 ? "low" : rep < 1 ? "mid" : "high"} style={{ width: `${Math.min(100, (rep / 1.5) * 100)}%` }} /><i /></div>
              <em>{rep.toFixed(2)}</em>
            </li>
          );
        })}
      </ul>
      <p className="vp-hint">Trust 1.00 = delivers what it promises.</p>
    </div>
  );
}
