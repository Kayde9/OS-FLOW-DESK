# System Call Observatory (ETW mode)

The Observatory records how a program interacts with Windows while it runs. It captures **Event Tracing for Windows (ETW)** events for one target process and shows them in a live event stream, a multi-lane timeline, an event inspector and an analysis view. Every session is saved to SQLite.

## What it captures and what it does not

The page is labelled **"System Call Observatory — ETW Mode"** because it does not capture native system calls. These are different levels of abstraction, and FlowDesk keeps them apart:

| Level | Captured? | Source |
|---|---|---|
| FlowDesk task events (dispatch, completion, preemption) | Yes, labelled **FlowDesk app event** | FlowDesk job engine (`FlowDesk.Engine`) |
| File-system requests (create, read, write, delete, rename, plus optional close/cleanup/query/set) | Yes | `Microsoft-Windows-Kernel-File` |
| I/O completion: duration and NTSTATUS | Yes, when "Completions" is on | Kernel-File `OperationEnd`, matched to its request by IRP |
| Process start/stop, thread start/stop, image load/unload | Yes | `Microsoft-Windows-Kernel-Process` |
| Physical disk read/write/flush | Yes, where it can be attributed | `Microsoft-Windows-Kernel-Disk` |
| Windows API calls (for example `ReadFile`) | No | — |
| Native system-call entry/exit (`NtReadFile` …) | No | Only the NT Kernel Logger reports these, as raw service addresses that need symbol resolution. FlowDesk does not decode them, so it shows no syscall names, return values or stacks. |

ETW events are operating-system observations. FlowDesk events describe what the application decided to do. Telemetry samples are system-wide measurements. The UI labels each source separately, and exports keep a `source` column.

## Providers

GUIDs and keyword bits were checked with `logman query providers` on Windows 11 build 26200.

| Provider | GUID | Keywords enabled |
|---|---|---|
| Microsoft-Windows-Kernel-File | `{EDD08927-9CC4-4E65-B970-C2560FB5C289}` | CREATE 0x80, READ 0x100, WRITE 0x200, DELETE_PATH 0x400, RENAME_SETLINK_PATH 0x800, CREATE_NEW_FILE 0x1000; plus OP_END 0x40 (completions) and FILEIO 0x20 (handle/metadata events) when selected |
| Microsoft-Windows-Kernel-Process | `{22FB2CD6-0E7B-422B-A0C7-2FAD1FD0E716}` | PROCESS 0x10, THREAD 0x20, IMAGE 0x40 |
| Microsoft-Windows-Kernel-Disk | `{C7BDE69A-E1E0-4177-B6EF-283AD1525271}` | 0x8000000000000000 (the provider defines only its Analytic channel keyword) |

Note that Kernel-File's `OperationEnd` carries both OP_END and FILEIO. Enabling handle/metadata events therefore also enables completions at the ETW level. When completions are switched off, the collector discards them.

### Fields verified on this machine

Event layouts are never hard-coded. TDH (`TdhGetEventInformation`) reads them from each provider's manifest once per event id and version, and FlowDesk walks every payload using that layout. A property it cannot size safely, such as a struct or a variable-length array, stops decoding, and the event is marked `_undecoded` with the reason. Each session stores the schemas it saw, and the live test writes them to `src-tauri/target/etw-verification.json`.

These are the schemas observed during the elevated live test (Windows 11 Home 26200, 25 October 2026):

