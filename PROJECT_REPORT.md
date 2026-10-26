# FlowDesk: An Operating Systems Observatory, Algorithm Lab and Desktop Performance Manager

**Project Report — Operating System**

| | |
|---|---|
| **Subject** | Operating System |
| **Project title** | FlowDesk: An Operating Systems Observatory, Algorithm Lab and Desktop Performance Manager |
| **Under the guidance of** | S. Chandrasekhar |
| **Submitted by** | [Student name] |
| **Roll number / SAP ID** | [Roll number] |
| **Programme and semester** | [Programme, semester] |
| **Institution** | [Institution name] |
| **Academic year** | 2026–27 |
| **Date of submission** | 25 October 2026 |

---

## Certificate

This is to certify that the project titled **"FlowDesk: An Operating Systems Observatory, Algorithm Lab and Desktop Performance Manager"** is the bona fide work of **[Student name] ([Roll number])**. It was carried out under my guidance as project work for the course **Operating System** during the academic year 2026–27.

&nbsp;

**S. Chandrasekhar**
Project Guide, Operating System

Signature: ______________________  Date: ______________

---

## Acknowledgement

I express my sincere gratitude to **S. Chandrasekhar** for his guidance throughout this project. His teaching of process scheduling, synchronisation, deadlocks, memory management and file systems shaped both the design of FlowDesk and the algorithms it demonstrates.

I also thank the department and my institution for the resources and the opportunity to apply operating-system theory to a working application.

---

## Table of Contents

1. Abstract
2. Introduction
3. Problem Statement and Objectives
4. Operating-System Concepts Applied
5. System Architecture
6. Module Design
   - 6.1 Telemetry Service
   - 6.2 Job Engine and Application-Level Scheduler
   - 6.3 File Operations
   - 6.4 Algorithm Lab
   - 6.5 Database Design
7. User Interface Design
8. Implementation Details
9. Testing and Results
10. Limitations and Future Work
11. Conclusion
12. References
13. Appendix: Running the Project

---

## 1. Abstract

FlowDesk is a Windows desktop application that connects operating-system theory with real system behaviour. It has three parts:

1. **An observatory** that measures live CPU, memory, disk, GPU and process activity through Windows APIs.
2. **A desktop performance manager** that runs real file workloads (SHA-256 hashing, indexing, duplicate detection, metadata analysis and verified copying) on a pool of worker threads. An application-level scheduler chooses which task each worker serves using FCFS, Priority, Round Robin or Shortest-Remaining-Work policies.
3. **An Algorithm Lab** that simulates and animates classic OS algorithms: CPU scheduling, process states, synchronisation, deadlocks, memory management, disk scheduling, buffering and file allocation.

The application is built with React and TypeScript for the interface and Rust with Tauri 2 for the system layer. Results are stored in SQLite. Every measured value states its source, and sensors that Windows does not expose are shown as "N/A" with the reason, never estimated. On the test machine, a real hashing workload processed 3,866 files (789.8 MB) in 23.4 seconds, while the telemetry service recorded CPU, disk, GPU and temperature samples every second. All 26 algorithm unit tests and 8 backend tests pass, and the simulators reproduce standard textbook results.

---

## 2. Introduction

Operating-system concepts such as scheduling, synchronisation and paging are usually studied on paper with small, fixed examples. Students rarely see how these ideas relate to the computer they are using. Tools like Task Manager show live numbers but do not explain the algorithms behind them, while algorithm visualisers explain the algorithms but use no real data.

FlowDesk combines both views in one application. A student can:

- run a real workload on their own files and watch a scheduler hand work to threads;
- see the resulting CPU, disk and GPU load measured live from the hardware;
- open the Algorithm Lab, enter the same kind of process table seen in class, and step through the schedule, page faults or safe sequence one event at a time.

The application is styled as an industrial control room, with gauges, status lights and an execution pipeline (INPUT → SCHEDULER → WORKERS → FILE PROCESSOR → OUTPUT), so that work moving through the system is visible at a glance.

---

## 3. Problem Statement and Objectives

### 3.1 Problem Statement

Build a desktop application that (a) measures real system resources accurately, (b) runs real background workloads under user-selectable scheduling policies with progress, pause and cancellation, (c) records each run for later comparison, and (d) teaches core OS algorithms through interactive, step-by-step simulation. Simulated values must never be presented as real operating-system behaviour.

