// SYNTHETIC trace events — for unit tests only.
// Never imported by application code, so it is not part of the bundle, and
// every event is tagged provider "SYNTHETIC-TEST" + fields._synthetic = true.
// It must never be presented as a Windows trace.

import type { TraceEvent } from "./types";

export const SYNTHETIC_PROVIDER = "SYNTHETIC-TEST";

export function synthetic(n: number, base = 1_790_000_000_000_000): TraceEvent[] {
  return Array.from({ length: n }, (_, i): TraceEvent => {
    const tsUs = base + i * 1000;
    if (i % 10 === 0) {
      return {
        seq: i + 1,
        tsUs,
        recvUs: tsUs + 40,
        source: "flowdesk",
        provider: "FlowDesk.Engine",
        category: "workload",
        eventName: "UnitDispatched",
        operation: "UnitDispatched",
        pid: 500,
        tid: 100 + (i % 2),
        processName: "synthetic.exe",
        threadName: `flowdesk-worker-${i % 2}`,
        filePath: `C:\\synthetic\\file${i % 5}.bin`,
        fields: { _synthetic: true, jobId: 1 },
      };
    }
    const dur = i % 3 === 0 ? 10 * i : undefined;
    const failed = i % 7 === 0 && dur != null;
    return {
      seq: i + 1,
      tsUs,
      recvUs: tsUs + 40,
      source: "etw",
      provider: SYNTHETIC_PROVIDER,
      category: "file",
      eventName: i % 4 === 1 ? "Create" : "Read",
      operation: i % 4 === 1 ? "Create" : "Read",
      pid: 500,
      tid: 100 + (i % 3),
      processName: "synthetic.exe",
      cpu: i % 4,
      filePath: `C:\\synthetic\\file${i % 5}.bin`,
      size: i % 4 === 1 ? undefined : 262_144,
      durationUs: dur,
      status: dur == null ? undefined : failed ? "error" : "success",
      resultCode: dur == null ? undefined : failed ? "0xC0000011 STATUS_END_OF_FILE" : "0x00000000 STATUS_SUCCESS",
      awaitsCompletion: true,
      fields: { _synthetic: true },
    };
  });
}
