// Pure trace analysis over normalized events. Functions take index arrays so
// filtering never copies event objects (live sessions hold up to 100k events).
// Everything here is derived from captured data only.

import type { TraceEvent } from "./types";

export interface EventFilter {
  text: string;
  categories: Set<string> | null;
  source: "all" | "etw" | "flowdesk";
  pid: number | null;
  tid: number | null;
  /** Inclusive [from, to] in µs. */
  range: [number, number] | null;
  problemsOnly: boolean;
}

export const emptyFilter = (): EventFilter => ({ text: "", categories: null, source: "all", pid: null, tid: null, range: null, problemsOnly: false });

export const isProblem = (e: TraceEvent) => e.status === "error" || e.status === "warning";

export function matches(e: TraceEvent, f: EventFilter, needle = f.text.trim().toLowerCase()): boolean {
  if (f.categories && !f.categories.has(e.category)) return false;
  if (f.source !== "all" && e.source !== f.source) return false;
  if (f.pid != null && e.pid !== f.pid) return false;
  if (f.tid != null && e.tid !== f.tid) return false;
  if (f.range && (e.tsUs < f.range[0] || e.tsUs > f.range[1])) return false;
  if (f.problemsOnly && !isProblem(e)) return false;
  if (needle) {
    const hay = `${e.eventName} ${e.operation ?? ""} ${e.filePath ?? ""} ${e.processName ?? ""} ${e.threadName ?? ""} ${e.resultCode ?? ""} ${e.provider} ${e.pid ?? ""} ${e.tid ?? ""}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

export function filterIdx(events: TraceEvent[], f: EventFilter): number[] {
  const needle = f.text.trim().toLowerCase();
  const out: number[] = [];
  for (let i = 0; i < events.length; i++) if (matches(events[i], f, needle)) out.push(i);
  return out;
}

export type SortKey = "time" | "process" | "pid" | "tid" | "category" | "event" | "size" | "duration" | "status";

export function sortIdx(events: TraceEvent[], idx: number[], key: SortKey, dir: 1 | -1): number[] {
  if (key === "time") {
    // Source timestamp, then arrival order (ETW buffers per CPU can interleave).
    const out = idx.slice().sort((a, b) => events[a].tsUs - events[b].tsUs || events[a].seq - events[b].seq);
    return dir === 1 ? out : out.reverse();
  }
  const val = (e: TraceEvent): string | number | undefined => {
    switch (key) {
      case "process": return e.processName ?? "";
      case "pid": return e.pid;
      case "tid": return e.tid;
      case "category": return e.category;
      case "event": return e.operation ?? e.eventName;
      case "size": return e.size;
      case "duration": return e.durationUs;
      case "status": return e.resultCode ?? "";
    }
  };
  return idx.slice().sort((a, b) => {
    const va = val(events[a]);
    const vb = val(events[b]);
    // Missing values always sort last, regardless of direction.
    if (va == null && vb == null) return events[a].seq - events[b].seq;
    if (va == null) return 1;
    if (vb == null) return -1;
    const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
    return c * dir || events[a].seq - events[b].seq;
  });
}

export function countBy(events: TraceEvent[], idx: number[], key: (e: TraceEvent) => string | undefined): [string, number][] {
  const m = new Map<string, number>();
  for (const i of idx) {
    const k = key(events[i]);
    if (k == null) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** Nearest-rank percentile of a sorted array (same rule as the backend summary). */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export interface OpRow {
  key: string;
  category: string;
  operation: string;
  count: number;
  bytes: number;
  matched: number;
  unmatched: number;
  problems: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export function operationStats(events: TraceEvent[], idx: number[]): OpRow[] {
  const m = new Map<string, OpRow & { d: number[] }>();
  for (const i of idx) {
    const e = events[i];
    const op = e.operation ?? e.eventName;
    const key = `${e.category}/${op}`;
    let r = m.get(key);
    if (!r) {
      r = { key, category: e.category, operation: op, count: 0, bytes: 0, matched: 0, unmatched: 0, problems: 0, p50: null, p95: null, max: null, d: [] };
      m.set(key, r);
    }
    r.count++;
    r.bytes += e.size ?? 0;
    if (e.durationUs != null) {
      r.matched++;
      r.d.push(e.durationUs);
    } else if (e.awaitsCompletion) r.unmatched++;
    if (isProblem(e)) r.problems++;
  }
  return [...m.values()]
    .map(({ d, ...r }) => {
      d.sort((a, b) => a - b);
      return { ...r, p50: percentile(d, 50), p95: percentile(d, 95), max: d.length ? d[d.length - 1] : null };
    })
    .sort((a, b) => b.count - a.count);
}

/** Event counts in `bins` equal slices of [t0, t1] (µs). */
export function histogram(events: TraceEvent[], idx: number[], t0: number, t1: number, bins: number): number[] {
  const out = new Array<number>(bins).fill(0);
  const span = Math.max(1, t1 - t0);
  for (const i of idx) {
    const t = events[i].tsUs;
    if (t < t0 || t > t1) continue;
    out[Math.min(bins - 1, Math.floor(((t - t0) / span) * bins))]++;
  }
  return out;
}

/** Log-scale duration bins: <10µs, 10–100µs, 0.1–1ms, 1–10ms, 10–100ms, ≥100ms. */
export const DURATION_BINS = ["< 10 µs", "10–100 µs", "0.1–1 ms", "1–10 ms", "10–100 ms", "≥ 100 ms"];
export function durationHistogram(events: TraceEvent[], idx: number[]): number[] {
  const out = new Array<number>(DURATION_BINS.length).fill(0);
  for (const i of idx) {
    const d = events[i].durationUs;
    if (d == null) continue;
    const b = d < 10 ? 0 : Math.min(DURATION_BINS.length - 1, Math.floor(Math.log10(d)));
    out[b]++;
  }
  return out;
}

export interface Lane {
  key: string;
  pid: number | null;
  tid: number | null;
  label: string;
  sub: string;
  count: number;
}

export const laneKey = (e: TraceEvent) => `${e.pid ?? "?"}:${e.tid ?? "-"}`;

/** One lane per (process, thread); events without a thread (e.g. attributed disk I/O) get a per-process lane. */
export function buildLanes(events: TraceEvent[], idx: number[]): Lane[] {
  const m = new Map<string, Lane>();
  for (const i of idx) {
    const e = events[i];
    const key = laneKey(e);
    let l = m.get(key);
    if (!l) {
      const proc = e.processName ?? (e.pid != null ? `PID ${e.pid}` : "unknown process");
      l = {
        key,
        pid: e.pid ?? null,
        tid: e.tid ?? null,
        label: e.threadName ?? (e.tid != null ? `TID ${e.tid}` : "no thread"),
        sub: `${proc}${e.tid != null && e.threadName ? ` · TID ${e.tid}` : ""}`,
        count: 0,
      };
      m.set(key, l);
    } else if (!l.label.startsWith("flowdesk") && e.threadName) {
      l.label = e.threadName;
      l.sub = `${e.processName ?? `PID ${e.pid}`} · TID ${e.tid}`;
    }
    l.count++;
  }
  return [...m.values()].sort((a, b) => (a.pid ?? 0) - (b.pid ?? 0) || b.count - a.count);
}

/** Index (into `order`) of the next/previous entry after position `from`. */
export function step(order: number[], from: number, dir: 1 | -1): number | null {
  if (!order.length) return null;
  if (from < 0) return dir === 1 ? 0 : order.length - 1;
  const n = from + dir;
  return n < 0 || n >= order.length ? null : n;
}

/** Events near `center` in time, sharing the thread or the file. */
export function related(events: TraceEvent[], center: TraceEvent, max = 12): TraceEvent[] {
  const lane = laneKey(center);
  const cands: TraceEvent[] = [];
  for (const e of events) {
    if (e.seq === center.seq) continue;
    if (laneKey(e) === lane || (center.filePath && e.filePath === center.filePath)) cands.push(e);
  }
  return cands.sort((a, b) => Math.abs(a.tsUs - center.tsUs) - Math.abs(b.tsUs - center.tsUs)).slice(0, max).sort((a, b) => a.tsUs - b.tsUs);
}

export interface Point {
  ts: number; // ms
  value: number | null;
}

/** The `n` samples closest in time to `tsMs`, oldest first. */
export function nearest<T extends { ts: number }>(samples: T[], tsMs: number, n = 4): T[] {
  return samples
    .slice()
    .sort((a, b) => Math.abs(a.ts - tsMs) - Math.abs(b.ts - tsMs))
    .slice(0, n)
    .sort((a, b) => a.ts - b.ts);
}

// ------------------------------------------------------------ formatting

/** Wall-clock time with microseconds: 14:03:07.123456 */
export function clockUs(us: number | null | undefined): string {
  if (us == null) return "—";
  const d = new Date(Math.floor(us / 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${p(Math.floor(us % 1000), 3)}`;
}

export function durUs(us: number | null | undefined): string {
  if (us == null) return "—";
  if (us < 1000) return `${us} µs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(us < 10_000 ? 2 : 1)} ms`;
  return `${(us / 1e6).toFixed(2)} s`;
}

export function compact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 10_000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}
