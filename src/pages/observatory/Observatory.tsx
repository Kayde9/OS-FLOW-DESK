import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, Pause, Play, Radio, Search, X, ZoomIn, ZoomOut } from "lucide-react";
import { Empty, ErrorNote, Loading, Panel, Seg } from "../../components/industrial/Panel";
import { isTauri } from "../../lib/backend";
import { useSelection } from "../../lib/engine/store";
import { OP_LABEL } from "../../lib/format";
import { buildLanes, clockUs, compact, durUs, emptyFilter, filterIdx, sortIdx, step, type SortKey } from "../../lib/trace/analysis";
import {
  buildConfig,
  LIVE_CAP,
  refreshCaps,
  setRenderPaused,
  startCapture,
  stopCapture,
  ui,
  useSetup,
  useTrace,
  useUi,
  viewLive,
  win,
} from "../../lib/trace/store";
import { useSamples } from "../../lib/telemetry/store";
import { AnalysisTab } from "./AnalysisTab";
import { CAT, CatGlyph } from "./categories";
import { EventTable } from "./EventTable";
import { CommandHeader, ExportControls, StatsStrip, type HeaderModel } from "./Header";
import { Inspector } from "./Inspector";
import { SessionsTab } from "./SessionsTab";
import { TargetSetup } from "./TargetSetup";
import { fromPoints, fromSamples } from "./telemetry";
import { Timeline } from "./Timeline";

type Tab = "capture" | "analysis" | "sessions";
const setUi = (p: Partial<ReturnType<typeof ui.get>>) => ui.set((s) => ({ ...s, ...p }));
const CATS = ["file", "disk", "process", "thread", "image", "workload"];

