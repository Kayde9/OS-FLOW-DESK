// Multi-lane trace timeline, drawn on a canvas so 100k events cost one pass of
// fillRect calls rather than 100k DOM nodes. One lane per (process, thread).
// Bars are drawn ONLY for events with a matched completion (real durations);
// everything else is a point marker. Telemetry bands below share the time axis
// but each has its own y-scale (separate small charts, no dual axis).
//
// Wheel = zoom at cursor · drag = pan · Shift+drag = select range ·
// click = select event · wheel over lane labels = scroll lanes.

import { useEffect, useMemo, useRef, useState } from "react";
import { bytes } from "../../lib/format";
import { clockUs, durUs, laneKey, type Lane } from "../../lib/trace/analysis";
import type { TraceEvent } from "../../lib/trace/types";
import { catOf, cssColor, drawShape } from "./categories";
import { series, type TelSeries } from "./telemetry";

const GUTTER = 176;
const AXIS = 22;
const LANE_H = 18;
const MAX_LANES = 10;
const BAND_H = 34;
const BAND_GAP = 6;

interface Props {
  events: TraceEvent[];
  idx: number[];
  version: number;
  lanes: Lane[];
  extent: [number, number] | null;
  window: [number, number] | null;
  selected: number | null;
  range: [number, number] | null;
  tel: TelSeries[];
  onWindow: (w: [number, number] | null) => void;
  onSelect: (seq: number) => void;
  onRange: (r: [number, number] | null) => void;
}

