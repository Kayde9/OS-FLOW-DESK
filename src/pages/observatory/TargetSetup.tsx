import { useEffect, useMemo, useState } from "react";
import { FolderOpen, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { Seg } from "../../components/industrial/Panel";
import { api, errorText, isTauri } from "../../lib/backend";
import { browseFolder, useEngine, useSelection } from "../../lib/engine/store";
import { bytes, OP_LABEL, POLICY_LABEL, shortPath } from "../../lib/format";
import { setup, useSetup } from "../../lib/trace/store";
import type { Capabilities } from "../../lib/trace/types";
import type { Op, ProcInfo } from "../../lib/types";

const OPS: Op[] = ["hash", "index", "duplicates", "metadata"];

function Num({ label, value, min, max, step = 1, unit, onChange, disabled }: { label: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <label className="flex items-center gap-2 text-[11.5px]">
      <span className="text-ink-3 w-[92px] shrink-0">{label}</span>
      <input
        type="number"
        className="field h-7 w-[92px] text-right"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
        }}
      />
      <span className="text-ink-3">{unit}</span>
    </label>
  );
}

function Check({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode; hint?: string; disabled?: boolean }) {
  return (
    <label className={`flex items-start gap-2 text-[12px] ${disabled ? "opacity-40" : ""}`}>
      <input type="checkbox" className="mt-0.5 accent-[rgb(var(--amber))]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">
        <span className="text-ink">{label}</span>
        {hint && <span className="block text-[11px] text-ink-3 leading-snug">{hint}</span>}
      </span>
    </label>
  );
}

