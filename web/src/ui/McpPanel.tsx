import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type McpCatalogEntry, type McpOverview, type McpServer } from "../api";
import type { AgentId } from "../contract";
import { VENDOR } from "../scene/model";

const STATE_LABEL: Record<string, string> = {
  ready: "Connected",
  starting: "Starting…",
  failed: "Failed",
  disabled: "Off",
  needs_keys: "Needs keys",
  stopped: "Restarting…",
};

function useMcp(): [McpOverview | null, string | null, (run: () => Promise<McpOverview>) => Promise<boolean>, boolean] {
  const [view, setView] = useState<McpOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (call: () => Promise<McpOverview>) => {
    setBusy(true);
    setError(null);
    try {
      setView(await call());
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "that didn't work");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void run(api.mcp);
    // Servers start in the background and tool calls stream in: keep it fresh.
    const timer = window.setInterval(() => api.mcp().then(setView).catch(() => undefined), 4000);
    return () => window.clearInterval(timer);
  }, [run]);
  return [view, error, run, busy];
}

/** A key field: blank means "keep what's saved". */
function KeyInputs({
  keys,
  values,
  onChange,
}: {
  keys: { var: string; label?: string; url?: string; set: boolean }[];
  values: Record<string, string>;
  onChange(values: Record<string, string>): void;
}) {
  return (
    <>
      {keys.map((k) => (
        <label key={k.var} className="mcp-field">
          <span>
            {k.label ?? k.var}
            {k.url && (
              <a href={k.url} target="_blank" rel="noreferrer">
                get one ↗
              </a>
            )}
          </span>
          <input
            type="password"
            autoComplete="off"
            value={values[k.var] ?? ""}
            placeholder={k.set ? "saved (leave blank to keep)" : k.var}
            onChange={(e) => onChange({ ...values, [k.var]: e.target.value })}
          />
        </label>
      ))}
    </>
  );
}

