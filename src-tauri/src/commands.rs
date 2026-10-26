use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;
use tauri_plugin_opener::OpenerExt;

use crate::db::{Db, JobEvent, JobRecord, MetricAggregate, SeriesPoint};
use crate::engine::{Engine, EngineConfig, EngineSnapshot, SubmitRequest};
use crate::scan::{self, ScanSummary};
use crate::telemetry::{ProcessList, Sample, SystemInfo, Telemetry};
use crate::trace::{
    export::{self, Redact},
    model::{TraceConfig, TraceEvent},
    store::{SessionRecord, Summary, TelemetryPoint},
    Capabilities, SessionView, TraceManager,
};
use crate::util::csv_field;

pub struct Paths {
    pub db_path: PathBuf,
    pub reports_dir: PathBuf,
}

type R<T> = Result<T, String>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    info: SystemInfo,
    last_sample_ts: u64,
    interval_ms: u64,
    db_path: String,
    reports_dir: String,
}

#[tauri::command]
pub fn app_status(t: State<'_, Arc<Telemetry>>, p: State<'_, Paths>) -> AppStatus {
    AppStatus {
        info: t.info(),
        last_sample_ts: t.last_ok(),
        interval_ms: t.interval_ms.load(std::sync::atomic::Ordering::Relaxed),
        db_path: p.db_path.to_string_lossy().into_owned(),
        reports_dir: p.reports_dir.to_string_lossy().into_owned(),
    }
}

#[tauri::command]
pub fn telemetry_history(t: State<'_, Arc<Telemetry>>) -> Vec<Sample> {
    t.history()
}

#[tauri::command]
pub fn set_telemetry_interval(ms: u64, t: State<'_, Arc<Telemetry>>, db: State<'_, Arc<Db>>) -> R<u64> {
    let ms = ms.clamp(500, 10_000);
    t.interval_ms.store(ms, std::sync::atomic::Ordering::Relaxed);
    db.set_preference("telemetry.intervalMs", &ms.to_string())?;
    Ok(ms)
}

