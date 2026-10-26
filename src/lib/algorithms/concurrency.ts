// A tiny deterministic thread interpreter with counting semaphores, mutexes and
// Mesa-style monitors (condition variables). Classic synchronisation problems
// are expressed as instruction lists and executed one instruction per step
// under a seeded interleaving, so every run is reproducible.

type Shared = Record<string, any>;
type Locals = Record<string, any>;

export type Instr =
  | { op: "wait"; s: string }
  | { op: "signal"; s: string }
  | { op: "lock"; m: string }
  | { op: "unlock"; m: string }
  | { op: "cwait"; c: string; m: string }
  | { op: "csignal"; c: string }
  | { op: "act"; label: string; run: (sh: Shared, me: Locals, tid: number) => void }
  | { op: "jmp"; to: number }
  /** Jump when `cond` is true; otherwise fall through. Control flow costs no step. */
  | { op: "jif"; cond: (sh: Shared, me: Locals) => boolean; to: number }
  | { op: "end" };

export interface ThreadDef {
  name: string;
  prog: Instr[];
  locals?: Locals;
}

export type ThreadState = "ready" | "blocked" | "done";

export interface SimStep {
  step: number;
  thread: number;
  action: string;
  states: ThreadState[];
  blockedOn: (string | null)[];
  sems: Record<string, number>;
  mutexes: Record<string, number | null>;
  shared: Shared;
  violation: string | null;
}

export interface SimResult {
  steps: SimStep[];
  deadlock: boolean;
  finished: boolean;
  shared: Shared;
  threads: string[];
  violations: number;
}

export type SchedMode = "random" | "round_robin";

