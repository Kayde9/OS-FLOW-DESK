// Mirrors of the Rust backend's serialized types (src-tauri/src).

export interface Metric {
  value: number | null;
  unit: string;
  source: string;
  /** The sensor/counter exists on this system. */
  available: boolean;
  note: string | null;
}

export interface Throttle {
  available: boolean;
  active: boolean;
  reasons: string[];
  source: string;
  note: string | null;
}

export interface Sample {
  ts: number;
  cpu: Metric;
  cores: number[];
  cpuFreq: Metric;
  cpuTemp: Metric;
  memUsed: Metric;
  memTotal: Metric;
  memAvailable: Metric;
  swapUsed: Metric;
  swapTotal: Metric;
  diskRead: Metric;
  diskWrite: Metric;
  diskActive: Metric;
  gpuUtil: Metric;
  gpuTemp: Metric;
  gpuPower: Metric;
  gpuFan: Metric;
  gpuMemUsed: Metric;
  gpuMemTotal: Metric;
  gpuThrottle: Throttle;
  fan: Metric;
  appCpu: Metric;
  appMem: Metric;
  processCount: number | null;
}

export interface SystemInfo {
  host: string | null;
  os: string | null;
  cpuBrand: string;
  logicalCores: number;
  physicalCores: number | null;
  totalMemory: number;
  gpuName: string | null;
  gpuNote: string | null;
  pdhDisk: boolean;
  pdhGpu: boolean;
  thermalZones: number;
  selfPid: number;
}

export interface AppStatus {
  info: SystemInfo;
  lastSampleTs: number;
  intervalMs: number;
  dbPath: string;
  reportsDir: string;
}

export interface ProcInfo {
  pid: number;
  parent: number | null;
  name: string;
  exe: string | null;
  cpu: number;
  memory: number;
  virtualMemory: number;
  status: string;
  diskReadBps: number;
  diskWriteBps: number;
  runTime: number;
}

export interface ProcessList {
  ts: number;
  cpuReady: boolean;
  processes: ProcInfo[];
}

export interface ScanSummary {
  path: string;
  files: number;
  dirs: number;
  bytes: number;
  errors: number;
  errorSamples: string[];
  truncated: boolean;
  durationMs: number;
  largest: [string, number][];
  extensions: { ext: string; files: number; bytes: number }[];
  sizeCollisions: number;
}

export type Op = "hash" | "index" | "duplicates" | "metadata" | "copy";
export type Policy = "fcfs" | "priority" | "round_robin" | "shortest_remaining";
export type JobStatus = "queued" | "running" | "paused" | "completed" | "cancelled" | "failed";

export interface EngineConfig {
  policy: Policy;
  workers: number;
  quantumMs: number;
  maxWorkersPerTask: number;
}

export interface JobView {
  id: number;
  name: string;
  op: Op;
  opLabel: string;
  folder: string;
  dest: string | null;
  priority: number;
  policy: Policy;
  status: JobStatus;
  filesTotal: number;
  filesDone: number;
  filesFailed: number;
  filesSkipped: number;
  bytesTotal: number;
  bytesDone: number;
  progress: number;
  rateBps: number;
  rateFps: number;
  etaMs: number | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  elapsedMs: number;
  responseMs: number | null;
  preemptions: number;
  activeWorkers: number;
  queuedUnits: number;
  currentFiles: string[];
  errors: string[];
  errorCount: number;
  reportPath: string | null;
  summary: string | null;
}

export interface WorkerSlot {
  id: number;
  state: "idle" | "busy" | "parked";
  jobId: number | null;
  file: string | null;
  since: number;
  units: number;
}

export interface Decision {
  ts: number;
  worker: number;
  jobId: number;
  file: string;
  reason: string;
}

export interface EngineSnapshot {
  ts: number;
  config: EngineConfig;
  maxWorkers: number;
  jobs: JobView[];
  workers: WorkerSlot[];
  runnableTasks: number;
  rrOrder: number[];
  decisions: Decision[];
  dispatches: number;
}

export interface SubmitRequest {
  name: string;
  op: Op;
  folder: string;
  dest: string | null;
  priority: number;
}

/** Persisted task/experiment record (snake_case, straight from SQLite). */
export interface JobRecord {
  id: number;
  name: string;
  op: Op;
  folder: string;
  dest: string | null;
  policy: Policy;
  priority: number;
  workers: number;
  quantum_ms: number;
  max_workers_per_task: number;
  status: JobStatus | "interrupted";
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  files_total: number;
  files_done: number;
  files_failed: number;
  files_skipped: number;
  bytes_total: number;
  bytes_done: number;
  response_ms: number | null;
  preemptions: number;
  report_path: string | null;
  error: string | null;
  summary: string | null;
}

export interface MetricAggregate {
  metric: string;
  unit: string;
  source: string;
  avg: number | null;
  min: number | null;
  max: number | null;
  samples: number;
  unavailable_samples: number;
}

export interface JobEvent {
  ts: number;
  level: "info" | "warn" | "error";
  message: string;
}

export interface JobDetail {
  record: JobRecord;
  aggregates: MetricAggregate[];
  events: JobEvent[];
}

export interface SeriesPoint {
  metric: string;
  ts: number;
  value: number | null;
}
