import { useMemo, useState } from "react";
import { Seg } from "../../components/industrial/Panel";
import { diningPhilosophers, producerConsumer, raceCounter, readersWriters, type DiningStrategy, type Guard, type SchedMode, type SimResult } from "../../lib/algorithms/concurrency";
import { Chip, entityColor, LabFrame, Metric, NumField, StepControls, useStepper } from "./primitives";

type Topic = "pc" | "rw" | "dining" | "race";

export default function ConcurrencyLab() {
  const [topic, setTopic] = useState<Topic>("pc");
  return (
    <div className="flex flex-col gap-3">
      <Seg
        label="Concurrency topic"
        value={topic}
        onChange={setTopic}
        options={[
          { value: "pc", label: "Producer–Consumer" },
          { value: "rw", label: "Readers–Writers" },
          { value: "dining", label: "Dining Philosophers" },
          { value: "race", label: "Semaphores · Mutex · Monitor" },
        ]}
      />
      {topic === "pc" && <ProducerConsumer />}
      {topic === "rw" && <ReadersWriters />}
      {topic === "dining" && <Dining />}
      {topic === "race" && <Race />}
    </div>
  );
}

/** Thread state lanes + action log shared by every concurrency view. */
function Trace({ r, i, extra }: { r: SimResult; i: number; extra?: React.ReactNode }) {
  const step = r.steps[i];
  if (!step) return <div className="text-ink-3 text-[12px]">No steps executed.</div>;
  return (
    <>
      <div className="grid grid-cols-[1fr_320px] gap-4">
        <div className="flex flex-col gap-1">
          {r.threads.map((name, t) => (
            <div key={t} className={`flex items-center gap-2 h-7 px-2 rounded-sm ${step.thread === t ? "bg-amber/[0.08] border border-amber/40" : "border border-transparent"}`}>
              <span className="w-2 h-2 rounded-full" style={{ background: entityColor(name, r.threads) }} />
              <span className="text-[12px] w-[110px]">{name}</span>
              <span className={`text-micro uppercase w-[64px] ${step.states[t] === "blocked" ? "text-amber" : step.states[t] === "done" ? "text-ok" : "text-ink-3"}`}>{step.states[t]}</span>
              <span className="text-[11px] text-ink-3 truncate">{step.blockedOn[t] ? `on ${step.blockedOn[t]}` : step.thread === t ? step.action : ""}</span>
            </div>
          ))}
        </div>
        <div className="recess p-2 h-[220px] overflow-auto text-[11.5px]">
          <div className="label mb-1">Trace</div>
          {r.steps
            .slice(Math.max(0, i - 40), i + 1)
            .reverse()
            .map((s) => (
              <div key={s.step} className={`flex gap-2 ${s.violation ? "text-alert" : ""}`}>
                <span className="readout text-ink-3 w-8 text-right">{s.step}</span>
                <span className="text-ink-2 w-[86px] truncate">{r.threads[s.thread]}</span>
                <span className="truncate">{s.action}{s.violation ? ` ⚠ ${s.violation}` : ""}</span>
              </div>
            ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        {Object.entries(step.sems).map(([k, v]) => <Chip key={k}>{k} = {v}</Chip>)}
        {Object.entries(step.mutexes).map(([k, v]) => <Chip key={k} title="lock owner">{k}: {v == null ? "free" : r.threads[v]}</Chip>)}
        {extra}
      </div>
    </>
  );
}

function Outcome({ r }: { r: SimResult }) {
  return (
    <Metric
      label="Outcome"
      value={<span className={r.deadlock ? "text-alert" : r.finished ? "text-ok" : "text-amber"}>{r.deadlock ? "DEADLOCK" : r.finished ? "completed" : "step limit"}</span>}
      sub={`${r.steps.length} steps · ${r.violations} invariant violations`}
    />
  );
}

function ProducerConsumer() {
  const [o, setO] = useState({ bufferSize: 3, producers: 2, consumers: 2, items: 5, mode: "semaphore" as "semaphore" | "monitor", seed: 7 });
  const r = useMemo(() => producerConsumer(o), [o]);
  const s = useStepper(r.steps.length);
  const step = r.steps[s.i];
  const buf: string[] = step?.shared.buffer ?? [];
  return (
    <LabFrame
      title="Bounded-Buffer Producer–Consumer"
      code="Y1"
      config={
        <div className="flex flex-wrap gap-3 items-end">
          <Seg label="Mechanism" value={o.mode} onChange={(mode) => setO({ ...o, mode })} options={[{ value: "semaphore", label: "Semaphores" }, { value: "monitor", label: "Monitor (Mesa)" }]} />
          <NumField label="Buffer size" value={o.bufferSize} min={1} max={10} onChange={(bufferSize) => setO({ ...o, bufferSize })} />
          <NumField label="Producers" value={o.producers} min={1} max={4} onChange={(producers) => setO({ ...o, producers })} />
          <NumField label="Consumers" value={o.consumers} min={1} max={4} onChange={(consumers) => setO({ ...o, consumers })} />
          <NumField label="Items each" value={o.items} min={1} max={20} onChange={(items) => setO({ ...o, items })} />
          <NumField label="Interleaving seed" value={o.seed} min={1} max={9999} onChange={(seed) => setO({ ...o, seed })} />
        </div>
      }
      controls={<StepControls s={s} />}
      explanation={
        o.mode === "semaphore" ? (
          <p><span className="font-mono">empty</span> counts free slots, <span className="font-mono">full</span> counts filled slots and <span className="font-mono">mutex</span> protects the buffer. Producers wait on empty, consumers wait on full, so neither overruns the buffer. Swapping the order of wait(empty) and wait(mutex) would allow deadlock.</p>
        ) : (
          <p>The monitor lock provides mutual exclusion. Threads <span className="font-mono">wait</span> on the condition variables notFull/notEmpty, which atomically releases the lock. With Mesa semantics a signalled thread must re-acquire the lock and <i>re-check</i> its condition in a while loop.</p>
        )
      }
    >
      <div className="flex items-center gap-2">
        <span className="label w-[92px]">Buffer</span>
        {Array.from({ length: o.bufferSize }, (_, k) => (
          <div key={k} className="w-[64px] h-9 recess flex items-center justify-center readout text-[11px] transition-colors duration-200" style={buf[k] ? { background: "rgb(var(--amber) / .2)", borderColor: "rgb(var(--amber) / .5)" } : undefined}>
            {buf[k] ?? ""}
          </div>
        ))}
      </div>
      <Trace r={r} i={s.i} />
      <div className="grid grid-cols-4 gap-2">
        <Outcome r={r} />
        <Metric label="Produced" value={step?.shared.produced ?? 0} sub={`of ${o.producers * o.items}`} />
        <Metric label="Consumed" value={step?.shared.consumed ?? 0} />
        <Metric label="Peak occupancy" value={`${r.shared.maxFill}/${o.bufferSize}`} />
      </div>
    </LabFrame>
  );
}

function ReadersWriters() {
  const [o, setO] = useState({ readers: 3, writers: 2, iterations: 3, preference: "readers" as "readers" | "writers", seed: 5 });
  const r = useMemo(() => readersWriters(o), [o]);
  const s = useStepper(r.steps.length);
  const step = r.steps[s.i];
  return (
    <LabFrame
      title="Readers–Writers"
      code="Y2"
      config={
        <div className="flex flex-wrap gap-3 items-end">
          <Seg label="Preference" value={o.preference} onChange={(preference) => setO({ ...o, preference })} options={[{ value: "readers", label: "Readers preferred" }, { value: "writers", label: "Writers preferred" }]} />
          <NumField label="Readers" value={o.readers} min={1} max={5} onChange={(readers) => setO({ ...o, readers })} />
          <NumField label="Writers" value={o.writers} min={1} max={4} onChange={(writers) => setO({ ...o, writers })} />
          <NumField label="Iterations" value={o.iterations} min={1} max={10} onChange={(iterations) => setO({ ...o, iterations })} />
          <NumField label="Interleaving seed" value={o.seed} min={1} max={9999} onChange={(seed) => setO({ ...o, seed })} />
        </div>
      }
      controls={<StepControls s={s} />}
      explanation={
        <p>
          Any number of readers may read together, but a writer needs exclusive access. In the <b>readers-preference</b> solution the first reader locks out writers and the
          last reader lets them in, so a steady stream of readers can starve writers. The <b>writers-preference</b> solution adds a <span className="font-mono">readTry</span>
          gate that a waiting writer closes, so new readers queue behind it.
        </p>
      }
    >
      <Trace r={r} i={s.i} extra={<><Chip>active readers = {step?.shared.activeReaders ?? 0}</Chip><Chip>active writers = {step?.shared.activeWriters ?? 0}</Chip></>} />
      <div className="grid grid-cols-4 gap-2">
        <Outcome r={r} />
        <Metric label="Reads" value={step?.shared.reads ?? 0} />
        <Metric label="Writes" value={step?.shared.writes ?? 0} />
        <Metric label="Max concurrent readers" value={r.shared.maxReaders} />
      </div>
    </LabFrame>
  );
}

function Dining() {
  const [o, setO] = useState({ n: 5, meals: 2, strategy: "naive" as DiningStrategy, sched: "round_robin" as SchedMode, seed: 1 });
  const r = useMemo(() => diningPhilosophers(o), [o]);
  const s = useStepper(r.steps.length);
  const step = r.steps[s.i];
  const R = 80;
  const C = 110;
  return (
    <LabFrame
      title="Dining Philosophers"
      code="Y3"
      config={
        <div className="flex flex-wrap gap-3 items-end">
          <Seg label="Strategy" value={o.strategy} onChange={(strategy) => setO({ ...o, strategy })} options={[{ value: "naive", label: "Naive (left, right)" }, { value: "ordered", label: "Resource ordering" }, { value: "waiter", label: "Waiter (N−1 seats)" }]} />
          <Seg label="Interleaving" value={o.sched} onChange={(sched) => setO({ ...o, sched })} options={[{ value: "round_robin", label: "Lock-step" }, { value: "random", label: "Seeded random" }]} />
          <NumField label="Philosophers" value={o.n} min={2} max={8} onChange={(n) => setO({ ...o, n })} />
          <NumField label="Meals each" value={o.meals} min={1} max={10} onChange={(meals) => setO({ ...o, meals })} />
          {o.sched === "random" && <NumField label="Seed" value={o.seed} min={1} max={9999} onChange={(seed) => setO({ ...o, seed })} />}
        </div>
      }
      controls={<StepControls s={s} />}
      explanation={
        <p>
          When every philosopher picks up the left fork first, a lock-step interleaving leaves each holding one fork and waiting for the next: a circular wait, so deadlock.
          <b> Resource ordering</b> (always take the lower-numbered fork first) breaks the cycle. The <b>waiter</b> semaphore admits at most N−1 philosophers, so at least one can always eat.
        </p>
      }
    >
      <div className="flex gap-6 items-center">
        <svg width={C * 2} height={C * 2} viewBox={`0 0 ${C * 2} ${C * 2}`} role="img" aria-label="Philosophers table">
          <circle cx={C} cy={C} r={R - 22} fill="rgb(var(--panel-sunk))" stroke="rgb(var(--steel))" />
          {Array.from({ length: o.n }, (_, i) => {
            const a = (i / o.n) * Math.PI * 2 - Math.PI / 2;
            const fa = ((i + 0.5) / o.n) * Math.PI * 2 - Math.PI / 2;
            const owner = step?.mutexes[`fork${(i + 1) % o.n}`];
            const st = step?.states[i];
            const eating = step?.shared.eating[i];
            return (
              <g key={i}>
                <circle cx={C + R * Math.cos(a)} cy={C + R * Math.sin(a)} r={17} fill={eating ? "rgb(var(--ok) / .3)" : "rgb(var(--panel-raised))"} stroke={st === "blocked" ? "rgb(var(--amber))" : st === "done" ? "rgb(var(--ok))" : "rgb(var(--steel-hi))"} strokeWidth={2} />
                <text x={C + R * Math.cos(a)} y={C + R * Math.sin(a) + 4} textAnchor="middle" fontSize="11" fill="rgb(var(--ink))" fontFamily="JetBrains Mono">
                  P{i}
                </text>
                <line
                  x1={C + (R - 40) * Math.cos(fa)}
                  y1={C + (R - 40) * Math.sin(fa)}
                  x2={C + (R - 26) * Math.cos(fa)}
                  y2={C + (R - 26) * Math.sin(fa)}
                  stroke={owner != null ? "rgb(var(--amber))" : "rgb(var(--ink-3))"}
                  strokeWidth={3}
                  strokeLinecap="round"
                >
                  <title>fork{(i + 1) % o.n}{owner != null ? ` held by P${owner}` : " free"}</title>
                </line>
              </g>
            );
          })}
        </svg>
        <div className="flex-1 min-w-0">
          <Trace r={r} i={s.i} />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Outcome r={r} />
        <Metric label="Meals eaten" value={(step?.shared.meals as number[] | undefined)?.join(" · ") ?? "—"} />
        <Metric label="Forks held" value={step ? Object.values(step.mutexes).filter((v) => v != null).length : 0} sub={`of ${o.n}`} />
      </div>
    </LabFrame>
  );
}

function Race() {
  const [o, setO] = useState({ threads: 3, increments: 4, guard: "none" as Guard, sched: "round_robin" as SchedMode, seed: 3 });
  const r = useMemo(() => raceCounter(o), [o]);
  const s = useStepper(r.steps.length);
  const step = r.steps[s.i];
  return (
    <LabFrame
      title="Race Conditions & Synchronisation Primitives"
      code="Y4"
      config={
        <div className="flex flex-wrap gap-3 items-end">
          <Seg
            label="Protection"
            value={o.guard}
            onChange={(guard) => setO({ ...o, guard })}
            options={[
              { value: "none", label: "None" },
              { value: "mutex", label: "Mutex" },
              { value: "semaphore", label: "Binary semaphore" },
              { value: "monitor", label: "Monitor" },
            ]}
          />
          <Seg label="Interleaving" value={o.sched} onChange={(sched) => setO({ ...o, sched })} options={[{ value: "round_robin", label: "Lock-step" }, { value: "random", label: "Seeded random" }]} />
          <NumField label="Threads" value={o.threads} min={2} max={6} onChange={(threads) => setO({ ...o, threads })} />
          <NumField label="Increments each" value={o.increments} min={1} max={20} onChange={(increments) => setO({ ...o, increments })} />
          {o.sched === "random" && <NumField label="Seed" value={o.seed} min={1} max={9999} onChange={(seed) => setO({ ...o, seed })} />}
        </div>
      }
      controls={<StepControls s={s} />}
      explanation={
        <p>
          <span className="font-mono">counter++</span> is three machine steps: load, add, store. Without protection, two threads can load the same value and one update is
          lost. A <b>mutex</b> has an owner and must be released by that thread. A <b>binary semaphore</b> is a counter any thread may signal. A <b>monitor</b> wraps the
          data with an implicit lock (shown here as the monitor lock) and adds condition variables, which the Producer–Consumer view demonstrates.
        </p>
      }
    >
      <Trace r={r} i={s.i} extra={<Chip>counter = {step?.shared.counter ?? 0}</Chip>} />
      <div className="grid grid-cols-4 gap-2">
        <Outcome r={r} />
        <Metric label="Expected" value={r.expected} />
        <Metric label="Final counter" value={r.final} />
        <Metric label="Lost updates" value={<span className={r.lost ? "text-alert" : "text-ok"}>{r.lost}</span>} />
      </div>
    </LabFrame>
  );
}
