import { useMemo } from "react";
import { Copy, Crosshair, Pin, PinOff, X } from "lucide-react";
import { bytes } from "../../lib/format";
import { clockUs, durUs, related } from "../../lib/trace/analysis";
import type { TraceEvent } from "../../lib/trace/types";
import { CatLabel, SourceBadge } from "./categories";
import { interval, series, type TelSeries } from "./telemetry";

const ANNOTATIONS: Record<string, string> = {
  _keyword: "Event keyword mask",
  _headerProcessId: "Header process id (logging context)",
  _headerThreadId: "Header thread id (logging context)",
  _undecoded: "Payload not fully decoded",
  _path: "Path",
  _attribution: "Attributed to target by",
  completionExtraInformation: "OperationEnd ExtraInformation",
};

function Row({ k, v, mono = true }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-ink-3 truncate" title={k}>{k}</dt>
      <dd className={`${mono ? "readout" : ""} text-ink break-all selectable`}>{v}</dd>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-steel-dim/70 px-3 py-2.5">
      <h3 className="label mb-1.5">{title}</h3>
      {children}
    </section>
  );
}

export function Inspector({
  e,
  events,
  tel,
  pinned,
  onClose,
  onSelect,
  onPin,
  onJump,
}: {
  e: TraceEvent;
  events: TraceEvent[];
  tel: TelSeries[];
  pinned: boolean;
  onClose: () => void;
  onSelect: (seq: number) => void;
  onPin: () => void;
  onJump: () => void;
}) {
  const rel = useMemo(() => related(events, e, 10), [events, e]);
  const provider = Object.entries(e.fields).filter(([k]) => !k.startsWith("_") && k !== "completionExtraInformation" && k !== "jobId" && k !== "worker" && k !== "detail");
  const notes = Object.entries(e.fields).filter(([k]) => k in ANNOTATIONS);
  const app = e.source === "flowdesk";
  const tMs = e.tsUs / 1000;
  const telRows = ["cpu", "app_cpu", "disk_read", "disk_write", "mem_used", "gpu_util", "cpu_temp"].map((m) => series(tel, m)).filter((s): s is TelSeries => !!s);

  return (
    <aside className="flex flex-col min-h-0 h-full bg-panel border-l border-steel-dim" aria-label="Event inspector">
      <header className="panel-head shrink-0">
        <span className="font-mono text-amber/80 tracking-normal">#{e.seq}</span>
        <h2 className="truncate text-ink-2">Event inspector</h2>
        <div className="ml-auto flex gap-1 normal-case tracking-normal font-normal">
          <button className="btn btn-sm" onClick={onJump} title="Center the timeline on this event"><Crosshair size={12} /></button>
          <button className="btn btn-sm" onClick={onPin} title={pinned ? "Unpin" : "Pin"}>{pinned ? <PinOff size={12} /> : <Pin size={12} />}</button>
          <button className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(e, null, 2))} title="Copy normalized JSON"><Copy size={12} /></button>
          <button className="btn btn-sm" onClick={onClose} aria-label="Close inspector"><X size={12} /></button>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto text-[12px]">
        <div className="px-3 py-2.5">
          <div className="text-[15px] font-semibold text-ink truncate" title={e.eventName}>{e.eventName}</div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <CatLabel category={e.category} />
            <SourceBadge source={e.source} />
          </div>
        </div>

        <Section title="Identity">
          <dl className="grid grid-cols-[112px_1fr] gap-x-2 gap-y-1">
            <Row k="Provider" v={e.provider} mono={false} />
            {e.eventId != null && <Row k="Event id / ver." v={`${e.eventId} / v${e.version ?? "?"}${e.opcode != null ? ` · opcode ${e.opcode}` : ""}`} />}
            <Row k="Event time" v={clockUs(e.tsUs)} />
            <Row k="Processed" v={`${clockUs(e.recvUs)} (+${durUs(Math.max(0, e.recvUs - e.tsUs))})`} />
            {e.cpu != null && <Row k="CPU" v={e.cpu} />}
            <Row k="Process" v={`${e.processName ?? "—"} · PID ${e.pid ?? "—"}`} />
            <Row k="Thread" v={e.tid != null ? `${e.threadName ? `${e.threadName} · ` : ""}TID ${e.tid}` : "not attributed to a thread"} />
          </dl>
        </Section>

        <Section title={app ? "Workload operation" : "Operation"}>
          <dl className="grid grid-cols-[112px_1fr] gap-x-2 gap-y-1">
            {e.operation && <Row k="Operation" v={e.operation} />}
            {e.filePath && <Row k="File path" v={e.filePath} />}
            {e.size != null && <Row k="Size" v={`${bytes(e.size)} (${e.size.toLocaleString()} B)`} />}
            {e.offset != null && <Row k="Offset" v={e.offset.toLocaleString()} />}
            {app && e.fields.jobId != null && <Row k="Task" v={`#${String(e.fields.jobId)}${e.fields.worker != null ? ` · worker W${String(e.fields.worker)}` : ""}`} />}
            {app && e.fields.detail != null && <Row k="Detail" v={String(e.fields.detail)} mono={false} />}
            {!app && (
              <Row
                k="Duration"
                mono={false}
                v={
                  e.durationUs != null ? (
                    <span>
                      <span className="readout">{durUs(e.durationUs)}</span>
                      <span className="block text-[11px] text-ink-3">OperationEnd timestamp − request timestamp, matched by IRP {String(e.fields.Irp ?? "")}.</span>
                    </span>
                  ) : e.awaitsCompletion ? (
                    <span className="text-ink-3">No completion observed — duration unknown (completion may have been lost, filtered, or after the capture ended).</span>
                  ) : (
                    <span className="text-ink-3">Point event — the provider reports no duration.</span>
                  )
                }
              />
            )}
            {e.resultCode && (
              <Row
                k="Result"
                mono={false}
                v={
                  <span>
                    <span className={`readout ${e.status === "success" ? "text-ok" : "text-alert"}`}>{e.resultCode}</span>
                    <span className="block text-[11px] text-ink-3">NTSTATUS reported by Kernel-File OperationEnd (I/O result — not a system-call return value).</span>
                  </span>
                }
              />
            )}
            {app && <Row k="Note" mono={false} v={<span className="text-ink-3">Recorded by FlowDesk's engine; it describes what FlowDesk decided, not what Windows observed.</span>} />}
          </dl>
        </Section>

        {provider.length > 0 && (
          <Section title={`Provider fields (${provider.length})`}>
            <dl className="grid grid-cols-[112px_1fr] gap-x-2 gap-y-1">
              {provider.map(([k, v]) => <Row key={k} k={k} v={String(v)} />)}
            </dl>
          </Section>
        )}
        {notes.length > 0 && (
          <Section title="FlowDesk annotations">
            <dl className="grid grid-cols-[112px_1fr] gap-x-2 gap-y-1">
              {notes.map(([k, v]) => <Row key={k} k={ANNOTATIONS[k]} v={String(v)} mono={k !== "_undecoded" && k !== "_path"} />)}
            </dl>
          </Section>
        )}

        <Section title="Nearby telemetry">
          {telRows.every((s) => !s.points.length) ? (
            <div className="text-ink-3 text-[11.5px]">No telemetry samples cover this time.</div>
          ) : (
            <table className="w-full text-[11.5px]">
              <tbody>
                {telRows.map((s) => {
                  let best: { ts: number; value: number | null } | null = null;
                  for (const pt of s.points) if (!best || Math.abs(pt.ts - tMs) < Math.abs(best.ts - tMs)) best = pt;
                  return (
                    <tr key={s.metric} className="h-5">
                      <td className="text-ink-3 pr-2">{s.label}</td>
                      <td className="readout text-right text-ink" title={s.note ?? undefined}>
                        {best?.value == null ? "N/A" : s.unit === "B/s" ? `${bytes(best.value)}/s` : s.unit === "B" ? bytes(best.value) : `${best.value.toFixed(1)} ${s.unit}`}
                      </td>
                      <td className="readout text-right text-ink-3 pl-2">{best ? `${((best.ts - tMs) / 1000).toFixed(2)} s` : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="text-[10.5px] text-ink-3 mt-1.5 leading-snug">
            Closest sample per metric (offset from this event). Sampling interval ≈ {interval(telRows[0]) ?? "—"} ms; source {telRows[0]?.source ?? "—"}. System-wide
            measurements: co-occurrence does not show that this event caused them.
          </p>
        </Section>

        <Section title={`Related events (${rel.length})`}>
          {rel.length === 0 ? (
            <div className="text-ink-3 text-[11.5px]">No other events on this thread or file.</div>
          ) : (
            <ul>
              {rel.map((r) => (
                <li key={r.seq}>
                  <button className="w-full text-left grid grid-cols-[72px_1fr_64px] gap-2 h-5 text-[11.5px] hover:bg-white/[0.03] px-1 rounded-sm" onClick={() => onSelect(r.seq)}>
                    <span className="readout text-ink-3">{((r.tsUs - e.tsUs) / 1000).toFixed(3)} ms</span>
                    <span className="truncate text-ink-2">{r.operation ?? r.eventName}</span>
                    <span className="readout text-right text-ink-3">{r.durationUs != null ? durUs(r.durationUs) : ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[10.5px] text-ink-3 mt-1">Same thread or same file, nearest in time.</p>
        </Section>
      </div>
    </aside>
  );
}
