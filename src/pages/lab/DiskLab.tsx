import { useMemo, useState } from "react";
import { ErrorNote, Seg } from "../../components/industrial/Panel";
import { diskSchedule, simulateBuffering, type BufferScheme, type DiskAlgo } from "../../lib/algorithms/disk";
import { LabFrame, Metric, NumField, NumListField, parseNums, StepControls, useStepper } from "./primitives";

const ALGOS: { value: DiskAlgo; label: string }[] = [
  { value: "fcfs", label: "FCFS" },
  { value: "sstf", label: "SSTF" },
  { value: "scan", label: "SCAN" },
  { value: "cscan", label: "C-SCAN" },
  { value: "look", label: "LOOK" },
  { value: "clook", label: "C-LOOK" },
];

export default function DiskLab() {
  const [topic, setTopic] = useState<"arm" | "buffer">("arm");
  return (
    <div className="flex flex-col gap-3">
      <Seg label="Disk topic" value={topic} onChange={setTopic} options={[{ value: "arm", label: "Disk-arm scheduling" }, { value: "buffer", label: "I/O buffering" }]} />
      {topic === "arm" ? <Arm /> : <Buffering />}
    </div>
  );
}

function Arm() {
  const [reqText, setReq] = useState("98 183 37 122 14 124 65 67");
  const [head, setHead] = useState(53);
  const [cyl, setCyl] = useState(200);
  const [dir, setDir] = useState<"up" | "down">("up");
  const [countWrap, setCountWrap] = useState(true);
  const [algo, setAlgo] = useState<DiskAlgo>("sstf");
  const req = parseNums(reqText);
  const { r, all, err } = useMemo(() => {
    if (!req) return { r: null, all: [], err: "Requests must be numbers" };
    try {
      const o = { cylinders: cyl, direction: dir, countWrap };
      return { r: diskSchedule(req, head, algo, o), all: ALGOS.map((a) => ({ a: a.label, m: diskSchedule(req, head, a.value, o).movement })), err: null };
    } catch (e) {
      return { r: null, all: [], err: (e as Error).message };
    }
  }, [reqText, head, cyl, dir, countWrap, algo]);
  const s = useStepper(r ? r.path.length : 0);
  const W = 760;
  const H = Math.max(160, (r?.path.length ?? 0) * 22 + 30);
  const x = (c: number) => 20 + (c / (cyl - 1)) * (W - 40);
  const best = Math.min(...all.map((a) => a.m));
  return (
    <LabFrame
      title="Disk-Arm Scheduling"
      code="D1"
      config={
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[260px]"><NumListField label="Request queue (cylinders)" value={reqText} onChange={setReq} /></div>
          <NumField label="Head" value={head} min={0} max={cyl - 1} onChange={setHead} />
          <NumField label="Cylinders" value={cyl} min={10} max={10000} onChange={setCyl} />
          <Seg label="Direction" value={dir} onChange={setDir} options={[{ value: "up", label: "→ higher" }, { value: "down", label: "← lower" }]} />
          <Seg label="Algorithm" value={algo} onChange={setAlgo} options={ALGOS} />
          <label className="flex items-center gap-1.5 text-[11.5px] text-ink-2 h-8">
            <input type="checkbox" className="accent-[rgb(var(--amber))]" checked={countWrap} onChange={(e) => setCountWrap(e.target.checked)} /> count circular return
          </label>
        </div>
      }
      controls={<StepControls s={s} label="move" />}
      explanation={
        <>
          <p><b>FCFS</b> is fair but zig-zags. <b>SSTF</b> picks the nearest request (low movement, but far requests can starve). <b>SCAN</b> (elevator) sweeps to the end of the disk and reverses; <b>LOOK</b> reverses at the last request. <b>C-SCAN / C-LOOK</b> serve in one direction only and jump back, giving more uniform waiting times.</p>
          {r?.notes.map((n, i) => <p key={i} className="text-ink-3">{n}</p>)}
        </>
      }
    >
      {err && <ErrorNote>{err}</ErrorNote>}
      {r && (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full recess" role="img" aria-label="Head movement">
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <g key={f}>
                <line x1={x(f * (cyl - 1))} x2={x(f * (cyl - 1))} y1={14} y2={H - 6} stroke="rgb(255 255 255 / .05)" />
                <text x={x(f * (cyl - 1))} y={11} fontSize="9.5" textAnchor="middle" fill="rgb(var(--ink-3))" fontFamily="JetBrains Mono">{Math.round(f * (cyl - 1))}</text>
              </g>
            ))}
            <polyline
              points={r.path.slice(0, s.i + 1).map((c, i) => `${x(c)},${24 + i * 22}`).join(" ")}
              fill="none"
              stroke="rgb(var(--amber))"
              strokeWidth={2}
              strokeLinejoin="round"
            />
            {r.path.map((c, i) => (
              <g key={i} opacity={i > s.i ? 0.15 : 1}>
                <circle cx={x(c)} cy={24 + i * 22} r={r.passThrough.includes(c) && i > 0 ? 3 : 5} fill={i === 0 ? "rgb(var(--ok))" : r.passThrough.includes(c) ? "rgb(var(--steel-hi))" : "rgb(var(--amber))"} stroke="rgb(var(--panel-sunk))" strokeWidth={2} />
                <text x={x(c) + 8} y={28 + i * 22} fontSize="10" fill="rgb(var(--ink-2))" fontFamily="JetBrains Mono">{c}</text>
              </g>
            ))}
          </svg>
          <div className="grid grid-cols-[repeat(3,minmax(0,1fr))_2fr] gap-2">
            <Metric label="Total head movement" value={r.movement} sub="cylinders" />
            <Metric label="Average seek" value={r.avgSeek.toFixed(1)} sub="per request" />
            <Metric label="Service order" value={r.order.join(" ")} />
            <div className="recess px-2.5 py-1.5">
              <div className="label">Same queue, every algorithm</div>
              <div className="flex flex-wrap gap-x-3 text-[12px]">
                {all.map((a) => <span key={a.a} className={`readout ${a.m === best ? "text-ok" : ""}`}>{a.a} {a.m}</span>)}
              </div>
            </div>
          </div>
        </>
      )}
    </LabFrame>
  );
}

