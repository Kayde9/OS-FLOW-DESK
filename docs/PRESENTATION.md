# FlowDesk — Presentation Script (3 Presenters)

**Project:** FlowDesk: An Operating Systems Observatory, Algorithm Lab and Desktop Performance Manager
**Subject:** Operating System · **Guide:** S. Chandrasekhar · **Duration:** about 18 minutes plus questions

> Each slide has **On screen** (what goes on the slide) and **Say** (what the presenter speaks). Copy "On screen" into PowerPoint or Google Slides. Slide numbers run 1 to 21 so the work is easy to divide.

## Who presents what

| Presenter | Slides | Topic | Time |
|---|---|---|---|
| **Presenter 1** | 1–7 | Problem, architecture, real-time monitoring (telemetry) | ~6 min |
| **Presenter 2** | 8–14 | The real job scheduler, file workloads, database, live demo | ~7 min |
| **Presenter 3** | 15–21 | Algorithm Lab, System Call Observatory (ETW), limits, conclusion | ~6 min |

**Hand-offs (say these exactly):**
- 1 → 2: "I measured the machine. Now [Name 2] will show how FlowDesk puts real work on it and schedules it."
- 2 → 3: "So that is real scheduling. [Name 3] will explain the theory behind it, and how we looked at what Windows does underneath."

**Golden rule for the whole team:** FlowDesk never shows fake numbers. Say "real", "simulated" or "N/A, with the reason" for everything. This is our strongest point.

---

# PART 1 — Presenter 1 (Slides 1–7)

## Slide 1 — Title

**On screen**
- FlowDesk
- An Operating Systems Observatory, Algorithm Lab and Desktop Performance Manager
- Team names, roll numbers, guide: S. Chandrasekhar

**Say**
"Good morning, sir. Our project is FlowDesk. It is a Windows desktop application that connects operating-system theory with what really happens on a computer. Most OS topics such as scheduling, paging and deadlocks are studied on paper with small examples. We built one application where you can see them on your own machine, and also practise the classic algorithms step by step."

---

## Slide 2 — The problem

**On screen**
- Theory is learned on paper, with fixed examples
- Task Manager shows live numbers but does not explain the algorithms
- Algorithm visualisers explain algorithms but use no real data
- **Goal:** one tool that does both, honestly

**Say**
"Task Manager tells you the CPU is at 60 percent but not why, or which policy decided it. Algorithm visualisers show Round Robin but with made-up numbers. Our objective was a single tool where a student can run a real workload, watch a scheduler hand work to threads, see the hardware react, and then open the Lab and step through the same ideas. One rule: simulated values must never be presented as real."

---

## Slide 3 — What FlowDesk is: three parts

**On screen**
1. **Observatory** — real CPU, memory, disk, GPU and process measurements
2. **Performance Manager** — real file workloads on a thread pool, with our own scheduler (FCFS, Priority, Round Robin, Shortest Remaining)
3. **Algorithm Lab** — simulated, step-by-step OS algorithms (labelled "Simulation")
- Bonus: **System Call Observatory** — what Windows does underneath, using ETW

**Say**
"FlowDesk has three parts. First, an observatory that measures the real machine. Second, a manager that runs real file work, such as hashing, on worker threads with a scheduler we wrote. Third, an Algorithm Lab, which is simulation and is labelled that way everywhere. On top of these we added the System Call Observatory, which my teammate will explain."

---

## Slide 4 — Technology and architecture

**On screen**
- Frontend: React + TypeScript + Tailwind (the interface)
- Backend: **Rust** with **Tauri 2** (system layer, threads, file I/O)
- Storage: **SQLite**
- Telemetry sources: sysinfo, Windows **PDH** counters, NVIDIA **NVML**
- Diagram: UI ⇄ (commands, events) ⇄ Rust engine + telemetry thread ⇄ SQLite ⇄ Windows

**Say**
"The interface is React. The heavy work is in Rust, which gives us safe, fast threads. Tauri joins the two: the interface sends commands like start-task, and the backend pushes events like a new telemetry sample every second. Results are saved in SQLite so experiments can be compared later. Why Rust? OS-level code needs memory safety and no garbage-collector pauses while we measure performance."

---

## Slide 5 — Operating-system concepts used

