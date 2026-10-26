// UI preferences persisted in SQLite (falls back to defaults when the backend is unavailable).

import { api, isTauri } from "./backend";
import { createStore, useStore } from "./store";

export interface UiPrefs {
  reducedMotion: boolean;
  defaultRangeMs: number;
}

const DEFAULTS: UiPrefs = { reducedMotion: false, defaultRangeMs: 300_000 };
export const prefs = createStore<UiPrefs>(DEFAULTS);
export const usePrefs = () => useStore(prefs);

function apply(p: UiPrefs) {
  document.documentElement.dataset.reducedMotion = String(p.reducedMotion);
}

export async function loadPrefs() {
  apply(prefs.get());
  if (!isTauri) return;
  try {
    const rows = new Map(await api.getPreferences());
    const raw = rows.get("ui.prefs");
    if (raw) {
      const p = { ...DEFAULTS, ...JSON.parse(raw) };
      prefs.set(p);
      apply(p);
    }
  } catch {
    /* defaults */
  }
}

export async function savePrefs(patch: Partial<UiPrefs>) {
  const p = { ...prefs.get(), ...patch };
  prefs.set(p);
  apply(p);
  if (isTauri) await api.setPreference("ui.prefs", JSON.stringify(p));
}
