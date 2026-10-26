// Typed bridge to the Rust backend. Outside the Tauri shell (plain `vite dev`)
// every call rejects with BackendUnavailable — the UI shows that state instead
// of substituting fake data.

import type {
  AppStatus,
  EngineConfig,
  EngineSnapshot,
  JobDetail,
  JobRecord,
  ProcessList,
  Sample,
  ScanSummary,
  SeriesPoint,
  SubmitRequest,
} from "./types";
import type {
  Capabilities,
  ExportFormat,
  Redact,
  SessionRecord,
  SessionView,
  Summary,
  TelemetryPoint,
  TraceConfig,
  TraceEvent,
} from "./trace/types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export class BackendUnavailable extends Error {
  constructor() {
    super("FlowDesk backend unavailable — running outside the desktop shell");
  }
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) throw new BackendUnavailable();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function listen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => cb(e.payload));
}

export const api = {
  appStatus: () => call<AppStatus>("app_status"),
  telemetryHistory: () => call<Sample[]>("telemetry_history"),
  setTelemetryInterval: (ms: number) => call<number>("set_telemetry_interval", { ms }),
  listProcesses: () => call<ProcessList>("list_processes"),
  scanFolder: (path: string) => call<ScanSummary>("scan_folder", { path }),
  engineState: () => call<EngineSnapshot>("engine_state"),
  engineSetConfig: (config: EngineConfig) => call<EngineConfig>("engine_set_config", { config }),
  submitJob: (req: SubmitRequest) => call<number>("submit_job", { req }),
  pauseJob: (id: number) => call<void>("pause_job", { id }),
  resumeJob: (id: number) => call<void>("resume_job", { id }),
  cancelJob: (id: number) => call<void>("cancel_job", { id }),
  listJobs: (limit?: number) => call<JobRecord[]>("list_jobs", { limit }),
  jobDetail: (id: number) => call<JobDetail>("job_detail", { id }),
  jobSeries: (id: number) => call<SeriesPoint[]>("job_series", { id }),
  deleteJob: (id: number) => call<void>("delete_job", { id }),
  clearHistory: () => call<number>("clear_history"),
  exportJobsCsv: (ids: number[], path: string) => call<number>("export_jobs_csv", { ids, path }),
  getPreferences: () => call<[string, string][]>("get_preferences"),
  setPreference: (key: string, value: string) => call<void>("set_preference", { key, value }),
  openPath: (path: string, reveal = false) => call<void>("open_path", { path, reveal }),

  traceCapabilities: () => call<Capabilities>("trace_capabilities"),
  traceStart: (config: TraceConfig) => call<SessionView>("trace_start", { config }),
  traceStop: (id: number) => call<void>("trace_stop", { id }),
  traceCancel: (id: number) => call<void>("trace_cancel", { id }),
  traceCurrent: () => call<SessionView | null>("trace_current"),
  traceSessions: (limit?: number) => call<SessionRecord[]>("trace_sessions", { limit }),
  traceSession: (id: number) => call<SessionRecord>("trace_session", { id }),
  traceEvents: (id: number, afterSeq: number, limit: number) => call<TraceEvent[]>("trace_events", { id, afterSeq, limit }),
  traceTelemetry: (id: number) => call<TelemetryPoint[]>("trace_telemetry", { id }),
  traceSummary: (id: number) => call<Summary>("trace_summary", { id }),
  traceDelete: (id: number) => call<number>("trace_delete", { id }),
  traceExport: (id: number, format: ExportFormat, path: string, redact: Redact) => call<number>("trace_export", { id, format, path, redact }),
};

/** Native folder picker (Tauri dialog plugin). Returns null when cancelled. */
export async function pickFolder(title: string): Promise<string | null> {
  if (!isTauri) throw new BackendUnavailable();
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ directory: true, multiple: false, title });
  return typeof r === "string" ? r : null;
}

export async function pickSavePath(defaultPath: string, filter = { name: "CSV", extensions: ["csv"] }): Promise<string | null> {
  if (!isTauri) throw new BackendUnavailable();
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath, filters: [filter] });
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
