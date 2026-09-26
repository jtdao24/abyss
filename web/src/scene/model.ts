// Pure derivation of what the market scene shows for a given MarketState.
// Scene.ts only draws this; nothing here touches Pixi, so it is unit-testable.
import type { AgentId, TaskType } from "../contract";
import type { AgentStatus, MarketState, TaskStatus, TaskView } from "../state/reducer";

export const AGENT_ORDER: AgentId[] = ["haiku", "sonnet", "opus"];
export const TASK_TYPES: TaskType[] = ["research", "writing", "checking"];
export const MAX_CARDS = 5;

/** Public stall names. The market never shows which model runs a stall;
 *  the real model names only appear in the (hidden) ledger panel. */
export const VENDOR: Record<AgentId, { name: string; tier: string; color: string }> = {
  opus: { name: "VENDOR 1", tier: "PREMIUM", color: "#2f6fd6" },   // blue stall
  sonnet: { name: "VENDOR 2", tier: "PREMIUM", color: "#d64545" }, // red stall
  haiku: { name: "VENDOR 3", tier: "BUDGET", color: "#8a4fd0" },   // purple stall
};

export type BubbleTone = "thinking" | "bid" | "pass" | "won" | "working" | "done";
export type ReviewTone = "good" | "ok" | "bad";

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

export function formatCents(usd: number): string {
  const cents = usd * 100;
  return cents < 1 ? `${cents.toFixed(2)}¢` : `${cents.toFixed(1)}¢`;
}

function bubbleFor(agentId: AgentId, task: TaskView | null): StallModel["bubble"] {
  if (!task) return null;
  if (task.status === "open") {
    const bid = task.bids[agentId];
    if (!bid) return { text: "...", tone: "thinking" };
    if (!bid.ok) return { text: "PASS", tone: "pass" };
    return { text: `Q${bid.promised_quality} ${formatCents(bid.predicted_cost_usd ?? 0)}`, tone: "bid" };
  }
  if (task.winner !== agentId) return null;
  if (task.status === "assigned") return { text: "WON!", tone: "won" };
  if (task.status === "working") return { text: "WORKING", tone: "working" };
  if (task.status === "done" || task.status === "graded") return { text: "DONE", tone: "done" };
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

  let review: SceneModel["review"] = null;
  for (let i = state.taskOrder.length - 1; i >= 0; i -= 1) {
    const graded = state.tasks[state.taskOrder[i]];
    if (graded?.grade == null) continue;
    const promised = graded.winner ? graded.bids[graded.winner]?.promised_quality ?? null : null;
    const tone: ReviewTone =
      promised === null || graded.grade >= promised ? "good" : graded.grade < promised - 1 ? "bad" : "ok";
    review = { text: `${graded.task_id.toUpperCase()} ${graded.grade}/10`, tone };
    break;
  }

  const banner = task
    ? `${task.task_id.toUpperCase()} ${task.type.toUpperCase()} - ${task.title}`
    : state.currentJob
      ? "SPLITTING JOB..."
      : "WAITING FOR A JOB";

  const total = state.final?.total_cost_usd ?? state.stats?.total_cost_usd ?? 0;
  const finalBanner = state.final
    ? `JOB ${state.final.status.toUpperCase()} - GRADE ${state.final.mean_grade ?? "-"} - $${state.final.total_cost_usd.toFixed(4)}`
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
        : "MAIN AGENT";

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
