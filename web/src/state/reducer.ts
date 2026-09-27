import type {
  AbyssEvent,
  AgentId,
  AgentSpec,
  BidData,
  FinalData,
  HelloData,
  StatsData,
  TaskSpec,
  TaskType,
  Usage,
} from "../contract";

export type AgentStatus = "idle" | "bidding" | "working";
export type TaskStatus =
  | "pending"
  | "open"
  | "assigned"
  | "working"
  | "done"
  | "graded"
  | "failed";

export interface AgentView extends AgentSpec {
  reputation: Record<TaskType, number>;
  status: AgentStatus;
}

export interface TaskView extends TaskSpec {
  status: TaskStatus;
  bids: Partial<Record<AgentId, BidData>>;
  winner: AgentId | null;
  output: string | null;
  /** The winner's actual work call (tokens and cost). */
  workUsage: Usage | null;
  grade: number | null;
  rationale: string | null;
}

export interface MarketState {
  agents: Partial<Record<AgentId, AgentView>>;
  currentJob: {
    jobId: string;
    jobText: string;
    priceWeight: number;
  } | null;
  tasks: Record<string, TaskView>;
  taskOrder: string[];
  stats: StatsData | null;
  final: FinalData | null;
  log: AbyssEvent[];
  connected: boolean;
  config: HelloData["config"] | null;
  jobActive: boolean;
  /** The main agent has packaged the current job's file (before `final` arrives). */
  assembled: { filename: string; summary: string } | null;
  /** Every finished job this session, oldest first. */
  history: { jobId: string; jobText: string; final: FinalData }[];
  /** Steering notes the server acknowledged, for every job this session. */
  steering: { jobId: string; target: "job" | AgentId; note: string }[];
  /**
   * The highest `seq` applied for each job. A reconnect (or a second tab)
   * replays the current or last job's events: anything at or below this is
   * one we already have.
   */
  lastSeq: Record<string, number>;
  /** Jobs the user stopped this session (their file has what was finished). */
  stopped: string[];
}

// How the server says a job was stopped (backend/abyss/server.py and llm.py):
// a steering note on the job, then "stopped by you" errors for the work it cut.
export const isStopNote = (note: string): boolean => note.startsWith("Stop:");
export const isStopError = (message: string): boolean => message.startsWith("stopped by you");

/** Did the user stop this job? */
export function wasStopped(state: Pick<MarketState, "stopped">, jobId: string | null | undefined): boolean {
  return jobId != null && state.stopped.includes(jobId);
}

function markStopped(state: MarketState, jobId: string | null): string[] {
  return jobId === null || state.stopped.includes(jobId) ? state.stopped : [...state.stopped, jobId];
}

export const initialState: MarketState = {
  agents: {},
  currentJob: null,
  tasks: {},
  taskOrder: [],
  stats: null,
  final: null,
  log: [],
  connected: false,
  config: null,
  jobActive: false,
  assembled: null,
  history: [],
  steering: [],
  lastSeq: {},
  stopped: [],
};

export function setConnected(state: MarketState, connected: boolean): MarketState {
  return { ...state, connected };
}

/**
 * True when `ev` is a job event this state has already applied: the server
 * sends the current (or last) job's events to every connection that joins, so
 * a reconnect replays what we saw before it dropped. `seq` is server-wide and
 * strictly increasing, so "at or below the last one seen for that job" is exact.
 */
export function isReplay(state: MarketState, ev: AbyssEvent): boolean {
  if (ev.job_id === null) return false; // hello and one connection's own errors
  const last = state.lastSeq[ev.job_id];
  return last !== undefined && ev.seq <= last;
}

/**
 * A replayed event changes nothing we already know, except whether the job is
 * still running: the fresh `hello` cleared that, and the replay (which runs in
 * order up to the job's end, if it ended) puts it back.
 */
function replayed(state: MarketState, ev: AbyssEvent): MarketState {
  if (ev.job_id !== state.currentJob?.jobId) return state;
  const ends = ev.type === "final" || (ev.type === "error" && ev.data.fatal);
  const jobActive = !ends && !state.history.some((h) => h.jobId === ev.job_id);
  return jobActive === state.jobActive ? state : { ...state, jobActive };
}

