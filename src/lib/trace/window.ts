// Bounded in-memory event window for the live view. Older events are dropped
// from memory only; every event is still in SQLite and reloads on reopen.

import type { Completion, TraceEvent } from "./types";

export interface EventWindow {
  events: TraceEvent[];
  bySeq: Map<number, number>;
  /** Events dropped from memory because the window was full. */
  dropped: number;
}

export const newWindow = (): EventWindow => ({ events: [], bySeq: new Map(), dropped: 0 });

export function appendWindow(w: EventWindow, batch: TraceEvent[], cap: number) {
  for (const e of batch) w.events.push(e);
  if (w.events.length > cap) {
    const cut = w.events.length - cap;
    w.events.splice(0, cut);
    w.dropped += cut;
    w.bySeq.clear();
    w.events.forEach((e, i) => w.bySeq.set(e.seq, i));
  } else {
    for (let i = w.events.length - batch.length; i < w.events.length; i++) w.bySeq.set(w.events[i].seq, i);
  }
}

/** Applies IRP-matched completions to events still in the window. Returns how many applied. */
export function applyCompletions(w: EventWindow, comps: Completion[]): number {
  let n = 0;
  for (const c of comps) {
    const i = w.bySeq.get(c.seq);
    if (i == null) continue;
    const e = w.events[i];
    w.events[i] = {
      ...e,
      durationUs: c.durationUs,
      status: c.status,
      resultCode: c.resultCode,
      fields: c.extraInformation != null ? { ...e.fields, completionExtraInformation: c.extraInformation } : e.fields,
    };
    n++;
  }
  return n;
}
