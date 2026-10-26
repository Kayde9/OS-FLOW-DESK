# FlowDesk — Algorithms and Formulas

This guide explains every algorithm in FlowDesk, with the formulas, the exact conventions the simulators use, and a worked example for each. It follows the code in `src/lib/algorithms/` (Algorithm Lab, **simulated**), `src-tauri/src/engine/` (the real job scheduler) and `src-tauri/src/trace/` (the Observatory).

**Contents**

1. [CPU scheduling](#1-cpu-scheduling)
2. [Process management](#2-process-management-five-state-model)
3. [Synchronisation](#3-synchronisation-and-concurrency)
4. [Deadlocks](#4-deadlocks)
5. [Memory management](#5-memory-management)
6. [Disk scheduling](#6-disk-scheduling)
7. [I/O buffering](#7-io-buffering)
8. [File allocation](#8-file-allocation)
9. [FlowDesk's real job scheduler](#9-flowdesks-real-job-scheduler)
10. [Telemetry and trace formulas](#10-telemetry-and-trace-formulas)

---

## 1. CPU scheduling

The CPU scheduler picks which ready process runs next. The simulator advances in discrete time, one unit per tick.

### 1.1 Metrics (all algorithms)

| Metric | Formula |
|---|---|
| Completion time `CT` | time the process finishes |
| Turnaround time `TAT` | `CT − Arrival` |
| Waiting time `WT` | time spent in a ready queue. With no I/O this equals `TAT − Burst`. Time blocked on I/O is **not** counted. |
| Response time `RT` | `First run time − Arrival` |
| Average waiting / turnaround / response | `(Σ value) / n` |
| Makespan | `max(CT)` over all processes |
| Throughput | `n / Makespan` |
| CPU utilisation | `Busy time / Makespan` |
| Context switches | counted each time the CPU starts a process different from the one it last ran (the first dispatch is not counted) |

### 1.2 Conventions used by the simulator

- A **lower priority number means higher priority**.
- At the same instant, queue order is: new arrivals, then processes returning from I/O, then a process whose quantum just expired.
- Ties are broken by arrival time, then by input order.
- Context-switch cost is zero.
- An optional I/O burst blocks a process after it has executed `io.at` units, for `io.duration` ticks.

### 1.3 The algorithms

| Algorithm | Selection rule | Preemptive? | Notes |
|---|---|---|---|
| **FCFS** | oldest arrival in the ready queue | No | Simple. Suffers the *convoy effect*: short jobs wait behind a long one. |
| **SJF** | smallest *burst* among ready processes | No | Minimises average waiting time among non-preemptive policies. Can starve long jobs. |
| **SRTF** | smallest *remaining* time; checked every tick | Yes | Preemptive SJF. Optimal for average waiting time, but also starves long jobs. |
| **Priority (non-preemptive)** | best (lowest-numbered) priority | No | Can starve low-priority processes. |
| **Priority (preemptive)** | best priority; a better arrival preempts the runner | Yes | Aging (raising priority over time) is the standard cure for starvation. FlowDesk's simulator does not age. |
| **Round Robin (RR)** | FIFO queue; each process runs at most one quantum `q` | Yes | A large `q` behaves like FCFS. A tiny `q` wastes time on switches. Good response time. |
| **Multilevel Queue (MLQ)** | 2 fixed queues: Q0 is RR with quantum `q`, Q1 is FCFS. Q0 has strict priority over Q1 | Yes | A process's queue is fixed by its `queue` field. Q1 can starve. |
| **Multilevel Feedback Queue (MLFQ)** | 3 queues: Q0 (RR, `q₀`), Q1 (RR, `q₁`), Q2 (FCFS). New processes enter Q0. Using a full quantum **demotes** a process one level | Yes | Favours short, interactive jobs. Defaults `q₀ = 2`, `q₁ = 4`. A higher-level arrival preempts a lower level. |

Preemption tests:

```
SRTF:        preempt if  ∃ ready s :  s.remaining < running.remaining
Priority-P:  preempt if  ∃ ready s :  s.priority  < running.priority
MLQ/MLFQ:    preempt if  any queue above the running process's level is non-empty
```

### 1.4 Worked example

Processes `P1 (arrival 0, burst 7)`, `P2 (2, 4)`, `P3 (4, 1)`, `P4 (5, 4)`. These are the numbers checked by the unit tests.

| Algorithm | Completion (P1, P2, P3, P4) | Avg waiting | Avg turnaround |
|---|---|---|---|
| FCFS | 7, 11, 12, 16 | 4.75 | 8.75 |
| SJF | 7, 12, 8, 16 | 4.00 | 8.00 |
| SRTF | 16, 7, 5, 11 | 3.00 | 7.00 |
| Round Robin, `q = 2` | 16, 9, 7, 15 | — | — |

FCFS check: waiting times are `0, 5, 7, 7`, so `(0+5+7+7)/4 = 4.75`. SRTF Gantt chart: `P1 (0–2) · P2 (2–4) · P3 (4–5) · P2 (5–7) · P4 (7–11) · P1 (11–16)`.

---

## 2. Process management (five-state model)

A process moves between five states. Only one process can be RUNNING on a single CPU.

| Transition | From → To | Meaning |
|---|---|---|
| Admit | NEW → READY | the OS accepts the process |
| Dispatch | READY → RUNNING | the scheduler loads its PCB onto the CPU (fails if another process is already running) |
| Interrupt / timeout | RUNNING → READY | quantum expired or pre-empted; context saved |
| I/O or event wait | RUNNING → WAITING | blocks on a device or event |
| I/O or event completion | WAITING → READY | the awaited event happened |
| Exit | RUNNING → TERMINATED | the process finishes |

Illegal transitions (for example waking a READY process) are rejected.

The **Process Control Block (PCB)** holds: PID, parent PID, state, saved program counter, priority, CPU time and dispatch count. In the simulator, saving context after a run adds `+4` to the PC and `+1` to CPU time. These are simulated values, as the Lab states.

---

## 3. Synchronisation and concurrency

A **race condition** happens when the result depends on how threads interleave. A **critical section** is code that must run by one thread at a time. A correct solution needs mutual exclusion, progress and bounded waiting.

### 3.1 Primitives (the Lab's deterministic interpreter)

| Primitive | Operations | Meaning |
|---|---|---|
| **Counting semaphore** `S` | `wait(S)`: if `S > 0` then `S ← S − 1`, else block. `signal(S)`: wake one waiter, else `S ← S + 1` | `S` counts free resources |
| **Mutex** | `lock`, `unlock` | a binary lock with an owner |
| **Mesa monitor** | `wait(c)` releases the monitor lock and sleeps; `signal(c)` wakes one waiter, which must **re-acquire the lock** before continuing | Because the condition may change before the woken thread runs, always re-check it with `while`, not `if` |

Each step executes one instruction of one thread, chosen by a seeded random or round-robin interleaving, so every run is reproducible.

### 3.2 Classic problems

**Race on a shared counter.** `T` threads each do `N` increments of `counter ← counter + 1`, which is really load, add, store.

```
expected = T × N
lost     = expected − final
```

With no protection updates are lost. With a mutex, a binary semaphore or a monitor, `lost = 0`.

**Producer–consumer (bounded buffer of size `B`).**

```
semaphores:  empty = B,  full = 0,  mutex = 1
producer:  wait(empty); wait(mutex); put(item); signal(mutex); signal(full)
consumer:  wait(full);  wait(mutex); get();     signal(mutex); signal(empty)
```

Invariants checked: `0 ≤ items in buffer ≤ B`, and no item is lost or duplicated. The monitor version uses `notFull` and `notEmpty` condition variables with `while` loops.

**Readers–writers.** Many readers may read at once, but a writer needs exclusive access.

- *Reader preference*: a counter `readcount` guarded by `mutex`; the first reader locks `rw`, the last unlocks it. Writers can starve.
- *Writer preference*: a waiting writer blocks new readers (extra `readTry`, `rmutex` and `wmutex` semaphores). Readers can starve.

**Dining philosophers (n philosophers, n forks).**

| Strategy | Rule | Result |
|---|---|---|
| Naive | each picks left fork, then right | Can **deadlock** when all hold their left fork (circular wait) |
| Resource ordering | always pick the lower-numbered fork first | Breaks circular wait, so no deadlock |
| Waiter | a `room` semaphore initialised to `n − 1` | At most `n − 1` compete, so someone always eats |

The four deadlock conditions are mutual exclusion, hold and wait, no preemption and circular wait. Removing any one prevents deadlock.

---

## 4. Deadlocks

### 4.1 Banker's algorithm (avoidance)

Notation: `n` processes, `m` resource types.

```
Available[m]      free instances of each resource
Max[n][m]         most each process may ever request
Allocation[n][m]  currently held
Need[n][m]  =  Max − Allocation
```

**Safety algorithm.** The state is *safe* if the processes can all finish in some order.

```
Work   ← Available
Finish[i] ← false for all i
repeat:
    find i with Finish[i] = false  and  Need[i] ≤ Work     (component-wise)
    Work ← Work + Allocation[i];   Finish[i] ← true;   append i to the sequence
until no such i exists
safe  ⇔  Finish[i] = true for all i
```

The simulator scans processes in index order on each pass, so its safe sequence is deterministic.

**Resource-request algorithm** (process `Pᵢ` asks for `Request`):

1. If `Request > Need[i]` → error (more than declared).
2. If `Request > Available` → `Pᵢ` must wait.
3. Pretend to allocate:
   `Available −= Request`, `Allocation[i] += Request`, `Need[i] −= Request`.
4. Run the safety algorithm. If safe → **grant**; otherwise **deny** and restore the state.

**Worked example.** `Available = (3, 3, 2)`, five processes:

| | Allocation | Max | Need |
|---|---|---|---|
| P0 | 0 1 0 | 7 5 3 | 7 4 3 |
| P1 | 2 0 0 | 3 2 2 | 1 2 2 |
| P2 | 3 0 2 | 9 0 2 | 6 0 0 |
| P3 | 2 1 1 | 2 2 2 | 0 1 1 |
| P4 | 0 0 2 | 4 3 3 | 4 3 1 |

Pass 1: P1 fits `(1,2,2) ≤ (3,3,2)`, so `Work = (5,3,2)`. P3 fits, so `Work = (7,4,3)`. P4 fits, so `Work = (7,4,5)`. Pass 2: P0 fits, then P2. Safe sequence: **⟨P1, P3, P4, P0, P2⟩**. A request `P1 = (1,0,2)` is within Need and Available and leaves a safe state, so it is **granted**.

### 4.2 Deadlock detection (resource-allocation graph)

For multi-instance resources, detection is the safety algorithm with *Request* in place of *Need*:

```
Available[j] = Instances[j] − Σᵢ Allocation[i][j]
Work ← Available;  Finish[i] ← (Allocation[i] is all zero)
repeat: find i with ¬Finish[i] and Request[i] ≤ Work
        Work += Allocation[i];  Finish[i] ← true
deadlocked processes  =  { i : ¬Finish[i] }
```

For visualisation the simulator also builds a **wait-for graph**: an edge `Pᵢ → Pₖ` exists when `Pᵢ` requests a resource that `Pₖ` holds. A depth-first search finds a cycle. With single-instance resources a cycle means deadlock; with multiple instances it is necessary but not sufficient, which is why the Work/Finish test decides.

---

## 5. Memory management

### 5.1 Page replacement

A **page fault** occurs when the referenced page is not in a frame. When all frames are full a victim is chosen.

| Algorithm | Victim |
|---|---|
| **FIFO** | the page that was loaded earliest |
| **LRU** | the page whose last use is oldest |
| **Optimal (OPT)** | the page whose next use is farthest in the future (or never). Not implementable in real systems; it is the benchmark. |

```
Hits      = references − faults
Hit ratio = hits / references          Fault rate = faults / references
```

**Belady's anomaly:** with FIFO, adding frames can *increase* faults. LRU and OPT are stack algorithms and never show it.

**Worked examples.**

- Reference string `7 0 1 2 0 3 0 4 2 3 0 3 2 1 2 0 1 7 0 1` with 3 frames: **FIFO 15, LRU 12, OPT 9** faults.
- Reference string `1 2 3 4 1 2 5 1 2 3 4 5` under FIFO: **9 faults with 3 frames, 10 with 4 frames**. This is Belady's anomaly.

### 5.2 Paging (address translation)

The logical address splits into page number and offset. The page size must be a power of two.

```
page   = ⌊ logical / pageSize ⌋
offset =   logical mod pageSize
offsetBits = log₂(pageSize)
physical = frame × pageSize + offset
```

If `page` is beyond the page table the hardware traps. If the entry is marked invalid it is a page fault. Example: page size 1024, logical 3000 → page 2, offset 952; if page 2 maps to frame 7, `physical = 7 × 1024 + 952 = 8120`.

### 5.3 Segmentation

Each segment has a `base` and a `limit`.

```
if offset ≥ limit  →  trap (segmentation violation)
physical = base + offset
```

### 5.4 Contiguous allocation

| Policy | Chooses the hole that is … |
|---|---|
| **First fit** | the first one large enough (lowest address) |
| **Best fit** | the smallest one large enough (least leftover) |
| **Worst fit** | the largest (biggest leftover) |

- **Dynamic partitions:** the chosen hole is split, and freed holes next to each other are merged.

  ```
  External fragmentation = 1 − (largest hole / total free memory)      (0 = all free memory contiguous)
  ```

- **Fixed partitions:** each partition holds at most one process; the wasted space inside is **internal fragmentation**.

  ```
  Internal fragmentation = Σ (partition size − process size)
  ```

**Worked example.** Partitions `100 500 200 300 600`; requests `212 417 112 426`.

- First fit: 212→500, 417→600, 112→200, and **426 cannot be placed**.
- Best fit: 212→300, 417→500, 112→200, 426→600, so **all are placed**.

---

## 6. Disk scheduling

The disk arm moves between cylinders; **seek time is proportional to distance**, so the goal is to minimise head movement.

```
Total head movement = Σ |positionᵢ − positionᵢ₋₁|
Average seek        = Total head movement / number of requests
```

| Algorithm | Behaviour |
|---|---|
| **FCFS** | serve in arrival order. Fair but can zig-zag. |
| **SSTF** | always serve the nearest request. Low movement, but can starve distant requests. |
| **SCAN** (elevator) | sweep in one direction to the **end of the disk**, then reverse |
| **C-SCAN** | sweep to the end, jump to the other end, sweep the same direction again (more uniform waiting) |
| **LOOK** | like SCAN but reverse at the **last request**, not the disk end |
| **C-LOOK** | like C-SCAN but jump only to the farthest pending request |

The Lab lets you choose the disk size, the initial direction, and whether the C-SCAN/C-LOOK return jump counts as head movement. The results below count it.

**Worked example.** 200 cylinders, head at 53, moving up, requests `98 183 37 122 14 124 65 67`:

| Algorithm | Total movement |
|---|---|
| FCFS | 640 |
| SSTF | 236 |
| SCAN | 331 (`53→199→14`) |
| C-SCAN | 382 (`53→199`, jump to 0, `→37`) |
| LOOK | 299 (`53→183→14`) |
| C-LOOK | 322 (`53→183`, jump to 14, `→37`) |

---

## 7. I/O buffering

Reading a block takes `T` (device time into a system buffer), then `M` (copy to user space), then the process computes for `C[i]`. With `k` buffers, the device may fill block `i` once the buffer used by block `i − k` has been copied out.

```
fillStart[i]    = max( fillEnd[i−1],  copyEnd[i−k] )
fillEnd[i]      = fillStart[i] + T
copyStart[i]    = max( fillEnd[i],    computeEnd[i−1] )
copyEnd[i]      = copyStart[i] + M
computeEnd[i]   = copyEnd[i] + C[i]

Total time        = computeEnd[last]
Device utilisation = (blocks × T) / Total
CPU idle time     = Total − Σ (copy time + compute time)
```

| Scheme | Buffers | Effect |
|---|---|---|
| **None** | 0 | The device reads straight into user space and the CPU waits: `Total = Σ (T + C[i])`. |
| **Single** | 1 | Reading block *i+1* overlaps only with computing *i* in a limited way. |
| **Double** | 2 | While one buffer is consumed, the device fills the other. |
| **Circular** | `k ≥ 2` (default 4) | Smooths bursts when `T` and `C` vary. |

---

## 8. File allocation

| Method | Layout | Strengths | Weaknesses |
|---|---|---|---|
| **Contiguous** | one run of consecutive blocks (first fit over free runs) | Fast sequential and direct access. Needs only start and length. | External fragmentation. Files cannot grow easily. |
| **Linked** | each block points to the next | No external fragmentation. Easy to grow. | Slow direct access. Pointer overhead. Fragile if a pointer is lost. |
| **Indexed** | one index block lists all data blocks | Direct access, no external fragmentation | Index-block overhead, with a size limit per index block |

```
Disk reads to reach logical block k (directory entry already in memory):
   contiguous : 1
   linked     : k + 1
   indexed    : 2          (index block + data block)

Blocks needed for a file of s data blocks:   contiguous s,   linked s,   indexed s + 1
Linked pointers                               = Σ (size − 1) over all files
```

The Lab reports free runs, the largest free run (to show fragmentation), and the pointer or index overhead.

---

## 9. FlowDesk's real job scheduler

Unlike the Lab, this is **real** (`src-tauri/src/engine/`): worker threads process real files. Each task is split into one **unit** per file. Idle workers take the next unit from the task the policy selects. This schedules FlowDesk's own tasks only; Windows still schedules the worker threads onto CPU cores.

| Policy | Task chosen |
|---|---|
| **FCFS** | smallest submission sequence number |
| **Priority** | highest `priority` (P10 highest); ties by arrival. Takes effect at the next file boundary |
| **Round Robin** | next task in the rotating ring. A unit runs for at most the quantum (5–500 ms), then its cursor is saved and requeued |
| **Shortest Remaining** | fewest bytes left: `remaining = bytesTotal − bytesDone − bytesWrittenOff` |

**Preemption with saved context.** When a Round Robin quantum expires, the open file handle, bytes read and partial SHA-256 state (the *cursor*) go to the back of the task's queue. Any worker can resume the file exactly where it stopped, the way an OS keeps a process's state in its PCB. A task with 32 suspended files resumes one before opening another, to bound open handles.

**Per-task metrics:**

```
Response time = first dispatch − submission
Progress      = (bytesDone + bytesWrittenOff) / bytesTotal    (file count for index/metadata tasks)
Throughput    = bytesDone / elapsed
```

Synchronisation inside the engine: scheduler state sits behind one `Mutex`, workers sleep on a `Condvar`, and per-chunk counters (bytes done, pause and cancel flags) are atomics.

---

## 10. Telemetry and trace formulas

**Telemetry (real measurements).**

```
Disk active time (%)  = 100 − PDH "% Idle Time"            (clamped to 0–100)
GPU utilisation (%)   = busiest GPU engine, summed over processes (as Task Manager does)
Process CPU (%)       = sysinfo process CPU / logical cores
Memory used           = total − available   (GlobalMemoryStatusEx)
```

**Job progress rates.**

```
rate  ←  rate + α · (instantaneous − rate),     α = min(1, Δt / 2 s)     (exponential moving average)
ETA   =  remaining / rate         (shown only after 2 s of data)
```

**Observatory (ETW) derived values.**

```
Request duration  = OperationEnd timestamp − request timestamp      (matched by IRP; unmatched requests have no duration)
Events per second = Δ captured events / Δ time                      (from the backend counter)
p50 / p95 / max   = nearest-rank percentile:  sorted[ ⌈ p/100 × N ⌉ − 1 ]
```

An **IRP** is the I/O request packet, the Windows structure that identifies one I/O request from start to completion.

---

### What is real and what is simulated

| Section | Nature |
|---|---|
| 1–8 | **Simulation** in the Algorithm Lab, labelled as such. They reproduce the textbook results above. |
| 9 | **Real** scheduling of FlowDesk's own tasks on a thread pool. |
| 10 | **Real** measurements from this computer. |
