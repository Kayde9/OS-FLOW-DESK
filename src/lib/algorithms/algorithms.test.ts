import { describe, expect, it } from "vitest";
import { simulate, SAMPLE_PROCS, type Proc } from "./cpu";
import { allocate, fixedPartitions, pageReplacement, translatePaging, translateSegment } from "./memory";
import { bankerRequest, bankerSafety, detectDeadlock } from "./deadlock";
import { diningPhilosophers, producerConsumer, raceCounter, readersWriters } from "./concurrency";
import { diskSchedule, simulateBuffering } from "./disk";
import { accessCost, metrics, runOps } from "./filesystem";
import { applyTransition, canApply, create, initialModel } from "./process";

const completion = (r: ReturnType<typeof simulate>) => Object.fromEntries(r.stats.map((s) => [s.id, s.completion]));

describe("CPU scheduling", () => {
  it("FCFS", () => {
    const r = simulate(SAMPLE_PROCS, "fcfs");
    expect(completion(r)).toEqual({ P1: 7, P2: 11, P3: 12, P4: 16 });
    expect(r.avgWaiting).toBe(4.75);
    expect(r.avgTurnaround).toBe(8.75);
    expect(r.contextSwitches).toBe(3);
  });
  it("SJF (non-preemptive)", () => {
    const r = simulate(SAMPLE_PROCS, "sjf");
    expect(completion(r)).toEqual({ P1: 7, P3: 8, P2: 12, P4: 16 });
    expect(r.avgWaiting).toBe(4);
  });
  it("SRTF", () => {
    const r = simulate(SAMPLE_PROCS, "srtf");
    expect(completion(r)).toEqual({ P1: 16, P2: 7, P3: 5, P4: 11 });
    expect(r.avgWaiting).toBe(3);
    expect(r.gantt.map((g) => `${g.pid}:${g.start}-${g.end}`)).toEqual(["P1:0-2", "P2:2-4", "P3:4-5", "P2:5-7", "P4:7-11", "P1:11-16"]);
  });
  it("Round Robin q=2 queues arrivals before the preempted process", () => {
    const r = simulate(SAMPLE_PROCS, "rr", { quantum: 2, mlqQuantum: 2, mlfqQuanta: [2, 4] });
    expect(completion(r)).toEqual({ P1: 16, P2: 9, P3: 7, P4: 15 });
  });
  it("Priority (both variants)", () => {
    const np = simulate(SAMPLE_PROCS, "priority");
    expect(completion(np)).toEqual({ P1: 7, P2: 11, P4: 15, P3: 16 });
    const p = simulate(SAMPLE_PROCS, "priority_p");
    // P2 (pri 1) preempts P1 at t=2; P4 (pri 2) runs before P1 (pri 3) resumes.
    expect(completion(p)).toEqual({ P2: 6, P4: 10, P1: 15, P3: 16 });
  });
  it("blocks on I/O and reports idle CPU", () => {
    const r = simulate([{ id: "A", arrival: 0, burst: 4, priority: 1, queue: 0, io: { at: 2, duration: 3 } }], "fcfs");
    expect(r.stats[0].completion).toBe(7);
    expect(r.stats[0].waiting).toBe(0);
    expect(r.cpuUtilisation).toBeCloseTo(4 / 7);
    expect(r.ticks[3].blocked).toEqual(["A"]);
  });
  it("MLFQ demotes through all levels", () => {
    const r = simulate([{ id: "A", arrival: 0, burst: 10, priority: 1, queue: 0 }], "mlfq");
    expect(r.gantt.map((g) => g.level)).toEqual([0, 1, 2]);
    expect(r.gantt.map((g) => g.end - g.start)).toEqual([2, 4, 4]);
  });
  it("MLQ gives queue 0 strict priority", () => {
    const procs: Proc[] = [
      { id: "B", arrival: 0, burst: 5, priority: 1, queue: 1 },
      { id: "S", arrival: 1, burst: 2, priority: 1, queue: 0 },
    ];
    const r = simulate(procs, "mlq");
    expect(completion(r)).toEqual({ S: 3, B: 7 });
  });
  it("rejects invalid input", () => {
    expect(() => simulate([{ id: "X", arrival: 0, burst: 0, priority: 1, queue: 0 }], "fcfs")).toThrow();
  });
});

