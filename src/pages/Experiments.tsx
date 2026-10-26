import { useEffect, useMemo, useState } from "react";
import { Download, FolderOpen, RotateCcw, Search, Trash2 } from "lucide-react";
import { Empty, ErrorNote, Led, Loading, NA, Panel, Readout, Seg, statusTone } from "../components/industrial/Panel";
import { TimeSeriesChart, type Series } from "../components/charts/TimeSeriesChart";
import { api, errorText, pickSavePath } from "../lib/backend";
import { bytes, dateTime, duration, OP_LABEL, pct, POLICY_LABEL, rate } from "../lib/format";
import type { JobDetail, JobRecord, MetricAggregate, SeriesPoint } from "../lib/types";
import { useJobRecords } from "./overview/Tables";

const elapsed = (r: JobRecord) => (r.started_at && r.ended_at ? r.ended_at - r.started_at : null);
const throughput = (r: JobRecord) => {
  const e = elapsed(r);
  return e && e > 0 ? r.bytes_done / (e / 1000) : null;
};

type SortKey = "created" | "elapsed" | "throughput" | "files";

export default function Experiments() {
  const { rows, error, reload } = useJobRecords(2000);
  const [q, setQ] = useState("");
  const [op, setOp] = useState("all");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState<SortKey>("created");
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [focus, setFocus] = useState<number | null>(null);
  const [mode, setMode] = useState<"inspect" | "compare">("inspect");
  const [msg, setMsg] = useState<string | null>(null);

  const list = useMemo(() => {
    if (!rows) return [];
    const n = q.trim().toLowerCase();
    let r = rows.filter(
      (x) =>
        (op === "all" || x.op === op) &&
        (status === "all" || x.status === status) &&
        (!n || x.name.toLowerCase().includes(n) || x.folder.toLowerCase().includes(n) || String(x.id) === n),
    );
    const key: Record<SortKey, (x: JobRecord) => number> = {
      created: (x) => x.created_at,
      elapsed: (x) => elapsed(x) ?? -1,
      throughput: (x) => throughput(x) ?? -1,
      files: (x) => x.files_done,
    };
    r = [...r].sort((a, b) => key[sort](b) - key[sort](a));
    return r;
  }, [rows, q, op, status, sort]);

  useEffect(() => {
    if (focus == null && list.length) setFocus(list[0].id);
  }, [list, focus]);

  const toggle = (id: number) =>
    setChecked((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else if (n.size < 4) n.add(id);
      return n;
    });

  const exportCsv = async () => {
    const ids = checked.size ? [...checked] : list.map((r) => r.id);
    try {
      const path = await pickSavePath(`flowdesk-experiments-${new Date().toISOString().slice(0, 10)}.csv`);
      if (!path) return;
      const n = await api.exportJobsCsv(ids, path);
      setMsg(`Exported ${n} record(s) to ${path}`);
    } catch (e) {
      setMsg(errorText(e));
    }
  };

  return (
    <div className="p-3 grid gap-3 grid-cols-[minmax(500px,1fr)_minmax(0,1.25fr)] min-w-[1000px] items-start">
      <Panel
        title="Experiment records"
        code="X"
        status={{ tone: rows ? "ok" : "off", label: rows ? `${list.length} of ${rows.length}` : "SQLite" }}
        bodyClassName="flex flex-col"
        actions={
          <button className="btn btn-sm" onClick={() => void exportCsv()} disabled={!list.length} title={checked.size ? "Export checked records" : "Export all filtered records"}>
            <Download size={12} /> CSV{checked.size ? ` (${checked.size})` : ""}
          </button>
        }
      >
        <div className="p-2 flex flex-wrap gap-2 border-b border-steel-dim">
          <div className="relative flex-1 min-w-[140px]">
            <Search size={12} className="absolute left-2 top-2.5 text-ink-3" />
            <input className="field pl-6 w-full font-sans" placeholder="Search name, folder, #id" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search experiments" />
          </div>
          <select className="field" value={op} onChange={(e) => setOp(e.target.value)} aria-label="Operation filter">
            <option value="all">All operations</option>
            {Object.entries(OP_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select className="field" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
            <option value="all">All statuses</option>
            {["completed", "cancelled", "failed", "interrupted", "running", "queued", "paused"].map((s) => <option key={s}>{s}</option>)}
          </select>
          <select className="field" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
            <option value="created">Newest</option>
            <option value="elapsed">Longest</option>
            <option value="throughput">Fastest</option>
            <option value="files">Most files</option>
          </select>
        </div>
        {msg && <div className="px-3 py-1.5 text-[11.5px] text-ink-2 border-b border-steel-dim selectable">{msg}</div>}
        {error && <div className="p-3"><ErrorNote>{error}</ErrorNote></div>}
        {rows && list.length === 0 && <Empty title="No matching experiments">Run a task from the Workspace. Every run is recorded here with the telemetry captured during it.</Empty>}
        <div className="overflow-auto h-[calc(100vh-235px)] min-h-[360px]">
          <table className="tbl">
            <thead>
              <tr>
                <th className="w-6" title="Select up to 4 to compare" />
                <th>Experiment</th>
                <th>Policy</th>
                <th>Status</th>
                <th className="text-right">Elapsed</th>
                <th className="text-right">Rate</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} onClick={() => (setFocus(r.id), setMode("inspect"))} className={`cursor-pointer ${focus === r.id ? "bg-amber/[0.07]" : ""}`}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={checked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Compare #${r.id}`} className="accent-[rgb(var(--amber))]" />
                  </td>
                  <td className="max-w-[190px]">
                    <div className="truncate" title={r.name}><span className="readout text-ink-3 mr-1">#{r.id}</span>{r.name}</div>
                    <div className="text-[10.5px] text-ink-3 truncate">{OP_LABEL[r.op]} · {dateTime(r.created_at)}</div>
                  </td>
                  <td className="text-ink-2">{POLICY_LABEL[r.policy]}</td>
                  <td><span className="flex items-center gap-1.5"><Led tone={statusTone(r.status)} />{r.status}</span></td>
                  <td className="readout text-right">{duration(elapsed(r))}</td>
                  <td className="readout text-right">{r.op === "index" || r.op === "metadata" ? "—" : rate(throughput(r))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="p-2 border-t border-steel-dim flex items-center gap-2">
          <Seg
            label="View"
            value={mode}
            onChange={setMode}
            options={[
              { value: "inspect", label: "Inspect" },
              { value: "compare", label: `Compare (${checked.size})`, disabled: checked.size < 2 },
            ]}
          />
          <span className="text-[10.5px] text-ink-3">Tick 2–4 records to compare side by side.</span>
        </div>
      </Panel>

      {mode === "compare" && checked.size >= 2 && rows ? (
        <Compare records={rows.filter((r) => checked.has(r.id))} />
      ) : focus != null ? (
        <Inspect id={focus} onDeleted={() => (setFocus(null), reload())} />
      ) : (
        <Panel title="Inspection" code="X2"><Empty title="Select an experiment" /></Panel>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- inspection

const SERIES_DEF: { metric: string; label: string; color: string; fmt: (v: number) => string; yMax?: number; group: string }[] = [
  { metric: "cpu", label: "CPU", color: "--series-cpu", fmt: (v) => `${v.toFixed(0)}%`, yMax: 100, group: "CPU %" },
  { metric: "app_cpu", label: "FlowDesk CPU", color: "--series-mem", fmt: (v) => `${v.toFixed(0)}%`, yMax: 100, group: "CPU %" },
  { metric: "disk_read", label: "Read", color: "--series-read", fmt: (v) => rate(v).replace(" ", ""), group: "Disk" },
  { metric: "disk_write", label: "Write", color: "--series-write", fmt: (v) => rate(v).replace(" ", ""), group: "Disk" },
  { metric: "gpu_temp", label: "GPU temp", color: "--series-gpu", fmt: (v) => `${v.toFixed(0)}°`, group: "Temperature" },
  { metric: "cpu_temp", label: "CPU temp", color: "--series-cpu", fmt: (v) => `${v.toFixed(0)}°`, group: "Temperature" },
];

function fmtAgg(a: MetricAggregate, v: number | null) {
  if (v == null) return "—";
  if (a.unit === "B/s") return rate(v);
  if (a.unit === "B") return bytes(v);
  if (a.unit === "%") return pct(v);
  return `${v.toFixed(1)} ${a.unit}`;
}

function Inspect({ id, onDeleted }: { id: number; onDeleted: () => void }) {
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [series, setSeries] = useState<SeriesPoint[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setSeries(null);
    setErr(null);
    setNote(null);
    Promise.all([api.jobDetail(id), api.jobSeries(id)])
      .then(([d, s]) => live && (setDetail(d), setSeries(s)))
      .catch((e) => live && setErr(errorText(e)));
    return () => {
      live = false;
    };
  }, [id]);

  const groups = useMemo(() => {
    if (!series) return [];
    const ts = [...new Set(series.map((p) => p.ts))].sort((a, b) => a - b);
    const idx = new Map(ts.map((t, i) => [t, i]));
    const byMetric = new Map<string, (number | null)[]>();
    for (const p of series) {
      if (!byMetric.has(p.metric)) byMetric.set(p.metric, new Array(ts.length).fill(null));
      byMetric.get(p.metric)![idx.get(p.ts)!] = p.value;
    }
    const out: { group: string; series: Series[]; fmt: (v: number) => string; yMax?: number }[] = [];
    for (const d of SERIES_DEF) {
      const values = byMetric.get(d.metric);
      if (!values || values.every((v) => v == null)) continue;
      let g = out.find((x) => x.group === d.group);
      if (!g) out.push((g = { group: d.group, series: [], fmt: d.fmt, yMax: d.yMax }));
      g.series.push({ id: d.metric, label: d.label, color: d.color, values });
    }
    return out.map((g) => ({ ...g, ts }));
  }, [series]);

  if (err) return <Panel title="Inspection" code="X2"><ErrorNote>{err}</ErrorNote></Panel>;
  if (!detail) return <Panel title="Inspection" code="X2"><Loading /></Panel>;
  const r = detail.record;
  const summary = r.summary ? (JSON.parse(r.summary) as Record<string, unknown>) : null;

  const rerun = async () => {
    try {
      const cur = await api.engineState();
      await api.engineSetConfig({
        policy: r.policy,
        workers: r.workers,
        quantumMs: r.quantum_ms,
        maxWorkersPerTask: r.max_workers_per_task,
      });
      const nid = await api.submitJob({ name: `${r.name} (repeat of #${r.id})`, op: r.op, folder: r.folder, dest: r.dest, priority: r.priority });
      setNote(`Started task #${nid} with the same folder, operation and engine configuration${cur.config.policy !== r.policy ? ` (engine policy changed to ${POLICY_LABEL[r.policy]})` : ""}.`);
    } catch (e) {
      setNote(errorText(e));
    }
  };

  const remove = async () => {
    if (!confirm(`Delete experiment #${r.id} and its telemetry? Report files on disk are kept.`)) return;
    try {
      await api.deleteJob(r.id);
      onDeleted();
    } catch (e) {
      setNote(errorText(e));
    }
  };

  const live = r.status === "running" || r.status === "queued" || r.status === "paused";

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <Panel
        title={`#${r.id} · ${r.name}`}
        code="X2"
        status={{ tone: statusTone(r.status), label: r.status }}
        actions={
          <>
            {r.report_path && <button className="btn btn-sm" onClick={() => void api.openPath(r.report_path!, true).catch((e) => setNote(errorText(e)))}><FolderOpen size={12} /> Report</button>}
            <button className="btn btn-sm" onClick={() => void rerun()} disabled={live} title="Run again with identical configuration"><RotateCcw size={12} /> Repeat</button>
            <button className="btn btn-sm btn-danger" onClick={() => void remove()} disabled={live} aria-label="Delete"><Trash2 size={12} /></button>
          </>
        }
      >
        {note && <div className="mb-2 text-[11.5px] text-ink-2 selectable">{note}</div>}
        <div className="grid grid-cols-4 gap-3">
          <Readout label="Operation" value={<span className="font-sans text-[13px]">{OP_LABEL[r.op]}</span>} />
          <Readout label="Policy" value={<span className="font-sans text-[13px]">{POLICY_LABEL[r.policy]}</span>} sub={r.policy === "round_robin" ? `quantum ${r.quantum_ms} ms` : undefined} />
          <Readout label="Workers" value={r.workers} sub={`≤ ${r.max_workers_per_task} per task · P${r.priority}`} />
          <Readout label="Elapsed" value={duration(elapsed(r))} />
          <Readout label="Files" value={`${r.files_done} / ${r.files_total}`} sub={`${r.files_failed} failed · ${r.files_skipped} skipped`} />
          <Readout label="Bytes processed" value={bytes(r.bytes_done)} sub={`of ${bytes(r.bytes_total)}`} />
          <Readout label="Throughput" value={rate(throughput(r))} />
          <Readout label="Response time" value={duration(r.response_ms)} sub={`${r.preemptions} preemptions`} />
          <Readout label="Started" value={<span className="text-[12px]">{dateTime(r.started_at)}</span>} />
          <Readout label="Ended" value={<span className="text-[12px]">{dateTime(r.ended_at)}</span>} />
          <Readout label="Folder" value={<span className="text-[11.5px]" title={r.folder}>{r.folder}</span>} className="col-span-2" />
        </div>
        {r.error && <div className="mt-2"><ErrorNote>{r.error}</ErrorNote></div>}
      </Panel>

      <Panel title="Measured telemetry during run" code="X3" status={{ tone: detail.aggregates.length ? "ok" : "off", label: `${detail.aggregates[0]?.samples ?? 0} samples` }}>
        {detail.aggregates.length === 0 ? (
          <Empty title="No telemetry recorded">Samples are recorded once per telemetry interval while a task is running; very short tasks may finish between samples.</Empty>
        ) : (
          <>
            <table className="tbl mb-3">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th className="text-right">Avg</th>
                  <th className="text-right">Min</th>
                  <th className="text-right">Max</th>
                  <th className="text-right">Samples</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {detail.aggregates.map((a) => (
                  <tr key={a.metric}>
                    <td className="readout">{a.metric}</td>
                    {a.samples === 0 ? (
                      <td colSpan={3} className="text-right"><NA compact reason="Sensor unavailable for the whole run" /></td>
                    ) : (
                      <>
                        <td className="readout text-right">{fmtAgg(a, a.avg)}</td>
                        <td className="readout text-right text-ink-2">{fmtAgg(a, a.min)}</td>
                        <td className="readout text-right text-ink-2">{fmtAgg(a, a.max)}</td>
                      </>
                    )}
                    <td className="readout text-right text-ink-3">{a.samples}{a.unavailable_samples ? ` (+${a.unavailable_samples} N/A)` : ""}</td>
                    <td className="text-[11px] text-ink-3 truncate max-w-[180px]" title={a.source}>{a.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="grid grid-cols-2 gap-3">
              {groups.map((g) => (
                <div key={g.group}>
                  <div className="text-[12px] text-ink-2 mb-1">{g.group}</div>
                  <TimeSeriesChart ts={g.ts} series={g.series} format={g.fmt} yMax={g.yMax} height={110} />
                </div>
              ))}
            </div>
            <p className="mt-2 text-[10.5px] text-ink-3 leading-snug">
              System-wide measurements taken while this task ran. Other programs also contribute, so they show what was observed, not what the task or its policy caused.
            </p>
          </>
        )}
      </Panel>

      <div className="grid grid-cols-2 gap-3">
        <Panel title="Result summary" code="X4">
          {summary ? <SummaryView op={r.op} s={summary} /> : <Empty title="No result summary" />}
        </Panel>
        <Panel title="Event log" code="X5" bodyClassName="max-h-[220px] overflow-auto">
          <ul className="text-[11.5px]">
            {detail.events.map((e, i) => (
              <li key={i} className="flex gap-2 px-3 py-1 border-b border-steel-dim/50">
                <span className="readout text-ink-3 shrink-0">{dateTime(e.ts).split(" ").pop()}</span>
                <span className={e.level === "error" ? "text-alert" : e.level === "warn" ? "text-amber" : "text-ink-2"}>{e.message}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function SummaryView({ op, s }: { op: string; s: Record<string, unknown> }) {
  const n = (k: string) => (s[k] as number) ?? 0;
  if (op === "duplicates")
    return (
      <div className="grid grid-cols-2 gap-3">
        <Readout label="Duplicate groups" value={n("groups")} />
        <Readout label="Files in groups" value={n("duplicateFiles")} />
        <Readout label="Reclaimable" value={bytes(n("reclaimableBytes"))} tone="amber" />
        <Readout label="Candidates hashed" value={n("hashed")} />
      </div>
    );
  if (op === "metadata" || op === "index") {
    const ext = (s.extensions as { ext: string; files: number; bytes: number }[]) ?? [];
    const sizes = (s.sizeBuckets as { label: string; files: number }[]) ?? [];
    const maxS = Math.max(1, ...sizes.map((x) => x.files));
    return (
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-3 gap-3">
          <Readout label="Files" value={n("files")} />
          <Readout label="Total" value={bytes(n("bytes"))} />
          <Readout label="Read-only" value={n("readonly")} />
        </div>
        <div className="label">Size distribution</div>
        {sizes.map((b) => (
          <div key={b.label} className="flex items-center gap-2 text-[11px]">
            <span className="w-20 text-ink-2">{b.label}</span>
            <div className="flex-1 recess h-1.5"><div className="h-full bg-steel-hi" style={{ width: `${(b.files / maxS) * 100}%` }} /></div>
            <span className="readout w-12 text-right">{b.files}</span>
          </div>
        ))}
        <div className="label mt-1">Top types</div>
        <div className="flex flex-wrap gap-1">
          {ext.slice(0, 8).map((e) => <span key={e.ext} className="readout text-[10.5px] px-1.5 recess text-ink-2">.{e.ext} {bytes(e.bytes)}</span>)}
        </div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3">
      <Readout label="Files" value={n("files")} />
      <Readout label="Bytes" value={bytes(n("bytes"))} />
    </div>
  );
}

// ---------------------------------------------------------------- comparison

function Compare({ records }: { records: JobRecord[] }) {
  const [aggs, setAggs] = useState<Map<number, MetricAggregate[]>>(new Map());
  useEffect(() => {
    let live = true;
    Promise.all(records.map((r) => api.jobDetail(r.id).then((d) => [r.id, d.aggregates] as const)))
      .then((list) => live && setAggs(new Map(list)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [records]);

  const sameWorkload = records.every((r) => r.op === records[0].op && r.folder === records[0].folder && r.bytes_total === records[0].bytes_total);
  const avg = (id: number, m: string) => aggs.get(id)?.find((a) => a.metric === m)?.avg ?? null;

  const rows: { label: string; get: (r: JobRecord) => number | null; fmt: (v: number) => string; better: "low" | "high" | null }[] = [
    { label: "Elapsed", get: elapsed, fmt: duration, better: "low" },
    { label: "Throughput", get: throughput, fmt: rate, better: "high" },
    { label: "Response time", get: (r) => r.response_ms, fmt: duration, better: "low" },
    { label: "Preemptions", get: (r) => r.preemptions, fmt: (v) => String(v), better: null },
    { label: "Files done", get: (r) => r.files_done, fmt: (v) => String(v), better: null },
    { label: "Avg CPU (system)", get: (r) => avg(r.id, "cpu"), fmt: pct, better: null },
    { label: "Avg FlowDesk CPU", get: (r) => avg(r.id, "app_cpu"), fmt: pct, better: null },
    { label: "Avg memory used", get: (r) => avg(r.id, "mem_used"), fmt: bytes, better: null },
    { label: "Avg disk read", get: (r) => avg(r.id, "disk_read"), fmt: rate, better: null },
    { label: "Avg GPU temp", get: (r) => avg(r.id, "gpu_temp"), fmt: (v) => `${v.toFixed(1)} °C`, better: null },
  ];

  return (
    <Panel title="Side-by-side comparison" code="X6" status={{ tone: sameWorkload ? "ok" : "amber", label: sameWorkload ? "compatible workloads" : "different workloads" }}>
      {!sameWorkload && (
        <div className="mb-3 text-[11.5px] text-amber border border-amber/30 bg-amber/5 rounded-sm px-2.5 py-2">
          These runs differ in operation, folder or total size, so timing differences are not attributable to the scheduling configuration.
        </div>
      )}
      <table className="tbl">
        <thead>
          <tr>
            <th>Measure</th>
            {records.map((r) => (
              <th key={r.id} className="text-right normal-case">
                <div className="readout">#{r.id}</div>
                <div className="font-sans text-ink-2 tracking-normal">{POLICY_LABEL[r.policy]}{r.policy === "round_robin" ? ` q${r.quantum_ms}` : ""} · {r.workers}w</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const vals = records.map(row.get);
            const finite = vals.filter((v): v is number => v != null);
            const best = row.better && finite.length > 1 ? (row.better === "low" ? Math.min(...finite) : Math.max(...finite)) : null;
            const max = Math.max(1e-9, ...finite);
            return (
              <tr key={row.label}>
                <td className="text-ink-2">{row.label}</td>
                {vals.map((v, i) => (
                  <td key={records[i].id} className="text-right">
                    <div className={`readout ${best != null && v === best ? "text-ok" : ""}`}>{v == null ? "—" : row.fmt(v)}</div>
                    {v != null && (row.label === "Elapsed" || row.label === "Throughput") && (
                      <div className="recess h-1 mt-0.5 ml-auto w-full">
                        <div className="h-full ml-auto" style={{ width: `${(v / max) * 100}%`, background: "rgb(var(--series-cpu))" }} />
                      </div>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-3 text-[10.5px] text-ink-3 leading-snug">
        For a fair comparison, repeat runs on the same folder. The first run may be slower because files are not yet in the OS file cache. Green marks the best
        timing value. System-wide CPU, memory and temperature are observations only: other processes and ambient conditions affect them, so they do not show that a policy caused a change.
      </p>
    </Panel>
  );
}
