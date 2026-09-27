// One market event as lines in the Captain's terminal (the same wording as
// the Python terminal chat, `python -m abyss.chat`). Pure apart from the
// "Open file" action, so every event type is easy to test.
import type { AbyssEvent, AgentId } from "../contract";
import { AGENT_ORDER, vendorTitle, verdict } from "../scene/model";
import { formatUsd } from "../state/money";
import { isStopError, isStopNote } from "../state/reducer";
import { openResult, resultDoc } from "./resultView";

export type Tone = "plain" | "dim" | "bold" | "cyan" | "green" | "yellow" | "red" | "echo";
export type Line = { text: string; tone: Tone; action?: { label: string; run: () => void } };
/** What describe() needs beyond the event: which jobs were stopped, and each job's text. */
export type Context = { stopped: Set<string>; jobText: Map<string, string>; /** jobs whose cut-off was already said once */ said: Set<string> };
/** Stop and the budget cap end work on purpose: said calmly, not as failures. */
const cutOff = (message: string) => isStopError(message) || message.startsWith("budget reached");

const VENDOR = Object.fromEntries(AGENT_ORDER.map((id) => [id, vendorTitle(id)])) as Record<AgentId, string>;
const VERDICT_TONE = { good: "green", ok: "yellow", bad: "red" } as const;

/** Tasks worth redoing: unfinished, or graded below what the vendor promised. */
export function weakTasks(tasks: { task_id: string; grade: number | null; promised_quality: number | null }[]): string[] {
  return tasks.filter((t) => t.grade === null || (t.promised_quality !== null && t.grade < t.promised_quality)).map((t) => t.task_id);
}

/** One event as terminal lines (the same wording as the Python terminal chat). */
export function describe(ev: AbyssEvent, ctx: Context): Line[] {
  switch (ev.type) {
    case "hello": {
      const c = ev.data.config;
      const mode = c.fake_llm ? "FAKE MODE — no real AI calls" : !c.real_models ? "TEST MODE — every vendor on the budget model" : "LIVE — real models";
      return [{ text: `connected to the market · ${mode}`, tone: "dim" }];
    }
    case "job_split":
      return [
        { text: `🧭 Main agent split the job into ${ev.data.tasks.length} tasks:`, tone: "bold" },
        ...ev.data.tasks.map((t) => ({ text: `   ${t.task_id.toUpperCase()} ${t.type.padEnd(8)} ${t.title}`, tone: "plain" as Tone })),
      ];
    case "task_posted":
      return [{ text: "", tone: "plain" }, { text: `→ ${ev.data.task_id.toUpperCase()} (${ev.data.type}): vendors are walking to the boat to bid`, tone: "cyan" }];
    case "bid": {
      const who = VENDOR[ev.data.agent_id];
      if (!ev.data.ok) {
        if (cutOff(ev.data.error ?? "")) return []; // the task's own line says why
        const standby = (ev.data.error ?? "").startsWith("standby");
        return [{ text: `   ${who} ${standby ? "is on standby (backup only)" : "passed"}`, tone: "dim" }];
      }
      const cents = ((ev.data.predicted_cost_usd ?? 0) * 100).toFixed(2);
      return [{ text: `   ${who} bids: promises ${ev.data.promised_quality}/10 for ${cents}¢ — "${ev.data.pitch}"`, tone: "dim" }];
    }
    case "won":
      return [{ text: `   ✓ ${VENDOR[ev.data.agent_id]} wins ${ev.data.task_id.toUpperCase()}`, tone: "bold" }];
    case "working":
      return [{ text: `   ${VENDOR[ev.data.agent_id]} is working on it...`, tone: "dim" }];
    case "done":
      return [{ text: `   ${VENDOR[ev.data.agent_id]} finished (${ev.data.usage.output_tokens} tokens, ${formatUsd(ev.data.usage.cost_usd)}) → off to the reviewer`, tone: "dim" }];
    case "graded": {
      const { grade, promised_quality: promised } = ev.data;
      const tone: Tone = VERDICT_TONE[verdict(grade, promised)];
      return [{ text: `   Reviewer: ${grade}/10${promised !== null ? ` (promised ${promised})` : ""} — ${ev.data.rationale}`, tone }];
    }
    case "rep_update": {
      const delta = ev.data.new - ev.data.old;
      return [{ text: `   ${VENDOR[ev.data.agent_id]} ${ev.data.task_type} reputation ${ev.data.old.toFixed(3)} → ${ev.data.new.toFixed(3)} ${delta > 0 ? "▲" : delta < 0 ? "▼" : "="}`, tone: "dim" }];
    }
    case "steered":
      if (ev.data.target === "job" && isStopNote(ev.data.note))
        return [{ text: "   ■ Stopping: work already started finishes, no new AI calls start", tone: "yellow" }];
      return [{ text: `   ✎ noted for ${ev.data.target === "job" ? "every vendor" : VENDOR[ev.data.target]}: "${ev.data.note}" (applies from their next piece of work)`, tone: "yellow" }];
    case "assembled":
      return [{ text: "", tone: "plain" }, { text: `📦 Main agent is packaging everything into ${ev.data.filename}`, tone: "bold" }];
    case "final": {
      const f = ev.data;
      const stopped = ev.job_id !== null && ctx.stopped.has(ev.job_id);
      if (!f.deliverable || !f.filename)
        return stopped
          ? [{ text: "■ Stopped before anything was finished: no file.", tone: "yellow" }]
          : [{ text: `✗ The job ended (${f.status}) without a file.`, tone: "red" }];
      const open = () => openResult(resultDoc(f, ctx.jobText.get(ev.job_id ?? "") ?? null, stopped));
      return [
        { text: "", tone: "plain" },
        stopped
          ? { text: `■ Stopped. Your file has what was finished: ${f.filename}`, tone: "yellow", action: { label: "Open file", run: open } }
          : { text: `✅ Done! Your file is ready: ${f.filename}`, tone: "green", action: { label: "Open file", run: open } },
        ...(f.summary ? [{ text: `   ${f.summary}`, tone: "plain" as Tone }] : []),
        { text: `   mean grade ${f.mean_grade ?? "—"}/10 · total cost ${formatUsd(f.total_cost_usd)} · ${(f.duration_ms / 1000).toFixed(1)}s`, tone: "dim" },
        ...(weakTasks(f.tasks).length
          ? [{ text: `   /retry sends ${weakTasks(f.tasks).map((id) => id.toUpperCase()).join(", ")} out for bids again and keeps the rest`, tone: "yellow" as Tone }]
          : []),
      ];
    }
    case "error": {
      const m = ev.data.message;
      if (cutOff(m)) {
        // Said once per job; each later task it cut off just gets a short line.
        const key = ev.job_id ?? "";
        const draft = /your file is .*/.exec(m)?.[0];
        if (draft && ctx.said.has(key)) return [{ text: `   ■ Y${draft.slice(1)}`, tone: "yellow" }];
        if (ctx.said.has(key)) return ev.data.task_id ? [{ text: `   ■ ${ev.data.task_id.toUpperCase()} skipped`, tone: "yellow" }] : [];
        ctx.said.add(key);
        return [{ text: `   ■ ${m[0].toUpperCase()}${m.slice(1)}`, tone: "yellow" }];
      }
      return [{ text: `   ⚠ ${m}`, tone: "red" }];
    }
    default:
      return [];
  }
}