describe("Memory", () => {
  const refs = [7, 0, 1, 2, 0, 3, 0, 4, 2, 3, 0, 3, 2, 1, 2, 0, 1, 7, 0, 1];
  it("page replacement textbook string, 3 frames", () => {
    expect(pageReplacement(refs, 3, "fifo").faults).toBe(15);
    expect(pageReplacement(refs, 3, "lru").faults).toBe(12);
    expect(pageReplacement(refs, 3, "opt").faults).toBe(9);
  });
  it("Belady's anomaly under FIFO", () => {
    const b = [1, 2, 3, 4, 1, 2, 5, 1, 2, 3, 4, 5];
    expect(pageReplacement(b, 3, "fifo").faults).toBe(9);
    expect(pageReplacement(b, 4, "fifo").faults).toBe(10);
  });
  it("paging translation and faults", () => {
    const r = translatePaging(5000, 1024, [3, 7, null, 2, 9]);
    expect(r.page).toBe(4);
    expect(r.offset).toBe(904);
    expect(r.physical).toBe(9 * 1024 + 904);
    expect(translatePaging(2100, 1024, [3, 7, null]).ok).toBe(false);
  });
  it("segmentation with limit trap", () => {
    const t = [{ base: 1400, limit: 1000 }, { base: 6300, limit: 400 }];
    expect(translateSegment(1, 53, t).physical).toBe(6353);
    expect(translateSegment(1, 400, t).ok).toBe(false);
  });
  it("fixed partitions classic exercise", () => {
    const parts = [100, 500, 200, 300, 600];
    const req = [212, 417, 112, 426];
    expect(fixedPartitions(parts, req, "first").placement.map((p) => p.partition)).toEqual([1, 4, 2, null]);
    expect(fixedPartitions(parts, req, "best").placement.map((p) => p.partition)).toEqual([3, 1, 2, 4]);
    expect(fixedPartitions(parts, req, "worst").placement.map((p) => p.partition)).toEqual([4, 1, 3, null]);
  });
  it("dynamic allocation detects external fragmentation", () => {
    const r = allocate(100, [
      { kind: "alloc", pid: "A", size: 30 },
      { kind: "alloc", pid: "B", size: 30 },
      { kind: "alloc", pid: "C", size: 30 },
      { kind: "free", pid: "A" },
      { kind: "free", pid: "C" },
      { kind: "alloc", pid: "D", size: 50 },
    ], "first");
    expect(r.failed).toBe(1);
    expect(r.steps[5].message).toMatch(/external fragmentation/);
    expect(r.finalFree).toBe(70);
  });
});

describe("Deadlock", () => {
  const avail = [3, 3, 2];
  const max = [[7, 5, 3], [3, 2, 2], [9, 0, 2], [2, 2, 2], [4, 3, 3]];
  const alloc = [[0, 1, 0], [2, 0, 0], [3, 0, 2], [2, 1, 1], [0, 0, 2]];
  it("Banker's safety (Silberschatz example)", () => {
    const r = bankerSafety(avail, max, alloc);
    expect(r.safe).toBe(true);
    expect(r.sequence).toEqual([1, 3, 4, 0, 2]);
  });
  it("resource request algorithm", () => {
    expect(bankerRequest(avail, max, alloc, 1, [1, 0, 2]).granted).toBe(true);
    expect(bankerRequest(avail, max, alloc, 4, [3, 3, 0]).granted).toBe(false);
  });
  it("detects a circular wait", () => {
    const r = detectDeadlock({
      processes: ["P0", "P1"],
      resources: [{ id: "R0", instances: 1 }, { id: "R1", instances: 1 }],
      allocation: [[1, 0], [0, 1]],
      request: [[0, 1], [1, 0]],
    });
    expect(r.deadlocked).toEqual([0, 1]);
    expect(r.cycle?.sort()).toEqual([0, 1]);
  });
});

