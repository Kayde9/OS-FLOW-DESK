// Analysis derived from the events in view (the current filter / time range).
// Each panel is tagged OBSERVED (counted directly from events), DERIVED
// (computed statistics) or HYPOTHESIS (rule-based interpretation, never fact).

import { useMemo, useState } from "react";
import { Empty, Panel } from "../../components/industrial/Panel";
import { bytes } from "../../lib/format";
import {
  clockUs,
  countBy,
  DURATION_BINS,
  durationHistogram,
  durUs,
  histogram,
  operationStats,
} from "../../lib/trace/analysis";
import type { TraceEvent, TraceStats } from "../../lib/trace/types";
import { catOf, CatGlyph } from "./categories";
import { interval, type TelSeries } from "./telemetry";

function Tag({ kind }: { kind: "observed" | "derived" | "hypothesis" }) {
  const cls = kind === "observed" ? "border-ok/40 text-ok" : kind === "derived" ? "border-info/40 text-info" : "border-violet/50 text-violet";
  return <span className={`inline-flex items-center px-1.5 h-5 rounded-sm border text-micro uppercase font-semibold ${cls}`}>{kind}</span>;
}

function BarList({ rows, total, glyph, label = (k) => k }: { rows: [string, number][]; total: number; glyph?: (k: string) => React.ReactNode; label?: (k: string) => string }) {
  if (!rows.length) return <div className="text-[11.5px] text-ink-3">No events.</div>;
  const max = Math.max(...rows.map((r) => r[1]));
  return (
    <ul className="flex flex-col gap-1">
      {rows.slice(0, 8).map(([k, n]) => (
        <li key={k} className="grid grid-cols-[minmax(0,150px)_1fr_86px] items-center gap-2 text-[11.5px] h-5" title={`${label(k)}: ${n.toLocaleString()} events`}>
          <span className="flex items-center gap-1.5 min-w-0 text-ink-2">
            {glyph?.(k)}
            <span className="truncate">{label(k)}</span>
          </span>
          <span className="h-2 recess">
            <span className="block h-full rounded-r-[2px] bg-steel-hi" style={{ width: `${(n / max) * 100}%` }} />
          </span>
          <span className="readout text-right text-ink">
            {n.toLocaleString()} <span className="text-ink-3">{((n / Math.max(1, total)) * 100).toFixed(0)}%</span>
          </span>
        </li>
      ))}
      {rows.length > 8 && <li className="text-[11px] text-ink-3">+ {rows.length - 8} more</li>}
    </ul>
  );
}

function Histo({ values, labels, height = 90, unit, highlight }: { values: number[]; labels?: string[]; height?: number; unit: string; highlight?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...values);
  const w = 100 / values.length;
  return (
    <div className="relative">
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }} role="img" aria-label={`Histogram, ${values.length} bins`}>
        {values.map((v, i) => {
          const h = (v / max) * (height - 4);
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={i * w} y={0} width={w} height={height} fill="transparent" />
              {v > 0 && (
                <rect x={i * w + Math.min(0.3, w * 0.1)} y={height - h} width={Math.max(0.2, w - Math.min(0.6, w * 0.2))} height={h} rx={0.6} fill={hover === i ? "rgb(var(--amber))" : highlight ?? "rgb(var(--series-cpu))"} />
              )}
            </g>
          );
        })}
        <line x1="0" x2="100" y1={height - 0.5} y2={height - 0.5} stroke="rgb(var(--steel))" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
      </svg>
      {hover != null && (
        <div className="absolute -top-1 right-0 recess bg-panel-sunk/95 px-2 py-1 text-[11px] readout pointer-events-none">
          {labels?.[hover] ?? `bin ${hover + 1}`}: {values[hover].toLocaleString()} {unit}
        </div>
      )}
      {labels && labels.length <= 8 && (
        <div className="grid text-[10.5px] text-ink-3 mt-1" style={{ gridTemplateColumns: `repeat(${labels.length}, minmax(0,1fr))` }}>
          {labels.map((l) => <span key={l} className="text-center truncate">{l}</span>)}
        </div>
      )}
    </div>
  );
}

