//! System Call Observatory — ETW mode.
//!
//! Captures supported Windows ETW events (Kernel-File, Kernel-Process,
//! Kernel-Disk) for one target process, plus FlowDesk's own application-level
//! workload events, which stay labelled as a separate source. Native system-call
//! entry/exit is *not* captured: the kernel's syscall events report only
//! service addresses and need the NT Kernel Logger plus symbol resolution,
//! which FlowDesk does not do.
//!
//! Threads per session:
//!   ETW consumer (ProcessTrace callback) ─┐ bounded queue ┌─► SQLite (batched)
//!   engine observer (FlowDesk events) ────┴──────────────►│ writer ─► `trace://batch`, `trace://state`
//!   supervisor: limits, loss counters, workload completion, stop/finalize

pub mod collector;
pub mod decode;
pub mod etw;
pub mod export;
pub mod model;
pub mod providers;
pub mod store;
#[cfg(test)]
pub mod synthetic;

use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::db::Db;
use crate::engine::{AppEvent, Engine};
use crate::telemetry::Telemetry;
use crate::util::{now_ms, now_us, register_thread, thread_names};
use collector::{Collector, CollectorCfg, Counters};
use model::{Completion, SessionState, TargetSpec, TraceConfig, TraceEvent, TraceStats};
use providers::ProviderDef;

pub enum Msg {
    Event(TraceEvent),
    Completion(Completion),
}