**On screen** (table)

| OS concept | Where in FlowDesk | Real / simulated |
|---|---|---|
| Processes and threads | Worker thread pool, telemetry thread, process list | Real |
| CPU scheduling | Job engine; Lab simulator | Real + Simulated |
| Preemption, context saving | Round Robin saves a file's state and resumes it | Real |
| Synchronisation | Mutex and condition variable; Lab semaphores | Real + Simulated |
| Deadlock, memory, disk, file systems | Algorithm Lab | Simulated |
| I/O and file systems | Real file reads, ETW tracing | Real |

**Say**
"This table maps the syllabus to the project. The key point is the last column. FlowDesk's scheduler decides which of its own tasks a worker serves next. It does not replace the Windows kernel scheduler, which still decides when our threads run on CPU cores. We state that in the interface."

---

## Slide 6 — Real-time monitoring (telemetry)

**On screen**
- One sample every second (adjustable 0.5 to 10 s)
- Every reading carries: **value, unit, source, availability, reason**

| Metric | Source |
|---|---|
| CPU, per-core, memory | sysinfo |
| Disk throughput and active time | Windows PDH counters |
| GPU utilisation | PDH `GPU Engine` counters |
| GPU temperature, power, fan | NVIDIA NVML (NVIDIA only) |
| CPU temperature | WMI thermal zone, usually **N/A** without admin |
| Fan speed | **N/A** always: Windows has no standard API |

**Say**
"A dedicated thread samples the machine every second. Each reading says where it came from. If Windows does not provide a sensor, for example CPU temperature, we show N/A and the reason. We never estimate. Disk active time is 100 minus PDH's idle time. GPU utilisation is the busiest GPU engine, which is how Task Manager reports it."

---

## Slide 7 — The monitoring screens

**On screen** (screenshots)
- Overview: gauges for CPU, memory, disk, GPU; live charts; the execution pipeline INPUT → SCHEDULER → WORKERS → FILE PROCESSOR → OUTPUT
- Live Monitor: process table, per-core CPU, disk and GPU charts, sensor availability table

**Say**
"The Overview is the control-room view. The pipeline on it animates only when the backend reports real progress, and stops when idle. The Live Monitor shows every process, per-core load, and a table of which sensors are available on this machine. The interface is designed for dark, industrial use, and it respects the reduced-motion setting."

**Hand-off to Presenter 2.**

---

# PART 2 — Presenter 2 (Slides 8–14)

## Slide 8 — The workload model

**On screen**
- A **task** is split into **units**, one per file
- A fixed pool of **worker threads** (up to the number of cores, max 16)
- Operations: SHA-256 hashing · file indexing · duplicate detection · metadata analysis · verified safe copy
- Controls: **pause, resume, cancel**, concurrency limit

**Say**
"Every task is split into one unit per file. A pool of worker threads repeatedly asks the scheduler for the next unit. The operations are real file work. For example, hashing streams each file through SHA-256, and safe copy copies to a temporary file, verifies the hash, and only then renames it. It never overwrites an existing file."

---

## Slide 9 — The scheduling policies (real)

**On screen**

| Policy | Rule |
|---|---|
| FCFS | The task that was submitted first |
| Priority | Highest priority (P10 high, P1 low); ties by arrival |
| Round Robin | Tasks take turns; each runs at most one quantum (5–500 ms) |
| Shortest Remaining | The task with the fewest bytes left |

**Say**
"These are the four policies, and they run on real work. Priority takes effect at the next file boundary. Round Robin uses a time quantum. Shortest Remaining is the SRTF idea, measured in bytes left. The scheduler logs every decision with its reason, for example 'Priority: P9 is highest among 2 ready tasks', so the student can watch the algorithm decide."

---

## Slide 10 — Preemption with saved context

**On screen**
- Round Robin stops a file when its quantum expires
- Its **cursor** is saved: open file handle + bytes read + partial SHA-256 state
- Requeued at the back; **any worker** can resume it exactly where it stopped
- Same as an OS saving a process's context in its PCB
- Verified: a preempted hash equals an uninterrupted hash

