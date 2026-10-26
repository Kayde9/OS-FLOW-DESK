import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import { Empty, ErrorNote, Led, NA, Panel, Readout, Seg } from "../components/industrial/Panel";
import { Sparkline } from "../components/charts/Sparkline";
import { TimeSeriesChart } from "../components/charts/TimeSeriesChart";
import { api, errorText, isTauri } from "../lib/backend";
import { bytes, duration, pct, rate } from "../lib/format";
import { memPct, pick, RANGES, val, windowed } from "../lib/telemetry/series";
import { useAppStatus, useFeed, useSamples } from "../lib/telemetry/store";
import { usePrefs } from "../lib/prefs";
import type { Metric, ProcInfo, ProcessList, Sample } from "../lib/types";

type Tab = "processes" | "cpu" | "memory" | "disk" | "gpu";

function useProcesses(enabled: boolean, intervalMs = 2000) {
  const [list, setList] = useState<ProcessList | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || !isTauri) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const l = await api.listProcesses();
        if (!alive) return;
        setList(l);
        setError(null);
        // The first call only primes CPU deltas; follow up quickly.
        timer = setTimeout(tick, l.cpuReady ? intervalMs : 600);
      } catch (e) {
        if (alive) setError(errorText(e));
        timer = setTimeout(tick, intervalMs * 2);
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [enabled, intervalMs]);
  return { list, error };
}

function useWindow() {
  const all = useSamples();
  const { defaultRangeMs } = usePrefs();
  const [range, setRange] = useState<number>(defaultRangeMs);
  const samples = useMemo(() => windowed(all, range), [all, range]);
  const ts = useMemo(() => samples.map((s) => s.ts), [samples]);
  const selector = <Seg label="Time range" value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r.value, label: r.label }))} />;
  return { samples, ts, selector, last: samples[samples.length - 1] as Sample | undefined };
}

const pctFmt = (v: number) => `${v.toFixed(0)}%`;
const rateFmt = (v: number) => rate(v).replace(" ", "");

export default function LiveMonitor() {
  const [tab, setTab] = useState<Tab>("processes");
  const feed = useFeed();
  const procs = useProcesses(tab === "processes" || tab === "memory" || tab === "disk");
  return (
    <div className="p-3 flex flex-col gap-3 min-w-[1000px]">
      <div className="flex items-center gap-3">
        <Seg
          label="Monitor view"
          value={tab}
          onChange={setTab}
          options={[
            { value: "processes", label: "Processes" },
            { value: "cpu", label: "CPU" },
            { value: "memory", label: "Memory" },
            { value: "disk", label: "Disk" },
            { value: "gpu", label: "GPU & Sensors" },
          ]}
        />
        <span className="live-badge">Live telemetry</span>
        <span className="text-[11px] text-ink-3">Real measurements from this PC. Unsupported readings are marked N/A.</span>
      </div>
      {feed === "offline" && <ErrorNote>The telemetry service runs in the FlowDesk desktop backend, which is not connected.</ErrorNote>}
      {tab === "processes" && <Processes {...procs} />}
      {tab === "cpu" && <CpuView />}
      {tab === "memory" && <MemoryView list={procs.list} />}
      {tab === "disk" && <DiskView list={procs.list} />}
      {tab === "gpu" && <GpuView />}
    </div>
  );
}

// ------------------------------------------------------------------ processes

type SortKey = "name" | "pid" | "cpu" | "memory" | "io" | "status";

