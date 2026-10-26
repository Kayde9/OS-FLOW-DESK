import { useState } from "react";
import { FolderOpen, Trash2 } from "lucide-react";
import { ErrorNote, Panel, Readout, Seg } from "../components/industrial/Panel";
import { api, errorText, isTauri } from "../lib/backend";
import { bytes } from "../lib/format";
import { RANGES } from "../lib/telemetry/series";
import { refreshStatus, useAppStatus } from "../lib/telemetry/store";
import { savePrefs, usePrefs } from "../lib/prefs";

export default function Settings() {
  const status = useAppStatus();
  const p = usePrefs();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (f: () => Promise<string | void>) => {
    setErr(null);
    setMsg(null);
    try {
      const m = await f();
      if (m) setMsg(m);
    } catch (e) {
      setErr(errorText(e));
    }
  };

  return (
    <div className="p-3 grid gap-3 grid-cols-2 min-w-[1000px] items-start">
      <Panel title="Telemetry" code="T">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="label w-32">Sample interval</span>
            <Seg
              label="Sample interval"
              value={status?.intervalMs ?? 1000}
              onChange={(ms) => run(async () => (await api.setTelemetryInterval(ms), await refreshStatus(), `Interval set to ${ms / 1000}s`))}
              options={[500, 1000, 2000, 5000].map((ms) => ({ value: ms, label: `${ms / 1000}s`, disabled: !isTauri }))}
            />
          </div>
          <p className="text-[11.5px] text-ink-3 leading-snug">
            One sample per interval is emitted to the UI and, while tasks run, stored in SQLite. Shorter intervals give finer charts at slightly higher overhead.
          </p>
          <div className="flex items-center gap-3">
            <span className="label w-32">Default chart range</span>
            <Seg label="Default range" value={p.defaultRangeMs} onChange={(v) => void savePrefs({ defaultRangeMs: v })} options={RANGES.map((r) => ({ value: r.value, label: r.label }))} />
          </div>
        </div>
      </Panel>

      <Panel title="Interface" code="I">
        <label className="flex items-center gap-3">
          <span className="label w-32">Reduce motion</span>
          <input type="checkbox" className="accent-[rgb(var(--amber))] w-4 h-4" checked={p.reducedMotion} onChange={(e) => void savePrefs({ reducedMotion: e.target.checked })} />
          <span className="text-[11.5px] text-ink-3">Stops pipeline flow and gauge transitions. The OS reduced-motion setting is always respected.</span>
        </label>
      </Panel>

      <Panel title="System" code="S">
        {status ? (
          <div className="grid grid-cols-2 gap-3">
            <Readout label="Host" value={<span className="text-[12.5px]">{status.info.host ?? "—"}</span>} />
            <Readout label="OS" value={<span className="text-[12.5px]">{status.info.os ?? "—"}</span>} />
            <Readout label="CPU" value={<span className="text-[12px] font-sans">{status.info.cpuBrand}</span>} className="col-span-2" />
            <Readout label="Cores" value={`${status.info.physicalCores ?? "?"} physical / ${status.info.logicalCores} logical`} />
            <Readout label="RAM" value={bytes(status.info.totalMemory)} />
            <Readout label="GPU (NVML)" value={<span className="text-[12px] font-sans">{status.info.gpuName ?? "not detected"}</span>} sub={status.info.gpuNote ?? undefined} />
            <Readout label="PDH counters" value={`disk ${status.info.pdhDisk ? "✓" : "✗"} · GPU ${status.info.pdhGpu ? "✓" : "✗"}`} />
            <Readout label="ACPI thermal zones" value={status.info.thermalZones} sub={status.info.thermalZones ? undefined : "not readable (CPU temperature N/A)"} />
            <Readout label="FlowDesk PID" value={status.info.selfPid} />
          </div>
        ) : (
          <ErrorNote>Backend not connected.</ErrorNote>
        )}
      </Panel>

      <Panel title="Data" code="DB">
        <div className="flex flex-col gap-3">
          <Readout label="Database" value={<span className="text-[11.5px] selectable">{status?.dbPath ?? "—"}</span>} />
          <Readout label="Reports" value={<span className="text-[11.5px] selectable">{status?.reportsDir ?? "—"}</span>} />
          <div className="flex gap-2">
            <button className="btn" disabled={!status} onClick={() => run(() => api.openPath(status!.reportsDir, false))}>
              <FolderOpen size={14} /> Open reports folder
            </button>
            <button
              className="btn btn-danger"
              disabled={!status}
              onClick={() =>
                confirm("Delete all finished task records and their telemetry from the database? Report files on disk are kept.") &&
                run(async () => `Removed ${await api.clearHistory()} record(s).`)
              }
            >
              <Trash2 size={14} /> Clear history
            </button>
          </div>
          {msg && <div className="text-[11.5px] text-ok">{msg}</div>}
          {err && <ErrorNote>{err}</ErrorNote>}
        </div>
      </Panel>
    </div>
  );
}
