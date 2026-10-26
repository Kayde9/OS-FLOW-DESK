import { useEffect, useMemo, useState } from "react";
import { FolderOpen, GitCompare, Trash2 } from "lucide-react";
import { Empty, ErrorNote, Led, Loading, Panel } from "../../components/industrial/Panel";
import { api, errorText } from "../../lib/backend";
import { bytes, dateTime, duration, OP_LABEL } from "../../lib/format";
import { durUs } from "../../lib/trace/analysis";
import { openSession, useTrace } from "../../lib/trace/store";
import type { SessionRecord } from "../../lib/trace/types";
import { ExportControls, STATE_TONE } from "./Header";

const op = (r: SessionRecord) => (r.config?.target.kind === "workload" ? OP_LABEL[r.config.target.job.op] : null);

function compareRows() {
  const s = (r: SessionRecord) => r.summary;
  const opRow = (r: SessionRecord, name: string) => s(r)?.operations.find((o) => o.category === "file" && o.operation === name);
  const rows: [string, (r: SessionRecord) => string][] = [
    ["Target", (r) => `${r.targetName ?? "—"} (${r.targetKind})`],
    ["Workload", (r) => op(r) ?? "—"],
    ["Providers", (r) => (r.providers ?? []).filter((p) => p.enabled).map((p) => p.id).join(", ") || "FlowDesk events only"],
    ["Duration", (r) => (r.startedAt && r.endedAt ? duration(r.endedAt - r.startedAt) : "—")],
    ["Events stored", (r) => r.events.toLocaleString()],
    ["File events", (r) => (s(r)?.byCategory.file ?? 0).toLocaleString()],
    ["Workload events", (r) => (s(r)?.byCategory.workload ?? 0).toLocaleString()],
    ["Read requests", (r) => `${opRow(r, "Read")?.count ?? 0} · ${bytes(opRow(r, "Read")?.bytes ?? 0)}`],
    ["Read p50 / p95", (r) => `${durUs(opRow(r, "Read")?.p50Us)} / ${durUs(opRow(r, "Read")?.p95Us)}`],
    ["Write requests", (r) => `${opRow(r, "Write")?.count ?? 0} · ${bytes(opRow(r, "Write")?.bytes ?? 0)}`],
    ["Write p50 / p95", (r) => `${durUs(opRow(r, "Write")?.p50Us)} / ${durUs(opRow(r, "Write")?.p95Us)}`],
    ["Non-success results", (r) => String(s(r)?.results.reduce((a, x) => a + x[1], 0) ?? 0)],
    ["ETW events lost", (r) => (r.mode === "etw" ? String(r.stats?.etwEventsLost ?? "not reported") : "n/a")],
    ["Queue drops", (r) => String(r.stats?.queueDropped ?? 0)],
  ];
  return rows;
}

