import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { applyCssVars } from "./theme";
import { Results } from "./ui/Results";
import "./styles.css";

applyCssVars();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).get("view") === "results" ? <Results /> : <App />}
  </React.StrictMode>,
);
