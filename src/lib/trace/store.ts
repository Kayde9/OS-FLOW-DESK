// Trace client: capabilities, the backend's current session (`trace://state`),
// live event batches (`trace://batch`) and reopened saved sessions.
// Events live in a module-level window (mutated in place, `version` bumps)
// so 100k-event sessions do not re-copy arrays on every batch.

import { api, errorText, isTauri, listen } from "../backend";
import { createStore, useStore } from "../store";
import type { Op } from "../types";
import { emptyFilter, type EventFilter, type SortKey } from "./analysis";
import type { Capabilities, Completion, SessionRecord, SessionView, TelemetryPoint, TraceConfig, TraceEvent } from "./types";
import { appendWindow, applyCompletions, newWindow } from "./window";

export const LIVE_CAP = 100_000;
const LOAD_CAP = 200_000;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export interface Viewing {
  kind: "live" | "saved";
  sessionId: number | null;
  record: SessionRecord | null;
  telemetry: TelemetryPoint[] | null;
}

interface TraceState {
  caps: Capabilities | null;
  capsError: string | null;
  live: SessionView | null;
  viewing: Viewing;
  version: number;
  loading: boolean;
  loadNote: string | null;
  renderPaused: boolean;
  held: number;
  /** Captured events per second, from successive backend counter readings. */
  rate: number | null;
  error: string | null;
  sessionsVersion: number;
}

export const win = newWindow();
let heldBatches: { events: TraceEvent[]; completions: Completion[] }[] = [];
let heldCount = 0;
const rateRing: [number, number][] = [];

export const trace = createStore<TraceState>({
  caps: null,
  capsError: null,
  live: null,
  viewing: { kind: "live", sessionId: null, record: null, telemetry: null },
  version: 0,
  loading: false,
  loadNote: null,
  renderPaused: false,
  held: 0,
  rate: null,
  error: null,
  sessionsVersion: 0,
});

function resetWindow() {
  win.events.length = 0;
  win.bySeq.clear();
  win.dropped = 0;
  heldBatches = [];
  heldCount = 0;
  rateRing.length = 0;
}

function ingest(events: TraceEvent[], completions: Completion[]) {
  appendWindow(win, events, LIVE_CAP);
  applyCompletions(win, completions);
}

function acceptState(v: SessionView) {
  trace.set((s) => {
    const prev = s.live;
    const isNew = !prev || prev.id !== v.id;
    let viewing = s.viewing;
    if (isNew && s.viewing.kind === "live") {
      resetWindow();
      viewing = { kind: "live", sessionId: v.id, record: null, telemetry: null };
    }
    const finished = TERMINAL.has(v.state) && (!prev || prev.id !== v.id || !TERMINAL.has(prev.state));
    // Event rate from the backend's captured counter (not from rendering).
    let rate = isNew ? null : s.rate;
    if (v.state === "capturing") {
      const now = performance.now();
      rateRing.push([now, v.stats.captured]);
      while (rateRing.length > 2 && now - rateRing[0][0] > 2500) rateRing.shift();
      const [t0, c0] = rateRing[0];
      if (now - t0 > 400) rate = ((v.stats.captured - c0) * 1000) / (now - t0);
    } else if (TERMINAL.has(v.state)) rate = null;
    return { ...s, live: v, viewing, rate, sessionsVersion: s.sessionsVersion + (finished ? 1 : 0), version: s.version + (isNew ? 1 : 0) };
  });
}

let started = false;
export async function startTrace() {
  if (started || !isTauri) return;
  started = true;
  try {
    const [caps, cur] = await Promise.all([api.traceCapabilities(), api.traceCurrent()]);
    trace.set((s) => ({ ...s, caps }));
    // Without administrator rights ETW sessions are denied: default to FlowDesk events only.
    if (!caps.elevated) setup.set((x) => ({ ...x, providers: [] }));
    if (cur) acceptState(cur);
    await listen<SessionView>("trace://state", acceptState);
    await listen<{ sessionId: number; events: TraceEvent[]; completions: Completion[] }>("trace://batch", (b) => {
      const s = trace.get();
      if (s.viewing.kind !== "live" || s.live?.id !== b.sessionId) return;
      if (s.renderPaused) {
        if (heldCount < LIVE_CAP) {
          heldBatches.push({ events: b.events, completions: b.completions });
          heldCount += b.events.length;
        }
        trace.set((p) => ({ ...p, held: heldCount }));
        return;
      }
      ingest(b.events, b.completions);
      trace.set((p) => ({ ...p, version: p.version + 1 }));
    });
  } catch (e) {
    trace.set((s) => ({ ...s, capsError: errorText(e) }));
  }
}

export async function refreshCaps() {
  try {
    const caps = await api.traceCapabilities();
    trace.set((s) => ({ ...s, caps }));
  } catch (e) {
    trace.set((s) => ({ ...s, capsError: errorText(e) }));
  }
}

export async function startCapture(cfg: TraceConfig): Promise<SessionView | null> {
  trace.set((s) => ({ ...s, error: null }));
  try {
    resetWindow();
    trace.set((s) => ({ ...s, viewing: { kind: "live", sessionId: null, record: null, telemetry: null }, renderPaused: false, held: 0, version: s.version + 1 }));
    const v = await api.traceStart(cfg);
    acceptState(v);
    return v;
  } catch (e) {
    trace.set((s) => ({ ...s, error: errorText(e) }));
    return null;
  }
}

