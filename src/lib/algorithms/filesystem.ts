// File allocation methods on a simulated disk of fixed-size blocks.

export type AllocMethod = "contiguous" | "linked" | "indexed";

export interface FileEntry {
  name: string;
  size: number; // data blocks
  /** contiguous: [start..start+size); linked: chain order; indexed: data blocks */
  blocks: number[];
  indexBlock: number | null;
}

export interface FsState {
  method: AllocMethod;
  disk: (string | null)[]; // owner per block ("name" or "name#idx" for index blocks)
  files: FileEntry[];
}

export type FsOp = { kind: "create"; name: string; size: number } | { kind: "delete"; name: string };

export interface FsStep {
  op: FsOp;
  state: FsState;
  ok: boolean;
  message: string;
}

export function emptyFs(method: AllocMethod, blocks: number): FsState {
  return { method, disk: new Array(blocks).fill(null), files: [] };
}

function clone(s: FsState): FsState {
  return { method: s.method, disk: [...s.disk], files: s.files.map((f) => ({ ...f, blocks: [...f.blocks] })) };
}

export function apply(state: FsState, op: FsOp): FsStep {
  const s = clone(state);
  if (op.kind === "delete") {
    const f = s.files.find((x) => x.name === op.name);
    if (!f) return { op, state, ok: false, message: `${op.name} does not exist` };
    for (let i = 0; i < s.disk.length; i++) if (s.disk[i] === f.name || s.disk[i] === `${f.name}#idx`) s.disk[i] = null;
    s.files = s.files.filter((x) => x !== f);
    return { op, state: s, ok: true, message: `Deleted ${f.name}: ${f.blocks.length + (f.indexBlock != null ? 1 : 0)} block(s) freed` };
  }
  if (!op.name.trim()) return { op, state, ok: false, message: "File name required" };
  if (s.files.some((f) => f.name === op.name)) return { op, state, ok: false, message: `${op.name} already exists` };
  if (op.size < 1) return { op, state, ok: false, message: "Size must be at least one block" };
  const free = s.disk.map((o, i) => (o == null ? i : -1)).filter((i) => i >= 0);
  if (s.method === "contiguous") {
    // first fit over runs of free blocks
    let run = 0;
    let start = -1;
    for (let i = 0; i < s.disk.length; i++) {
      if (s.disk[i] == null) {
        if (run === 0) start = i;
        run++;
        if (run === op.size) break;
      } else run = 0;
    }
    if (run < op.size) {
      return {
        op,
        state,
        ok: false,
        message: free.length >= op.size ? `No run of ${op.size} contiguous free blocks (${free.length} free in total): external fragmentation` : `Disk full: ${free.length} free`,
      };
    }
    const blocks = Array.from({ length: op.size }, (_, k) => start + k);
    blocks.forEach((b) => (s.disk[b] = op.name));
    s.files.push({ name: op.name, size: op.size, blocks, indexBlock: null });
    return { op, state: s, ok: true, message: `${op.name}: start ${start}, length ${op.size}` };
  }
  const need = op.size + (s.method === "indexed" ? 1 : 0);
  if (free.length < need) return { op, state, ok: false, message: `Disk full: ${need} needed, ${free.length} free` };
  if (s.method === "linked") {
    const blocks = free.slice(0, op.size);
    blocks.forEach((b) => (s.disk[b] = op.name));
    s.files.push({ name: op.name, size: op.size, blocks, indexBlock: null });
    return { op, state: s, ok: true, message: `${op.name}: start ${blocks[0]}, end ${blocks[blocks.length - 1]}; ${blocks.length - 1} next-pointer(s)` };
  }
  const [idx, ...blocks] = free.slice(0, need);
  s.disk[idx] = `${op.name}#idx`;
  blocks.forEach((b) => (s.disk[b] = op.name));
  s.files.push({ name: op.name, size: op.size, blocks, indexBlock: idx });
  return { op, state: s, ok: true, message: `${op.name}: index block ${idx} → [${blocks.join(", ")}]` };
}

export function runOps(method: AllocMethod, blocks: number, ops: FsOp[]): FsStep[] {
  let s = emptyFs(method, blocks);
  return ops.map((op) => {
    const step = apply(s, op);
    s = step.state;
    return step;
  });
}

/** Disk reads needed to access logical block `k` of a file (directory entry already in memory). */
export function accessCost(method: AllocMethod, k: number): number {
  if (method === "contiguous") return 1;
  if (method === "linked") return k + 1;
  return 2; // index block + data block
}

export function metrics(s: FsState) {
  const used = s.disk.filter((d) => d != null).length;
  const overhead = s.files.filter((f) => f.indexBlock != null).length;
  const free = s.disk.length - used;
  let runs = 0;
  let largest = 0;
  let cur = 0;
  for (const d of s.disk) {
    if (d == null) {
      cur++;
      largest = Math.max(largest, cur);
    } else {
      if (cur) runs++;
      cur = 0;
    }
  }
  if (cur) runs++;
  const pointers = s.method === "linked" ? s.files.reduce((a, f) => a + Math.max(0, f.size - 1), 0) : 0;
  return { used, free, overhead, freeRuns: runs, largestFreeRun: largest, pointers };
}
