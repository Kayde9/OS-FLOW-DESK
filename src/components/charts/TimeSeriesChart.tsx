import { memo, useEffect, useMemo, useRef, useState } from "react";
import { clock } from "../../lib/format";

export interface Series {
  id: string;
  label: string;
  /** CSS var holding an rgb triplet, e.g. "--series-cpu" */
  color: string;
  values: (number | null)[];
}

interface Props {
  ts: number[];
  series: Series[];
  format: (v: number) => string;
  /** Fixed y maximum (e.g. 100 for percentages); otherwise auto-scaled with headroom. */
  yMax?: number;
  height?: number;
  /** Shown when there is nothing to plot. */
  emptyLabel?: string;
}

const PAD_BASE = { r: 10, t: 8, b: 18 };

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

export const TimeSeriesChart = memo(function TimeSeriesChart({ ts, series, format, yMax, height = 150, emptyLabel = "Waiting for samples" }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(120, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visible = series.filter((s) => !hidden.has(s.id));
  const n = ts.length;
  const t0 = ts[0] ?? 0;
  const t1 = ts[n - 1] ?? 1;
  const top = useMemo(() => {
    if (yMax != null) return yMax;
    let m = 0;
    for (const s of visible) for (const v of s.values) if (v != null && v > m) m = v;
    return niceMax(m * 1.1);
  }, [visible, yMax]);
  // Left gutter sized to the widest axis label (monospace ≈ 6px per char at 9.5px).
  const PAD = { ...PAD_BASE, l: Math.max(30, Math.max(format(top).length, format(top / 2).length) * 6 + 10) };
  const plotW = width - PAD.l - PAD.r;
  const plotH = height - PAD.t - PAD.b;

  const x = (t: number) => PAD.l + (t1 === t0 ? plotW : ((t - t0) / (t1 - t0)) * plotW);
  const y = (v: number) => PAD.t + plotH - (Math.min(v, top) / top) * plotH;

  const paths = visible.map((s) => {
    let d = "";
    let pen = false;
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (v == null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${x(ts[i]).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    }
    return { s, d };
  });

  const timeTicks = useMemo(() => {
    if (n < 2) return [];
    const span = t1 - t0;
    const step = [5e3, 10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 1800e3, 3600e3].find((s) => span / s <= Math.max(2, plotW / 90)) ?? 3600e3;
    const out: number[] = [];
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(t);
    return out;
  }, [t0, t1, n, plotW]);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (n < 2) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = t0 + ((px - PAD.l) / plotW) * (t1 - t0);
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(ts[lo - 1] - t) < Math.abs(ts[lo] - t)) lo--;
    setHover(lo);
  };

  const last = n - 1;
  const hi = hover != null ? hover : null;

  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      {series.length >= 2 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1" role="group" aria-label="Series">
          {series.map((s) => {
            const off = hidden.has(s.id);
            const cur = s.values[last];
            return (
              <button
                key={s.id}
                type="button"
                aria-pressed={!off}
                onClick={() =>
                  setHidden((h) => {
                    const nh = new Set(h);
                    if (nh.has(s.id)) nh.delete(s.id);
                    else if (nh.size < series.length - 1) nh.add(s.id);
                    return nh;
                  })
                }
                className={`flex items-center gap-1.5 text-[11px] rounded-sm px-1 -mx-1 hover:bg-white/5 ${off ? "text-ink-3 line-through" : "text-ink-2"}`}
              >
                <span className="w-3 h-[3px] rounded-full" style={{ background: off ? "rgb(var(--steel))" : `rgb(var(${s.color}))` }} />
                {s.label}
                <span className="readout text-ink">{cur != null ? format(cur) : "—"}</span>
              </button>
            );
          })}
        </div>
      )}
      <div ref={ref} className="relative recess" style={{ height }}>
        {n < 2 ? (
          <div className="absolute inset-0 flex items-center justify-center text-[11.5px] text-ink-3">{emptyLabel}</div>
        ) : (
          <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} className="block">
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <g key={f}>
                <line x1={PAD.l} x2={width - PAD.r} y1={PAD.t + plotH * (1 - f)} y2={PAD.t + plotH * (1 - f)} stroke="rgb(255 255 255 / .05)" />
                {f % 0.5 === 0 && (
                  <text x={PAD.l - 6} y={PAD.t + plotH * (1 - f) + 3} textAnchor="end" fontSize="9.5" fill="rgb(var(--ink-3))" fontFamily="JetBrains Mono">
                    {format(top * f)}
                  </text>
                )}
              </g>
            ))}
            {timeTicks.map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={PAD.t} y2={PAD.t + plotH} stroke="rgb(255 255 255 / .035)" />
                <text x={x(t)} y={height - 5} textAnchor="middle" fontSize="9.5" fill="rgb(var(--ink-3))" fontFamily="JetBrains Mono">
                  {clock(t, (t1 - t0) < 600e3)}
                </text>
              </g>
            ))}
            {paths.map(({ s, d }) => (
              <path key={s.id} d={d} fill="none" stroke={`rgb(var(${s.color}))`} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {/* current-value markers */}
            {visible.map((s) => {
              const v = s.values[last];
              return v == null ? null : (
                <circle key={s.id} cx={x(ts[last])} cy={y(v)} r="3" fill={`rgb(var(${s.color}))`} stroke="rgb(var(--panel-sunk))" strokeWidth="2" />
              );
            })}
            {hi != null && (
              <g pointerEvents="none">
                <line x1={x(ts[hi])} x2={x(ts[hi])} y1={PAD.t} y2={PAD.t + plotH} stroke="rgb(var(--steel-hi))" strokeDasharray="2 3" />
                {visible.map((s) => {
                  const v = s.values[hi];
                  return v == null ? null : (
                    <circle key={s.id} cx={x(ts[hi])} cy={y(v)} r="4" fill={`rgb(var(${s.color}))`} stroke="rgb(var(--panel-sunk))" strokeWidth="2" />
                  );
                })}
              </g>
            )}
          </svg>
        )}
        {hi != null && n >= 2 && (
          <div
            className="absolute top-1 pointer-events-none panel px-2 py-1.5 text-[11px] z-10 min-w-[120px]"
            style={x(ts[hi]) > width / 2 ? { right: width - x(ts[hi]) + 10 } : { left: x(ts[hi]) + 10 }}
          >
            <div className="readout text-ink-3 mb-0.5">{clock(ts[hi])}</div>
            {visible.map((s) => (
              <div key={s.id} className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ background: `rgb(var(${s.color}))` }} />
                <span className="text-ink-2">{s.label}</span>
                <span className="readout text-ink ml-auto pl-2">{s.values[hi] != null ? format(s.values[hi]!) : "N/A"}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
