import { useState } from "react";
import { Plus } from "lucide-react";
import { ErrorNote } from "../../components/industrial/Panel";
import { applyTransition, canApply, create, initialModel, TRANSITIONS, type Model, type PState, type Transition } from "../../lib/algorithms/process";
import { LabFrame, Metric, NumField } from "./primitives";

const POS: Record<PState, [number, number]> = {
  new: [70, 60],
  ready: [250, 60],
  running: [430, 60],
  waiting: [340, 170],
  terminated: [600, 60],
};

const EDGES: { tr: Transition; d: string; lx: number; ly: number }[] = [
  { tr: "admit", d: "M112 60 L208 60", lx: 160, ly: 52 },
  { tr: "dispatch", d: "M292 52 C330 30 360 30 388 52", lx: 340, ly: 28 },
  { tr: "timeout", d: "M388 70 C360 92 330 92 292 70", lx: 340, ly: 104 },
  { tr: "wait", d: "M440 82 L370 150", lx: 432, ly: 126 },
  { tr: "wake", d: "M310 150 L255 82", lx: 250, ly: 126 },
  { tr: "exit", d: "M472 60 L558 60", lx: 515, ly: 52 },
];

export default function ProcessLab() {
  const [m, setM] = useState<Model>(() => {
    let x = create(initialModel(), "init", 1);
    x = applyTransition(x, 100, "admit");
    return create(x, "editor", 2, 100);
  });
  const [sel, setSel] = useState<number | null>(100);
  const [name, setName] = useState("worker");
  const [prio, setPrio] = useState(3);
  const [err, setErr] = useState<string | null>(null);
  const cur = m.procs.find((p) => p.pid === sel) ?? null;

  const act = (tr: Transition) => {
    if (sel == null) return;
    try {
      setM(applyTransition(m, sel, tr, tr === "wait" ? "disk I/O" : undefined));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const counts = (s: PState) => m.procs.filter((p) => p.state === s).length;

  return (
    <LabFrame
      title="Process State Model"
      code="P1"
      config={
        <div className="flex flex-wrap gap-3 items-end">
          <label className="flex flex-col gap-1">
            <span className="label">Process name</span>
            <input className="field w-32" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <NumField label="Priority" value={prio} min={1} max={10} onChange={setPrio} />
          <button className="btn" onClick={() => (setM(create(m, name || "proc", prio, sel)), setErr(null))}>
            <Plus size={14} /> Create {sel != null ? `(child of ${sel})` : ""}
          </button>
          <button className="btn" onClick={() => (setM(initialModel()), setSel(null))}>Reset</button>
        </div>
      }
      explanation={
        <p>
          Every process has a PCB holding its state, saved program counter, priority and accounting. On a single CPU at most one process is RUNNING. A dispatch loads the
          PCB's context; a timeout or I/O wait saves it (a context switch). Illegal transitions, such as waking a READY process, are rejected. The PCs and CPU times shown are simulated values.
        </p>
      }
    >
      <div className="grid grid-cols-[660px_1fr] gap-4 items-start">
        <svg viewBox="0 0 660 220" className="recess w-full" role="img" aria-label="Process state diagram">
          <defs>
            <marker id="pa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="rgb(var(--steel-hi))" /></marker>
            <marker id="pb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="rgb(var(--amber))" /></marker>
          </defs>
          {EDGES.map((e) => {
            const allowed = sel != null && !canApply(m, sel, e.tr);
            return (
              <g key={e.tr} onClick={() => allowed && act(e.tr)} style={{ cursor: allowed ? "pointer" : "default" }}>
                <path d={e.d} fill="none" stroke={allowed ? "rgb(var(--amber))" : "rgb(var(--steel))"} strokeWidth={allowed ? 2 : 1.4} markerEnd={allowed ? "url(#pb)" : "url(#pa)"} />
                <text x={e.lx} y={e.ly} textAnchor="middle" fontSize="10" fill={allowed ? "rgb(var(--amber))" : "rgb(var(--ink-3))"}>{TRANSITIONS[e.tr].label.split(" ")[0]}</text>
              </g>
            );
          })}
          {(Object.keys(POS) as PState[]).map((s) => {
            const [x, y] = POS[s];
            const here = cur?.state === s;
            return (
              <g key={s}>
                <rect x={x - 42} y={y - 22} width={84} height={44} rx={3} fill={here ? "rgb(var(--amber) / .15)" : "rgb(var(--panel-raised))"} stroke={here ? "rgb(var(--amber))" : "rgb(var(--steel-hi))"} strokeWidth={here ? 2 : 1} />
                <text x={x} y={y - 2} textAnchor="middle" fontSize="11" fill="rgb(var(--ink))" fontWeight={600}>{s.toUpperCase()}</text>
                <text x={x} y={y + 13} textAnchor="middle" fontSize="10" fill="rgb(var(--ink-3))" fontFamily="JetBrains Mono">{counts(s)}</text>
              </g>
            );
          })}
        </svg>
        <div className="flex flex-col gap-2">
          <div className="label">Transitions for {cur ? `PID ${cur.pid} (${cur.name})` : "— select a process"}</div>
          <div className="grid grid-cols-2 gap-1.5">
            {(Object.keys(TRANSITIONS) as Transition[]).map((tr) => {
              const why = sel != null ? canApply(m, sel, tr) : "Select a process";
              return (
                <button key={tr} className="btn btn-sm justify-start" disabled={!!why} title={why ?? undefined} onClick={() => act(tr)}>
                  {TRANSITIONS[tr].label}
                </button>
              );
            })}
          </div>
          {err && <ErrorNote>{err}</ErrorNote>}
        </div>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>PID</th>
            <th>Name</th>
            <th>Parent</th>
            <th>State</th>
            <th className="text-right">Priority</th>
            <th className="text-right">Saved PC</th>
            <th className="text-right">CPU time</th>
            <th className="text-right">Dispatches</th>
            <th>Waiting on</th>
          </tr>
        </thead>
        <tbody>
          {m.procs.map((p) => (
            <tr key={p.pid} onClick={() => setSel(p.pid)} className={`cursor-pointer ${p.pid === sel ? "bg-amber/[0.08]" : ""}`}>
              <td className="readout">{p.pid}</td>
              <td>{p.name}</td>
              <td className="readout text-ink-3">{p.parent ?? "—"}</td>
              <td className={p.state === "running" ? "text-amber" : p.state === "terminated" ? "text-ink-3" : ""}>{p.state.toUpperCase()}</td>
              <td className="readout text-right">{p.priority}</td>
              <td className="readout text-right">0x{p.pc.toString(16).padStart(4, "0")}</td>
              <td className="readout text-right">{p.cpuTime}</td>
              <td className="readout text-right">{p.switches}</td>
              <td className="text-ink-3">{p.waitReason ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid grid-cols-[1fr_260px] gap-4">
        <div className="recess p-2 text-[11.5px] max-h-[140px] overflow-auto">
          {[...m.log].reverse().map((l, i) => (
            <div key={i}><span className="readout text-ink-3 mr-2">t{l.t}</span><span className="text-ink-2">{l.msg}</span></div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Metric label="Processes" value={m.procs.length} />
          <Metric label="Context switches" value={m.procs.reduce((a, p) => a + p.switches, 0)} sub="dispatches" />
        </div>
      </div>
    </LabFrame>
  );
}
