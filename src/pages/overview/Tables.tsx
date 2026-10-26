import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { FolderOpen } from "lucide-react";
import { Empty, ErrorNote, Led, Panel, Progress, statusTone } from "../../components/industrial/Panel";
import { api, errorText, isTauri } from "../../lib/backend";
import { useEngine, useFinishedVersion } from "../../lib/engine/store";
import { bytes, dateTime, duration, OP_LABEL, POLICY_LABEL } from "../../lib/format";
import type { JobRecord } from "../../lib/types";

export function useJobRecords(limit: number) {
  const version = useFinishedVersion();
  const snap = useEngine();
  const count = snap?.jobs.length ?? 0;
  const [rows, setRows] = useState<JobRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!isTauri) {
      setError("Experiment history is stored by the desktop backend, which is not connected.");
      return;
    }
    let live = true;
    api
      .listJobs(limit)
      .then((r) => live && (setRows(r), setError(null)))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [limit, version, count, nonce]);
  return { rows, error, reload: () => setNonce((n) => n + 1) };
}

export function CurrentTasks() {
  const snap = useEngine();
  const jobs = snap?.jobs ?? [];
  return (
    <Panel title="Current Session Tasks" code="F1" status={{ tone: jobs.some((j) => j.status === "running") ? "amber" : "off", label: `${jobs.length} tasks` }} bodyClassName="overflow-auto max-h-[220px]">
      {jobs.length === 0 ? (
        <Empty title="No tasks in this session">Tasks you start in the Workspace appear here with live progress.</Empty>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Task</th>
              <th>Operation</th>
              <th>Policy</th>
              <th>Status</th>
              <th className="w-[110px]">Progress</th>
              <th className="text-right">Workers</th>
              <th className="text-right">Duration</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td className="max-w-[160px] truncate" title={j.name}>
                  <span className="readout text-ink-3 mr-1.5">#{j.id}</span>
                  {j.name}
                </td>
                <td className="text-ink-2">{j.opLabel}</td>
                <td className="text-ink-2">{POLICY_LABEL[j.policy]}</td>
                <td>
                  <span className="flex items-center gap-1.5">
                    <Led tone={statusTone(j.status)} />
                    {j.status}
                  </span>
                </td>
                <td>
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <Progress value={j.progress} tone={j.status === "completed" ? "ok" : "amber"} />
                    </div>
                    <span className="readout text-[11px] w-9 text-right">{(j.progress * 100).toFixed(0)}%</span>
                  </div>
                </td>
                <td className="readout text-right" title="CPU time is attributable to FlowDesk as a whole, not per task">
                  {j.activeWorkers}
                </td>
                <td className="readout text-right">{duration(j.elapsedMs)}</td>
                <td className="text-right">
                  {j.reportPath && (
                    <button className="btn btn-sm" onClick={() => void api.openPath(j.reportPath!, true)} title="Show report">
                      <FolderOpen size={12} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

export function RecentExperiments() {
  const { rows, error } = useJobRecords(8);
  return (
    <Panel
      title="Recent Experiments"
      code="F2"
      status={{ tone: rows ? "ok" : "off", label: "SQLite" }}
      actions={
        <Link to="/experiments" className="btn btn-sm">
          All
        </Link>
      }
      bodyClassName="overflow-auto max-h-[220px]"
    >
      {error ? (
        <div className="p-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : !rows ? null : rows.length === 0 ? (
        <Empty title="No saved experiments yet">Every completed, cancelled or failed task is recorded with its telemetry.</Empty>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Experiment</th>
              <th>Operation</th>
              <th>Policy</th>
              <th>Status</th>
              <th className="text-right">Files</th>
              <th className="text-right">Bytes</th>
              <th className="text-right">Duration</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="max-w-[160px] truncate" title={r.name}>
                  <span className="readout text-ink-3 mr-1.5">#{r.id}</span>
                  {r.name}
                </td>
                <td className="text-ink-2">{OP_LABEL[r.op]}</td>
                <td className="text-ink-2">{POLICY_LABEL[r.policy]}</td>
                <td>
                  <span className="flex items-center gap-1.5">
                    <Led tone={statusTone(r.status)} />
                    {r.status}
                  </span>
                </td>
                <td className="readout text-right">{r.files_done}</td>
                <td className="readout text-right">{bytes(r.bytes_done)}</td>
                <td className="readout text-right">{r.started_at && r.ended_at ? duration(r.ended_at - r.started_at) : "—"}</td>
                <td className="readout text-ink-3">{dateTime(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
