# FlowDesk

Operating Systems Observatory, Algorithm Lab and Desktop Performance Manager for Windows, with an industrial control-room interface.

**Stack:** React 18 + TypeScript + Vite + Tailwind 3 (frontend) · Tauri 2 + Rust (backend) · SQLite (rusqlite, bundled).

## What is real and what is simulated

| Area | Source |
|---|---|
| CPU, per-core load, memory, page file, processes | `sysinfo` |
| Disk read/write throughput, disk active time | Windows PDH `\PhysicalDisk(_Total)\…` (falls back to volume `IOCTL_DISK_PERFORMANCE`) |
| GPU utilisation | Windows PDH `\GPU Engine(*)\Utilization Percentage` (busiest engine, all vendors with WDDM 2.x) |
| GPU temperature, power, fan, VRAM, throttle reasons | NVIDIA NVML (runtime-loaded `nvml.dll`; reported **N/A** on other vendors) |
| CPU temperature | ACPI thermal zones via WMI. These are usually unreadable without administrator rights, in which case they show **N/A** with the reason |
| System fan speed | Always **N/A**: Windows has no standard API |
| Workspace tasks | Real file I/O on worker threads (SHA-256, indexing, duplicate detection, metadata analysis, verified safe copy) |
| Algorithm Lab | **Simulation**, labelled as such everywhere |
| System Call Observatory | Real ETW events (Kernel-File, Kernel-Process, Kernel-Disk) for one target process, plus FlowDesk engine events kept as a separate source. **ETW mode**: native syscall entry/exit is not captured. Needs administrator rights (or Performance Log Users). See [docs/system-call-observatory.md](docs/system-call-observatory.md) |

FlowDesk's scheduling policies (FCFS, Priority, Round Robin, Shortest Remaining) choose which *FlowDesk task* its worker threads serve next. The Windows kernel still schedules those threads onto CPUs.

## Layout

```
src/                      React frontend
  lib/backend.ts          typed invoke bridge (no mock fallback)
  lib/telemetry/          telemetry client store + series helpers
  lib/engine/             job-engine client store + folder selection
  lib/trace/              trace client store, bounded live window, pure analysis (+ analysis.test.ts)
  pages/observatory/      System Call Observatory: header, target setup, canvas timeline,
                          virtualized event table, inspector, analysis, sessions
  lib/algorithms/         pure, unit-tested algorithm modules (+ algorithms.test.ts)
  components/industrial/  Panel, Gauge, LED, Readout, Progress, Seg …
  components/charts/      TimeSeriesChart (SVG, crosshair tooltip, legend toggles), Sparkline
  pages/                  Overview, LiveMonitor, Workspace, Experiments, History, Settings
  pages/lab/              Algorithm Lab: one module per category + shared primitives
src-tauri/src/
  telemetry/              sampler thread, PDH, NVML
  engine/                 application-level scheduler, workers, cursors, reports
  trace/                  ETW session lifecycle (etw.rs), TDH schema decoding (decode.rs),
                          target filtering + IRP correlation (collector.rs), SQLite (store.rs),
                          exports + redaction (export.rs), providers.rs, model.rs
  scan.rs                 folder traversal
  db.rs                   SQLite migrations + queries
  commands.rs             Tauri commands
```

### Job engine

Each task is split into one unit per file. A fixed pool of worker threads asks the scheduler for the next unit, and the policy picks the task it comes from. Under Round Robin a unit runs for at most one quantum; content operations keep a resumable cursor (an open file plus the hasher state), so a preempted file resumes exactly where it stopped. Pause and cancel are checked between 256 KiB chunks. A cancelled copy deletes its `.flowdesk-part` file, and safe copy never overwrites an existing file. The engine emits `engine://state` events at most every 250 ms, including the scheduler's decision log.

### Persistence

The database lives at `%APPDATA%\dev.flowdesk.observatory\flowdesk.sqlite`, with schema migrations tracked in `PRAGMA user_version`. Tables:

- `jobs`: task and experiment records.
- `telemetry_samples`: long format (timestamp, metric, value, unit, source, availability), recorded each interval while a task runs.
- `job_events`: per-task event log.
- `preferences`: settings.
- `trace_sessions`, `trace_events`, `trace_telemetry` (schema v2): trace sessions, normalized events (batched inserts, completions applied by `seq`) and the telemetry window of each session. The newest 30 sessions / 3M events are kept.

Tasks still running when the app exits are marked `interrupted` on the next launch. Reports (JSON plus CSV) go to the `reports` folder next to the database.

## Develop

Prerequisites: Node 18+, Rust (stable, MSVC toolchain), Visual Studio Build Tools with C++ and WebView2 (preinstalled on Windows 11).

```sh
npm install
npm run tauri dev      # desktop app with the backend
npm test               # algorithm unit tests (vitest)
cd src-tauri && cargo test   # backend tests: scheduler, copy safety, DB restart, trace lifecycle/decoding/storage
cargo test -- --ignored etw_live   # from an ELEVATED terminal: real ETW capture of a hashing task
                                   # (writes target/etw-verification.json with the schemas TDH reported)
npm run tauri build    # NSIS installer
```

This repository is inside OneDrive. To keep Rust build output out of sync, set `CARGO_TARGET_DIR`, for example `set CARGO_TARGET_DIR=%LOCALAPPDATA%\flowdesk-target`.

Running `npm run dev` alone serves the UI in a browser. Backend panels then show "backend not connected" instead of placeholder data, and the Algorithm Lab works fully.

## Not implemented

- Compression and backup operations (shown disabled in the Workspace).
- CPU package temperature without administrator rights, and fan RPM.
- Per-task CPU attribution: CPU usage is measured for the FlowDesk process as a whole.
