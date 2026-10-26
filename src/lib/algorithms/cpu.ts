// CPU scheduling simulator (discrete time, 1 unit per tick).
//
// Conventions (stated in the UI):
//  • Lower priority number = higher priority.
//  • A process arriving at time t, a process returning from I/O at t, and a
//    process whose quantum expired at t are queued in that order.
//  • Waiting time = time spent in a ready queue (excludes blocked I/O time).
//  • A context switch is counted each time the CPU starts executing a process
//    different from the one it last executed (the first dispatch is not counted).

export type CpuAlgo = "fcfs" | "sjf" | "srtf" | "priority" | "priority_p" | "rr" | "mlq" | "mlfq";

export interface Proc {
  id: string;
  arrival: number;
  burst: number;
  priority: number;
  /** Multilevel Queue assignment: 0 = system/interactive (RR), 1 = batch (FCFS). */
  queue: number;
  /** Optional single I/O request: after `at` units of CPU, block for `duration`. */
  io?: { at: number; duration: number } | null;
}

export interface CpuOptions {
  quantum: number;
  /** MLQ queue-0 quantum. */
  mlqQuantum: number;
  /** MLFQ quanta for levels 0 and 1; level 2 is FCFS. */
  mlfqQuanta: [number, number];
}

export const DEFAULT_OPTIONS: CpuOptions = { quantum: 2, mlqQuantum: 2, mlfqQuanta: [2, 4] };

export interface Tick {
  t: number;
  running: string | null;
  /** Queue level of the running process (MLQ/MLFQ). */
  level: number | null;
  /** Ready queue(s) in dispatch order. For MLQ/MLFQ one array per level. */
  queues: string[][];
  blocked: string[];
  done: string[];
  events: string[];
}

export interface Segment {
  pid: string | null;
  start: number;
  end: number;
  level?: number;
}

export interface ProcStat {
  id: string;
  arrival: number;
  burst: number;
  completion: number;
  turnaround: number;
  waiting: number;
  response: number;
}

export interface CpuResult {
  ticks: Tick[];
  gantt: Segment[];
  stats: ProcStat[];
  avgWaiting: number;
  avgTurnaround: number;
  avgResponse: number;
  makespan: number;
  throughput: number;
  contextSwitches: number;
  cpuUtilisation: number;
}

export const ALGO_INFO: Record<CpuAlgo, { label: string; preemptive: boolean; uses: ("quantum" | "priority" | "queue")[] }> = {
  fcfs: { label: "FCFS", preemptive: false, uses: [] },
  sjf: { label: "SJF", preemptive: false, uses: [] },
  srtf: { label: "SRTF", preemptive: true, uses: [] },
  priority: { label: "Priority (non-preemptive)", preemptive: false, uses: ["priority"] },
  priority_p: { label: "Priority (preemptive)", preemptive: true, uses: ["priority"] },
  rr: { label: "Round Robin", preemptive: true, uses: ["quantum"] },
  mlq: { label: "Multilevel Queue", preemptive: true, uses: ["queue", "quantum"] },
  mlfq: { label: "Multilevel Feedback Queue", preemptive: true, uses: ["quantum"] },
};

interface PState {
  p: Proc;
  remaining: number;
  executed: number;
  level: number;
  firstRun: number | null;
  completion: number | null;
  ioReturn: number | null;
  waited: number;
}

const MAX_TIME = 10_000;

export function validate(procs: Proc[]): string | null {
  if (!procs.length) return "Add at least one process";
  const ids = new Set<string>();
  for (const p of procs) {
    if (!p.id.trim()) return "Every process needs an ID";
    if (ids.has(p.id)) return `Duplicate process ID ${p.id}`;
    ids.add(p.id);
    if (!Number.isInteger(p.arrival) || p.arrival < 0) return `${p.id}: arrival must be a non-negative integer`;
    if (!Number.isInteger(p.burst) || p.burst < 1) return `${p.id}: burst must be a positive integer`;
    if (p.io && (p.io.at < 1 || p.io.at >= p.burst || p.io.duration < 1)) return `${p.id}: I/O must start after ≥1 and before the last CPU unit, with duration ≥ 1`;
  }
  return null;
}

