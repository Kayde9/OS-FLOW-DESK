import { useEffect, useState } from "react";
import { Ban, Download, Play, Radar, Square } from "lucide-react";
import { Led, Readout, type Tone } from "../../components/industrial/Panel";
import { api, errorText, pickSavePath } from "../../lib/backend";
import { duration } from "../../lib/format";
import { clockUs, compact } from "../../lib/trace/analysis";
import type { ExportFormat, Redact, SessionState, TraceStats } from "../../lib/trace/types";

export const STATE_TONE: Record<SessionState, Tone> = {
  idle: "off",
  preparing: "amber",
  capturing: "ok",
  stopping: "amber",
  finalizing: "amber",
  completed: "info",
  failed: "alert",
  cancelled: "off",
};

export const STATE_LABEL: Record<SessionState, string> = {
  idle: "Idle",
  preparing: "Preparing session",
  capturing: "Capturing",
  stopping: "Stopping · flushing ETW buffers",
  finalizing: "Finalizing · saving",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const ACTIVE = new Set<SessionState>(["preparing", "capturing", "stopping", "finalizing"]);

function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

export interface HeaderModel {
  state: SessionState;
  title: string;
  target: string;
  mode: string | null;
  startedAt: number | null;
  endedAt: number | null;
  events: number | null;
  lastEventUs: number | null;
  loss: number | null;
  lossNote: string;
  sessionId: number | null;
  saved: boolean;
}

export function CommandHeader({
  m,
  canStart,
  startHint,
  starting,
  onStart,
  onStop,
  onCancel,
}: {
  m: HeaderModel;
  canStart: boolean;
  startHint: string | null;
  starting: boolean;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
}) {
  const active = ACTIVE.has(m.state);
  const now = useNow(active);
  const elapsed = m.startedAt ? (m.endedAt ?? (active ? now : m.startedAt)) - m.startedAt : null;
  return (
    <section className="panel rivets px-5 py-2.5 flex items-center gap-5 min-w-0" aria-label="Tracing command header">
      <div className="flex items-center gap-3 min-w-0 shrink-0">
        <div className="w-9 h-9 recess flex items-center justify-center">
          <Radar size={18} className={m.state === "capturing" ? "text-ok" : "text-amber"} />
        </div>
        <div className="min-w-0">
          <h1 className="text-[14px] font-semibold tracking-wide leading-tight">
            System Call Observatory <span className="text-amber">— ETW Mode</span>
          </h1>
          <div className="text-[11px] text-ink-3 leading-tight" title="Captures Windows ETW file, process/thread and disk events plus FlowDesk workload events. Native syscall entry/exit is not captured.">
            Kernel-File · Kernel-Process · Kernel-Disk · FlowDesk engine — no native syscall entry/exit
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 min-w-[190px]" role="status" aria-live="polite">
        <Led tone={STATE_TONE[m.state]} pulse={m.state === "capturing" || m.state === "stopping" || m.state === "finalizing" || m.state === "preparing"} />
        <div className="leading-tight min-w-0">
          <div className="text-[12.5px] font-medium">{STATE_LABEL[m.state]}</div>
          <div className="text-[11px] text-ink-3 truncate" title={m.title}>
            {m.sessionId != null ? `#${m.sessionId} · ` : ""}
            {m.mode ?? "no session"}
            {m.saved && " · saved"}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(150px,1.4fr)_repeat(4,minmax(78px,1fr))] gap-4 flex-1 min-w-0">
        <Readout label="Target" value={<span className="text-[13px]">{m.target}</span>} />
        <Readout label="Duration" value={elapsed != null ? duration(elapsed) : "—"} />
        <Readout label="Events" value={m.events != null ? compact(m.events) : "—"} />
        <Readout label="Latest event" value={<span className="text-[13px]">{m.lastEventUs ? clockUs(m.lastEventUs).slice(0, 12) : "—"}</span>} />
        <Readout
          label="Lost / dropped"
          value={m.loss == null ? <span className="text-ink-3 text-[12px]" title={m.lossNote}>N/A</span> : m.loss}
          tone={m.loss ? "alert" : m.loss === 0 ? "ok" : "dim"}
          sub={<span title={m.lossNote}>{m.loss == null ? m.lossNote : "ETW + FlowDesk queue"}</span>}
        />
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button className="btn btn-amber" disabled={!canStart || active || starting} onClick={onStart} title={startHint ?? "Start capture"}>
          <Play size={14} /> {starting ? "Starting…" : "Start capture"}
        </button>
        <button className="btn" disabled={m.state !== "capturing"} onClick={onStop} title="Stop capture, flush buffers and save">
          <Square size={13} /> Stop
        </button>
        <button className="btn btn-danger" disabled={m.state !== "capturing" && m.state !== "preparing"} onClick={onCancel} title="Stop capture, cancel the linked workload, keep events captured so far">
          <Ban size={13} /> Cancel
        </button>
      </div>
    </section>
  );
}

