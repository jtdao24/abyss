// Pure derivation of what the market scene shows for a given MarketState.
// Scene.ts only draws this; nothing here touches Pixi, so it is unit-testable.
import { THEME } from "../theme";
import type { AgentId, TaskType } from "../contract";
import { wasStopped, type AgentStatus, type MarketState, type TaskStatus, type TaskView } from "../state/reducer";

export const AGENT_ORDER: AgentId[] = ["haiku", "sonnet", "opus"];
export const TASK_TYPES: TaskType[] = ["research", "writing", "checking"];
export const MAX_CARDS = 5;

/** Public stall names. The market never shows which model runs a stall;
 *  the real model names only appear in the (hidden) ledger panel. */
export const VENDOR: Record<AgentId, { name: string; tier: string; color: string }> = {
  opus: { name: "VENDOR 1", tier: "PREMIUM", color: THEME.vendorOpus },   // blue stall
  sonnet: { name: "VENDOR 2", tier: "STANDARD", color: THEME.vendorSonnet }, // red stall
  haiku: { name: "VENDOR 3", tier: "BUDGET", color: THEME.vendorHaiku },   // purple stall
};

export type BubbleTone = "thinking" | "bid" | "pass" | "won" | "working" | "done";
export type ReviewTone = "good" | "ok" | "bad";

/** "Vendor 1": a stall's name in a sentence. */
export const vendorTitle = (agentId: AgentId): string => VENDOR[agentId].name.replace("VENDOR", "Vendor");

/** A grade against its promise: met it, missed by one, or missed by more. */
export function verdict(grade: number, promised: number | null): ReviewTone {
  if (promised === null || grade >= promised) return "good";
  return grade < promised - 1 ? "bad" : "ok";
}

/** The AI's name as the page shows it ("meta" runs Muse Spark). */
export function providerLabel(provider: string | null | undefined): string {
  if (provider === "meta") return "Muse";
  if (provider === "openai") return "OpenAI";
  return provider ?? "—";
}

export interface StallModel {
  agentId: AgentId;
  name: string;
  color: string;
  status: AgentStatus;
  bubble: { text: string; tone: BubbleTone } | null;
  winner: boolean;
  reputation: Record<TaskType, number>;
}

export interface CardModel {
  taskId: string;
  type: TaskType;
  label: string;
  status: TaskStatus;
  glyph: string;
  winnerColor: string | null;
  current: boolean;
}

export interface SceneModel {
  stalls: StallModel[];
  cards: CardModel[];
  banner: string;
  spent: string;
  review: { text: string; tone: ReviewTone } | null;
  /** The reviewer is grading the current task right now. */
  reviewing: boolean;
  /** What the main agent (orchestrator) says. */
  mainAgent: string;
  finalBanner: string | null;
}

export function currentTask(state: MarketState): TaskView | null {
  for (let i = state.taskOrder.length - 1; i >= 0; i -= 1) {
    const task = state.tasks[state.taskOrder[i]];
    if (task && task.status !== "pending") return task;
  }
  return null;
}

/** The premium stall sits out a task unless the cheaper stalls have been slipping. */
export function isStandby(bid: { ok: boolean; error: string | null }): boolean {
  return !bid.ok && (bid.error ?? "").startsWith("standby");
}

export function formatCents(usd: number): string {
  const cents = usd * 100;
  return cents < 1 ? `${cents.toFixed(2)}¢` : `${cents.toFixed(1)}¢`;
}

