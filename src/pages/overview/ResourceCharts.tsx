import { useMemo, useState } from "react";
import { Panel, Seg } from "../../components/industrial/Panel";
import { TimeSeriesChart } from "../../components/charts/TimeSeriesChart";
import { rate } from "../../lib/format";
import { memPct, pick, RANGES, windowed } from "../../lib/telemetry/series";
import { useFeed, useSamples } from "../../lib/telemetry/store";
import { usePrefs } from "../../lib/prefs";

const pctFmt = (v: number) => `${v.toFixed(0)}%`;
const rateFmt = (v: number) => rate(v).replace(" ", "");

export function ResourceCharts({ height = 104 }: { height?: number }) {
  const all = useSamples();
  const feed = useFeed();
  const { defaultRangeMs } = usePrefs();
  const [range, setRange] = useState<number>(defaultRangeMs);
  const samples = useMemo(() => windowed(all, range), [all, range]);
  const ts = useMemo(() => samples.map((s) => s.ts), [samples]);
  const last = samples[samples.length - 1];
  const empty = feed === "offline" ? "Telemetry backend not connected" : "Waiting for samples";

  const cpu = useMemo(() => [{ id: "cpu", label: "CPU", color: "--series-cpu", values: pick(samples, (s) => s.cpu) }], [samples]);
  const mem = useMemo(() => [{ id: "mem", label: "Memory", color: "--series-mem", values: samples.map(memPct) }], [samples]);
  const disk = useMemo(
    () => [
      { id: "read", label: "Read", color: "--series-read", values: pick(samples, (s) => s.diskRead) },
      { id: "write", label: "Write", color: "--series-write", values: pick(samples, (s) => s.diskWrite) },
    ],
    [samples],
  );
  const gpu = useMemo(() => [{ id: "gpu", label: "GPU", color: "--series-gpu", values: pick(samples, (s) => s.gpuUtil) }], [samples]);
  const gpuAvailable = last ? last.gpuUtil.available : true;

  return (
    <Panel
      title="Resource Telemetry"
      code="E"
      status={feed === "live" ? { tone: "ok", label: "live" } : { tone: "off", label: feed }}
      actions={<Seg label="Time range" value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r.value, label: r.label }))} />}
      bodyClassName="p-3 grid grid-cols-2 gap-x-4 gap-y-2"
    >
      <ChartBlock title="CPU utilisation" unit="% of all cores" current={last?.cpu.value != null ? pctFmt(last.cpu.value) : null}>
        <TimeSeriesChart ts={ts} series={cpu} format={pctFmt} yMax={100} height={height} emptyLabel={empty} />
      </ChartBlock>
      <ChartBlock title="Memory in use" unit="% of physical RAM" current={last ? (memPct(last) != null ? pctFmt(memPct(last)!) : null) : null}>
        <TimeSeriesChart ts={ts} series={mem} format={pctFmt} yMax={100} height={height} emptyLabel={empty} />
      </ChartBlock>
      <ChartBlock title="Disk throughput" unit="bytes/s, all physical disks">
        <TimeSeriesChart ts={ts} series={disk} format={rateFmt} height={height - 18} emptyLabel={empty} />
      </ChartBlock>
      <ChartBlock title="GPU utilisation" unit="% busiest engine" current={last?.gpuUtil.value != null ? pctFmt(last.gpuUtil.value) : null}>
        {gpuAvailable ? (
          <TimeSeriesChart ts={ts} series={gpu} format={pctFmt} yMax={100} height={height} emptyLabel={empty} />
        ) : (
          <div className="recess flex items-center justify-center text-[11.5px] text-ink-3 px-4 text-center" style={{ height }}>
            N/A: {last?.gpuUtil.note}
          </div>
        )}
      </ChartBlock>
    </Panel>
  );
}

function ChartBlock({ title, unit, current, children }: { title: string; unit: string; current?: string | null; children: React.ReactNode }) {
  return (
    <div className="min-w-0 flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] text-ink-2 font-medium">{title}</span>
        <span className="text-[10.5px] text-ink-3">{unit}</span>
        {current && <span className="readout ml-auto text-[13px]">{current}</span>}
      </div>
      {children}
    </div>
  );
}
