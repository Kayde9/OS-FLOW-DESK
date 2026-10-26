import type { ReactNode } from "react";
import { Cpu, FileOutput, FolderInput, FolderOpen, ListOrdered, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { Led, type Tone } from "../../components/industrial/Panel";
import { api, errorText } from "../../lib/backend";
import { browseFolder, useEngine, useSelection } from "../../lib/engine/store";
import { bytes, POLICY_LABEL, rate, shortPath } from "../../lib/format";
import type { EngineSnapshot, JobView } from "../../lib/types";

/** The job the pipeline follows: a running task, else the latest one. */
export function focusJob(snap: EngineSnapshot | null): JobView | null {
  if (!snap || !snap.jobs.length) return null;
  return snap.jobs.find((j) => j.status === "running") ?? snap.jobs.find((j) => j.status === "paused" || j.status === "queued") ?? snap.jobs[0];
}

/** True only while the backend reports real progress (EWMA of measured deltas). */
export function isFlowing(j: JobView | null) {
  return !!j && j.status === "running" && (j.rateBps > 1024 || j.rateFps > 0.05);
}

function Stage({ code, title, icon, tone, statusLabel, children, footer }: { code: string; title: string; icon: ReactNode; tone: Tone; statusLabel: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="panel flex flex-col min-w-0 flex-1">
      <div className="panel-head">
        <span className="font-mono text-amber/80 tracking-normal">{code}</span>
        <span className="text-ink-3">{icon}</span>
        <span className="text-ink-2">{title}</span>
        <span className="ml-auto flex items-center gap-1.5 normal-case tracking-normal font-normal text-[10.5px] text-ink-3">
          <Led tone={tone} pulse={tone === "amber"} />
          {statusLabel}
        </span>
      </div>
      <div className="flex-1 px-2.5 py-2 flex flex-col gap-1 min-h-0">{children}</div>
      {footer && <div className="px-2.5 pb-2">{footer}</div>}
    </div>
  );
}

function KV({ k, v, title }: { k: string; v: ReactNode; title?: string }) {
  return (
    <div className="flex items-baseline gap-2 text-[12px] min-w-0" title={title}>
      <span className="text-ink-3 shrink-0 text-[11px]">{k}</span>
      <span className="readout text-ink ml-auto truncate text-right">{v}</span>
    </div>
  );
}

function Conduit({ flowing, label }: { flowing: boolean; label?: string }) {
  return (
    <div className="w-7 shrink-0 flex flex-col items-center justify-center gap-1" aria-hidden>
      <div className={`conduit h-[2px] w-full ${flowing ? "flowing" : ""}`} />
      <svg width="8" height="10" viewBox="0 0 8 10" className={flowing ? "text-amber" : "text-steel"}>
        <path d="M0 0 L8 5 L0 10 Z" fill="currentColor" />
      </svg>
      {label && <span className="readout text-[9px] text-ink-3">{label}</span>}
    </div>
  );
}

export function Pipeline() {
  const snap = useEngine();
  const sel = useSelection();
  const job = focusJob(snap);
  const flowing = isFlowing(job);
  const busy = snap?.workers.filter((w) => w.state === "busy") ?? [];
  const configured = snap?.config.workers ?? 0;
  const queuedUnits = snap?.jobs.reduce((n, j) => n + (j.status === "running" || j.status === "queued" ? j.queuedUnits : 0), 0) ?? 0;
  const completedTasks = snap?.jobs.filter((j) => j.status === "completed").length ?? 0;
  const lastDecision = snap?.decisions[0];
  const live = job && (job.status === "running" || job.status === "paused" || job.status === "queued");
  const outputPath = job?.op === "copy" ? job.dest : job?.reportPath;

  const open = async (path: string, reveal: boolean) => {
    try {
      await api.openPath(path, reveal);
    } catch (e) {
      alert(errorText(e));
    }
  };

  return (
    <div className="flex items-stretch min-h-[178px]">
      <Stage
        code="C1"
        title="Input"
        icon={<FolderInput size={13} />}
        tone={sel.scanning ? "info" : sel.scan ? "ok" : sel.error ? "alert" : "off"}
        statusLabel={sel.scanning ? "scanning" : sel.scan ? "ready" : sel.error ? "error" : "no folder"}
        footer={
          <button className="btn btn-sm w-full" onClick={() => void browseFolder()}>
            <FolderOpen size={12} /> {sel.folder ? "Change folder" : "Select folder"}
          </button>
        }
      >
        <KV k="Directory" v={shortPath(sel.folder ?? job?.folder, 30)} title={sel.folder ?? job?.folder ?? undefined} />
        <KV k="Files" v={sel.scan ? sel.scan.files.toLocaleString() : job ? job.filesTotal.toLocaleString() : "—"} />
        <KV k="Total size" v={sel.scan ? bytes(sel.scan.bytes) : job ? bytes(job.bytesTotal) : "—"} />
        {sel.error && <div className="text-[11px] text-alert truncate" title={sel.error}>{sel.error}</div>}
        {sel.scan && sel.scan.errors > 0 && <div className="text-[11px] text-amber">{sel.scan.errors} entries unreadable</div>}
      </Stage>
      <Conduit flowing={flowing} />
      <Stage
        code="C2"
        title="Scheduler"
        icon={<ListOrdered size={13} />}
        tone={snap ? (snap.runnableTasks > 0 ? "amber" : "ok") : "off"}
        statusLabel={snap ? (snap.runnableTasks > 0 ? "dispatching" : "standing by") : "offline"}
      >
        <KV k="Policy" v={snap ? POLICY_LABEL[snap.config.policy] : "—"} />
        <KV k="Ready tasks" v={snap ? snap.runnableTasks : "—"} />
        <KV
          k={snap?.config.policy === "round_robin" ? "Quantum" : "Priority"}
          v={snap ? (snap.config.policy === "round_robin" ? `${snap.config.quantumMs} ms` : job ? `P${job.priority}` : "—") : "—"}
        />
        <KV k="Selected" v={lastDecision ? `#${lastDecision.jobId}` : "—"} />
        <div className="text-[10.5px] text-ink-3 leading-snug line-clamp-2" title={lastDecision?.reason}>
          {lastDecision ? lastDecision.reason : "No dispatch decisions yet"}
        </div>
      </Stage>
      <Conduit flowing={flowing} />
      <Stage
        code="C3"
        title="Workers"
        icon={<Users size={13} />}
        tone={busy.length ? "amber" : snap ? "ok" : "off"}
        statusLabel={busy.length ? `${busy.length} busy` : snap ? "idle" : "offline"}
      >
        <KV k="Active / pool" v={snap ? `${busy.length} / ${configured}` : "—"} />
        <KV k="Queued units" v={snap ? queuedUnits.toLocaleString() : "—"} />
        <KV k="Tasks done" v={snap ? completedTasks : "—"} />
        <div className="flex flex-wrap gap-1 pt-0.5" aria-label="Worker status">
          {snap?.workers.map((w) => (
            <span
              key={w.id}
              title={`Worker ${w.id}: ${w.state}${w.file ? ` — ${w.file}` : ""}`}
              className={`readout text-[9.5px] w-[22px] h-[16px] flex items-center justify-center rounded-sm border ${
                w.state === "busy" ? "border-amber/60 text-amber bg-amber/10" : w.state === "idle" ? "border-steel text-ink-2" : "border-steel-dim text-ink-3/50"
              }`}
            >
              W{w.id}
            </span>
          ))}
        </div>
        <div className="text-[10.5px] text-ink-3 truncate" title={busy[0]?.file ?? undefined}>
          {busy[0]?.file ? `W${busy[0].id}: ${busy[0].file}` : "No file in flight"}
        </div>
      </Stage>
      <Conduit flowing={flowing} />
      <Stage
        code="C4"
        title="File Processor"
        icon={<Cpu size={13} />}
        tone={flowing ? "amber" : job?.status === "paused" ? "info" : live ? "info" : "off"}
        statusLabel={flowing ? "processing" : job?.status === "paused" ? "paused" : live ? "waiting" : "idle"}
      >
        <KV k="Operation" v={job ? job.opLabel : "—"} />
        <KV k="File" v={live && job.currentFiles[0] ? shortPath(job.currentFiles[0], 26) : "—"} title={live ? job.currentFiles.join("\n") : undefined} />
        <KV k="Rate" v={live ? (job.op === "index" || job.op === "metadata" ? `${job.rateFps.toFixed(0)} files/s` : rate(job.rateBps)) : "—"} />
        <KV k="Processed" v={job ? bytes(job.bytesDone) : "—"} />
        <KV k="Errors / skipped" v={job ? `${job.filesFailed} / ${job.filesSkipped}` : "—"} />
      </Stage>
      <Conduit flowing={flowing} />
      <Stage
        code="C5"
        title="Output"
        icon={<FileOutput size={13} />}
        tone={job?.status === "completed" ? "ok" : job?.status === "failed" ? "alert" : job?.status === "cancelled" ? "amber" : live ? "info" : "off"}
        statusLabel={job ? job.status : "no output"}
        footer={
          outputPath ? (
            <button className="btn btn-sm w-full" onClick={() => void open(outputPath, true)}>
              <FolderOpen size={12} /> Open results
            </button>
          ) : (
            <Link to="/workspace" className="btn btn-sm w-full">
              Create task
            </Link>
          )
        }
      >
        <KV k="Completed" v={job ? `${job.filesDone.toLocaleString()} / ${job.filesTotal.toLocaleString()}` : "—"} />
        <KV k="Succeeded" v={job ? <span className="text-ok">{job.filesDone}</span> : "—"} />
        <KV k="Failed" v={job ? <span className={job.filesFailed ? "text-alert" : ""}>{job.filesFailed}</span> : "—"} />
        <KV k="Location" v={shortPath(outputPath, 26)} title={outputPath ?? undefined} />
      </Stage>
    </div>
  );
}
