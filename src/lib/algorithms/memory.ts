// Memory management: page replacement, paging & segmentation address
// translation, and contiguous (dynamic partition) allocation.

// ------------------------------------------------------------ page replacement

export type PageAlgo = "fifo" | "lru" | "opt";

export interface PageStep {
  ref: number;
  frames: (number | null)[];
  hit: boolean;
  /** Frame slot that received the page on a fault. */
  slot: number | null;
  victim: number | null;
  reason: string;
}

export interface PageResult {
  steps: PageStep[];
  faults: number;
  hits: number;
  hitRatio: number;
}

export function pageReplacement(refs: number[], frameCount: number, algo: PageAlgo): PageResult {
  if (frameCount < 1) throw new Error("Need at least one frame");
  const frames: (number | null)[] = new Array(frameCount).fill(null);
  const loadedAt: number[] = new Array(frameCount).fill(-1);
  const lastUsed: number[] = new Array(frameCount).fill(-1);
  const steps: PageStep[] = [];
  let faults = 0;
  refs.forEach((ref, i) => {
    const at = frames.indexOf(ref);
    if (at >= 0) {
      lastUsed[at] = i;
      steps.push({ ref, frames: [...frames], hit: true, slot: null, victim: null, reason: `Page ${ref} already resident in frame ${at}` });
      return;
    }
    faults++;
    let slot = frames.indexOf(null);
    let victim: number | null = null;
    let reason: string;
    if (slot >= 0) {
      reason = `Fault: free frame ${slot}`;
    } else {
      if (algo === "fifo") {
        slot = loadedAt.indexOf(Math.min(...loadedAt));
        reason = `Fault: evict ${frames[slot]}, loaded earliest (t=${loadedAt[slot]})`;
      } else if (algo === "lru") {
        slot = lastUsed.indexOf(Math.min(...lastUsed));
        reason = `Fault: evict ${frames[slot]}, least recently used (t=${lastUsed[slot]})`;
      } else {
        // Optimal: evict the page whose next use is farthest away (or never).
        let far = -1;
        slot = 0;
        for (let f = 0; f < frameCount; f++) {
          const next = refs.indexOf(frames[f]!, i + 1);
          const d = next === -1 ? Infinity : next;
          if (d > far) {
            far = d;
            slot = f;
          }
        }
        reason = `Fault: evict ${frames[slot]}, ${far === Infinity ? "never used again" : `next used at t=${far}`}`;
      }
      victim = frames[slot];
    }
    frames[slot] = ref;
    loadedAt[slot] = i;
    lastUsed[slot] = i;
    steps.push({ ref, frames: [...frames], hit: false, slot, victim, reason });
  });
  const hits = refs.length - faults;
  return { steps, faults, hits, hitRatio: refs.length ? hits / refs.length : 0 };
}

// ------------------------------------------------------------ paging

export interface PagingResult {
  ok: boolean;
  page: number;
  offset: number;
  offsetBits: number;
  pageBits: number;
  frame: number | null;
  physical: number | null;
  message: string;
}

export function translatePaging(logical: number, pageSize: number, pageTable: (number | null)[]): PagingResult {
  if (pageSize < 1 || (pageSize & (pageSize - 1)) !== 0) throw new Error("Page size must be a power of two");
  if (logical < 0 || !Number.isInteger(logical)) throw new Error("Logical address must be a non-negative integer");
  const offsetBits = Math.log2(pageSize);
  const pageBits = Math.max(1, Math.ceil(Math.log2(Math.max(2, pageTable.length))));
  const page = Math.floor(logical / pageSize);
  const offset = logical % pageSize;
  if (page >= pageTable.length) {
    return { ok: false, page, offset, offsetBits, pageBits, frame: null, physical: null, message: `Trap: page ${page} is beyond the page table (length ${pageTable.length})` };
  }
  const frame = pageTable[page];
  if (frame == null) {
    return { ok: false, page, offset, offsetBits, pageBits, frame: null, physical: null, message: `Page fault: page ${page} is marked invalid (not resident)` };
  }
  const physical = frame * pageSize + offset;
  return { ok: true, page, offset, offsetBits, pageBits, frame, physical, message: `Page ${page} → frame ${frame}; physical = ${frame} × ${pageSize} + ${offset} = ${physical}` };
}

// ------------------------------------------------------------ segmentation

export interface Segment {
  base: number;
  limit: number;
}