export function simulate(procs: Proc[], algo: CpuAlgo, opt: CpuOptions = DEFAULT_OPTIONS): CpuResult {
  const err = validate(procs);
  if (err) throw new Error(err);
  const levels = algo === "mlq" ? 2 : algo === "mlfq" ? 3 : 1;
  const st: PState[] = procs.map((p) => ({ p, remaining: p.burst, executed: 0, level: algo === "mlq" ? Math.min(1, Math.max(0, p.queue)) : 0, firstRun: null, completion: null, ioReturn: null, waited: 0 }));
  const queues: PState[][] = Array.from({ length: levels }, () => []);
  // Stable arrival order for tie-breaking: arrival, then input order.
  const order = new Map(st.map((s, i) => [s.p.id, s.p.arrival * 1e6 + i]));

  let running: PState | null = null;
  let slice = 0;
  let requeue: PState | null = null;
  let lastExecuted: string | null = null;
  let switches = 0;
  let busy = 0;
  const ticks: Tick[] = [];
  const events: string[] = [];

  const quantumFor = (s: PState): number | null => {
    if (algo === "rr") return opt.quantum;
    if (algo === "mlq") return s.level === 0 ? opt.mlqQuantum : null;
    if (algo === "mlfq") return s.level < 2 ? opt.mlfqQuanta[s.level] : null;
    return null;
  };

  const pickIndex = (q: PState[]): number => {
    if (!q.length) return -1;
    const best = (key: (s: PState) => number) => {
      let bi = 0;
      for (let i = 1; i < q.length; i++) {
        const a = key(q[i]);
        const b = key(q[bi]);
        if (a < b || (a === b && order.get(q[i].p.id)! < order.get(q[bi].p.id)!)) bi = i;
      }
      return bi;
    };
    switch (algo) {
      case "sjf":
      case "srtf":
        return best((s) => s.remaining);
      case "priority":
      case "priority_p":
        return best((s) => s.p.priority);
      default:
        return 0; // FIFO order of the (level) queue
    }
  };

  const shouldPreempt = (r: PState): boolean => {
    if (algo === "srtf") return queues[0].some((s) => s.remaining < r.remaining);
    if (algo === "priority_p") return queues[0].some((s) => s.p.priority < r.p.priority);
    if (algo === "mlq" || algo === "mlfq") return queues.slice(0, r.level).some((q) => q.length > 0);
    return false;
  };

  const allDone = () => st.every((s) => s.completion != null);

  for (let t = 0; t < MAX_TIME && !allDone(); t++) {
    const ev: string[] = [];
    // 1. arrivals, 2. I/O completions, 3. quantum-expired requeue
    for (const s of st) if (s.p.arrival === t) (queues[s.level].push(s), ev.push(`${s.p.id} arrives`));
    for (const s of st)
      if (s.ioReturn === t) {
        s.ioReturn = null;
        queues[s.level].push(s);
        ev.push(`${s.p.id} I/O complete → ready`);
      }
    if (requeue) {
      queues[requeue.level].push(requeue);
      requeue = null;
    }
    // preemption by a better ready process
    if (running && shouldPreempt(running)) {
      ev.push(`${running.p.id} preempted`);
      queues[running.level].push(running);
      running = null;
    }
    // dispatch
    if (!running) {
      const li = queues.findIndex((q) => q.length > 0);
      if (li >= 0) {
        const i = pickIndex(queues[li]);
        running = queues[li].splice(i, 1)[0];
        slice = 0;
        if (running.firstRun == null) running.firstRun = t;
        if (lastExecuted != null && lastExecuted !== running.p.id) switches++;
        ev.push(`dispatch ${running.p.id}${levels > 1 ? ` (Q${running.level})` : ""}`);
      }
    }
    // everyone still queued waits this tick
    for (const q of queues) for (const s of q) s.waited++;

    const snapshot: Tick = {
      t,
      running: running?.p.id ?? null,
      level: levels > 1 ? running?.level ?? null : null,
      queues: queues.map((q) => q.map((s) => s.p.id)),
      blocked: st.filter((s) => s.ioReturn != null).map((s) => s.p.id),
      done: st.filter((s) => s.completion != null).map((s) => s.p.id),
      events: [...events.splice(0), ...ev],
    };

    if (running) {
      busy++;
      running.remaining--;
      running.executed++;
      slice++;
      lastExecuted = running.p.id;
      const r: PState = running;
      if (r.remaining === 0) {
        r.completion = t + 1;
        events.push(`${r.p.id} completes`);
        running = null;
      } else if (r.p.io && r.executed === r.p.io.at) {
        r.ioReturn = t + 1 + r.p.io.duration;
        events.push(`${r.p.id} blocks for I/O (${r.p.io.duration})`);
        running = null;
      } else {
        const q = quantumFor(r);
        if (q != null && slice >= q) {
          if (algo === "mlfq" && r.level < 2) {
            r.level++;
            events.push(`${r.p.id} quantum expired → demoted to Q${r.level}`);
          } else events.push(`${r.p.id} quantum expired`);
          requeue = r;
          running = null;
        }
      }
    }
    ticks.push(snapshot);
  }
  if (!allDone()) throw new Error("Simulation exceeded 10,000 time units");

  const gantt: Segment[] = [];
  for (const k of ticks) {
    const last = gantt[gantt.length - 1];
    const level = k.level ?? undefined;
    if (last && last.pid === k.running && last.level === level && last.end === k.t) last.end = k.t + 1;
    else gantt.push({ pid: k.running, start: k.t, end: k.t + 1, level });
  }
  const stats: ProcStat[] = st.map((s) => ({
    id: s.p.id,
    arrival: s.p.arrival,
    burst: s.p.burst,
    completion: s.completion!,
    turnaround: s.completion! - s.p.arrival,
    waiting: s.waited,
    response: s.firstRun! - s.p.arrival,
  }));
  const n = stats.length;
  const makespan = Math.max(...stats.map((s) => s.completion));
  const avg = (f: (s: ProcStat) => number) => stats.reduce((a, s) => a + f(s), 0) / n;
  // Final completion events belong to the time after the last tick.
  if (events.length && ticks.length) ticks[ticks.length - 1].events.push(...events);
  return {
    ticks,
    gantt,
    stats,
    avgWaiting: avg((s) => s.waiting),
    avgTurnaround: avg((s) => s.turnaround),
    avgResponse: avg((s) => s.response),
    makespan,
    throughput: n / makespan,
    contextSwitches: switches,
    cpuUtilisation: busy / makespan,
  };
}

export const SAMPLE_PROCS: Proc[] = [
  { id: "P1", arrival: 0, burst: 7, priority: 3, queue: 1 },
  { id: "P2", arrival: 2, burst: 4, priority: 1, queue: 0 },
  { id: "P3", arrival: 4, burst: 1, priority: 4, queue: 0 },
  { id: "P4", arrival: 5, burst: 4, priority: 2, queue: 1 },
];
