import { useEffect, useMemo, useState } from "react";
import { Archive, Copy, FileSearch, FolderOpen, Hash, Layers, ListTree, Play, RefreshCw, Save } from "lucide-react";
import { Empty, ErrorNote, Led, Loading, Panel, Progress, Readout, Seg, statusTone } from "../components/industrial/Panel";
import { api, errorText, isTauri, pickFolder } from "../lib/backend";
import { browseFolder, scanSelected, useEngine, useSelection } from "../lib/engine/store";
import { bytes, clock, duration, POLICY_LABEL, rate, shortPath } from "../lib/format";
import type { EngineConfig, Op, Policy } from "../lib/types";
import { TaskControls } from "./overview/ActiveTask";
import { useNavigate } from "react-router-dom";
import { setup, startCapture, trace, useCaptureState, useSetup } from "../lib/trace/store";

const OPS: { op: Op | "compress" | "backup"; label: string; icon: typeof Hash; desc: string; disabled?: string }[] = [
  { op: "hash", label: "SHA-256 hashing", icon: Hash, desc: "Streams every file through SHA-256; writes a JSON + CSV manifest." },
  { op: "index", label: "File indexing", icon: ListTree, desc: "Records path, size, timestamps and attributes of each file (no content read)." },
  { op: "duplicates", label: "Duplicate detection", icon: Layers, desc: "Hashes only files whose size matches another file, then groups identical content." },
  { op: "metadata", label: "Metadata analysis", icon: FileSearch, desc: "Extension, size and age distributions plus the largest files." },
  { op: "copy", label: "Safe file copy", icon: Copy, desc: "Copies to a destination via temp file + SHA-256 verify; never overwrites." },
  { op: "compress", label: "Compression", icon: Archive, desc: "Not implemented in this build.", disabled: "Not implemented yet" },
  { op: "backup", label: "Backup", icon: Save, desc: "Not implemented in this build.", disabled: "Not implemented yet" },
];

const POLICY_HELP: Record<Policy, string> = {
  fcfs: "Workers always take files from the task that arrived first. Later tasks wait until earlier ones run out of queued files.",
  priority: "Workers take files from the highest-priority ready task (P10 highest). Preemptive at file boundaries: a newly submitted higher-priority task gets the next free worker.",
  round_robin: "Ready tasks take turns. Each dispatch runs for one time quantum; an unfinished file is suspended (cursor saved) and requeued at the back.",
  shortest_remaining: "Workers take files from the task with the fewest bytes left (an SRTF analogue measured in bytes).",
};

function Step({ n, title, done, children, className = "" }: { n: number; title: string; done?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <Panel
      title={title}
      code={`S${n}`}
      status={done ? { tone: "ok", label: "set" } : { tone: "off", label: "pending" }}
      className={className}
    >
      {children}
    </Panel>
  );
}