**Say**
"This is the heart of the project. When the quantum expires, we do not restart the file. We save its state, which is the open handle, the position and the half-computed hash, and requeue it. Any worker can pick it up later. That is exactly a context switch. We tested that a hash computed with many preemptions equals the normal hash, so correctness is preserved. A real run showed 1,182 preemptions while copying 227 files."

---

## Slide 11 — Synchronisation inside the engine

**On screen**

```
loop:
  lock(engine)
  while no runnable task:  wait(condition_variable)
  task ← policy.pick()
  unit ← task.queue.pop_front()
  unlock(engine)
  run_unit(unit, budget)       # checks pause/cancel every 256 KiB
  lock(engine); apply(outcome); unlock(engine); notify_all()
```

- One **Mutex** guards the scheduler state; idle workers sleep on a **Condvar**
- Per-chunk counters (bytes done, pause/cancel flags) are **atomics**

**Say**
"All workers share the scheduler state, so it is protected by a mutex. Idle workers sleep on a condition variable, which is the same wait and signal mechanism we study in monitors. Counters that change on every chunk, like bytes done, are atomics, so the interface can read progress without taking the lock. Pause and cancel are flags checked between 256 KiB chunks."

---

## Slide 12 — Safety and persistence

**On screen**
- Cancelled copy deletes its partial file; copy never overwrites
- Destination inside the source is refused; scans stop at 250,000 files
- **SQLite** with versioned migrations: `jobs`, `telemetry_samples`, `job_events`, trace tables
- Telemetry is recorded **while a task runs**, so every experiment keeps its conditions
- Tasks running at exit are marked `interrupted` on the next start

**Say**
"We designed for safety. Cancelling a copy never leaves half-written files. The database stores each task and the telemetry measured during it, so the Experiments page can compare runs side by side and repeat a run with identical settings. We also state a limitation: system-wide numbers alone do not prove a policy caused a change, because other programs share the machine."

---

## Slide 13 — Results

**On screen**

| Run | Operation | Result |
|---|---|---|
| SHA-256, FCFS | 3,866 files, 789.8 MB | 23.4 s (about 33.8 MB/s) |
| Safe copy, Round Robin, q = 20 ms | 227 files, 314 MB | 1,182 preemptions, all files byte-identical |
| Cancel test | hashing task | stopped within one chunk, saved as `cancelled` |

- Telemetry recorded during the 23.4 s hashing run: average CPU 63.6 %, disk read about 39 MB/s
- Tests: **26** algorithm tests, **26** backend tests, **7** trace-analysis tests, all passing

**Say**
"These are measured results. Hashing about 790 MB took 23 seconds. During that run FlowDesk recorded the CPU and disk behaviour. In Round Robin, two tasks progressed together and the decision log showed the rotation. After a safe copy we checked every copied file with SHA-256, and found no temporary files left."

*(If you re-run before the presentation, say your new numbers instead and keep them consistent with the screen.)*

---

## Slide 14 — LIVE DEMO (about 2 minutes)

**Steps (Presenter 2 drives the app, Presenter 1 narrates the monitor)**
1. Open **Workspace** → select the folder → operation **SHA-256 hashing**.
2. Policy: show **Round Robin**, quantum 50 ms. Press **Start task**.
3. Show **Track progress** and the **Scheduler decisions** table (worker, task, reason).
4. Switch to **Overview**: the pipeline is animating, CPU and disk gauges move. Say "this is the machine's real reaction".
5. Press **Pause**, then **Resume**, then **Cancel** and show the status.
6. Open **Experiments** → the run is saved with its measured CPU and disk.

**If something fails:** say "the backend is not connected in this browser view, so the app shows 'not connected' instead of fake data", then move on with screenshots.

**Hand-off to Presenter 3.**

---

# PART 3 — Presenter 3 (Slides 15–21)

## Slide 15 — Algorithm Lab

**On screen**
- 8 categories, each with input, step-by-step execution, metrics and explanation
- Always badged **"Simulation"**
- CPU scheduling · Process states · Concurrency · Deadlocks · Memory · Disk · File systems · OS architecture

**Say**
"The Algorithm Lab is where theory lives. You enter the same process table you see in class and step through it one tick at a time. The Lab is simulation and says so. Its value is that the results match the textbook, which we verify in unit tests."

---

## Slide 16 — CPU scheduling formulas and verification

**On screen**

