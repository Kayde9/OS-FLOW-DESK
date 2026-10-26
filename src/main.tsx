import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import "./styles/index.css";
import { startTelemetry } from "./lib/telemetry/store";
import { startEngine } from "./lib/engine/store";
import { loadPrefs } from "./lib/prefs";
import { startTrace } from "./lib/trace/store";

void loadPrefs();
void startTelemetry();
void startEngine();
// Subscribes to trace events only; never starts a capture by itself.
void startTrace();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