### 3.2 Objectives

| No. | Objective | Achieved through |
|---|---|---|
| O1 | Collect live CPU, memory, disk, GPU and process telemetry | Telemetry service using sysinfo, Windows PDH counters and NVIDIA NVML |
| O2 | Mark unsupported sensors explicitly | Every metric carries value, unit, source and an availability flag with a reason |
| O3 | Implement application-level scheduling of real work | Job engine with FCFS, Priority, Round Robin and Shortest-Remaining policies |
| O4 | Support progress, pause, resume and cancellation | Shared atomic flags checked between 256 KiB chunks |
| O5 | Persist experiments across restarts | SQLite database with versioned migrations |
| O6 | Simulate classic OS algorithms with correct results | Pure TypeScript modules verified by unit tests against textbook answers |
| O7 | Present everything in a clear, responsive interface | React interface with reusable industrial components and live charts |

---

## 4. Operating-System Concepts Applied

The table maps each syllabus topic to where it appears in FlowDesk.

| OS concept | Where it is used in FlowDesk | Real or simulated |
|---|---|---|
| Processes and threads | Worker thread pool, telemetry thread, event emitter thread; live process list with PID, CPU and memory | Real |
| CPU scheduling (FCFS, Priority, RR, SRTF) | Job engine decides which task's file each worker processes next | Real (application level) |
| CPU scheduling (FCFS, SJF, SRTF, Priority, RR, MLQ, MLFQ) | Algorithm Lab simulator with Gantt chart and metrics | Simulated |
| Preemption and context saving | Round Robin suspends a file mid-read and saves its cursor (open file handle + hash state), then resumes it later on any worker | Real |
| Process state model | Five-state model (new, ready, running, waiting, terminated) with a PCB table | Simulated |
| Synchronisation: mutex, semaphore, monitor | Engine state guarded by a mutex and condition variable; Lab interpreter for semaphores, mutexes and Mesa monitors | Real and simulated |
| Classic problems | Producer–consumer, readers–writers, dining philosophers, race condition | Simulated |
| Deadlock | Banker's algorithm (safety and request), resource-allocation graph with detection | Simulated |
| Memory management | Page replacement (FIFO, LRU, Optimal), paging translation, segmentation, first/best/worst fit | Simulated |
| Memory monitoring | Used, available, page file and FlowDesk's own working set | Real |
| Disk scheduling | FCFS, SSTF, SCAN, C-SCAN, LOOK, C-LOOK | Simulated |
| I/O buffering | No buffering, single, double and circular buffering timelines | Simulated |
| File systems | Contiguous, linked and indexed allocation; real directory traversal and file I/O | Simulated and real |
| System calls and kernel structure | Traced path of a file read from user mode through the Windows NT executive, drivers and hardware | Conceptual |

**Important distinction.** FlowDesk's scheduler decides which *FlowDesk task* each of its own worker threads works on next. It does not replace the Windows kernel scheduler, which still decides when those threads run on CPU cores. The interface states this wherever scheduling policies appear.

---

## 5. System Architecture

### 5.1 Technology Stack

| Layer | Technology | Purpose |
|---|---|---|
| Interface | React 18, TypeScript, Vite, Tailwind CSS | Pages, charts, gauges, interaction |
| Desktop shell | Tauri 2 (WebView2 on Windows) | Native window, commands, events, file dialogs |
| System layer | Rust | Telemetry, worker threads, scheduling, file I/O |
| Telemetry sources | sysinfo crate, Windows PDH, NVIDIA NVML | CPU, memory, disk, GPU and sensor readings |
| Storage | SQLite (rusqlite, bundled) | Tasks, experiments, telemetry samples, events, preferences |
| Testing | Vitest (frontend), cargo test (backend) | Unit and integration tests |

### 5.2 Architecture Diagram

