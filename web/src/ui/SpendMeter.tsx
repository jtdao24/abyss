import { useEffect, useRef, useState } from "react";
import { sfx } from "../audio/sfx";
import { api, type LimitPeriod, type LimitsStatus } from "../api";

const SHORT: Record<LimitPeriod["period"], string> = { day: "Today", week: "Week", month: "Month" };
const money = (v: number) => (v < 10 ? `$${v.toFixed(2)}` : `$${v.toFixed(0)}`);

/** The tightest limit (highest share used), else today's spend. */
function headline(status: LimitsStatus): LimitPeriod {
  const limited = status.periods.filter((p) => p.limit !== null);
  if (!limited.length) return status.periods[0];
  return limited.reduce((a, b) => ((b.pct ?? 0) > (a.pct ?? 0) ? b : a));
}

/** Bottom-right corner: spend against the limits; click to set them. */
export function SpendMeter({ refreshKey }: { refreshKey: unknown }) {
  const [status, setStatus] = useState<LimitsStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => api.limits().then(setStatus).catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [refreshKey]);

  // Alarm once when spending crosses a limit (not on load if already over).
  const wasOver = useRef<boolean | null>(null);
  useEffect(() => {
    if (!status) return;
    const over = headline(status).state === "over";
    if (over && wasOver.current === false) sfx.alarm();
    wasOver.current = over;
  }, [status]);

  if (!status) return null;
  const top = headline(status);
  const tone = top.state === "over" ? "over" : top.state === "warn" ? "warn" : "";

  const openEditor = () => {
    setDraft(Object.fromEntries(status.periods.map((p) => [p.period, p.limit === null ? "" : String(p.limit)])));
    setError(null);
    setOpen((v) => !v);
  };
  const save = async () => {
    const body: Record<string, number | null> = {};
    for (const p of status.periods) {
      const raw = (draft[p.period] ?? "").trim();
      body[p.period] = raw ? Number(raw) : null;
    }
    try {
      setStatus(await api.setLimits(body));
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't save");
    }
  };

  return (
    <div className="spend-meter">
      {open && (
        <form
          className="spend-pop"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <strong>Spending limits</strong>
          {status.periods.map((p) => (
            <label key={p.period}>
              <span>{SHORT[p.period]}</span>
              <small>{money(p.spent)} spent</small>
              <input
                inputMode="decimal"
                placeholder="no limit"
                value={draft[p.period] ?? ""}
                onChange={(e) => setDraft({ ...draft, [p.period]: e.target.value.replace(/[^0-9.]/g, "") })}
              />
            </label>
          ))}
          {error && <p className="form-error">{error}</p>}
          <p className="spend-hint">Warns at 80%. At 100% new sessions stop.</p>
          <button type="submit">Save</button>
        </form>
      )}
      <button
        type="button"
        className={`spend-pill ${tone}`}
        onClick={openEditor}
        aria-expanded={open}
        title={status.message ?? "Spending limits"}
      >
        <span>
          {SHORT[top.period]} {money(top.spent)}
          {top.limit !== null && <em> / {money(top.limit)}</em>}
        </span>
        {top.limit !== null && (
          <i className="spend-bar">
            <b style={{ width: `${Math.min(100, (top.pct ?? 0) * 100)}%` }} />
          </i>
        )}
      </button>
    </div>
  );
}