function Processes({ list, error }: { list: ProcessList | null; error: string | null }) {
  const status = useAppStatus();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "heavy" | "self">("all");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "cpu", desc: true });
  const [selected, setSelected] = useState<number | null>(null);

  const rows = useMemo(() => {
    if (!list) return [];
    const needle = q.trim().toLowerCase();
    let r = list.processes.filter((p) => !needle || p.name.toLowerCase().includes(needle) || String(p.pid).includes(needle));
    if (filter === "active") r = r.filter((p) => p.cpu >= 0.5);
    if (filter === "heavy") r = r.filter((p) => p.memory >= 200 * 1024 ** 2);
    if (filter === "self") r = r.filter((p) => p.pid === status?.info.selfPid);
    const k = sort.key;
    const get = (p: ProcInfo) => (k === "io" ? p.diskReadBps + p.diskWriteBps : (p as unknown as Record<string, string | number>)[k]);
    r = [...r].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      const c = typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number);
      return sort.desc ? -c : c;
    });
    return r;
  }, [list, q, filter, sort, status]);

  const sel = list?.processes.find((p) => p.pid === selected) ?? null;
  const th = (key: SortKey, label: string, right = false) => (
    <th className={right ? "text-right" : ""}>
      <button className={`inline-flex items-center gap-1 uppercase ${sort.key === key ? "text-amber" : ""}`} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }))}>
        {label}
        {sort.key === key && (sort.desc ? <ArrowDown size={10} /> : <ArrowUp size={10} />)}
      </button>
    </th>
  );

  return (
    <div className="grid gap-3 grid-cols-[minmax(0,1fr)_300px]">
      <Panel
        title="Processes"
        code="P"
        status={list ? { tone: list.cpuReady ? "ok" : "info", label: list.cpuReady ? `${list.processes.length} processes` : "priming CPU deltas" } : { tone: "off", label: "waiting" }}
        actions={
          <>
            <div className="relative">
              <Search size={12} className="absolute left-2 top-2 text-ink-3" />
              <input className="field h-7 pl-6 w-[180px] font-sans" placeholder="Name or PID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search processes" />
            </div>
            <Seg
              label="Filter"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "active", label: "CPU ≥0.5%" },
                { value: "heavy", label: "≥200 MB" },
                { value: "self", label: "FlowDesk" },
              ]}
            />
          </>
        }
        className="h-[calc(100vh-150px)] min-h-[400px]"
        bodyClassName="overflow-auto"
      >
        {error && <div className="p-3"><ErrorNote>{error}</ErrorNote></div>}
        <table className="tbl">
          <thead>
            <tr>
              {th("name", "Name")}
              {th("pid", "PID", true)}
              {th("cpu", "CPU", true)}
              {th("memory", "Memory", true)}
              {th("io", "I/O", true)}
              {th("status", "Status")}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.pid} onClick={() => setSelected(p.pid)} className={`cursor-pointer ${selected === p.pid ? "bg-amber/[0.07]" : ""}`}>
                <td className="max-w-[280px] truncate" title={p.exe ?? p.name}>
                  {p.name}
                  {p.pid === status?.info.selfPid && <span className="ml-2 text-micro uppercase text-amber">FlowDesk</span>}
                </td>
                <td className="readout text-right text-ink-2">{p.pid}</td>
                <td className="readout text-right">{list?.cpuReady ? pct(p.cpu) : "…"}</td>
                <td className="readout text-right">{bytes(p.memory)}</td>
                <td className="readout text-right text-ink-2">{list?.cpuReady ? rateFmt(p.diskReadBps + p.diskWriteBps) : "…"}</td>
                <td className="text-ink-3">{p.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list && rows.length === 0 && <Empty title="No processes match" />}
      </Panel>
      <Panel className="self-start" title="Process detail" code="P2" status={sel ? { tone: "ok", label: "live" } : { tone: "off", label: "none" }} actions={sel && <button className="btn btn-sm" onClick={() => setSelected(null)} aria-label="Close"><X size={12} /></button>}>
        {!sel ? (
          <Empty title="Select a process">Click a row to inspect it. Values refresh every 2 s.</Empty>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <div className="text-[14px] font-medium break-all">{sel.name}</div>
              <div className="readout text-[11px] text-ink-3 break-all selectable">{sel.exe ?? "executable path not accessible"}</div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Readout label="PID" value={sel.pid} />
              <Readout label="Parent" value={sel.parent ?? "—"} />
              <Readout label="CPU" value={pct(sel.cpu)} sub="of total capacity" />
              <Readout label="Status" value={sel.status} />
              <Readout label="Working set" value={bytes(sel.memory)} />
              <Readout label="Virtual" value={bytes(sel.virtualMemory)} />
              <Readout label="I/O read" value={rate(sel.diskReadBps)} />
              <Readout label="I/O write" value={rate(sel.diskWriteBps)} />
              <Readout label="Running for" value={duration(sel.runTime * 1000)} />
            </div>
            <p className="text-[10.5px] text-ink-3 leading-snug">I/O counts all of the process's I/O as Windows reports it (file, network and device), not just disk.</p>
          </div>
        )}
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ CPU

