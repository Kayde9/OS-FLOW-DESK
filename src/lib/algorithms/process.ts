// Five-state process model with a PCB table (single CPU).

export type PState = "new" | "ready" | "running" | "waiting" | "terminated";
export type Transition = "admit" | "dispatch" | "timeout" | "wait" | "wake" | "exit";

export const TRANSITIONS: Record<Transition, { from: PState; to: PState; label: string }> = {
  admit: { from: "new", to: "ready", label: "Admit" },
  dispatch: { from: "ready", to: "running", label: "Dispatch" },
  timeout: { from: "running", to: "ready", label: "Interrupt / timeout" },
  wait: { from: "running", to: "waiting", label: "I/O or event wait" },
  wake: { from: "waiting", to: "ready", label: "I/O or event completion" },
  exit: { from: "running", to: "terminated", label: "Exit" },
};

export interface Pcb {
  pid: number;
  name: string;
  state: PState;
  pc: number;
  priority: number;
  cpuTime: number;
  switches: number;
  waitReason: string | null;
  parent: number | null;
}

export interface Model {
  procs: Pcb[];
  clock: number;
  nextPid: number;
  log: { t: number; msg: string }[];
}

export const initialModel = (): Model => ({ procs: [], clock: 0, nextPid: 100, log: [] });

export function create(m: Model, name: string, priority: number, parent: number | null = null): Model {
  const pcb: Pcb = { pid: m.nextPid, name, state: "new", pc: 0, priority, cpuTime: 0, switches: 0, waitReason: null, parent };
  return { ...m, procs: [...m.procs, pcb], nextPid: m.nextPid + 1, log: [...m.log, { t: m.clock, msg: `create PID ${pcb.pid} (${name})${parent != null ? ` as child of ${parent}` : ""} → NEW` }] };
}

export function canApply(m: Model, pid: number, tr: Transition): string | null {
  const p = m.procs.find((x) => x.pid === pid);
  if (!p) return "No such process";
  const def = TRANSITIONS[tr];
  if (p.state !== def.from) return `${def.label} requires state ${def.from.toUpperCase()}, but PID ${pid} is ${p.state.toUpperCase()}`;
  if (tr === "dispatch" && m.procs.some((x) => x.state === "running")) return "The CPU is busy: one process is already RUNNING";
  return null;
}

export function applyTransition(m: Model, pid: number, tr: Transition, reason?: string): Model {
  const err = canApply(m, pid, tr);
  if (err) throw new Error(err);
  const def = TRANSITIONS[tr];
  const procs = m.procs.map((p) => {
    if (p.pid !== pid) return p;
    const q = { ...p, state: def.to };
    if (tr === "dispatch") q.switches++;
    if (tr === "timeout" || tr === "wait" || tr === "exit") {
      // Saving context: the simulated PC advances by the work done while running.
      q.pc += 4;
      q.cpuTime += 1;
    }
    q.waitReason = tr === "wait" ? reason ?? "I/O" : null;
    return q;
  });
  return { ...m, procs, clock: m.clock + 1, log: [...m.log, { t: m.clock + 1, msg: `PID ${pid}: ${def.label} (${def.from.toUpperCase()} → ${def.to.toUpperCase()})${tr === "wait" ? ` on ${reason ?? "I/O"}` : ""}` }] };
}
