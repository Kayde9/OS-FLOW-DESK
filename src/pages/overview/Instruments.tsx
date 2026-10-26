import { useMemo } from "react";
import { Gauge } from "../../components/industrial/Gauge";
import { Led, NA, Panel, type Tone } from "../../components/industrial/Panel";
import { bytes, rate } from "../../lib/format";
import { pick, val } from "../../lib/telemetry/series";
import { useAppStatus, useFeed, useSamples } from "../../lib/telemetry/store";
import type { Metric, Sample } from "../../lib/types";

const TREND = 60;

function offlineMetric(): Metric {
  return { value: null, unit: "", source: "—", available: false, note: "Telemetry backend not connected" };
}

export function InstrumentCluster() {
  const samples = useSamples();
  const status = useAppStatus();
  const recent = useMemo(() => samples.slice(-TREND), [samples]);
  const s: Sample | undefined = recent[recent.length - 1];

  if (!s) {
    const m = offlineMetric();
    return (
      <>
        {["CPU", "Memory", "Disk", "GPU"].map((l) => (
          <Gauge key={l} label={l} fraction={null} value="—" source={m.source} available={false} note={m.note} trend={[]} series="--series-cpu" />
        ))}
      </>
    );
  }

  const cpu = val(s.cpu);
  const memU = val(s.memUsed);
  const memT = val(s.memTotal);
  const rd = val(s.diskRead);
  const wr = val(s.diskWrite);
  const active = val(s.diskActive);
  const gpu = val(s.gpuUtil);
  const freq = val(s.cpuFreq);
  const vram = val(s.gpuMemUsed);
  const vramT = val(s.gpuMemTotal);

  return (
    <>
      <Gauge
        label="CPU"
        fraction={cpu != null ? cpu / 100 : null}
        value={cpu != null ? cpu.toFixed(1) : "—"}
        unit="%"
        sub={`${s.cores.length} logical cores${freq ? ` · ${(freq / 1000).toFixed(2)} GHz` : ""}`}
        source={s.cpu.source}
        available={s.cpu.available}
        note={s.cpu.note}
        trend={pick(recent, (x) => x.cpu)}
        series="--series-cpu"
        warnAt={0.9}
        scaleMax="100%"
      />
      <Gauge
        label="Memory"
        fraction={memU != null && memT ? memU / memT : null}
        value={memU != null ? (memU / 1024 ** 3).toFixed(1) : "—"}
        unit="GB"
        sub={memU != null && memT ? `of ${(memT / 1024 ** 3).toFixed(1)} GB · ${((memU / memT) * 100).toFixed(0)}% used` : undefined}
        source={s.memUsed.source}
        available={s.memUsed.available}
        trend={pick(recent, (x) => x.memUsed)}
        series="--series-mem"
        warnAt={0.9}
        scaleMax="100%"
      />
      <Gauge
        label="Disk"
        fraction={active != null ? active / 100 : null}
        value={rd != null && wr != null ? ((rd + wr) / 1024 ** 2).toFixed(1) : "—"}
        unit="MB/s"
        sub={`R ${rate(rd)} · W ${rate(wr)}${active != null ? ` · ${active.toFixed(0)}% active` : ""}`}
        source={s.diskRead.source}
        available={s.diskRead.available}
        note={s.diskRead.note}
        trend={recent.map((x) => {
          const a = val(x.diskRead);
          const b = val(x.diskWrite);
          return a != null && b != null ? a + b : null;
        })}
        series="--series-read"
        scaleMax="100% active time"
      />
      <Gauge
        label="GPU"
        fraction={gpu != null ? gpu / 100 : null}
        value={gpu != null ? gpu.toFixed(0) : "—"}
        unit="%"
        sub={[status?.info.gpuName, vram != null && vramT ? `VRAM ${bytes(vram)} / ${bytes(vramT)}` : null].filter(Boolean).join(" · ") || undefined}
        source={s.gpuUtil.source}
        available={s.gpuUtil.available}
        note={s.gpuUtil.note}
        trend={pick(recent, (x) => x.gpuUtil)}
        series="--series-gpu"
        scaleMax="100%"
      />
    </>
  );
}

/** Thresholds are stated in the UI so the colour coding is auditable. */
function tempTone(v: number, warn: number, crit: number): Tone {
  return v >= crit ? "alert" : v >= warn ? "amber" : "ok";
}

function Row({ label, metric, fmt, tone, hint }: { label: string; metric: Metric | undefined; fmt: (v: number) => string; tone?: (v: number) => Tone; hint?: string }) {
  const v = metric && metric.available ? metric.value : null;
  return (
    <div className="flex items-center gap-2 h-[26px] border-b border-steel-dim/50 last:border-0" title={metric?.note ?? hint ?? undefined}>
      <Led tone={v != null ? (tone ? tone(v) : "info") : "off"} />
      <span className="text-[12px] text-ink-2 w-[86px] shrink-0">{label}</span>
      <span className="min-w-0 flex-1 text-right">
        {v != null ? (
          <span className="readout text-[13px]">{fmt(v)}</span>
        ) : metric?.available ? (
          <span className="text-[11px] text-ink-3">{metric.note ?? "waiting"}</span>
        ) : (
          <NA reason={metric?.note ?? "Telemetry backend not connected"} compact />
        )}
      </span>
    </div>
  );
}

export function ThermalPanel() {
  const samples = useSamples();
  const feed = useFeed();
  const s = samples[samples.length - 1];
  const th = s?.gpuThrottle;
  const unavailable = s ? [s.cpuTemp, s.gpuTemp, s.gpuPower, s.gpuFan, s.fan].filter((m) => !m.available) : [];
  return (
    <Panel
      title="Thermal & Power"
      code="B"
      status={s ? { tone: unavailable.length ? "amber" : "ok", label: `${5 - unavailable.length}/5 sensors` } : { tone: "off", label: feed }}
      bodyClassName="px-3 py-1.5 flex flex-col"
    >
      <Row label="CPU temp" metric={s?.cpuTemp} fmt={(v) => `${v.toFixed(0)} °C`} tone={(v) => tempTone(v, 80, 95)} />
      <Row label="GPU temp" metric={s?.gpuTemp} fmt={(v) => `${v.toFixed(0)} °C`} tone={(v) => tempTone(v, 80, 90)} />
      <Row label="GPU power" metric={s?.gpuPower} fmt={(v) => `${v.toFixed(1)} W`} />
      <Row label="GPU fan" metric={s?.gpuFan} fmt={(v) => `${v.toFixed(0)} %`} />
      <Row label="System fan" metric={s?.fan} fmt={(v) => `${v.toFixed(0)} RPM`} />
      <div className="flex items-center gap-2 h-[26px]" title={th?.note ?? undefined}>
        <Led tone={th?.available ? (th.active ? "amber" : "ok") : "off"} />
        <span className="text-[12px] text-ink-2 w-[86px] shrink-0">GPU throttle</span>
        <span className="flex-1 text-right text-[12px]">
          {th?.available ? (
            th.active ? <span className="text-amber">{th.reasons.join(", ")}</span> : <span className="text-ok">none</span>
          ) : (
            <NA reason={th?.note ?? "Telemetry backend not connected"} compact />
          )}
        </span>
      </div>
      <div className="mt-auto pt-1 text-[10.5px] text-ink-3 leading-snug">
        Amber ≥ 80 °C · red ≥ 90 °C GPU / 95 °C CPU. Hover N/A for the reason a sensor is missing.
      </div>
    </Panel>
  );
}