function CpuView() {
  const { samples, ts, selector, last } = useWindow();
  const status = useAppStatus();
  const recent = samples.slice(-60);
  const cores = last?.cores ?? [];
  return (
    <div className="grid gap-3 grid-cols-[minmax(0,1fr)_340px]">
      <Panel title="CPU utilisation" code="C" status={{ tone: last ? "ok" : "off", label: last ? "live" : "waiting" }} actions={selector}>
        <TimeSeriesChart ts={ts} series={[{ id: "cpu", label: "CPU", color: "--series-cpu", values: pick(samples, (s) => s.cpu) }]} format={pctFmt} yMax={100} height={240} />
        <div className="mt-3">
          <div className="label mb-1.5">Per-logical-core activity · last 60 samples</div>
          <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(8, Math.max(1, cores.length))}, minmax(0,1fr))` }}>
            {cores.map((c, i) => (
              <div key={i} className="recess p-1.5">
                <div className="flex justify-between text-[10.5px]">
                  <span className="readout text-ink-3">CPU{i}</span>
                  <span className="readout">{c.toFixed(0)}%</span>
                </div>
                <div className="h-[26px]">
                  <Sparkline values={recent.map((s) => s.cores[i] ?? null)} color="rgb(var(--series-cpu))" max={100} height={26} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </Panel>
      <Panel title="Processor" code="C2">
        <div className="flex flex-col gap-3">
          <Readout label="Model" value={<span className="text-[12.5px] font-sans">{status?.info.cpuBrand || "—"}</span>} />
          <div className="grid grid-cols-2 gap-3">
            <Readout label="Utilisation" value={pct(val(last?.cpu))} />
            <Readout label="Logical cores" value={status?.info.logicalCores ?? "—"} />
            <Readout label="Physical cores" value={status?.info.physicalCores ?? "—"} />
            <MetricReadout label="Frequency" metric={last?.cpuFreq} fmt={(v) => `${(v / 1000).toFixed(2)} GHz`} />
            <MetricReadout label="FlowDesk CPU" metric={last?.appCpu} fmt={(v) => pct(v)} />
            <MetricReadout label="Temperature" metric={last?.cpuTemp} fmt={(v) => `${v.toFixed(0)} °C`} />
          </div>
          {last?.cpuFreq.note && <p className="text-[10.5px] text-ink-3 leading-snug">{last.cpuFreq.note}</p>}
        </div>
      </Panel>
    </div>
  );
}

function MetricReadout({ label, metric, fmt }: { label: string; metric?: Metric; fmt: (v: number) => string }) {
  if (!metric) return <Readout label={label} value="—" />;
  if (!metric.available) return <Readout label={label} value={<NA reason={metric.note} compact />} sub={metric.note ?? undefined} />;
  return <Readout label={label} value={metric.value != null ? fmt(metric.value) : "…"} sub={metric.source} />;
}

// ------------------------------------------------------------------ Memory

function MemoryView({ list }: { list: ProcessList | null }) {
  const { samples, ts, selector, last } = useWindow();
  const top = useMemo(() => (list ? [...list.processes].sort((a, b) => b.memory - a.memory).slice(0, 12) : []), [list]);
  const total = val(last?.memTotal);
  return (
    <div className="grid gap-3 grid-cols-[minmax(0,1fr)_380px]">
      <Panel title="Physical memory" code="M" status={{ tone: last ? "ok" : "off", label: last ? "live" : "waiting" }} actions={selector}>
        <div className="grid grid-cols-6 gap-3 mb-3">
          <Readout label="Used" value={bytes(val(last?.memUsed))} />
          <Readout label="Available" value={bytes(val(last?.memAvailable))} />
          <Readout label="Total" value={bytes(total)} />
          <Readout label="Memory load" value={last ? pct(memPct(last), 0) : "—"} sub="used ÷ total" />
          <Readout label="Page file" value={bytes(val(last?.swapUsed))} sub={`of ${bytes(val(last?.swapTotal))}`} />
          <Readout label="FlowDesk" value={bytes(val(last?.appMem))} sub="working set" tone="amber" />
        </div>
        <TimeSeriesChart ts={ts} series={[{ id: "mem", label: "Memory", color: "--series-mem", values: samples.map(memPct) }]} format={pctFmt} yMax={100} height={220} />
        <p className="mt-2 text-[10.5px] text-ink-3">Windows' hard-fault rate and compressed-memory size are not collected by this build, so no memory-pressure score is shown.</p>
      </Panel>
      <Panel title="Top processes by memory" code="M2" bodyClassName="overflow-auto">
        {!list ? (
          <Empty title="Sampling processes" />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Process</th>
                <th className="text-right">Working set</th>
                <th className="w-[90px]">Share</th>
              </tr>
            </thead>
            <tbody>
              {top.map((p) => (
                <tr key={p.pid}>
                  <td className="max-w-[160px] truncate" title={`${p.name} (${p.pid})`}>{p.name}</td>
                  <td className="readout text-right">{bytes(p.memory)}</td>
                  <td>
                    <div className="recess h-1.5">
                      <div className="h-full" style={{ width: `${total ? (p.memory / total) * 100 : 0}%`, background: "rgb(var(--series-mem))" }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ Disk

function DiskView({ list }: { list: ProcessList | null }) {
  const { samples, ts, selector, last } = useWindow();
  const top = useMemo(
    () => (list?.cpuReady ? [...list.processes].sort((a, b) => b.diskReadBps + b.diskWriteBps - (a.diskReadBps + a.diskWriteBps)).slice(0, 10) : []),
    [list],
  );
  return (
    <div className="grid gap-3 grid-cols-[minmax(0,1fr)_380px]">
      <Panel title="Disk throughput & active time" code="D" status={{ tone: last ? "ok" : "off", label: last?.diskRead.source ?? "waiting" }} actions={selector}>
        <div className="grid grid-cols-4 gap-3 mb-3">
          <MetricReadout label="Read" metric={last?.diskRead} fmt={rate} />
          <MetricReadout label="Write" metric={last?.diskWrite} fmt={rate} />
          <MetricReadout label="Active time" metric={last?.diskActive} fmt={(v) => pct(v)} />
          <Readout label="Peak (window)" value={rate(Math.max(0, ...samples.map((s) => (val(s.diskRead) ?? 0) + (val(s.diskWrite) ?? 0))))} />
        </div>
        <TimeSeriesChart
          ts={ts}
          series={[
            { id: "read", label: "Read", color: "--series-read", values: pick(samples, (s) => s.diskRead) },
            { id: "write", label: "Write", color: "--series-write", values: pick(samples, (s) => s.diskWrite) },
          ]}
          format={rateFmt}
          height={180}
        />
        <div className="mt-3">
          <div className="text-[12px] text-ink-2 mb-1">Active time <span className="text-[10.5px] text-ink-3">% of time disks were busy</span></div>
          {last && !last.diskActive.available ? (
            <NA reason={last.diskActive.note} />
          ) : (
            <TimeSeriesChart ts={ts} series={[{ id: "act", label: "Active", color: "--series-read", values: pick(samples, (s) => s.diskActive) }]} format={pctFmt} yMax={100} height={110} />
          )}
        </div>
      </Panel>
      <Panel title="Top processes by I/O" code="D2" bodyClassName="overflow-auto">
        {!list?.cpuReady ? (
          <Empty title="Sampling processes" />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Process</th>
                <th className="text-right">Read</th>
                <th className="text-right">Write</th>
              </tr>
            </thead>
            <tbody>
              {top.map((p) => (
                <tr key={p.pid}>
                  <td className="max-w-[150px] truncate" title={`${p.name} (${p.pid})`}>{p.name}</td>
                  <td className="readout text-right">{rateFmt(p.diskReadBps)}</td>
                  <td className="readout text-right">{rateFmt(p.diskWriteBps)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="p-3 text-[10.5px] text-ink-3">Per-process figures include all I/O types (file, network and device) as reported by Windows.</p>
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ GPU & sensors

function GpuView() {
  const { samples, ts, selector, last } = useWindow();
  const status = useAppStatus();
  const sensors: [string, Metric | undefined, (v: number) => string][] = [
    ["CPU utilisation", last?.cpu, (v) => pct(v)],
    ["CPU frequency", last?.cpuFreq, (v) => `${v.toFixed(0)} MHz`],
    ["CPU temperature", last?.cpuTemp, (v) => `${v.toFixed(1)} °C`],
    ["Memory used", last?.memUsed, (v) => bytes(v)],
    ["Disk read", last?.diskRead, rate],
    ["Disk write", last?.diskWrite, rate],
    ["Disk active time", last?.diskActive, (v) => pct(v)],
    ["GPU utilisation", last?.gpuUtil, (v) => pct(v)],
    ["GPU temperature", last?.gpuTemp, (v) => `${v.toFixed(0)} °C`],
    ["GPU power", last?.gpuPower, (v) => `${v.toFixed(1)} W`],
    ["GPU fan", last?.gpuFan, (v) => `${v.toFixed(0)} %`],
    ["GPU memory used", last?.gpuMemUsed, (v) => bytes(v)],
    ["System fan", last?.fan, (v) => `${v} RPM`],
    ["FlowDesk CPU", last?.appCpu, (v) => pct(v)],
    ["FlowDesk memory", last?.appMem, (v) => bytes(v)],
  ];
  return (
    <div className="grid gap-3 grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel title={status?.info.gpuName ?? "GPU"} code="G" status={{ tone: last?.gpuUtil.available ? "ok" : "off", label: last?.gpuUtil.source ?? "waiting" }} actions={selector}>
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-[12px] text-ink-2 mb-1">Utilisation <span className="text-[10.5px] text-ink-3">busiest engine</span></div>
            <TimeSeriesChart ts={ts} series={[{ id: "gpu", label: "GPU", color: "--series-gpu", values: pick(samples, (s) => s.gpuUtil) }]} format={pctFmt} yMax={100} height={130} />
          </div>
          <div>
            <div className="text-[12px] text-ink-2 mb-1">Temperature <span className="text-[10.5px] text-ink-3">°C, NVML</span></div>
            {last && !last.gpuTemp.available ? (
              <NA reason={last.gpuTemp.note} />
            ) : (
              <TimeSeriesChart ts={ts} series={[{ id: "t", label: "GPU temp", color: "--series-gpu", values: pick(samples, (s) => s.gpuTemp) }]} format={(v) => `${v.toFixed(0)}°`} height={110} />
            )}
          </div>
          <div>
            <div className="text-[12px] text-ink-2 mb-1">Power draw <span className="text-[10.5px] text-ink-3">W, NVML</span></div>
            {last && !last.gpuPower.available ? (
              <NA reason={last.gpuPower.note} />
            ) : (
              <TimeSeriesChart ts={ts} series={[{ id: "p", label: "GPU power", color: "--series-gpu", values: pick(samples, (s) => s.gpuPower) }]} format={(v) => `${v.toFixed(0)}W`} height={110} />
            )}
          </div>
        </div>
      </Panel>
      <Panel title="Sensor availability" code="G2" bodyClassName="overflow-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Reading</th>
              <th className="text-right">Value</th>
              <th>Source / reason</th>
            </tr>
          </thead>
          <tbody>
            {sensors.map(([label, m, fmt]) => (
              <tr key={label}>
                <td>
                  <span className="flex items-center gap-1.5">
                    <Led tone={!m ? "off" : m.available ? "ok" : "off"} />
                    {label}
                  </span>
                </td>
                <td className="readout text-right">{m?.available ? (m.value != null ? fmt(m.value) : "…") : <NA compact reason={m?.note} />}</td>
                <td className="text-[11px] text-ink-3 max-w-[300px] truncate" title={m?.note ?? m?.source}>
                  {m ? (m.available ? m.source : m.note) : "—"}
                </td>
              </tr>
            ))}
            <tr>
              <td>
                <span className="flex items-center gap-1.5">
                  <Led tone={last?.gpuThrottle.available ? (last.gpuThrottle.active ? "amber" : "ok") : "off"} />
                  GPU throttling
                </span>
              </td>
              <td className="readout text-right">{last?.gpuThrottle.available ? (last.gpuThrottle.active ? "active" : "none") : <NA compact reason={last?.gpuThrottle.note} />}</td>
              <td className="text-[11px] text-ink-3 truncate max-w-[300px]">{last?.gpuThrottle.available ? last.gpuThrottle.reasons.join(", ") || "NVML" : last?.gpuThrottle.note}</td>
            </tr>
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
