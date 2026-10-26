import type { Metric, Sample } from "../types";

export const RANGES = [
  { value: 60_000, label: "1M" },
  { value: 300_000, label: "5M" },
  { value: 900_000, label: "15M" },
  { value: 3_600_000, label: "1H" },
] as const;

export function windowed(samples: Sample[], rangeMs: number): Sample[] {
  if (!samples.length) return samples;
  const cutoff = samples[samples.length - 1].ts - rangeMs;
  let i = samples.length - 1;
  while (i > 0 && samples[i - 1].ts >= cutoff) i--;
  return samples.slice(i);
}

export const val = (m: Metric | undefined | null) => (m && m.available ? m.value : null);

export function pick(samples: Sample[], f: (s: Sample) => Metric): (number | null)[] {
  return samples.map((s) => val(f(s)));
}

export function memPct(s: Sample): number | null {
  const u = val(s.memUsed);
  const t = val(s.memTotal);
  return u != null && t ? (u / t) * 100 : null;
}
