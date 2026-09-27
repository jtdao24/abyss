import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";

import { installAudioUnlock, isMuted, onMarketEvent, onMutedChange, setMuted, sfx } from "./audio/sfx";
import { api, type Prices, type Provider, type SessionSummary, type Usage } from "./api";
import type { ClientMsg } from "./contract";

import { Director } from "./scene/director";
import { TIME_MODES, readTimeMode, saveTimeMode, type TimeMode } from "./scene/daylight";
import { MarketScene } from "./scene/Scene";
import type { InteractId } from "./scene/world";
import { FixtureSource } from "./sources/fixture";
import type { MarketSource } from "./sources/types";
import { WsSource } from "./sources/ws";
import { isReplay, wasStopped, type MarketState } from "./state/reducer";
import { store } from "./state/store";
import { CostCompare } from "./ui/CostCompare";
import { CostPanel } from "./ui/CostPanel";
import { ResultPanel } from "./ui/ResultPanel";
import { openResult, resultDoc } from "./ui/resultView";
import { SpendMeter } from "./ui/SpendMeter";
import { GameDialog } from "./ui/GameDialog";
import { Intro } from "./ui/Intro";
import { Ledger } from "./ui/Ledger";

const params = new URLSearchParams(window.location.search);
const SOURCE = params.get("source") === "fixture" ? "fixture" : "ws"; // live by default; ?source=fixture replays a recording
// Same origin as the page: the backend serves the built site on :8000, and
// `npm run dev` proxies /ws to it.
const WS_URL = import.meta.env.VITE_WS_URL ?? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
const parsedSpeed = Number(params.get("speed") || "1");
const SPEED = SOURCE === "fixture" && Number.isFinite(parsedSpeed) && parsedSpeed > 0 ? parsedSpeed : 1;
// The Tools panel (and its catalog and logos) loads when you first open it.
const McpPanel = lazy(() => import("./ui/McpPanel").then((m) => ({ default: m.McpPanel })));

/** Everyone you can walk up to on the boardwalk, for the keyboard. */
const PEOPLE: [InteractId, string][] = [
  ["main", "Captain"],
  ["tasks", "Tasks"],
  ["vendor:opus", "Vendor 1"],
  ["vendor:sonnet", "Vendor 2"],
  ["vendor:haiku", "Vendor 3"],
  ["reviewer", "Lifeguard"],
];
/** How long after a hello incoming events count as the server's catch-up burst. */
const CATCH_UP_MS = 400;