function lcg(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function runThreads(opts: {
  threads: ThreadDef[];
  shared: Shared;
  sems?: Record<string, number>;
  mutexes?: string[];
  conds?: string[];
  seed?: number;
  sched?: SchedMode;
  maxSteps?: number;
  invariant?: (sh: Shared) => string | null;
  snapshot?: (sh: Shared) => Shared;
}): SimResult {
  const rnd = lcg(opts.seed ?? 7);
  const sh = opts.shared;
  const snap = opts.snapshot ?? ((x: Shared) => structuredClone(x));
  const sems = new Map(Object.entries(opts.sems ?? {}).map(([k, v]) => [k, { value: v, queue: [] as number[] }]));
  const mutexes = new Map((opts.mutexes ?? []).map((m) => [m, { owner: null as number | null, queue: [] as number[] }]));
  const conds = new Map((opts.conds ?? []).map((c) => [c, { queue: [] as { tid: number; m: string }[] }]));
  const th = opts.threads.map((t) => ({ name: t.name, prog: t.prog, pc: 0, state: "ready" as ThreadState, on: null as string | null, locals: { ...(t.locals ?? {}) } }));
  const steps: SimStep[] = [];
  let rr = 0;
  let violations = 0;
  const max = opts.maxSteps ?? 4000;

  const acquire = (tid: number, m: string) => {
    const mx = mutexes.get(m)!;
    if (mx.owner == null) {
      mx.owner = tid;
      th[tid].state = "ready";
      th[tid].on = null;
    } else {
      mx.queue.push(tid);
      th[tid].state = "blocked";
      th[tid].on = m;
    }
  };
  const release = (tid: number, m: string) => {
    const mx = mutexes.get(m)!;
    if (mx.owner !== tid) throw new Error(`${th[tid].name} unlocked ${m} without owning it`);
    const next = mx.queue.shift();
    mx.owner = next ?? null;
    if (next != null) {
      th[next].state = "ready";
      th[next].on = null;
    }
  };

  // Skip control-flow instructions so each step is one meaningful action.
  const settle = (t: (typeof th)[number]) => {
    for (let guard = 0; guard < 1000; guard++) {
      const ins = t.prog[t.pc];
      if (!ins || ins.op === "end") {
        t.state = "done";
        return;
      }
      if (ins.op === "jmp") t.pc = ins.to;
      else if (ins.op === "jif") t.pc = ins.cond(sh, t.locals) ? ins.to : t.pc + 1;
      else return;
    }
    throw new Error(`${t.name}: control-flow loop without an action`);
  };
  th.forEach(settle);

  for (let step = 0; step < max; step++) {
    const runnable = th.map((t, i) => (t.state === "ready" ? i : -1)).filter((i) => i >= 0);
    if (!runnable.length) break;
    let tid: number;
    if (opts.sched === "round_robin") {
      tid = runnable.find((i) => i >= rr % th.length) ?? runnable[0];
      rr = tid + 1;
    } else tid = runnable[Math.floor(rnd() * runnable.length)];
    const t = th[tid];
    const ins = t.prog[t.pc];
    let action = "";
    switch (ins.op) {
      case "wait": {
        const s = sems.get(ins.s)!;
        if (s.value > 0) {
          s.value--;
          action = `wait(${ins.s}) → proceeds`;
        } else {
          s.queue.push(tid);
          t.state = "blocked";
          t.on = ins.s;
          action = `wait(${ins.s}) → blocks`;
        }
        t.pc++;
        break;
      }
      case "signal": {
        const s = sems.get(ins.s)!;
        const next = s.queue.shift();
        if (next != null) {
          th[next].state = "ready";
          th[next].on = null;
          action = `signal(${ins.s}) → wakes ${th[next].name}`;
        } else {
          s.value++;
          action = `signal(${ins.s})`;
        }
        t.pc++;
        break;
      }
      case "lock":
        acquire(tid, ins.m);
        action = t.state === "blocked" ? `lock(${ins.m}) → blocks` : `lock(${ins.m})`;
        t.pc++;
        break;
      case "unlock":
        release(tid, ins.m);
        action = `unlock(${ins.m})`;
        t.pc++;
        break;
      case "cwait":
        release(tid, ins.m);
        conds.get(ins.c)!.queue.push({ tid, m: ins.m });
        t.state = "blocked";
        t.on = ins.c;
        action = `wait(${ins.c}) → releases ${ins.m}, sleeps`;
        t.pc++;
        break;
      case "csignal": {
        const w = conds.get(ins.c)!.queue.shift();
        if (w) {
          acquire(w.tid, w.m); // Mesa: the woken thread must re-acquire the monitor lock
          action = `signal(${ins.c}) → ${th[w.tid].name} re-enters monitor queue`;
        } else action = `signal(${ins.c}) → no waiter`;
        t.pc++;
        break;
      }
      case "act":
        ins.run(sh, t.locals, tid);
        action = ins.label;
        t.pc++;
        break;
      default:
        break;
    }
    if (t.state !== "blocked") settle(t);
    const violation = opts.invariant ? opts.invariant(sh) : null;
    if (violation) violations++;
    steps.push({
      step,
      thread: tid,
      action,
      states: th.map((x) => x.state),
      blockedOn: th.map((x) => x.on),
      sems: Object.fromEntries([...sems].map(([k, v]) => [k, v.value])),
      mutexes: Object.fromEntries([...mutexes].map(([k, v]) => [k, v.owner])),
      shared: snap(sh),
      violation,
    });
  }
  const finished = th.every((t) => t.state === "done");
  return { steps, deadlock: !finished && th.every((t) => t.state !== "ready"), finished, shared: sh, threads: th.map((t) => t.name), violations };
}

// ------------------------------------------------------------ producer–consumer

export function producerConsumer(o: { bufferSize: number; producers: number; consumers: number; items: number; mode: "semaphore" | "monitor"; seed: number }): SimResult {
  const total = o.producers * o.items;
  const quota = (c: number) => Math.floor(total / o.consumers) + (c < total % o.consumers ? 1 : 0);
  const sh: Shared = { buffer: [] as string[], produced: 0, consumed: 0, maxFill: 0 };
  const put = (label: string): Instr => ({
    op: "act",
    label,
    run: (s, me) => {
      s.buffer.push(me.item);
      s.produced++;
      s.maxFill = Math.max(s.maxFill, s.buffer.length);
    },
  });
  const take: Instr = { op: "act", label: "remove item", run: (s, me) => ((me.got = s.buffer.shift()), s.consumed++, me.n++) };
  const make = (p: number): Instr => ({ op: "act", label: "produce item", run: (_s, me) => ((me.item = `P${p}:${me.n + 1}`), me.n++) });

  const threads: ThreadDef[] = [];
  for (let p = 0; p < o.producers; p++) {
    const prog: Instr[] =
      o.mode === "semaphore"
        ? [
            { op: "jif", cond: (_s, me) => me.n >= o.items, to: 8 },
            make(p),
            { op: "wait", s: "empty" },
            { op: "wait", s: "mutex" },
            put("insert into buffer"),
            { op: "signal", s: "mutex" },
            { op: "signal", s: "full" },
            { op: "jmp", to: 0 },
            { op: "end" },
          ]
        : [
            { op: "jif", cond: (_s, me) => me.n >= o.items, to: 10 },
            make(p),
            { op: "lock", m: "monitor" },
            { op: "jif", cond: (s) => s.buffer.length < o.bufferSize, to: 6 },
            { op: "cwait", c: "notFull", m: "monitor" },
            { op: "jmp", to: 3 },
            put("insert into buffer"),
            { op: "csignal", c: "notEmpty" },
            { op: "unlock", m: "monitor" },
            { op: "jmp", to: 0 },
            { op: "end" },
          ];
    threads.push({ name: `Producer ${p}`, prog, locals: { n: 0 } });
  }
  for (let c = 0; c < o.consumers; c++) {
    const q = quota(c);
    const prog: Instr[] =
      o.mode === "semaphore"
        ? [
            { op: "jif", cond: (_s, me) => me.n >= q, to: 8 },
            { op: "wait", s: "full" },
            { op: "wait", s: "mutex" },
            take,
            { op: "signal", s: "mutex" },
            { op: "signal", s: "empty" },
            { op: "act", label: "consume item", run: () => {} },
            { op: "jmp", to: 0 },
            { op: "end" },
          ]
        : [
            { op: "jif", cond: (_s, me) => me.n >= q, to: 10 },
            { op: "lock", m: "monitor" },
            { op: "jif", cond: (s) => s.buffer.length > 0, to: 5 },
            { op: "cwait", c: "notEmpty", m: "monitor" },
            { op: "jmp", to: 2 },
            take,
            { op: "csignal", c: "notFull" },
            { op: "unlock", m: "monitor" },
            { op: "act", label: "consume item", run: () => {} },
            { op: "jmp", to: 0 },
            { op: "end" },
          ];
    threads.push({ name: `Consumer ${c}`, prog, locals: { n: 0 } });
  }
  return runThreads({
    threads,
    shared: sh,
    sems: o.mode === "semaphore" ? { empty: o.bufferSize, full: 0, mutex: 1 } : {},
    mutexes: o.mode === "monitor" ? ["monitor"] : [],
    conds: o.mode === "monitor" ? ["notFull", "notEmpty"] : [],
    seed: o.seed,
    invariant: (s) => (s.buffer.length > o.bufferSize ? "buffer overflow" : null),
  });
}

// ------------------------------------------------------------ readers–writers

type AsmItem = Instr | { mark: string } | { op: "jmp"; to: string } | { op: "jif"; cond: (sh: Shared, me: Locals) => boolean; to: string };

/** Resolves string jump targets to instruction indices. */
function assemble(items: AsmItem[]): Instr[] {
  const marks = new Map<string, number>();
  let n = 0;
  for (const it of items) {
    if ("mark" in it) marks.set(it.mark, n);
    else n++;
  }
  return items
    .filter((it): it is Exclude<AsmItem, { mark: string }> => !("mark" in it))
    .map((it) => {
      if ((it.op === "jmp" || it.op === "jif") && typeof it.to === "string") {
        const to = marks.get(it.to);
        if (to == null) throw new Error(`unknown label ${it.to}`);
        return { ...it, to } as Instr;
      }
      return it as Instr;
    });
}

export function readersWriters(o: { readers: number; writers: number; iterations: number; preference: "readers" | "writers"; seed: number }): SimResult {
  const sh: Shared = { readcount: 0, writecount: 0, activeReaders: 0, activeWriters: 0, reads: 0, writes: 0, maxReaders: 0, value: 0 };
  const startRead: Instr = { op: "act", label: "start reading", run: (s) => ((s.activeReaders++), (s.maxReaders = Math.max(s.maxReaders, s.activeReaders))) };
  const endRead: Instr = { op: "act", label: "finish reading", run: (s, me) => ((s.activeReaders--), s.reads++, me.n++) };
  const startWrite: Instr = { op: "act", label: "start writing", run: (s) => s.activeWriters++ };
  const endWrite: Instr = { op: "act", label: "finish writing", run: (s, me) => ((s.activeWriters--), s.writes++, s.value++, me.n++) };
  const inc = (k: string): Instr => ({ op: "act", label: `${k}++`, run: (s) => s[k]++ });
  const dec = (k: string): Instr => ({ op: "act", label: `${k}--`, run: (s) => s[k]-- });
  const W = (s: string): Instr => ({ op: "wait", s });
  const S = (s: string): Instr => ({ op: "signal", s });
  const done = { op: "jif" as const, cond: (_s: Shared, me: Locals) => me.n >= o.iterations, to: "END" };

  let reader: Instr[];
  let writer: Instr[];
  if (o.preference === "readers") {
    reader = assemble([
      { mark: "TOP" }, done,
      W("mutex"), inc("readcount"),
      { op: "jif", cond: (s) => s.readcount !== 1, to: "R1" }, W("rw"),
      { mark: "R1" }, S("mutex"),
      startRead, endRead,
      W("mutex"), dec("readcount"),
      { op: "jif", cond: (s) => s.readcount !== 0, to: "R2" }, S("rw"),
      { mark: "R2" }, S("mutex"),
      { op: "jmp", to: "TOP" },
      { mark: "END" }, { op: "end" },
    ]);
    writer = assemble([{ mark: "TOP" }, done, W("rw"), startWrite, endWrite, S("rw"), { op: "jmp", to: "TOP" }, { mark: "END" }, { op: "end" }]);
  } else {
    reader = assemble([
      { mark: "TOP" }, done,
      W("readTry"), W("rmutex"), inc("readcount"),
      { op: "jif", cond: (s) => s.readcount !== 1, to: "R1" }, W("resource"),
      { mark: "R1" }, S("rmutex"), S("readTry"),
      startRead, endRead,
      W("rmutex"), dec("readcount"),
      { op: "jif", cond: (s) => s.readcount !== 0, to: "R2" }, S("resource"),
      { mark: "R2" }, S("rmutex"),
      { op: "jmp", to: "TOP" },
      { mark: "END" }, { op: "end" },
    ]);
    writer = assemble([
      { mark: "TOP" }, done,
      W("wmutex"), inc("writecount"),
      { op: "jif", cond: (s) => s.writecount !== 1, to: "W1" }, W("readTry"),
      { mark: "W1" }, S("wmutex"),
      W("resource"), startWrite, endWrite, S("resource"),
      W("wmutex"), dec("writecount"),
      { op: "jif", cond: (s) => s.writecount !== 0, to: "W2" }, S("readTry"),
      { mark: "W2" }, S("wmutex"),
      { op: "jmp", to: "TOP" },
      { mark: "END" }, { op: "end" },
    ]);
  }
  const threads: ThreadDef[] = [];
  for (let i = 0; i < o.readers; i++) threads.push({ name: `Reader ${i}`, prog: reader, locals: { n: 0 } });
  for (let i = 0; i < o.writers; i++) threads.push({ name: `Writer ${i}`, prog: writer, locals: { n: 0 } });
  return runThreads({
    threads,
    shared: sh,
    sems: o.preference === "readers" ? { mutex: 1, rw: 1 } : { rmutex: 1, wmutex: 1, readTry: 1, resource: 1 },
    seed: o.seed,
    invariant: (s) =>
      s.activeWriters > 1 ? "two writers active" : s.activeWriters > 0 && s.activeReaders > 0 ? "reader and writer active together" : null,
  });
}

// ------------------------------------------------------------ dining philosophers

export type DiningStrategy = "naive" | "ordered" | "waiter";

export function diningPhilosophers(o: { n: number; meals: number; strategy: DiningStrategy; sched: SchedMode; seed: number }): SimResult {
  const sh: Shared = { meals: new Array(o.n).fill(0), eating: new Array(o.n).fill(false) };
  const forks = Array.from({ length: o.n }, (_, i) => `fork${i}`);
  const threads: ThreadDef[] = [];
  for (let i = 0; i < o.n; i++) {
    const left = i;
    const right = (i + 1) % o.n;
    const [a, b] = o.strategy === "ordered" ? [Math.min(left, right), Math.max(left, right)] : [left, right];
    const eat: Instr = { op: "act", label: "eat", run: (s) => ((s.eating[i] = true), s.meals[i]++) };
    const done: Instr = { op: "act", label: "put down forks", run: (s, me) => ((s.eating[i] = false), me.n++) };
    const think: Instr = { op: "act", label: "think", run: () => {} };
    const body: Instr[] = [think, { op: "lock", m: forks[a] }, { op: "lock", m: forks[b] }, eat, done, { op: "unlock", m: forks[b] }, { op: "unlock", m: forks[a] }];
    const prog: Instr[] =
      o.strategy === "waiter"
        ? [{ op: "jif", cond: (_s, me) => me.n >= o.meals, to: 11 }, body[0], { op: "wait", s: "room" }, ...body.slice(1), { op: "signal", s: "room" }, { op: "jmp", to: 0 }, { op: "end" }]
        : [{ op: "jif", cond: (_s, me) => me.n >= o.meals, to: 9 }, ...body, { op: "jmp", to: 0 }, { op: "end" }];
    threads.push({ name: `Philosopher ${i}`, prog, locals: { n: 0 } });
  }
  return runThreads({
    threads,
    shared: sh,
    mutexes: forks,
    sems: o.strategy === "waiter" ? { room: o.n - 1 } : {},
    seed: o.seed,
    sched: o.sched,
    invariant: (s) => {
      for (let i = 0; i < o.n; i++) if (s.eating[i] && s.eating[(i + 1) % o.n]) return `neighbours ${i} and ${(i + 1) % o.n} eating together`;
      return null;
    },
  });
}

// ------------------------------------------------------------ race condition / primitives

export type Guard = "none" | "mutex" | "semaphore" | "monitor";

export function raceCounter(o: { threads: number; increments: number; guard: Guard; sched: SchedMode; seed: number }): SimResult & { expected: number; final: number; lost: number } {
  const sh: Shared = { counter: 0 };
  const load: Instr = { op: "act", label: "load counter → register", run: (s, me) => (me.reg = s.counter) };
  const addI: Instr = { op: "act", label: "register + 1", run: (_s, me) => me.reg++ };
  const store: Instr = { op: "act", label: "store register → counter", run: (s, me) => ((s.counter = me.reg), me.n++) };
  const enter: Instr | null = o.guard === "mutex" ? { op: "lock", m: "m" } : o.guard === "monitor" ? { op: "lock", m: "monitor" } : o.guard === "semaphore" ? { op: "wait", s: "s" } : null;
  const exit: Instr | null = o.guard === "mutex" ? { op: "unlock", m: "m" } : o.guard === "monitor" ? { op: "unlock", m: "monitor" } : o.guard === "semaphore" ? { op: "signal", s: "s" } : null;
  const crit = [enter, load, addI, store, exit].filter(Boolean) as Instr[];
  const prog: Instr[] = [{ op: "jif", cond: (_s, me) => me.n >= o.increments, to: crit.length + 2 }, ...crit, { op: "jmp", to: 0 }, { op: "end" }];
  const r = runThreads({
    threads: Array.from({ length: o.threads }, (_, i) => ({ name: `T${i}`, prog, locals: { n: 0, reg: 0 } })),
    shared: sh,
    sems: o.guard === "semaphore" ? { s: 1 } : {},
    mutexes: o.guard === "mutex" ? ["m"] : o.guard === "monitor" ? ["monitor"] : [],
    seed: o.seed,
    sched: o.sched,
    maxSteps: 20000,
  });
  const expected = o.threads * o.increments;
  return { ...r, expected, final: sh.counter, lost: expected - sh.counter };
}