export function reduce(state: MarketState, ev: AbyssEvent): MarketState {
  if (isReplay(state, ev)) return replayed(state, ev);
  const lastSeq = ev.job_id === null ? state.lastSeq : { ...state.lastSeq, [ev.job_id]: ev.seq };
  const withLog = { ...state, lastSeq, log: [...state.log, ev].slice(-200) };
  switch (ev.type) {
    case "hello": {
      const agents: MarketState["agents"] = {};
      for (const agent of ev.data.agents) {
        agents[agent.agent_id] = {
          ...agent,
          reputation: { ...ev.data.reputation[agent.agent_id] },
          status: "idle",
        };
      }
      // A fresh hello means a fresh connection. Closing a connection never
      // cancels the server's job, but we can't tell from hello whether one is
      // running: the server replays the current (or last) job's events right
      // after it, and those put jobActive back (see `replayed`).
      return { ...withLog, agents, connected: true, config: ev.data.config, jobActive: false };
    }
    case "job_split": {
      const tasks = Object.fromEntries(
        ev.data.tasks.map((task) => [task.task_id, createTask(task)]),
      );
      return {
        ...withLog,
        currentJob: {
          jobId: ev.job_id ?? "",
          jobText: ev.data.job_text,
          priceWeight: ev.data.price_weight,
        },
        tasks,
        taskOrder: ev.data.tasks.map((task) => task.task_id),
        stats: null,
        final: null,
        jobActive: true,
        assembled: null,
      };
    }
    case "task_posted":
      return {
        ...withLog,
        agents: mapAgentStatus(state.agents, () => "bidding"),
        tasks: updateTask(state.tasks, ev.data.task_id, {
          ...ev.data,
          status: "open",
        }),
      };
    case "bid": {
      const task = state.tasks[ev.data.task_id];
      if (!task) return withLog;
      return {
        ...withLog,
        tasks: {
          ...state.tasks,
          [ev.data.task_id]: {
            ...task,
            bids: { ...task.bids, [ev.data.agent_id]: ev.data },
          },
        },
      };
    }
    case "won":
      return {
        ...withLog,
        agents: mapAgentStatus(state.agents, () => "idle"),
        tasks: updateTask(state.tasks, ev.data.task_id, {
          winner: ev.data.agent_id,
          status: "assigned",
        }),
      };
    case "working":
      return {
        ...withLog,
        agents: mapAgentStatus(state.agents, (agentId) =>
          agentId === ev.data.agent_id ? "working" : "idle",
        ),
        tasks: updateTask(state.tasks, ev.data.task_id, { status: "working" }),
      };
    case "done":
      return {
        ...withLog,
        agents: mapAgentStatus(state.agents, () => "idle"),
        tasks: updateTask(state.tasks, ev.data.task_id, {
          output: ev.data.output,
          workUsage: ev.data.usage,
          status: "done",
        }),
      };
    case "graded":
      return {
        ...withLog,
        tasks: updateTask(state.tasks, ev.data.task_id, {
          grade: ev.data.grade,
          rationale: ev.data.rationale,
          status: "graded",
        }),
      };
    case "rep_update": {
      const agent = state.agents[ev.data.agent_id];
      if (!agent) return withLog;
      return {
        ...withLog,
        agents: {
          ...state.agents,
          [ev.data.agent_id]: {
            ...agent,
            reputation: {
              ...agent.reputation,
              [ev.data.task_type]: ev.data.new,
            },
          },
        },
      };
    }
    case "stats":
      return { ...withLog, stats: ev.data };
    case "final":
      return {
        ...withLog,
        agents: mapAgentStatus(state.agents, () => "idle"),
        final: ev.data,
        jobActive: false,
        history: [
          ...state.history,
          { jobId: ev.job_id ?? "", jobText: state.currentJob?.jobText ?? "", final: ev.data },
        ],
      };
    case "error":
      // An error for this connection only ("a job is already running", a bad
      // command, a spending limit): it says nothing about the market's job.
      if (ev.job_id === null && !ev.data.fatal) return withLog;
      return {
        ...withLog,
        stopped: isStopError(ev.data.message) ? markStopped(state, ev.job_id) : state.stopped,
        agents: mapAgentStatus(state.agents, () => "idle"),
        jobActive: ev.data.fatal ? false : state.jobActive,
        tasks: ev.data.task_id
          ? updateTask(state.tasks, ev.data.task_id, { status: "failed" })
          : state.tasks,
      };
    case "assembled":
      return { ...withLog, assembled: { filename: ev.data.filename, summary: ev.data.summary } };
    case "steered":
      return {
        ...withLog,
        steering: [...state.steering, { jobId: ev.job_id ?? "", ...ev.data }],
        stopped: ev.data.target === "job" && isStopNote(ev.data.note) ? markStopped(state, ev.job_id) : state.stopped,
      };
    default:
      console.warn("Unknown Abyss event type", (ev as { type: string }).type);
      return withLog;
  }
}

function createTask(task: TaskSpec): TaskView {
  return {
    ...task,
    status: "pending",
    bids: {},
    winner: null,
    output: null,
    workUsage: null,
    grade: null,
    rationale: null,
  };
}

function updateTask(
  tasks: Record<string, TaskView>,
  taskId: string,
  changes: Partial<TaskView>,
): Record<string, TaskView> {
  const current = tasks[taskId];
  if (!current) return tasks;
  return { ...tasks, [taskId]: { ...current, ...changes } };
}

function mapAgentStatus(
  agents: MarketState["agents"],
  status: (agentId: AgentId) => AgentStatus,
): MarketState["agents"] {
  const updated: MarketState["agents"] = {};
  for (const [agentId, agent] of Object.entries(agents) as [
    AgentId,
    AgentView,
  ][]) {
    updated[agentId] = { ...agent, status: status(agentId) };
  }
  return updated;
}
