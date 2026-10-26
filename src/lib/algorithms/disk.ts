// Disk-arm scheduling and I/O buffering schemes.

export type DiskAlgo = "fcfs" | "sstf" | "scan" | "cscan" | "look" | "clook";

export interface DiskResult {
  /** Head positions in visiting order, starting with the initial head. */
  path: number[];
  /** Requests in service order. */
  order: number[];
  movement: number;
  avgSeek: number;
  /** Positions the head travels through without servicing (track ends, wrap jumps). */
  passThrough: number[];
  notes: string[];
}

export function diskSchedule(
  requests: number[],
  head: number,
  algo: DiskAlgo,
  opts: { cylinders: number; direction: "up" | "down"; countWrap: boolean },
): DiskResult {
  const max = opts.cylinders - 1;
  if (head < 0 || head > max) throw new Error(`Head must be between 0 and ${max}`);
  for (const r of requests) if (r < 0 || r > max || !Number.isInteger(r)) throw new Error(`Request ${r} outside 0–${max}`);
  const notes: string[] = [];
  const passThrough: number[] = [];
  let order: number[] = [];
  const path: number[] = [head];
  const lower = requests.filter((r) => r < head).sort((a, b) => b - a); // descending
  const upper = requests.filter((r) => r >= head).sort((a, b) => a - b); // ascending
  const up = opts.direction === "up";

  switch (algo) {
    case "fcfs":
      order = [...requests];
      path.push(...order);
      break;
    case "sstf": {
      const left = [...requests];
      let pos = head;
      while (left.length) {
        let bi = 0;
        for (let i = 1; i < left.length; i++) if (Math.abs(left[i] - pos) < Math.abs(left[bi] - pos)) bi = i;
        pos = left.splice(bi, 1)[0];
        order.push(pos);
      }
      path.push(...order);
      notes.push("Ties are broken by request order.");
      break;
    }
    case "scan":
    case "look": {
      const first = up ? upper : lower;
      const second = up ? lower : upper;
      order = [...first, ...second];
      path.push(...first);
      if (second.length) {
        if (algo === "scan") {
          const end = up ? max : 0;
          if (path[path.length - 1] !== end) {
            path.push(end);
            passThrough.push(end);
          }
          notes.push(`SCAN continues to cylinder ${end} before reversing.`);
        }
        path.push(...second);
      }
      break;
    }
    case "cscan":
    case "clook": {
      const first = up ? upper : lower;
      const wrapPart = up ? [...lower].sort((a, b) => a - b) : [...upper].sort((a, b) => b - a);
      order = [...first, ...wrapPart];
      path.push(...first);
      if (wrapPart.length) {
        if (algo === "cscan") {
          const end = up ? max : 0;
          const start = up ? 0 : max;
          if (path[path.length - 1] !== end) path.push(end), passThrough.push(end);
          path.push(start);
          passThrough.push(start);
        }
        // C-LOOK jumps straight to the farthest pending request at the other end.
        path.push(...wrapPart);
      }
      break;
    }
  }
  let movement = 0;
  for (let i = 1; i < path.length; i++) {
    const isWrap = (algo === "cscan" || algo === "clook") && wrapIndex(path, i, up);
    if (isWrap && !opts.countWrap) continue;
    movement += Math.abs(path[i] - path[i - 1]);
  }
  if (algo === "cscan" || algo === "clook") notes.push(opts.countWrap ? "The return jump is counted as head movement." : "The return jump is not counted (some textbooks treat it as a fast return).");
  return { path, order, movement, avgSeek: requests.length ? movement / requests.length : 0, passThrough, notes };
}

/** True if path[i-1] → path[i] is the circular wrap (the only move against the sweep direction). */
function wrapIndex(path: number[], i: number, up: boolean) {
  return up ? path[i] < path[i - 1] : path[i] > path[i - 1];
}

// ------------------------------------------------------------ buffering

export type BufferScheme = "none" | "single" | "double" | "circular";

export interface BlockTiming {
  block: number;
  buffer: number | null;
  fillStart: number;
  fillEnd: number;
  copyStart: number;
  copyEnd: number;
  computeStart: number;
  computeEnd: number;
}

export interface BufferResult {
  timeline: BlockTiming[];
  total: number;
  perBlock: number;
  deviceBusy: number;
  cpuIdle: number;
}

/**
 * Device reads a block in T into a system buffer; the process copies it to user
 * space in M and then computes for C[i]. With k buffers the device may fill
 * block i once the buffer used by block i−k has been copied out.
 * "none" = the device reads straight into user space, so reading and computing never overlap.
 */
export function simulateBuffering(blocks: number, T: number, M: number, C: number[], scheme: BufferScheme, k = 4): BufferResult {
  if (blocks < 1) throw new Error("Need at least one block");
  const comp = (i: number) => C[i % C.length];
  const nbuf = scheme === "single" ? 1 : scheme === "double" ? 2 : scheme === "circular" ? Math.max(2, k) : 0;
  const tl: BlockTiming[] = [];
  for (let i = 0; i < blocks; i++) {
    const prev = tl[i - 1];
    if (scheme === "none") {
      const fillStart = prev ? prev.computeEnd : 0;
      const fillEnd = fillStart + T;
      tl.push({ block: i, buffer: null, fillStart, fillEnd, copyStart: fillEnd, copyEnd: fillEnd, computeStart: fillEnd, computeEnd: fillEnd + comp(i) });
      continue;
    }
    const bufferFree = i >= nbuf ? tl[i - nbuf].copyEnd : 0;
    const fillStart = Math.max(prev ? prev.fillEnd : 0, bufferFree);
    const fillEnd = fillStart + T;
    const copyStart = Math.max(fillEnd, prev ? prev.computeEnd : 0);
    const copyEnd = copyStart + M;
    tl.push({ block: i, buffer: i % nbuf, fillStart, fillEnd, copyStart, copyEnd, computeStart: copyEnd, computeEnd: copyEnd + comp(i) });
  }
  const total = tl[tl.length - 1].computeEnd;
  const deviceBusy = (blocks * T) / total;
  const cpuWork = tl.reduce((a, b) => a + (b.copyEnd - b.copyStart) + (b.computeEnd - b.computeStart), 0);
  return { timeline: tl, total, perBlock: total / blocks, deviceBusy, cpuIdle: total - cpuWork };
}