describe("Concurrency", () => {
  it("producer–consumer never overflows and consumes everything (both mechanisms)", () => {
    for (const mode of ["semaphore", "monitor"] as const) {
      const r = producerConsumer({ bufferSize: 2, producers: 2, consumers: 3, items: 6, mode, seed: 11 });
      expect(r.finished).toBe(true);
      expect(r.violations).toBe(0);
      expect(r.shared.consumed).toBe(12);
      expect(r.shared.maxFill).toBeLessThanOrEqual(2);
    }
  });
  it("readers–writers keeps mutual exclusion", () => {
    for (const preference of ["readers", "writers"] as const) {
      const r = readersWriters({ readers: 3, writers: 2, iterations: 3, preference, seed: 5 });
      expect(r.finished).toBe(true);
      expect(r.violations).toBe(0);
      expect(r.shared.writes).toBe(6);
      expect(r.shared.reads).toBe(9);
    }
  });
  it("naive dining philosophers deadlock under lock-step scheduling; ordered/waiter do not", () => {
    expect(diningPhilosophers({ n: 5, meals: 2, strategy: "naive", sched: "round_robin", seed: 1 }).deadlock).toBe(true);
    for (const strategy of ["ordered", "waiter"] as const) {
      const r = diningPhilosophers({ n: 5, meals: 2, strategy, sched: "round_robin", seed: 1 });
      expect(r.finished).toBe(true);
      expect(r.violations).toBe(0);
    }
  });
  it("unprotected counter loses updates; guarded ones do not", () => {
    expect(raceCounter({ threads: 3, increments: 5, guard: "none", sched: "round_robin", seed: 1 }).lost).toBeGreaterThan(0);
    for (const guard of ["mutex", "semaphore", "monitor"] as const) expect(raceCounter({ threads: 3, increments: 5, guard, sched: "random", seed: 3 }).lost).toBe(0);
  });
});

describe("Disk", () => {
  const req = [98, 183, 37, 122, 14, 124, 65, 67];
  const o = { cylinders: 200, direction: "up" as const, countWrap: true };
  it("textbook head movement", () => {
    expect(diskSchedule(req, 53, "fcfs", o).movement).toBe(640);
    expect(diskSchedule(req, 53, "sstf", o).movement).toBe(236);
    expect(diskSchedule(req, 53, "scan", { ...o, direction: "down" }).movement).toBe(236);
    expect(diskSchedule(req, 53, "scan", o).movement).toBe(331);
    expect(diskSchedule(req, 53, "cscan", o).movement).toBe(382);
    expect(diskSchedule(req, 53, "cscan", { ...o, countWrap: false }).movement).toBe(183);
    expect(diskSchedule(req, 53, "look", o).movement).toBe(299);
    expect(diskSchedule(req, 53, "clook", o).movement).toBe(322);
  });
  it("buffering: double ≈ max(C+M, T) per block, single ≈ max(C, T) + M", () => {
    const n = 50;
    const single = simulateBuffering(n, 10, 2, [6], "single");
    const dbl = simulateBuffering(n, 10, 2, [6], "double");
    const none = simulateBuffering(n, 10, 2, [6], "none");
    expect(none.total).toBe(n * 16);
    expect(single.perBlock).toBeCloseTo(12, 0);
    expect(dbl.perBlock).toBeCloseTo(10, 0);
  });
});

describe("File allocation", () => {
  it("contiguous fails on fragmentation where linked/indexed succeed", () => {
    const ops = [
      { kind: "create" as const, name: "a", size: 4 },
      { kind: "create" as const, name: "b", size: 4 },
      { kind: "create" as const, name: "c", size: 4 },
      { kind: "delete" as const, name: "a" },
      { kind: "delete" as const, name: "c" },
      { kind: "create" as const, name: "d", size: 6 },
    ];
    expect(runOps("contiguous", 12, ops)[5].ok).toBe(false);
    const linked = runOps("linked", 12, ops);
    expect(linked[5].ok).toBe(true);
    expect(linked[5].state.files.find((f) => f.name === "d")!.blocks).toEqual([0, 1, 2, 3, 8, 9]);
    const idx = runOps("indexed", 12, ops)[5];
    expect(idx.ok).toBe(true);
    expect(metrics(idx.state).overhead).toBe(2);
    expect(accessCost("linked", 5)).toBe(6);
  });
});

describe("Process model", () => {
  it("enforces legal transitions and a single running process", () => {
    let m = create(initialModel(), "a", 1);
    m = create(m, "b", 1);
    m = applyTransition(m, 100, "admit");
    m = applyTransition(m, 101, "admit");
    m = applyTransition(m, 100, "dispatch");
    expect(canApply(m, 101, "dispatch")).toMatch(/busy/);
    expect(canApply(m, 101, "wake")).toMatch(/requires/);
    m = applyTransition(m, 100, "wait", "disk");
    m = applyTransition(m, 101, "dispatch");
    expect(m.procs.map((p) => p.state)).toEqual(["waiting", "running"]);
  });
});
