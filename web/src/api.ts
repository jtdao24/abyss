// The local tool's HTTP API (backend/abyss/server.py, /api/*). Same origin as
// the page: the backend serves the built site, and `npm run dev` proxies it.
import type { FinalData, StatsData } from "./contract";

export interface Provider {
  id: string;
  label: string;
}

export interface Prices {
  default_provider: string;
  fake: boolean;
  test_mode: boolean;
  /** provider -> agent id -> the model that serves it */
  tiers: Record<string, Record<string, string>>;
  /** model -> [input, output] USD per million tokens */
  prices: Record<string, [number, number]>;
}

export interface SessionSummary {
  id: string;
  job_text: string;
  provider: string | null;
  status: string | null;
  cost_usd: number;
  mean_grade: number | null;
  filename: string | null;
  started_at: number | null;
  duration_ms: number | null;
  budget_usd: number | null;
}

export interface Estimate {
  provider: string;
  test_mode: boolean;
  tasks: number;
  low_usd: number;
  high_usd: number;
  calls: number;
}

export interface SessionRecord {
  id: string;
  job_text: string;
  provider: string | null;
  status: string;
  started_at: number;
  stats: StatsData | null;
  final: FinalData | null;
}

export interface Usage {
  totals: {
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    calls: number;
    jobs: number;
    premium_equiv_usd: number;
  };
  mean_grade: number | null;
  by_purpose: Record<string, { cost_usd: number; calls: number }>;
  by_provider: Record<string, { cost_usd: number; jobs: number }>;
  recent: {
    job_id: string;
    cost_usd: number;
    premium_equiv_usd: number;
    mean_grade: number | null;
    provider: string;
    job_text: string;
    started_at: number | null;
  }[];
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return (await response.json()) as T;
}

export const api = {
  providers: () => getJson<Provider[]>("/api/providers"),
  prices: () => getJson<Prices>("/api/prices"),
  sessions: () => getJson<SessionSummary[]>("/api/sessions"),
  session: (id: string) => getJson<SessionRecord>(`/api/sessions/${encodeURIComponent(id)}`),
  usage: () => getJson<Usage>("/api/usage"),
  estimate: (provider: string | null) =>
    getJson<Estimate>(`/api/estimate${provider ? `?provider=${encodeURIComponent(provider)}` : ""}`),
};