export function TargetSetup({ caps, locked }: { caps: Capabilities | null; locked: boolean }) {
  const s = useSetup();
  const sel = useSelection();
  const snap = useEngine();
  const [procs, setProcs] = useState<ProcInfo[] | null>(null);
  const [procErr, setProcErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const set = (p: Partial<typeof s>) => setup.set((x) => ({ ...x, ...p }));
  const toggleProvider = (id: string, on: boolean) => set({ providers: on ? [...new Set([...s.providers, id])] : s.providers.filter((p) => p !== id) });

  const loadProcs = async () => {
    setProcErr(null);
    try {
      const l = await api.listProcesses();
      setProcs(l.processes.sort((a, b) => b.cpu - a.cpu || a.name.localeCompare(b.name)));
    } catch (e) {
      setProcErr(errorText(e));
    }
  };
  useEffect(() => {
    if (s.mode === "process" && !procs && isTauri) void loadProcs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.mode]);
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (procs ?? []).filter((p) => !n || p.name.toLowerCase().includes(n) || String(p.pid) === n).slice(0, 80);
  }, [procs, q]);

  const elevated = caps?.elevated ?? false;

  return (
    <fieldset disabled={locked} className="flex flex-col gap-3 min-w-0 disabled:opacity-60">
      <div className={`recess px-2.5 py-2 text-[11.5px] leading-snug ${elevated ? "" : "border-amber/40"}`}>
        <div className="flex items-center gap-1.5 font-medium mb-0.5">
          {elevated ? <ShieldCheck size={13} className="text-ok" /> : <ShieldAlert size={13} className="text-amber" />}
          {elevated ? "Elevated — ETW sessions available" : "Not elevated — ETW sessions will be denied"}
        </div>
        {!elevated && (
          <>
            <p className="text-ink-3">{caps?.permissionNote}</p>
            <div className="flex gap-1.5 mt-1.5 flex-wrap">
              <button type="button" className="btn btn-sm" onClick={() => set({ providers: [], mode: "workload" })} title="Record only FlowDesk's own workload events — no ETW session, no administrator rights needed">
                Use FlowDesk events only
              </button>
            </div>
            <details className="mt-1.5">
              <summary className="cursor-pointer text-amber">To capture real ETW events</summary>
              <ol className="list-decimal pl-4 mt-1 text-ink-3 space-y-0.5">
                <li>Close FlowDesk and any running <span className="font-mono">npm run tauri dev</span>.</li>
                <li>Open PowerShell with <em>Run as administrator</em>.</li>
                <li><span className="font-mono">cd</span> to the project folder, then run <span className="font-mono selectable">npm run tauri dev</span>.</li>
              </ol>
              <p className="text-ink-3 mt-1">Alternatively add your account to the <span className="font-mono">Performance Log Users</span> group and sign in again.</p>
            </details>
          </>
        )}
      </div>

      <div>
        <div className="label mb-1.5">Trace target</div>
        <Seg
          label="Trace target"
          value={s.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: "workload", label: "FlowDesk workload" },
            { value: "process", label: "Running process" },
          ]}
        />
      </div>

      {s.mode === "workload" ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="recess flex-1 h-8 px-2 flex items-center min-w-0">
              <span className="readout text-[11.5px] truncate" title={sel.folder ?? undefined}>
                {sel.folder ? shortPath(sel.folder, 34) : <span className="text-ink-3 font-sans">No folder selected</span>}
              </span>
            </div>
            <button type="button" className="btn btn-sm h-8" onClick={() => void browseFolder()} disabled={!isTauri}>
              <FolderOpen size={13} /> {sel.folder ? "Change" : "Browse…"}
            </button>
          </div>
          {sel.scan && <div className="text-[11px] text-ink-3 readout">{sel.scan.files.toLocaleString()} files · {bytes(sel.scan.bytes)}</div>}
          {sel.scanning && <div className="text-[11px] text-ink-3">Scanning folder…</div>}
          <label className="flex items-center gap-2 text-[11.5px]">
            <span className="text-ink-3 w-[92px]">Operation</span>
            <select className="field h-7 flex-1" value={s.op} onChange={(e) => set({ op: e.target.value as Op })}>
              {OPS.map((o) => (
                <option key={o} value={o}>{OP_LABEL[o]}</option>
              ))}
            </select>
          </label>
          <Num label="Task priority" value={s.priority} min={1} max={10} unit="P1–P10" onChange={(priority) => set({ priority })} />
          <div className="text-[11px] text-ink-3 leading-snug">
            Scheduling: {snap ? `${POLICY_LABEL[snap.config.policy]}, ${snap.config.workers} workers${snap.config.policy === "round_robin" ? `, q=${snap.config.quantumMs} ms` : ""}` : "engine not connected"} (change in Workspace).
            The traced process is FlowDesk itself; worker threads get named lanes. Safe copy can be traced from the Workspace.
          </div>
          <Check checked={s.stopWithWorkload} onChange={(stopWithWorkload) => set({ stopWithWorkload })} label="Stop capture when the workload finishes" />
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1.5">
            <input className="field h-7 flex-1 font-sans" placeholder="Filter by name or PID" value={q} onChange={(e) => setQ(e.target.value)} />
            <button type="button" className="btn btn-sm h-7" onClick={() => void loadProcs()} title="Refresh process list"><RefreshCw size={12} /></button>
          </div>
          {procErr && <div className="text-[11px] text-alert">{procErr}</div>}
          <ul className="recess max-h-[168px] overflow-y-auto" role="listbox" aria-label="Processes">
            {shown.map((p) => (
              <li key={p.pid}>
                <button
                  type="button"
                  role="option"
                  aria-selected={s.procPid === p.pid}
                  onClick={() => set({ procPid: p.pid, procName: p.name })}
                  className={`w-full grid grid-cols-[1fr_56px_48px] gap-2 px-2 h-6 text-[11.5px] text-left ${s.procPid === p.pid ? "bg-amber/10 text-amber" : "hover:bg-white/[0.03]"}`}
                >
                  <span className="truncate">{p.name}</span>
                  <span className="readout text-right text-ink-3">{p.pid}</span>
                  <span className="readout text-right text-ink-3">{p.cpu.toFixed(1)}%</span>
                </button>
              </li>
            ))}
            {procs && !shown.length && <li className="px-2 py-1 text-[11px] text-ink-3">No match</li>}
          </ul>
          <div className="text-[11px] text-ink-3 leading-snug">
            {s.procPid != null ? <span className="text-ink-2">Selected: {s.procName} · PID {s.procPid}. </span> : null}
            Only events attributable to this PID are kept; not every activity of a process is visible to these providers.
          </div>
        </div>
      )}

      <div>
        <div className="label mb-1.5">ETW providers</div>
        <div className="flex flex-col gap-2">
          {(caps?.providers ?? []).map((p) => (
            <Check key={p.id} checked={s.providers.includes(p.id)} onChange={(on) => toggleProvider(p.id, on)} label={<span>{p.name.replace("Microsoft-Windows-", "")}</span>} hint={p.description} />
          ))}
          <div className="pl-5 flex flex-col gap-1.5">
            <Check
              checked={s.fileCompletions}
              disabled={!s.providers.includes("file")}
              onChange={(fileCompletions) => set({ fileCompletions })}
              label="Completions (durations, NTSTATUS)"
              hint="OperationEnd matched by IRP. Raises volume: completions are delivered system-wide and filtered here."
            />
            <Check
              checked={s.fileMetadata}
              disabled={!s.providers.includes("file")}
              onChange={(fileMetadata) => set({ fileMetadata })}
              label="Handle & metadata events"
              hint="Cleanup, Close, query/set information, directory enumeration."
            />
          </div>
          {!s.providers.length && <div className="text-[11px] text-amber">No ETW providers: only FlowDesk application events will be recorded.</div>}
        </div>
      </div>

      <div>
        <div className="label mb-1.5">Filters & limits</div>
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-[11.5px]">
            <span className="text-ink-3 w-[92px] shrink-0">Path contains</span>
            <input className="field h-7 flex-1" placeholder="optional, e.g. \\Documents\\" value={s.pathFilter} onChange={(e) => set({ pathFilter: e.target.value })} />
          </label>
          <Num label="Max duration" value={s.maxDurationS} min={5} max={1800} unit="s" onChange={(maxDurationS) => set({ maxDurationS })} />
          <Num label="Max events" value={s.maxEvents} min={1000} max={2_000_000} step={1000} unit="events" onChange={(maxEvents) => set({ maxEvents })} />
          <Num label="ETW buffer" value={s.bufferKb} min={64} max={1024} step={64} unit="KB" onChange={(bufferKb) => set({ bufferKb })} />
          <Num label="Max buffers" value={s.maxBuffers} min={16} max={512} unit="buffers" onChange={(maxBuffers) => set({ maxBuffers })} />
          <Check
            checked={s.excludeTracerIo}
            onChange={(excludeTracerIo) => set({ excludeTracerIo })}
            label="Exclude the tracer's own database I/O"
            hint="Drops events from FlowDesk's trace-writer thread so saving events does not generate more events. Counted as 'self'."
          />
        </div>
      </div>
      <p className="text-[10.5px] text-ink-3 leading-snug">
        Captures start only when you press Start, run in real-time mode with bounded buffers, and stay on this computer. {caps?.nativeSyscallNote}
      </p>
    </fieldset>
  );
}