| Provider | Id / version | Name (from TDH) | Fields |
|---|---|---|---|
| Kernel-File | 12 v1 | Create | Irp, FileObject, IssuingThreadId, CreateOptions, CreateAttributes, ShareAccess, FileName |
| Kernel-File | 15 v1 | Read | ByteOffset, Irp, FileObject, FileKey, IssuingThreadId, IOSize, IOFlags, ExtraFlags |
| Kernel-File | 16 v1 | Write | same as Read |
| Kernel-File | 24 v0 | OperationEnd | Irp, ExtraInformation, Status |
| Kernel-File | 26 v1 / 27 v1 | DeletePath / RenamePath | Irp, FileObject, FileKey, ExtraInformation, IssuingThreadId, InfoClass, FilePath |
| Kernel-File | 30 v1 | CreateNewFile | as Create |
| Kernel-Process | 3 v1 / 4 v1 | ThreadStart / ThreadStop | ProcessID, ThreadID, StackBase, StackLimit, UserStackBase, UserStackLimit, StartAddr, Win32StartAddr, TebBase, SubProcessTag (+ CycleTime on stop) |
| Kernel-Disk | 10 v0 / 11 v0 | *(no name in manifest: shown as "Event 10" / "Event 11")* | DiskNumber, IrpFlags, TransferSize, Reserved, ByteOffset, FileObject, IORequestPacket, HighResResponseTime |
| Kernel-Disk | 14 v0 | *(shown as "Event 14")* | DiskNumber, IrpFlags, HighResResponseTime, IORequestPacket |

Results from that run: 5 hashed files, 94 events stored, 2,984 ETW events delivered before filtering, **0 events lost**, Read p50 37 µs and p95 124 µs (75 IRP-matched completions). Five reads returned `STATUS_END_OF_FILE`, the expected last read of each file. No disk events were attributed in that run because the freshly written test files were served from the cache. Disk attribution by `FileObject` was added after the run showed that Kernel-Disk has no `IssuingThreadId`; it is covered by unit tests but has not yet been confirmed in a second live run.

`HighResResponseTime` is kept as a raw field and is never converted into a duration, because its unit is not documented in the manifest.

## Correlation and attribution rules

- **Target filter.** A Kernel-File request belongs to the target when the event header's process id is the target PID. The I/O manager logs requests in the requester's context.
- **Paths.** A `Create` event carries `FileName` and `FileObject`, and later requests on the same `FileObject` inherit that path. NT device paths (`\Device\HarddiskVolume3\…`) are mapped to drive letters with `QueryDosDevice`. If a file was opened before the capture started, its path is shown as **unknown**, never guessed.
- **Durations.** A request that carries an `Irp` is matched to the next `OperationEnd` with the same `Irp`, even if that completion was logged in another process context. Duration is the OperationEnd timestamp minus the request timestamp. A request with no observed completion stays **unmatched** and has no duration. The timeline draws bars only for matched requests; every other event is a point marker.
- **Status.** The NTSTATUS from OperationEnd is the I/O result. It is labelled as such, not as a system-call return value. Codes are classified with the `NT_SUCCESS` severity bits, and common codes are named from `ntstatus.h`.
- **Process events.** These are kept when `ProcessID` or `ParentProcessID` is the target, or when the header process id is the target.
- **Disk events.** Kernel-Disk events are logged outside the requesting process and carry no issuing thread. They are attributed when the header process id is the target, or when their `FileObject` belongs to a file the target opened during the capture. Cached reads cause no disk I/O, and cache write-back by the System process is not attributed.
- **Observer effect.** FlowDesk's trace-writer thread writes events to SQLite. Its own I/O is excluded by default and counted as "self". Other FlowDesk threads, such as telemetry persistence, remain visible under their thread names.
- **Timestamps.** ETW converts its QPC timestamps to FILETIME system time, and FlowDesk events use `GetSystemTimePreciseAsFileTime` through Rust's `SystemTime`, so both share one clock. Each event keeps the source timestamp (`tsUs`), the time FlowDesk processed it (`recvUs`) and its arrival order (`seq`). The table sorts by timestamp and breaks ties by `seq`.

## Session lifecycle

`Idle → Preparing → Capturing → Stopping → Finalizing → Completed | Cancelled`. A session can also end as `Failed` from Preparing, Capturing, Stopping or Finalizing. Transitions are checked by `SessionState::can_go`.