export default function Observatory() {
  const t = useTrace();
  const u = useUi();
  const s = useSetup();
  const sel = useSelection();
  const samples = useSamples();
  const [tab, setTab] = useState<Tab>("capture");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    void refreshCaps();
  }, []);

  const events = win.events;
  const live = t.viewing.kind === "live" ? t.live : null;
  const record = t.viewing.kind === "saved" ? t.viewing.record : null;
  const session = live ?? null;

  /* eslint-disable react-hooks/exhaustive-deps */
  const filtered = useMemo(() => filterIdx(events, u.filter), [t.version, u.filter]);
  const order = useMemo(() => sortIdx(events, filtered, u.sort.key, u.sort.dir), [filtered, u.sort]);
  const lanes = useMemo(() => buildLanes(events, filtered), [filtered]);
  const extent = useMemo<[number, number] | null>(() => {
    if (!events.length) return null;
    let a = Infinity;
    let b = -Infinity;
    for (const e of events) {
      a = Math.min(a, e.tsUs);
      b = Math.max(b, e.tsUs + (e.durationUs ?? 0));
    }
    return [a, b];
  }, [t.version]);
  /* eslint-enable react-hooks/exhaustive-deps */

  const tel = useMemo(() => {
    if (t.viewing.kind === "saved") return fromPoints(t.viewing.telemetry ?? []);
    if (!extent) return fromSamples([], 0, 0);
    return fromSamples(samples, extent[0] / 1000, extent[1] / 1000);
  }, [t.viewing, samples, extent]);

  const selectedEvent = u.selected != null ? events[win.bySeq.get(u.selected) ?? -1] ?? null : null;
  const cfg = buildConfig(s, sel.folder);
  const capturing = live?.state === "capturing";
  const follow = u.follow && capturing && u.sort.key === "time" && u.sort.dir === 1;

  const header: HeaderModel = record
    ? {
        state: record.state,
        title: record.name,
        target: `${record.targetName ?? "—"} · PID ${record.targetPid ?? "—"}`,
        mode: `Saved session · ${record.mode === "etw" ? "ETW" : "FlowDesk events only"}`,
        startedAt: record.startedAt,
        endedAt: record.endedAt ?? record.startedAt,
        events: record.events,
        lastEventUs: record.lastEventUs,
        loss: record.mode === "etw" && record.stats ? (record.stats.etwEventsLost ?? 0) + (record.stats.etwRtBuffersLost ?? 0) + record.stats.queueDropped : null,
        lossNote: record.mode === "etw" ? "ControlTrace(QUERY) counters" : "No ETW session",
        sessionId: record.id,
        saved: true,
      }
    : session
      ? {
          state: session.state,
          title: session.name,
          target: `${session.target.name ?? "process"} · PID ${session.target.pid}${session.jobId != null ? ` · task #${session.jobId}` : ""}`,
          mode: session.mode === "etw" ? `ETW · ${session.providers.filter((p) => p.enabled).map((p) => p.name.replace("Microsoft-Windows-", "")).join(", ") || "providers pending"}` : "FlowDesk events only",
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          events: session.stats.captured,
          lastEventUs: session.stats.lastEventUs,
          loss: session.mode === "etw" && session.stats.etwEventsLost != null ? session.stats.etwEventsLost + (session.stats.etwRtBuffersLost ?? 0) + session.stats.queueDropped : session.mode === "etw" ? null : null,
          lossNote: session.mode === "etw" ? (session.stats.etwEventsLost == null ? "waiting for first ETW query" : "ControlTrace(QUERY) counters") : "No ETW session",
          sessionId: session.id,
          saved: ["completed", "cancelled", "failed"].includes(session.state),
        }
      : { state: "idle", title: "", target: s.mode === "workload" ? `FlowDesk · ${OP_LABEL[s.op]}` : s.procName ? `${s.procName} · PID ${s.procPid}` : "none selected", mode: null, startedAt: null, endedAt: null, events: null, lastEventUs: null, loss: null, lossNote: "no session", sessionId: null, saved: false };

  const start = async () => {
    if (typeof cfg === "string") return;
    setStarting(true);
    ui.set((x) => ({ ...x, selected: null, pinned: [], window: null, follow: true, filter: { ...x.filter, range: null } }));
    setTab("capture");
    await startCapture(cfg);
    setStarting(false);
  };

  const selectSeq = (seq: number) => setUi({ selected: seq });
  const stepSel = (dir: 1 | -1) => {
    const pos = u.selected == null ? -1 : order.findIndex((i) => events[i].seq === u.selected);
    const n = step(order, pos, dir);
    if (n != null) {
      setUi({ selected: events[order[n]].seq, follow: false });
      center(events[order[n]].tsUs, false);
    }
  };
  const center = (ts: number, force = true) => {
    const w = u.window ?? extent;
    if (!w) return;
    if (!force && ts >= w[0] && ts <= w[1]) return;
    const half = Math.max(500, (w[1] - w[0]) / 2);
    setUi({ window: [ts - half, ts + half] });
  };
  const zoom = (f: number) => {
    const w = u.window ?? extent;
    if (!w) return;
    const mid = (w[0] + w[1]) / 2;
    const half = Math.max(10, ((w[1] - w[0]) / 2) * f);
    setUi({ window: [mid - half, mid + half] });
  };
  const toggleCat = (c: string) => {
    const cur = u.filter.categories ?? new Set(CATS);
    const next = new Set(cur);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    setUi({ filter: { ...u.filter, categories: next.size === CATS.length ? null : next } });
  };
  const pin = (seq: number) => setUi({ pinned: u.pinned.includes(seq) ? u.pinned.filter((x) => x !== seq) : [...u.pinned, seq] });
  const onSort = (k: SortKey) => setUi({ sort: { key: k, dir: u.sort.key === k ? ((-u.sort.dir) as 1 | -1) : 1 } });

  const failed = live?.state === "failed" ? live : null;
  const streamNote =
    live && (live.stats.notStreamed > 0 || win.dropped > 0)
      ? `Live view: ${win.dropped ? `${compact(win.dropped)} oldest events dropped from memory (window ${compact(LIVE_CAP)})` : ""}${live.stats.notStreamed ? ` ${compact(live.stats.notStreamed)} events were saved but not streamed` : ""}. All captured events are in the database${["completed", "cancelled"].includes(live.state) ? " — reload to see them" : ""}.`
      : null;

  return (
    <div className="p-3 flex flex-col gap-3 min-w-[1120px]">
      <CommandHeader
        m={header}
        canStart={isTauri && typeof cfg !== "string" && t.caps != null}
        startHint={typeof cfg === "string" ? cfg : null}
        starting={starting}
        onStart={() => void start()}
        onStop={() => void stopCapture(false)}
        onCancel={() => void stopCapture(true)}
      />
      {!isTauri && <ErrorNote>The Observatory needs the FlowDesk desktop backend (npm run tauri dev). Nothing here is simulated.</ErrorNote>}
      {t.capsError && <ErrorNote>{t.capsError}</ErrorNote>}
      {t.error && <ErrorNote>{t.error}</ErrorNote>}
      {failed && (
        <ErrorNote>
          <div className="font-medium">{failed.errorKind === "permission" ? "Capture could not start: administrator rights required" : "Capture failed"}</div>
          <div className="text-ink-2">{failed.error}</div>
          {failed.errorKind === "permission" && (
            <div className="text-ink-2 mt-1">
              To capture ETW, run <span className="font-mono">npm run tauri dev</span> from a PowerShell opened with Run as administrator, or add your account to <span className="font-mono">Performance Log Users</span>. Otherwise untick all ETW providers (or press “Use FlowDesk events only”) to record FlowDesk application events. No events were captured and the workload was not started.
            </div>
          )}
        </ErrorNote>
      )}
      {session?.stopReason && session.state !== "capturing" && !record && (
        <div className="text-[11.5px] text-ink-3">Stop reason: <span className="text-ink-2">{session.stopReason}</span></div>
      )}

      <div className="flex items-center gap-3">
        <Seg label="Observatory view" value={tab} onChange={setTab} options={[{ value: "capture", label: "Capture" }, { value: "analysis", label: "Analysis" }, { value: "sessions", label: "Sessions" }]} />
        {t.viewing.kind === "saved" ? (
          <span className="flex items-center gap-2 text-[11.5px] text-ink-2">
            <span className="sim-badge border-info/50 text-info">Saved session #{t.viewing.sessionId}</span>
            {t.live && ["capturing", "preparing"].includes(t.live.state) && (
              <button className="btn btn-sm" onClick={viewLive}><Radio size={12} /> Back to live capture</button>
            )}
          </span>
        ) : live ? (
          <span className="live-badge">{capturing ? "Live capture" : `Session #${live.id}`}</span>
        ) : null}
        {t.loading && <Loading label="Loading events from database" />}
        {t.loadNote && <span className="text-[11.5px] text-amber">{t.loadNote}</span>}
        {live && !capturing && ["completed", "cancelled"].includes(live.state) && (
          <span className="ml-auto flex items-center gap-2">
            <ExportControls sessionId={live.id} name={live.name} compact />
          </span>
        )}
      </div>

      {tab === "capture" && (
        <div className="grid grid-cols-[300px_minmax(0,1fr)] gap-3 items-start">
          <Panel title="Trace target" code="T1" rivets status={capturing ? { tone: "ok", label: "locked" } : undefined}>
            <TargetSetup caps={t.caps} locked={!!live && ["preparing", "capturing", "stopping", "finalizing"].includes(live.state)} />
          </Panel>
          <div className="flex flex-col gap-3 min-w-0">
            <StatsStrip stats={record?.stats ?? session?.stats ?? null} rate={t.rate} live={capturing} mode={record?.mode ?? session?.mode ?? null} />
            {streamNote && (
              <div className="text-[11.5px] text-amber flex items-center gap-2">
                {streamNote}
                {live && ["completed", "cancelled"].includes(live.state) && <button className="btn btn-sm" onClick={viewLive}>Reload from database</button>}
              </div>
            )}

            <Panel
              title="Execution timeline"
              code="T2"
              bodyClassName="p-0"
              status={{ tone: lanes.length ? "info" : "off", label: `${lanes.length} lanes · ${filtered.length.toLocaleString()} events` }}
              actions={
                <div className="flex items-center gap-1">
                  {u.filter.range && (
                    <button className="btn btn-sm" onClick={() => setUi({ filter: { ...u.filter, range: null } })} title="Clear time range filter">
                      range {durUs(Math.round(u.filter.range[1] - u.filter.range[0]))} <X size={11} />
                    </button>
                  )}
                  <button className="btn btn-sm" onClick={() => zoom(0.5)} title="Zoom in" aria-label="Zoom in"><ZoomIn size={12} /></button>
                  <button className="btn btn-sm" onClick={() => zoom(2)} title="Zoom out" aria-label="Zoom out"><ZoomOut size={12} /></button>
                  <button className="btn btn-sm" onClick={() => setUi({ window: null })} title="Fit all events" aria-label="Fit"><Maximize2 size={12} /></button>
                </div>
              }
            >
              {events.length === 0 ? (
                <Empty title={live?.state === "capturing" ? "Waiting for the first events…" : "No events"}>
                  {live?.state === "capturing" ? "Events appear here as ETW delivers them (about once per second per buffer flush)." : "Start a capture or open a saved session. The timeline shows real captured timestamps only."}
                </Empty>
              ) : (
                <>
                  <Timeline
                    events={events}
                    idx={filtered}
                    version={t.version}
                    lanes={lanes}
                    extent={extent}
                    window={u.window}
                    selected={u.selected}
                    range={u.filter.range}
                    tel={tel}
                    onWindow={(window) => setUi({ window })}
                    onSelect={(seq) => setUi({ selected: seq, follow: false })}
                    onRange={(range) => setUi({ filter: { ...u.filter, range } })}
                  />
                  <div className="flex items-center gap-4 px-3 py-1.5 border-t border-steel-dim text-[11px] text-ink-3 flex-wrap">
                    {Object.entries(CAT).map(([k, c]) => (
                      <span key={k} className="flex items-center gap-1.5"><CatGlyph category={k} /> {c.label}</span>
                    ))}
                    <span className="flex items-center gap-1.5"><span className="inline-block w-4 h-2 rounded-[1px] bg-cat-file" /> bar = matched duration</span>
                    <span className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full border-[1.5px] border-alert" /> warning/error result</span>
                    <span className="ml-auto">Wheel zoom · drag pan · Shift+drag range · click select</span>
                  </div>
                </>
              )}
            </Panel>

            <Panel title="Event stream" code="T3" className="h-[560px]" bodyClassName="flex flex-col min-h-0" status={{ tone: t.renderPaused ? "amber" : capturing ? "ok" : "off", label: t.renderPaused ? `view paused · ${t.held.toLocaleString()} held` : capturing ? "streaming" : "static" }}>
              <div className="flex items-center gap-2 px-3 py-2 border-b border-steel-dim flex-wrap">
                <label className="flex items-center gap-1.5 recess px-2 h-7 w-[240px]">
                  <Search size={12} className="text-ink-3" />
                  <input className="bg-transparent outline-none text-[12px] flex-1 min-w-0" placeholder="Search name, path, result, PID…" value={u.filter.text} onChange={(e) => setUi({ filter: { ...u.filter, text: e.target.value } })} aria-label="Search events" />
                </label>
                <div className="flex gap-1" role="group" aria-label="Category filter">
                  {CATS.map((c) => {
                    const on = !u.filter.categories || u.filter.categories.has(c);
                    return (
                      <button key={c} aria-pressed={on} onClick={() => toggleCat(c)} className={`h-7 px-2 rounded-sm border text-[11px] flex items-center gap-1.5 ${on ? "border-steel bg-panel-raised text-ink" : "border-steel-dim text-ink-3 opacity-60"}`}>
                        <CatGlyph category={c} /> {CAT[c].label.replace("FlowDesk workload", "Workload")}
                      </button>
                    );
                  })}
                </div>
                <select className="field h-7 w-[118px]" value={u.filter.source} onChange={(e) => setUi({ filter: { ...u.filter, source: e.target.value as "all" } })} aria-label="Source">
                  <option value="all">All sources</option>
                  <option value="etw">ETW only</option>
                  <option value="flowdesk">FlowDesk only</option>
                </select>
                <input className="field h-7 w-[70px]" placeholder="PID" value={u.filter.pid ?? ""} onChange={(e) => setUi({ filter: { ...u.filter, pid: e.target.value ? Number(e.target.value) || null : null } })} aria-label="Filter PID" />
                <input className="field h-7 w-[70px]" placeholder="TID" value={u.filter.tid ?? ""} onChange={(e) => setUi({ filter: { ...u.filter, tid: e.target.value ? Number(e.target.value) || null : null } })} aria-label="Filter TID" />
                <label className="flex items-center gap-1.5 text-[11.5px] text-ink-2">
                  <input type="checkbox" className="accent-[rgb(var(--amber))]" checked={u.filter.problemsOnly} onChange={(e) => setUi({ filter: { ...u.filter, problemsOnly: e.target.checked } })} /> Errors only
                </label>
                {(u.filter.text || u.filter.categories || u.filter.pid != null || u.filter.tid != null || u.filter.problemsOnly || u.filter.source !== "all" || u.filter.range) && (
                  <button className="btn btn-sm" onClick={() => setUi({ filter: emptyFilter() })}>Clear filters</button>
                )}
                <div className="ml-auto flex items-center gap-1.5">
                  <span className="readout text-[11px] text-ink-3">{order.length.toLocaleString()} / {events.length.toLocaleString()}</span>
                  <button className="btn btn-sm" onClick={() => stepSel(-1)} title="Previous matching event" aria-label="Previous match"><ChevronLeft size={12} /></button>
                  <button className="btn btn-sm" onClick={() => stepSel(1)} title="Next matching event" aria-label="Next match"><ChevronRight size={12} /></button>
                  {capturing && (
                    <>
                      <button className={`btn btn-sm ${u.follow ? "btn-amber" : ""}`} onClick={() => setUi({ follow: !u.follow })} title="Keep the newest events in view">Follow</button>
                      <button className="btn btn-sm" onClick={() => setRenderPaused(!t.renderPaused)} title="Pause rendering only — capture continues in the background">
                        {t.renderPaused ? <><Play size={11} /> Resume view</> : <><Pause size={11} /> Pause view</>}
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className={`flex-1 min-h-0 grid ${selectedEvent ? "grid-cols-[minmax(0,1fr)_370px]" : "grid-cols-1"}`}>
                {events.length === 0 ? (
                  <Empty title="No events yet">{live?.state === "capturing" ? "Capture is running; matching events will stream in." : "Nothing captured in this view."}</Empty>
                ) : (
                  <EventTable
                    events={events}
                    order={order}
                    version={t.version}
                    selected={u.selected}
                    pinned={u.pinned}
                    sort={u.sort}
                    follow={follow && !t.renderPaused}
                    onSort={onSort}
                    onSelect={selectSeq}
                    onPin={pin}
                    onScrolledAway={() => setUi({ follow: false })}
                  />
                )}
                {selectedEvent && (
                  <Inspector
                    e={selectedEvent}
                    events={events}
                    tel={tel}
                    pinned={u.pinned.includes(selectedEvent.seq)}
                    onClose={() => setUi({ selected: null })}
                    onSelect={(seq) => setUi({ selected: seq, follow: false })}
                    onPin={() => pin(selectedEvent.seq)}
                    onJump={() => center(selectedEvent.tsUs)}
                  />
                )}
              </div>
            </Panel>
            {selectedEvent && <div className="sr-only" aria-live="polite">Selected {selectedEvent.eventName} at {clockUs(selectedEvent.tsUs)}</div>}
          </div>
        </div>
      )}

      {tab === "analysis" && <AnalysisTab events={events} idx={filtered} stats={record?.stats ?? session?.stats ?? null} tel={tel} mode={record?.mode ?? session?.mode ?? null} />}
      {tab === "sessions" && <SessionsTab onOpened={() => setTab("capture")} />}
    </div>
  );
}
