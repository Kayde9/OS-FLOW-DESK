import { useMemo, useState } from "react";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { ErrorNote, Seg } from "../../components/industrial/Panel";
import { accessCost, apply, emptyFs, metrics, type AllocMethod, type FsOp } from "../../lib/algorithms/filesystem";
import { entityColor, LabFrame, Metric, NumField } from "./primitives";

const PRESET: FsOp[] = [
  { kind: "create", name: "a.txt", size: 5 },
  { kind: "create", name: "b.bin", size: 7 },
  { kind: "create", name: "c.log", size: 4 },
  { kind: "create", name: "d.img", size: 6 },
  { kind: "delete", name: "b.bin" },
  { kind: "delete", name: "d.img" },
  { kind: "create", name: "e.mp4", size: 10 },
];

function replay(method: AllocMethod, size: number, ops: FsOp[]) {
  let s = emptyFs(method, size);
  const log: { op: FsOp; ok: boolean; message: string }[] = [];
  for (const op of ops) {
    const st = apply(s, op);
    s = st.state;
    log.push({ op, ok: st.ok, message: st.message });
  }
  return { state: s, log };
}

export default function FsLab() {
  const [method, setMethod] = useState<AllocMethod>("contiguous");
  const [size, setSize] = useState(32);
  const [ops, setOps] = useState<FsOp[]>(PRESET);
  const [name, setName] = useState("f.dat");
  const [fsize, setFsize] = useState(3);
  const [focus, setFocus] = useState<string | null>(null);
  const { state, log } = useMemo(() => replay(method, size, ops), [method, size, ops]);
  const m = metrics(state);
  const names = [...new Set(ops.filter((o) => o.kind === "create").map((o) => o.name))];
  const file = state.files.find((f) => f.name === focus) ?? null;

  return (
    <LabFrame
      title="File Allocation"
      code="F1"
      config={
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3 items-end">
            <Seg label="Method" value={method} onChange={setMethod} options={[{ value: "contiguous", label: "Contiguous" }, { value: "linked", label: "Linked" }, { value: "indexed", label: "Indexed" }]} />
            <NumField label="Disk blocks" value={size} min={8} max={96} onChange={setSize} />
            <label className="flex flex-col gap-1">
              <span className="label">File name</span>
              <input className="field w-28" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <NumField label="Blocks" value={fsize} min={1} max={64} onChange={setFsize} />
            <button className="btn" onClick={() => setOps((o) => [...o, { kind: "create", name: name.trim(), size: fsize }])}><Plus size={14} /> Create</button>
            <button className="btn" onClick={() => setOps(PRESET)}><RotateCcw size={14} /> Preset</button>
            <button className="btn" onClick={() => setOps([])}>Format disk</button>
          </div>
          <p className="text-[11px] text-ink-3">The same create/delete sequence is replayed under each method. Click a file to see its directory entry, and delete it from there.</p>
        </div>
      }
      explanation={
        <>
          <p><b>Contiguous</b>: the directory stores (start, length). Sequential and random access are fast, but external fragmentation can make a create fail even when enough blocks are free.</p>
          <p><b>Linked</b>: each block stores a pointer to the next. There is no external fragmentation, but reaching block k costs k + 1 reads and one damaged pointer loses the rest of the file.</p>
          <p><b>Indexed</b>: an index block lists every data block, giving direct access in 2 reads at the cost of one extra block per file.</p>
        </>
      }
    >
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: "repeat(16, minmax(0, 1fr))" }} role="grid" aria-label="Disk blocks">
        {state.disk.map((owner, i) => {
          const base = owner?.replace("#idx", "") ?? null;
          const isIdx = owner?.endsWith("#idx");
          const order = file ? file.blocks.indexOf(i) : -1;
          return (
            <button
              key={i}
              onClick={() => base && setFocus(base)}
              className={`h-9 rounded-sm text-[10px] font-mono flex flex-col items-center justify-center transition-all duration-200 border ${base && base === focus ? "border-amber" : "border-transparent"}`}
              style={{ background: base ? entityColor(base, names) : "rgb(var(--panel-sunk))", color: base ? "#0d0f10" : "rgb(var(--ink-3))", outline: isIdx ? "2px dashed rgb(var(--ink))" : undefined, outlineOffset: -4 }}
              title={owner ? `${base}${isIdx ? " (index block)" : ""}` : "free"}
            >
              <span className="opacity-70">{i}</span>
              {order >= 0 && file && method === "linked" && <span>{file.blocks[order + 1] ?? "∅"}</span>}
              {isIdx && <span>idx</span>}
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-[1fr_320px] gap-4">
        <div className="recess p-2 text-[11.5px] max-h-[160px] overflow-auto">
          <div className="label mb-1">Operation log</div>
          {log.map((l, i) => (
            <div key={i} className={l.ok ? "text-ink-2" : "text-alert"}>
              <span className="readout text-ink-3 mr-2">{i + 1}</span>
              {l.op.kind === "create" ? `create ${l.op.name} (${l.op.size})` : `delete ${l.op.name}`}: {l.message}
            </div>
          ))}
          {!log.length && <span className="text-ink-3">Disk is empty.</span>}
        </div>
        <div className="recess p-2 text-[12px]">
          <div className="label mb-1">Directory entry</div>
          {file ? (
            <div className="flex flex-col gap-1">
              <div className="font-medium">{file.name}</div>
              <div className="readout text-ink-2 text-[11.5px]">
                {method === "contiguous" && `start ${file.blocks[0]}, length ${file.size}`}
                {method === "linked" && `start ${file.blocks[0]}, end ${file.blocks[file.blocks.length - 1]}`}
                {method === "indexed" && `index block ${file.indexBlock} → [${file.blocks.join(", ")}]`}
              </div>
              <div className="text-[11px] text-ink-3">Reads to reach last block: {accessCost(method, file.size - 1)}</div>
              <button className="btn btn-sm btn-danger self-start mt-1" onClick={() => (setOps((o) => [...o, { kind: "delete", name: file.name }]), setFocus(null))}>
                <Trash2 size={12} /> Delete {file.name}
              </button>
            </div>
          ) : (
            <span className="text-ink-3">Select a file block.</span>
          )}
        </div>
      </div>
      {log.some((l) => !l.ok) && method === "contiguous" && <ErrorNote>A create failed under contiguous allocation. Switch to Linked or Indexed to see the same workload succeed.</ErrorNote>}
      <div className="grid grid-cols-5 gap-2">
        <Metric label="Used blocks" value={`${m.used}/${state.disk.length}`} />
        <Metric label="Free runs" value={m.freeRuns} sub={`largest ${m.largestFreeRun}`} />
        <Metric label="Index overhead" value={m.overhead} sub="blocks" />
        <Metric label="Next-pointers" value={m.pointers} sub="linked only" />
        <Metric label="Files" value={state.files.length} />
      </div>
    </LabFrame>
  );
}

