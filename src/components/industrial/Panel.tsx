import type { ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

export type Tone = "ok" | "amber" | "alert" | "info" | "off";

export function Led({ tone = "off", pulse = false, title }: { tone?: Tone; pulse?: boolean; title?: string }) {
  const cls = tone === "off" ? "" : `led-${tone}`;
  return <span className={`led ${cls} ${pulse ? "led-pulse" : ""}`} title={title} aria-hidden={!title} />;
}

interface PanelProps {
  title: ReactNode;
  /** Short code shown before the title, e.g. "A-01". */
  code?: string;
  status?: { tone: Tone; label: string; pulse?: boolean };
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  rivets?: boolean;
  children: ReactNode;
}

export function Panel({ title, code, status, actions, className = "", bodyClassName = "panel-body", rivets, children }: PanelProps) {
  return (
    <section className={`panel flex flex-col min-w-0 ${className}`}>
      <header className={`panel-head ${rivets ? "rivets pl-5 pr-5" : ""}`}>
        {code && <span className="font-mono text-amber/80 tracking-normal">{code}</span>}
        <h2 className="truncate text-ink-2">{title}</h2>
        <div className="ml-auto flex items-center gap-2 normal-case tracking-normal font-normal">
          {actions}
          {status && (
            <span className="flex items-center gap-1.5 text-micro uppercase tracking-[0.08em] text-ink-2">
              <Led tone={status.tone} pulse={status.pulse} />
              {status.label}
            </span>
          )}
        </div>
      </header>
      <div className={`flex-1 min-h-0 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function Readout({
  label,
  value,
  unit,
  sub,
  tone,
  className = "",
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  tone?: "amber" | "ok" | "alert" | "dim";
  className?: string;
}) {
  const color = tone === "amber" ? "text-amber" : tone === "ok" ? "text-ok" : tone === "alert" ? "text-alert" : tone === "dim" ? "text-ink-3" : "text-ink";
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="label truncate">{label}</div>
      <div className={`readout text-[15px] leading-6 truncate ${color}`}>
        {value}
        {unit && <span className="text-[11px] text-ink-3 ml-1">{unit}</span>}
      </div>
      {sub && <div className="text-[11px] text-ink-3 truncate">{sub}</div>}
    </div>
  );
}

export function Progress({ value, tone = "amber", label }: { value: number; tone?: "amber" | "ok" | "alert"; label?: string }) {
  const bg =
    tone === "ok"
      ? "linear-gradient(90deg, rgb(var(--ok) / .55), rgb(var(--ok)))"
      : tone === "alert"
        ? "linear-gradient(90deg, rgb(var(--alert) / .55), rgb(var(--alert)))"
        : undefined;
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="track" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <span style={{ width: `${pct}%`, background: bg }} />
    </div>
  );
}

export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={o.value === value}
          disabled={o.disabled}
          title={o.title}
          className="disabled:opacity-40"
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="h-full min-h-[96px] flex flex-col items-center justify-center text-center gap-1.5 px-4 py-4">
      {icon && <div className="text-steel-hi">{icon}</div>}
      <div className="text-[12px] font-medium text-ink-2">{title}</div>
      {children && <div className="text-[11.5px] text-ink-3 max-w-[420px]">{children}</div>}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-ink-3 text-[12px] p-3">
      <Loader2 size={14} className="animate-spin" /> {label}…
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[12px] text-alert border border-alert/30 bg-alert/5 rounded-sm px-2.5 py-2">
      <AlertTriangle size={14} className="shrink-0 mt-px" />
      <div className="min-w-0 break-words selectable">{children}</div>
    </div>
  );
}

/** Explicit "not available" marker with the reason — never a fabricated value. */
export function NA({ reason, compact }: { reason?: string | null; compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-ink-3" title={reason ?? undefined}>
      <span className="readout px-1 rounded-sm border border-steel-dim text-[11px] leading-4">N/A</span>
      {!compact && reason && <span className="text-[11px] truncate">{reason}</span>}
    </span>
  );
}

export function SimBadge({ children = "Simulation" }: { children?: ReactNode }) {
  return <span className="sim-badge" title="Computed by FlowDesk's simulator — not measured from the operating system">{children}</span>;
}

export function LiveBadge({ children = "Live telemetry" }: { children?: ReactNode }) {
  return <span className="live-badge" title="Measured from this computer">{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="readout text-[11px] px-1.5 py-0.5 recess text-ink-2">{children}</span>;
}

export const statusTone = (status: string): Tone =>
  status === "running"
    ? "amber"
    : status === "completed"
      ? "ok"
      : status === "failed" || status === "interrupted"
        ? "alert"
        : status === "queued" || status === "paused"
          ? "info"
          : "off";