function createSource(): MarketSource {
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

function SoundIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M2 6h3l4-3v10L5 10H2z" fill="currentColor" />
      {muted ? (
        <path d="M11 6l4 4M15 6l-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      ) : (
        <path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.5a6 6 0 0 1 0 9" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      )}
    </svg>
  );
}

const TIME_LABEL: Record<TimeMode, string> = {
  auto: "Light follows your clock",
  day: "Always day",
  night: "Always night",
};

function TimeIcon({ mode }: { mode: TimeMode }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      {mode === "day" && (
        <>
          <circle cx="8" cy="8" r="3" fill="currentColor" />
          <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </>
      )}
      {mode === "night" && <path d="M10.5 2a6 6 0 1 0 3.5 10A5 5 0 0 1 10.5 2z" fill="currentColor" />}
      {mode === "auto" && (
        <>
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

export default function App() {
  const [state, setState] = useState(store.getState());
  const [dialog, setDialog] = useState<InteractId | null>(null);
  // ?ledger=1 shows the raw call ledger; otherwise the right drawer is the cost dashboard.
  const rawLedger = params.get("ledger") === "1";
  const [showLedger, setShowLedger] = useState(rawLedger || (SOURCE === "ws" && window.innerWidth >= 1280));
  const [showTools, setShowTools] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const [sceneError, setSceneError] = useState<string | null>(null);
  // A refusal meant for you ("a job is already running", a spending limit)
  // shows here when the Captain's terminal isn't open to say it.
  const [notice, setNotice] = useState<string | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [prices, setPrices] = useState<Prices | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [muted, setMutedState] = useState(isMuted());
  const [timeMode, setTimeMode] = useState<TimeMode>(readTimeMode);
  const cycleTime = () => {
    const next = TIME_MODES[(TIME_MODES.indexOf(timeMode) + 1) % TIME_MODES.length];
    setTimeMode(next);
    saveTimeMode(next);
    sceneRef.current?.setTimeMode(next);
  };

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    installAudioUnlock();
    return onMutedChange(setMutedState);
  }, []);

  // Opening a panel zooms the camera onto who you're talking to; closing zooms out.
  const dialogRef = useRef<InteractId | null>(null);
  const openDialog = useCallback((id: InteractId | null) => {
    if (id !== dialogRef.current) (id ? sfx.open : sfx.close)();
    dialogRef.current = id;
    setDialog(id);
    sceneRef.current?.focus(id === "tasks" ? null : id);
  }, []);
  const sourceRef = useRef<MarketSource | null>(null);
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
      scene.setTimeMode(readTimeMode(), true);
      directorRef.current = new Director(created, SPEED);
      if (import.meta.env.DEV) (window as unknown as { __abyss: unknown }).__abyss = { scene: created, store, director: directorRef.current };
      scene.render(store.getState());
      unsubscribe = store.subscribe(() => scene?.render(store.getState()));
      setSceneReady(true);
    }).catch((error: unknown) => {
      if (cancelled) return;
      console.error("The market scene failed to load", error);
      setSceneError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
      unsubscribe();
      directorRef.current?.destroy();
      directorRef.current = null;
      scene?.destroy();
    };
  }, []);

  // A replay waits for the intro to finish so its opening isn't hidden behind it.
  const [introDone, setIntroDone] = useState(false);
  const startSource = SOURCE !== "fixture" || introDone;
  useEffect(() => {
    if (!startSource) return;
    const unsubscribe = store.subscribe(() => setState(store.getState()));
    const source = createSource();
    sourceRef.current = source;
    // Right after a hello the server sends the current (or last) job's events
    // so far. Events we already had are dropped by the reducer; new ones in
    // that burst are caught up quietly (no sounds or fanfares).
    let catchUpUntil = 0;
    source.start((event) => {
      const replay = isReplay(store.getState(), event);
      store.dispatch(event);
      if (event.type === "hello" && SOURCE === "ws") catchUpUntil = performance.now() + CATCH_UP_MS;
      if (replay) return;
      if (event.type === "error" && event.job_id === null && !event.data.fatal && dialogRef.current !== "main") {
        setNotice(event.data.message);
      }
      const quiet = event.type !== "hello" && performance.now() < catchUpUntil;
      directorRef.current?.onEvent(event, quiet);
      if (!quiet) onMarketEvent(event);
    });
    return () => {
      source.stop();
      unsubscribe();
    };
  }, [startSource]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable='true']");
      if (e.key === "Escape") {
        // Esc closes the side panel you're in, else the market's panel.
        const inSide = e.target instanceof HTMLElement && e.target.closest(".cost-panel, .ledger");
        if (inSide) {
          setShowLedger(false);
          setShowTools(false);
        } else openDialog(null);
        return;
      }
      // C opens the Captain from anywhere you aren't typing.
      if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        openDialog("main");
      }
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
  // The newest finished file stays one click away, even while the next job runs.
  const lastFile = [...state.history].reverse().find((h) => h.final.deliverable) ?? null;

  return (
    <main className={`app-shell ${showLedger || showTools ? "" : "ledger-hidden"}`}>
      <section className="stage-shell" aria-label="Abyss boardwalk market">
        <header className="stage-header">
          <div className="brand">
            <strong className="wordmark">ABYSS</strong>
            <span className={`mode-badge ${badge.tone}`}>
              <i aria-hidden="true" />
              {badge.label}
            </span>
          </div>
          <p className="header-hint">Click the Captain on the boat (or press C) to give a job · click anyone to zoom in</p>
          <CostCompare state={state} />
          <div className="header-actions" role="toolbar" aria-label="Panels">
            <button
              type="button"
              className="ledger-toggle captain-toggle"
              aria-pressed={dialog === "main"}
              aria-keyshortcuts="C"
              title="Open the Captain's terminal (C)"
              onClick={() => openDialog(dialog === "main" ? null : "main")}
            >
              Captain
            </button>
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
                Tools
              </button>
            )}
            <button type="button" className="ledger-toggle" aria-pressed={showLedger} onClick={() => { setShowLedger((v) => !v); setShowTools(false); }}>
              {rawLedger ? "Ledger" : "Costs"}
            </button>
            {lastFile && (
              <button
                type="button"
                className="ledger-toggle file-toggle"
                title={`Open ${lastFile.final.filename ?? "the finished file"}`}
                onClick={() => openResult(resultDoc(lastFile.final, lastFile.jobText, wasStopped(state, lastFile.jobId)))}
              >
                File
              </button>
            )}
            <button
              type="button"
              className="ledger-toggle sound-toggle"
              aria-pressed={!muted}
              aria-label={muted ? "Turn sound on" : "Turn sound off"}
              title={muted ? "Sound off" : "Sound on"}
              onClick={() => setMuted(!muted)}
            >
              <SoundIcon muted={muted} />
            </button>
            <button
              type="button"
              className="ledger-toggle sound-toggle"
              aria-label={`${TIME_LABEL[timeMode]} (click to change)`}
              title={TIME_LABEL[timeMode]}
              onClick={cycleTime}
            >
              <TimeIcon mode={timeMode} />
            </button>
          </div>
        </header>
        <div className="stage-fit">
          <div id="stage" ref={stageRef}>
            {/* The market is a picture you click. For the keyboard, the same
                people as buttons, shown when you tab into them. */}
            <nav className="scene-nav" aria-label="People on the boardwalk">
              {PEOPLE.map(([id, label]) => (
                <button key={id} type="button" aria-pressed={dialog === id} onClick={() => openDialog(dialog === id ? null : id)}>
                  {label}
                </button>
              ))}
            </nav>
            {sceneError && (
              <div className="stage-placeholder" role="alert">
                <span>ABYSS MARKET</span>
                <small>THE BOARDWALK DIDN'T LOAD</small>
                <p className="stage-error">{sceneError}</p>
                <button type="button" className="ledger-toggle" onClick={() => window.location.reload()}>
                  Try again
                </button>
              </div>
            )}
            {!sceneError && <Intro ready={sceneReady} onDone={() => setIntroDone(true)} />}
            {notice && (
              <div className="market-notice" role="status">
                <span>{notice}</span>
                <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
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
        </div>
      </section>
      {showTools && !showLedger && (
        <Suspense fallback={<aside className="cost-panel mcp-panel" aria-label="Tools (MCP servers)" aria-busy="true" />}>
          <McpPanel onClose={() => setShowTools(false)} />
        </Suspense>
      )}
      <ResultPanel />
      {showLedger &&
        (rawLedger || SOURCE !== "ws" ? (
          <Ledger state={state} />
        ) : (
          <CostPanel state={state} prices={prices} usage={usage} sessions={sessions} onClose={() => setShowLedger(false)} />
        ))}
    </main>
  );
}
