import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, SkipForward } from "lucide-react";
import { Panel, Seg, SimBadge } from "../../components/industrial/Panel";

// ------------------------------------------------------------ step player

export function useStepper(count: number) {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(500);
  useEffect(() => {
    setI(0);
    setPlaying(false);
  }, [count]);
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setI((x) => {
        if (x >= count - 1) {
          setPlaying(false);
          return x;
        }
        return x + 1;
      });
    }, speed);
    return () => clearInterval(t);
  }, [playing, speed, count]);
  return {
    i: Math.min(i, Math.max(0, count - 1)),
    count,
    playing,
    speed,
    setSpeed,
    setI,
    toggle: () => (i >= count - 1 ? (setI(0), setPlaying(true)) : setPlaying((p) => !p)),
    step: (d: number) => (setPlaying(false), setI((x) => Math.max(0, Math.min(count - 1, x + d)))),
    reset: () => (setPlaying(false), setI(0)),
    end: () => (setPlaying(false), setI(count - 1)),
  };
}

export type Stepper = ReturnType<typeof useStepper>;

export function StepControls({ s, label = "Step" }: { s: Stepper; label?: string }) {
  if (!s.count) return null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <button className="btn btn-sm" onClick={s.reset} aria-label="Reset to start">
        <RotateCcw size={12} />
      </button>
      <button className="btn btn-sm" onClick={() => s.step(-1)} disabled={s.i === 0} aria-label="Previous step">
        <ChevronLeft size={12} />
      </button>
      <button className="btn btn-sm btn-amber w-[70px]" onClick={s.toggle}>
        {s.playing ? <Pause size={12} /> : <Play size={12} />} {s.playing ? "Pause" : "Play"}
      </button>
      <button className="btn btn-sm" onClick={() => s.step(1)} disabled={s.i >= s.count - 1} aria-label="Next step">
        <ChevronRight size={12} />
      </button>
      <button className="btn btn-sm" onClick={s.end} aria-label="Jump to end">
        <SkipForward size={12} />
      </button>
      <input
        type="range"
        min={0}
        max={s.count - 1}
        value={s.i}
        onChange={(e) => s.step(Number(e.target.value) - s.i)}
        className="w-[140px] accent-[rgb(var(--amber))]"
        aria-label={`${label} scrubber`}
      />
      <span className="readout text-[11.5px] text-ink-2 w-[90px]">
        {label} {s.i + 1}/{s.count}
      </span>
      <Seg
        label="Playback speed"
        value={s.speed}
        onChange={s.setSpeed}
        options={[
          { value: 900, label: "0.5×" },
          { value: 500, label: "1×" },
          { value: 200, label: "2.5×" },
          { value: 60, label: "8×" },
        ]}
      />
    </div>
  );
}

// ------------------------------------------------------------ inputs

export function parseNums(text: string): number[] | null {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  const nums = parts.map(Number);
  return nums.every((n) => Number.isFinite(n)) ? nums : null;
}

export function NumListField({ label, value, onChange, width = "w-full", hint }: { label: string; value: string; onChange: (v: string) => void; width?: string; hint?: string }) {
  const bad = parseNums(value) == null;
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="label">{label}</span>
      <input className={`field ${width} ${bad ? "border-alert/70" : ""}`} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      {hint && <span className="text-[10.5px] text-ink-3">{hint}</span>}
    </label>
  );
}

export function NumField({ label, value, onChange, min, max, width = "w-20" }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; width?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="label">{label}</span>
      <input
        type="number"
        className={`field ${width}`}
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(min != null && v < min ? min : max != null && v > max ? max : v);
        }}
      />
    </label>
  );
}

// ------------------------------------------------------------ frame

