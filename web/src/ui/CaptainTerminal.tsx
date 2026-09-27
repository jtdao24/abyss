// The Captain is a terminal: type a job (or a /command) at the prompt and the
// market streams its progress back, line by line, like `python -m abyss.chat`.
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";

import { sfx } from "../audio/sfx";
import { api, type Attachment, type McpServer, type Provider, type SessionRecord, type SessionSummary } from "../api";
import type { AbyssEvent, AgentId, ClientMsg } from "../contract";
import { formatUsd } from "../state/money";
import { wasStopped, type MarketState } from "../state/reducer";
import { describe, weakTasks, type Context, type Line, type Tone } from "./describeEvent";
import { downloadText, openResult, resultDoc } from "./resultView";
import { eventKey, nearBottom } from "./terminalScroll";
import { useDialogFocus } from "./useDialogFocus";

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
  ["  /stop                       stop the running job (no new AI calls)", "plain"],
  ["  /queue  /unqueue <n>        jobs typed while one runs wait in line", "plain"],
  ["  /rerun [n]                  run a past session again (/sessions numbers)", "plain"],
  ["  /retry [t2,t3] [n]          redo just those tasks, keep the rest (none named: the weak ones)", "plain"],
  ["  /price <0-5>                how much price matters (0 = quality only)", "plain"],
  ["  /budget <usd|off>           hard spending cap for your next job", "plain"],
  ["  /ai [name]                  pick the AI for your next job", "plain"],
  ["  /link <url>  /file          attach a link or a file to your next job", "plain"],
  ["  /tools [on|off <name>|all]  which tool servers the vendors may use", "plain"],
  ["  /examples  /example <n>     sample jobs (puts one on the prompt)", "plain"],
  ["  /estimate                   what a typical job costs", "plain"],
  ["  /result  /save              open or download the finished file", "plain"],
  ["  /sessions  /open <n>        past sessions (open shows the file)", "plain"],
  ["  /status  /reset  /clear  /exit", "plain"],
  ["  ↑ ↓ recall earlier lines · Esc closes", "dim"],
].map(([text, tone]) => ({ text, tone: tone as Tone }));

// The terminal outlives its window: closing the Captain and coming back keeps
// the scrollback, your settings and your command history.
type Local = { id: number; after: AbyssEvent | null; lines: Line[] };
const MAX_LOCAL = 300;
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
  /** Connected tool servers (ready ones), and the ones left out of your next job. */
  toolServers: [] as McpServer[],
  toolsOff: [] as string[],
};

interface Props {
  state: MarketState;
  onClose(): void;
  send?: (message: ClientMsg) => boolean;
  providers?: Provider[];
  sessions?: SessionSummary[];
}