```
Turnaround = Completion − Arrival
Waiting    = time in ready queue
Response   = First run − Arrival
Throughput = n / Makespan        Utilisation = Busy / Makespan
```

Processes P1 (0,7), P2 (2,4), P3 (4,1), P4 (5,4):

| Algorithm | Avg waiting | Avg turnaround |
|---|---|---|
| FCFS | 4.75 | 8.75 |
| SJF | 4.00 | 8.00 |
| SRTF | 3.00 | 7.00 |

**Say**
"We simulate FCFS, SJF, SRTF, Priority, Round Robin, a Multilevel Queue and a Multilevel Feedback Queue. On the classic example, SRTF gives the lowest average waiting time, 3.00, which matches the textbook. FCFS gives 4.75 because short jobs wait behind the long first job, the convoy effect. A Compare button runs every algorithm on the same input."

---

## Slide 17 — Other Lab algorithms

**On screen**

| Topic | Verified result |
|---|---|
| Page replacement (3 frames, standard string) | FIFO 15 · LRU 12 · Optimal 9 faults |
| Belady's anomaly (FIFO) | 3 frames → 9 faults, 4 frames → **10** |
| Banker's algorithm | Safe sequence **P1, P3, P4, P0, P2** |
| Disk scheduling, head at 53 | FCFS 640 · SSTF 236 · SCAN 331 · LOOK 299 |
| Dining philosophers (naive) | **Deadlock** detected |
| Race condition (no lock) | Lost updates; zero with mutex, semaphore or monitor |

**Say**
"Each of these matches a textbook answer. Belady's anomaly is a nice one: giving FIFO more frames made it worse, 9 faults to 10. The Banker's algorithm finds a safe sequence, and refuses a request that would leave the system unsafe. The concurrency lab runs a small deterministic interpreter, so a race condition is reproducible, and you can watch the lost updates disappear when you add a mutex."

---

## Slide 18 — System Call Observatory: what a system call is

**On screen**

```
FlowDesk hashes a file
  → Rust File::read()               library call
  → Windows API ReadFile()          user mode
  → native system call NtReadFile   switch to kernel mode
  → I/O manager → file-system driver → disk driver → hardware
```

**Say**
"A program cannot touch the disk directly. It runs in user mode and asks the kernel through a system call. We wanted students to see that boundary. We must be honest about the levels: Windows API calls, native system calls, and ETW events are different things."

---

## Slide 19 — What we capture: ETW mode

**On screen**
- **ETW** = Event Tracing for Windows, the kernel's built-in tracing facility
- Providers: **Kernel-File**, **Kernel-Process**, **Kernel-Disk** + FlowDesk's own events
- Named **"ETW Mode"**: we do **not** capture native syscall entry/exit
- Shows: file create / read / write with **path, size, duration, NTSTATUS result**
- Duration = completion time − request time, matched by the request's **IRP**
- Two sources always labelled separately: **ETW observation** vs **FlowDesk app event**

**Say**
"We use ETW because it is the supported way to see kernel activity. We read three providers: file I/O, process and thread events, and disk I/O. The page is named ETW Mode because we do not claim to capture raw system calls. Windows reports those only as raw addresses that need kernel symbols. A request's duration is the time between the request and its completion event, matched by the I/O request packet. If no completion is seen, we show no duration instead of guessing."

---

## Slide 20 — Verified results and honest limits

**On screen**
- Real run (admin): hashing 5 files, **2,984** ETW events delivered, **94** belonged to FlowDesk, **0 events lost**
- Read operations: median **37 µs**, 95th percentile **124 µs** (75 matched completions)
- Without administrator rights: ETW is denied by Windows, so we offer **"FlowDesk events only"** (task started, per-file progress, cancel, finish)
- **Limits:** CPU temperature and fan speed often N/A · GPU sensors NVIDIA only · compression and backup not implemented · Lab ignores context-switch cost

**Say**
"We verified ETW with a real capture from an administrator terminal. Starting an ETW session needs administrator rights, which Windows enforces, so we do not bypass it. Without them, the app records FlowDesk's own events and labels them as such. We also list our limits openly, because an honest tool is more useful than an impressive-looking fake one."

---

## Slide 21 — Conclusion and future work

