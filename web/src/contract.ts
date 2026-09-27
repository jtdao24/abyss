// Abyss event contract v1 — mirrored from SPEC.md §7.

export type AgentId = "haiku" | "sonnet" | "opus";
export type TaskType = "research" | "writing" | "checking";
export type Purpose = "split" | "bid" | "work" | "review" | "assemble";

export interface Usage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
}

export interface AgentSpec {
  agent_id: AgentId;
  display_name: string;
  model: string;
  color: string;
}

export type Reputation = Record<AgentId, Record<TaskType, number>>;

export interface TaskSpec {
  task_id: string;
  type: TaskType;
  title: string;
  brief: string;
  depends_on: string[];
}

export interface HelloData {
  agents: AgentSpec[];
  reputation: Reputation;
  config: {
    price_weight: number;
    rep_init: number;
    rep_alpha: number;
    task_types: TaskType[];
    real_models: boolean;
    fake_llm: boolean;
    orchestrator_model: string;
    reviewer_model: string;
    /** USD per million [input, output] tokens for every model in play. Older recordings omit it. */
    prices?: Record<string, [number, number]>;
  };
}

export interface JobSplitData {
  job_text: string;
  tasks: TaskSpec[];
  price_weight: number;
  usage: Usage;
}

export interface TaskPostedData extends TaskSpec {
  index: number;
  total: number;
  est_input_tokens: number;
}

export interface BidData {
  task_id: string;
  agent_id: AgentId;
  ok: boolean;
  error: string | null;
  predicted_output_tokens: number | null;
  est_input_tokens: number | null;
  predicted_cost_usd: number | null;
  promised_quality: number | null;
  pitch: string | null;
  reputation: number | null;
  score: number | null;
  usage: Usage | null;
}

export interface WonData {
  task_id: string;
  agent_id: AgentId;
  mode: "auction" | "fixed";
  score: number | null;
  runner_up_agent_id: AgentId | null;
  runner_up_score: number | null;
  scores: Partial<Record<AgentId, number>>;
  price_weight: number;
}

export interface WorkingData {
  task_id: string;
  agent_id: AgentId;
}

export interface DoneData {
  task_id: string;
  agent_id: AgentId;
  output: string;
  predicted_output_tokens: number | null;
  predicted_cost_usd: number | null;
  usage: Usage;
}

export interface GradedData {
  task_id: string;
  agent_id: AgentId;
  grade: number;
  promised_quality: number | null;
  rationale: string;
  usage: Usage;
}

export interface RepUpdateData {
  task_id: string;
  agent_id: AgentId;
  task_type: TaskType;
  old: number;
  new: number;
  ratio: number;
}

export interface StatsData {
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  calls: number;
  by_purpose: Record<Purpose, { cost_usd: number; calls: number }>;
  by_agent: Record<
    AgentId,
    {
      cost_usd: number;
      input_tokens: number;
      output_tokens: number;
      calls: number;
      tasks_won: number;
    }
  >;
}

export interface FinalTask {
  task_id: string;
  type: TaskType;
  agent_id: AgentId | null;
  grade: number | null;
  promised_quality: number | null;
  cost_usd: number;
}

export interface FinalData {
  status: "ok" | "partial" | "error";
  deliverable_task_id: string | null;
  deliverable: string | null;
  /** The main agent's file name for the deliverable (the terminal saves it to Downloads). */
  filename: string | null;
  summary: string | null;
  tasks: FinalTask[];
  total_cost_usd: number;
  mean_grade: number | null;
  duration_ms: number;
}

export interface ErrorData {
  message: string;
  task_id: string | null;
  fatal: boolean;
}

export interface AssembledData {
  filename: string;
  summary: string;
  usage: Usage;
}

export interface SteeredData {
  target: "job" | AgentId;
  note: string;
}

type Envelope<T extends string, D> = {
  v: 1;
  seq: number;
  t: number;
  job_id: string | null;
  type: T;
  data: D;
};

export type AbyssEvent =
  | Envelope<"hello", HelloData>
  | Envelope<"job_split", JobSplitData>
  | Envelope<"task_posted", TaskPostedData>
  | Envelope<"bid", BidData>
  | Envelope<"won", WonData>
  | Envelope<"working", WorkingData>
  | Envelope<"done", DoneData>
  | Envelope<"graded", GradedData>
  | Envelope<"rep_update", RepUpdateData>
  | Envelope<"stats", StatsData>
  | Envelope<"final", FinalData>
  | Envelope<"error", ErrorData>
  | Envelope<"steered", SteeredData>
  | Envelope<"assembled", AssembledData>;

export type ClientMsg =
  | { type: "start_job"; job: string; price_weight?: number; provider?: string; budget_usd?: number; attachments?: string[]; tools?: string[] }
  | { type: "reset" }
  | { type: "steer"; target: "job" | AgentId; note: string };
