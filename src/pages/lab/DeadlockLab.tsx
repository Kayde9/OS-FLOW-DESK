import { useMemo, useState } from "react";
import { ErrorNote, Seg } from "../../components/industrial/Panel";
import { bankerRequest, bankerSafety, detectDeadlock, type Matrix } from "../../lib/algorithms/deadlock";
import { Chip, LabFrame, Lane, Metric, NumListField, parseNums, StepControls, useStepper } from "./primitives";

function parseMatrix(text: string): Matrix | null {
  const rows = text.split("\n").map((r) => r.trim()).filter(Boolean).map(parseNums);
  if (rows.some((r) => !r)) return null;
  return rows as Matrix;
}

function MatrixField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const bad = parseMatrix(value) == null;
  return (
    <label className="flex flex-col gap-1">
      <span className="label">{label}</span>
      <textarea className={`field h-[110px] py-1 leading-5 resize-none ${bad ? "border-alert/70" : ""}`} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
    </label>
  );
}

export default function DeadlockLab() {
  const [mode, setMode] = useState<"banker" | "rag">("banker");
  return (
    <div className="flex flex-col gap-3">
      <Seg label="Deadlock topic" value={mode} onChange={setMode} options={[{ value: "banker", label: "Banker's algorithm" }, { value: "rag", label: "Resource-allocation graph" }]} />
      {mode === "banker" ? <Banker /> : <RagView />}
    </div>
  );
}