```
┌───────────────────────────── React frontend (WebView2) ─────────────────────────────┐
│  Overview · Live Monitor · Workspace · Algorithm Lab · Experiments · History · Settings│
│        │ stores (telemetry, engine, selection)        │ algorithm modules (pure TS)  │
└────────┼──────────────────────────────────────────────┼──────────────────────────────┘
         │ invoke(command)            ▲ events            (runs entirely in the UI)
         ▼                            │ telemetry://sample, engine://state
┌──────────────────────────────── Rust backend (Tauri) ───────────────────────────────┐
│  commands.rs ──► Engine (scheduler + worker pool) ──► file operations (ops.rs)        │
│       │                │                                   │                          │
│       │                └──── running task ids ─────► Telemetry thread (1 s)           │
│       │                                                  │  sysinfo · PDH · NVML      │
│       ▼                                                  ▼                            │
│                         SQLite database (db.rs, migrations)                           │
└───────────────────────────────────────────────────────────────────────────────────────┘
         │                                   │
         ▼                                   ▼
   Windows file system                 Windows performance counters, GPU driver
```

### 5.3 Communication

- **Commands (frontend → backend):** the interface calls typed Rust functions such as `submit_job`, `cancel_job`, `scan_folder` and `list_processes`.
- **Events (backend → frontend):** the backend pushes `telemetry://sample` once per interval and `engine://state` at most every 250 ms, so the interface is never flooded.
- **No mock data:** outside the desktop shell, every backend call fails with a clear "backend not connected" message instead of returning placeholder values.

---

## 6. Module Design

### 6.1 Telemetry Service

A dedicated thread samples the system once per interval (default 1 second, adjustable from 0.5 to 10 seconds). Each metric is a record of:

```
Metric { value, unit, source, available, note }
```

| Metric | Source | Notes |
|---|---|---|
| CPU utilisation, per-core load, frequency | sysinfo | Frequency may show the nominal value, as reported by Windows |
| Memory used, available, page file | sysinfo | FlowDesk's own working set is also recorded |
| Disk read and write throughput | PDH `\PhysicalDisk(_Total)\Disk Read/Write Bytes/sec` | Rate counters need two samples, so the first reading shows "warming up" |
| Disk active time | PDH `100 − % Idle Time` | Averaged over physical disks |
| GPU utilisation | PDH `\GPU Engine(*)\Utilization Percentage` | Busiest engine, as Task Manager reports it; works for any vendor with a WDDM 2.x driver |
| GPU temperature, power, fan, VRAM, throttling | NVIDIA NVML | Loaded at run time; other vendors show N/A |
| CPU temperature | ACPI thermal zones through WMI | Usually unreadable without administrator rights, so shown as N/A with the reason |
| System fan speed | None | Windows has no standard API; always N/A |

Samples are kept in a ring buffer of 3,600 entries for the live charts. While any task is running, each sample is also written to SQLite in long format (timestamp, metric, value, unit, source, availability), so every experiment keeps the conditions under which it ran.

### 6.2 Job Engine and Application-Level Scheduler

**Model.** Each task (job) is split into units, one per file. A fixed pool of worker threads (up to the number of logical cores, maximum 16) repeatedly asks the scheduler for the next unit. The scheduler state is protected by a mutex, and idle workers sleep on a condition variable until work arrives.

**Scheduling policies.**

| Policy | Rule for choosing the next task | OS analogue |
|---|---|---|
| FCFS | Task that was submitted first | First-Come, First-Served |
| Priority | Highest priority (P10 high … P1 low); ties by arrival. Preemptive at file boundaries | Preemptive priority scheduling |
| Round Robin | Next task in a rotating ring; each dispatch runs for at most one time quantum (5–500 ms) | Round Robin with time quantum |
| Shortest Remaining | Task with the fewest bytes left | Shortest Remaining Time First |

**Preemption with saved context.** Under Round Robin, a worker stops a file when its quantum expires. The file's *cursor*, which holds the open file handle, the bytes read so far and the partial SHA-256 state, is placed at the back of the task's ready queue. Any worker can later resume it exactly where it stopped. This mirrors how an operating system saves a process's context in its PCB on a context switch. To avoid holding too many open handles, a task that already has 32 suspended files resumes one of those before opening a new file.

**Pseudocode of a worker:**

```
loop:
    lock(engine)
    while no runnable task (or this worker is parked):
        wait(condition_variable)
    task  ← policy.pick(runnable tasks)          # FCFS / Priority / RR / SRW
    unit  ← task.ready_queue.pop_front()
    record decision (time, worker, task, reason)
    unlock(engine)

    outcome ← run_unit(unit, budget = quantum if RR else ∞)
             # reads 256 KiB chunks, checks pause/cancel flags between chunks

    lock(engine)
    apply(outcome)   # done / failed / skipped / preempted → requeue / paused / cancelled
    if task has no units left and no active workers: finish task
    unlock(engine); notify_all()
```