export function AnalysisTab({ events, idx, stats, tel, mode }: { events: TraceEvent[]; idx: number[]; stats: TraceStats | null; tel: TelSeries[]; mode: string | null }) {
  const a = useMemo(() => {
    const ops = operationStats(events, idx);
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const i of idx) {
      t0 = Math.min(t0, events[i].tsUs);
      t1 = Math.max(t1, events[i].tsUs);
    }
    const file = idx.filter((i) => events[i].category === "file");
    const reads = file.filter((i) => events[i].operation === "Read");
    const writes = file.filter((i) => events[i].operation === "Write");
    const paths = new Map<string, { n: number; r: number; w: number }>();
    for (const i of file) {
      const e = events[i];
      if (!e.filePath) continue;
      const p = paths.get(e.filePath) ?? { n: 0, r: 0, w: 0 };
      p.n++;
      if (e.operation === "Read") p.r += e.size ?? 0;
      if (e.operation === "Write") p.w += e.size ?? 0;
      paths.set(e.filePath, p);
    }
    const lifecycle = idx.filter((i) => ["process", "thread", "image"].includes(events[i].category));
    const longest = idx.filter((i) => events[i].durationUs != null).sort((x, y) => events[y].durationUs! - events[x].durationUs!).slice(0, 10);
    return {
      ops,
      t0,
      t1,
      freq: idx.length ? histogram(events, idx, t0, t1, 60) : [],
      byProvider: countBy(events, idx, (e) => e.provider),
      byCategory: countBy(events, idx, (e) => e.category),
      byProcess: countBy(events, idx, (e) => `${e.processName ?? "PID"} (${e.pid ?? "?"})`),
      byThread: countBy(events, idx, (e) => (e.tid != null ? `${e.threadName ?? "TID"} · ${e.tid}` : undefined)),
      readN: reads.length,
      writeN: writes.length,
      readB: reads.reduce((s, i) => s + (events[i].size ?? 0), 0),
      writeB: writes.reduce((s, i) => s + (events[i].size ?? 0), 0),
      readD: durationHistogram(events, reads),
      writeD: durationHistogram(events, writes),
      paths: [...paths.entries()].sort((x, y) => y[1].r + y[1].w - (x[1].r + x[1].w) || y[1].n - x[1].n).slice(0, 10),
      unknownPath: file.filter((i) => !events[i].filePath).length,
      results: countBy(events, idx, (e) => (e.status === "error" || e.status === "warning" ? `${e.operation ?? e.eventName} → ${e.resultCode}` : undefined)),
      lifecycle,
      longest,
      eof: reads.filter((i) => events[i].resultCode?.includes("END_OF_FILE")).length,
      unmatched: ops.reduce((s, o) => s + o.unmatched, 0),
    };
  }, [events, idx]);

  if (!idx.length) return <Empty title="No events to analyze">Start or open a session, or widen the filter.</Empty>;

  const spanUs = a.t1 - a.t0;
  const lost = (stats?.etwEventsLost ?? 0) + (stats?.etwRtBuffersLost ?? 0) + (stats?.queueDropped ?? 0);
  const telWindow = tel
    .map((s) => {
      const pts = s.points.filter((p) => p.ts * 1000 >= a.t0 - 1e6 && p.ts * 1000 <= a.t1 + 1e6);
      const vals = pts.map((p) => p.value).filter((v): v is number => v != null);
      return { s, n: pts.length, missing: pts.length - vals.length, avg: vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null, max: vals.length ? Math.max(...vals) : null };
    })
    .filter((r) => r.n > 0 || !r.s.available);
  const fmt = (s: TelSeries, v: number | null) => (v == null ? "N/A" : s.unit === "B/s" ? `${bytes(v)}/s` : s.unit === "B" ? bytes(v) : `${v.toFixed(1)} ${s.unit}`);

  return (
    <div className="grid grid-cols-12 gap-3">
      <div className="col-span-12 text-[11.5px] text-ink-3">
        Analyzing {idx.length.toLocaleString()} events in view ({durUs(spanUs)} from {clockUs(a.t0)}). Filters and the timeline range selection apply here.
      </div>

      <Panel className="col-span-4" title="Event distribution" code="A1" actions={<Tag kind="observed" />}>
        <div className="flex flex-col gap-3">
          <div><div className="label mb-1">By category</div><BarList rows={a.byCategory} total={idx.length} label={(k) => catOf(k).label} glyph={(k) => <CatGlyph category={k} />} /></div>
          <div><div className="label mb-1">By provider</div><BarList rows={a.byProvider} total={idx.length} /></div>
          <div><div className="label mb-1">By process</div><BarList rows={a.byProcess} total={idx.length} /></div>
        </div>
      </Panel>

      <Panel className="col-span-8" title="Event frequency over time" code="A2" actions={<Tag kind="derived" />}>
        <Histo values={a.freq} unit="events" labels={a.freq.map((_, i) => `+${durUs(Math.round((spanUs / a.freq.length) * i))}`)} />
        <div className="flex justify-between text-[10.5px] text-ink-3 readout mt-1">
          <span>{clockUs(a.t0)}</span>
          <span>60 bins · {durUs(Math.round(spanUs / 60))} each</span>
          <span>{clockUs(a.t1)}</span>
        </div>
        <div className="mt-3 label mb-1">Operations</div>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Category</th><th>Operation</th><th className="text-right">Count</th><th className="text-right">Bytes</th>
                <th className="text-right" title="Requests with a matched OperationEnd">Matched</th>
                <th className="text-right" title="Requests that expected a completion but none was observed">Unmatched</th>
                <th className="text-right">Warn/err</th><th className="text-right">p50</th><th className="text-right">p95</th><th className="text-right">Max</th>
              </tr>
            </thead>
            <tbody>
              {a.ops.slice(0, 12).map((o) => (
                <tr key={o.key}>
                  <td><span className="flex items-center gap-1.5"><CatGlyph category={o.category} />{catOf(o.category).label}</span></td>
                  <td>{o.operation}</td>
                  <td className="readout text-right">{o.count.toLocaleString()}</td>
                  <td className="readout text-right">{o.bytes ? bytes(o.bytes) : "—"}</td>
                  <td className="readout text-right">{o.matched || "—"}</td>
                  <td className="readout text-right text-ink-3">{o.unmatched || "—"}</td>
                  <td className={`readout text-right ${o.problems ? "text-alert" : ""}`}>{o.problems || "—"}</td>
                  <td className="readout text-right">{durUs(o.p50)}</td>
                  <td className="readout text-right">{durUs(o.p95)}</td>
                  <td className="readout text-right">{durUs(o.max)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[10.5px] text-ink-3 mt-1.5">Durations exist only for requests matched to an OperationEnd by IRP; percentiles are nearest-rank over matched requests.</p>
      </Panel>

      <Panel className="col-span-6" title="File I/O" code="A3" actions={<Tag kind="observed" />}>
        <div className="grid grid-cols-4 gap-3 mb-3">
          <div><div className="label">Reads</div><div className="readout text-[15px]">{a.readN.toLocaleString()}</div><div className="text-[11px] text-ink-3 readout">{bytes(a.readB)} requested</div></div>
          <div><div className="label">Writes</div><div className="readout text-[15px]">{a.writeN.toLocaleString()}</div><div className="text-[11px] text-ink-3 readout">{bytes(a.writeB)} requested</div></div>
          <div><div className="label">Unknown path</div><div className="readout text-[15px]">{a.unknownPath.toLocaleString()}</div><div className="text-[11px] text-ink-3">opened pre-capture</div></div>
          <div><div className="label">Warn/err results</div><div className={`readout text-[15px] ${a.results.length ? "text-alert" : ""}`}>{a.results.reduce((s, r) => s + r[1], 0)}</div><div className="text-[11px] text-ink-3">NTSTATUS</div></div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div><div className="label mb-1">Read duration distribution <Tag kind="derived" /></div><Histo values={a.readD} labels={DURATION_BINS} unit="reads" height={60} highlight="rgb(var(--cat-file))" /></div>
          <div><div className="label mb-1">Write duration distribution <Tag kind="derived" /></div><Histo values={a.writeD} labels={DURATION_BINS} unit="writes" height={60} highlight="rgb(var(--cat-file))" /></div>
        </div>
        <div className="label mt-3 mb-1">Files by bytes requested</div>
        {a.paths.length ? (
          <table className="tbl">
            <thead><tr><th>Path</th><th className="text-right">Events</th><th className="text-right">Read</th><th className="text-right">Write</th></tr></thead>
            <tbody>
              {a.paths.map(([p, v]) => (
                <tr key={p}><td className="readout max-w-[300px] truncate" title={p}>{p}</td><td className="readout text-right">{v.n}</td><td className="readout text-right">{v.r ? bytes(v.r) : "—"}</td><td className="readout text-right">{v.w ? bytes(v.w) : "—"}</td></tr>
              ))}
            </tbody>
          </table>
        ) : <div className="text-[11.5px] text-ink-3">No file events with known paths.</div>}
        {a.results.length > 0 && (
          <>
            <div className="label mt-3 mb-1">Non-success results</div>
            <BarList rows={a.results} total={idx.length} />
          </>
        )}
      </Panel>

      <Panel className="col-span-6" title="Process & thread activity" code="A4" actions={<Tag kind="observed" />}>
        <div className="label mb-1">Events per thread</div>
        <BarList rows={a.byThread} total={idx.length} />
        <div className="label mt-3 mb-1">Lifecycle events ({a.lifecycle.length})</div>
        {a.lifecycle.length ? (
          <ul className="max-h-[160px] overflow-y-auto">
            {a.lifecycle.slice(0, 200).map((i) => {
              const e = events[i];
              return (
                <li key={e.seq} className="grid grid-cols-[110px_120px_1fr] gap-2 text-[11.5px] h-5">
                  <span className="readout text-ink-3">{clockUs(e.tsUs).slice(0, 12)}</span>
                  <span className="flex items-center gap-1.5"><CatGlyph category={e.category} />{e.eventName}</span>
                  <span className="readout truncate text-ink-2" title={e.filePath}>PID {e.pid} · TID {e.tid ?? "—"} {e.filePath ? `· ${e.filePath}` : ""}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="text-[11.5px] text-ink-3">None in view{mode === "etw" ? " (enable Kernel-Process to capture them)" : ""}.</div>
        )}
        <div className="label mt-3 mb-1">Longest observed operations <Tag kind="derived" /></div>
        {a.longest.length ? (
          <ul>
            {a.longest.map((i) => {
              const e = events[i];
              return (
                <li key={e.seq} className="grid grid-cols-[70px_80px_1fr] gap-2 text-[11.5px] h-5">
                  <span className="readout text-right text-ink">{durUs(e.durationUs)}</span>
                  <span className="truncate text-ink-2">{e.operation}</span>
                  <span className="readout truncate text-ink-3" title={e.filePath}>{e.filePath ?? "path unknown"}</span>
                </li>
              );
            })}
          </ul>
        ) : <div className="text-[11.5px] text-ink-3">No matched completions in view.</div>}
        <p className="text-[10.5px] text-ink-3 mt-1">A ranking within this session only — no slowness threshold or baseline is applied.</p>
      </Panel>

      <Panel className="col-span-6" title="Telemetry during this window" code="A5" actions={<Tag kind="observed" />}>
        <table className="tbl">
          <thead><tr><th>Metric</th><th className="text-right">Avg</th><th className="text-right">Max</th><th className="text-right">Samples</th><th>Source</th></tr></thead>
          <tbody>
            {telWindow.map(({ s, n, missing, avg, max }) => (
              <tr key={s.metric} title={s.note ?? undefined}>
                <td>{s.label}</td>
                <td className="readout text-right">{fmt(s, avg)}</td>
                <td className="readout text-right">{fmt(s, max)}</td>
                <td className="readout text-right">{n}{missing ? <span className="text-ink-3"> ({missing} N/A)</span> : ""}</td>
                <td className="text-ink-3 truncate max-w-[180px]" title={s.source}>{s.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[10.5px] text-ink-3 mt-1.5">
          System-wide measurements, interval ≈ {interval(tel[0]) ?? "—"} ms. Other programs contribute to them; timestamps overlapping with trace events do not show that those events caused a change.
        </p>
      </Panel>

      <Panel className="col-span-6" title="Data quality & interpretation" code="A6" actions={<Tag kind="hypothesis" />}>
        <ul className="flex flex-col gap-2 text-[12px] leading-snug">
          <li>
            <span className="label mr-1">Loss</span>
            {mode !== "etw" ? "No ETW session — loss counters do not apply." : lost ? <span className="text-alert">{lost} events/buffers lost or dropped: counts are lower bounds.</span> : "ETW reported no lost events or buffers, and no FlowDesk queue drops."}
          </li>
          {a.eof > 0 && (
            <li><span className="label mr-1">Hypothesis</span>{a.eof} reads returned STATUS_END_OF_FILE. This is consistent with sequential readers (such as hashing) reading until the end of each file, not with a fault.</li>
          )}
          {a.unmatched > 0 && (
            <li><span className="label mr-1">Hypothesis</span>{a.unmatched} requests have no observed completion. They may have completed after the capture stopped, their OperationEnd may have been lost, or completions were disabled.</li>
          )}
          {a.unknownPath > 0 && (
            <li><span className="label mr-1">Note</span>{a.unknownPath} file events have no path because their file object was opened before the capture started; FlowDesk does not guess the path.</li>
          )}
          <li><span className="label mr-1">Scope</span>File and disk events show I/O requests as seen by the I/O manager and disk driver. Cached reads may produce no disk I/O, and cache write-back by the System process is not attributed to the target.</li>
        </ul>
      </Panel>
    </div>
  );
}
