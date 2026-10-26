import { describe, expect, it } from "vitest";
import {
  buildLanes,
  clockUs,
  countBy,
  durationHistogram,
  emptyFilter,
  filterIdx,
  histogram,
  nearest,
  operationStats,
  percentile,
  related,
  sortIdx,
  step,
} from "./analysis";
import { synthetic } from "./synthetic";
import { applyCompletions, appendWindow } from "./window";

// All events below come from the labelled synthetic generator (tests only).
const evs = synthetic(40);

describe("trace filtering", () => {
  it("filters by text, category, pid, time range and problems", () => {
    const all = filterIdx(evs, emptyFilter());
    expect(all.length).toBe(40);
    expect(filterIdx(evs, { ...emptyFilter(), categories: new Set(["workload"]) }).every((i) => evs[i].source === "flowdesk")).toBe(true);
    expect(filterIdx(evs, { ...emptyFilter(), text: "file3.bin" }).every((i) => evs[i].filePath?.endsWith("file3.bin"))).toBe(true);
    expect(filterIdx(evs, { ...emptyFilter(), tid: 101 }).every((i) => evs[i].tid === 101)).toBe(true);
    const r = filterIdx(evs, { ...emptyFilter(), range: [evs[10].tsUs, evs[19].tsUs] });
    expect(r).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const problems = filterIdx(evs, { ...emptyFilter(), problemsOnly: true });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((i) => evs[i].status === "error")).toBe(true);
  });

  it("sorts with missing values last in both directions", () => {
    const idx = filterIdx(evs, emptyFilter());
    for (const dir of [1, -1] as const) {
      const s = sortIdx(evs, idx, "duration", dir);
      const firstMissing = s.findIndex((i) => evs[i].durationUs == null);
      expect(s.slice(firstMissing).every((i) => evs[i].durationUs == null)).toBe(true);
      const known = s.slice(0, firstMissing).map((i) => evs[i].durationUs!);
      expect(known).toEqual(known.slice().sort((a, b) => (a - b) * dir));
    }
    const t = sortIdx(evs, idx.slice().reverse(), "time", 1);
    expect(t).toEqual(idx);
  });
});

describe("trace statistics", () => {
  it("computes per-operation counts and nearest-rank percentiles from matched durations only", () => {
    const ops = operationStats(evs, filterIdx(evs, emptyFilter()));
    const read = ops.find((o) => o.operation === "Read")!;
    const withDur = evs.filter((e) => e.operation === "Read" && e.durationUs != null).map((e) => e.durationUs!).sort((a, b) => a - b);
    expect(read.matched).toBe(withDur.length);
    expect(read.unmatched).toBe(evs.filter((e) => e.operation === "Read" && e.awaitsCompletion && e.durationUs == null).length);
    expect(read.p50).toBe(percentile(withDur, 50));
    expect(read.max).toBe(withDur[withDur.length - 1]);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([], 95)).toBeNull();
  });

  it("bins frequency and durations", () => {
    const idx = filterIdx(evs, emptyFilter());
    const h = histogram(evs, idx, evs[0].tsUs, evs[39].tsUs, 4);
    expect(h.reduce((a, b) => a + b, 0)).toBe(40);
    const d = durationHistogram(evs, idx);
    expect(d.reduce((a, b) => a + b, 0)).toBe(evs.filter((e) => e.durationUs != null).length);
    expect(countBy(evs, idx, (e) => e.category)[0][1]).toBeGreaterThan(0);
  });

  it("builds one lane per thread and finds related events", () => {
    const lanes = buildLanes(evs, filterIdx(evs, emptyFilter()));
    expect(new Set(lanes.map((l) => l.key)).size).toBe(lanes.length);
    expect(lanes.reduce((a, l) => a + l.count, 0)).toBe(40);
    expect(lanes.some((l) => l.label.startsWith("flowdesk-worker"))).toBe(true);
    const rel = related(evs, evs[5], 5);
    expect(rel.length).toBe(5);
    expect(rel.every((e) => e.tid === evs[5].tid || e.filePath === evs[5].filePath)).toBe(true);
  });

  it("steps through matches and picks nearest telemetry", () => {
    expect(step([3, 7, 9], -1, 1)).toBe(0);
    expect(step([3, 7, 9], 2, 1)).toBeNull();
    expect(step([3, 7, 9], 1, -1)).toBe(0);
    const s = [{ ts: 1000 }, { ts: 2000 }, { ts: 3000 }, { ts: 4000 }];
    expect(nearest(s, 2400, 2).map((x) => x.ts)).toEqual([2000, 3000]);
    expect(clockUs(Date.UTC(2026, 0, 1) * 1000 + 123_456)).toMatch(/\.123456$/);
  });
});

describe("live window", () => {
  it("patches completions by seq and stays bounded", () => {
    const fresh = synthetic(10).map((e) => ({ ...e, durationUs: undefined, status: undefined, resultCode: undefined }));
    const w = { events: [] as typeof fresh, bySeq: new Map<number, number>(), dropped: 0 };
    appendWindow(w, fresh, 6);
    expect(w.events.length).toBeLessThanOrEqual(6);
    expect(w.dropped).toBe(4);
    const lastSeq = w.events[w.events.length - 1].seq;
    const n = applyCompletions(w, [
      { seq: lastSeq, endUs: 0, durationUs: 42, status: "success", resultCode: "0x00000000 STATUS_SUCCESS" },
      { seq: fresh[0].seq, endUs: 0, durationUs: 1, status: "success", resultCode: "x" }, // dropped from window
    ]);
    expect(n).toBe(1);
    expect(w.events[w.events.length - 1].durationUs).toBe(42);
    expect(w.events.every((e, i) => w.bySeq.get(e.seq) === i)).toBe(true);
  });
});
