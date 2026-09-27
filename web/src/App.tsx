import { useCallback, useEffect, useRef, useState } from "react";

import { api, type Prices, type Provider, type SessionSummary, type Usage } from "./api";
import type { ClientMsg } from "./contract";

import { Director } from "./scene/director";
import { MarketScene } from "./scene/Scene";
import type { InteractId } from "./scene/world";
import { FixtureSource } from "./sources/fixture";
import type { EventSource } from "./sources/types";
import { WsSource } from "./sources/ws";
import type { MarketState } from "./state/reducer";
import { store } from "./state/store";
import { CostCompare } from "./ui/CostCompare";
import { CostPanel } from "./ui/CostPanel";
import { McpPanel } from "./ui/McpPanel";
import { SpendMeter } from "./ui/SpendMeter";
import { GameDialog } from "./ui/GameDialog";
import { Ledger } from "./ui/Ledger";

const params = new URLSearchParams(window.location.search);
const SOURCE = params.get("source") === "fixture" ? "fixture" : "ws"; // live by default; ?source=fixture replays a recording
// Same origin as the page: the backend serves the built site on :8000, and
// `npm run dev` proxies /ws to it.
const WS_URL = import.meta.env.VITE_WS_URL ?? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
const parsedSpeed = Number(params.get("speed") || "1");
const SPEED = SOURCE === "fixture" && Number.isFinite(parsedSpeed) && parsedSpeed > 0 ? parsedSpeed : 1;

function createSource(): EventSource {
  if (SOURCE === "ws") {
    return new WsSource(WS_URL, (connected) => store.setConnected(connected));
  }
  const file = params.get("file") || "fake_run";
  return new FixtureSource(`/fixtures/${encodeURIComponent(file)}.json`, SPEED);
}

/** Which AI the market runs on, read from the stalls' models in `hello`. */
function aiName(state: MarketState): string {
  const models = Object.values(state.agents).map((agent) => agent?.model ?? "");
  if (models.some((m) => m.startsWith("muse"))) return "MUSE";
  if (models.some((m) => m.startsWith("gpt") || /^o\d/.test(m))) return "OPENAI";
  return "";
}

function modeBadge(state: MarketState): { label: string; tone: string } {
  if (SOURCE === "fixture") return { label: "REPLAY", tone: "replay" };
  if (!state.connected) return { label: "OFFLINE", tone: "offline" };
  if (!state.config) return { label: "CONNECTING", tone: "offline" };
  const ai = aiName(state);
  const prefix = ai ? `${ai} · ` : "";
  if (state.config.fake_llm) return { label: `${prefix}FAKE`, tone: "fake" };
  if (!state.config.real_models) return { label: `${prefix}TEST MODE`, tone: "test" };
  return { label: `${prefix}LIVE`, tone: "live" };
}

