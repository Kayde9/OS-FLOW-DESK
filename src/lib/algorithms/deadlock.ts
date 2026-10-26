// Deadlock avoidance (Banker's algorithm) and detection (resource-allocation graphs).

export type Matrix = number[][];

export interface SafetyStep {
  process: number | null;
  work: number[];
  finish: boolean[];
  message: string;
}

export interface SafetyResult {
  safe: boolean;
  sequence: number[];
  need: Matrix;
  steps: SafetyStep[];
}

const le = (a: number[], b: number[]) => a.every((v, i) => v <= b[i]);
const add = (a: number[], b: number[]) => a.map((v, i) => v + b[i]);
const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);

export function validateBanker(available: number[], max: Matrix, alloc: Matrix): string | null {
  const m = available.length;
  if (max.length !== alloc.length) return "Max and Allocation must have the same number of processes";
  for (let i = 0; i < max.length; i++) {
    if (max[i].length !== m || alloc[i].length !== m) return `Row P${i} must have ${m} resource columns`;
    for (let j = 0; j < m; j++) {
      if (alloc[i][j] < 0 || max[i][j] < 0) return "Values must be non-negative";
      if (alloc[i][j] > max[i][j]) return `P${i} holds more of R${j} than its declared maximum`;
    }
  }
  if (available.some((v) => v < 0)) return "Available must be non-negative";
  return null;
}

/** Banker's safety algorithm. Scans processes in index order each pass (deterministic sequence). */
export function bankerSafety(available: number[], max: Matrix, alloc: Matrix): SafetyResult {
  const err = validateBanker(available, max, alloc);
  if (err) throw new Error(err);
  const n = max.length;
  const need = max.map((row, i) => sub(row, alloc[i]));
  let work = [...available];
  const finish = new Array(n).fill(false);
  const sequence: number[] = [];
  const steps: SafetyStep[] = [{ process: null, work: [...work], finish: [...finish], message: `Work = Available = [${work.join(", ")}]` }];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let i = 0; i < n; i++) {
      if (finish[i]) continue;
      if (le(need[i], work)) {
        work = add(work, alloc[i]);
        finish[i] = true;
        sequence.push(i);
        progressed = true;
        steps.push({ process: i, work: [...work], finish: [...finish], message: `P${i}: Need [${need[i].join(", ")}] ≤ Work → runs, releases [${alloc[i].join(", ")}]; Work = [${work.join(", ")}]` });
      }
    }
  }
  const safe = finish.every(Boolean);
  steps.push({
    process: null,
    work: [...work],
    finish: [...finish],
    message: safe ? `Safe: sequence ⟨${sequence.map((p) => `P${p}`).join(", ")}⟩` : `Unsafe: ${finish.map((f, i) => (f ? null : `P${i}`)).filter(Boolean).join(", ")} can never finish with the resources available`,
  });
  return { safe, sequence, need, steps };
}

export interface RequestResult {
  granted: boolean;
  message: string;
  safety: SafetyResult | null;
  available: number[];
  alloc: Matrix;
}

/** Resource-request algorithm: grant only if the resulting state is safe. */
export function bankerRequest(available: number[], max: Matrix, alloc: Matrix, p: number, req: number[]): RequestResult {
  const need = max.map((row, i) => sub(row, alloc[i]));
  if (!le(req, need[p])) return { granted: false, message: `Error: P${p} requested more than its remaining need [${need[p].join(", ")}]`, safety: null, available, alloc };
  if (!le(req, available)) return { granted: false, message: `P${p} must wait: request exceeds Available [${available.join(", ")}]`, safety: null, available, alloc };
  const avail2 = sub(available, req);
  const alloc2 = alloc.map((row, i) => (i === p ? add(row, req) : [...row]));
  const safety = bankerSafety(avail2, max, alloc2);
  return safety.safe
    ? { granted: true, message: `Granted: the state after allocation is safe`, safety, available: avail2, alloc: alloc2 }
    : { granted: false, message: `Denied: granting would leave the system unsafe, so P${p} waits`, safety, available, alloc };
}

// ------------------------------------------------------------ RAG / detection

export interface Rag {
  processes: string[];
  resources: { id: string; instances: number }[];
  /** allocation[p][r] instances of r held by p */
  allocation: Matrix;
  /** request[p][r] instances of r requested (waiting) by p */
  request: Matrix;
}

export interface DetectionResult {
  deadlocked: number[];
  order: number[];
  /** A cycle in the wait-for graph (process indices) when one exists. */
  cycle: number[] | null;
  available: number[];
}

/** Multi-instance detection algorithm + wait-for-graph cycle for visualisation. */
export function detectDeadlock(g: Rag): DetectionResult {
  const n = g.processes.length;
  const m = g.resources.length;
  const held = Array.from({ length: m }, (_, r) => g.allocation.reduce((a, row) => a + (row[r] ?? 0), 0));
  const available = g.resources.map((r, j) => r.instances - held[j]);
  if (available.some((v) => v < 0)) throw new Error("More instances allocated than exist");
  let work = [...available];
  const finish = g.allocation.map((row) => row.every((v) => v === 0));
  const order: number[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (!finish[i] && le(g.request[i], work)) {
        work = add(work, g.allocation[i]);
        finish[i] = true;
        order.push(i);
        changed = true;
      }
    }
  }
  const deadlocked = finish.map((f, i) => (f ? -1 : i)).filter((i) => i >= 0);
  // Wait-for edges: Pi → Pk if Pi requests r and Pk holds r.
  const waits = (i: number) => {
    const out: number[] = [];
    for (let r = 0; r < m; r++) if (g.request[i][r] > 0) for (let k = 0; k < n; k++) if (k !== i && g.allocation[k][r] > 0) out.push(k);
    return out;
  };
  let cycle: number[] | null = null;
  const color = new Array(n).fill(0);
  const stack: number[] = [];
  const dfs = (u: number): boolean => {
    color[u] = 1;
    stack.push(u);
    for (const v of waits(u)) {
      if (color[v] === 1) {
        cycle = stack.slice(stack.indexOf(v));
        return true;
      }
      if (color[v] === 0 && dfs(v)) return true;
    }
    stack.pop();
    color[u] = 2;
    return false;
  };
  for (let i = 0; i < n && !cycle; i++) if (color[i] === 0) dfs(i);
  return { deadlocked, order, cycle, available };
}