**On screen**
- An OS is **policies** (which process, which page, which request) built on **mechanisms** (context switch, locks, interrupts)
- FlowDesk lets you **see both**, on real hardware and in simulation
- **Future work:** compression and backup · aging for the Priority policy · AMD/Intel GPU sensors · configurable context-switch cost · repeated-run statistics

**Say**
"The main lesson of this course is that an operating system is a set of policies built on mechanisms, and the choice of policy has measurable consequences. FlowDesk makes both visible. Thank you, sir. We are ready for questions."

---

# Demo checklist (do 10 minutes before)

- [ ] Close any old FlowDesk window and any old `npm run tauri dev` (port 1420 must be free)
- [ ] Open PowerShell, `cd` to the project, run `npm run tauri dev`; wait for the window
- [ ] For the live ETW demo only: use a PowerShell opened with **Run as administrator**
- [ ] A test folder with a few hundred files is selected (hashing ends in about 5–20 s)
- [ ] Do one dry run of slide 14, including the Observatory page
- [ ] Keep screenshots of every page as a fallback
- [ ] The laptop is on charger; notifications are off

---

# Faculty questions and ready answers

*These are the questions most likely to come. The person named should answer; anyone may add. Short answers first, deeper detail after.*

## For Presenter 1 (architecture and monitoring)

**Q1. Why Rust and Tauri instead of Java or Electron?**
Rust has no garbage collector, so measurement and file processing are not paused, and its ownership rules prevent data races in a multi-threaded engine. Tauri uses the system's WebView, so the app is small and uses less memory than Electron.

**Q2. How do you get disk and GPU usage?**
From Windows Performance Data Helper (PDH) counters. Disk read/write come from `\PhysicalDisk(_Total)`. Disk active time is 100 minus the idle time counter. GPU usage is the busiest engine under `\GPU Engine(*)`. NVIDIA temperature and power come from NVML.

**Q3. Why does CPU temperature show N/A?**
Windows has no standard API for the CPU package sensor. The ACPI thermal zone is usually unreadable without administrator rights. Showing N/A with the reason is more honest than an estimate.

**Q4. Is your monitoring accurate?**
The values come from the same OS counters Task Manager uses. Rate counters need two samples, so the first reading says "warming up". Sampling is every 1 s by default, so very short spikes can be missed.

**Q5. Does FlowDesk replace the Windows scheduler?**
No. It decides which FlowDesk task a worker serves next. Windows still schedules the threads onto cores. We say this in the interface.

## For Presenter 2 (scheduler and engine)

**Q6. Is your Round Robin real preemption like an OS?**
It is *application-level* preemption. We cannot interrupt a thread like a kernel timer can, so each unit checks its time budget between 256 KiB chunks, then saves its cursor and yields. The effect on the queue is the same as RR. The true limit is that a single chunk read cannot be interrupted.

**Q7. How do you save the "context" of a file?**
In a cursor: the open file handle, bytes read so far and the partial SHA-256 state. Another worker can resume it. This is the same idea as a PCB with saved registers.

**Q8. Where is the mutual exclusion in your code?**
All scheduler state is behind one `Mutex`. Workers wait on a `Condvar` when nothing is runnable and are woken by `notify_all`. Per-chunk counters are atomics, so reading progress never blocks the workers.

**Q9. Can your scheduler cause starvation or deadlock?**
Starvation: Priority can starve low-priority tasks, because we have no aging yet; it is listed as future work. Deadlock: we hold the scheduler lock only to pick or record work, never while doing file I/O. Where a second lock is needed (the database), it is always taken *after* the scheduler lock and never the other way round, so the circular-wait condition cannot form (lock ordering).

**Q10. What happens on cancel or app crash?**
Cancel sets a flag. The queue is cleared and running units stop at the next chunk. A partial copy file is deleted. If the app closes mid-task, the next start marks the task `interrupted`.

**Q11. Which policy is best?**
It depends on the goal. SRT gives the lowest average waiting time but needs to know sizes and can starve large tasks. RR gives fair, quick first response. Priority serves important work first. FCFS is simplest. Also, our measurements are system-wide, so one run alone does not prove a policy caused a difference.

**Q12. How is hashing verified?**
A unit test checks the SHA-256 of "abc" against the standard test vector. Another test checks that a preempted and resumed hash equals an uninterrupted one. Copies are verified by hashing the copy.