**Control.**

- *Pause* sets a flag; the running unit is suspended at its next chunk boundary and kept at the front of the queue.
- *Cancel* sets a flag, clears the queue and stops in-flight units at their next chunk; partial copies are deleted.
- *Concurrency limit* sets the most workers a single task may hold at once.

**Scheduler decision log.** Every dispatch records the policy's reason, for example "Priority: P9 is highest among 2 ready tasks" or "Round Robin: next in rotation (50 ms quantum); resuming preempted file". The log is shown live in the Workspace, so the student can see the algorithm making its decisions.

**Metrics recorded per task:** files done, failed and skipped; bytes processed; elapsed time; response time (submission to first dispatch); number of preemptions; average throughput.

### 6.3 File Operations

| Operation | What it does | Output |
|---|---|---|
| SHA-256 hashing | Streams each file through SHA-256 | JSON and CSV manifest of path, size and hash |
| File indexing | Records path, size, modified/created time and read-only flag (no content read) | JSON and CSV index |
| Duplicate detection | Hashes only files whose size matches another file, then groups identical hashes | Duplicate groups and reclaimable space |
| Metadata analysis | Extension, size and age distributions; largest files | Summary report |
| Safe file copy | Copies to a temporary `.flowdesk-part` file, verifies the SHA-256 of the copy, then renames it. Never overwrites an existing file | Copied tree and hash manifest |

Compression and backup are shown in the interface but disabled, because they are not implemented.

### 6.4 Algorithm Lab

Each algorithm is a separate, pure TypeScript module with unit tests. The interface uses shared components (step player, Gantt chart, block map, metric tiles) for all of them. Every Lab page carries a "Simulation" badge.

