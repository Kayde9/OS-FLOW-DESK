import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { isTauri } from "../../lib/backend";
import { useEngine } from "../../lib/engine/store";
import { useAppStatus, useFeed, useLatest } from "../../lib/telemetry/store";
import { clock } from "../../lib/format";
import { Led, type Tone } from "../industrial/Panel";
import type { Sample } from "../../lib/types";

const TITLES: Record<string, string> = {
  "/": "Overview · Control Room",
  "/monitor": "Live Monitor",
  "/workspace": "Workspace · Workload Builder",
  "/lab": "Algorithm Lab",
  "/experiments": "Experiments",
  "/history": "Task History",
  "/settings": "Settings",
};

function sensorCount(s: Sample | null) {
  if (!s) return null;
  const list = [s.cpu, s.memUsed, s.diskRead, s.diskActive, s.gpuUtil, s.gpuTemp, s.gpuPower, s.cpuTemp, s.gpuFan, s.fan];
  return { ok: list.filter((m) => m.available).length, total: list.length };
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col justify-center px-3 border-l border-steel-dim h-full min-w-0">
      <div className="label leading-3">{label}</div>
      <div className="flex items-center gap-1.5 text-[12px] text-ink whitespace-nowrap">{children}</div>
    </div>
  );
}

export function TopStrip() {
  const { pathname } = useLocation();
  const feed = useFeed();
  const latest = useLatest();
  const status = useAppStatus();
  const snap = useEngine();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const base = "/" + (pathname.split("/")[1] ?? "");
  const running = snap?.jobs.filter((j) => j.status === "running").length ?? 0;
  const queued = snap?.jobs.filter((j) => j.status === "queued" || j.status === "paused").length ?? 0;
  const sensors = sensorCount(latest);

  const feedView: Record<string, { tone: Tone; label: string }> = {
    live: { tone: "ok", label: "Collecting" },
    connecting: { tone: "info", label: "Connecting" },
    stale: { tone: "amber", label: "Stalled" },
    offline: { tone: "off", label: "No backend" },
    error: { tone: "alert", label: "Error" },
  };
  const f = feedView[feed];
  const monitoring = running > 0 ? { tone: "amber" as Tone, label: "Recording task telemetry" } : feed === "live" ? { tone: "ok" as Tone, label: "Monitoring" } : { tone: "off" as Tone, label: "Idle" };

  return (
    <header className="h-[52px] shrink-0 flex items-stretch bg-bg-1 border-b border-steel-dim">
      <div className="flex flex-col justify-center px-4 min-w-0 flex-1">
        <div className="text-[14px] font-medium truncate">{TITLES[base] ?? "FlowDesk"}</div>
        <div className="text-[10.5px] text-ink-3 truncate font-mono">
          {status ? `${status.info.host ?? "local"} · ${status.info.os ?? ""}` : isTauri ? "connecting to backend…" : "browser preview: backend features disabled"}
        </div>
      </div>
      <Cell label="Monitoring">
        <Led tone={monitoring.tone} pulse={running > 0} />
        {monitoring.label}
      </Cell>
      <Cell label="Telemetry">
        <Led tone={f.tone} />
        {f.label}
        {status && feed === "live" && <span className="readout text-ink-3">@{(status.intervalMs / 1000).toFixed(1)}s</span>}
      </Cell>
      <Cell label="Workloads">
        <span className="readout">{running}</span>
        <span className="text-ink-3">running</span>
        <span className="readout">{queued}</span>
        <span className="text-ink-3">waiting</span>
      </Cell>
      <Cell label="Last sample">
        <span className="readout">{latest ? clock(latest.ts) : "—"}</span>
      </Cell>
      <Cell label="Sensors">
        {sensors ? (
          <span title="Counters/sensors exposed by this machine; the rest are marked N/A where they appear">
            <span className="readout">{sensors.ok}</span>
            <span className="text-ink-3">/{sensors.total} available</span>
          </span>
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </Cell>
    </header>
  );
}