function niceStep(spanUs: number, target: number): number {
  const raw = spanUs / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

function relLabel(us: number): string {
  const a = Math.abs(us);
  if (a < 1000) return `+${us.toFixed(0)} µs`;
  if (a < 1e6) return `+${(us / 1000).toFixed(a < 1e4 ? 2 : 1)} ms`;
  return `+${(us / 1e6).toFixed(a < 1e7 ? 3 : 1)} s`;
}

export function Timeline(p: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(900);
  const [laneOff, setLaneOff] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number; ev: TraceEvent | null; t: number } | null>(null);
  const drag = useRef<{ x0: number; w0: [number, number]; mode: "pan" | "range"; moved: boolean } | null>(null);
  const [rangeDraft, setRangeDraft] = useState<[number, number] | null>(null);

  const visLanes = p.lanes.slice(laneOff, laneOff + MAX_LANES);
  const lanesH = Math.max(1, visLanes.length) * LANE_H;
  const bandTop = AXIS + lanesH + BAND_GAP;
  const height = bandTop + 2 * (BAND_H + BAND_GAP);
  const plotW = Math.max(50, width - GUTTER - 8);
  const win: [number, number] | null = p.window ?? (p.extent ? [p.extent[0], Math.max(p.extent[1], p.extent[0] + 1000)] : null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => setLaneOff((o) => Math.min(o, Math.max(0, p.lanes.length - MAX_LANES))), [p.lanes.length]);

  // Per-lane event indices sorted by time, for hit testing.
  const byLane = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const i of p.idx) {
      const k = laneKey(p.events[i]);
      let a = m.get(k);
      if (!a) m.set(k, (a = []));
      a.push(i);
    }
    for (const a of m.values()) a.sort((x, y) => p.events[x].tsUs - p.events[y].tsUs);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.idx, p.version]);
  // Longest real duration: how far back a bar covering time t can start.
  const maxDur = useMemo(() => {
    let m = 0;
    for (const i of p.idx) m = Math.max(m, p.events[i].durationUs ?? 0);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.idx, p.version]);

  const xOf = (t: number) => (win ? GUTTER + ((t - win[0]) / (win[1] - win[0])) * plotW : 0);
  const tOf = (x: number) => (win ? win[0] + ((x - GUTTER) / plotW) * (win[1] - win[0]) : 0);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const raf = requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.floor(width * dpr);
      c.height = Math.floor(height * dpr);
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.font = "10.5px 'JetBrains Mono', Consolas, monospace";
      const ink2 = cssColor("--ink-2");
      const ink3 = cssColor("--ink-3");
      const grid = cssColor("--steel-dim", 0.6);

      // Lane backgrounds and labels
      visLanes.forEach((l, i) => {
        const y = AXIS + i * LANE_H;
        if (i % 2 === 0) {
          ctx.fillStyle = "rgb(255 255 255 / 0.018)";
          ctx.fillRect(0, y, width, LANE_H);
        }
        ctx.fillStyle = l.label.startsWith("flowdesk-") ? ink2 : ink3;
        ctx.fillText(l.label.length > 22 ? `${l.label.slice(0, 21)}…` : l.label, 8, y + 12.5);
      });
      ctx.fillStyle = grid;
      ctx.fillRect(GUTTER - 1, AXIS, 1, lanesH);
      if (!win) return;

      // Axis: relative to the first event
      const origin = p.extent?.[0] ?? win[0];
      const stepUs = niceStep(win[1] - win[0], Math.max(2, Math.floor(plotW / 110)));
      const first = Math.ceil((win[0] - origin) / stepUs) * stepUs + origin;
      ctx.fillStyle = ink3;
      for (let t = first; t <= win[1]; t += stepUs) {
        const x = xOf(t);
        ctx.fillStyle = grid;
        ctx.fillRect(x, AXIS - 4, 1, lanesH + 4);
        ctx.fillStyle = ink3;
        ctx.fillText(relLabel(t - origin), x + 3, 13);
      }

      // Range selection
      const r = rangeDraft ?? p.range;
      if (r) {
        const x0 = Math.max(GUTTER, xOf(Math.min(r[0], r[1])));
        const x1 = Math.min(width, xOf(Math.max(r[0], r[1])));
        ctx.fillStyle = cssColor("--amber", 0.1);
        ctx.fillRect(x0, AXIS, Math.max(1, x1 - x0), height - AXIS);
        ctx.fillStyle = cssColor("--amber", 0.6);
        ctx.fillRect(x0, AXIS, 1, height - AXIS);
        ctx.fillRect(x1, AXIS, 1, height - AXIS);
      }

      // Events
      ctx.save();
      ctx.beginPath();
      ctx.rect(GUTTER, AXIS, plotW, lanesH);
      ctx.clip();
      const alert = cssColor("--alert");
      const colors = new Map<string, string>();
      visLanes.forEach((l, li) => {
        const arr = byLane.get(l.key);
        if (!arr) return;
        const cy = AXIS + li * LANE_H + LANE_H / 2;
        for (const i of arr) {
          const e = p.events[i];
          const end = e.tsUs + (e.durationUs ?? 0);
          if (end < win[0] || e.tsUs > win[1]) continue;
          const c = catOf(e.category);
          let col = colors.get(c.token);
          if (!col) colors.set(c.token, (col = cssColor(c.token)));
          ctx.fillStyle = col;
          const x = xOf(e.tsUs);
          if (e.durationUs != null && e.durationUs > 0) {
            // Real duration from a matched completion
            const w = Math.max(2, xOf(end) - x);
            ctx.fillRect(x, cy - 4, w, 8);
          } else {
            drawShape(ctx, c.shape, x, cy, c.shape === "tick" ? 5 : 4);
          }
          if (e.status === "error" || e.status === "warning") {
            ctx.strokeStyle = alert;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(x, cy, 6, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      });
      ctx.restore();

      // Selected event
      if (p.selected != null) {
        const e = p.events.find((x) => x.seq === p.selected);
        if (e && e.tsUs >= win[0] && e.tsUs <= win[1]) {
          const x = xOf(e.tsUs);
          ctx.fillStyle = cssColor("--amber", 0.9);
          ctx.fillRect(x - 0.5, AXIS, 1, height - AXIS);
          const li = visLanes.findIndex((l) => l.key === laneKey(e));
          if (li >= 0) {
            ctx.strokeStyle = cssColor("--amber");
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, AXIS + li * LANE_H + LANE_H / 2, 7, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }

      // Telemetry bands (each its own scale; gaps where no value)
      const band = (top: number, label: string, defs: { s: TelSeries | undefined; token: string; name: string }[], fixedMax?: number) => {
        ctx.fillStyle = "rgb(0 0 0 / 0.18)";
        ctx.fillRect(GUTTER, top, plotW, BAND_H);
        ctx.fillStyle = ink3;
        ctx.fillText(label, 8, top + 12);
        const avail = defs.filter((d) => d.s?.available);
        if (!avail.length) {
          ctx.fillText("N/A — no samples in this window", GUTTER + 8, top + BAND_H / 2 + 4);
          return;
        }
        let max = fixedMax ?? 0;
        if (fixedMax == null) for (const d of avail) for (const pt of d.s!.points) if (pt.value != null) max = Math.max(max, pt.value);
        max = max || 1;
        ctx.fillText(defs[0].s?.unit === "B/s" ? `max ${bytes(max)}/s` : `max ${max.toFixed(0)}${defs[0].s?.unit ?? ""}`, 8, top + 25);
        avail.forEach((d, di) => {
          if (defs.length > 1) {
            ctx.fillStyle = cssColor(d.token);
            ctx.fillRect(GUTTER + plotW - 96 + di * 48, top + 5, 8, 2);
            ctx.fillStyle = ink2;
            ctx.fillText(d.name, GUTTER + plotW - 85 + di * 48, top + 10);
          }
          ctx.save();
          ctx.beginPath();
          ctx.rect(GUTTER, top, plotW, BAND_H);
          ctx.clip();
          ctx.strokeStyle = cssColor(d.token);
          ctx.lineWidth = 2;
          ctx.beginPath();
          let pen = false;
          for (const pt of d.s!.points) {
            const t = pt.ts * 1000;
            if (pt.value == null) {
              pen = false;
              continue;
            }
            const x = xOf(t);
            const y = top + BAND_H - 3 - (pt.value / max) * (BAND_H - 6);
            if (pen) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
            pen = true;
          }
          ctx.stroke();
          ctx.restore();
        });
      };
      band(bandTop, "System CPU %", [{ s: series(p.tel, "cpu"), token: "--series-cpu", name: "cpu" }], 100);
      band(bandTop + BAND_H + BAND_GAP, "Disk throughput", [
        { s: series(p.tel, "disk_read"), token: "--series-read", name: "read" },
        { s: series(p.tel, "disk_write"), token: "--series-write", name: "write" },
      ]);

      // Hover crosshair
      if (hover && hover.x > GUTTER) {
        ctx.fillStyle = cssColor("--ink", 0.35);
        ctx.fillRect(hover.x, AXIS, 1, height - AXIS);
      }
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, win?.[0], win?.[1], byLane, p.selected, p.range, rangeDraft, p.tel, laneOff, hover, p.lanes]);

  const hit = (x: number, y: number): TraceEvent | null => {
    if (!win || x < GUTTER || y < AXIS || y >= AXIS + lanesH) return null;
    const lane = visLanes[Math.floor((y - AXIS) / LANE_H)];
    const arr = lane && byLane.get(lane.key);
    if (!arr?.length) return null;
    const t = tOf(x);
    const tol = (6 / plotW) * (win[1] - win[0]);
    // Binary search the first event at or after t - tol, scan forward.
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (p.events[arr[mid]].tsUs < t - tol - maxDur) lo = mid + 1;
      else hi = mid;
    }
    let best: TraceEvent | null = null;
    let bestD = Infinity;
    for (let k = lo; k < arr.length; k++) {
      const e = p.events[arr[k]];
      if (e.tsUs > t + tol) break;
      const end = e.tsUs + (e.durationUs ?? 0);
      const d = t >= e.tsUs && t <= end ? 0 : Math.min(Math.abs(t - e.tsUs), Math.abs(t - end));
      if (d <= tol && d < bestD) {
        best = e;
        bestD = d;
      }
    }
    return best;
  };

  const pos = (ev: React.MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };

  return (
    <div ref={wrap} className="relative select-none">
      <canvas
        ref={canvas}
        style={{ width: "100%", height }}
        className={drag.current?.mode === "pan" ? "cursor-grabbing" : "cursor-crosshair"}
        role="img"
        aria-label={`Trace timeline: ${p.idx.length} events in ${p.lanes.length} process/thread lanes. Use the event table for a text view.`}
        onWheel={(ev) => {
          const { x } = pos(ev);
          if (x < GUTTER) {
            setLaneOff((o) => Math.max(0, Math.min(p.lanes.length - MAX_LANES, o + Math.sign(ev.deltaY))));
            return;
          }
          if (!win) return;
          const t = tOf(x);
          const f = ev.deltaY > 0 ? 1.25 : 0.8;
          const a = t - (t - win[0]) * f;
          const b = t + (win[1] - t) * f;
          if (b - a < 20) return;
          p.onWindow([a, b]);
        }}
        onMouseDown={(ev) => {
          if (!win) return;
          const { x } = pos(ev);
          if (x < GUTTER) return;
          drag.current = { x0: x, w0: win, mode: ev.shiftKey ? "range" : "pan", moved: false };
        }}
        onMouseMove={(ev) => {
          const { x, y } = pos(ev);
          const d = drag.current;
          if (d && win) {
            if (Math.abs(x - d.x0) > 3) d.moved = true;
            if (d.moved && d.mode === "pan") {
              const dt = ((x - d.x0) / plotW) * (d.w0[1] - d.w0[0]);
              p.onWindow([d.w0[0] - dt, d.w0[1] - dt]);
            } else if (d.moved) {
              setRangeDraft([tOf(d.x0), tOf(x)]);
            }
            return;
          }
          setHover({ x, y, ev: hit(x, y), t: tOf(x) });
        }}
        onMouseUp={(ev) => {
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          const { x, y } = pos(ev);
          if (!d.moved) {
            const e = hit(x, y);
            if (e) p.onSelect(e.seq);
          } else if (d.mode === "range" && rangeDraft) {
            const r: [number, number] = [Math.min(...rangeDraft), Math.max(...rangeDraft)];
            setRangeDraft(null);
            p.onRange(r[1] - r[0] > 1 ? r : null);
          }
        }}
        onMouseLeave={() => {
          drag.current = null;
          setRangeDraft(null);
          setHover(null);
        }}
      />
      {p.lanes.length > MAX_LANES && (
        <div className="absolute left-2 bottom-[86px] text-[10.5px] text-ink-3 readout">
          lanes {laneOff + 1}–{Math.min(p.lanes.length, laneOff + MAX_LANES)} of {p.lanes.length} · wheel to scroll
        </div>
      )}
      {hover?.ev && <Tip x={hover.x} y={hover.y} width={width} e={hover.ev} />}
      {hover && !hover.ev && hover.x > GUTTER && hover.y >= bandTop && (
        <TelTip x={hover.x} y={hover.y} width={width} t={hover.t} tel={p.tel} />
      )}
    </div>
  );
}

function Tip({ x, y, width, e }: { x: number; y: number; width: number; e: TraceEvent }) {
  const left = Math.min(x + 14, width - 300);
  return (
    <div className="absolute z-20 pointer-events-none w-[286px] recess bg-panel-sunk/95 px-2.5 py-2 text-[11.5px] shadow-lg" style={{ left, top: y + 14 }}>
      <div className="font-medium text-ink truncate">
        {e.eventName} <span className="text-ink-3 font-normal">· {catOf(e.category).label}</span>
      </div>
      <div className="readout text-ink-2">{clockUs(e.tsUs)}</div>
      {e.filePath && <div className="readout text-ink-2 truncate" title={e.filePath}>{e.filePath}</div>}
      <div className="readout text-ink-3 flex gap-3 flex-wrap">
        {e.size != null && <span>{bytes(e.size)}</span>}
        <span>{e.durationUs != null ? durUs(e.durationUs) : e.awaitsCompletion ? "no completion observed" : "point event"}</span>
        {e.resultCode && <span className={e.status === "success" ? "" : "text-alert"}>{e.resultCode}</span>}
      </div>
    </div>
  );
}

function TelTip({ x, y, width, t, tel }: { x: number; y: number; width: number; t: number; tel: TelSeries[] }) {
  const tMs = t / 1000;
  const rows = ["cpu", "disk_read", "disk_write"].map((m) => {
    const s = series(tel, m);
    let best: { ts: number; value: number | null } | null = null;
    for (const pt of s?.points ?? []) if (!best || Math.abs(pt.ts - tMs) < Math.abs(best.ts - tMs)) best = pt;
    return { s, best };
  });
  if (!rows.some((r) => r.best)) return null;
  return (
    <div className="absolute z-20 pointer-events-none w-[230px] recess bg-panel-sunk/95 px-2.5 py-2 text-[11.5px]" style={{ left: Math.min(x + 14, width - 240), top: y - 70 }}>
      {rows.map(({ s, best }) =>
        s ? (
          <div key={s.metric} className="flex justify-between gap-2">
            <span className="text-ink-3">{s.label}</span>
            <span className="readout text-ink">
              {best?.value == null ? "N/A" : s.unit === "B/s" ? `${bytes(best.value)}/s` : `${best.value.toFixed(1)} ${s.unit}`}
            </span>
          </div>
        ) : null,
      )}
      <div className="text-[10.5px] text-ink-3 mt-1">Nearest sample · {rows[0].s?.source}</div>
    </div>
  );
}