export default function Workspace() {
  const sel = useSelection();
  const snap = useEngine();
  const [op, setOp] = useState<Op>("hash");
  const [dest, setDest] = useState<string | null>(null);
  const [priority, setPriority] = useState(5);
  const [name, setName] = useState("");
  const [cfg, setCfg] = useState<EngineConfig | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastId, setLastId] = useState<number | null>(null);
  const [traced, setTraced] = useState(false);
  const navigate = useNavigate();
  const capture = useCaptureState();
  const traceBusy = capture != null && !["completed", "failed", "cancelled"].includes(capture);

  useEffect(() => {
    if (snap && !cfg) setCfg(snap.config);
  }, [snap, cfg]);

  const maxWorkers = snap?.maxWorkers ?? 1;
  const scan = sel.scan;
  const ready = !!scan && scan.files > 0 && !!cfg && (op !== "copy" || !!dest);
  const configChanged = cfg && snap && JSON.stringify(cfg) !== JSON.stringify(snap.config);

  const est = useMemo(() => {
    if (!scan) return null;
    if (op === "duplicates") return { files: scan.sizeCollisions, note: "size-collision candidates" };
    return { files: scan.files, note: "files" };
  }, [scan, op]);

  const submit = async () => {
    if (!sel.folder || !cfg) return;
    setSubmitting(true);
    setErr(null);
    try {
      await api.engineSetConfig(cfg);
      const req = { name, op, folder: sel.folder, dest: op === "copy" ? dest : null, priority };
      if (traced) {
        // The Observatory starts the ETW session first, then submits this task.
        const s = setup.get();
        const v = await startCapture({
          target: { kind: "workload", job: req },
          name: null,
          providers: s.providers,
          fileCompletions: s.fileCompletions,
          fileMetadata: s.fileMetadata,
          maxDurationS: s.maxDurationS,
          maxEvents: s.maxEvents,
          bufferKb: s.bufferKb,
          maxBuffers: s.maxBuffers,
          stopWithWorkload: true,
          excludeTracerIo: s.excludeTracerIo,
          pathFilter: s.pathFilter.trim() || null,
        });
        if (v) navigate("/observatory");
        else setErr(trace.get().error ?? "Trace session could not start");
        return;
      }
      const id = await api.submitJob(req);
      setLastId(id);
      setName("");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setSubmitting(false);
    }
  };

  const sessionJobs = snap?.jobs ?? [];

  return (
    <div className="p-3 grid gap-3 grid-cols-[minmax(0,1.15fr)_minmax(380px,1fr)] min-w-[1000px] items-start">
      <div className="flex flex-col gap-3 min-w-0">
        {!isTauri && <ErrorNote>The workspace needs the FlowDesk desktop backend (run with <span className="font-mono">npm run tauri dev</span>). Nothing here is simulated.</ErrorNote>}

        <Step n={1} title="Select folder" done={!!scan}>
          <div className="flex items-center gap-2">
            <div className="recess flex-1 h-8 px-2 flex items-center min-w-0">
              <span className="readout text-[12px] truncate selectable" title={sel.folder ?? undefined}>
                {sel.folder ?? <span className="text-ink-3 font-sans">No folder selected: use the native picker</span>}
              </span>
            </div>
            <button className="btn btn-amber" onClick={() => void browseFolder()} disabled={!isTauri}>
              <FolderOpen size={14} /> {sel.folder ? "Change" : "Browse…"}
            </button>
            <button className="btn" onClick={() => sel.folder && void scanSelected(sel.folder)} disabled={!sel.folder || sel.scanning} title="Rescan">
              <RefreshCw size={14} />
            </button>
          </div>
          {sel.scanning && <Loading label="Scanning folder" />}
          {sel.error && <div className="mt-2"><ErrorNote>{sel.error}</ErrorNote></div>}
          {scan && (
            <div className="mt-3 grid grid-cols-[repeat(5,minmax(0,1fr))] gap-3">
              <Readout label="Files" value={scan.files.toLocaleString()} />
              <Readout label="Folders" value={scan.dirs.toLocaleString()} />
              <Readout label="Total size" value={bytes(scan.bytes)} />
              <Readout label="Scan time" value={duration(scan.durationMs)} />
              <Readout label="Access errors" value={scan.errors} tone={scan.errors ? "amber" : "ok"} />
            </div>
          )}
          {scan?.truncated && <div className="mt-2 text-[11.5px] text-amber">Stopped at 250,000 files. Choose a narrower folder for a complete workload.</div>}
          {scan && scan.errors > 0 && (
            <details className="mt-2 text-[11.5px] text-ink-2">
              <summary className="cursor-pointer text-amber">Show access errors</summary>
              <ul className="mt-1 font-mono text-[11px] text-ink-3 max-h-24 overflow-auto selectable">
                {scan.errorSamples.map((e, i) => <li key={i} className="truncate" title={e}>{e}</li>)}
              </ul>
            </details>
          )}
          {scan && scan.extensions.length > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <div className="label mb-1">By type (size)</div>
                {scan.extensions.slice(0, 5).map((e) => (
                  <div key={e.ext} className="flex items-center gap-2 text-[11.5px] h-5">
                    <span className="readout w-16 truncate text-ink-2">.{e.ext}</span>
                    <div className="flex-1 recess h-1.5">
                      <div className="h-full bg-steel-hi" style={{ width: `${(e.bytes / Math.max(1, scan.bytes)) * 100}%` }} />
                    </div>
                    <span className="readout w-16 text-right text-ink-3">{bytes(e.bytes)}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="label mb-1">Largest files</div>
                {scan.largest.map(([p, s]) => (
                  <div key={p} className="flex gap-2 text-[11.5px] h-5">
                    <span className="readout truncate text-ink-2 flex-1" title={p}>{shortPath(p, 34)}</span>
                    <span className="readout text-ink-3">{bytes(s)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Step>

        <Step n={2} title="Select operation" done={op !== "copy" || !!dest}>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Operation">
            {OPS.map((o) => {
              const Icon = o.icon;
              const selected = op === o.op;
              return (
                <button
                  key={o.op}
                  role="radio"
                  aria-checked={selected}
                  disabled={!!o.disabled}
                  title={o.disabled}
                  onClick={() => setOp(o.op as Op)}
                  className={`text-left flex gap-2.5 p-2.5 rounded-sm border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    selected ? "border-amber/70 bg-amber/[0.07]" : "border-steel-dim bg-panel-sunk hover:border-steel"
                  }`}
                >
                  <Icon size={16} className={selected ? "text-amber mt-0.5" : "text-ink-3 mt-0.5"} />
                  <span className="min-w-0">
                    <span className="block text-[12.5px] font-medium">
                      {o.label}
                      {o.disabled && <span className="ml-2 text-micro uppercase text-ink-3">{o.disabled}</span>}
                    </span>
                    <span className="block text-[11px] text-ink-3 leading-snug">{o.desc}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {op === "copy" && (
            <div className="mt-3 flex items-center gap-2">
              <span className="label w-24">Destination</span>
              <div className="recess flex-1 h-8 px-2 flex items-center min-w-0">
                <span className="readout text-[12px] truncate">{dest ?? <span className="text-ink-3 font-sans">Choose a folder outside the source</span>}</span>
              </div>
              <button
                className="btn"
                disabled={!isTauri}
                onClick={async () => {
                  try {
                    const d = await pickFolder("Select the copy destination");
                    if (d) setDest(d);
                  } catch (e) {
                    setErr(errorText(e));
                  }
                }}
              >
                <FolderOpen size={14} /> Browse…
              </button>
            </div>
          )}
        </Step>

        <Step n={3} title="Configure scheduling" done={!!cfg}>
          {!cfg ? (
            <Empty title="Engine not connected" />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <span className="label w-24">Policy</span>
                <Seg
                  label="Scheduling policy"
                  value={cfg.policy}
                  onChange={(policy) => setCfg({ ...cfg, policy })}
                  options={(["fcfs", "priority", "round_robin", "shortest_remaining"] as Policy[]).map((p) => ({ value: p, label: POLICY_LABEL[p] }))}
                />
              </div>
              <p className="text-[11.5px] text-ink-2 leading-snug pl-[108px]">{POLICY_HELP[cfg.policy]}</p>
              <Slider label="Task priority" value={priority} min={1} max={10} onChange={setPriority} fmt={(v) => `P${v}`} hint="Per task. Used by the Priority policy." />
              <Slider
                label="Worker threads"
                value={cfg.workers}
                min={1}
                max={maxWorkers}
                onChange={(workers) => setCfg({ ...cfg, workers, maxWorkersPerTask: Math.min(cfg.maxWorkersPerTask, workers) })}
                fmt={(v) => `${v}`}
                hint={`Engine-wide. Limited to ${maxWorkers} (logical cores, max 16).`}
              />
              <Slider
                label="Per-task limit"
                value={cfg.maxWorkersPerTask}
                min={1}
                max={cfg.workers}
                onChange={(maxWorkersPerTask) => setCfg({ ...cfg, maxWorkersPerTask })}
                fmt={(v) => `${v}`}
                hint="Concurrency cap: the most workers one task may hold at once."
              />
              <Slider
                label="Time quantum"
                value={cfg.quantumMs}
                min={5}
                max={500}
                step={5}
                disabled={cfg.policy !== "round_robin"}
                onChange={(quantumMs) => setCfg({ ...cfg, quantumMs })}
                fmt={(v) => `${v} ms`}
                hint="Round Robin only. Units run at most this long before requeueing."
              />
              <div className="text-[11px] text-ink-3 border-t border-steel-dim pt-2 leading-snug">
                These policies decide which <em>FlowDesk task</em> its worker threads serve next. Windows still schedules those threads onto CPU cores;
                FlowDesk does not replace or modify the kernel scheduler. Engine settings apply to all FlowDesk tasks.
              </div>
            </div>
          )}
        </Step>
      </div>

      <div className="flex flex-col gap-3 min-w-0">
        <Step n={4} title="Review & execute" done={ready}>
          <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 text-[12px]">
            <dt className="text-ink-3">Folder</dt>
            <dd className="readout truncate" title={sel.folder ?? undefined}>{shortPath(sel.folder, 44)}</dd>
            <dt className="text-ink-3">Workload</dt>
            <dd className="readout">{est ? `${est.files.toLocaleString()} ${est.note} · ${bytes(scan?.bytes)}` : "—"}</dd>
            <dt className="text-ink-3">Operation</dt>
            <dd>{OPS.find((o) => o.op === op)?.label}</dd>
            {op === "copy" && (
              <>
                <dt className="text-ink-3">Destination</dt>
                <dd className="readout truncate">{shortPath(dest, 44)}</dd>
              </>
            )}
            <dt className="text-ink-3">Policy</dt>
            <dd>
              {cfg ? POLICY_LABEL[cfg.policy] : "—"}
              {cfg?.policy === "round_robin" && <span className="readout text-ink-3"> · q={cfg.quantumMs} ms</span>}
              {configChanged && <span className="ml-2 text-micro uppercase text-amber">applies on start</span>}
            </dd>
            <dt className="text-ink-3">Workers</dt>
            <dd className="readout">{cfg ? `${cfg.workers} (≤ ${cfg.maxWorkersPerTask} per task)` : "—"}</dd>
            <dt className="text-ink-3">Priority</dt>
            <dd className="readout">P{priority}</dd>
          </dl>
          <div className="mt-3 flex items-center gap-2">
            <input className="field flex-1 font-sans" placeholder="Task name (optional)" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            <button className="btn btn-amber" disabled={!ready || submitting || (traced && traceBusy)} onClick={() => void submit()}>
              <Play size={14} /> {submitting ? "Starting…" : traced ? "Start traced task" : "Start task"}
            </button>
          </div>
          <TraceOption traced={traced} setTraced={setTraced} busy={traceBusy} />
          {op === "duplicates" && scan && scan.sizeCollisions === 0 && (
            <div className="mt-2 text-[11.5px] text-amber">No two non-empty files share a size, so no duplicates are possible.</div>
          )}
          {err && <div className="mt-2"><ErrorNote>{err}</ErrorNote></div>}
          {lastId && !err && <div className="mt-2 text-[11.5px] text-ok">Task #{lastId} submitted.</div>}
        </Step>

        <Panel title="Track progress" code="S5" status={{ tone: sessionJobs.some((j) => j.status === "running") ? "amber" : "off", label: `${sessionJobs.length} this session` }} bodyClassName="flex flex-col">
          {sessionJobs.length === 0 ? (
            <Empty title="No tasks yet">Started tasks report progress here from backend events.</Empty>
          ) : (
            <ul className="divide-y divide-steel-dim/60 max-h-[340px] overflow-auto">
              {sessionJobs.map((j) => (
                <li key={j.id} className="px-3 py-2.5 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <Led tone={statusTone(j.status)} pulse={j.status === "running"} />
                    <span className="readout text-ink-3">#{j.id}</span>
                    <span className="text-[12.5px] truncate flex-1" title={j.name}>{j.name}</span>
                    <span className="text-[11px] text-ink-3">{POLICY_LABEL[j.policy]} · P{j.priority}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1"><Progress value={j.progress} tone={j.status === "completed" ? "ok" : j.status === "failed" ? "alert" : "amber"} /></div>
                    <span className="readout text-[11.5px] w-12 text-right">{(j.progress * 100).toFixed(1)}%</span>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-ink-3">
                    <span className="readout">{j.filesDone + j.filesFailed + j.filesSkipped}/{j.filesTotal} files</span>
                    <span className="readout">{bytes(j.bytesDone)}</span>
                    {j.status === "running" && <span className="readout">{j.op === "index" || j.op === "metadata" ? `${j.rateFps.toFixed(0)} f/s` : rate(j.rateBps)}</span>}
                    <span className="readout">{duration(j.elapsedMs)}</span>
                    {j.etaMs != null && <span className="readout">ETA {duration(j.etaMs)}</span>}
                    <span className="ml-auto">{j.status}</span>
                  </div>
                  {j.errorCount > 0 && <div className="text-[11px] text-amber truncate" title={j.errors.join("\n")}>{j.errorCount} issue(s): {j.errors[0]}</div>}
                  <div className="flex gap-1.5">
                    <TaskControls job={j} compact />
                    {j.reportPath && (
                      <button className="btn btn-sm" onClick={() => void api.openPath(j.reportPath!, true)}>
                        <FolderOpen size={12} /> Report
                      </button>
                    )}
                    {j.op === "copy" && j.dest && j.status === "completed" && (
                      <button className="btn btn-sm" onClick={() => void api.openPath(j.dest!, false)}>
                        <FolderOpen size={12} /> Destination
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Scheduler decisions" code="S5b" status={{ tone: snap?.decisions.length ? "info" : "off", label: `${snap?.dispatches ?? 0} dispatches` }} bodyClassName="max-h-[220px] overflow-auto">
          {!snap?.decisions.length ? (
            <Empty title="No dispatches yet">Each time a worker takes a file, the policy's reason is logged here.</Empty>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Worker</th>
                  <th>Task</th>
                  <th>Reason / file</th>
                </tr>
              </thead>
              <tbody>
                {snap.decisions.map((d, i) => (
                  <tr key={`${d.ts}-${i}`}>
                    <td className="readout text-ink-3">{clock(d.ts)}</td>
                    <td className="readout">W{d.worker}</td>
                    <td className="readout">#{d.jobId}</td>
                    <td className="max-w-[260px] truncate" title={`${d.reason}\n${d.file}`}>
                      <span className="text-ink-2">{d.reason}</span>
                      <span className="text-ink-3 readout"> · {d.file}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}

function TraceOption({ traced, setTraced, busy }: { traced: boolean; setTraced: (v: boolean) => void; busy: boolean }) {
  const s = useSetup();
  return (
    <div className="mt-2 recess px-2.5 py-2 text-[11.5px]">
      <label className="flex items-center gap-2">
        <input type="checkbox" className="accent-[rgb(var(--amber))]" checked={traced} onChange={(e) => setTraced(e.target.checked)} />
        <span className="text-ink">Trace this task with the System Call Observatory</span>
      </label>
      {traced && (
        <div className="text-ink-3 mt-1 leading-snug pl-5">
          {s.providers.length
            ? `ETW providers: ${s.providers.join(", ")}${s.fileCompletions ? " (+ completions)" : ""}. Requires administrator rights.`
            : "No ETW providers selected: FlowDesk application events only."}{" "}
          Capture stops when the task finishes (max {s.maxDurationS} s). Change providers and limits in the Observatory.
          {busy && <span className="block text-amber">A trace session is already active; stop it first.</span>}
        </div>
      )}
    </div>
  );
}

function Slider({ label, value, min, max, step = 1, onChange, fmt, hint, disabled }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; fmt: (v: number) => string; hint?: string; disabled?: boolean }) {
  return (
    <label className={`flex items-center gap-3 ${disabled ? "opacity-40" : ""}`}>
      <span className="label w-24 shrink-0">{label}</span>
      <input type="range" className="flex-1 accent-[rgb(var(--amber))]" min={min} max={max} step={step} value={value} disabled={disabled || min === max} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="readout w-16 text-right text-[12.5px]">{fmt(value)}</span>
      {hint && <span className="text-[10.5px] text-ink-3 w-[220px] leading-tight">{hint}</span>}
    </label>
  );
}