| Category | Algorithms and features |
|---|---|
| CPU scheduling | FCFS, SJF, SRTF, Priority (non-preemptive and preemptive), Round Robin, Multilevel Queue, Multilevel Feedback Queue. Editable process table with arrival, burst, priority, queue and optional I/O burst. Shows ready queues, running and blocked processes, Gantt chart, waiting, turnaround and response times, throughput, context switches and CPU utilisation. Compares all algorithms on the same input. Can import processes from the largest files of a scanned folder. |
| Process management | Five-state model with legal transitions only, single running process, PCB table (PID, parent, state, saved PC, priority, CPU time, dispatches) |
| Concurrency | Deterministic thread interpreter with counting semaphores, mutexes and Mesa monitors. Producer–consumer (semaphore and monitor versions), readers–writers (reader and writer preference), dining philosophers (naive, resource ordering, waiter), race condition on a shared counter with no protection, mutex, semaphore or monitor |
| Deadlocks | Banker's safety algorithm and resource-request algorithm; resource-allocation graph with a detection algorithm and wait-for cycle highlighting |
| Memory management | FIFO, LRU and Optimal page replacement (with Belady's anomaly); paging address translation with bit breakdown; segmentation with limit checks; first, best and worst fit for dynamic and fixed partitions |
| Disk scheduling | FCFS, SSTF, SCAN, C-SCAN, LOOK, C-LOOK with head-movement plot; I/O buffering timelines (none, single, double, circular) |
| File systems | Contiguous, linked and indexed allocation on a block map, with directory entries, fragmentation and access cost |
| OS architecture | Windows NT layer diagram and step-by-step traces of a file read, a performance-counter query and a thread preemption |

**Conventions used by the CPU simulator** (shown to the user):

- Lower priority number means higher priority.
- At the same time instant, new arrivals join the ready queue before a process whose quantum just expired.
- Waiting time is the time spent in a ready queue; blocked I/O time is excluded.
- A context switch is counted each time the CPU starts a different process from the one it last ran.

Formulas:

```
Turnaround time = Completion time − Arrival time
Waiting time    = time spent in the ready queue
Response time   = First run time − Arrival time
Throughput      = Number of processes ÷ Makespan
CPU utilisation = Busy time ÷ Makespan
```

### 6.5 Database Design

The schema version is tracked with SQLite's `PRAGMA user_version`, and migrations run in a transaction at start-up. Tasks that were running when the application closed are marked `interrupted` on the next launch.

| Table | Key columns | Purpose |
|---|---|---|
| `jobs` | id, name, op, folder, dest, policy, priority, workers, quantum_ms, status, created_at, started_at, ended_at, files_done, files_failed, files_skipped, bytes_done, response_ms, preemptions, report_path, summary | One row per task or experiment |
| `telemetry_samples` | job_id, ts, metric, value, unit, source, available | Measurements taken while a task ran |
| `job_events` | job_id, ts, level, message | Submission, pause, errors, completion |
| `preferences` | key, value | Settings such as the telemetry interval and engine configuration |

Deleting a task removes its samples and events automatically (`ON DELETE CASCADE`). An index on `(job_id, metric, ts)` keeps experiment queries fast.

---

## 7. User Interface Design

The interface uses a dark, industrial control-room style: graphite panels, steel borders, amber highlights, green for healthy states and red only for critical ones. Numbers, process IDs, paths and timestamps use a monospace font. Colours for metric series were checked for colour-blind separation, and status colours are never reused as series colours.

| Page | Contents |
|---|---|
| Overview | CPU, memory, disk and GPU gauges with trend lines and data sources; thermal and power panel; the execution pipeline (INPUT → SCHEDULER → WORKERS → FILE PROCESSOR → OUTPUT); active task with pause, resume and cancel; live charts with 1/5/15/60-minute ranges; current tasks and recent experiments |
| Live Monitor | Searchable, sortable process table with detail panel; per-core CPU; memory with top processes; disk throughput and active time; GPU charts and a sensor availability table |
| Workspace | Five steps: native folder picker and scan, operation choice, scheduling configuration, review and start, live progress with the scheduler decision log |
| Algorithm Lab | Eight categories, each with input, step-by-step execution, metrics and an explanation |
| Experiments | Search, filters, sorting, detailed inspection with telemetry charts, side-by-side comparison of up to four runs, CSV export, and "repeat run" with identical settings |
| History | Day-by-day log of every task with its event messages |
| Settings | Telemetry interval, default chart range, reduced motion, system information, database and report locations |

Design rules followed:

- The pipeline animates only while the backend reports real progress, and it stops when the system is idle.
- The operating system's reduced-motion setting is respected, and there is also an in-app switch.
- Every unavailable reading shows "N/A" with the reason on hover.
- The top status strip is driven by real state: monitoring status, telemetry feed, running and waiting tasks, time of the last sample and number of available sensors.

---

## 8. Implementation Details

### 8.1 Project Structure

```
OS/
├── src/                          React frontend
│   ├── lib/backend.ts            typed command bridge
│   ├── lib/telemetry/            telemetry store and chart helpers
│   ├── lib/engine/               engine store and folder selection
│   ├── lib/algorithms/           cpu, memory, deadlock, concurrency, disk,
│   │                             filesystem, process + algorithms.test.ts
│   ├── components/industrial/    Panel, Gauge, LED, Readout, Progress …
│   ├── components/charts/        TimeSeriesChart, Sparkline
│   └── pages/                    Overview, LiveMonitor, Workspace, Experiments,
│                                 History, Settings, lab/*
└── src-tauri/src/                Rust backend
    ├── telemetry/                sampler, pdh.rs, gpu.rs
    ├── engine/                   scheduler + workers (mod.rs), ops.rs
    ├── scan.rs                   folder traversal
    ├── db.rs                     SQLite and migrations
    └── commands.rs               Tauri commands
```

### 8.2 Notable Implementation Points

- **Thread safety.** Engine state is held in one `Mutex` with a `Condvar`. Per-task counters that change on every chunk (bytes done, cancel and pause flags) are atomics, so progress can be read without taking the lock.
- **Event throttling.** A separate emitter thread sends the engine snapshot at most four times a second. It computes processing rates with an exponentially weighted moving average and estimates remaining time only after two seconds of data.
- **Safety limits.** Folder scans stop at 250,000 files; a copy destination inside the source folder (or containing it) is refused; worker count and quantum are clamped to safe ranges.
- **Cleanup on cancel.** A suspended copy cursor deletes its temporary file when it is dropped, so a cancelled copy never leaves partial files.
- **Efficient charts.** Charts are drawn as lightweight SVG with a hover crosshair and tooltip, so updating once per second does not slow file processing.

---

## 9. Testing and Results

### 9.1 Test Environment

| Item | Value |
|---|---|
| Operating system | Windows 11 Home Single Language |
| Processor | 12 logical cores |
| Memory | 15.3 GB |
| GPU | NVIDIA GeForce RTX 3050 Laptop GPU |
| Toolchain | Node.js 22, Rust 1.99, Tauri 2.12 |

### 9.2 Automated Tests

| Suite | Tests | Result |
|---|---|---|
| Algorithm unit tests (Vitest) | 26 | All passed |
| Backend tests (cargo test) | 8 | All passed |
| TypeScript type check and production build | — | Passed, no errors |
| Rust compiler warnings | — | None |

**Backend tests cover:** SHA-256 of "abc" against the standard test vector; preemption and resumption giving the same hash; verified copy and no-overwrite rule; cancelled copy deleting its partial file; FCFS running tasks in arrival order; Priority running the higher-priority task first; Round Robin preempting and interleaving two tasks; cancellation stopping a running task; and the database marking a running task as interrupted after a simulated restart.

### 9.3 Algorithm Verification Against Textbook Answers

**CPU scheduling** on the process set P1 (arrival 0, burst 7), P2 (2, 4), P3 (4, 1), P4 (5, 4):

| Algorithm | Completion times (P1, P2, P3, P4) | Average waiting time | Average turnaround |
|---|---|---|---|
| FCFS | 7, 11, 12, 16 | 4.75 | 8.75 |
| SJF | 7, 12, 8, 16 | 4.00 | 8.00 |
| SRTF | 16, 7, 5, 11 | 3.00 | 7.00 |
| Round Robin (q = 2) | 16, 9, 7, 15 | — | — |

SRTF Gantt chart produced: P1 (0–2), P2 (2–4), P3 (4–5), P2 (5–7), P4 (7–11), P1 (11–16), which matches the standard solution.

**Other algorithms:**

| Test | Input | Expected | FlowDesk result |
|---|---|---|---|
| Page replacement, 3 frames | 7 0 1 2 0 3 0 4 2 3 0 3 2 1 2 0 1 7 0 1 | FIFO 15, LRU 12, Optimal 9 faults | 15, 12, 9 |
| Belady's anomaly (FIFO) | 1 2 3 4 1 2 5 1 2 3 4 5 | 3 frames: 9 faults, 4 frames: 10 | 9, 10 |
| Banker's algorithm | Available (3, 3, 2), 5 processes | Safe; sequence P1, P3, P4, P0, P2 | Same |
| Banker's request | P1 requests (1, 0, 2) | Granted | Granted |
| Disk scheduling, head 53 | 98 183 37 122 14 124 65 67 | FCFS 640, SSTF 236, SCAN 331, C-SCAN 382, LOOK 299, C-LOOK 322 | Same |
| Fixed partitions | 100 500 200 300 600; requests 212 417 112 426 | First fit cannot place 426; best fit places all | Same |
| Dining philosophers, naive, lock-step | 5 philosophers | Deadlock | Deadlock detected |
| Race condition, no lock | 3 threads × 5 increments | Lost updates | Lost updates; zero with mutex, semaphore or monitor |
| Producer–consumer and readers–writers | Several seeds | No invariant violations | 0 violations |

### 9.4 Real Workload Results

These runs were made in the running application on the test machine.

| Run | Operation | Policy | Files | Data | Time | Outcome |
|---|---|---|---|---|---|---|
| 1 | SHA-256 hashing | FCFS | 3,866 | 789.8 MB | 23.4 s (33.8 MB/s) | Completed |
| 3 | SHA-256 hashing | Round Robin, q = 50 ms | 3 | 7.1 MB | 117 ms (61.0 MB/s) | Completed, 3 preemptions |
| 4 | Safe copy | Round Robin, q = 20 ms, 2 workers | 227 | 314 MB | — | Completed, 1,182 preemptions |
| 5 | SHA-256 hashing, run alongside run 4 | Round Robin | 227 (cancelled) | 15.5 MB of 314 MB | — | Cancelled as requested |

Observations:

- **Round Robin interleaving was real.** Runs 4 and 5 progressed together (about 4% each after 0.7 seconds), and the decision log showed the scheduler rotating between them.
- **Cancellation worked.** Run 5 stopped within one chunk and was saved in the database as `cancelled`; a partial report was still written.
- **Copy safety was verified.** All 227 copied files were byte-identical to the originals (checked with SHA-256), and no temporary `.flowdesk-part` files remained.
- **Telemetry was recorded during run 1:** 23 one-second samples per metric. Average system CPU was 63.6%, FlowDesk's own CPU 9.8%, disk read 39.1 MB/s, disk active time 23.8%, GPU temperature 62 °C and GPU power 10.5 W.
- **Unavailable sensors were handled honestly.** CPU temperature was recorded as unavailable in all 23 samples instead of being estimated, and system fan speed is always shown as N/A.

These system-wide measurements describe what was observed while a task ran. Other programs also use the CPU and disk, so the measurements alone do not prove that a scheduling policy caused a change. The Experiments page states this limitation next to every comparison.

---

## 10. Limitations and Future Work

### 10.1 Limitations

- CPU temperature is usually unavailable without administrator rights, and fan speed cannot be read through a standard Windows API.
- GPU temperature, power and fan readings are supported only for NVIDIA GPUs; utilisation works for all vendors.
- CPU usage can be attributed to the FlowDesk process as a whole, not to an individual task.
- Compression and backup operations are not implemented.
- The Algorithm Lab models context-switch cost as zero.
- On smaller screens the Overview page needs some vertical scrolling.

### 10.2 Future Work

- Add compression (e.g. zstd) and incremental backup operations.
- Read CPU package temperature through a signed driver or vendor library when running with elevated rights.
- Support AMD and Intel GPU sensors through their vendor libraries.
- Add aging to the Priority policy to prevent starvation, and an I/O-aware policy that separates disk-bound from CPU-bound tasks.
- Allow a configurable context-switch cost in the CPU simulator.
- Add statistical comparison of repeated runs (mean and spread over several trials).

---

## 11. Conclusion

FlowDesk shows that operating-system concepts can be studied on the computer itself rather than only on paper. The project implemented a real application-level scheduler with four policies, preemption that saves and restores a file's processing state, and pause and cancel controls, all running on a thread pool synchronised with a mutex and condition variable. A telemetry service measures the effect on the hardware and labels each reading with its source or a reason for its absence. The Algorithm Lab reproduces standard textbook results for scheduling, page replacement, Banker's algorithm and disk scheduling, and makes synchronisation problems such as deadlock and race conditions visible step by step.

Building the project reinforced the core lesson of the course: an operating system is a set of policies (which process runs, which page is evicted, which request is served) built on mechanisms (context switching, locks, interrupts), and the choice of policy has measurable consequences for throughput, response time and fairness.

---

## 12. References

1. A. Silberschatz, P. B. Galvin and G. Gagne, *Operating System Concepts*, 10th ed., Wiley, 2018.
2. A. S. Tanenbaum and H. Bos, *Modern Operating Systems*, 4th ed., Pearson, 2015.
3. W. Stallings, *Operating Systems: Internals and Design Principles*, 9th ed., Pearson, 2018.
4. P. Yosifovich, A. Ionescu, M. E. Russinovich and D. A. Solomon, *Windows Internals, Part 1*, 7th ed., Microsoft Press, 2017.
5. R. H. Arpaci-Dusseau and A. C. Arpaci-Dusseau, *Operating Systems: Three Easy Pieces*, Arpaci-Dusseau Books, 2018.
6. Microsoft, "Performance Counters (PDH)", Windows App Development documentation.
7. NVIDIA, "NVIDIA Management Library (NVML) API Reference".
8. Tauri Contributors, "Tauri 2 Documentation", tauri.app.
9. SQLite Consortium, "SQLite Documentation", sqlite.org.

---

## 13. Appendix: Running the Project

**Requirements:** Windows 10 or 11, Node.js 18 or later, Rust (stable, MSVC toolchain), Visual Studio Build Tools with C++, and WebView2 (preinstalled on Windows 11).

```sh
npm install                  # install frontend dependencies
npm run tauri dev            # start the desktop application
npm test                     # run the 26 algorithm tests
cd src-tauri && cargo test   # run the 8 backend tests
npm run tauri build          # build the Windows installer
```

Data locations:

- Database: `%APPDATA%\dev.flowdesk.observatory\flowdesk.sqlite`
- Reports: `%APPDATA%\dev.flowdesk.observatory\reports\`
