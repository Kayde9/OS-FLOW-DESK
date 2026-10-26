import { useMemo, useState } from "react";
import { FolderInput, Plus, Shuffle, Trash2 } from "lucide-react";
import { ErrorNote, Seg } from "../../components/industrial/Panel";
import { ALGO_INFO, DEFAULT_OPTIONS, SAMPLE_PROCS, simulate, validate, type CpuAlgo, type CpuOptions, type CpuResult, type Proc } from "../../lib/algorithms/cpu";
import { useSelection } from "../../lib/engine/store";
import { Chip, entityColor, Gantt, LabFrame, Lane, Metric, NumField, StepControls, useStepper } from "./primitives";

const ALGOS = Object.keys(ALGO_INFO) as CpuAlgo[];

const EXPLAIN: Record<CpuAlgo, string> = {
  fcfs: "First-Come, First-Served runs processes in arrival order to completion. It is simple and fair in order, but a long early job delays every short job behind it (the convoy effect), which inflates average waiting time.",
  sjf: "Shortest Job First picks the ready process with the smallest CPU burst and runs it to completion. Among non-preemptive policies it gives the minimum average waiting time when bursts are known, but long jobs can starve.",
  srtf: "Shortest Remaining Time First is preemptive SJF: a newly arrived process with less remaining work preempts the running one. It minimises average waiting time at the cost of more context switches.",
  priority: "Non-preemptive priority scheduling runs the highest-priority ready process (lowest number) to completion. Low-priority processes may starve; real systems add aging.",
  priority_p: "Preemptive priority scheduling switches immediately when a higher-priority process becomes ready.",
  rr: "Round Robin gives each ready process one time quantum in turn. Response time is good for interactive work; a quantum that is too small adds switching overhead, and one that is too large degenerates to FCFS.",
  mlq: "The Multilevel Queue keeps processes permanently in queue 0 (interactive, Round Robin) or queue 1 (batch, FCFS). Queue 0 has strict priority and preempts queue 1.",
  mlfq: "The Multilevel Feedback Queue starts every process in Q0. A process that uses its whole quantum is demoted (Q0 → Q1 → Q2, FCFS), so CPU-bound work sinks while short or I/O-bound work stays responsive. Higher queues preempt lower ones.",
};

function randomProcs(n: number): Proc[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `P${i + 1}`,
    arrival: Math.floor(Math.random() * 8),
    burst: 1 + Math.floor(Math.random() * 8),
    priority: 1 + Math.floor(Math.random() * 5),
    queue: Math.random() < 0.5 ? 0 : 1,
  }));
}