export async function stopCapture(cancel = false) {
  const id = trace.get().live?.id;
  if (id == null) return;
  try {
    await (cancel ? api.traceCancel(id) : api.traceStop(id));
  } catch (e) {
    trace.set((s) => ({ ...s, error: errorText(e) }));
  }
}

export function setRenderPaused(paused: boolean) {
  if (!paused) {
    for (const b of heldBatches) ingest(b.events, b.completions);
    heldBatches = [];
    heldCount = 0;
  }
  trace.set((s) => ({ ...s, renderPaused: paused, held: 0, version: s.version + 1 }));
}

/** Loads a saved session (events in seq order, up to LOAD_CAP) for inspection. */
export async function openSession(id: number) {
  resetWindow();
  trace.set((s) => ({ ...s, loading: true, loadNote: null, error: null, viewing: { kind: "saved", sessionId: id, record: null, telemetry: null }, version: s.version + 1 }));
  try {
    const [record, telemetry] = await Promise.all([api.traceSession(id), api.traceTelemetry(id)]);
    let after = 0;
    for (;;) {
      const page = await api.traceEvents(id, after, 20_000);
      if (!page.length) break;
      appendWindow(win, page, LOAD_CAP);
      after = page[page.length - 1].seq;
      if (trace.get().viewing.sessionId !== id) return;
      if (win.events.length >= LOAD_CAP) break;
    }
    const note = record.events > win.events.length ? `Showing the first ${win.events.length.toLocaleString()} of ${record.events.toLocaleString()} stored events.` : null;
    trace.set((s) => (s.viewing.sessionId === id ? { ...s, loading: false, loadNote: note, viewing: { kind: "saved", sessionId: id, record, telemetry }, version: s.version + 1 } : s));
  } catch (e) {
    trace.set((s) => ({ ...s, loading: false, error: errorText(e) }));
  }
}

export function viewLive() {
  resetWindow();
  const live = trace.get().live;
  trace.set((s) => ({ ...s, viewing: { kind: "live", sessionId: live?.id ?? null, record: null, telemetry: null }, loadNote: null, version: s.version + 1 }));
  // A finished live session is reloaded from SQLite so nothing is missing.
  if (live && TERMINAL.has(live.state)) void openSession(live.id);
}

export const useTrace = () => useStore(trace);
export const useTraceVersion = () => useStore(trace, (s) => s.version);
export const useCaptureState = () => useStore(trace, (s) => s.live?.state ?? null);

// ------------------------------------------------------------ capture setup

export interface Setup {
  mode: "workload" | "process";
  op: Op;
  procPid: number | null;
  procName: string | null;
  providers: string[];
  fileCompletions: boolean;
  fileMetadata: boolean;
  maxDurationS: number;
  maxEvents: number;
  bufferKb: number;
  maxBuffers: number;
  stopWithWorkload: boolean;
  excludeTracerIo: boolean;
  pathFilter: string;
  priority: number;
}

export const setup = createStore<Setup>({
  mode: "workload",
  op: "hash",
  procPid: null,
  procName: null,
  providers: ["file", "process"],
  fileCompletions: true,
  fileMetadata: false,
  maxDurationS: 120,
  maxEvents: 250_000,
  bufferKb: 256,
  maxBuffers: 64,
  stopWithWorkload: true,
  excludeTracerIo: true,
  pathFilter: "",
  priority: 5,
});
export const useSetup = () => useStore(setup);

export function buildConfig(s: Setup, folder: string | null): TraceConfig | string {
  const base = {
    name: null,
    providers: s.providers,
    fileCompletions: s.fileCompletions,
    fileMetadata: s.fileMetadata,
    maxDurationS: s.maxDurationS,
    maxEvents: s.maxEvents,
    bufferKb: s.bufferKb,
    maxBuffers: s.maxBuffers,
    stopWithWorkload: s.stopWithWorkload,
    excludeTracerIo: s.excludeTracerIo,
    pathFilter: s.pathFilter.trim() || null,
  };
  if (s.mode === "workload") {
    if (!folder) return "Select a folder for the workload first";
    return { ...base, target: { kind: "workload", job: { name: "", op: s.op, folder, dest: null, priority: s.priority } } };
  }
  if (s.procPid == null) return "Select a process to trace";
  if (!s.providers.length) return "Tracing another process needs at least one ETW provider";
  return { ...base, target: { kind: "process", pid: s.procPid, name: s.procName } };
}

// ------------------------------------------------------------ view state (survives tab switches)

export interface TraceUi {
  selected: number | null;
  pinned: number[];
  filter: EventFilter;
  sort: { key: SortKey; dir: 1 | -1 };
  /** Timeline window in µs; null = fit to data. */
  window: [number, number] | null;
  follow: boolean;
}

export const ui = createStore<TraceUi>({ selected: null, pinned: [], filter: emptyFilter(), sort: { key: "time", dir: 1 }, window: null, follow: true });
export const useUi = () => useStore(ui);
