import { memo } from "react";
import { Sparkline } from "../charts/Sparkline";

/** 240° instrument gauge with bezel, tick ring, needle and trend sparkline. */
interface GaugeProps {
  label: string;
  /** Normalised 0–1 deflection, or null when unavailable / warming up. */
  fraction: number | null;
  value: string;
  unit?: string;
  sub?: string;
  source: string;
  available: boolean;
  note?: string | null;
  trend: (number | null)[];
  /** CSS rgb triplet var name for the series colour, e.g. "--series-cpu" */
  series: string;
  /** Fraction above which the arc turns amber (operational warning). */
  warnAt?: number;
  /** Scale end label (e.g. "100%", "250 MB/s"). */
  scaleMax?: string;
}

const START = 150; // degrees, SVG coordinates (0 = 3 o'clock, clockwise)
const SWEEP = 240;
const R = 46;

function polar(deg: number, r: number) {
  const a = (deg * Math.PI) / 180;
  return [60 + r * Math.cos(a), 60 + r * Math.sin(a)];
}

function arc(from: number, to: number, r: number) {
  const [x1, y1] = polar(from, r);
  const [x2, y2] = polar(to, r);
  const large = to - from > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

export const Gauge = memo(function Gauge(p: GaugeProps) {
  const f = p.fraction == null ? null : Math.max(0, Math.min(1, p.fraction));
  const end = START + SWEEP * (f ?? 0);
  const warn = f != null && p.warnAt != null && f >= p.warnAt;
  const color = warn ? "rgb(var(--amber))" : `rgb(var(${p.series}))`;
  const ticks = Array.from({ length: 11 }, (_, i) => START + (SWEEP * i) / 10);
  const [nx, ny] = polar(end, R - 12);

  return (
    <div className="panel flex flex-col min-w-0" aria-label={`${p.label} gauge`}>
      <div className="panel-head rivets pl-5 pr-5">
        <span className="text-ink-2">{p.label}</span>
        <span className="ml-auto flex items-center gap-1.5 normal-case tracking-normal font-normal text-[10.5px] text-ink-3 truncate" title={p.note ?? p.source}>
          <span className={`led ${p.available ? (f == null ? "led-info" : "led-ok") : ""}`} />
          {p.available ? (f == null ? "warming up" : "live") : "unavailable"}
        </span>
      </div>
      <div className="flex-1 flex flex-col gap-2 p-3 pt-2 min-h-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="relative shrink-0 w-[96px] h-[90px]">
            <svg viewBox="0 0 120 112" className="w-full h-full">
              {/* bezel */}
              <circle cx="60" cy="60" r="56" fill="rgb(var(--panel-sunk))" stroke="rgb(var(--steel))" strokeWidth="1.5" />
              <circle cx="60" cy="60" r="52" fill="none" stroke="rgb(0 0 0 / .45)" strokeWidth="2" />
              {ticks.map((t, i) => {
                const [x1, y1] = polar(t, 51);
                const [x2, y2] = polar(t, i % 5 === 0 ? 44 : 47);
                return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgb(var(--steel-hi))" strokeWidth={i % 5 === 0 ? 1.4 : 0.8} />;
              })}
              <path d={arc(START, START + SWEEP, R - 6)} fill="none" stroke="rgb(var(--steel-dim))" strokeWidth="5" strokeLinecap="round" />
              {f != null && f > 0.002 && (
                <path d={arc(START, end, R - 6)} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round" style={{ transition: "stroke 300ms" }} />
              )}
              {f != null && (
                <>
                  <line x1="60" y1="60" x2={nx} y2={ny} stroke="rgb(var(--ink))" strokeWidth="1.6" strokeLinecap="round" />
                  <circle cx="60" cy="60" r="4" fill="rgb(var(--panel-raised))" stroke="rgb(var(--steel-hi))" />
                </>
              )}
            </svg>
            {!p.available && (
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="readout text-[12px] text-ink-3 px-1.5 border border-steel-dim rounded-sm bg-panel-sunk">N/A</span>
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="readout text-[26px] leading-8 text-ink whitespace-nowrap">
              {p.available ? p.value : "—"}
              {p.available && p.unit && <span className="text-[12px] text-ink-3 ml-1">{p.unit}</span>}
            </div>
            <div className="text-[11px] text-ink-2 leading-snug line-clamp-2" title={p.sub}>
              {p.available ? p.sub : p.note}
            </div>
            {p.scaleMax && <div className="text-[10px] text-ink-3 mt-0.5">dial 0 – {p.scaleMax}</div>}
          </div>
        </div>
        <div className="recess h-[34px] px-1 py-0.5">{p.available ? <Sparkline values={p.trend} color={`rgb(var(${p.series}))`} /> : null}</div>
        <div className="text-[10.5px] text-ink-3 truncate" title={p.note ?? p.source}>
          SRC · <span className="font-mono">{p.source}</span>
        </div>
      </div>
    </div>
  );
});
