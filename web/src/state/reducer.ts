import type {
  AbyssEvent,
  AgentId,
  AgentSpec,
  BidData,
  FinalData,
  StatsData,
  TaskSpec,
  TaskType,
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
};

export function reduce(state: MarketState, ev: AbyssEvent): MarketState {
  const withLog = { ...state, log: [...state.log, ev].slice(-200) };
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
      return { ...withLog, agents, connected: true };
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
      };
    case "error":
      return {
        ...withLog,
        agents: mapAgentStatus(state.agents, () => "idle"),
        tasks: ev.data.task_id
          ? updateTask(state.tasks, ev.data.task_id, { status: "failed" })
          : state.tasks,
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