export function CaptainTerminal({ state, onClose, send, providers = [], sessions = [] }: Props) {
  // `version` changes whenever your own lines do (they live outside React state).
  const [version, rerender] = useReducer((n: number) => n + 1, 0);
  const [input, setInput] = useState("");
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const screen = useRef<HTMLDivElement | null>(null);
  const field = useRef<HTMLInputElement | null>(null);
  const filePicker = useRef<HTMLInputElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  useDialogFocus(dialog); // the prompt gets focus; closing hands it back
  const live = Boolean(send);
  const running = state.jobActive;

  const toLines = (lines: (Line | string)[]): Line[] => lines.map((l) => (typeof l === "string" ? { text: l, tone: "plain" } : l));
  const print = (...lines: (Line | string)[]): Local => {
    const last = state.log.at(-1) ?? null;
    const entry: Local = { id: term.nextId++, after: last, lines: toLines(lines) };
    term.local.push(entry);
    // The market's own log keeps its last 200 events; keep your lines bounded too.
    if (term.local.length > MAX_LOCAL) term.local.splice(0, term.local.length - MAX_LOCAL);
    rerender();
    return entry;
  };
  /**
   * For commands that answer later (a fetch): print a placeholder now and fill
   * it in place when the answer comes, so the reply sits under its command
   * instead of after whatever you typed next.
   */
  const later = (what: string) => {
    const entry = print({ text: `${what}…`, tone: "dim" });
    return (...lines: (Line | string)[]) => {
      entry.lines = toLines(lines);
      rerender();
    };
  };

  // A welcome the first time the terminal opens.
  useEffect(() => {
    if (term.local.length === 0) {
      print(
        { text: "Abyss — tell the Captain what you need.  (/help for commands)", tone: "bold" },
        live ? { text: "Type a job below and press Enter.", tone: "dim" } : { text: "This is a replay: you can watch and read, but not start jobs.", tone: "dim" },
      );
    }
    if (live) api.mcp().then((v) => (term.toolServers = v.servers.filter((s) => s.state === "ready"))).catch(() => undefined);
  }, []);

  // Stay pinned to the newest line while the market talks, unless you scrolled up.
  // "Were you at the bottom" is measured when you scroll, not after lines arrive:
  // a burst taller than the slack (the job's plan) would otherwise unpin it.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = screen.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  const attach = async (make: () => Promise<Attachment>, what: string) => {
    const answer = later(`reading ${what}`);
    try {
      const added = await make();
      term.attachments = [...term.attachments.filter((a) => a.id !== added.id), added].slice(0, 5);
      answer({ text: `attached ${added.name} (${added.chars.toLocaleString()} chars) to your next job`, tone: "green" });
    } catch (error) {
      answer({ text: `couldn't attach that: ${error instanceof Error ? error.message : "unknown error"}`, tone: "red" });
    }
  };

  const stop = () => {
    if (needLive()) return;
    if (!running) return print({ text: "no job is running to stop", tone: "yellow" });
    // The server's "Stopping" note confirms it (every open window sees that).
    if (!send!({ type: "stop_job" })) print({ text: "couldn't send that: the connection dropped", tone: "red" });
  };

  const rerun = (record: SessionRecord): Line[] => {
    const sent = send!({
      type: "start_job",
      job: record.job_text,
      ...(record.provider ? { provider: record.provider } : {}),
      ...(record.budget_usd != null ? { budget_usd: record.budget_usd } : {}),
      ...(record.attachment_ids?.length ? { attachments: record.attachment_ids } : {}),
      ...(record.tools ? { tools: record.tools } : {}),
      ...(running ? { queue: true } : {}),
    });
    if (!sent) return [{ text: "couldn't send that: the connection dropped", tone: "red" }];
    return [{ text: `${running ? "queued" : "running"} again: "${record.job_text.slice(0, 70)}" (same AI, budget, tools and files)`, tone: "dim" }];
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
      if (!state.connected) return print({ text: "not connected to the market yet", tone: "red" });
      const sent = send!({
        type: "start_job",
        job: text,
        price_weight: term.priceWeight,
        ...(term.provider ? { provider: term.provider } : {}),
        ...(term.budget !== null ? { budget_usd: term.budget } : {}),
        ...(term.attachments.length ? { attachments: term.attachments.map((a) => a.id) } : {}),
        // Tools are all on unless you switched some off (then send the ones still on).
        ...(term.toolsOff.length ? { tools: term.toolServers.map((t) => t.name).filter((n) => !term.toolsOff.includes(n)) } : {}),
        // Busy? Wait in line instead of being refused.
        ...(running ? { queue: true } : {}),
      });
      if (!sent) return print({ text: "couldn't send that: the connection dropped", tone: "red" });
      term.attachments = [];
      if (running) return print({ text: "The crew is busy: your job is queued and starts when this one ends (/queue).", tone: "yellow" });
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
        const bits = [running ? "a job is running (/stop to stop it)" : "the market is idle", `price weight ${term.priceWeight}`];
        if (term.budget !== null) bits.push(`budget $${term.budget}`);
        if (term.provider) bits.push(`AI ${term.provider}`);
        if (term.attachments.length) bits.push(`${term.attachments.length} attached`);
        if (term.toolsOff.length) bits.push(`${term.toolsOff.length} tool server${term.toolsOff.length === 1 ? "" : "s"} off`);
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
      case "tools": {
        if (needLive()) return;
        const [action, ...nameParts] = rest.split(" ");
        const name = nameParts.join(" ").trim().toLowerCase();
        const answer = later("checking the tool servers");
        api.mcp().then(
          (v) => {
            term.toolServers = v.servers.filter((t) => t.state === "ready");
            const find = () => term.toolServers.find((t) => t.name.toLowerCase() === name || t.label.toLowerCase() === name);
            if (action === "all") {
              term.toolsOff = [];
              return answer({ text: "every tool server is on for your next job", tone: "dim" });
            }
            if (action === "on" || action === "off") {
              const server = find();
              if (!server) return answer({ text: `no connected tool server called "${name}" (try /tools)`, tone: "red" });
              term.toolsOff = action === "off" ? [...new Set([...term.toolsOff, server.name])] : term.toolsOff.filter((n) => n !== server.name);
              return answer({ text: `${server.label} is ${action} for your next job`, tone: "dim" });
            }
            if (action) return answer({ text: "usage: /tools, /tools on <name>, /tools off <name>, /tools all", tone: "red" });
            if (!term.toolServers.length) return answer({ text: "no tool servers connected (add some with the Tools button)", tone: "dim" });
            answer(
              ...term.toolServers.map((t) => ({
                text: `  ${term.toolsOff.includes(t.name) ? "·" : "✓"} ${t.name} — ${t.label} (${t.tools.length} tools)${term.toolsOff.includes(t.name) ? ", off" : ""}`,
                tone: (term.toolsOff.includes(t.name) ? "dim" : "plain") as Tone,
              })),
              { text: "/tools off <name> leaves one out of your next job", tone: "dim" },
            );
          },
          () => answer({ text: "couldn't reach the tool servers", tone: "red" }),
        );
        return;
      }
      case "examples":
        return print(...EXAMPLES.map((e, i) => `  ${i + 1}. ${e}`), { text: "/example <n> puts one on the prompt to edit", tone: "dim" });
      case "example": {
        const pick = EXAMPLES[Number(rest) - 1];
        if (!pick) return print({ text: `usage: /example <1-${EXAMPLES.length}>`, tone: "red" });
        setInput(pick);
        return rerender();
      }
      case "estimate": {
        if (needLive()) return;
        const answer = later("estimating");
        api.estimate(term.provider).then(
          (e) => answer({ text: `a typical ${e.tasks}-task job costs about ${formatUsd(e.low_usd)}–${formatUsd(e.high_usd)} (${e.calls} AI calls)`, tone: "dim" }),
          () => answer({ text: "couldn't get an estimate", tone: "red" }),
        );
        return;
      }
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
      case "stop":
        return stop();
      case "queue": {
        if (needLive()) return;
        const answer = later("reading the queue");
        api.queue().then(
          (q) => {
            if (!q.queue.length) return answer({ text: "nothing queued", tone: "dim" });
            answer(...q.queue.map((item, i) => `  ${i + 1}. ${item.job.slice(0, 70)}`), { text: "/unqueue <n> removes one", tone: "dim" });
          },
          () => answer({ text: "couldn't read the queue", tone: "red" }),
        );
        return;
      }
      case "unqueue": {
        if (needLive()) return;
        const n = Number(rest);
        const answer = later("reading the queue");
        api.queue().then(
          (q) => {
            const item = q.queue[n - 1];
            if (!item) return answer({ text: "usage: /unqueue <n> (see /queue)", tone: "red" });
            api.dequeue(item.id).then(
              () => answer({ text: `removed "${item.job.slice(0, 60)}" from the queue`, tone: "dim" }),
              () => answer({ text: "couldn't remove it", tone: "red" }),
            );
          },
          () => answer({ text: "couldn't read the queue", tone: "red" }),
        );
        return;
      }
      case "retry": {
        if (needLive()) return;
        // /retry            the latest session's weak tasks
        // /retry t2,t3      those tasks of the latest session
        // /retry t2 3       task t2 of session 3 (see /sessions)
        const parts = rest.split(/\s+/).filter(Boolean);
        const named = parts.filter((p) => /^t\d+(,t\d+)*$/i.test(p)).flatMap((p) => p.toLowerCase().split(","));
        const number = parts.find((p) => /^\d+$/.test(p));
        const s = sessions[(number ? Number(number) : 1) - 1];
        if (!s) return print({ text: "usage: /retry [t2,t3] [n] (see /sessions; no number = the latest)", tone: "red" });
        const answer = later("loading that session");
        api.session(s.id).then(
          (record) => {
            if (!record.plan?.length) return answer({ text: "that session was saved before retries existed: /rerun runs the whole job again", tone: "yellow" });
            const ids = named.length ? named : weakTasks(record.final?.tasks ?? []);
            if (!ids.length) return answer({ text: "every task met its promise: name one to redo anyway, like /retry t2", tone: "dim" });
            const sent = send!({ type: "retry_task", session_id: s.id, task_ids: ids, ...(running ? { queue: true } : {}) });
            if (!sent) return answer({ text: "couldn't send that: the connection dropped", tone: "red" });
            const titles = ids.map((id) => {
              const task = record.plan!.find((p) => p.task_id === id);
              return task ? `${id.toUpperCase()} (${task.title})` : id.toUpperCase();
            });
            answer({ text: `${running ? "queued: " : ""}redoing ${titles.join(", ")}; the other tasks keep their work, free`, tone: "dim" });
          },
          () => answer({ text: "couldn't load that session", tone: "red" }),
        );
        return;
      }
      case "rerun": case "again": {
        if (needLive()) return;
        const s = sessions[(rest ? Number(rest) : 1) - 1];
        if (!s) return print({ text: "usage: /rerun [n] (see /sessions; no number = the latest)", tone: "red" });
        const answer = later("loading that session");
        api.session(s.id).then(
          (record) => answer(...rerun(record)),
          () => answer({ text: "couldn't load that session", tone: "red" }),
        );
        return;
      }
      case "reset":
        if (needLive()) return;
        send!({ type: "reset" });
        return print({ text: "reputations reset", tone: "dim" });
      case "result": {
        const last = [...state.history].reverse().find((h) => h.final.deliverable);
        if (!last) return print({ text: "no finished file yet", tone: "dim" });
        openResult(resultDoc(last.final, last.jobText, wasStopped(state, last.jobId)));
        return print({ text: `opened ${last.final.filename ?? "result.md"}`, tone: "dim" });
      }
      case "save": {
        const f = [...state.history].reverse().find((h) => h.final.deliverable)?.final;
        if (!f?.deliverable) return print({ text: "no finished file yet", tone: "dim" });
        downloadText(f.filename ?? "result.md", f.deliverable);
        return print({ text: `downloading ${f.filename ?? "result.md"}`, tone: "green" });
      }
      case "sessions":
        if (!sessions.length) return print({ text: "no saved sessions yet", tone: "dim" });
        return print(
          ...sessions.slice(0, 10).map((s, i) => `  ${i + 1}. ${s.job_text.slice(0, 60)}${s.job_text.length > 60 ? "…" : ""}  · $${s.cost_usd.toFixed(4)}${s.mean_grade != null ? ` · ${s.mean_grade}/10` : ""}`),
          { text: "/open <n> shows one · /rerun <n> runs it again · /retry t2 <n> redoes one task", tone: "dim" },
        );
      case "open": {
        const s = sessions[Number(rest) - 1];
        if (!s) return print({ text: "usage: /open <n> (see /sessions)", tone: "red" });
        const answer = later("loading that session");
        api.session(s.id).then(
          (record) => {
            const f = record.final;
            if (!f?.deliverable) return answer({ text: `this session ended without a file (${record.status})`, tone: "dim" });
            openResult(resultDoc(f, record.job_text, Boolean(record.stopped) || record.status === "stopped"));
            answer({ text: `opened ${f.filename ?? "result.md"} from "${record.job_text.slice(0, 60)}"`, tone: "dim" });
          },
          () => answer({ text: "couldn't load that session", tone: "red" }),
        );
        return;
      }
      default:
        return print({ text: `unknown command /${head} (try /help)`, tone: "red" });
    }
  };

  // Scrollback: every event's lines, with your own lines placed after the event they followed.
  // Rebuilt only when the log or your lines change, not on every keystroke.
  const rows = useMemo(() => scrollback(state.log, state.stopped), [state.log, state.stopped, version]);

  return (
    <div ref={dialog} className="rpg-dialog captain-term" role="dialog" aria-label="Captain terminal" onPointerDown={(e) => e.stopPropagation()}>
      <div className="ct-bar">
        <span className="ct-dots"><i /><i /><i /></span>
        <strong>captain@abyss</strong>
        <em className={running ? "busy" : ""}>{running ? "job running" : live ? (state.connected ? "ready" : "connecting…") : "replay"}</em>
        {running && live && (
          <button type="button" className="ct-stop" onClick={stop} title="Stop the job: no new AI calls">
            ■ stop
          </button>
        )}
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div
        className="ct-screen"
        ref={screen}
        onScroll={(e) => (pinned.current = nearBottom(e.currentTarget))}
        onClick={() => window.getSelection()?.isCollapsed && field.current?.focus()}
        aria-live="polite"
      >
        {rows}
      </div>
      <form
        className="ct-prompt"
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim()) (/^\/stop\b/.test(input.trim()) ? sfx.stop : sfx.submit)();
          pinned.current = true; // typing something takes you back to the newest line
          run(input);
          setInput("");
          setHistoryAt(null);
        }}
      >
        <span>you ›</span>
        <input
          ref={field}
          data-autofocus
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

