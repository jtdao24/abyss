import { useEffect, useState } from "react";

import { FixtureSource } from "./sources/fixture";
import type { EventSource } from "./sources/types";
import { store } from "./state/store";
import { DebugPanel } from "./ui/DebugPanel";

function sourceFromLocation(): EventSource {
  const params = new URLSearchParams(window.location.search);
  const file = params.get("file") || "fake_run";
  const parsedSpeed = Number(params.get("speed") || "1");
  const speed = Number.isFinite(parsedSpeed) && parsedSpeed > 0 ? parsedSpeed : 1;
  const source = params.get("source") || "fixture";
  if (source !== "fixture") {
    console.warn(`Unknown source ${source}; using fixture replay.`);
  }
  return new FixtureSource(`/fixtures/${encodeURIComponent(file)}.json`, speed);
}

export default function App() {
  const [state, setState] = useState(store.getState());

  useEffect(() => {
    const unsubscribe = store.subscribe(() => setState(store.getState()));
    const source = sourceFromLocation();
    source.start((event) => store.dispatch(event));
    return () => {
      source.stop();
      unsubscribe();
    };
  }, []);

  return (
    <main className="app-shell">
      <section className="stage-shell" aria-label="Abyss pixel market">
        <div id="stage">
          <div className="stage-placeholder">
            <span>ABYSS MARKET</span>
            <small>PIXEL HARBOR INITIALIZING</small>
          </div>
        </div>
      </section>
      <DebugPanel state={state} />
    </main>
  );
}
