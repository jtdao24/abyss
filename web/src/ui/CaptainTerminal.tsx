// The Captain is a terminal: type a job (or a /command) at the prompt and the
// market streams its progress back, line by line, like `python -m abyss.chat`.
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";

import { api, type Attachment, type Provider, type SessionSummary } from "../api";
import type { AbyssEvent, AgentId, ClientMsg } from "../contract";
import type { MarketState } from "../state/reducer";

type Tone = "plain" | "dim" | "bold" | "cyan" | "green" | "yellow" | "red" | "echo";
type Line = { text: string; tone: Tone };

const VENDOR: Record<AgentId, string> = { opus: "Vendor 1", sonnet: "Vendor 2", haiku: "Vendor 3" };
const STEER_TARGET: Record<string, "job" | AgentId> = {
  "1": "opus", v1: "opus", vendor1: "opus",
  "2": "sonnet", v2: "sonnet", vendor2: "sonnet",
  "3": "haiku", v3: "haiku", vendor3: "haiku",
  job: "job", all: "job", everyone: "job",
};

const EXAMPLES = [
  "Research [topic] and write a 200-word brief for a busy reader, with the 3 key facts and sources.",
  "Fact-check the following text. List every claim that is wrong or unsupported, with a correction: [paste the text]",
  "Summarize the attached material in 8 bullet points, then list 3 open questions it raises.",
  "Compare [option A] and [option B] for [goal]: a pros and cons table, then a one-paragraph recommendation.",
  "Plan a [N]-day trip to [place] for [who] under [budget]: a day-by-day plan with costs.",
  "Write a Python function that [does something], with a docstring and three example calls. Then check it for bugs.",
];

const HELP: Line[] = [
  ["Type a job and press Enter. Commands:", "bold"],
  ["  /steer <1|2|3|job> <note>   steer a vendor (or everyone) mid-job", "plain"],
  ["  /price <0-5>                how much price matters (0 = quality only)", "plain"],
  ["  /budget <usd|off>           hard spending cap for your next job", "plain"],
  ["  /ai [name]                  pick the AI for your next job", "plain"],
  ["  /link <url>  /file          attach a link or a file to your next job", "plain"],
  ["  /examples  /example <n>     sample jobs (puts one on the prompt)", "plain"],
  ["  /estimate                   what a typical job costs", "plain"],
  ["  /result  /save              read or download the finished file", "plain"],
  ["  /sessions  /open <n>        past sessions", "plain"],
  ["  /status  /reset  /clear  /exit", "plain"],
  ["  ↑ ↓ recall earlier lines · Esc closes", "dim"],
].map(([text, tone]) => ({ text, tone: tone as Tone }));

/** One event as terminal lines (the same wording as the Python terminal chat). */
function describe(ev: AbyssEvent): Line[] {
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
      return [{ text: `   ${VENDOR[ev.data.agent_id]} finished (${ev.data.usage.output_tokens} tokens, $${ev.data.usage.cost_usd.toFixed(4)}) → off to the reviewer`, tone: "dim" }];
    case "graded": {
      const { grade, promised_quality: promised } = ev.data;
      const tone: Tone = promised === null || grade >= promised ? "green" : grade < promised - 1 ? "red" : "yellow";
      return [{ text: `   Reviewer: ${grade}/10${promised !== null ? ` (promised ${promised})` : ""} — ${ev.data.rationale}`, tone }];
    }
    case "rep_update": {
      const delta = ev.data.new - ev.data.old;
      return [{ text: `   ${VENDOR[ev.data.agent_id]} ${ev.data.task_type} reputation ${ev.data.old.toFixed(3)} → ${ev.data.new.toFixed(3)} ${delta > 0 ? "▲" : delta < 0 ? "▼" : "="}`, tone: "dim" }];
    }
    case "steered":
      return [{ text: `   ✎ noted for ${ev.data.target === "job" ? "every vendor" : VENDOR[ev.data.target]}: "${ev.data.note}" (applies from their next piece of work)`, tone: "yellow" }];
    case "assembled":
      return [{ text: "", tone: "plain" }, { text: `📦 Main agent is packaging everything into ${ev.data.filename}`, tone: "bold" }];
    case "final": {
      const f = ev.data;
      if (!f.deliverable || !f.filename) return [{ text: `✗ The job ended (${f.status}) without a file.`, tone: "red" }];
      return [
        { text: "", tone: "plain" },
        { text: `✅ Done! Your file is ready: ${f.filename}  (/save downloads it, /result shows it)`, tone: "green" },
        ...(f.summary ? [{ text: `   ${f.summary}`, tone: "plain" as Tone }] : []),
        { text: `   mean grade ${f.mean_grade ?? "—"}/10 · total cost $${f.total_cost_usd.toFixed(4)} · ${(f.duration_ms / 1000).toFixed(1)}s`, tone: "dim" },
      ];
    }
    case "error":
      return [{ text: `   ⚠ ${ev.data.message}`, tone: "red" }];
    default:
      return [];
  }
}