export function translateSegment(seg: number, offset: number, table: Segment[]) {
  if (seg < 0 || seg >= table.length) return { ok: false as const, physical: null, message: `Trap: segment ${seg} does not exist` };
  const s = table[seg];
  if (offset < 0 || offset >= s.limit) return { ok: false as const, physical: null, message: `Trap: offset ${offset} ≥ limit ${s.limit} (segmentation violation)` };
  return { ok: true as const, physical: s.base + offset, message: `Segment ${seg}: base ${s.base} + offset ${offset} = ${s.base + offset}` };
}

// ------------------------------------------------------------ contiguous allocation

export type FitAlgo = "first" | "best" | "worst";

export interface Block {
  start: number;
  size: number;
  owner: string | null;
}

export type AllocOp = { kind: "alloc"; pid: string; size: number } | { kind: "free"; pid: string };

export interface AllocStep {
  op: AllocOp;
  blocks: Block[];
  ok: boolean;
  message: string;
}

export interface AllocResult {
  steps: AllocStep[];
  failed: number;
  finalFree: number;
  largestHole: number;
  holes: number;
  /** 1 − largest hole / total free: 0 = all free memory is contiguous. */
  externalFragmentation: number;
}

function coalesce(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (last && last.owner == null && b.owner == null && last.start + last.size === b.start) last.size += b.size;
    else out.push({ ...b });
  }
  return out;
}

export function allocate(totalSize: number, ops: AllocOp[], algo: FitAlgo, initial?: Block[]): AllocResult {
  let blocks: Block[] = initial ? initial.map((b) => ({ ...b })) : [{ start: 0, size: totalSize, owner: null }];
  const steps: AllocStep[] = [];
  let failed = 0;
  for (const op of ops) {
    let ok = true;
    let message: string;
    if (op.kind === "alloc") {
      if (blocks.some((b) => b.owner === op.pid)) {
        ok = false;
        message = `${op.pid} is already allocated`;
      } else {
        const holes = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.owner == null && b.size >= op.size);
        let pick: { b: Block; i: number } | undefined;
        if (algo === "first") pick = holes[0];
        else if (algo === "best") pick = holes.sort((a, b) => a.b.size - b.b.size || a.b.start - b.b.start)[0];
        else pick = holes.sort((a, b) => b.b.size - a.b.size || a.b.start - b.b.start)[0];
        if (!pick) {
          ok = false;
          failed++;
          const free = blocks.filter((b) => b.owner == null).reduce((a, b) => a + b.size, 0);
          message = free >= op.size ? `${op.pid} (${op.size}) fails: ${free} free in total but no single hole is large enough (external fragmentation)` : `${op.pid} (${op.size}) fails: only ${free} free`;
        } else {
          const { b, i } = pick;
          const parts: Block[] = [{ start: b.start, size: op.size, owner: op.pid }];
          if (b.size > op.size) parts.push({ start: b.start + op.size, size: b.size - op.size, owner: null });
          blocks.splice(i, 1, ...parts);
          message = `${op.pid} (${op.size}) → hole at ${b.start} of size ${b.size}${b.size > op.size ? `, leaving ${b.size - op.size}` : ", exact fit"}`;
        }
      }
    } else {
      const b = blocks.find((x) => x.owner === op.pid);
      if (!b) {
        ok = false;
        message = `${op.pid} is not allocated`;
      } else {
        b.owner = null;
        blocks = coalesce(blocks);
        message = `free ${op.pid}: ${b.size} returned at ${b.start} (adjacent holes merged)`;
      }
    }
    steps.push({ op, blocks: blocks.map((b) => ({ ...b })), ok, message });
  }
  const holes = blocks.filter((b) => b.owner == null);
  const finalFree = holes.reduce((a, b) => a + b.size, 0);
  const largestHole = Math.max(0, ...holes.map((h) => h.size));
  return { steps, failed, finalFree, largestHole, holes: holes.length, externalFragmentation: finalFree ? 1 - largestHole / finalFree : 0 };
}

/** Fixed partitions (classic textbook exercise): each partition holds at most one process. */
export function fixedPartitions(partitions: number[], requests: number[], algo: FitAlgo) {
  const owner: (number | null)[] = partitions.map(() => null);
  const placement = requests.map((size, pi) => {
    const free = partitions.map((p, i) => ({ p, i })).filter(({ p, i }) => owner[i] == null && p >= size);
    let pick = free[0];
    if (algo === "best") pick = free.sort((a, b) => a.p - b.p)[0];
    if (algo === "worst") pick = free.sort((a, b) => b.p - a.p)[0];
    if (!pick) return { process: pi, size, partition: null as number | null, internal: 0 };
    owner[pick.i] = pi;
    return { process: pi, size, partition: pick.i, internal: pick.p - size };
  });
  return { placement, internalFragmentation: placement.reduce((a, p) => a + p.internal, 0), unplaced: placement.filter((p) => p.partition == null).length };
}
