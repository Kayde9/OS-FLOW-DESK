// Virtualized event stream: only the rows in view (+ overscan) are rendered,
// so 100k-event sessions scroll smoothly and a live batch re-renders ~40 rows.

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Pin, PinOff } from "lucide-react";
import { bytes } from "../../lib/format";
import { clockUs, durUs, type SortKey } from "../../lib/trace/analysis";
import type { TraceEvent } from "../../lib/trace/types";
import { CatGlyph, catOf } from "./categories";

const ROW = 24;
const OVERSCAN = 12;
const COLS = "grid grid-cols-[124px_112px_58px_58px_120px_150px_minmax(160px,1fr)_74px_84px_168px_28px]";

const HEAD: [SortKey | null, string, string?][] = [
  ["time", "Timestamp"],
  ["process", "Process"],
  ["pid", "PID", "text-right"],
  ["tid", "TID", "text-right"],
  ["category", "Category"],
  ["event", "Event / operation"],
  [null, "File path"],
  ["size", "Size", "text-right"],
  ["duration", "Duration", "text-right"],
  ["status", "Result"],
  [null, ""],
];

interface Props {
  events: TraceEvent[];
  order: number[];
  version: number;
  selected: number | null;
  pinned: number[];
  sort: { key: SortKey; dir: 1 | -1 };
  follow: boolean;
  onSort: (k: SortKey) => void;
  onSelect: (seq: number) => void;
  onPin: (seq: number) => void;
  onScrolledAway: () => void;
}

function Row({ e, selected, pinned, onSelect, onPin }: { e: TraceEvent; selected: boolean; pinned: boolean; onSelect: () => void; onPin: () => void }) {
  const problem = e.status === "error" || e.status === "warning";
  return (
    <div
      role="row"
      aria-selected={selected}
      onClick={onSelect}
      className={`${COLS} items-center h-6 px-2 text-[11.5px] border-b border-steel-dim/40 cursor-default ${
        selected ? "bg-amber/[0.09] shadow-[inset_2px_0_0_rgb(var(--amber))]" : "hover:bg-white/[0.025]"
      }`}
    >
      <span className="readout text-ink-2">{clockUs(e.tsUs)}</span>
      <span className="truncate text-ink-2" title={e.processName}>{e.processName ?? "—"}</span>
      <span className="readout text-right text-ink-3">{e.pid ?? "—"}</span>
      <span className="readout text-right text-ink-3" title={e.threadName}>{e.tid ?? "—"}</span>
      <span className="flex items-center gap-1.5 min-w-0 pl-2">
        <CatGlyph category={e.category} />
        <span className="truncate text-ink-2">{catOf(e.category).label}</span>
      </span>
      <span className="truncate text-ink" title={`${e.provider} · ${e.eventName}`}>{e.operation ?? e.eventName}</span>
      <span className="readout truncate text-ink-2" title={e.filePath}>
        {e.filePath ?? (e.fields._path ? <span className="text-ink-3 font-sans italic">path unknown</span> : "")}
      </span>
      <span className="readout text-right text-ink-2">{e.size != null ? bytes(e.size) : ""}</span>
      <span className="readout text-right text-ink-2">
        {e.durationUs != null ? durUs(e.durationUs) : e.awaitsCompletion ? <span className="text-ink-3" title="No completion (OperationEnd) observed for this request">—</span> : ""}
      </span>
      <span className={`readout truncate pl-2 ${problem ? "text-alert" : "text-ink-3"}`} title={e.resultCode}>
        {problem && "▲ "}
        {e.resultCode ?? ""}
      </span>
      <button
        className="text-ink-3 hover:text-amber justify-self-center"
        title={pinned ? "Unpin" : "Pin event"}
        aria-label={pinned ? "Unpin event" : "Pin event"}
        onClick={(ev) => {
          ev.stopPropagation();
          onPin();
        }}
      >
        {pinned ? <PinOff size={12} className="text-amber" /> : <Pin size={12} />}
      </button>
    </div>
  );
}

export function EventTable(p: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [h, setH] = useState(400);
  const auto = useRef(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Follow the newest events while live (time ascending).
  useEffect(() => {
    const el = box.current;
    if (!el || !p.follow) return;
    auto.current = true;
    el.scrollTop = el.scrollHeight;
  }, [p.version, p.follow, p.order.length]);

  // Keep the selection visible when it changes from elsewhere (timeline, stepping).
  useEffect(() => {
    const el = box.current;
    if (!el || p.selected == null) return;
    const pos = p.order.findIndex((i) => p.events[i].seq === p.selected);
    if (pos < 0) return;
    const y = pos * ROW;
    if (y < el.scrollTop || y > el.scrollTop + el.clientHeight - ROW * 2) {
      auto.current = true;
      el.scrollTop = Math.max(0, y - el.clientHeight / 2);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.selected]);

  const first = Math.max(0, Math.floor(top / ROW) - OVERSCAN);
  const last = Math.min(p.order.length, Math.ceil((top + h) / ROW) + OVERSCAN);
  const pinnedEvents = p.pinned.map((s) => p.events.find((e) => e.seq === s)).filter((e): e is TraceEvent => !!e);

  return (
    <div className="flex flex-col min-h-0 h-full" role="grid" aria-rowcount={p.order.length} aria-label="Trace events">
      <div className="overflow-x-auto overflow-y-hidden flex flex-col min-h-0 h-full">
        <div className="min-w-[1180px] flex flex-col min-h-0 h-full">
          <div role="row" className={`${COLS} items-center h-7 px-2 bg-panel-raised border-b border-steel-dim shrink-0`}>
            {HEAD.map(([k, label, cls], i) => (
              <button
                key={i}
                role="columnheader"
                disabled={!k}
                onClick={() => k && p.onSort(k)}
                className={`label flex items-center gap-1 truncate ${cls === "text-right" ? "justify-end" : ""} ${i === 4 || i === 9 ? "pl-2" : ""} ${k ? "hover:text-ink-2" : "cursor-default"}`}
                aria-sort={k && p.sort.key === k ? (p.sort.dir === 1 ? "ascending" : "descending") : undefined}
              >
                {label}
                {k && p.sort.key === k && (p.sort.dir === 1 ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
              </button>
            ))}
          </div>
          {pinnedEvents.length > 0 && (
            <div className="shrink-0 border-b border-amber/30 bg-amber/[0.03]">
              <div className="label px-2 pt-1 text-amber/80">Pinned ({pinnedEvents.length})</div>
              {pinnedEvents.map((e) => (
                <Row key={`pin-${e.seq}`} e={e} selected={p.selected === e.seq} pinned onSelect={() => p.onSelect(e.seq)} onPin={() => p.onPin(e.seq)} />
              ))}
            </div>
          )}
          <div
            ref={box}
            className="flex-1 min-h-0 overflow-y-auto"
            onScroll={(ev) => {
              const el = ev.currentTarget;
              setTop(el.scrollTop);
              if (auto.current) {
                auto.current = false;
                return;
              }
              if (p.follow && el.scrollTop + el.clientHeight < el.scrollHeight - ROW * 2) p.onScrolledAway();
            }}
          >
            <div style={{ height: p.order.length * ROW, position: "relative" }}>
              <div style={{ position: "absolute", top: first * ROW, left: 0, right: 0 }}>
                {p.order.slice(first, last).map((i) => {
                  const e = p.events[i];
                  return (
                    <Row
                      key={e.seq}
                      e={e}
                      selected={p.selected === e.seq}
                      pinned={p.pinned.includes(e.seq)}
                      onSelect={() => p.onSelect(e.seq)}
                      onPin={() => p.onPin(e.seq)}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
