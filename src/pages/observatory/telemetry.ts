// Telemetry aligned to a trace window. Live sessions read the telemetry ring
// buffer; saved sessions read the snapshot stored at finalize. Missing or
// unsupported readings stay null — gaps are never interpolated.

import type { Metric, Sample } from "../../lib/types";
import type { TelemetryPoint } from "../../lib/trace/types";

export interface TelSeries {
  metric: string;
  label: string;
  unit: string;
  source: string;
  /** At least one sample had a value. */
  available: boolean;
  note: string | null;
  points: { ts: number; value: number | null }[];
}

const METRICS: [string, keyof Sample, string][] = [
  ["cpu", "cpu", "System CPU"],
  ["app_cpu", "appCpu", "FlowDesk CPU"],
  ["disk_read", "diskRead", "Disk read"],
  ["disk_write", "diskWrite", "Disk write"],
  ["disk_active", "diskActive", "Disk active"],
  ["mem_used", "memUsed", "Memory used"],
  ["gpu_util", "gpuUtil", "GPU utilisation"],
  ["gpu_temp", "gpuTemp", "GPU temperature"],
  ["cpu_temp", "cpuTemp", "CPU temperature"],
];

export function fromSamples(samples: Sample[], t0: number, t1: number): TelSeries[] {
  const win = samples.filter((s) => s.ts >= t0 - 2000 && s.ts <= t1 + 2000);
  return METRICS.map(([metric, key, label]) => {
    const ms = win.map((s) => s[key] as Metric);
    const last = ms[ms.length - 1];
    return {
      metric,
      label,
      unit: last?.unit ?? "",
      source: last?.source ?? "—",
      available: ms.some((m) => m.value != null),
      note: ms.find((m) => m.note)?.note ?? null,
      points: win.map((s, i) => ({ ts: s.ts, value: ms[i].value })),
    };
  });
}

export function fromPoints(points: TelemetryPoint[]): TelSeries[] {
  return METRICS.map(([metric, , label]) => {
    const ps = points.filter((p) => p.metric === metric);
    return {
      metric,
      label,
      unit: ps[0]?.unit ?? "",
      source: ps[0]?.source ?? "—",
      available: ps.some((p) => p.value != null),
      note: ps.length && ps.every((p) => !p.available) ? "Sensor unavailable on this system" : null,
      points: ps.map((p) => ({ ts: p.ts, value: p.value })),
    };
  });
}

export const series = (all: TelSeries[], metric: string) => all.find((s) => s.metric === metric);

/** Median spacing between samples, for "sampling interval" labels. */
export function interval(s: TelSeries | undefined): number | null {
  if (!s || s.points.length < 2) return null;
  const d = s.points.slice(1).map((p, i) => p.ts - s.points[i].ts).sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}
