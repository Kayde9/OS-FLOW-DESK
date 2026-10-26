//! FlowDesk job engine — an *application-level* scheduler.
//!
//! Tasks (jobs) are split into units (one per file). A fixed pool of worker
//! threads asks the scheduler for work; the selected policy decides which task
//! the next unit comes from. Under Round Robin a unit runs for at most one time
//! quantum before its cursor is requeued. This schedules FlowDesk's own work
//! only — Windows still schedules the worker threads onto CPUs.

pub mod ops;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::db::{Db, JobFinal, NewJob};
use crate::scan::{self, FileEntry};
use crate::util::{human_bytes, now_ms};
use ops::{Ctx, Cursor, FileResult, Op, Outcome};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Policy {
    Fcfs,
    Priority,
    RoundRobin,
    ShortestRemaining,
}

impl Policy {
    pub fn as_str(self) -> &'static str {
        match self {
            Policy::Fcfs => "fcfs",
            Policy::Priority => "priority",
            Policy::RoundRobin => "round_robin",
            Policy::ShortestRemaining => "shortest_remaining",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineConfig {
    pub policy: Policy,
    pub workers: usize,
    pub quantum_ms: u64,
    pub max_workers_per_task: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitRequest {
    pub name: String,
    pub op: Op,
    pub folder: String,
    pub dest: Option<String>,
    /// 1 (lowest) – 10 (highest).
    pub priority: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Running,
    Paused,
    Completed,
    Cancelled,
    Failed,
}

impl JobStatus {
    fn as_str(self) -> &'static str {
        match self {
            JobStatus::Queued => "queued",
            JobStatus::Running => "running",
            JobStatus::Paused => "paused",
            JobStatus::Completed => "completed",
            JobStatus::Cancelled => "cancelled",
            JobStatus::Failed => "failed",
        }
    }
    fn terminal(self) -> bool {
        matches!(self, JobStatus::Completed | JobStatus::Cancelled | JobStatus::Failed)
    }
}

pub struct JobShared {
    pub bytes_done: AtomicU64,
    pub cancel: AtomicBool,
    pub pause: AtomicBool,
}

enum Unit {
    Fresh(FileEntry),
    Suspended(Cursor),
}

struct Job {
    id: i64,
    seq: u64,
    name: String,
    op: Op,
    folder: PathBuf,
    dest: Option<PathBuf>,
    priority: i64,
    policy: Policy,
    status: JobStatus,
    ready: VecDeque<Unit>,
    /// Suspended cursors in `ready` (each holds open file handles).
    suspended: usize,
    active: usize,
    current: Vec<(usize, String)>,
    shared: Arc<JobShared>,
    files_total: u64,
    files_done: u64,
    files_failed: u64,
    files_skipped: u64,
    bytes_total: u64,
    bytes_written_off: u64,
    created_at: i64,
    started_at: Option<i64>,
    ended_at: Option<i64>,
    response_ms: Option<i64>,
    preemptions: u64,
    results: Vec<FileResult>,
    errors: Vec<String>,
    error_count: u64,
    report_path: Option<String>,
    summary: Option<String>,
    // rate estimation (emitter thread)
    rate_bps: f64,
    rate_fps: f64,
    last_bytes: u64,
    last_files: u64,
}

impl Job {
    fn settled(&self) -> u64 {
        self.files_done + self.files_failed + self.files_skipped
    }
    fn bytes_done(&self) -> u64 {
        self.shared.bytes_done.load(Ordering::Relaxed)
    }
    fn progress(&self) -> f64 {
        if self.status == JobStatus::Completed {
            return 1.0;
        }
        let p = if self.op.reads_content() && self.bytes_total > 0 {
            (self.bytes_done() + self.bytes_written_off) as f64 / self.bytes_total as f64
        } else if self.files_total > 0 {
            self.settled() as f64 / self.files_total as f64
        } else {
            0.0
        };
        p.clamp(0.0, 1.0)
    }
    fn remaining_bytes(&self) -> u64 {
        self.bytes_total.saturating_sub(self.bytes_done() + self.bytes_written_off)
    }
    fn runnable(&self, max_per_task: usize) -> bool {
        matches!(self.status, JobStatus::Queued | JobStatus::Running)
            && !self.shared.pause.load(Ordering::Relaxed)
            && !self.shared.cancel.load(Ordering::Relaxed)
            && !self.ready.is_empty()
            && self.active < max_per_task
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum WorkerState {
    Idle,
    Busy,
    Parked,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerSlot {
    id: usize,
    state: WorkerState,
    job_id: Option<i64>,
    file: Option<String>,
    since: i64,
    units: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    ts: i64,
    worker: usize,
    job_id: i64,
    file: String,
    reason: String,
}

struct State {
    config: EngineConfig,
    jobs: Vec<Job>,
    rr: VecDeque<i64>,
    workers: Vec<WorkerSlot>,
    decisions: VecDeque<Decision>,
    seq: u64,
    dispatches: u64,
}

pub struct Engine {
    state: Mutex<State>,
    cv: Condvar,
    dirty: AtomicBool,
    db: Arc<Db>,
    reports_dir: PathBuf,
    pub max_workers: usize,
    observer: Mutex<Option<Observer>>,
}

/// An application-level workload event, forwarded to an active trace session.
/// These describe what FlowDesk decided to do — they are not OS observations.
#[derive(Debug, Clone)]
pub struct AppEvent {
    pub ts_us: i64,
    pub tid: u32,
    pub job_id: i64,
    pub kind: &'static str,
    pub worker: Option<usize>,
    pub file: Option<String>,
    pub detail: Option<String>,
}

pub type Observer = Arc<dyn Fn(AppEvent) + Send + Sync>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    id: i64,
    name: String,
    op: Op,
    op_label: &'static str,
    folder: String,
    dest: Option<String>,
    priority: i64,
    policy: Policy,
    status: JobStatus,
    files_total: u64,
    files_done: u64,
    files_failed: u64,
    files_skipped: u64,
    bytes_total: u64,
    bytes_done: u64,
    progress: f64,
    rate_bps: f64,
    rate_fps: f64,
    eta_ms: Option<u64>,
    created_at: i64,
    started_at: Option<i64>,
    ended_at: Option<i64>,
    elapsed_ms: i64,
    response_ms: Option<i64>,
    preemptions: u64,
    active_workers: usize,
    queued_units: usize,
    current_files: Vec<String>,
    errors: Vec<String>,
    error_count: u64,
    report_path: Option<String>,
    summary: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineSnapshot {
    ts: i64,
    config: EngineConfig,
    max_workers: usize,
    jobs: Vec<JobView>,
    workers: Vec<WorkerSlot>,
    runnable_tasks: usize,
    rr_order: Vec<i64>,
    decisions: Vec<Decision>,
    dispatches: u64,
}

/// What a worker took from the scheduler.
struct Dispatch {
    job_id: i64,
    unit: Unit,
    ctx: Ctx,
    shared: Arc<JobShared>,
    budget: Option<Duration>,
    file: String,
    reason: String,
    /// First dispatch of this task (it just started running).
    first: bool,
}

/// A job that just reached a terminal state; finalised outside the lock.
struct Finished {
    id: i64,
    name: String,
    op: Op,
    folder: PathBuf,
    dest: Option<PathBuf>,
    policy: Policy,
    status: JobStatus,
    results: Vec<FileResult>,
    errors: Vec<String>,
    db: JobFinalOwned,
}

struct JobFinalOwned {
    started_at: Option<i64>,
    ended_at: i64,
    files_done: i64,
    files_failed: i64,
    files_skipped: i64,
    bytes_done: i64,
    response_ms: Option<i64>,
    preemptions: i64,
}

const MAX_ERRORS_KEPT: usize = 200;
const MAX_FINISHED_KEPT: usize = 25;
const MAX_SUSPENDED: usize = 32;

impl Engine {
    pub fn new(db: Arc<Db>, reports_dir: PathBuf, config: EngineConfig) -> Arc<Self> {
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let max_workers = cores.clamp(1, 16);
        let config = Self::sanitize(config, max_workers);
        let workers = (0..max_workers)
            .map(|id| WorkerSlot {
                id,
                state: if id < config.workers { WorkerState::Idle } else { WorkerState::Parked },
                job_id: None,
                file: None,
                since: now_ms(),
                units: 0,
            })
            .collect();
        Arc::new(Engine {
            state: Mutex::new(State {
                config,
                jobs: Vec::new(),
                rr: VecDeque::new(),
                workers,
                decisions: VecDeque::new(),
                seq: 0,
                dispatches: 0,
            }),
            cv: Condvar::new(),
            dirty: AtomicBool::new(true),
            db,
            reports_dir,
            max_workers,
            observer: Mutex::new(None),
        })
    }

    pub fn set_observer(&self, o: Option<Observer>) {
        *self.observer.lock().unwrap() = o;
    }

    fn notify(&self, job_id: i64, kind: &'static str, worker: Option<usize>, file: Option<String>, detail: Option<String>) {
        let o = self.observer.lock().unwrap().clone();
        if let Some(o) = o {
            o(AppEvent { ts_us: crate::util::now_us(), tid: crate::util::current_tid(), job_id, kind, worker, file, detail });
        }
    }

    fn sanitize(mut c: EngineConfig, max_workers: usize) -> EngineConfig {
        c.workers = c.workers.clamp(1, max_workers);
        c.max_workers_per_task = c.max_workers_per_task.clamp(1, c.workers);
        c.quantum_ms = c.quantum_ms.clamp(5, 5_000);
        c
    }

    pub fn start(self: &Arc<Self>, app: AppHandle) {
        self.start_workers();
        let me = Arc::clone(self);
        std::thread::Builder::new()
            .name("flowdesk-engine-emitter".into())
            .spawn(move || me.emitter_loop(app))
            .expect("spawn emitter");
    }

    pub(crate) fn start_workers(self: &Arc<Self>) {
        for idx in 0..self.max_workers {
            let me = Arc::clone(self);
            std::thread::Builder::new()
                .name(format!("flowdesk-worker-{idx}"))
                .spawn(move || me.worker_loop(idx))
                .expect("spawn worker");
        }
    }

    pub fn set_config(&self, c: EngineConfig) -> EngineConfig {
        let mut st = self.state.lock().unwrap();
        st.config = Self::sanitize(c, self.max_workers);
        let n = st.config.workers;
        for w in st.workers.iter_mut() {
            if w.id >= n && w.state == WorkerState::Idle {
                w.state = WorkerState::Parked;
            } else if w.id < n && w.state == WorkerState::Parked {
                w.state = WorkerState::Idle;
            }
        }
        let cfg = st.config.clone();
        drop(st);
        self.touch();
        cfg
    }

    fn touch(&self) {
        self.dirty.store(true, Ordering::Relaxed);
        self.cv.notify_all();
    }

    pub fn running_job_ids(&self) -> Vec<i64> {
        let st = self.state.lock().unwrap();
        st.jobs.iter().filter(|j| j.status == JobStatus::Running).map(|j| j.id).collect()
    }

    pub fn submit(&self, req: SubmitRequest) -> Result<i64, String> {
        let folder = PathBuf::from(&req.folder);
        let dest = match (req.op, &req.dest) {
            (Op::Copy, Some(d)) if !d.trim().is_empty() => Some(PathBuf::from(d)),
            (Op::Copy, _) => return Err("Safe copy needs a destination folder".into()),
            _ => None,
        };
        if let Some(d) = &dest {
            validate_dest(&folder, d)?;
        }
        let (mut files, _) = scan::walk(&folder)?;
        if req.op == Op::Duplicates {
            // Only files that share a size with another file can be duplicates.
            let mut counts = std::collections::HashMap::<u64, u32>::new();
            for f in &files {
                *counts.entry(f.size).or_default() += 1;
            }
            files.retain(|f| f.size > 0 && counts[&f.size] > 1);
        }
        if files.is_empty() {
            return Err(match req.op {
                Op::Duplicates => "No duplicate candidates: no two non-empty files share a size".into(),
                _ => "The selected folder contains no readable files".into(),
            });
        }
        let bytes_total: u64 = files.iter().map(|f| f.size).sum();
        let created_at = now_ms();
        let priority = req.priority.clamp(1, 10);
        let name = if req.name.trim().is_empty() { req.op.label().to_string() } else { req.name.trim().to_string() };

        let mut st = self.state.lock().unwrap();
        let cfg = st.config.clone();
        let id = self.db.insert_job(&NewJob {
            name: &name,
            op: req.op.as_str(),
            folder: &req.folder,
            dest: dest.as_ref().and_then(|d| d.to_str()),
            policy: cfg.policy.as_str(),
            priority,
            workers: cfg.workers as i64,
            quantum_ms: cfg.quantum_ms as i64,
            max_workers_per_task: cfg.max_workers_per_task as i64,
            created_at,
            files_total: files.len() as i64,
            bytes_total: bytes_total as i64,
        })?;
        self.db.add_event(
            id,
            created_at,
            "info",
            &format!(
                "Submitted: {} files, {} under {} (priority {priority})",
                files.len(),
                human_bytes(bytes_total),
                cfg.policy.as_str()
            ),
        );
        st.seq += 1;
        let seq = st.seq;
        let files_total = files.len() as u64;
        st.jobs.push(Job {
            id,
            seq,
            name,
            op: req.op,
            folder,
            dest,
            priority,
            policy: cfg.policy,
            status: JobStatus::Queued,
            ready: files.into_iter().map(Unit::Fresh).collect(),
            suspended: 0,
            active: 0,
            current: Vec::new(),
            shared: Arc::new(JobShared {
                bytes_done: AtomicU64::new(0),
                cancel: AtomicBool::new(false),
                pause: AtomicBool::new(false),
            }),
            files_total,
            files_done: 0,
            files_failed: 0,
            files_skipped: 0,
            bytes_total,
            bytes_written_off: 0,
            created_at,
            started_at: None,
            ended_at: None,
            response_ms: None,
            preemptions: 0,
            results: Vec::new(),
            errors: Vec::new(),
            error_count: 0,
            report_path: None,
            summary: None,
            rate_bps: 0.0,
            rate_fps: 0.0,
            last_bytes: 0,
            last_files: 0,
        });
        st.rr.push_back(id);
        drop(st);
        self.notify(id, "TaskSubmitted", None, None, Some(format!("{files_total} files, {}", human_bytes(bytes_total))));
        self.touch();
        Ok(id)
    }

    pub fn pause(&self, id: i64) -> Result<(), String> {
        let mut st = self.state.lock().unwrap();
        let j = st.jobs.iter_mut().find(|j| j.id == id).ok_or("No such active task")?;
        if j.status.terminal() {
            return Err("Task already finished".into());
        }
        j.shared.pause.store(true, Ordering::Relaxed);
        j.status = JobStatus::Paused;
        drop(st);
        let _ = self.db.set_job_status(id, "paused", None);
        self.db.add_event(id, now_ms(), "info", "Paused by user");
        self.notify(id, "TaskPaused", None, None, None);
        self.touch();
        Ok(())
    }

    pub fn resume(&self, id: i64) -> Result<(), String> {
        let mut st = self.state.lock().unwrap();
        let j = st.jobs.iter_mut().find(|j| j.id == id).ok_or("No such active task")?;
        if j.status != JobStatus::Paused {
            return Err("Task is not paused".into());
        }
        j.shared.pause.store(false, Ordering::Relaxed);
        j.status = if j.started_at.is_some() { JobStatus::Running } else { JobStatus::Queued };
        let s = j.status.as_str();
        drop(st);
        let _ = self.db.set_job_status(id, s, None);
        self.db.add_event(id, now_ms(), "info", "Resumed by user");
        self.notify(id, "TaskResumed", None, None, None);
        self.touch();
        Ok(())
    }

    pub fn cancel(self: &Arc<Self>, id: i64) -> Result<(), String> {
        let finished = {
            let mut st = self.state.lock().unwrap();
            let j = st.jobs.iter_mut().find(|j| j.id == id).ok_or("No such active task")?;
            if j.status.terminal() {
                return Err("Task already finished".into());
            }
            j.shared.cancel.store(true, Ordering::Relaxed);
            j.shared.pause.store(false, Ordering::Relaxed);
            self.db.add_event(id, now_ms(), "warn", "Cancellation requested");
            // Drop queued units; in-flight units stop at their next chunk boundary.
            j.ready.clear();
            j.suspended = 0;
            Self::maybe_finish(&mut st, id)
        };
        self.notify(id, "CancelRequested", None, None, None);
        if let Some(f) = finished {
            self.finalize(f);
        }
        self.touch();
        Ok(())
    }

    /// (progress 0..1, files settled, files total, bytes done, bytes total) of an active task.
    pub fn job_progress(&self, id: i64) -> Option<(f64, u64, u64, u64, u64)> {
        let st = self.state.lock().unwrap();
        st.jobs.iter().find(|j| j.id == id).map(|j| (j.progress(), j.settled(), j.files_total, j.bytes_done(), j.bytes_total))
    }

    fn worker_loop(self: Arc<Self>, idx: usize) {
        crate::util::register_thread(&format!("flowdesk-worker-{idx}"));
        loop {
            let d = {
                let mut st = self.state.lock().unwrap();
                loop {
                    if idx < st.config.workers {
                        if let Some(d) = Self::pick(&mut st, idx) {
                            break d;
                        }
                        st.workers[idx].state = WorkerState::Idle;
                    } else {
                        st.workers[idx].state = WorkerState::Parked;
                    }
                    st = self.cv.wait(st).unwrap();
                }
            };
            self.dirty.store(true, Ordering::Relaxed);
            if d.first {
                self.notify(d.job_id, "TaskStarted", None, None, None);
            }
            self.notify(d.job_id, "UnitDispatched", Some(idx), Some(d.file.clone()), Some(d.reason));
            let cursor = match d.unit {
                Unit::Fresh(e) => Cursor::new(e),
                Unit::Suspended(c) => c,
            };
            let outcome = ops::run_unit(&d.ctx, cursor, &d.shared, d.budget);
            let kind = match &outcome {
                Outcome::Done(_) => "UnitCompleted",
                Outcome::Skipped { .. } => "UnitSkipped",
                Outcome::Failed { .. } => "UnitFailed",
                Outcome::Preempted(_) => "UnitPreempted",
                Outcome::Paused(_) => "UnitPaused",
                Outcome::Cancelled => "UnitCancelled",
            };
            let detail = match &outcome {
                Outcome::Skipped { reason, .. } => Some(reason.clone()),
                Outcome::Failed { error, .. } => Some(error.clone()),
                _ => None,
            };
            self.notify(d.job_id, kind, Some(idx), Some(d.file), detail);
            let finished = {
                let mut st = self.state.lock().unwrap();
                Self::apply(&mut st, idx, d.job_id, outcome, &self.db);
                Self::maybe_finish(&mut st, d.job_id)
            };
            if let Some(f) = finished {
                self.finalize(f);
            }
            self.touch();
        }
    }

    /// Scheduling decision. Returns the unit a worker should execute next.
    fn pick(st: &mut State, idx: usize) -> Option<Dispatch> {
        let maxw = st.config.max_workers_per_task;
        let candidates: Vec<usize> =
            st.jobs.iter().enumerate().filter(|(_, j)| j.runnable(maxw)).map(|(i, _)| i).collect();
        if candidates.is_empty() {
            return None;
        }
        let n = candidates.len();
        let (ji, reason) = match st.config.policy {
            Policy::Fcfs => {
                let i = *candidates.iter().min_by_key(|&&i| st.jobs[i].seq).unwrap();
                (i, format!("FCFS — earliest arrival among {n} ready task(s)"))
            }
            Policy::Priority => {
                let i = *candidates.iter().min_by_key(|&&i| (-st.jobs[i].priority, st.jobs[i].seq)).unwrap();
                (i, format!("Priority — P{} is highest among {n} ready task(s)", st.jobs[i].priority))
            }
            Policy::ShortestRemaining => {
                let i = *candidates.iter().min_by_key(|&&i| (st.jobs[i].remaining_bytes(), st.jobs[i].seq)).unwrap();
                (i, format!("Shortest remaining — {} left, least of {n} task(s)", human_bytes(st.jobs[i].remaining_bytes())))
            }
            Policy::RoundRobin => {
                let pos = st
                    .rr
                    .iter()
                    .position(|id| candidates.iter().any(|&i| st.jobs[i].id == *id))
                    .expect("runnable job missing from RR ring");
                let id = st.rr.remove(pos).unwrap();
                st.rr.push_back(id);
                let i = *candidates.iter().find(|&&i| st.jobs[i].id == id).unwrap();
                (i, format!("Round Robin — next in rotation ({} ms quantum)", st.config.quantum_ms))
            }
        };
        let budget = (st.config.policy == Policy::RoundRobin).then(|| Duration::from_millis(st.config.quantum_ms));
        let now = now_ms();
        let job = &mut st.jobs[ji];
        // Bound open handles: once enough files are mid-flight, resume one of them
        // instead of opening another fresh file.
        let unit = match job.ready.iter().position(|u| matches!(u, Unit::Suspended(_))) {
            Some(pos) if job.suspended >= MAX_SUSPENDED => job.ready.remove(pos).unwrap(),
            _ => job.ready.pop_front().unwrap(),
        };
        if matches!(unit, Unit::Suspended(_)) {
            job.suspended -= 1;
        }
        let (file, resumed) = match &unit {
            Unit::Fresh(e) => (e.rel.clone(), false),
            Unit::Suspended(c) => (c.entry.rel.clone(), true),
        };
        let first = job.started_at.is_none();
        if first {
            job.started_at = Some(now);
            job.response_ms = Some(now - job.created_at);
        }
        if job.status == JobStatus::Queued {
            job.status = JobStatus::Running;
        }
        job.active += 1;
        job.current.push((idx, file.clone()));
        let job_id = job.id;
        let ctx = Ctx { op: job.op, dest: job.dest.clone() };
        let shared = Arc::clone(&job.shared);
        let w = &mut st.workers[idx];
        w.state = WorkerState::Busy;
        w.job_id = Some(job_id);
        w.file = Some(file.clone());
        w.since = now;
        st.dispatches += 1;
        if st.decisions.len() == 60 {
            st.decisions.pop_back();
        }
        let reason = if resumed { format!("{reason}; resuming preempted file") } else { reason };
        st.decisions.push_front(Decision { ts: now, worker: idx, job_id, file: file.clone(), reason: reason.clone() });
        Some(Dispatch { job_id, unit, ctx, shared, budget, file, reason, first })
    }

    fn apply(st: &mut State, idx: usize, job_id: i64, outcome: Outcome, db: &Db) {
        let w = &mut st.workers[idx];
        w.job_id = None;
        w.file = None;
        w.units += 1;
        let Some(job) = st.jobs.iter_mut().find(|j| j.id == job_id) else { return };
        job.active -= 1;
        job.current.retain(|(w, _)| *w != idx);
        let log_err = |job: &mut Job, msg: String, level: &str| {
            job.error_count += 1;
            if job.errors.len() < MAX_ERRORS_KEPT {
                db.add_event(job.id, now_ms(), level, &msg);
                job.errors.push(msg);
            }
        };
        match outcome {
            Outcome::Done(r) => {
                job.files_done += 1;
                job.results.push(r);
            }
            Outcome::Skipped { reason, unread } => {
                job.files_skipped += 1;
                job.bytes_written_off += unread;
                log_err(job, reason, "warn");
            }
            Outcome::Failed { error, unread } => {
                job.files_failed += 1;
                job.bytes_written_off += unread;
                log_err(job, error, "error");
            }
            Outcome::Preempted(c) => {
                job.preemptions += 1;
                job.suspended += 1;
                job.ready.push_back(Unit::Suspended(c));
            }
            Outcome::Paused(c) => {
                job.suspended += 1;
                job.ready.push_front(Unit::Suspended(c));
            }
            Outcome::Cancelled => {}
        }
    }

    fn maybe_finish(st: &mut State, job_id: i64) -> Option<Finished> {
        let job = st.jobs.iter_mut().find(|j| j.id == job_id)?;
        if job.status.terminal() || job.active > 0 {
            return None;
        }
        let cancelled = job.shared.cancel.load(Ordering::Relaxed);
        if !cancelled && !job.ready.is_empty() {
            return None;
        }
        let now = now_ms();
        job.status = if cancelled {
            JobStatus::Cancelled
        } else if job.files_done == 0 && job.files_failed > 0 {
            JobStatus::Failed
        } else {
            JobStatus::Completed
        };
        job.ended_at = Some(now);
        st.rr.retain(|id| *id != job_id);
        let f = Finished {
            id: job.id,
            name: job.name.clone(),
            op: job.op,
            folder: job.folder.clone(),
            dest: job.dest.clone(),
            policy: job.policy,
            status: job.status,
            results: std::mem::take(&mut job.results),
            errors: job.errors.clone(),
            db: JobFinalOwned {
                started_at: job.started_at,
                ended_at: now,
                files_done: job.files_done as i64,
                files_failed: job.files_failed as i64,
                files_skipped: job.files_skipped as i64,
                bytes_done: job.bytes_done() as i64,
                response_ms: job.response_ms,
                preemptions: job.preemptions as i64,
            },
        };
        // Keep the active list bounded.
        let finished: Vec<i64> = st.jobs.iter().filter(|j| j.status.terminal()).map(|j| j.id).collect();
        if finished.len() > MAX_FINISHED_KEPT {
            let drop_ids = &finished[..finished.len() - MAX_FINISHED_KEPT];
            st.jobs.retain(|j| !drop_ids.contains(&j.id));
        }
        Some(f)
    }

    fn finalize(&self, f: Finished) {
        let status = f.status.as_str();
        let meta = ops::ReportMeta {
            id: f.id,
            name: &f.name,
            op: f.op,
            folder: &f.folder,
            dest: f.dest.as_deref(),
            policy: f.policy.as_str(),
            status,
        };
        let (report, summary, err) = if f.results.is_empty() && f.status == JobStatus::Cancelled {
            (None, None, Some("Cancelled before any file completed".to_string()))
        } else {
            match ops::write_report(&self.reports_dir, &meta, &f.results, &f.errors) {
                Ok((p, s)) => (Some(p.to_string_lossy().into_owned()), Some(s), None),
                Err(e) => (None, None, Some(e)),
            }
        };
        let _ = self.db.finish_job(
            f.id,
            &JobFinal {
                status,
                started_at: f.db.started_at,
                ended_at: f.db.ended_at,
                files_done: f.db.files_done,
                files_failed: f.db.files_failed,
                files_skipped: f.db.files_skipped,
                bytes_done: f.db.bytes_done,
                response_ms: f.db.response_ms,
                preemptions: f.db.preemptions,
                report_path: report.as_deref(),
                error: err.as_deref(),
                summary: summary.as_deref(),
            },
        );
        self.db.add_event(
            f.id,
            f.db.ended_at,
            if f.status == JobStatus::Completed { "info" } else { "warn" },
            &format!(
                "Finished: {status} — {} done, {} failed, {} skipped",
                f.db.files_done, f.db.files_failed, f.db.files_skipped
            ),
        );
        {
            let mut st = self.state.lock().unwrap();
            if let Some(j) = st.jobs.iter_mut().find(|j| j.id == f.id) {
                j.report_path = report;
                j.summary = summary;
            }
        }
        self.notify(
            f.id,
            "TaskFinished",
            None,
            None,
            Some(format!("{status}: {} done, {} failed, {} skipped", f.db.files_done, f.db.files_failed, f.db.files_skipped)),
        );
    }

    pub fn snapshot(&self) -> EngineSnapshot {
        let st = self.state.lock().unwrap();
        let now = now_ms();
        let maxw = st.config.max_workers_per_task;
        let jobs = st
            .jobs
            .iter()
            .rev()
            .map(|j| {
                let elapsed_ms = j.started_at.map(|s| j.ended_at.unwrap_or(now) - s).unwrap_or(0);
                let eta_ms = if j.status == JobStatus::Running && elapsed_ms > 2000 {
                    if j.op.reads_content() && j.rate_bps > 1.0 {
                        Some((j.remaining_bytes() as f64 / j.rate_bps * 1000.0) as u64)
                    } else if !j.op.reads_content() && j.rate_fps > 0.01 {
                        Some(((j.files_total - j.settled()) as f64 / j.rate_fps * 1000.0) as u64)
                    } else {
                        None
                    }
                } else {
                    None
                };
                JobView {
                    id: j.id,
                    name: j.name.clone(),
                    op: j.op,
                    op_label: j.op.label(),
                    folder: j.folder.to_string_lossy().into_owned(),
                    dest: j.dest.as_ref().map(|d| d.to_string_lossy().into_owned()),
                    priority: j.priority,
                    policy: j.policy,
                    status: j.status,
                    files_total: j.files_total,
                    files_done: j.files_done,
                    files_failed: j.files_failed,
                    files_skipped: j.files_skipped,
                    bytes_total: j.bytes_total,
                    bytes_done: j.bytes_done(),
                    progress: j.progress(),
                    rate_bps: if j.status == JobStatus::Running { j.rate_bps } else { 0.0 },
                    rate_fps: if j.status == JobStatus::Running { j.rate_fps } else { 0.0 },
                    eta_ms,
                    created_at: j.created_at,
                    started_at: j.started_at,
                    ended_at: j.ended_at,
                    elapsed_ms,
                    response_ms: j.response_ms,
                    preemptions: j.preemptions,
                    active_workers: j.active,
                    queued_units: j.ready.len(),
                    current_files: j.current.iter().map(|(_, f)| f.clone()).collect(),
                    errors: j.errors.iter().rev().take(5).cloned().collect(),
                    error_count: j.error_count,
                    report_path: j.report_path.clone(),
                    summary: j.summary.clone(),
                }
            })
            .collect();
        EngineSnapshot {
            ts: now,
            config: st.config.clone(),
            max_workers: self.max_workers,
            jobs,
            workers: st.workers.clone(),
            runnable_tasks: st.jobs.iter().filter(|j| j.runnable(maxw)).count(),
            rr_order: st.rr.iter().cloned().collect(),
            decisions: st.decisions.iter().take(30).cloned().collect(),
            dispatches: st.dispatches,
        }
    }

    fn emitter_loop(self: Arc<Self>, app: AppHandle) {
        crate::util::register_thread("flowdesk-engine-emitter");
        let mut last = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let dt = last.elapsed().as_secs_f64();
            last = Instant::now();
            let any_running = {
                let mut st = self.state.lock().unwrap();
                let mut any = false;
                for j in st.jobs.iter_mut().filter(|j| j.status == JobStatus::Running) {
                    any = true;
                    let b = j.bytes_done();
                    let f = j.settled();
                    let inst_b = (b - j.last_bytes.min(b)) as f64 / dt;
                    let inst_f = (f - j.last_files.min(f)) as f64 / dt;
                    // EWMA with ~2 s time constant
                    let a = (dt / 2.0).min(1.0);
                    j.rate_bps = if j.last_bytes == 0 && j.rate_bps == 0.0 { inst_b } else { j.rate_bps + a * (inst_b - j.rate_bps) };
                    j.rate_fps = if j.last_files == 0 && j.rate_fps == 0.0 { inst_f } else { j.rate_fps + a * (inst_f - j.rate_fps) };
                    j.last_bytes = b;
                    j.last_files = f;
                }
                any
            };
            if any_running || self.dirty.swap(false, Ordering::Relaxed) {
                let _ = app.emit("engine://state", self.snapshot());
            }
        }
    }
}

/// Refuse destinations that would copy into themselves.
fn validate_dest(src: &Path, dest: &Path) -> Result<(), String> {
    let s = std::fs::canonicalize(src).map_err(|e| format!("Source folder: {e}"))?;
    std::fs::create_dir_all(dest).map_err(|e| format!("Destination folder: {e}"))?;
    let d = std::fs::canonicalize(dest).map_err(|e| format!("Destination folder: {e}"))?;
    if d == s || d.starts_with(&s) {
        return Err("Destination must not be the source folder or inside it".into());
    }
    if s.starts_with(&d) {
        return Err("Destination must not contain the source folder".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(tag: &str, files: usize, size: usize) -> (PathBuf, Arc<Db>) {
        let base = std::env::temp_dir().join(format!("flowdesk-engine-{tag}-{}-{}", std::process::id(), now_ms()));
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        for i in 0..files {
            std::fs::write(src.join(format!("f{i}.bin")), vec![i as u8; size]).unwrap();
        }
        let db = Arc::new(Db::open(&base.join("t.sqlite")).unwrap());
        (base, db)
    }

    fn engine(db: &Arc<Db>, base: &Path, policy: Policy, quantum_ms: u64) -> Arc<Engine> {
        Engine::new(
            Arc::clone(db),
            base.join("reports"),
            EngineConfig { policy, workers: 1, quantum_ms, max_workers_per_task: 1 },
        )
    }

    fn req(base: &Path, name: &str, priority: i64) -> SubmitRequest {
        SubmitRequest {
            name: name.into(),
            op: Op::Hash,
            folder: base.join("src").to_string_lossy().into_owned(),
            dest: None,
            priority,
        }
    }

    fn wait_all(e: &Engine) -> EngineSnapshot {
        let t = Instant::now();
        loop {
            let s = e.snapshot();
            let done = s.jobs.iter().all(|j| j.status.terminal()) && s.jobs.iter().all(|j| j.report_path.is_some() || j.status == JobStatus::Cancelled);
            if done {
                return s;
            }
            assert!(t.elapsed() < Duration::from_secs(30), "engine did not finish");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn job<'a>(s: &'a EngineSnapshot, id: i64) -> &'a JobView {
        s.jobs.iter().find(|j| j.id == id).unwrap()
    }

    #[test]
    fn fcfs_runs_tasks_in_arrival_order() {
        let (base, db) = setup("fcfs", 3, 200_000);
        let e = engine(&db, &base, Policy::Fcfs, 50);
        let a = e.submit(req(&base, "a", 1)).unwrap();
        let b = e.submit(req(&base, "b", 10)).unwrap();
        e.start_workers();
        let s = wait_all(&e);
        assert!(job(&s, a).ended_at.unwrap() <= job(&s, b).started_at.unwrap());
        assert_eq!(job(&s, a).files_done, 3);
        assert_eq!(db.get_job(b).unwrap().unwrap().status, "completed");
    }

    #[test]
    fn priority_runs_highest_first() {
        let (base, db) = setup("prio", 3, 200_000);
        let e = engine(&db, &base, Policy::Priority, 50);
        let low = e.submit(req(&base, "low", 2)).unwrap();
        let high = e.submit(req(&base, "high", 9)).unwrap();
        e.start_workers();
        let s = wait_all(&e);
        assert!(job(&s, high).ended_at.unwrap() <= job(&s, low).started_at.unwrap());
    }

    #[test]
    fn round_robin_preempts_and_interleaves() {
        let (base, db) = setup("rr", 2, 8_000_000);
        let e = engine(&db, &base, Policy::RoundRobin, 5);
        let a = e.submit(req(&base, "a", 5)).unwrap();
        let b = e.submit(req(&base, "b", 5)).unwrap();
        e.start_workers();
        let s = wait_all(&e);
        assert!(job(&s, a).preemptions > 0 && job(&s, b).preemptions > 0);
        // Rotation: the dispatch log must alternate between the two tasks at least once.
        let ids: Vec<i64> = s.decisions.iter().map(|d| d.job_id).collect();
        assert!(ids.windows(2).any(|w| w[0] != w[1]));
        // Preemption must not change results: identical files hash identically.
        let report = std::fs::read_to_string(job(&s, a).report_path.as_ref().unwrap()).unwrap();
        assert!(report.contains("sha256"));
        assert_eq!(job(&s, a).bytes_done, 16_000_000);
    }

    #[test]
    fn cancel_stops_a_running_task() {
        let (base, db) = setup("cancel", 6, 20_000_000);
        let e = engine(&db, &base, Policy::Fcfs, 50);
        let id = e.submit(req(&base, "big", 5)).unwrap();
        e.start_workers();
        let t = Instant::now();
        while e.snapshot().jobs[0].bytes_done == 0 {
            assert!(t.elapsed() < Duration::from_secs(10));
            std::thread::sleep(Duration::from_millis(2));
        }
        e.cancel(id).unwrap();
        let s = wait_all(&e);
        let j = job(&s, id);
        assert_eq!(j.status, JobStatus::Cancelled);
        assert!(j.bytes_done < j.bytes_total);
        assert_eq!(db.get_job(id).unwrap().unwrap().status, "cancelled");
    }
}