function bubbleFor(agentId: AgentId, task: TaskView | null): StallModel["bubble"] {
  if (!task) return null;
  if (task.status === "open") {
    const bid = task.bids[agentId];
    if (!bid) return { text: "...", tone: "thinking" };
    if (!bid.ok) return { text: isStandby(bid) ? "STANDBY" : "PASS", tone: "pass" };
    return { text: `Q${bid.promised_quality} ${formatCents(bid.predicted_cost_usd ?? 0)}`, tone: "bid" };
  }
  if (task.winner !== agentId) return null;
  if (task.status === "assigned") return { text: "WON!", tone: "won" };
  if (task.status === "working") return { text: "WORKING", tone: "working" };
  // Only while the work is on its way to the reviewer: once graded, the grade pops up and the bubble goes.
  if (task.status === "done") return { text: "DONE", tone: "done" };
  return null;
}

function cardGlyph(task: TaskView): string {
  switch (task.status) {
    case "open": return "!";
    case "assigned":
    case "working": return "~";
    case "done": return "";
    case "graded": return String(task.grade ?? "");
    case "failed": return "X";
    default: return "";
  }
}

export function sceneModel(state: MarketState): SceneModel {
  const task = currentTask(state);
  const stalls: StallModel[] = [];
  for (const agentId of AGENT_ORDER) {
    const agent = state.agents[agentId];
    if (!agent) continue;
    const winner =
      task !== null && task.winner === agentId && task.status !== "open" && task.status !== "failed";
    stalls.push({
      agentId,
      name: VENDOR[agentId].name,
      color: agent.color,
      status: agent.status,
      bubble: bubbleFor(agentId, task),
      winner,
      reputation: agent.reputation,
    });
  }

  const cards = state.taskOrder.slice(0, MAX_CARDS).map((taskId): CardModel => {
    const view = state.tasks[taskId];
    const winner = view.winner ? VENDOR[view.winner] : undefined;
    return {
      taskId,
      type: view.type,
      label: `${taskId.toUpperCase()} ${view.type.toUpperCase()}`,
      status: view.status,
      glyph: cardGlyph(view),
      winnerColor: winner?.color ?? null,
      current: task?.task_id === taskId,
    };
  });

  // The lifeguard shows the latest grade while the job runs; once it's over
  // the final banner has the job's grade, so the bubble goes.
  let review: SceneModel["review"] = null;
  for (let i = state.final ? -1 : state.taskOrder.length - 1; i >= 0; i -= 1) {
    const graded = state.tasks[state.taskOrder[i]];
    if (graded?.grade == null) continue;
    const promised = graded.winner ? graded.bids[graded.winner]?.promised_quality ?? null : null;
    const tone = verdict(graded.grade, promised);
    review = { text: `${graded.task_id.toUpperCase()} ${graded.grade}/10`, tone };
    break;
  }

  const banner = task
    ? `${task.task_id.toUpperCase()} ${task.type.toUpperCase()} - ${task.title}`
    : state.currentJob
      ? "SPLITTING JOB..."
      : "WAITING FOR A JOB";

  const total = state.final?.total_cost_usd ?? state.stats?.total_cost_usd ?? 0;
  const stopped = wasStopped(state, state.currentJob?.jobId);
  const finalBanner = state.final
    ? `JOB ${stopped ? "STOPPED" : state.final.status.toUpperCase()} - GRADE ${state.final.mean_grade ?? "-"} - $${state.final.total_cost_usd.toFixed(4)}`
    : null;

  const tasksFinished =
    state.taskOrder.length > 0 &&
    state.taskOrder.every((id) => ["graded", "failed"].includes(state.tasks[id].status));
  const mainAgent = state.final
    ? state.final.filename ? `SENT ${state.final.filename.toUpperCase()}` : "JOB OVER"
    : state.assembled || tasksFinished
      ? "PACKAGING YOUR FILE..."
      : state.taskOrder.length > 0
      ? `${state.taskOrder.length} TASKS POSTED`
      : state.currentJob || state.jobActive
        ? "SPLITTING JOB..."
        : "CAPTAIN";

  return {
    stalls,
    cards,
    banner,
    spent: `SPENT $${total.toFixed(4)}`,
    review,
    reviewing: task?.status === "done",
    mainAgent,
    finalBanner,
  };
}
