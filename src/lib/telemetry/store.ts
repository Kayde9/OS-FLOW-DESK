// Telemetry service client: history bootstrap + live `telemetry://sample` events.
// Presentation components read from here; they never talk to the backend directly.

import { api, isTauri, listen, errorText } from "../backend";
import { createStore, useStore } from "../store";
import type { AppStatus, Sample } from "../types";

export type FeedState = "connecting" | "live" | "stale" | "offline" | "error";

interface TelemetryState {
  samples: Sample[];
  feed: FeedState;
  error: string | null;
  status: AppStatus | null;
}

const CAP = 3600;
export const telemetry = createStore<TelemetryState>({
  samples: [],
  feed: isTauri ? "connecting" : "offline",
  error: null,
  status: null,
});

let started = false;

export async function startTelemetry() {
  if (started || !isTauri) return;
  started = true;
  try {
    const [history, status] = await Promise.all([api.telemetryHistory(), api.appStatus()]);
    telemetry.set((s) => ({ ...s, samples: history.slice(-CAP), status }));
    await listen<Sample>("telemetry://sample", (sample) => {
      telemetry.set((s) => {
        const samples = s.samples.length >= CAP ? s.samples.slice(1) : s.samples.slice();
        samples.push(sample);
        return { ...s, samples, feed: "live", error: null };
      });
    });
    // System info is filled in by the sampling thread shortly after launch.
    setTimeout(() => refreshStatus(), 2500);
  } catch (e) {
    telemetry.set((s) => ({ ...s, feed: "error", error: errorText(e) }));
  }
  // Staleness watchdog: three missed intervals without a sample.
  setInterval(() => {
    const s = telemetry.get();
    const last = s.samples[s.samples.length - 1];
    const interval = s.status?.intervalMs ?? 1000;
    if (s.feed === "live" && last && Date.now() - last.ts > interval * 3 + 500) {
      telemetry.set((p) => ({ ...p, feed: "stale" }));
    }
  }, 1000);
}

export async function refreshStatus() {
  try {
    const status = await api.appStatus();
    telemetry.set((s) => ({ ...s, status }));
  } catch {
    /* status is optional */
  }
}

export const useSamples = () => useStore(telemetry, (s) => s.samples);
export const useLatest = () => useStore(telemetry, (s) => s.samples[s.samples.length - 1] ?? null);
export const useFeed = () => useStore(telemetry, (s) => s.feed);
export const useAppStatus = () => useStore(telemetry, (s) => s.status);
export const useTelemetryError = () => useStore(telemetry, (s) => s.error);