export default function CpuLab() {
  const [procs, setProcs] = useState<Proc[]>(SAMPLE_PROCS);
  const [algo, setAlgo] = useState<CpuAlgo>("fcfs");
  const [opt, setOpt] = useState<CpuOptions>(DEFAULT_OPTIONS);
  const [source, setSource] = useState<string | null>(null);
  const sel = useSelection();
  const err = validate(procs);

  const result: CpuResult | null = useMemo(() => {
    if (err) return null;
    try {
      return simulate(procs, algo, opt);
    } catch {
      return null;
    }
  }, [procs, algo, opt, err]);
  const comparison = useMemo(() => (err ? null : ALGOS.map((a) => ({ a, r: simulate(procs, a, opt) }))), [procs, opt, err]);
  const s = useStepper(result?.ticks.length ?? 0);
  const tick = result?.ticks[s.i];
  const keys = procs.map((p) => p.id);
  const info = ALGO_INFO[algo];

  const edit = (i: number, patch: Partial<Proc>) => setProcs((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  const importScan = () => {
    const files = sel.scan?.largest ?? [];
    if (!files.length) return;
    // Burst ∝ file size: 1 time unit per started MB, clamped to 1–20.
    setProcs(
      files.map(([, size], i) => ({
        id: `F${i + 1}`,
        arrival: i,
        burst: Math.max(1, Math.min(20, Math.ceil(size / 1024 ** 2))),
        priority: i + 1,
        queue: size < 4 * 1024 ** 2 ? 0 : 1,
        io: null,
      })),
    );
    setSource(`Imported the ${files.length} largest files of ${sel.folder}. Burst = size in MB (1–20), arrival = rank.`);
  };

  return (
    <LabFrame
      title="CPU Scheduling"
      code="L1"
      config={
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Seg label="Algorithm" value={algo} onChange={setAlgo} options={ALGOS.map((a) => ({ value: a, label: a === "priority_p" ? "Priority-P" : a === "priority" ? "Priority" : ALGO_INFO[a].label.replace("Multilevel Feedback Queue", "MLFQ").replace("Multilevel Queue", "MLQ") }))} />
            <span className="text-[11px] text-ink-3">{info.preemptive ? "preemptive" : "non-preemptive"}</span>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            {algo === "rr" && <NumField label="Quantum" value={opt.quantum} min={1} max={20} onChange={(quantum) => setOpt({ ...opt, quantum })} />}
            {algo === "mlq" && <NumField label="Q0 quantum" value={opt.mlqQuantum} min={1} max={20} onChange={(mlqQuantum) => setOpt({ ...opt, mlqQuantum })} />}
            {algo === "mlfq" && (
              <>
                <NumField label="Q0 quantum" value={opt.mlfqQuanta[0]} min={1} max={20} onChange={(q) => setOpt({ ...opt, mlfqQuanta: [q, opt.mlfqQuanta[1]] })} />
                <NumField label="Q1 quantum" value={opt.mlfqQuanta[1]} min={1} max={40} onChange={(q) => setOpt({ ...opt, mlfqQuanta: [opt.mlfqQuanta[0], q] })} />
              </>
            )}
            <div className="ml-auto flex gap-1.5">
              <button className="btn btn-sm" onClick={() => (setProcs(SAMPLE_PROCS), setSource(null))}>Sample</button>
              <button className="btn btn-sm" onClick={() => (setProcs(randomProcs(5)), setSource(null))}><Shuffle size={12} /> Random</button>
              <button className="btn btn-sm" onClick={importScan} disabled={!sel.scan?.largest.length} title={sel.scan ? "Use the Workspace folder's largest files as processes" : "Select a folder in the Workspace first"}>
                <FolderInput size={12} /> From folder scan
              </button>
            </div>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>PID</th>
                <th>Arrival</th>
                <th>Burst</th>
                <th>Priority (1 = high)</th>
                <th>Queue (MLQ)</th>
                <th>I/O after</th>
                <th>I/O length</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {procs.map((p, i) => (
                <tr key={i}>
                  <td><input className="field h-6 w-16" value={p.id} onChange={(e) => edit(i, { id: e.target.value })} aria-label="Process ID" /></td>
                  <td><input type="number" className="field h-6 w-16" value={p.arrival} min={0} onChange={(e) => edit(i, { arrival: Math.max(0, Math.round(+e.target.value)) })} aria-label="Arrival" /></td>
                  <td><input type="number" className="field h-6 w-16" value={p.burst} min={1} onChange={(e) => edit(i, { burst: Math.max(1, Math.round(+e.target.value)) })} aria-label="Burst" /></td>
                  <td><input type="number" className="field h-6 w-16" value={p.priority} min={1} onChange={(e) => edit(i, { priority: Math.max(1, Math.round(+e.target.value)) })} aria-label="Priority" /></td>
                  <td>
                    <select className="field h-6" value={p.queue} onChange={(e) => edit(i, { queue: +e.target.value })} aria-label="Queue">
                      <option value={0}>0 · interactive</option>
                      <option value={1}>1 · batch</option>
                    </select>
                  </td>
                  <td><input type="number" className="field h-6 w-16" value={p.io?.at ?? ""} placeholder="—" min={1} onChange={(e) => edit(i, { io: e.target.value === "" ? null : { at: Math.round(+e.target.value), duration: p.io?.duration ?? 2 } })} aria-label="I/O after units" /></td>
                  <td><input type="number" className="field h-6 w-16" value={p.io?.duration ?? ""} placeholder="—" min={1} disabled={!p.io} onChange={(e) => p.io && edit(i, { io: { at: p.io.at, duration: Math.max(1, Math.round(+e.target.value)) } })} aria-label="I/O duration" /></td>
                  <td className="text-right">
                    <button className="btn btn-sm" onClick={() => setProcs((ps) => ps.filter((_, j) => j !== i))} disabled={procs.length <= 1} aria-label="Remove process"><Trash2 size={12} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center gap-2">
            <button className="btn btn-sm" disabled={procs.length >= 12} onClick={() => setProcs((ps) => [...ps, { id: `P${ps.length + 1}`, arrival: 0, burst: 3, priority: 3, queue: 1 }])}>
              <Plus size={12} /> Add process
            </button>
            {source && <span className="text-[11px] text-ink-3 truncate">{source}</span>}
          </div>
          {err && <ErrorNote>{err}</ErrorNote>}
        </div>
      }
      controls={<StepControls s={s} label="t" />}
      explanation={
        <>
          <p>{EXPLAIN[algo]}</p>
          <p className="text-ink-3">
            Conventions: arrivals at time t join the ready queue before a process whose quantum expired at t. Waiting time is time spent in a ready queue
            (blocked I/O excluded). A context switch is counted whenever the CPU starts a different process than the one it last ran. Switch cost is modelled as zero.
          </p>
        </>
      }
    >
      {result && tick && (
        <>
          <Gantt segments={result.gantt} keys={keys} cursor={tick.t} />
          <div className="grid grid-cols-[1fr_280px] gap-4">
            <div className="flex flex-col gap-1.5">
              <Lane label={`t = ${tick.t}`}>
                <span className="text-[11.5px] text-ink-2">Running:</span>
                {tick.running ? <Chip color={entityColor(tick.running, keys)}>{tick.running}{tick.level != null ? ` · Q${tick.level}` : ""}</Chip> : <span className="text-ink-3 text-[12px]">idle</span>}
              </Lane>
              {tick.queues.map((q, li) => (
                <Lane key={li} label={tick.queues.length > 1 ? `Ready Q${li}` : "Ready queue"}>
                  {q.length ? q.map((id) => <Chip key={id} color={entityColor(id, keys)}>{id}</Chip>) : <span className="text-ink-3 text-[12px]">empty</span>}
                </Lane>
              ))}
              <Lane label="Blocked (I/O)">{tick.blocked.length ? tick.blocked.map((id) => <Chip key={id} dim>{id}</Chip>) : <span className="text-ink-3 text-[12px]">none</span>}</Lane>
              <Lane label="Terminated">{tick.done.length ? tick.done.map((id) => <Chip key={id}>{id}</Chip>) : <span className="text-ink-3 text-[12px]">none</span>}</Lane>
            </div>
            <div className="recess p-2 text-[11.5px] h-[150px] overflow-auto">
              <div className="label mb-1">Events up to t={tick.t}</div>
              {result.ticks
                .slice(0, s.i + 1)
                .reverse()
                .flatMap((k) => k.events.map((e) => ({ t: k.t, e })))
                .slice(0, 40)
                .map((x, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="readout text-ink-3 w-6 text-right">{x.t}</span>
                    <span className="text-ink-2">{x.e}</span>
                  </div>
                ))}
            </div>
          </div>
          <div className="grid grid-cols-6 gap-2">
            <Metric label="Avg waiting" value={result.avgWaiting.toFixed(2)} />
            <Metric label="Avg turnaround" value={result.avgTurnaround.toFixed(2)} />
            <Metric label="Avg response" value={result.avgResponse.toFixed(2)} />
            <Metric label="Throughput" value={result.throughput.toFixed(3)} sub="processes / unit" />
            <Metric label="Context switches" value={result.contextSwitches} sub="simulated" />
            <Metric label="CPU utilisation" value={`${(result.cpuUtilisation * 100).toFixed(0)}%`} sub={`makespan ${result.makespan}`} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <table className="tbl">
              <thead>
                <tr>
                  <th>PID</th>
                  <th className="text-right">Arrival</th>
                  <th className="text-right">Burst</th>
                  <th className="text-right">Completion</th>
                  <th className="text-right">Turnaround</th>
                  <th className="text-right">Waiting</th>
                  <th className="text-right">Response</th>
                </tr>
              </thead>
              <tbody>
                {result.stats.map((p) => (
                  <tr key={p.id}>
                    <td><span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: entityColor(p.id, keys) }} />{p.id}</td>
                    <td className="readout text-right">{p.arrival}</td>
                    <td className="readout text-right">{p.burst}</td>
                    <td className="readout text-right">{p.completion}</td>
                    <td className="readout text-right">{p.turnaround}</td>
                    <td className="readout text-right">{p.waiting}</td>
                    <td className="readout text-right">{p.response}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {comparison && (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Same input, every algorithm</th>
                    <th className="text-right">Avg wait</th>
                    <th className="text-right">Avg TAT</th>
                    <th className="text-right">Avg resp</th>
                    <th className="text-right">Switches</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.map(({ a, r }) => {
                    const best = Math.min(...comparison.map((c) => c.r.avgWaiting));
                    return (
                      <tr key={a} className={a === algo ? "bg-amber/[0.07]" : ""} onClick={() => setAlgo(a)} style={{ cursor: "pointer" }}>
                        <td>{ALGO_INFO[a].label}</td>
                        <td className={`readout text-right ${r.avgWaiting === best ? "text-ok" : ""}`}>{r.avgWaiting.toFixed(2)}</td>
                        <td className="readout text-right">{r.avgTurnaround.toFixed(2)}</td>
                        <td className="readout text-right">{r.avgResponse.toFixed(2)}</td>
                        <td className="readout text-right">{r.contextSwitches}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </LabFrame>
  );
}