1. **Preparing.** FlowDesk stops any stale `FlowDesk-Observatory` session left by a crashed instance, then calls `StartTrace` in real-time mode with QPC timestamps and bounded buffers. It starts the consumer thread (`OpenTrace` + `ProcessTrace`) before calling `EnableTraceEx2` for each provider, so no early buffers are missed. The state and any error are recorded per provider.
2. **Capturing.** The green indicator appears only after the backend confirms this state. For a workload target, FlowDesk then submits the task and links its id to the session.
3. **Stopping.** `ControlTrace(STOP)` flushes the remaining ETW buffers to the consumer before `ProcessTrace` returns. If that takes longer than 5 seconds, `CloseTrace` forces it to return.
4. **Finalizing.** The writer drains the queue, the telemetry window is copied into the session, an analysis summary is computed with SQL, and retention runs.

The session stops on Stop, Cancel (which also cancels the linked workload), the duration limit, the event limit, or 750 ms after the linked workload finishes. Only one session can be active at a time. When FlowDesk exits, the `RunEvent::Exit` handler stops the ETW session. If the app crashes, the next launch stops the leftover session and marks unfinished sessions as failed.

## Resource protection

- The consumer and the engine observer feed a bounded queue (65,536 messages) using `try_send`. Overflow is counted as **queue drops** and is never blocking.
- One writer thread inserts events in batches of up to 2,000, or every 200 ms, with one SQLite transaction per batch. It applies completions by `(session_id, seq)`.
- The live view receives at most 3,000 events per 250 ms tick, and the frontend keeps the newest 100,000 in memory. Extra events are still saved and reload from the database.
- ETW loss counters (`EventsLost`, `RealTimeBuffersLost`, `LogBuffersLost`) are read with `ControlTrace(QUERY)` every second and at stop. In FlowDesk-events-only mode they are shown as N/A, not 0.
- Limits are configurable: duration 5–1800 s, events 1,000–2,000,000, buffer 64–1024 KB, buffers 16–512.
- Retention keeps the newest 30 sessions and at most 3,000,000 stored events.

## Permissions

Controlling an ETW session requires administrator rights or membership in **Performance Log Users**. Without them, `StartTrace` returns `ERROR_ACCESS_DENIED`. The session then ends as Failed with `errorKind: "permission"` and an explanation, and the workload is not started. The Trace target panel explains how to launch from an elevated PowerShell (`npm run tauri dev` in a window opened with Run as administrator) or to join the group, and offers **Use FlowDesk events only**, which records engine events (task started/progress/paused/cancelled/finished, per-file dispatch and results) without an ETW session. When the app is not elevated, FlowDesk defaults to that mode. There is no in-app restart action, because it would end a running dev server.

FlowDesk never elevates itself silently, and it never starts a capture on launch.

## Exports and privacy

Sessions are stored locally only. Exports contain FlowDesk's **normalized** records: CSV or JSON of events, or a Markdown summary. They are not ETL files, because real-time sessions keep no `.etl`. Export redaction offers three levels:

- **Paths as captured.**
- **Redact user folder.** The `%USERPROFILE%` prefix is replaced.
- **Pseudonymize all paths.** Each path becomes a stable `<redacted:hash>.ext`. This also applies to path-like provider fields.

## Tests

- **Rust (`cargo test`).** Covers lifecycle transitions; TDH-layout payload decoding, including structs and truncated payloads; collector path tracking, IRP matching, filtering, self-exclusion and disk/process attribution; batched persistence with completion updates, replay paging, summaries and retention; redaction and CSV; the full lifecycle of a FlowDesk-events-only session with a real hashing workload; cancellation of the session and its linked task; duplicate-session refusal; and the permission-denied path, which is exercised for real when the terminal is not elevated.
- **Live ETW (`cargo test -- --ignored etw_live`, elevated).** Hashes real files under a real ETW session and checks that Create and Read events carry the expected paths, that completions are matched, that every file event is attributed to the FlowDesk PID, and that loss counters are reported.
- **Frontend (`npm test`).** Covers filtering, sorting, lanes, percentiles, histograms, related events, telemetry alignment, and the bounded live window with completion patching.
- **Synthetic test data.** `src-tauri/src/trace/synthetic.rs` (only compiled under `cfg(test)`) and `src/lib/trace/synthetic.ts` (never imported by app code) generate synthetic events for tests. Both are tagged with the provider `SYNTHETIC-TEST`.