## For Presenter 3 (Lab and Observatory)

**Q13. Why did SRTF give a smaller waiting time than FCFS?**
FCFS lets a long job at the front delay everyone (convoy effect). SRTF always runs the shortest remaining job, which is provably optimal for average waiting time. Its cost is possible starvation of long jobs and more context switches.

**Q14. Explain the Banker's algorithm in one minute.**
Before granting a request we pretend to grant it, then check whether some order exists in which all processes can finish: repeatedly find a process whose Need is at most Work, let it finish, add its allocation back to Work. If all can finish, the state is safe and we grant; otherwise the process waits.

**Q15. What is Belady's anomaly and why does it not happen with LRU?**
With FIFO, more frames can mean more faults (9 to 10 in our example). LRU and Optimal are *stack algorithms*: the set of pages kept with *n* frames is always a subset of those kept with *n+1*, so more memory cannot hurt.

**Q16. Is the Algorithm Lab real?**
No, it is simulation and is labelled "Simulation". We prove correctness by matching textbook answers in unit tests. The real parts are the job engine and the telemetry.

**Q17. Did you capture real system calls?** *(Most likely tough question)*
No, and we say so. We capture ETW events for file I/O, process and thread activity, and disk I/O. These are one level above the system call: for example a Kernel-File read event corresponds to the I/O manager handling a read request. Native syscall tracing needs the NT Kernel Logger and kernel symbol decoding, which we did not implement. That is why the page is called "ETW Mode".

**Q18. What is ETW?**
Event Tracing for Windows is the kernel's high-speed logging facility. A *controller* starts a session and enables *providers*; a *consumer* receives events. We run a real-time session, decode each event using the provider's manifest through TDH, and filter to our process.

**Q19. How do you compute a read's duration?**
Kernel-File logs a Read request with an IRP pointer. When the operation finishes it logs OperationEnd with the same IRP. Duration = OperationEnd time minus request time. If the OperationEnd never arrives, the request shows no duration.

**Q20. Why does it need administrator rights?**
Windows only lets administrators, or members of the Performance Log Users group, control trace sessions. We do not bypass this. Without rights we show a clear message and offer "FlowDesk events only", which are our own events and are labelled that way.

**Q21. Are the events real or generated?**
In ETW mode they are real events delivered by Windows. In fallback mode they are real FlowDesk engine events. There is no generated data. Test data exists only inside unit tests and is excluded from the app.

**Q22. Could tracing slow the system or lose events?**
We use bounded buffers and a bounded queue, and we report lost events. In our verified run ETW reported zero lost events. FlowDesk's own database writes are excluded from the trace, so the tracer does not trace itself.

## Questions for anyone

**Q23. What is the main contribution of the project?**
Real scheduling with preemption and saved context, real measurement of the hardware's response, and a verified Algorithm Lab, in one honest tool where every value says whether it is real, simulated or unavailable.

**Q24. What are the limitations?**
CPU temperature and fan speed are often unavailable; GPU sensors are NVIDIA only; compression and backup are not implemented; the Priority policy has no aging; the Lab assumes zero context-switch cost; native system-call capture is not implemented.

**Q25. What would you do next?**
Add aging to Priority, an I/O-aware policy, AMD and Intel GPU sensors, statistical comparison of repeated runs, and decode native syscall events.

**Q26. How did you test it?**
Automated tests: 26 algorithm tests against textbook results, backend tests for SHA-256, preemption, cancellation, copy safety, scheduler policies, database restart and the trace system, and 7 tests for trace analysis. We also ran a real ETW capture from an administrator terminal and recorded the schemas Windows reported.

---

# If you forget everything, remember these 6 lines

1. **FlowDesk = measure the real machine + schedule real work + learn algorithms in simulation.**
2. **Real vs simulated vs N/A is always labelled.** We never show fake numbers.
3. **Our scheduler chooses between FlowDesk tasks; Windows still schedules the threads.**
4. **Round Robin saves a file's cursor (like a PCB) and any worker can resume it.**
5. **ETW Mode shows I/O requests with duration; it is not raw system-call tracing.**
6. **ETW needs admin; without it we record FlowDesk's own events and say so.**
