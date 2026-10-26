import { useState } from "react";
import { Link } from "react-router-dom";
import { Ban, Pause, Play, Workflow } from "lucide-react";
import { Empty, ErrorNote, Panel, Progress, Readout, statusTone } from "../../components/industrial/Panel";
import { api, errorText } from "../../lib/backend";
import { bytes, duration, POLICY_LABEL, rate } from "../../lib/format";
import type { JobView } from "../../lib/types";

export function TaskControls({ job, compact }: { job: JobView; compact?: boolean }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await f();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const live = job.status === "running" || job.status === "queued" || job.status === "paused";
  if (!live) return null;
  const sm = compact ? "btn-sm" : "";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        {job.status === "paused" ? (
          <button className={`btn ${sm}`} disabled={busy} onClick={() => run(() => api.resumeJob(job.id))}>
            <Play size={12} /> Resume
          </button>
        ) : (
          <button className={`btn ${sm}`} disabled={busy} onClick={() => run(() => api.pauseJob(job.id))}>
            <Pause size={12} /> Pause
          </button>
        )}
        <button className={`btn btn-danger ${sm}`} disabled={busy} onClick={() => run(() => api.cancelJob(job.id))}>
          <Ban size={12} /> Cancel
        </button>
      </div>
      {err && <ErrorNote>{err}</ErrorNote>}
    </div>
  );
}

export function ActiveTask({ job }: { job: JobView | null }) {
  if (!job) {
    return (
      <Panel title="Active Task" code="D" status={{ tone: "off", label: "none" }}>
        <Empty icon={<Workflow size={22} />} title="No task has run this session">
          Create a workload in the <Link className="text-amber underline-offset-2 hover:underline" to="/workspace">Workspace</Link>: pick a folder, an operation and a scheduling policy.
        </Empty>
      </Panel>
    );
  }
  const content = job.op === "hash" || job.op === "duplicates" || job.op === "copy";
  const tone = statusTone(job.status);
  return (
    <Panel
      title={`Task #${job.id}`}
      code="D"
      status={{ tone, label: job.status, pulse: job.status === "running" }}
      bodyClassName="p-3 flex flex-col gap-2.5"
    >
      <div className="min-w-0">
        <div className="text-[14px] font-medium truncate" title={job.name}>{job.name}</div>
        <div className="text-[11.5px] text-ink-3 truncate">
          {job.opLabel} · {POLICY_LABEL[job.policy]} · P{job.priority}
        </div>
      </div>
      <div>
        <div className="flex items-baseline justify-between mb-1">
          <span className="readout text-[22px] text-amber">{(job.progress * 100).toFixed(1)}%</span>
          <span className="readout text-[11px] text-ink-3">{content ? "by bytes" : "by files"}</span>
        </div>
        <Progress value={job.progress} tone={job.status === "completed" ? "ok" : job.status === "failed" ? "alert" : "amber"} label="Task progress" />
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <Readout label="Files" value={`${job.filesDone + job.filesFailed + job.filesSkipped} / ${job.filesTotal}`} />
        <Readout label="Bytes" value={bytes(job.bytesDone)} sub={`of ${bytes(job.bytesTotal)}`} />
        <Readout label="Elapsed" value={duration(job.elapsedMs)} />
        <Readout
          label="Remaining"
          value={job.etaMs != null ? duration(job.etaMs) : job.status === "running" ? "estimating" : "—"}
          tone={job.etaMs == null ? "dim" : undefined}
        />
        <Readout label="Rate" value={content ? rate(job.rateBps) : `${job.rateFps.toFixed(0)} files/s`} />
        <Readout label="Workers" value={`${job.activeWorkers}`} sub={`${job.preemptions} preemptions`} />
      </div>
      {job.errorCount > 0 && (
        <div className="text-[11px] text-amber truncate" title={job.errors.join("\n")}>
          {job.errorCount} issue(s): {job.errors[0]}
        </div>
      )}
      <div className="mt-auto">
        <TaskControls job={job} />
      </div>
    </Panel>
  );
}