function ServerCard({ server, run, busy }: { server: McpServer; run: ReturnType<typeof useMcp>[2]; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const off = server.state === "disabled";
  const allowed = (tool: string) => server.allow === null || server.allow.includes(tool);
  const toggleTool = (tool: string) => {
    const all = server.tools.map((t) => t.name);
    const current = server.allow ?? all;
    const next = current.includes(tool) ? current.filter((t) => t !== tool) : [...current, tool];
    void run(() => api.mcpUpdate(server.name, { allow: next.length === all.length ? null : next }));
  };
  return (
    <li className={`mcp-server ${server.state}`}>
      <button type="button" className="mcp-server-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <i className="mcp-dot" />
        <strong>{server.label}</strong>
        {server.label !== server.name && <small>{server.name}</small>}
        <em>
          {STATE_LABEL[server.state] ?? server.state}
          {server.state === "ready" && ` · ${server.tools.filter((t) => allowed(t.name)).length} tools`}
        </em>
      </button>
      {open && (
        <div className="mcp-server-body">
          <code className="mcp-target">{server.target}</code>
          {server.error && <p className="form-error">{server.error}</p>}
          {server.keys.length > 0 && (
            <form
              className="mcp-keys"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => api.mcpUpdate(server.name, { secrets: keys })).then((ok) => ok && setKeys({}));
              }}
            >
              <KeyInputs keys={server.keys} values={keys} onChange={setKeys} />
              <button type="submit" className="chip" disabled={busy || !Object.values(keys).some((v) => v.trim())}>
                Save keys
              </button>
            </form>
          )}
          {server.tools.length > 0 && (
            <ul className="mcp-tools">
              {server.tools.map((t) => (
                <li key={t.name}>
                  <label title={t.description}>
                    <input type="checkbox" checked={allowed(t.name)} disabled={busy} onChange={() => toggleTool(t.name)} />
                    <b>{t.name}</b>
                    <span>{t.description}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="mcp-actions">
            <button type="button" className="chip" disabled={busy} onClick={() => void run(() => api.mcpUpdate(server.name, { disabled: !off }))}>
              {off ? "Turn on" : "Turn off"}
            </button>
            <button
              type="button"
              className="chip danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Remove ${server.label}?`)) void run(() => api.mcpRemove(server.name));
              }}
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function CatalogCard({
  entry,
  runtimes,
  run,
  busy,
}: {
  entry: McpCatalogEntry;
  runtimes: McpOverview["runtimes"];
  run: ReturnType<typeof useMcp>[2];
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [params, setParams] = useState<Record<string, string>>({});
  const [keys, setKeys] = useState<Record<string, string>>({});
  const missingRuntime = entry.runtime !== null && !runtimes[entry.runtime];
  const needsForm = entry.params.length > 0 || entry.secrets.some((s) => !s.set);
  const add = () => void run(() => api.mcpAdd({ catalog_id: entry.id, params, secrets: keys }));
  return (
    <li className={`mcp-catalog-card ${entry.added ? "added" : ""}`}>
      <div className="mcp-catalog-top">
        <strong>{entry.label}</strong>
        <small>{entry.category}</small>
      </div>
      <p>{entry.description}</p>
      {missingRuntime && (
        <p className="rpg-hint">
          Needs {entry.runtime === "npx" ? <a href="https://nodejs.org" target="_blank" rel="noreferrer">Node.js</a> : <a href="https://docs.astral.sh/uv/" target="_blank" rel="noreferrer">uv</a>} on this computer.
        </p>
      )}
      {entry.added ? (
        <em className="mcp-added">Added ✓</em>
      ) : open ? (
        <form
          className="mcp-keys"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          {entry.params.map((p) => (
            <label key={p.key} className="mcp-field">
              <span>{p.label}</span>
              <input value={params[p.key] ?? ""} placeholder={p.placeholder} onChange={(e) => setParams({ ...params, [p.key]: e.target.value })} />
            </label>
          ))}
          <KeyInputs keys={entry.secrets} values={keys} onChange={setKeys} />
          <p className="rpg-hint">Keys are saved to backend/.env on this computer only.</p>
          <button type="submit" className="chip" disabled={busy}>
            Add {entry.label}
          </button>
        </form>
      ) : (
        <button type="button" className="chip" disabled={busy} onClick={() => (needsForm ? setOpen(true) : add())}>
          + Add
        </button>
      )}
    </li>
  );
}

function CustomServerForm({ run, busy }: { run: ReturnType<typeof useMcp>[2]; busy: boolean }) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [envText, setEnvText] = useState("");
  const remote = /^https?:\/\//.test(target.trim());
  const submit = () => {
    // KEY=value lines: values go to .env, the config keeps ${KEY}.
    const secrets: Record<string, string> = {};
    const refs: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const at = line.indexOf("=");
      if (at < 1) continue;
      const key = line.slice(0, at).trim();
      secrets[key] = line.slice(at + 1).trim();
      refs[key] = `\${${key}}`;
    }
    const custom = remote
      ? { url: target.trim(), headers: refs.AUTHORIZATION ? { Authorization: `Bearer ${refs.AUTHORIZATION}` } : undefined }
      : (() => {
          const parts = target.trim().match(/"[^"]*"|\S+/g)?.map((p) => p.replace(/^"|"$/g, "")) ?? [];
          return { command: parts[0], args: parts.slice(1), env: Object.keys(refs).length ? refs : undefined };
        })();
    void run(() => api.mcpAdd({ name: name.trim(), custom, secrets })).then((ok) => {
      if (ok) {
        setName("");
        setTarget("");
        setEnvText("");
      }
    });
  };
  return (
    <form
      className="mcp-keys mcp-custom"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="mcp-field">
        <span>Name</span>
        <input value={name} placeholder="my-server" onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="mcp-field">
        <span>Command or URL</span>
        <input value={target} placeholder="npx -y some-mcp-server   or   https://example.com/mcp" onChange={(e) => setTarget(e.target.value)} />
      </label>
      <label className="mcp-field">
        <span>{remote ? "Keys (AUTHORIZATION=token is sent as a Bearer header)" : "Keys (KEY=value, one per line)"}</span>
        <textarea rows={2} value={envText} placeholder="API_KEY=…" onChange={(e) => setEnvText(e.target.value)} />
      </label>
      <button type="submit" className="chip" disabled={busy || !name.trim() || !target.trim()}>
        Add server
      </button>
    </form>
  );
}

export function McpPanel({ onClose }: { onClose(): void }) {
  const [view, error, run, busy] = useMcp();
  const [category, setCategory] = useState("All");
  const [query, setQuery] = useState("");
  const categories = useMemo(() => ["All", ...new Set((view?.catalog ?? []).map((c) => c.category))], [view?.catalog]);
  const catalog = (view?.catalog ?? []).filter(
    (c) =>
      (category === "All" || c.category === category) &&
      (!query || `${c.label} ${c.description}`.toLowerCase().includes(query.toLowerCase())),
  );
  const ready = view?.servers.filter((s) => s.state === "ready") ?? [];
  const toolCount = ready.reduce((n, s) => n + s.tools.length, 0);

  return (
    <aside className="cost-panel mcp-panel" aria-label="Tools (MCP servers)">
      <header className="cost-head">
        <strong>Tools · MCP</strong>
        <button type="button" onClick={onClose} aria-label="Hide tools">×</button>
      </header>

      <section className="cost-card">
        <h3>Connected</h3>
        {!view ? (
          <p className="cost-note">Loading…</p>
        ) : (
          <>
            <p className="cost-note">
              {ready.length} server{ready.length === 1 ? "" : "s"} · {toolCount} tools the vendors can call while they work.
            </p>
            {view.config_error && <p className="form-error">{view.config_file}: {view.config_error}</p>}
            {view.pending_reload && <p className="rpg-hint">Changes apply when the current session ends.</p>}
            {view.servers.length === 0 ? (
              <p className="cost-note">No servers yet. Add one below.</p>
            ) : (
              <ul className="mcp-servers">
                {view.servers.map((s) => (
                  <ServerCard key={s.name} server={s} run={run} busy={busy} />
                ))}
              </ul>
            )}
            <div className="mcp-actions">
              <button type="button" className="chip" disabled={busy} onClick={() => void run(api.mcpReload)}>
                Restart all
              </button>
            </div>
          </>
        )}
        {error && <p className="form-error">{error}</p>}
      </section>

      {view && view.activity.length > 0 && (
        <section className="cost-card">
          <h3>Recent tool calls</h3>
          <ul className="mcp-activity">
            {view.activity.map((a, i) => (
              <li key={`${a.t}-${i}`} className={a.ok ? "" : "bad"} title={`${a.args}\n→ ${a.result}`}>
                {a.agent_id && a.agent_id in VENDOR && (
                  <span className="stall-dot" style={{ background: VENDOR[a.agent_id as AgentId].color }} />
                )}
                <b>{a.server}</b>.{a.tool}
                <span>{a.ok ? `${a.ms} ms` : "error"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view && (
        <section className="cost-card">
          <h3>Add tools</h3>
          {(!view.runtimes.npx || !view.runtimes.uvx) && (
            <p className="rpg-hint">
              {!view.runtimes.npx && "Node.js (npx) isn't installed, so npx servers won't start. "}
              {!view.runtimes.uvx && "uv (uvx) isn't installed, so Python servers won't start."}
            </p>
          )}
          <input className="link-input mcp-search" value={query} placeholder="Search tools…" onChange={(e) => setQuery(e.target.value)} />
          <div className="template-row">
            {categories.map((c) => (
              <button key={c} type="button" className={`chip ${c === category ? "on" : ""}`} onClick={() => setCategory(c)}>
                {c}
              </button>
            ))}
          </div>
          <ul className="mcp-catalog">
            {catalog.map((entry) => (
              <CatalogCard key={entry.id} entry={entry} runtimes={view.runtimes} run={run} busy={busy} />
            ))}
          </ul>
          <details className="mcp-custom-wrap">
            <summary>Any other MCP server…</summary>
            <CustomServerForm run={run} busy={busy} />
          </details>
        </section>
      )}
    </aside>
  );
}