export function SessionsTab({ onOpened }: { onOpened: () => void }) {
  const t = useTrace();
  const [rows, setRows] = useState<SessionRecord[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<number[]>([]);

  const load = async () => {
    try {
      setRows(await api.traceSessions(200));
      setErr(null);
    } catch (e) {
      setErr(errorText(e));
    }
  };
  useEffect(() => {
    void load();
  }, [t.sessionsVersion]);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (rows ?? []).filter((r) => !n || `${r.id} ${r.name} ${r.targetName ?? ""} ${r.state} ${op(r) ?? ""}`.toLowerCase().includes(n));
  }, [rows, q]);
  const compared = (rows ?? []).filter((r) => picked.includes(r.id));
  const compatible = compared.length < 2 || compared.every((r) => r.targetKind === compared[0].targetKind && r.mode === compared[0].mode);

  if (err) return <ErrorNote>{err}</ErrorNote>;
  if (!rows) return <Loading label="Loading sessions" />;

  return (
    <div className="flex flex-col gap-3">
      <Panel
        title="Saved trace sessions"
        code="S1"
        status={{ tone: "info", label: `${rows.length} stored` }}
        actions={<input className="field h-6 w-[220px] font-sans text-[11.5px]" placeholder="Search sessions" value={q} onChange={(e) => setQ(e.target.value)} />}
        bodyClassName="max-h-[420px] overflow-auto"
      >
        {shown.length === 0 ? (
          <Empty title="No trace sessions">Sessions are saved automatically when a capture stops. The newest 30 are kept (and at most 3M events).</Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th title="Select up to 4 to compare"><GitCompare size={11} /></th>
                <th>#</th><th>Name</th><th>State</th><th>Mode</th><th>Target</th><th>Task</th>
                <th className="text-right">Events</th><th className="text-right">Duration</th><th>Created</th><th />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className={t.viewing.sessionId === r.id ? "bg-amber/[0.06]" : ""}>
                  <td>
                    <input
                      type="checkbox"
                      className="accent-[rgb(var(--amber))]"
                      aria-label={`Compare session ${r.id}`}
                      checked={picked.includes(r.id)}
                      disabled={!picked.includes(r.id) && picked.length >= 4}
                      onChange={(e) => setPicked((p) => (e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id)))}
                    />
                  </td>
                  <td className="readout text-ink-3">{r.id}</td>
                  <td className="max-w-[220px] truncate" title={r.error ?? r.name}>{r.name}</td>
                  <td><span className="flex items-center gap-1.5"><Led tone={STATE_TONE[r.state] ?? "off"} />{r.state}</span></td>
                  <td>{r.mode === "etw" ? "ETW" : "App events"}</td>
                  <td className="readout truncate max-w-[160px]">{r.targetName ?? "—"} · {r.targetPid ?? "—"}</td>
                  <td className="readout">{r.jobId != null ? `#${r.jobId}` : "—"}</td>
                  <td className="readout text-right">{r.events.toLocaleString()}</td>
                  <td className="readout text-right">{r.startedAt && r.endedAt ? duration(r.endedAt - r.startedAt) : "—"}</td>
                  <td className="readout text-ink-3">{dateTime(r.createdAt)}</td>
                  <td className="flex gap-1 items-center h-7">
                    <button className="btn btn-sm" onClick={() => { void openSession(r.id); onOpened(); }} title="Open in the capture view">
                      <FolderOpen size={11} /> Open
                    </button>
                    <button
                      className="btn btn-sm"
                      title="Delete session and its events"
                      aria-label={`Delete session ${r.id}`}
                      onClick={async () => {
                        if (!confirm(`Delete trace session #${r.id} and its ${r.events.toLocaleString()} events?`)) return;
                        await api.traceDelete(r.id).catch((e) => setErr(errorText(e)));
                        setPicked((p) => p.filter((x) => x !== r.id));
                        void load();
                      }}
                    >
                      <Trash2 size={11} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {t.viewing.kind === "saved" && t.viewing.record && (
        <Panel title={`Export session #${t.viewing.record.id}`} code="S2">
          <ExportControls sessionId={t.viewing.record.id} name={t.viewing.record.name} />
          <p className="text-[11px] text-ink-3 mt-2">Exports contain FlowDesk's normalized event records — not native ETL files (real-time sessions keep no .etl). Choose a redaction level before sharing.</p>
        </Panel>
      )}

      <Panel title="Compare sessions" code="S3" status={{ tone: compared.length >= 2 ? (compatible ? "ok" : "amber") : "off", label: compared.length >= 2 ? (compatible ? "compatible" : "different target kinds or modes") : "select 2–4" }}>
        {compared.length < 2 ? (
          <Empty title="Select two to four sessions above">Compares stored summaries: event counts, read/write volumes, completion percentiles and loss.</Empty>
        ) : (
          <>
            {!compatible && <div className="mb-2 text-[11.5px] text-amber">These sessions differ in target kind or capture mode, so their counts are not directly comparable.</div>}
            <table className="tbl">
              <thead>
                <tr>
                  <th>Metric</th>
                  {compared.map((r) => <th key={r.id} className="text-right">#{r.id} {r.name.slice(0, 24)}</th>)}
                </tr>
              </thead>
              <tbody>
                {compareRows().map(([label, f]) => (
                  <tr key={label}>
                    <td className="text-ink-3">{label}</td>
                    {compared.map((r) => <td key={r.id} className="readout text-right">{r.summary || label === "Target" || label === "Providers" ? f(r) : "no summary"}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[10.5px] text-ink-3 mt-1.5">Single runs: differences may come from caching, other programs or disk state, not only from the configuration. Repeat runs before drawing conclusions.</p>
          </>
        )}
      </Panel>
    </div>
  );
}
