// Mirrors of src-tauri/src/trace (serde camelCase). Optional fields are absent
// when the provider does not supply them — never filled with guesses.

import type { SubmitRequest } from "../types";

export type SessionState = "idle" | "preparing" | "capturing" | "stopping" | "finalizing" | "completed" | "failed" | "cancelled";
export type EventSource = "etw" | "flowdesk";
export type Category = "file" | "process" | "thread" | "image" | "disk" | "workload";

export interface TraceEvent {
  seq: number;
  /** Event timestamp from the source (Unix µs). */
  tsUs: number;
  /** When FlowDesk processed it (Unix µs). */
  recvUs: number;
  source: EventSource;
  provider: string;
  category: Category | string;
  eventName: string;
  eventId?: number;
  version?: number;
  opcode?: number;
  pid?: number;
  tid?: number;
  processName?: string;
  threadName?: string;
  cpu?: number;
  operation?: string;
  filePath?: string;
  size?: number;
  offset?: number;
  durationUs?: number;
  status?: string;
  resultCode?: string;
  awaitsCompletion?: boolean;
  fields: Record<string, unknown>;
}

export interface Completion {
  seq: number;
  endUs: number;
  durationUs: number;
  status: string;
  resultCode: string;
  extraInformation?: string;
}

export interface TraceStats {
  captured: number;
  persisted: number;
  byCategory: Record<string, number>;
  errors: number;
  completions: number;
  etwDelivered: number;
  filteredOut: number;
  selfExcluded: number;
  queueDropped: number;
  notStreamed: number;
  etwEventsLost: number | null;
  etwBuffersLost: number | null;
  etwRtBuffersLost: number | null;
  firstEventUs: number | null;
  lastEventUs: number | null;
  limitHit: string | null;
}

export interface ProviderStatus {
  id: string;
  name: string;
  guid: string;
  keywords: string;
  enabled: boolean;
  error: string | null;
}

export interface SchemaInfo {
  provider: string;
  eventId: number;
  version: number;
  name: string;
  fields: string[];
}

export type TargetSpec = { kind: "workload"; job: SubmitRequest } | { kind: "process"; pid: number; name: string | null };

export interface TraceConfig {
  target: TargetSpec;
  name: string | null;
  providers: string[];
  fileCompletions: boolean;
  fileMetadata: boolean;
  maxDurationS: number;
  maxEvents: number;
  bufferKb: number;
  maxBuffers: number;
  stopWithWorkload: boolean;
  excludeTracerIo: boolean;
  pathFilter: string | null;
}

export interface SessionView {
  id: number;
  name: string;
  state: SessionState;
  mode: "etw" | "app";
  target: { kind: "workload" | "process"; pid: number; name: string | null };
  jobId: number | null;
  providers: ProviderStatus[];
  config: TraceConfig;
  elevated: boolean;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  stats: TraceStats;
  schemas: SchemaInfo[];
  stopReason: string | null;
  error: string | null;
  errorKind: "permission" | "other" | null;
}

export interface ProviderDef {
  id: string;
  name: string;
  guid: string;
  categories: string[];
  description: string;
  attribution: string;
}

export interface Capabilities {
  platformSupported: boolean;
  elevated: boolean;
  devBuild: boolean;
  sessionName: string;
  selfPid: number;
  providers: ProviderDef[];
  nativeSyscalls: boolean;
  nativeSyscallNote: string;
  etlExport: boolean;
  etlNote: string;
  permissionNote: string;
}

export interface SessionRecord {
  id: number;
  name: string;
  state: SessionState;
  mode: "etw" | "app";
  targetKind: "workload" | "process";
  targetPid: number | null;
  targetName: string | null;
  jobId: number | null;
  providers: ProviderStatus[] | null;
  config: TraceConfig | null;
  elevated: boolean;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  firstEventUs: number | null;
  lastEventUs: number | null;
  events: number;
  stats: TraceStats | null;
  summary: Summary | null;
  schemas: SchemaInfo[] | null;
  error: string | null;
}

export interface TelemetryPoint {
  metric: string;
  ts: number;
  value: number | null;
  unit: string;
  source: string;
  available: boolean;
}

export interface OpStat {
  category: string;
  operation: string;
  count: number;
  bytes: number;
  matched: number;
  unmatched: number;
  errors: number;
  p50Us: number | null;
  p95Us: number | null;
  maxUs: number | null;
}

export interface Summary {
  events: number;
  firstEventUs: number | null;
  lastEventUs: number | null;
  bySource: Record<string, number>;
  byProvider: Record<string, number>;
  byCategory: Record<string, number>;
  operations: OpStat[];
  processes: [number | null, string | null, number][];
  topFiles: { path: string; events: number; readBytes: number; writeBytes: number }[];
  results: [string, number][];
  unknownPathEvents: number;
}

export type Redact = "none" | "user" | "paths";
export type ExportFormat = "csv" | "json" | "summary";
