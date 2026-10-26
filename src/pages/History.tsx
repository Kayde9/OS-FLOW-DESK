import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Empty, ErrorNote, Led, Panel, Seg, statusTone } from "../components/industrial/Panel";
import { api, errorText } from "../lib/backend";
import { bytes, clock, duration, OP_LABEL, POLICY_LABEL, shortPath } from "../lib/format";
import type { JobEvent } from "../lib/types";
import { useJobRecords } from "./overview/Tables";

/** Chronological audit log of every task FlowDesk has run, grouped by day. */
export default function History() {
  const { rows, error } = useJobRecords(5000);
  const [filter, setFilter] = useState<"all" | "ok" | "problems">("all");
  const [open, setOpen] = useState<number | null>(null);
  const [events, setEvents] = useState<Map<number, JobEvent[] | string>>(new Map());

  const days = useMemo(() => {
    const list = (rows ?? []).filter((r) =>
      filter === "all" ? true : filter === "ok" ? r.status === "completed" : r.status !== "completed" || r.files_failed > 0,
    );
    const m = new Map<string, typeof list>();
    for (const r of list) {
      const d = new Date(r.created_at).toLocaleDateString([], { weekday: "short", year: "numeric", month: "short", day: "2-digit" });
      if (!m.has(d)) m.set(d, []);
      m.get(d)!.push(r);
    }
    return [...m.entries()];
  }, [rows, filter]);

  const expand = async (id: number) => {
    setOpen((o) => (o === id ? null : id));
    if (events.has(id)) return;
    try {
      const d = await api.jobDetail(id);
      setEvents((m) => new Map(m).set(id, d.events));
    } catch (e) {
      setEvents((m) => new Map(m).set(id, errorText(e)));
    }
  };

  return (
    <div className="p-3 min-w-[1000px]">
      <Panel
        title="Task history"
        code="H"
        status={{ tone: rows ? "ok" : "off", label: rows ? `${rows.length} records` : "SQLite" }}
        actions={
          <Seg
            label="Filter"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "ok", label: "Completed" },
              { value: "problems", label: "With problems" },
            ]}
          />
        }
        bodyClassName=""
      >
        {error && <div className="p-3"><ErrorNote>{error}</ErrorNote></div>}
        {rows && days.length === 0 && <Empty title="No history yet">Tasks persist here across restarts. Tasks interrupted by closing FlowDesk are marked “interrupted”.</Empty>}
        {days.map(([day, list]) => (
          <section key={day}>
            <div className="sticky top-0 z-10 px-3 h-7 flex items-center label bg-panel-raised border-b border-steel-dim">{day}</div>
            <ul>
              {list.map((r) => {
                const ev = events.get(r.id);
                return (
                  <li key={r.id} className="border-b border-steel-dim/60">
                    <button className="w-full flex items-center gap-3 px-3 h-9 text-left hover:bg-white/[0.025]" onClick={() => void expand(r.id)} aria-expanded={open === r.id}>
                      {open === r.id ? <ChevronDown size={13} className="text-ink-3" /> : <ChevronRight size={13} className="text-ink-3" />}
                      <span className="readout text-ink-3 w-16">{clock(r.created_at)}</span>
                      <Led tone={statusTone(r.status)} />
                      <span className="w-[90px] text-[12px]">{r.status}</span>
                      <span className="readout text-ink-3 w-12">#{r.id}</span>
                      <span className="flex-1 truncate text-[12.5px]" title={r.name}>{r.name}</span>
                      <span className="text-[11.5px] text-ink-2 w-[150px] truncate">{OP_LABEL[r.op]}</span>
                      <span className="text-[11.5px] text-ink-2 w-[120px]">{POLICY_LABEL[r.policy]}</span>
                      <span className="readout text-[11.5px] w-[110px] text-right">{r.files_done}/{r.files_total} files</span>
                      <span className="readout text-[11.5px] w-[80px] text-right">{bytes(r.bytes_done)}</span>
                      <span className="readout text-[11.5px] w-[72px] text-right">{r.started_at && r.ended_at ? duration(r.ended_at - r.started_at) : "—"}</span>
                    </button>
                    {open === r.id && (
                      <div className="px-10 pb-3 pt-1 text-[11.5px]">
                        <div className="readout text-ink-3 mb-1 selectable" title={r.folder}>{shortPath(r.folder, 120)}</div>
                        {r.error && <div className="text-alert mb-1">{r.error}</div>}
                        {typeof ev === "string" ? (
                          <ErrorNote>{ev}</ErrorNote>
                        ) : !ev ? (
                          <span className="text-ink-3">Loading events…</span>
                        ) : (
                          <ul className="recess p-2 max-h-[200px] overflow-auto">
                            {ev.map((e, i) => (
                              <li key={i} className="flex gap-2">
                                <span className="readout text-ink-3 shrink-0">{clock(e.ts)}</span>
                                <span className={e.level === "error" ? "text-alert" : e.level === "warn" ? "text-amber" : "text-ink-2"}>{e.message}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </Panel>
    </div>
  );
}