#[tauri::command]
pub async fn list_processes(t: State<'_, Arc<Telemetry>>) -> R<ProcessList> {
    let t = Arc::clone(&t);
    tauri::async_runtime::spawn_blocking(move || t.list_processes()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn scan_folder(path: String) -> R<ScanSummary> {
    tauri::async_runtime::spawn_blocking(move || scan::walk(std::path::Path::new(&path)).map(|(_, s)| s))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn engine_state(e: State<'_, Arc<Engine>>) -> EngineSnapshot {
    e.snapshot()
}

#[tauri::command]
pub fn engine_set_config(config: EngineConfig, e: State<'_, Arc<Engine>>, db: State<'_, Arc<Db>>) -> R<EngineConfig> {
    let c = e.set_config(config);
    db.set_preference("engine.config", &serde_json::to_string(&c).map_err(|e| e.to_string())?)?;
    Ok(c)
}

#[tauri::command]
pub async fn submit_job(req: SubmitRequest, e: State<'_, Arc<Engine>>) -> R<i64> {
    let e = Arc::clone(&e);
    tauri::async_runtime::spawn_blocking(move || e.submit(req)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn pause_job(id: i64, e: State<'_, Arc<Engine>>) -> R<()> {
    e.pause(id)
}

#[tauri::command]
pub fn resume_job(id: i64, e: State<'_, Arc<Engine>>) -> R<()> {
    e.resume(id)
}

#[tauri::command]
pub fn cancel_job(id: i64, e: State<'_, Arc<Engine>>) -> R<()> {
    e.inner().cancel(id)
}

#[tauri::command]
pub fn list_jobs(limit: Option<i64>, db: State<'_, Arc<Db>>) -> R<Vec<JobRecord>> {
    db.list_jobs(limit.unwrap_or(500).clamp(1, 5000))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDetail {
    record: JobRecord,
    aggregates: Vec<MetricAggregate>,
    events: Vec<JobEvent>,
}

#[tauri::command]
pub fn job_detail(id: i64, db: State<'_, Arc<Db>>) -> R<JobDetail> {
    let record = db.get_job(id)?.ok_or("No such task")?;
    Ok(JobDetail { record, aggregates: db.job_aggregates(id)?, events: db.job_events(id)? })
}

#[tauri::command]
pub fn job_series(id: i64, db: State<'_, Arc<Db>>) -> R<Vec<SeriesPoint>> {
    db.job_series(id)
}

#[tauri::command]
pub fn delete_job(id: i64, db: State<'_, Arc<Db>>) -> R<()> {
    db.delete_job(id)
}

#[tauri::command]
pub fn clear_history(db: State<'_, Arc<Db>>) -> R<usize> {
    db.clear_history()
}

/// Writes the selected experiment records (with telemetry aggregates) to `path`.
#[tauri::command]
pub fn export_jobs_csv(ids: Vec<i64>, path: String, db: State<'_, Arc<Db>>) -> R<usize> {
    let metrics = ["cpu", "mem_used", "disk_read", "disk_write", "gpu_util", "gpu_temp", "cpu_temp", "app_cpu"];
    let mut out = String::from(
        "id,name,operation,folder,policy,priority,workers,quantum_ms,max_workers_per_task,status,created_at,started_at,ended_at,elapsed_ms,response_ms,files_total,files_done,files_failed,files_skipped,bytes_total,bytes_done,preemptions",
    );
    for m in metrics {
        out.push_str(&format!(",{m}_avg,{m}_max,{m}_unit,{m}_available_samples"));
    }
    out.push_str(",error\n");
    let mut n = 0;
    for id in ids {
        let Some(j) = db.get_job(id)? else { continue };
        let agg = db.job_aggregates(id)?;
        let opt = |v: Option<i64>| v.map(|v| v.to_string()).unwrap_or_default();
        out.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
            j.id,
            csv_field(&j.name),
            j.op,
            csv_field(&j.folder),
            j.policy,
            j.priority,
            j.workers,
            j.quantum_ms,
            j.max_workers_per_task,
            j.status,
            j.created_at,
            opt(j.started_at),
            opt(j.ended_at),
            opt(j.started_at.zip(j.ended_at).map(|(s, e)| e - s)),
            opt(j.response_ms),
            j.files_total,
            j.files_done,
            j.files_failed,
            j.files_skipped,
            j.bytes_total,
            j.bytes_done,
            j.preemptions
        ));
        for m in metrics {
            match agg.iter().find(|a| a.metric == m) {
                Some(a) => out.push_str(&format!(
                    ",{},{},{},{}",
                    a.avg.map(|v| format!("{v:.3}")).unwrap_or_default(),
                    a.max.map(|v| format!("{v:.3}")).unwrap_or_default(),
                    csv_field(&a.unit),
                    a.samples
                )),
                None => out.push_str(",,,,0"),
            }
        }
        out.push_str(&format!(",{}\n", csv_field(j.error.as_deref().unwrap_or(""))));
        n += 1;
    }
    std::fs::write(&path, out).map_err(|e| format!("Writing {path}: {e}"))?;
    Ok(n)
}

#[tauri::command]
pub fn get_preferences(db: State<'_, Arc<Db>>) -> R<Vec<(String, String)>> {
    db.get_preferences()
}

#[tauri::command]
pub fn set_preference(key: String, value: String, db: State<'_, Arc<Db>>) -> R<()> {
    db.set_preference(&key, &value)
}

// ------------------------------------------------------------------ tracing

#[tauri::command]
pub fn trace_capabilities(t: State<'_, Arc<TraceManager>>) -> Capabilities {
    t.capabilities()
}

#[tauri::command]
pub async fn trace_start(config: TraceConfig, t: State<'_, Arc<TraceManager>>) -> R<SessionView> {
    let t = Arc::clone(&t);
    tauri::async_runtime::spawn_blocking(move || t.start(config)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn trace_stop(id: i64, t: State<'_, Arc<TraceManager>>) -> R<()> {
    t.stop(id)
}

#[tauri::command]
pub fn trace_cancel(id: i64, t: State<'_, Arc<TraceManager>>) -> R<()> {
    t.cancel(id)
}

#[tauri::command]
pub fn trace_current(t: State<'_, Arc<TraceManager>>) -> Option<SessionView> {
    t.current()
}

#[tauri::command]
pub fn trace_sessions(limit: Option<i64>, db: State<'_, Arc<Db>>) -> R<Vec<SessionRecord>> {
    db.list_trace_sessions(limit.unwrap_or(100).clamp(1, 1000))
}

#[tauri::command]
pub fn trace_session(id: i64, db: State<'_, Arc<Db>>) -> R<SessionRecord> {
    db.get_trace_session(id)?.ok_or_else(|| format!("No trace session #{id}"))
}

#[tauri::command]
pub async fn trace_events(id: i64, after_seq: Option<i64>, limit: Option<i64>, db: State<'_, Arc<Db>>) -> R<Vec<TraceEvent>> {
    let db = Arc::clone(&db);
    tauri::async_runtime::spawn_blocking(move || db.trace_events(id, after_seq.unwrap_or(0), limit.unwrap_or(20_000).clamp(1, 50_000)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn trace_telemetry(id: i64, db: State<'_, Arc<Db>>) -> R<Vec<TelemetryPoint>> {
    db.trace_telemetry(id)
}

#[tauri::command]
pub async fn trace_summary(id: i64, db: State<'_, Arc<Db>>) -> R<Summary> {
    let db = Arc::clone(&db);
    tauri::async_runtime::spawn_blocking(move || db.trace_summary(id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn trace_delete(id: i64, db: State<'_, Arc<Db>>) -> R<usize> {
    db.delete_trace_session(id)
}

/// `format`: "csv" | "json" | "summary" (Markdown). Never an ETL file.
#[tauri::command]
pub async fn trace_export(id: i64, format: String, path: String, redact: Redact, db: State<'_, Arc<Db>>) -> R<usize> {
    let db = Arc::clone(&db);
    tauri::async_runtime::spawn_blocking(move || {
        let s = db.get_trace_session(id)?.ok_or_else(|| format!("No trace session #{id}"))?;
        if format == "summary" {
            let sum = db.trace_summary(id)?;
            std::fs::write(&path, export::summary_markdown(&s, &sum, redact)).map_err(|e| format!("Writing {path}: {e}"))?;
            Ok(sum.events as usize)
        } else {
            export::export(&db, &s, &format, &path, redact)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens a report file or folder that FlowDesk itself produced.
#[tauri::command]
pub fn open_path(path: String, reveal: bool, app: tauri::AppHandle) -> R<()> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("{path} no longer exists"));
    }
    if reveal {
        app.opener().reveal_item_in_dir(&p).map_err(|e| e.to_string())
    } else {
        app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
    }
}
