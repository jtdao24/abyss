import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { applyCssVars } from "./theme";
import "./styles.css";

// The experiment results page (?view=results) is rarely opened: load it on demand.
const Results = lazy(() => import("./ui/Results").then((m) => ({ default: m.Results })));

applyCssVars();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).get("view") === "results" ? (
      <Suspense fallback={null}>
        <Results />
      </Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