function Banker() {
  const [avail, setAvail] = useState("3 3 2");
  const [maxT, setMax] = useState("7 5 3\n3 2 2\n9 0 2\n2 2 2\n4 3 3");
  const [allocT, setAlloc] = useState("0 1 0\n2 0 0\n3 0 2\n2 1 1\n0 0 2");
  const [reqP, setReqP] = useState(1);
  const [reqT, setReqT] = useState("1 0 2");
  const a = parseNums(avail);
  const max = parseMatrix(maxT);
  const alloc = parseMatrix(allocT);
  const req = parseNums(reqT);

  const { res, err } = useMemo(() => {
    if (!a || !max || !alloc) return { res: null, err: "Matrices must contain only numbers" };
    try {
      return { res: bankerSafety(a, max, alloc), err: null };
    } catch (e) {
      return { res: null, err: (e as Error).message };
    }
  }, [avail, maxT, allocT]);
  const request = useMemo(() => {
    if (!res || !a || !max || !alloc || !req || req.length !== a.length || reqP < 0 || reqP >= max.length) return null;
    return bankerRequest(a, max, alloc, reqP, req);
  }, [res, reqP, reqT]);
  const s = useStepper(res?.steps.length ?? 0);
  const step = res?.steps[s.i];
  const m = a?.length ?? 0;

  return (
    <LabFrame
      title="Banker's Algorithm"
      code="K1"
      config={
        <div className="grid grid-cols-[1fr_1fr_1fr] gap-3">
          <div className="flex flex-col gap-3">
            <NumListField label={`Available (${m} resource types)`} value={avail} onChange={setAvail} />
            <div className="recess p-2 flex flex-col gap-2">
              <div className="label">Resource request</div>
              <div className="flex gap-2 items-end">
                <label className="flex flex-col gap-1">
                  <span className="label">Process</span>
                  <select className="field" value={reqP} onChange={(e) => setReqP(+e.target.value)}>
                    {(max ?? []).map((_, i) => <option key={i} value={i}>P{i}</option>)}
                  </select>
                </label>
                <NumListField label="Request vector" value={reqT} onChange={setReqT} />
              </div>
              {request && <div className={`text-[12px] ${request.granted ? "text-ok" : "text-amber"}`}>{request.message}</div>}
            </div>
          </div>
          <MatrixField label="Max (one row per process)" value={maxT} onChange={setMax} />
          <MatrixField label="Allocation" value={allocT} onChange={setAlloc} />
        </div>
      }
      controls={<StepControls s={s} />}
      explanation={
        <p>
          Banker's algorithm avoids deadlock by granting a request only if a <i>safe sequence</i> exists afterwards: an order in which every process can obtain its
          remaining Need (= Max − Allocation) from Work, finish, and release its allocation. An unsafe state is not necessarily deadlocked, but the OS can no longer
          guarantee to avoid deadlock.
        </p>
      }
    >
      {err && <ErrorNote>{err}</ErrorNote>}
      {res && step && (
        <>
          <table className="tbl w-auto">
            <thead>
              <tr>
                <th>Process</th>
                <th>Allocation</th>
                <th>Max</th>
                <th>Need</th>
                <th>Finished?</th>
              </tr>
            </thead>
            <tbody>
              {res.need.map((n, i) => (
                <tr key={i} className={step.process === i ? "bg-amber/[0.1]" : ""}>
                  <td className="readout">P{i}</td>
                  <td className="readout">{alloc![i].join(" ")}</td>
                  <td className="readout">{max![i].join(" ")}</td>
                  <td className="readout">{n.join(" ")}</td>
                  <td className={step.finish[i] ? "text-ok" : "text-ink-3"}>{step.finish[i] ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Lane label="Work">
            {step.work.map((w, i) => <Chip key={i}>R{i}={w}</Chip>)}
          </Lane>
          <Lane label="Sequence">
            {res.sequence.slice(0, step.finish.filter(Boolean).length).map((p) => <Chip key={p} color="#2AA198">P{p}</Chip>)}
          </Lane>
          <div className="text-[12px] text-ink-2">{step.message}</div>
          <div className="grid grid-cols-3 gap-2">
            <Metric label="State" value={<span className={res.safe ? "text-ok" : "text-alert"}>{res.safe ? "SAFE" : "UNSAFE"}</span>} />
            <Metric label="Safe sequence" value={res.safe ? res.sequence.map((p) => `P${p}`).join(" → ") : "none"} />
            <Metric label="Processes / resources" value={`${res.need.length} / ${m}`} />
          </div>
        </>
      )}
    </LabFrame>
  );
}

function RagView() {
  const [inst, setInst] = useState("1 1 2");
  const [allocT, setAlloc] = useState("1 0 0\n0 1 1\n0 0 1");
  const [reqT, setReq] = useState("0 1 0\n0 0 1\n1 0 0");
  const instances = parseNums(inst);
  const alloc = parseMatrix(allocT);
  const req = parseMatrix(reqT);
  const { r, err } = useMemo(() => {
    if (!instances || !alloc || !req) return { r: null, err: "Matrices must contain only numbers" };
    if (alloc.length !== req.length || alloc.some((row) => row.length !== instances.length) || req.some((row) => row.length !== instances.length))
      return { r: null, err: `Allocation and Request need one row per process and ${instances.length} columns` };
    try {
      return {
        r: detectDeadlock({ processes: alloc.map((_, i) => `P${i}`), resources: instances.map((n, i) => ({ id: `R${i}`, instances: n })), allocation: alloc, request: req }),
        err: null,
      };
    } catch (e) {
      return { r: null, err: (e as Error).message };
    }
  }, [inst, allocT, reqT]);

  const n = alloc?.length ?? 0;
  const m = instances?.length ?? 0;
  const W = 640;
  const px = (i: number) => 60 + (i * (W - 120)) / Math.max(1, n - 1);
  const rx = (j: number) => 60 + (j * (W - 120)) / Math.max(1, m - 1);
  const cyc = new Set(r?.cycle ?? []);

  return (
    <LabFrame
      title="Resource-Allocation Graph"
      code="K2"
      config={
        <div className="grid grid-cols-3 gap-3">
          <NumListField label="Instances per resource" value={inst} onChange={setInst} />
          <MatrixField label="Allocation (process × resource)" value={allocT} onChange={setAlloc} />
          <MatrixField label="Request (waiting for)" value={reqT} onChange={setReq} />
        </div>
      }
      explanation={
        <p>
          A request edge P → R means P waits for R; an assignment edge R → P means P holds an instance of R. With single-instance resources, a cycle means deadlock. With
          multiple instances a cycle is necessary but not sufficient, so FlowDesk runs the detection algorithm (Work/Finish over the Request matrix) to find which
          processes are actually deadlocked.
        </p>
      }
    >
      {err && <ErrorNote>{err}</ErrorNote>}
      {r && alloc && req && instances && (
        <>
          <svg viewBox={`0 0 ${W} 230`} className="w-full max-w-[760px] recess" role="img" aria-label="Resource allocation graph">
            <defs>
              <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" fill="rgb(var(--steel-hi))" />
              </marker>
              <marker id="arrA" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" fill="rgb(var(--alert))" />
              </marker>
            </defs>
            {alloc.map((row, i) =>
              row.map((v, j) =>
                v > 0 ? (
                  <line key={`a${i}${j}`} x1={rx(j)} y1={172} x2={px(i)} y2={62} stroke={cyc.has(i) ? "rgb(var(--alert))" : "rgb(var(--steel-hi))"} strokeWidth={1.5} markerEnd={cyc.has(i) ? "url(#arrA)" : "url(#arr)"} />
                ) : null,
              ),
            )}
            {req.map((row, i) =>
              row.map((v, j) =>
                v > 0 ? (
                  <line key={`r${i}${j}`} x1={px(i) + 6} y1={62} x2={rx(j) + 6} y2={172} stroke={cyc.has(i) ? "rgb(var(--alert))" : "rgb(var(--amber))"} strokeDasharray="5 3" strokeWidth={1.5} markerEnd={cyc.has(i) ? "url(#arrA)" : "url(#arr)"} />
                ) : null,
              ),
            )}
            {alloc.map((_, i) => (
              <g key={i}>
                <circle cx={px(i)} cy={40} r={20} fill="rgb(var(--panel-raised))" stroke={r.deadlocked.includes(i) ? "rgb(var(--alert))" : "rgb(var(--ok))"} strokeWidth={2} />
                <text x={px(i)} y={44} textAnchor="middle" fontSize="12" fill="rgb(var(--ink))" fontFamily="JetBrains Mono">P{i}</text>
              </g>
            ))}
            {instances.map((k, j) => (
              <g key={j}>
                <rect x={rx(j) - 24} y={172} width={48} height={36} rx={2} fill="rgb(var(--panel-raised))" stroke="rgb(var(--steel-hi))" />
                <text x={rx(j)} y={188} textAnchor="middle" fontSize="12" fill="rgb(var(--ink))" fontFamily="JetBrains Mono">R{j}</text>
                {Array.from({ length: k }, (_, d) => <circle key={d} cx={rx(j) - ((k - 1) * 7) / 2 + d * 7} cy={200} r={2.5} fill="rgb(var(--ink-2))" />)}
              </g>
            ))}
          </svg>
          <div className="text-[11px] text-ink-3">Solid: assignment R → P · dashed: request P → R · red: on a wait-for cycle</div>
          <div className="grid grid-cols-4 gap-2">
            <Metric label="Deadlocked" value={<span className={r.deadlocked.length ? "text-alert" : "text-ok"}>{r.deadlocked.length ? r.deadlocked.map((i) => `P${i}`).join(", ") : "none"}</span>} />
            <Metric label="Wait-for cycle" value={r.cycle ? r.cycle.map((i) => `P${i}`).join(" → ") + ` → P${r.cycle[0]}` : "none"} />
            <Metric label="Can finish (order)" value={r.order.length ? r.order.map((i) => `P${i}`).join(" → ") : "—"} />
            <Metric label="Available" value={r.available.join(" ")} />
          </div>
        </>
      )}
    </LabFrame>
  );
}