/** Standard Lab layout: configuration panel, visualisation, metrics and explanation. */
export function LabFrame({
  title,
  code,
  config,
  controls,
  children,
  explanation,
}: {
  title: string;
  code: string;
  config: ReactNode;
  controls?: ReactNode;
  children: ReactNode;
  explanation?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 min-w-0">
      <Panel title={`${title} · input`} code={code} actions={<SimBadge />}>
        {config}
      </Panel>
      <Panel title={`${title} · execution`} code={`${code}-V`} actions={controls} bodyClassName="p-3 flex flex-col gap-3">
        {children}
      </Panel>
      {explanation && (
        <Panel title="Explanation" code={`${code}-E`}>
          <div className="text-[12px] text-ink-2 leading-relaxed max-w-[900px] space-y-1.5">{explanation}</div>
        </Panel>
      )}
    </div>
  );
}

// ------------------------------------------------------------ visual atoms

/** Stable, distinguishable fills for simulated entities (processes, files…). Simulation-only — never used for live metrics. */
const ENTITY = ["#3D8FE0", "#C26B2E", "#2AA198", "#B455C9", "#8A9A2E", "#D8627A", "#5E7CE0", "#B08A2E"];
export const entityColor = (key: string, keys: string[]) => ENTITY[Math.max(0, keys.indexOf(key)) % ENTITY.length];

export function Gantt({ segments, keys, cursor, unitWidth, label }: { segments: { pid: string | null; start: number; end: number; level?: number }[]; keys: string[]; cursor?: number; unitWidth?: number; label?: string }) {
  const end = segments.length ? segments[segments.length - 1].end : 0;
  const uw = unitWidth ?? Math.max(14, Math.min(40, 900 / Math.max(1, end)));
  return (
    <div className="overflow-x-auto pb-1 pl-2" aria-label={label ?? "Gantt chart"}>
      <div className="relative" style={{ width: end * uw + 2, height: 52 }}>
        {segments.map((g, i) => (
          <div
            key={i}
            className="absolute top-0 h-[30px] flex items-center justify-center text-[11px] font-mono border-r-2 border-panel-sunk"
            style={{
              left: g.start * uw,
              width: (g.end - g.start) * uw,
              background: g.pid ? entityColor(g.pid, keys) : "repeating-linear-gradient(45deg, rgb(var(--steel-dim)) 0 4px, transparent 4px 8px)",
              color: g.pid ? "#0d0f10" : "rgb(var(--ink-3))",
              opacity: cursor != null && g.start > cursor ? 0.18 : 1,
              borderRadius: 2,
            }}
            title={`${g.pid ?? "idle"} ${g.start}–${g.end}${g.level != null ? ` (Q${g.level})` : ""}`}
          >
            {(g.end - g.start) * uw >= 18 ? (g.pid ?? "idle") : ""}
            {g.level != null && (g.end - g.start) * uw >= 36 && <sub className="ml-0.5 opacity-70">Q{g.level}</sub>}
          </div>
        ))}
        {Array.from({ length: end + 1 }, (_, t) => (
          <span key={t} className="absolute top-[33px] text-[9.5px] font-mono text-ink-3 -translate-x-1/2" style={{ left: t * uw }}>
            {end <= 40 || t % 5 === 0 ? t : ""}
          </span>
        ))}
        {cursor != null && <div className="absolute top-[-3px] h-[36px] w-[2px] bg-amber transition-[left] duration-150" style={{ left: (cursor + 1) * uw - 1 }} />}
      </div>
    </div>
  );
}

export function Chip({ children, color, dim, title }: { children: ReactNode; color?: string; dim?: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center h-6 px-2 rounded-sm font-mono text-[11.5px] transition-all duration-200 ${dim ? "opacity-40" : ""}`}
      style={color ? { background: color, color: "#0d0f10" } : { background: "rgb(var(--panel-raised))", border: "1px solid rgb(var(--steel))" }}
    >
      {children}
    </span>
  );
}

export function Metric({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="recess px-2.5 py-1.5 min-w-0">
      <div className="label truncate">{label}</div>
      <div className="readout text-[16px] text-ink truncate">{value}</div>
      {sub && <div className="text-[10.5px] text-ink-3 truncate">{sub}</div>}
    </div>
  );
}

export function Lane({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 min-h-[30px]">
      <span className="label w-[92px] shrink-0">{label}</span>
      <div className="flex flex-wrap gap-1 items-center min-w-0">{children}</div>
    </div>
  );
}