export default function App() {
  const [state, setState] = useState(store.getState());
  const [dialog, setDialog] = useState<InteractId | null>(null);
  // ?ledger=1 shows the raw call ledger; otherwise the right drawer is the cost dashboard.
  const rawLedger = params.get("ledger") === "1";
  const [showLedger, setShowLedger] = useState(rawLedger || (SOURCE === "ws" && window.innerWidth >= 1280));
  const [showTools, setShowTools] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [prices, setPrices] = useState<Prices | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);

  // Opening a panel zooms the camera onto who you're talking to; closing zooms out.
  const openDialog = useCallback((id: InteractId | null) => {
    setDialog(id);
    sceneRef.current?.focus(id === "tasks" ? null : id);
  }, []);
  const sourceRef = useRef<EventSource | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const directorRef = useRef<Director | null>(null);
  const sceneRef = useRef<MarketScene | null>(null);

  useEffect(() => {
    // StrictMode mounts twice in dev: a cancelled mount destroys its own scene.
    let cancelled = false;
    let scene: MarketScene | null = null;
    let unsubscribe = () => {};
    void MarketScene.create(stageRef.current!).then((created) => {
      if (cancelled) {
        created.destroy();
        return;
      }
      scene = created;
      sceneRef.current = created;
      scene.onInteract = (id) => openDialog(id);
      scene.onGround = () => openDialog(null);
      directorRef.current = new Director(created, SPEED);
      if (import.meta.env.DEV) (window as unknown as { __abyss: unknown }).__abyss = { scene: created, store };
      scene.render(store.getState());
      unsubscribe = store.subscribe(() => scene?.render(store.getState()));
      setSceneReady(true);
    });
    return () => {
      cancelled = true;
      unsubscribe();
      directorRef.current?.destroy();
      directorRef.current = null;
      scene?.destroy();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = store.subscribe(() => setState(store.getState()));
    const source = createSource();
    sourceRef.current = source;
    source.start((event) => {
      store.dispatch(event);
      directorRef.current?.onEvent(event);
    });
    return () => {
      source.stop();
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") openDialog(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openDialog]);


  // What this machine offers (AIs with keys, their models and prices), once connected.
  useEffect(() => {
    if (SOURCE !== "ws" || !state.connected) return;
    api.providers().then(setProviders).catch(() => setProviders([]));
    api.prices().then(setPrices).catch(() => setPrices(null));
  }, [state.connected]);

  // Saved sessions and all-time usage: on load, when a session starts, and when one ends.
  const jobId = state.currentJob?.jobId ?? null;
  useEffect(() => {
    if (SOURCE !== "ws") return;
    api.sessions().then(setSessions).catch(() => undefined);
    api.usage().then(setUsage).catch(() => undefined);
  }, [state.connected, jobId, state.history.length]);

  const send = SOURCE === "ws" ? (message: ClientMsg) => sourceRef.current?.send?.(message) ?? false : undefined;
  const badge = modeBadge(state);

  return (
    <main className={`app-shell ${showLedger || showTools ? "" : "ledger-hidden"}`}>
      <section className="stage-shell" aria-label="Abyss boardwalk market">
        <header className="stage-header">
          <div className="title">
            <strong>ABYSS</strong>
            <small>Click the Captain on the boat to open the terminal and type a job (python start.py --chat works too). Click anyone to zoom in.</small>
          </div>
          <div className="header-actions">
            {SOURCE === "ws" && (
              <button
                type="button"
                className="ledger-toggle"
                aria-pressed={showTools}
                onClick={() => {
                  setShowTools((v) => !v);
                  setShowLedger(false);
                }}
              >
                {showTools ? "Hide tools" : "Tools"}
              </button>
            )}
            <CostCompare state={state} />
            <button type="button" className="ledger-toggle" aria-pressed={showLedger} onClick={() => { setShowLedger((v) => !v); setShowTools(false); }}>
              {showLedger ? (rawLedger ? "Hide ledger" : "Hide costs") : rawLedger ? "Show ledger" : "Costs"}
            </button>
            <span className={`mode-badge ${badge.tone}`}>{badge.label}</span>
          </div>
        </header>
        <div id="stage" ref={stageRef}>
          {!sceneReady && (
            <div className="stage-placeholder">
              <span>ABYSS MARKET</span>
              <small>SETTING UP THE BOARDWALK</small>
            </div>
          )}
          {dialog && (
            <GameDialog
              key={dialog}
              id={dialog}
              state={state}
              onClose={() => openDialog(null)}
              send={send}
              providers={providers}
              sessions={sessions}
            />
          )}
          {SOURCE === "ws" && <SpendMeter refreshKey={`${jobId}-${state.history.length}`} />}
        </div>
      </section>
      {showTools && !showLedger && <McpPanel onClose={() => setShowTools(false)} />}
      {showLedger &&
        (rawLedger || SOURCE !== "ws" ? (
          <Ledger state={state} />
        ) : (
          <CostPanel state={state} prices={prices} usage={usage} sessions={sessions} onClose={() => setShowLedger(false)} />
        ))}
    </main>
  );
}