function Buffering() {
  const [blocks, setBlocks] = useState(8);
  const [T, setT] = useState(10);
  const [M, setM] = useState(2);
  const [cText, setC] = useState("6 6 14 4 6 16 4 6");
  const [k, setK] = useState(4);
  const C = parseNums(cText);
  const schemes: { s: BufferScheme; label: string }[] = [
    { s: "none", label: "No buffering" },
    { s: "single", label: "Single" },
    { s: "double", label: "Double" },
    { s: "circular", label: `Circular (${k})` },
  ];
  const results = useMemo(() => (C && C.length && C.every((c) => c >= 0) ? schemes.map((x) => ({ ...x, r: simulateBuffering(blocks, T, M, C, x.s, k) })) : null), [blocks, T, M, cText, k]);
  const max = results ? Math.max(...results.map((x) => x.r.total)) : 1;
  const W = 760;
  const sx = (t: number) => (t / max) * (W - 130);
  return (
    <LabFrame
      title="I/O Buffering"
      code="D2"
      config={
        <div className="flex flex-wrap gap-3 items-end">
          <NumField label="Blocks" value={blocks} min={1} max={30} onChange={setBlocks} />
          <NumField label="Device read T" value={T} min={1} max={100} onChange={setT} />
          <NumField label="Copy to user M" value={M} min={0} max={50} onChange={setM} />
          <div className="flex-1 min-w-[220px]"><NumListField label="Compute time C per block (cycled)" value={cText} onChange={setC} /></div>
          <NumField label="Circular buffers" value={k} min={2} max={10} onChange={setK} />
        </div>
      }
      explanation={
        <p>
          With <b>no buffering</b> the device and the process take turns. A <b>single</b> system buffer lets the device read block i+1 while the process computes on block i, so
          time per block ≈ max(C, T) + M. <b>Double</b> buffering also overlaps the copy, so ≈ max(C + M, T). A <b>circular</b> buffer of k slots absorbs bursts of slow
          computation, which matters when C varies from block to block.
        </p>
      }
    >
      {!results && <ErrorNote>Compute times must be non-negative numbers.</ErrorNote>}
      {results && (
        <>
          <svg viewBox={`0 0 ${W} ${results.length * 58 + 10}`} className="w-full" role="img" aria-label="Buffering timelines">
            {results.map((x, row) => (
              <g key={x.s} transform={`translate(0 ${row * 58 + 4})`}>
                <text x={0} y={14} fontSize="11" fill="rgb(var(--ink-2))">{x.label}</text>
                <text x={0} y={30} fontSize="10" fill="rgb(var(--ink-3))" fontFamily="JetBrains Mono">total {x.r.total}</text>
                <text x={92} y={14} fontSize="9" fill="rgb(var(--ink-3))">dev</text>
                <text x={92} y={36} fontSize="9" fill="rgb(var(--ink-3))">cpu</text>
                {x.r.timeline.map((b) => (
                  <g key={b.block}>
                    <rect x={120 + sx(b.fillStart)} y={4} width={Math.max(1, sx(b.fillEnd - b.fillStart) - 1)} height={14} fill="#2AA198" rx={1}><title>read block {b.block}: {b.fillStart}–{b.fillEnd}</title></rect>
                    {b.copyEnd > b.copyStart && <rect x={120 + sx(b.copyStart)} y={26} width={Math.max(1, sx(b.copyEnd - b.copyStart) - 1)} height={14} fill="#B455C9" rx={1}><title>copy block {b.block}</title></rect>}
                    <rect x={120 + sx(b.computeStart)} y={26} width={Math.max(1, sx(b.computeEnd - b.computeStart) - 1)} height={14} fill="#C26B2E" rx={1}><title>compute block {b.block}: {b.computeStart}–{b.computeEnd}</title></rect>
                  </g>
                ))}
              </g>
            ))}
          </svg>
          <div className="flex gap-4 text-[11px] text-ink-3">
            <span><span className="inline-block w-3 h-2 mr-1" style={{ background: "#2AA198" }} />device read (T)</span>
            <span><span className="inline-block w-3 h-2 mr-1" style={{ background: "#B455C9" }} />copy to user space (M)</span>
            <span><span className="inline-block w-3 h-2 mr-1" style={{ background: "#C26B2E" }} />compute (C)</span>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {results.map((x) => <Metric key={x.s} label={x.label} value={x.r.total} sub={`${x.r.perBlock.toFixed(1)}/block · device ${(x.r.deviceBusy * 100).toFixed(0)}% busy`} />)}
          </div>
        </>
      )}
    </LabFrame>
  );
}