/** Every event's lines, with your own lines placed after the event they followed. */
function scrollback(log: AbyssEvent[], stopped: string[]): ReactNode[] {
  const rows: ReactNode[] = [];
  const localByEvent = new Map<AbyssEvent | null, Local[]>();
  const shownEvents = new Set(log);
  for (const l of term.local) {
    if (l.id < term.clearedAfterId) continue;
    const key = l.after && shownEvents.has(l.after) ? l.after : null;
    localByEvent.set(key, [...(localByEvent.get(key) ?? []), l]);
  }
  const pushLines = (key: string, lines: Line[]) =>
    lines.forEach((line, i) =>
      rows.push(
        <div key={`${key}-${i}`} className={`t-${line.tone}`}>
          {line.text || " "}
          {line.action && (
            <button type="button" className="ct-action" onClick={line.action.run}>
              {line.action.label}
            </button>
          )}
        </div>,
      ),
    );
  const ctx: Context = {
    stopped: new Set(stopped),
    said: new Set(),
    jobText: new Map(log.filter((e) => e.type === "job_split" && e.job_id).map((e) => [e.job_id!, (e.data as { job_text: string }).job_text])),
  };
  localByEvent.get(null)?.forEach((l) => pushLines(`l${l.id}`, l.lines));
  const clearedAt = term.clearedAfterEvent ? log.indexOf(term.clearedAfterEvent) : -1;
  log.forEach((ev, index) => {
    if (index > clearedAt) pushLines(`e${eventKey(ev)}`, describe(ev, ctx));
    localByEvent.get(ev)?.forEach((l) => pushLines(`l${l.id}`, l.lines));
  });
  return rows;
}
