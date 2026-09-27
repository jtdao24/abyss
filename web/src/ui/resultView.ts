// Which finished file the result panel is showing (null = closed). The terminal,
// the header's File button and past sessions all open it through here.
import type { FinalData } from "../contract";

export interface ResultDoc {
  filename: string;
  content: string;
  summary: string | null;
  jobText: string | null;
  status: FinalData["status"];
  /** The user pressed Stop: the file has what was finished. */
  stopped: boolean;
  meanGrade: number | null;
  costUsd: number;
  durationMs: number;
}

let current: ResultDoc | null = null;
const listeners = new Set<(doc: ResultDoc | null) => void>();

export function resultDoc(final: FinalData, jobText: string | null, stopped: boolean): ResultDoc | null {
  if (!final.deliverable) return null;
  return {
    filename: final.filename ?? "result.md",
    content: final.deliverable,
    summary: final.summary,
    jobText,
    status: final.status,
    stopped,
    meanGrade: final.mean_grade,
    costUsd: final.total_cost_usd,
    durationMs: final.duration_ms,
  };
}

export function openResult(doc: ResultDoc | null): void {
  current = doc;
  listeners.forEach((fn) => fn(current));
}

export const closeResult = (): void => openResult(null);

export function onResultChange(fn: (doc: ResultDoc | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function currentResult(): ResultDoc | null {
  return current;
}

/** Save text as a file from the browser. */
export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Copy text; falls back to a hidden textarea where the Clipboard API is blocked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

/** Job ids the user stopped, read from the event log (Stop's steering note or its error). */
export function stoppedJobs(log: { type: string; job_id: string | null; data: unknown }[]): Set<string> {
  const ids = new Set<string>();
  for (const ev of log) {
    if (!ev.job_id) continue;
    const d = ev.data as { note?: string; message?: string };
    if ((ev.type === "steered" && d.note?.startsWith("Stop:")) || (ev.type === "error" && d.message?.startsWith("stopped by you"))) ids.add(ev.job_id);
  }
  return ids;
}