const QUEUE_CAP: usize = 65_536;
const BATCH: usize = 2_000;
const FLUSH_EVERY: Duration = Duration::from_millis(200);
const EMIT_EVERY: Duration = Duration::from_millis(250);
/// Most events streamed to the live view per emit; the rest are still saved.
const LIVE_CAP: usize = 3_000;
const KEEP_SESSIONS: i64 = 30;
const MAX_STORED_EVENTS: i64 = 3_000_000;
const WORKLOAD_LINGER: Duration = Duration::from_millis(750);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: String,
    pub name: String,
    pub guid: String,
    pub keywords: String,
    pub enabled: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetView {
    pub kind: &'static str,
    pub pid: u32,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub id: i64,
    pub name: String,
    pub state: SessionState,
    /// "etw" or "app" (FlowDesk application events only).
    pub mode: &'static str,
    pub target: TargetView,
    pub job_id: Option<i64>,
    pub providers: Vec<ProviderStatus>,
    pub config: TraceConfig,
    pub elevated: bool,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub stats: TraceStats,
    /// Event schemas TDH reported so far (what was actually decodable).
    pub schemas: Vec<model::SchemaInfo>,
    pub stop_reason: Option<String>,
    pub error: Option<String>,
    /// "permission" when the failure was an access-denied from ETW.
    pub error_kind: Option<&'static str>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveBatch<'a> {
    session_id: i64,
    events: &'a [TraceEvent],
    completions: &'a [Completion],
}

#[derive(Default)]
struct WriterStats {
    persisted: u64,
    by_category: BTreeMap<String, u64>,
    errors: u64,
    completions: u64,
    not_streamed: u64,
    first_event_us: Option<i64>,
    last_event_us: Option<i64>,
}

struct Active {
    id: i64,
    view: Mutex<SessionView>,
    counters: Arc<Counters>,
    writer_stats: Mutex<WriterStats>,
    schemas: Arc<Mutex<Vec<model::SchemaInfo>>>,
    seq: Arc<AtomicU64>,
    tx: Mutex<Option<SyncSender<Msg>>>,
    etw: Mutex<Option<etw::EtwSession>>,
    loss: Mutex<Option<etw::Loss>>,
    stop: AtomicBool,
    cancel: AtomicBool,
    finalizing: AtomicBool,
    stop_reason: Mutex<Option<String>>,
    finished_jobs: Mutex<HashSet<i64>>,
    writer: Mutex<Option<std::thread::JoinHandle<()>>>,
    started: Instant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    platform_supported: bool,
    elevated: bool,
    dev_build: bool,
    session_name: &'static str,
    self_pid: u32,
    providers: Vec<ProviderDef>,
    native_syscalls: bool,
    native_syscall_note: &'static str,
    etl_export: bool,
    etl_note: &'static str,
    permission_note: &'static str,
}

pub struct TraceManager {
    db: Arc<Db>,
    engine: Arc<Engine>,
    telemetry: Arc<Telemetry>,
    app: OnceLock<AppHandle>,
    current: Mutex<Option<Arc<Active>>>,
}

fn provider_keywords(p: &ProviderDef, cfg: &TraceConfig) -> u64 {
    match p.kind {
        providers::Kind::File => {
            let mut k = p.keywords;
            if cfg.file_completions {
                k |= providers::KF_OP_END;
            }
            if cfg.file_metadata {
                // Note: FILEIO also enables OperationEnd at the ETW level; the
                // collector ignores completions when they are switched off.
                k |= providers::KF_FILEIO;
            }
            k
        }
        _ => p.keywords,
    }
}

/// Queues one FlowDesk engine event (source = flowdesk) on the session's bounded queue.
fn push_app(a: &Active, e: &AppEvent, self_pid: u32, names: &std::collections::HashMap<u32, String>) {
    if e.kind == "TaskFinished" {
        a.finished_jobs.lock().unwrap().insert(e.job_id);
    }
    let seq = a.seq.fetch_add(1, Ordering::Relaxed) + 1;
    let ev = collector::app_event(seq, e, self_pid, names, now_us());
    if let Some(tx) = a.tx.lock().unwrap().as_ref() {
        match tx.try_send(Msg::Event(ev)) {
            Ok(()) => {
                a.counters.captured.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Full(_)) => {
                a.counters.queue_dropped.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Disconnected(_)) => {}
        }
    }
}

impl TraceManager {
    pub fn new(db: Arc<Db>, engine: Arc<Engine>, telemetry: Arc<Telemetry>) -> Arc<Self> {
        // A session left running by a crashed earlier instance would keep logging.
        etw::stop_stale();
        Arc::new(TraceManager { db, engine, telemetry, app: OnceLock::new(), current: Mutex::new(None) })
    }

    pub fn attach(&self, app: AppHandle) {
        let _ = self.app.set(app);
    }

    pub fn capabilities(&self) -> Capabilities {
        Capabilities {
            platform_supported: cfg!(windows),
            elevated: etw::is_elevated(),
            dev_build: cfg!(debug_assertions),
            session_name: etw::SESSION_NAME,
            self_pid: std::process::id(),
            providers: providers::ALL.to_vec(),
            native_syscalls: false,
            native_syscall_note: "Native system-call entry/exit is not captured. Windows exposes syscall events only through the NT Kernel Logger, as raw service addresses that need kernel symbol resolution; FlowDesk does not decode them, so no syscall names, return values or stacks are shown.",
            etl_export: false,
            etl_note: "Sessions run in real-time mode and keep no .etl file. Exports contain FlowDesk's normalized event records.",
            permission_note: "Starting an ETW session requires administrator rights or membership in the Performance Log Users group. Without them, only FlowDesk application events can be recorded.",
        }
    }

    pub fn current(&self) -> Option<SessionView> {
        let a = self.current.lock().unwrap().clone()?;
        Some(self.view(&a))
    }

    fn view(&self, a: &Active) -> SessionView {
        let mut v = a.view.lock().unwrap().clone();
        let w = a.writer_stats.lock().unwrap();
        let c = &a.counters;
        let loss = *a.loss.lock().unwrap();
        let etw = v.mode == "etw";
        v.schemas = a.schemas.lock().unwrap().clone();
        v.stats = TraceStats {
            captured: c.captured.load(Ordering::Relaxed),
            persisted: w.persisted,
            by_category: w.by_category.clone(),
            errors: w.errors,
            completions: w.completions,
            etw_delivered: c.delivered.load(Ordering::Relaxed),
            filtered_out: c.filtered.load(Ordering::Relaxed),
            self_excluded: c.self_excluded.load(Ordering::Relaxed),
            queue_dropped: c.queue_dropped.load(Ordering::Relaxed),
            not_streamed: w.not_streamed,
            etw_events_lost: loss.filter(|_| etw).map(|l| l.events_lost),
            etw_buffers_lost: loss.filter(|_| etw).map(|l| l.log_buffers_lost),
            etw_rt_buffers_lost: loss.filter(|_| etw).map(|l| l.rt_buffers_lost),
            first_event_us: w.first_event_us,
            last_event_us: w.last_event_us,
            limit_hit: v.stop_reason.clone().filter(|r| r.contains("limit")),
        };
        v
    }

    fn emit_state(&self, a: &Active) {
        if let Some(app) = self.app.get() {
            let _ = app.emit("trace://state", self.view(a));
        }
    }

    fn transition(&self, a: &Active, to: SessionState) {
        {
            let mut v = a.view.lock().unwrap();
            if !v.state.can_go(to) {
                return;
            }
            v.state = to;
            if to == SessionState::Capturing {
                v.started_at = Some(now_ms());
            }
            if to.terminal() {
                v.ended_at = Some(now_ms());
            }
            let _ = self.db.update_trace_session(a.id, to.as_str(), v.started_at, v.job_id, None);
        }
        self.emit_state(a);
    }

    pub fn start(self: &Arc<Self>, cfg: TraceConfig) -> Result<SessionView, String> {
        let cfg = cfg.sanitize();
        {
            let cur = self.current.lock().unwrap();
            if let Some(a) = cur.as_ref() {
                if !a.view.lock().unwrap().state.terminal() {
                    return Err(format!("Trace session #{} is still active. Stop it before starting another.", a.id));
                }
            }
        }
        let self_pid = std::process::id();
        // Validate the workload before anything (session record, ETW) is started.
        if let TargetSpec::Workload { job } = &cfg.target {
            let folder = std::path::Path::new(&job.folder);
            if job.folder.trim().is_empty() || !folder.is_dir() {
                return Err(format!("Workload folder not found: {}", job.folder));
            }
            if std::fs::read_dir(folder).is_err() {
                return Err(format!("Workload folder cannot be read: {}", job.folder));
            }
            if job.op == crate::engine::ops::Op::Copy && job.dest.as_deref().map_or(true, |d| d.trim().is_empty()) {
                return Err("Safe copy needs a destination folder".into());
            }
        }
        let (kind, pid, target_name) = match &cfg.target {
            TargetSpec::Workload { .. } => (
                "workload",
                self_pid,
                std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())),
            ),
            TargetSpec::Process { pid, name } => ("process", *pid, name.clone()),
        };
        if cfg.providers.is_empty() && kind == "process" {
            return Err("Tracing another process needs at least one ETW provider; FlowDesk application events exist only for FlowDesk's own workloads.".into());
        }
        let mode = if cfg.providers.is_empty() { "app" } else { "etw" };
        let elevated = etw::is_elevated();
        let provider_rows: Vec<ProviderStatus> = cfg
            .providers
            .iter()
            .filter_map(|id| providers::find(id))
            .map(|p| ProviderStatus {
                id: p.id.into(),
                name: p.name.into(),
                guid: providers::guid_string(p.guid),
                keywords: format!("0x{:X}", provider_keywords(p, &cfg)),
                enabled: false,
                error: None,
            })
            .collect();
        let name = cfg.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| match &cfg.target {
            TargetSpec::Workload { job } => format!("Trace · {}", job.op.label()),
            TargetSpec::Process { pid, name } => format!("Trace · {} ({pid})", name.as_deref().unwrap_or("process")),
        });
        let created_at = now_ms();
        let config_json = serde_json::to_value(&cfg).map_err(|e| e.to_string())?;
        let providers_json = serde_json::to_value(&provider_rows).map_err(|e| e.to_string())?;
        let id = self.db.insert_trace_session(&store::NewSession {
            name: &name,
            mode,
            target_kind: kind,
            target_pid: Some(pid as i64),
            target_name: target_name.as_deref(),
            providers: &providers_json,
            config: &config_json,
            elevated,
            created_at,
        })?;

        let (tx, rx) = sync_channel::<Msg>(QUEUE_CAP);
        let a = Arc::new(Active {
            id,
            view: Mutex::new(SessionView {
                id,
                name,
                state: SessionState::Idle,
                mode,
                target: TargetView { kind, pid, name: target_name.clone() },
                job_id: None,
                providers: provider_rows,
                config: cfg.clone(),
                elevated,
                created_at,
                started_at: None,
                ended_at: None,
                stats: TraceStats::default(),
                schemas: Vec::new(),
                stop_reason: None,
                error: None,
                error_kind: None,
            }),
            counters: Arc::new(Counters::default()),
            writer_stats: Mutex::new(WriterStats::default()),
            schemas: Arc::new(Mutex::new(Vec::new())),
            seq: Arc::new(AtomicU64::new(0)),
            tx: Mutex::new(Some(tx.clone())),
            etw: Mutex::new(None),
            loss: Mutex::new(None),
            stop: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            finalizing: AtomicBool::new(false),
            stop_reason: Mutex::new(None),
            finished_jobs: Mutex::new(HashSet::new()),
            writer: Mutex::new(None),
            started: Instant::now(),
        });
        *self.current.lock().unwrap() = Some(Arc::clone(&a));
        self.transition(&a, SessionState::Preparing);

        // Writer first, so the collector can exclude its thread's own I/O.
        let (tid_tx, tid_rx) = std::sync::mpsc::channel();
        let me = Arc::clone(self);
        let aw = Arc::clone(&a);
        let handle = std::thread::Builder::new()
            .name("flowdesk-trace-writer".into())
            .spawn(move || {
                let _ = tid_tx.send(register_thread("flowdesk-trace-writer"));
                me.writer_loop(&aw, rx);
            })
            .map_err(|e| e.to_string())?;
        *a.writer.lock().unwrap() = Some(handle);
        let writer_tid = tid_rx.recv_timeout(Duration::from_secs(2)).unwrap_or(0);

        if mode == "etw" {
            let mut exclude = HashSet::new();
            if cfg.exclude_tracer_io {
                exclude.insert(writer_tid);
            }
            let collector = Collector::new(
                CollectorCfg {
                    target_pid: pid,
                    target_name: target_name.clone(),
                    self_pid,
                    completions: cfg.file_completions,
                    exclude_tids: exclude,
                    path_filter: cfg.path_filter.clone(),
                    dos_map: etw::dos_map(),
                    thread_names: thread_names(),
                },
                Arc::clone(&a.seq),
                Arc::clone(&a.counters),
            );
            let opts = etw::StartOptions {
                buffer_kb: cfg.buffer_kb,
                max_buffers: cfg.max_buffers,
                providers: cfg.providers.iter().filter_map(|id| providers::find(id)).map(|p| (p, provider_keywords(p, &cfg))).collect(),
            };
            let consumer =
                etw::Consumer { collector, tx: tx.clone(), counters: Arc::clone(&a.counters), schemas: Arc::clone(&a.schemas) };
            match etw::start(opts, consumer) {
                Ok(session) => {
                    {
                        let mut v = a.view.lock().unwrap();
                        for (pid_, r) in &session.enabled {
                            if let Some(p) = v.providers.iter_mut().find(|p| p.id == *pid_) {
                                p.enabled = r.is_ok();
                                p.error = r.as_ref().err().cloned();
                            }
                        }
                        let pj = serde_json::to_value(&v.providers).unwrap_or(Value::Null);
                        let _ = self.db.update_trace_session(id, v.state.as_str(), None, None, Some(&pj));
                    }
                    *a.etw.lock().unwrap() = Some(session);
                }
                Err(err) => {
                    let (kind_, msg) = match err {
                        etw::EtwError::Permission(m) => (Some("permission"), m),
                        etw::EtwError::Other(m) => (Some("other"), m),
                    };
                    drop(tx);
                    self.fail(&a, &msg, kind_);
                    return Ok(self.view(&a));
                }
            }
        }
        drop(tx);
        self.transition(&a, SessionState::Capturing);

        if let TargetSpec::Workload { job } = &cfg.target {
            // Explicitly initialise the application-event collector before the task is submitted.
            let ao = Arc::clone(&a);
            let names = thread_names();
            self.engine.set_observer(Some(Arc::new(move |e: AppEvent| push_app(&ao, &e, self_pid, &names))));
            match self.engine.submit(job.clone()) {
                Ok(job_id) => {
                    a.view.lock().unwrap().job_id = Some(job_id);
                    let _ = self.db.update_trace_session(id, "capturing", None, Some(job_id), None);
                }
                Err(e) => {
                    *a.stop_reason.lock().unwrap() = Some(format!("Workload could not start: {e}"));
                    a.view.lock().unwrap().error = Some(format!("Workload could not start: {e}"));
                    a.stop.store(true, Ordering::Relaxed);
                }
            }
        }

        let me = Arc::clone(self);
        let asup = Arc::clone(&a);
        std::thread::Builder::new()
            .name("flowdesk-trace-supervisor".into())
            .spawn(move || me.supervise(asup))
            .map_err(|e| e.to_string())?;
        Ok(self.view(&a))
    }

    fn active(&self, id: i64) -> Result<Arc<Active>, String> {
        let cur = self.current.lock().unwrap();
        match cur.as_ref() {
            Some(a) if a.id == id && !a.view.lock().unwrap().state.terminal() => Ok(Arc::clone(a)),
            _ => Err(format!("Trace session #{id} is not active")),
        }
    }

    pub fn stop(&self, id: i64) -> Result<(), String> {
        let a = self.active(id)?;
        a.stop_reason.lock().unwrap().get_or_insert_with(|| "Stopped by user".into());
        a.stop.store(true, Ordering::Relaxed);
        Ok(())
    }

    pub fn cancel(&self, id: i64) -> Result<(), String> {
        let a = self.active(id)?;
        a.stop_reason.lock().unwrap().get_or_insert_with(|| "Cancelled by user".into());
        a.cancel.store(true, Ordering::Relaxed);
        a.stop.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn supervise(self: Arc<Self>, a: Arc<Active>) {
        let cfg = a.view.lock().unwrap().config.clone();
        let mut last_query = Instant::now();
        let mut workload_done_at: Option<Instant> = None;
        let mut last_progress = Instant::now();
        let mut last_seen = (0u64, 0u64);
        let self_pid = std::process::id();
        loop {
            std::thread::sleep(Duration::from_millis(100));
            if a.stop.load(Ordering::Relaxed) {
                break;
            }
            if a.started.elapsed() >= Duration::from_secs(cfg.max_duration_s) {
                *a.stop_reason.lock().unwrap() = Some(format!("Capture duration limit reached ({} s)", cfg.max_duration_s));
                break;
            }
            if a.counters.captured.load(Ordering::Relaxed) >= cfg.max_events {
                *a.stop_reason.lock().unwrap() = Some(format!("Event limit reached ({} events)", cfg.max_events));
                break;
            }
            if cfg.stop_with_workload {
                let job = a.view.lock().unwrap().job_id;
                if job.is_some_and(|j| a.finished_jobs.lock().unwrap().contains(&j)) {
                    // Keep capturing briefly so closing I/O (reports, handles) is included.
                    let t = *workload_done_at.get_or_insert_with(Instant::now);
                    if t.elapsed() >= WORKLOAD_LINGER {
                        *a.stop_reason.lock().unwrap() = Some("Workload completed".into());
                        break;
                    }
                }
            }
            // Real task progress from the engine, only when it changed.
            if last_progress.elapsed() >= Duration::from_millis(500) {
                last_progress = Instant::now();
                let job = a.view.lock().unwrap().job_id;
                if let Some((p, files, total, bytes_done, bytes_total)) = job.and_then(|j| self.engine.job_progress(j)) {
                    if (files, bytes_done) != last_seen && !a.stop.load(Ordering::Relaxed) {
                        last_seen = (files, bytes_done);
                        let e = AppEvent {
                            ts_us: now_us(),
                            tid: crate::util::current_tid(),
                            job_id: job.unwrap_or(0),
                            kind: "TaskProgress",
                            worker: None,
                            file: None,
                            detail: Some(format!(
                                "{:.1}% · {files}/{total} files · {} of {}",
                                p * 100.0,
                                crate::util::human_bytes(bytes_done),
                                crate::util::human_bytes(bytes_total)
                            )),
                        };
                        push_app(&a, &e, self_pid, &thread_names());
                    }
                }
            }
            if last_query.elapsed() >= Duration::from_secs(1) {
                last_query = Instant::now();
                if let Some(s) = a.etw.lock().unwrap().as_ref() {
                    if let Some(l) = s.query() {
                        *a.loss.lock().unwrap() = Some(l);
                    }
                }
            }
        }
        self.finalize(&a);
    }

    /// Stop → flush → persist → summarize. Runs at most once per session.
    fn finalize(&self, a: &Arc<Active>) {
        if a.finalizing.swap(true, Ordering::SeqCst) {
            return;
        }
        let reason = a.stop_reason.lock().unwrap().clone();
        a.view.lock().unwrap().stop_reason = reason;
        self.transition(a, SessionState::Stopping);
        let (is_workload, job_id) = {
            let v = a.view.lock().unwrap();
            (v.target.kind == "workload", v.job_id)
        };
        if is_workload {
            // Cancel while the observer is still attached so the cancellation is recorded.
            if a.cancel.load(Ordering::Relaxed) {
                if let Some(j) = job_id {
                    let _ = self.engine.cancel(j);
                    let t = Instant::now();
                    while !a.finished_jobs.lock().unwrap().contains(&j) && t.elapsed() < Duration::from_secs(3) {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                }
            }
            self.engine.set_observer(None);
        }
        // ETW flushes its buffers to the consumer before ProcessTrace returns.
        if let Some(s) = a.etw.lock().unwrap().take() {
            if let Some(l) = s.stop() {
                *a.loss.lock().unwrap() = Some(l);
            }
        }
        *a.tx.lock().unwrap() = None;
        if let Some(w) = a.writer.lock().unwrap().take() {
            let _ = w.join();
        }
        self.transition(a, SessionState::Finalizing);

        let result = (|| -> Result<Value, String> {
            let (start, end) = {
                let v = a.view.lock().unwrap();
                (v.started_at.unwrap_or(v.created_at), now_ms())
            };
            let window: Vec<_> = self
                .telemetry
                .history()
                .into_iter()
                .filter(|s| s.ts >= start - 2_000 && s.ts <= end + 2_000)
                .map(|s| (s.ts, s.rows()))
                .collect();
            self.db.insert_trace_telemetry(a.id, &window)?;
            let summary = self.db.trace_summary(a.id)?;
            serde_json::to_value(summary).map_err(|e| e.to_string())
        })();
        let final_state = if a.cancel.load(Ordering::Relaxed) { SessionState::Cancelled } else { SessionState::Completed };
        let (summary, error) = match result {
            Ok(s) => (Some(s), None),
            Err(e) => (None, Some(format!("Finalizing failed: {e}"))),
        };
        if let Some(e) = &error {
            a.view.lock().unwrap().error = Some(e.clone());
        }
        let v = self.view(a);
        let stats = json!(v.stats);
        let state = if v.error.is_some() { SessionState::Failed } else { final_state };
        let _ = self.db.finish_trace_session(a.id, state.as_str(), now_ms(), &stats, summary.as_ref(), v.error.as_deref());
        let _ = self.db.set_trace_schemas(a.id, &json!(v.schemas));
        let _ = self.db.enforce_trace_retention(KEEP_SESSIONS, MAX_STORED_EVENTS, a.id);
        self.transition(a, state);
    }

    fn fail(&self, a: &Arc<Active>, msg: &str, kind: Option<&'static str>) {
        a.finalizing.store(true, Ordering::SeqCst);
        {
            let mut v = a.view.lock().unwrap();
            v.error = Some(msg.to_string());
            v.error_kind = kind;
        }
        *a.tx.lock().unwrap() = None;
        if let Some(w) = a.writer.lock().unwrap().take() {
            let _ = w.join();
        }
        let v = self.view(a);
        let _ = self.db.finish_trace_session(a.id, "failed", now_ms(), &json!(v.stats), None, Some(msg));
        self.transition(a, SessionState::Failed);
    }

    /// Application exit: never leave an ETW session running.
    pub fn shutdown(&self) {
        let Some(a) = self.current.lock().unwrap().clone() else { return };
        if a.view.lock().unwrap().state.terminal() {
            return;
        }
        a.stop_reason.lock().unwrap().get_or_insert_with(|| "FlowDesk was closed during capture".into());
        a.cancel.store(true, Ordering::Relaxed);
        a.stop.store(true, Ordering::Relaxed);
        if !a.finalizing.swap(true, Ordering::SeqCst) {
            self.engine.set_observer(None);
            if let Some(s) = a.etw.lock().unwrap().take() {
                s.stop();
            }
            *a.tx.lock().unwrap() = None;
            if let Some(w) = a.writer.lock().unwrap().take() {
                let _ = w.join();
            }
            let v = self.view(&a);
            let _ = self.db.finish_trace_session(a.id, "cancelled", now_ms(), &json!(v.stats), None, Some("FlowDesk was closed during capture"));
        } else if let Some(s) = a.etw.lock().unwrap().take() {
            s.stop();
        }
        etw::stop_stale();
    }

    fn writer_loop(&self, a: &Arc<Active>, rx: Receiver<Msg>) {
        let mut events: Vec<TraceEvent> = Vec::with_capacity(BATCH);
        let mut comps: Vec<Completion> = Vec::new();
        let mut live_events: Vec<TraceEvent> = Vec::new();
        let mut live_comps: Vec<Completion> = Vec::new();
        let mut last_flush = Instant::now();
        let mut last_emit = Instant::now();
        let mut open = true;
        while open {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(first) => {
                    let mut next = Some(first);
                    while let Some(m) = next {
                        match m {
                            Msg::Event(e) => events.push(e),
                            Msg::Completion(c) => comps.push(c),
                        }
                        next = if events.len() + comps.len() < BATCH { rx.try_recv().ok() } else { None };
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => open = false,
            }
            let flush_now = !open || events.len() + comps.len() >= BATCH || last_flush.elapsed() >= FLUSH_EVERY;
            if flush_now && (!events.is_empty() || !comps.is_empty()) {
                last_flush = Instant::now();
                match self.db.insert_trace_batch(a.id, &events, &comps) {
                    Ok(_) => {
                        let mut w = a.writer_stats.lock().unwrap();
                        w.persisted += events.len() as u64;
                        w.completions += comps.len() as u64;
                        w.errors += comps.iter().filter(|c| c.status != "success").count() as u64;
                        for e in &events {
                            *w.by_category.entry(e.category.clone()).or_default() += 1;
                            w.first_event_us = Some(w.first_event_us.map_or(e.ts_us, |f| f.min(e.ts_us)));
                            w.last_event_us = Some(w.last_event_us.map_or(e.ts_us, |l| l.max(e.ts_us)));
                        }
                        let room = LIVE_CAP.saturating_sub(live_events.len());
                        let overflow = events.len().saturating_sub(room);
                        w.not_streamed += overflow as u64;
                        live_events.extend(events.drain(..).take(room));
                        events.clear();
                        live_comps.append(&mut comps);
                    }
                    Err(err) => {
                        a.view.lock().unwrap().error = Some(format!("Saving events failed: {err}"));
                        events.clear();
                        comps.clear();
                    }
                }
            }
            if !open || last_emit.elapsed() >= EMIT_EVERY {
                last_emit = Instant::now();
                if let Some(app) = self.app.get() {
                    if !live_events.is_empty() || !live_comps.is_empty() {
                        let _ = app.emit(
                            "trace://batch",
                            LiveBatch { session_id: a.id, events: &live_events, completions: &live_comps },
                        );
                    }
                }
                live_events.clear();
                live_comps.clear();
                self.emit_state(a);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::ops::Op;
    use crate::engine::{EngineConfig, Policy, SubmitRequest};

    struct Rig {
        base: std::path::PathBuf,
        db: Arc<Db>,
        tm: Arc<TraceManager>,
    }

    fn rig(tag: &str, files: usize, size: usize) -> Rig {
        let base = std::env::temp_dir().join(format!("flowdesk-trace-{tag}-{}-{}", std::process::id(), now_us()));
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        for i in 0..files {
            std::fs::write(src.join(format!("f{i}.bin")), vec![i as u8; size]).unwrap();
        }
        let db = Arc::new(Db::open(&base.join("t.sqlite")).unwrap());
        let engine = Engine::new(
            Arc::clone(&db),
            base.join("reports"),
            EngineConfig { policy: Policy::Fcfs, workers: 2, quantum_ms: 50, max_workers_per_task: 2 },
        );
        engine.start_workers();
        let tm = TraceManager::new(Arc::clone(&db), engine, Telemetry::new(1000));
        Rig { base, db, tm }
    }

    fn cfg(r: &Rig, providers: &[&str], op: Op) -> TraceConfig {
        TraceConfig {
            target: TargetSpec::Workload {
                job: SubmitRequest {
                    name: "traced".into(),
                    op,
                    folder: r.base.join("src").to_string_lossy().into_owned(),
                    dest: None,
                    priority: 5,
                },
            },
            name: None,
            providers: providers.iter().map(|s| s.to_string()).collect(),
            file_completions: true,
            file_metadata: false,
            max_duration_s: 60,
            max_events: 250_000,
            buffer_kb: 256,
            max_buffers: 64,
            stop_with_workload: true,
            exclude_tracer_io: true,
            path_filter: None,
        }
    }

    fn wait_terminal(tm: &TraceManager, secs: u64) -> SessionView {
        let t = Instant::now();
        loop {
            let v = tm.current().unwrap();
            if v.state.terminal() {
                return v;
            }
            assert!(t.elapsed() < Duration::from_secs(secs), "session stuck in {:?}", v.state);
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn all_events(db: &Db, id: i64) -> Vec<TraceEvent> {
        db.trace_events(id, 0, 50_000).unwrap()
    }

    #[test]
    fn app_events_session_runs_full_lifecycle_with_workload() {
        let r = rig("app", 4, 300_000);
        let v = r.tm.start(cfg(&r, &[], Op::Hash)).unwrap();
        assert_eq!(v.mode, "app");
        assert_eq!(v.state, SessionState::Capturing);
        // A second session cannot start while this one is active.
        assert!(r.tm.start(cfg(&r, &[], Op::Hash)).unwrap_err().contains("still active"));

        let done = wait_terminal(&r.tm, 30);
        assert_eq!(done.state, SessionState::Completed, "{:?}", done.error);
        assert_eq!(done.stop_reason.as_deref(), Some("Workload completed"));
        let job = done.job_id.expect("job linked to the session");

        let evs = all_events(&r.db, v.id);
        assert!(evs.iter().all(|e| e.source == model::EventSource::Flowdesk && e.category == "workload"));
        assert!(evs.windows(2).all(|w| w[0].seq < w[1].seq), "persisted in seq order");
        let count = |k: &str| evs.iter().filter(|e| e.event_name == k).count();
        assert_eq!(count("UnitDispatched"), 4);
        assert_eq!(count("UnitCompleted"), 4);
        assert_eq!(count("TaskFinished"), 1);
        assert_eq!(count("TaskStarted"), 1);
        assert!(evs.iter().all(|e| e.provider == "FlowDesk.Engine"), "no event is labelled as ETW in fallback mode");
        assert_eq!(done.stats.etw_events(), 0);
        assert!(evs.iter().all(|e| e.fields["jobId"] == json!(job)));
        assert!(evs
            .iter()
            .filter(|e| e.event_name == "UnitDispatched")
            .all(|e| e.thread_name.as_deref().is_some_and(|n| n.starts_with("flowdesk-worker-"))));

        let rec = r.db.get_trace_session(v.id).unwrap().unwrap();
        assert_eq!((rec.state.as_str(), rec.events, rec.job_id), ("completed", evs.len() as i64, Some(job)));
        assert!(rec.summary.is_some());
        assert_eq!(done.stats.persisted, evs.len() as u64);
        assert_eq!(done.stats.etw_events_lost, None, "no ETW session, so no loss figures are claimed");
        // A new session may start once the previous one is terminal.
        let again = r.tm.start(cfg(&r, &[], Op::Index)).unwrap();
        assert_eq!(wait_terminal(&r.tm, 30).state, SessionState::Completed);
        assert_ne!(again.id, v.id);
    }

    #[test]
    fn cancel_stops_session_and_linked_workload() {
        let r = rig("cancel", 6, 20_000_000);
        let v = r.tm.start(cfg(&r, &[], Op::Hash)).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        r.tm.cancel(v.id).unwrap();
        let done = wait_terminal(&r.tm, 30);
        assert_eq!(done.state, SessionState::Cancelled);
        assert_eq!(done.stop_reason.as_deref(), Some("Cancelled by user"));
        let job_id = done.job_id.unwrap();
        let t = Instant::now();
        let mut status = String::new();
        while status != "cancelled" && t.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(20));
            status = r.db.get_job(job_id).unwrap().unwrap().status;
        }
        assert_eq!(status, "cancelled");
        assert!(r.tm.stop(v.id).is_err(), "finished sessions cannot be stopped again");
        let names: Vec<String> = all_events(&r.db, v.id).into_iter().map(|e| e.event_name).collect();
        assert!(names.contains(&"CancelRequested".to_string()), "{names:?}");
        assert!(names.contains(&"TaskFinished".to_string()), "{names:?}");
    }

    #[test]
    fn invalid_workload_is_refused_before_any_session_exists() {
        let r = rig("badfolder", 1, 10);
        let mut c = cfg(&r, &["file"], Op::Hash);
        if let TargetSpec::Workload { job } = &mut c.target {
            job.folder = r.base.join("does-not-exist").to_string_lossy().into_owned();
        }
        assert!(r.tm.start(c).unwrap_err().contains("folder not found"));
        assert!(r.db.list_trace_sessions(10).unwrap().is_empty(), "no session record, no ETW attempt");
        assert!(r.tm.current().is_none());
    }

    #[test]
    fn external_process_without_providers_is_refused() {
        let r = rig("noprov", 1, 10);
        let mut c = cfg(&r, &[], Op::Hash);
        c.target = TargetSpec::Process { pid: 4, name: Some("System".into()) };
        assert!(r.tm.start(c).unwrap_err().contains("ETW provider"));
    }

    #[test]
    fn etw_without_privileges_fails_with_permission_explanation() {
        if etw::is_elevated() {
            eprintln!("elevated: permission-failure path not exercised");
            return;
        }
        let r = rig("perm", 2, 10);
        let v = r.tm.start(cfg(&r, &["file"], Op::Hash)).unwrap();
        // Unless the user is in Performance Log Users, StartTrace is denied.
        if v.state == SessionState::Failed {
            assert_eq!(v.error_kind, Some("permission"));
            assert!(v.error.unwrap().contains("Performance Log Users"));
            assert_eq!(r.db.get_trace_session(v.id).unwrap().unwrap().state, "failed");
            assert!(v.job_id.is_none(), "workload must not start when capture failed");
        } else {
            let _ = r.tm.stop(v.id);
            wait_terminal(&r.tm, 30);
        }
    }

    /// Real ETW capture of a FlowDesk hashing workload. Needs an elevated
    /// shell: `cargo test -- --ignored etw_live`. Writes the schemas TDH
    /// reported to target/etw-verification.json.
    #[test]
    #[ignore]
    fn etw_live_traces_hashing_workload() {
        assert!(etw::is_elevated(), "run from an elevated terminal");
        let r = rig("live", 5, 1_500_000);
        let v = r.tm.start(cfg(&r, &["file", "process", "disk"], Op::Hash)).unwrap();
        assert_eq!(v.state, SessionState::Capturing, "{:?}", v.error);
        assert!(v.providers.iter().all(|p| p.enabled), "{:?}", v.providers);
        let done = wait_terminal(&r.tm, 60);
        assert_eq!(done.state, SessionState::Completed, "{:?}", done.error);

        let evs = all_events(&r.db, v.id);
        let src = r.base.join("src").to_string_lossy().to_lowercase();
        let etw_file: Vec<_> = evs.iter().filter(|e| e.source == model::EventSource::Etw && e.category == "file").collect();
        let ours = |op: &str| {
            etw_file
                .iter()
                .filter(|e| {
                    e.operation.as_deref() == Some(op) && e.file_path.as_deref().is_some_and(|p| p.to_lowercase().starts_with(&src))
                })
                .count()
        };
        let report = json!({
            "session": done.id,
            "stats": done.stats,
            "providers": done.providers,
            "schemas": done.schemas,
            "creates_in_workload": ours("Create"),
            "reads_in_workload": ours("Read"),
            "operations": r.db.trace_summary(v.id).unwrap().operations,
        });
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("etw-verification.json");
        std::fs::write(&out, serde_json::to_string_pretty(&report).unwrap()).unwrap();
        eprintln!("wrote {}", out.display());

        assert!(ours("Create") >= 5, "Create events for the hashed files");
        assert!(ours("Read") >= 5, "Read events for the hashed files");
        assert!(etw_file.iter().any(|e| e.duration_us.is_some()), "some completions matched by IRP");
        assert!(etw_file.iter().all(|e| e.pid == Some(std::process::id())));
        assert!(evs.iter().any(|e| e.source == model::EventSource::Flowdesk));
        assert!(done.stats.etw_events_lost.is_some());
    }
}
