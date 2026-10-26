import { useMemo, useState } from "react";
import { ErrorNote, Seg } from "../../components/industrial/Panel";
import { allocate, fixedPartitions, pageReplacement, translatePaging, translateSegment, type AllocOp, type FitAlgo, type PageAlgo } from "../../lib/algorithms/memory";
import { Chip, entityColor, LabFrame, Lane, Metric, NumField, NumListField, parseNums, StepControls, useStepper } from "./primitives";

type Mode = "replacement" | "paging" | "segmentation" | "allocation";

export default function MemoryLab() {
  const [mode, setMode] = useState<Mode>("replacement");
  return (
    <div className="flex flex-col gap-3">
      <Seg
        label="Memory topic"
        value={mode}
        onChange={setMode}
        options={[
          { value: "replacement", label: "Page replacement" },
          { value: "paging", label: "Paging & translation" },
          { value: "segmentation", label: "Segmentation" },
          { value: "allocation", label: "Contiguous allocation" },
        ]}
      />
      {mode === "replacement" && <Replacement />}
      {mode === "paging" && <Paging />}
      {mode === "segmentation" && <Segmentation />}
      {mode === "allocation" && <Allocation />}
    </div>
  );
}

// ------------------------------------------------------------ replacement

function Replacement() {
  const [refsText, setRefs] = useState("7 0 1 2 0 3 0 4 2 3 0 3 2 1 2 0 1 7 0 1");
  const [frames, setFrames] = useState(3);
  const [algo, setAlgo] = useState<PageAlgo>("lru");
  const refs = parseNums(refsText);
  const r = useMemo(() => (refs && refs.length ? pageReplacement(refs, frames, algo) : null), [refsText, frames, algo]);
  const all = useMemo(() => (refs && refs.length ? (["fifo", "lru", "opt"] as PageAlgo[]).map((a) => ({ a, f: pageReplacement(refs, frames, a).faults })) : []), [refsText, frames]);
  const s = useStepper(r?.steps.length ?? 0);
  const step = r?.steps[s.i];
  return (
    <LabFrame
      title="Page Replacement"
      code="M1"
      config={
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[300px]">
            <NumListField label="Reference string" value={refsText} onChange={setRefs} hint="Page numbers separated by spaces or commas" />
          </div>
          <NumField label="Frames" value={frames} min={1} max={10} onChange={setFrames} />
          <Seg label="Algorithm" value={algo} onChange={setAlgo} options={[{ value: "fifo", label: "FIFO" }, { value: "lru", label: "LRU" }, { value: "opt", label: "Optimal" }]} />
        </div>
      }
      controls={<StepControls s={s} label="ref" />}
      explanation={
        <>
          <p><b>FIFO</b> evicts the page loaded earliest. It is cheap but can show Belady's anomaly (more frames, more faults; try <span className="font-mono">1 2 3 4 1 2 5 1 2 3 4 5</span> with 3 vs 4 frames).</p>
          <p><b>LRU</b> evicts the page unused for the longest time. It approximates Optimal, and real kernels approximate LRU with reference bits (clock).</p>
          <p><b>Optimal</b> evicts the page used farthest in the future. It needs future knowledge, so it is the benchmark lower bound.</p>
        </>
      }
    >
      {!refs && <ErrorNote>Reference string must contain only numbers.</ErrorNote>}
      {r && step && (
        <>
          <div className="overflow-x-auto">
            <table className="border-collapse">
              <tbody>
                <tr>
                  <td className="label pr-2">ref</td>
                  {r.steps.map((st, i) => (
                    <td key={i} className={`readout text-center w-8 h-7 text-[12px] ${i === s.i ? "text-amber" : i > s.i ? "text-ink-3/40" : ""}`}>{st.ref}</td>
                  ))}
                </tr>
                {Array.from({ length: frames }, (_, f) => (
                  <tr key={f}>
                    <td className="label pr-2">F{f}</td>
                    {r.steps.map((st, i) => {
                      const v = st.frames[f];
                      const changed = !st.hit && st.slot === f;
                      return (
                        <td key={i} className="p-0.5">
                          <div
                            className={`w-7 h-7 flex items-center justify-center readout text-[12px] rounded-sm transition-all duration-200 ${i > s.i ? "opacity-15" : ""}`}
                            style={{ background: changed ? "rgb(var(--amber) / .85)" : v == null ? "transparent" : "rgb(var(--panel-raised))", color: changed ? "#111" : undefined, border: "1px solid rgb(var(--steel-dim))" }}
                          >
                            {v ?? ""}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr>
                  <td className="label pr-2" />
                  {r.steps.map((st, i) => (
                    <td key={i} className={`text-center text-[10px] font-semibold ${i > s.i ? "opacity-15" : ""} ${st.hit ? "text-ok" : "text-alert"}`}>{st.hit ? "H" : "F"}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <div className="text-[12px] text-ink-2">Step {s.i + 1}: {step.reason}</div>
          <div className="grid grid-cols-5 gap-2">
            <Metric label="Page faults" value={r.faults} />
            <Metric label="Hits" value={r.hits} />
            <Metric label="Hit ratio" value={`${(r.hitRatio * 100).toFixed(1)}%`} />
            {all.map((x) => <Metric key={x.a} label={`${x.a.toUpperCase()} faults`} value={x.f} sub="same input" />)}
          </div>
        </>
      )}
    </LabFrame>
  );
}

// ------------------------------------------------------------ paging

function Paging() {
  const [pageSize, setPageSize] = useState(1024);
  const [tableText, setTable] = useState("5 2 - 7 9 - 1 3");
  const [addr, setAddr] = useState(5000);
  const table = tableText.split(/[\s,]+/).filter(Boolean).map((x) => (x === "-" ? null : Number(x)));
  const bad = table.some((x) => x != null && !Number.isInteger(x));
  let res: ReturnType<typeof translatePaging> | null = null;
  let err: string | null = null;
  try {
    if (!bad) res = translatePaging(addr, pageSize, table);
  } catch (e) {
    err = (e as Error).message;
  }
  const bits = res ? res.pageBits + res.offsetBits : 0;
  const bin = res ? addr.toString(2).padStart(bits, "0") : "";
  return (
    <LabFrame
      title="Paging & Address Translation"
      code="M2"
      config={
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="label">Page size (bytes)</span>
            <select className="field" value={pageSize} onChange={(e) => setPageSize(+e.target.value)}>
              {[256, 512, 1024, 2048, 4096].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <div className="flex-1 min-w-[260px]">
            <label className="flex flex-col gap-1">
              <span className="label">Page table (frame per page, “-” = invalid)</span>
              <input className={`field ${bad ? "border-alert/70" : ""}`} value={tableText} onChange={(e) => setTable(e.target.value)} />
            </label>
          </div>
          <NumField label="Logical address" value={addr} min={0} width="w-28" onChange={setAddr} />
        </div>
      }
      explanation={
        <p>
          The MMU splits a logical address into a page number (high bits) and an offset (low log₂(page size) bits). The page number indexes the page table; a valid entry
          supplies the frame, and physical address = frame × page size + offset. An invalid entry raises a page fault, which the OS handles by loading the page.
        </p>
      }
    >
      {err && <ErrorNote>{err}</ErrorNote>}
      {res && (
        <>
          <div className="flex items-center gap-4 flex-wrap">
            <div>
              <div className="label mb-1">Logical address bits</div>
              <div className="flex font-mono text-[13px]">
                {bin.split("").map((b, i) => (
                  <span key={i} className={`w-5 h-7 flex items-center justify-center border border-steel-dim ${i < bin.length - res!.offsetBits ? "bg-[#3D8FE0]/25" : "bg-[#C26B2E]/25"}`}>{b}</span>
                ))}
              </div>
              <div className="flex text-[10.5px] mt-1 gap-3">
                <span className="text-[#7fb5ee]">page = {res.page}</span>
                <span className="text-[#e09a66]">offset = {res.offset} ({res.offsetBits} bits)</span>
              </div>
            </div>
            <div className="text-ink-3">→</div>
            <div>
              <div className="label mb-1">Page table</div>
              <div className="flex gap-0.5">
                {table.map((f, i) => (
                  <div key={i} className={`w-10 text-center rounded-sm border ${i === res!.page ? "border-amber text-amber" : "border-steel-dim"}`}>
                    <div className="text-[9.5px] text-ink-3">p{i}</div>
                    <div className="readout text-[12px]">{f ?? "✗"}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="text-ink-3">→</div>
            <Metric label="Physical address" value={res.physical ?? "fault"} sub={res.frame != null ? `frame ${res.frame}` : undefined} />
          </div>
          <div className={`text-[12px] ${res.ok ? "text-ok" : "text-alert"}`}>{res.message}</div>
        </>
      )}
    </LabFrame>
  );
}

// ------------------------------------------------------------ segmentation

function Segmentation() {
  const [segText, setSeg] = useState("1400:1000, 6300:400, 4300:400, 3200:1100, 4700:1000");
  const [seg, setSegN] = useState(2);
  const [off, setOff] = useState(53);
  const table = segText.split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
    const [b, l] = p.split(":").map(Number);
    return { base: b, limit: l };
  });
  const bad = table.some((t) => !Number.isFinite(t.base) || !Number.isFinite(t.limit));
  const r = bad ? null : translateSegment(seg, off, table);
  const total = Math.max(1, ...table.map((t) => t.base + t.limit));
  return (
    <LabFrame
      title="Segmentation"
      code="M3"
      config={
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[300px]">
            <label className="flex flex-col gap-1">
              <span className="label">Segment table (base:limit, …)</span>
              <input className={`field ${bad ? "border-alert/70" : ""}`} value={segText} onChange={(e) => setSeg(e.target.value)} />
            </label>
          </div>
          <NumField label="Segment" value={seg} min={0} onChange={setSegN} />
          <NumField label="Offset" value={off} min={0} width="w-24" onChange={setOff} />
        </div>
      }
      explanation={<p>A logical address is a (segment, offset) pair. The offset is checked against the segment's limit; if it is in range, physical = base + offset. Otherwise the hardware traps to the OS (segmentation fault).</p>}
    >
      {r && (
        <>
          <div className="relative h-12 recess">
            {table.map((t, i) => (
              <div
                key={i}
                className="absolute top-1 bottom-1 rounded-sm flex items-center justify-center text-[10.5px] font-mono"
                style={{ left: `${(t.base / total) * 100}%`, width: `${(t.limit / total) * 100}%`, background: i === seg ? "rgb(var(--amber) / .8)" : "rgb(var(--steel-dim))", color: i === seg ? "#111" : undefined }}
                title={`S${i}: ${t.base}–${t.base + t.limit}`}
              >
                S{i}
              </div>
            ))}
            {r.ok && <div className="absolute -top-1 -bottom-1 w-[2px] bg-ok" style={{ left: `${(r.physical! / total) * 100}%` }} />}
          </div>
          <div className={`text-[12px] ${r.ok ? "text-ok" : "text-alert"}`}>{r.message}</div>
        </>
      )}
    </LabFrame>
  );
}

// ------------------------------------------------------------ allocation

function Allocation() {
  const [kind, setKind] = useState<"dynamic" | "fixed">("dynamic");
  const [algo, setAlgo] = useState<FitAlgo>("first");
  const [total, setTotal] = useState(1000);
  const [opsText, setOps] = useState("A=212, B=417, C=112, free B, D=426, E=300, free A, F=150");
  const [partsText, setParts] = useState("100 500 200 300 600");
  const [reqText, setReq] = useState("212 417 112 426");

  const ops: AllocOp[] | null = useMemo(() => {
    const out: AllocOp[] = [];
    for (const raw of opsText.split(",").map((s) => s.trim()).filter(Boolean)) {
      const f = raw.match(/^free\s+(\w+)$/i);
      const a = raw.match(/^(\w+)\s*=\s*(\d+)$/);
      if (f) out.push({ kind: "free", pid: f[1] });
      else if (a) out.push({ kind: "alloc", pid: a[1], size: +a[2] });
      else return null;
    }
    return out;
  }, [opsText]);
  const r = useMemo(() => (ops && kind === "dynamic" ? allocate(total, ops, algo) : null), [ops, total, algo, kind]);
  const fixed = useMemo(() => {
    const p = parseNums(partsText);
    const q = parseNums(reqText);
    return kind === "fixed" && p && q ? { parts: p, res: fixedPartitions(p, q, algo), req: q } : null;
  }, [partsText, reqText, algo, kind]);
  const s = useStepper(r?.steps.length ?? 0);
  const step = r?.steps[s.i];
  const owners = ops ? [...new Set(ops.map((o) => o.pid))] : [];

  return (
    <LabFrame
      title="Contiguous Allocation"
      code="M4"
      config={
        <div className="flex flex-col gap-3">
          <div className="flex gap-3 items-center">
            <Seg label="Partitioning" value={kind} onChange={setKind} options={[{ value: "dynamic", label: "Dynamic (variable)" }, { value: "fixed", label: "Fixed partitions" }]} />
            <Seg label="Fit" value={algo} onChange={setAlgo} options={[{ value: "first", label: "First Fit" }, { value: "best", label: "Best Fit" }, { value: "worst", label: "Worst Fit" }]} />
          </div>
          {kind === "dynamic" ? (
            <div className="flex gap-3 items-end">
              <NumField label="Memory size" value={total} min={10} width="w-24" onChange={setTotal} />
              <label className="flex flex-col gap-1 flex-1">
                <span className="label">Operations (“A=212” allocates, “free A” releases)</span>
                <input className={`field ${ops ? "" : "border-alert/70"}`} value={opsText} onChange={(e) => setOps(e.target.value)} />
              </label>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <NumListField label="Partition sizes" value={partsText} onChange={setParts} />
              <NumListField label="Process sizes (in order)" value={reqText} onChange={setReq} />
            </div>
          )}
        </div>
      }
      controls={kind === "dynamic" ? <StepControls s={s} label="op" /> : undefined}
      explanation={
        <>
          <p><b>First Fit</b> takes the first hole that is large enough (fast). <b>Best Fit</b> takes the smallest adequate hole, leaving tiny unusable slivers. <b>Worst Fit</b> takes the largest hole, hoping the remainder stays usable.</p>
          <p>Dynamic partitions suffer <i>external</i> fragmentation: enough total free space but no single hole is large enough. Fixed partitions suffer <i>internal</i> fragmentation: unused space inside an allocated partition.</p>
        </>
      }
    >
      {kind === "dynamic" && !ops && <ErrorNote>Could not parse the operations list.</ErrorNote>}
      {kind === "dynamic" && r && step && (
        <>
          <div className="relative h-14 recess">
            {step.blocks.map((b, i) => (
              <div
                key={i}
                className="absolute top-1 bottom-1 flex flex-col items-center justify-center text-[10.5px] font-mono rounded-sm transition-all duration-300 overflow-hidden"
                style={{
                  left: `${(b.start / total) * 100}%`,
                  width: `calc(${(b.size / total) * 100}% - 2px)`,
                  background: b.owner ? entityColor(b.owner, owners) : "repeating-linear-gradient(45deg, rgb(var(--steel-dim)) 0 4px, transparent 4px 8px)",
                  color: b.owner ? "#0d0f10" : "rgb(var(--ink-3))",
                }}
                title={`${b.owner ?? "hole"} @${b.start} size ${b.size}`}
              >
                <span>{b.owner ?? "free"}</span>
                <span className="opacity-70">{b.size}</span>
              </div>
            ))}
          </div>
          <div className={`text-[12px] ${step.ok ? "text-ink-2" : "text-alert"}`}>Op {s.i + 1}: {step.message}</div>
          <div className="grid grid-cols-5 gap-2">
            <Metric label="Failed requests" value={r.failed} />
            <Metric label="Free (final)" value={r.finalFree} />
            <Metric label="Holes" value={r.holes} />
            <Metric label="Largest hole" value={r.largestHole} />
            <Metric label="External fragmentation" value={`${(r.externalFragmentation * 100).toFixed(0)}%`} sub="1 − largest/free" />
          </div>
        </>
      )}
      {fixed && (
        <>
          <Lane label="Partitions">
            {fixed.parts.map((p, i) => {
              const pl = fixed.res.placement.find((x) => x.partition === i);
              return (
                <Chip key={i} color={pl ? entityColor(`P${pl.process}`, fixed.req.map((_, k) => `P${k}`)) : undefined} title={pl ? `P${pl.process} (${pl.size}) wastes ${pl.internal}` : "unused"}>
                  #{i}:{p}{pl ? ` ← P${pl.process}(${pl.size})` : ""}
                </Chip>
              );
            })}
          </Lane>
          <div className="grid grid-cols-3 gap-2">
            <Metric label="Unplaced processes" value={fixed.res.unplaced} />
            <Metric label="Internal fragmentation" value={fixed.res.internalFragmentation} />
            <Metric label="Placed" value={fixed.res.placement.length - fixed.res.unplaced} />
          </div>
        </>
      )}
    </LabFrame>
  );
}
