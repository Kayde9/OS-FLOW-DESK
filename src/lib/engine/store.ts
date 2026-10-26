// Job engine client: snapshot bootstrap + `engine://state` events, plus the
// shared Workspace folder selection used by both Workspace and the Overview pipeline.

import { api, isTauri, listen, errorText, pickFolder } from "../backend";
import { createStore, useStore } from "../store";
import type { EngineSnapshot, ScanSummary } from "../types";

interface EngineState {
  snap: EngineSnapshot | null;
  error: string | null;
  /** Increments whenever a task reaches a terminal state — history views refetch on change. */
  finishedVersion: number;
}

export const engine = createStore<EngineState>({ snap: null, error: null, finishedVersion: 0 });

const TERMINAL = new Set(["completed", "cancelled", "failed"]);
let started = false;

function accept(snap: EngineSnapshot) {
  engine.set((s) => {
    const before = new Map(s.snap?.jobs.map((j) => [j.id, j.status]) ?? []);
    const newlyFinished = snap.jobs.some((j) => TERMINAL.has(j.status) && !TERMINAL.has(before.get(j.id) ?? ""));
    return { snap, error: null, finishedVersion: s.finishedVersion + (newlyFinished ? 1 : 0) };
  });
}

export async function startEngine() {
  if (started || !isTauri) return;
  started = true;
  try {
    accept(await api.engineState());
    await listen<EngineSnapshot>("engine://state", accept);
  } catch (e) {
    engine.set((s) => ({ ...s, error: errorText(e) }));
  }
}

export const useEngine = () => useStore(engine, (s) => s.snap);
export const useEngineError = () => useStore(engine, (s) => s.error);
export const useFinishedVersion = () => useStore(engine, (s) => s.finishedVersion);

// ---------------------------------------------------------------- selection

interface Selection {
  folder: string | null;
  scan: ScanSummary | null;
  scanning: boolean;
  error: string | null;
}

export const selection = createStore<Selection>({ folder: null, scan: null, scanning: false, error: null });
export const useSelection = () => useStore(selection);

export async function scanSelected(folder: string) {
  selection.set({ folder, scan: null, scanning: true, error: null });
  try {
    const scan = await api.scanFolder(folder);
    selection.set((s) => (s.folder === folder ? { ...s, scan, scanning: false } : s));
  } catch (e) {
    selection.set((s) => (s.folder === folder ? { ...s, scanning: false, error: errorText(e) } : s));
  }
}

export async function browseFolder() {
  try {
    const folder = await pickFolder("Select a folder for FlowDesk to process");
    if (folder) await scanSelected(folder);
  } catch (e) {
    selection.set((s) => ({ ...s, error: errorText(e) }));
  }
}