export function StatsStrip({ stats, rate, live, mode }: { stats: TraceStats | null; rate: number | null; live: boolean; mode: string | null }) {
  if (!stats) {
    return (
      <div className="panel px-4 py-2.5 text-[12px] text-ink-3 flex items-center gap-2">
        <Led tone="off" /> No session — configure a target and start a capture. Statistics are calculated from the captured session only.
      </div>
    );
  }
  const c = stats.byCategory;
  const proc = (c.process ?? 0) + (c.thread ?? 0) + (c.image ?? 0);
  const etwCount = Object.entries(c).reduce((n, [k, v]) => (k === "workload" ? n : n + v), 0);
  const etw = mode === "etw";
  return (
    <div className="panel px-4 py-2 grid grid-cols-8 gap-4" aria-label="Session statistics">
      <Readout label="ETW events" value={etwCount.toLocaleString()} sub={etw ? "Windows ETW providers" : "ETW not enabled"} tone={etw ? undefined : "dim"} />
      <Readout label="FlowDesk events" value={(c.workload ?? 0).toLocaleString()} sub="engine events (not OS)" />
      <Readout label="Events / s" value={live && rate != null ? rate.toFixed(0) : "—"} sub={live ? "from capture counter" : "live only"} tone={live ? "amber" : "dim"} />
      <Readout label="File I/O" value={(c.file ?? 0).toLocaleString()} sub={`${stats.completions.toLocaleString()} completions`} />
      <Readout label="Process / thread" value={proc.toLocaleString()} sub={`${(c.disk ?? 0).toLocaleString()} disk`} />
      <Readout label="Error results" value={stats.errors.toLocaleString()} tone={stats.errors ? "alert" : undefined} sub="NTSTATUS warning/error" />
      <Readout
        label="ETW delivered"
        value={etw ? compact(stats.etwDelivered) : "—"}
        sub={etw ? `${compact(stats.filteredOut)} filtered · ${compact(stats.selfExcluded)} self` : "no ETW session"}
      />
      <Readout
        label="Loss / buffers"
        value={etw ? `${stats.etwEventsLost ?? "?"} / ${stats.etwRtBuffersLost ?? "?"}` : "—"}
        tone={(stats.etwEventsLost ?? 0) + (stats.etwRtBuffersLost ?? 0) + stats.queueDropped > 0 ? "alert" : etw ? "ok" : "dim"}
        sub={`queue drops ${stats.queueDropped}${stats.notStreamed ? ` · ${compact(stats.notStreamed)} not streamed` : ""}`}
      />
    </div>
  );
}

export function ExportControls({ sessionId, name, compact: small }: { sessionId: number; name: string; compact?: boolean }) {
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [redact, setRedact] = useState<Redact>("user");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async () => {
    setMsg(null);
    const ext = format === "summary" ? "md" : format;
    const base = `flowdesk-trace-${sessionId}-${name.replace(/[^\w.-]+/g, "_").slice(0, 40)}`;
    try {
      const path = await pickSavePath(`${base}.${ext}`, { name: format === "summary" ? "Markdown" : format.toUpperCase(), extensions: [ext] });
      if (!path) return;
      const n = await api.traceExport(sessionId, format, path, redact);
      setMsg({ ok: true, text: format === "summary" ? `Summary written (${n.toLocaleString()} events summarized)` : `${n.toLocaleString()} events written` });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  };
  return (
    <div className={`flex items-center gap-2 flex-wrap ${small ? "" : "text-[12px]"}`}>
      <select className="field h-7" value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)} aria-label="Export format">
        <option value="csv">Normalized events · CSV</option>
        <option value="json">Normalized events · JSON</option>
        <option value="summary">Summary report · Markdown</option>
      </select>
      <select className="field h-7" value={redact} onChange={(e) => setRedact(e.target.value as Redact)} aria-label="Path redaction">
        <option value="none">Paths as captured</option>
        <option value="user">Redact user folder</option>
        <option value="paths">Pseudonymize all paths</option>
      </select>
      <button className="btn btn-sm h-7" onClick={() => void run()}>
        <Download size={12} /> Export…
      </button>
      {msg && <span className={`text-[11.5px] ${msg.ok ? "text-ok" : "text-alert"}`}>{msg.text}</span>}
    </div>
  );
}