/** Save the finished file from the browser. */
function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// The terminal outlives its window: closing the Captain and coming back keeps
// the scrollback, your settings and your command history.
type Local = { id: number; after: AbyssEvent | null; lines: Line[] };
const term = {
  nextId: 1,
  local: [] as Local[],
  clearedAfterId: 0,
  clearedAfterEvent: null as AbyssEvent | null,
  history: [] as string[],
  priceWeight: 1,
  budget: null as number | null,
  provider: null as string | null,
  attachments: [] as Attachment[],
};

interface Props {
  state: MarketState;
  onClose(): void;
  send?: (message: ClientMsg) => boolean;
  providers?: Provider[];
  sessions?: SessionSummary[];
}

export function CaptainTerminal({ state, onClose, send, providers = [], sessions = [] }: Props) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [input, setInput] = useState("");
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const screen = useRef<HTMLDivElement | null>(null);
  const field = useRef<HTMLInputElement | null>(null);
  const filePicker = useRef<HTMLInputElement | null>(null);
  const live = Boolean(send);
  const running = state.jobActive;

  const print = (...lines: (Line | string)[]) => {
    const last = state.log.at(-1) ?? null;
    term.local.push({ id: term.nextId++, after: last, lines: lines.map((l) => (typeof l === "string" ? { text: l, tone: "plain" } : l)) });
    rerender();
  };

  // A welcome the first time the terminal opens.
  useEffect(() => {
    if (term.local.length === 0) {
      print(
        { text: "Abyss — tell the Captain what you need.  (/help for commands)", tone: "bold" },
        live ? { text: "Type a job below and press Enter.", tone: "dim" } : { text: "This is a replay: you can watch and read, but not start jobs.", tone: "dim" },
      );
    }
    field.current?.focus();
  }, []);

  // Stay pinned to the newest line while the market talks (unless you scrolled up).
  const lineCount = state.log.length + term.local.length;
  useEffect(() => {
    const el = screen.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [lineCount]);
  useEffect(() => {
    if (screen.current) screen.current.scrollTop = screen.current.scrollHeight;
  }, []);

  const attach = async (make: () => Promise<Attachment>, what: string) => {
    print({ text: `reading ${what}…`, tone: "dim" });
    try {
      const added = await make();
      term.attachments = [...term.attachments.filter((a) => a.id !== added.id), added].slice(0, 5);
      print({ text: `attached ${added.name} (${added.chars.toLocaleString()} chars) to your next job`, tone: "green" });
    } catch (error) {
      print({ text: `couldn't attach that: ${error instanceof Error ? error.message : "unknown error"}`, tone: "red" });
    }
  };

  const needLive = () => {
    if (live) return false;
    print({ text: "not in a replay: run python start.py to use the live market", tone: "yellow" });
    return true;
  };

  const run = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    term.history = [...term.history.filter((h) => h !== text), text].slice(-50);
    print({ text: `you › ${text}`, tone: "echo" });
    if (!text.startsWith("/")) {
      if (needLive()) return;
      if (running) return print({ text: "A job is already running. Steer it with /steer, or wait for it to finish.", tone: "yellow" });
      if (!state.connected) return print({ text: "not connected to the market yet", tone: "red" });
      const sent = send!({
        type: "start_job",
        job: text,
        price_weight: term.priceWeight,
        ...(term.provider ? { provider: term.provider } : {}),
        ...(term.budget !== null ? { budget_usd: term.budget } : {}),
        ...(term.attachments.length ? { attachments: term.attachments.map((a) => a.id) } : {}),
      });
      if (!sent) return print({ text: "couldn't send that: the connection dropped", tone: "red" });
      term.attachments = [];
      return print({ text: "Sent to the main agent. Watch the market, or follow along here.", tone: "dim" });
    }

    const [head, ...restParts] = text.slice(1).split(" ");
    const rest = restParts.join(" ").trim();
    switch (head.toLowerCase()) {
      case "help": case "h": case "?":
        return print(...HELP);
      case "exit": case "quit": case "q":
        return onClose();
      case "clear":
        term.clearedAfterId = term.nextId;
        term.clearedAfterEvent = state.log.at(-1) ?? null;
        return rerender();
      case "status": {
        const bits = [running ? "a job is running" : "the market is idle", `price weight ${term.priceWeight}`];
        if (term.budget !== null) bits.push(`budget $${term.budget}`);
        if (term.provider) bits.push(`AI ${term.provider}`);
        if (term.attachments.length) bits.push(`${term.attachments.length} attached`);
        return print({ text: bits.join(" · "), tone: "dim" });
      }
      case "price": {
        const weight = Number(rest);
        if (!rest || !Number.isFinite(weight) || weight < 0 || weight > 5) return print({ text: "usage: /price <number between 0 and 5>", tone: "red" });
        term.priceWeight = weight;
        return print({ text: `price weight set to ${weight} for your next job`, tone: "dim" });
      }
      case "budget": {
        if (rest === "off" || rest === "none") {
          term.budget = null;
          return print({ text: "no budget cap", tone: "dim" });
        }
        const usd = Number(rest.replace("$", ""));
        if (!Number.isFinite(usd) || usd <= 0 || usd > 100) return print({ text: "usage: /budget <dollars, up to 100> or /budget off", tone: "red" });
        term.budget = usd;
        return print({ text: `budget cap $${usd} for your next job: the crew stops when it runs out`, tone: "dim" });
      }
      case "ai": {
        if (!rest) {
          if (!providers.length) return print({ text: live ? "only the default AI is available" : "no AIs in a replay", tone: "dim" });
          return print(...providers.map((p, i) => ({ text: `  ${p.id}${p.id === (term.provider ?? providers[0].id) ? " (selected)" : ""} — ${p.label}${i === 0 ? ", default" : ""}`, tone: "plain" as Tone })));
        }
        const match = providers.find((p) => p.id === rest.toLowerCase() || p.label.toLowerCase().includes(rest.toLowerCase()));
        if (!match) return print({ text: `no AI called "${rest}" (try /ai to list them)`, tone: "red" });
        term.provider = match.id;
        return print({ text: `your next job runs on ${match.label}`, tone: "dim" });
      }
      case "link":
        if (needLive()) return;
        if (!/^https?:\/\//.test(rest)) return print({ text: "usage: /link https://…", tone: "red" });
        return void attach(() => api.attachLink(rest), rest);
      case "file":
        if (needLive()) return;
        return filePicker.current?.click();
      case "attached":
        if (!term.attachments.length) return print({ text: "nothing attached", tone: "dim" });
        return print(...term.attachments.map((a) => `  ${a.kind === "link" ? "🔗" : "📄"} ${a.name}`), { text: "/detach clears them", tone: "dim" });
      case "detach":
        term.attachments = [];
        return print({ text: "attachments cleared", tone: "dim" });
      case "examples":
        return print(...EXAMPLES.map((e, i) => `  ${i + 1}. ${e}`), { text: "/example <n> puts one on the prompt to edit", tone: "dim" });
      case "example": {
        const pick = EXAMPLES[Number(rest) - 1];
        if (!pick) return print({ text: `usage: /example <1-${EXAMPLES.length}>`, tone: "red" });
        setInput(pick);
        return rerender();
      }
      case "estimate":
        if (needLive()) return;
        api.estimate(term.provider).then(
          (e) => print({ text: `a typical ${e.tasks}-task job costs about $${e.low_usd.toFixed(4)}–$${e.high_usd.toFixed(4)} (${e.calls} AI calls)`, tone: "dim" }),
          () => print({ text: "couldn't get an estimate", tone: "red" }),
        );
        return;
      case "steer": {
        if (needLive()) return;
        const [who, ...noteParts] = rest.split(" ");
        const target = STEER_TARGET[who?.toLowerCase() ?? ""];
        const note = noteParts.join(" ").trim();
        if (!target || !note) return print({ text: "usage: /steer <1|2|3|job> <note>", tone: "red" });
        if (!running) return print({ text: "no job is running to steer", tone: "yellow" });
        send!({ type: "steer", target, note });
        return;
      }
      case "reset":
        if (needLive()) return;
        send!({ type: "reset" });
        return print({ text: "reputations reset", tone: "dim" });
      case "result": {
        const f = state.final;
        if (!f?.deliverable) return print({ text: "no finished file yet", tone: "dim" });
        return print({ text: `── ${f.filename ?? "result"} ──`, tone: "cyan" }, ...f.deliverable.split("\n"), { text: "── end ──", tone: "cyan" });
      }
      case "save": {
        const f = state.final;
        if (!f?.deliverable) return print({ text: "no finished file yet", tone: "dim" });
        download(f.filename ?? "result.md", f.deliverable);
        return print({ text: `downloading ${f.filename ?? "result.md"}`, tone: "green" });
      }
      case "sessions":
        if (!sessions.length) return print({ text: "no saved sessions yet", tone: "dim" });
        return print(
          ...sessions.slice(0, 10).map((s, i) => `  ${i + 1}. ${s.job_text.slice(0, 60)}${s.job_text.length > 60 ? "…" : ""}  · $${s.cost_usd.toFixed(4)}${s.mean_grade != null ? ` · ${s.mean_grade}/10` : ""}`),
          { text: "/open <n> shows one", tone: "dim" },
        );
      case "open": {
        const s = sessions[Number(rest) - 1];
        if (!s) return print({ text: "usage: /open <n> (see /sessions)", tone: "red" });
        api.session(s.id).then(
          (record) => {
            const f = record.final;
            print({ text: `── ${record.job_text} ──`, tone: "cyan" });
            if (!f?.deliverable) return print({ text: `this session ended without a file (${record.status})`, tone: "dim" });
            print(...f.deliverable.split("\n"), { text: `── ${f.filename ?? "result"} · grade ${f.mean_grade ?? "—"}/10 · $${f.total_cost_usd.toFixed(4)} ──`, tone: "cyan" });
          },
          () => print({ text: "couldn't load that session", tone: "red" }),
        );
        return;
      }
      default:
        return print({ text: `unknown command /${head} (try /help)`, tone: "red" });
    }
  };

  // Scrollback: every event's lines, with your own lines placed after the event they followed.
  const rows: ReactNode[] = [];
  const localByEvent = new Map<AbyssEvent | null, Local[]>();
  const shownEvents = new Set(state.log);
  for (const l of term.local) {
    if (l.id < term.clearedAfterId) continue;
    const key = l.after && shownEvents.has(l.after) ? l.after : null;
    localByEvent.set(key, [...(localByEvent.get(key) ?? []), l]);
  }
  const pushLines = (key: string, lines: Line[]) =>
    lines.forEach((line, i) => rows.push(<div key={`${key}-${i}`} className={`t-${line.tone}`}>{line.text || " "}</div>));
  localByEvent.get(null)?.forEach((l) => pushLines(`l${l.id}`, l.lines));
  const clearedAt = term.clearedAfterEvent ? state.log.indexOf(term.clearedAfterEvent) : -1;
  state.log.forEach((ev, index) => {
    if (index > clearedAt) pushLines(`e${ev.seq}-${index}`, describe(ev));
    localByEvent.get(ev)?.forEach((l) => pushLines(`l${l.id}`, l.lines));
  });

  return (
    <div className="rpg-dialog captain-term" role="dialog" aria-label="Captain terminal" onPointerDown={(e) => e.stopPropagation()}>
      <div className="ct-bar">
        <span className="ct-dots"><i /><i /><i /></span>
        <strong>captain@abyss</strong>
        <em className={running ? "busy" : ""}>{running ? "job running" : live ? (state.connected ? "ready" : "connecting…") : "replay"}</em>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="ct-screen" ref={screen} onClick={() => window.getSelection()?.isCollapsed && field.current?.focus()} aria-live="polite">
        {rows}
      </div>
      <form
        className="ct-prompt"
        onSubmit={(e) => {
          e.preventDefault();
          run(input);
          setInput("");
          setHistoryAt(null);
        }}
      >
        <span>you ›</span>
        <input
          ref={field}
          value={input}
          spellCheck={false}
          autoComplete="off"
          placeholder={running ? "/steer 2 keep it short" : "type a job, or /help"}
          aria-label="Command"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            if (!term.history.length) return;
            const at = historyAt === null ? term.history.length : historyAt;
            const next = Math.max(0, Math.min(term.history.length, at + (e.key === "ArrowUp" ? -1 : 1)));
            setHistoryAt(next);
            setInput(term.history[next] ?? "");
          }}
        />
      </form>
      <input
        ref={filePicker}
        type="file"
        hidden
        accept=".pdf,.txt,.md,.csv,.tsv,.json,.log"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void attach(() => api.attachFile(file), file.name);
        }}
      />
    </div>
  );
}
