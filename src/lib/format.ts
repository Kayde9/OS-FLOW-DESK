const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function bytes(b: number | null | undefined, digits = 1): string {
  if (b == null || !Number.isFinite(b)) return "—";
  let v = Math.abs(b);
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${(Math.sign(b) * v).toFixed(i === 0 ? 0 : digits)} ${UNITS[i]}`;
}

export function rate(bps: number | null | undefined): string {
  if (bps == null) return "—";
  return `${bytes(bps)}/s`;
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

export function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s % 60);
  if (m < 60) return `${m}m ${rs.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, "0")}m`;
}

export function clock(ts: number | null | undefined, withSeconds = true): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
    hour12: false,
  });
}

export function dateTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.toLocaleDateString([], { year: "numeric", month: "short", day: "2-digit" })} ${clock(ts)}`;
}

/** Shortens a path for display while keeping the final segments. */
export function shortPath(p: string | null | undefined, max = 48): string {
  if (!p) return "—";
  if (p.length <= max) return p;
  const parts = p.split(/[\\/]/);
  let out = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i]}\\${out}`;
    if (next.length + 4 > max) break;
    out = next;
  }
  return `…\\${out}`;
}

export const POLICY_LABEL: Record<string, string> = {
  fcfs: "FCFS",
  priority: "Priority",
  round_robin: "Round Robin",
  shortest_remaining: "Shortest Remaining",
};

export const OP_LABEL: Record<string, string> = {
  hash: "SHA-256 hashing",
  index: "File indexing",
  duplicates: "Duplicate detection",
  metadata: "Metadata analysis",
  copy: "Safe copy",
};
