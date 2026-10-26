mod commands;
mod db;
mod engine;
mod scan;
mod telemetry;
mod trace;
mod util;

use std::sync::Arc;

use tauri::Manager;

use commands::Paths;
use db::Db;
use engine::{Engine, EngineConfig, Policy};
use telemetry::Telemetry;
use trace::TraceManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("flowdesk.sqlite");
            let reports_dir = data_dir.join("reports");
            std::fs::create_dir_all(&reports_dir)?;
            let db = Arc::new(Db::open(&db_path)?);

            let prefs: std::collections::HashMap<String, String> = db.get_preferences()?.into_iter().collect();
            let interval = prefs.get("telemetry.intervalMs").and_then(|v| v.parse().ok()).unwrap_or(1000);
            let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
            let config = prefs
                .get("engine.config")
                .and_then(|v| serde_json::from_str::<EngineConfig>(v).ok())
                .unwrap_or(EngineConfig {
                    policy: Policy::Fcfs,
                    workers: (cores / 2).max(1),
                    quantum_ms: 50,
                    max_workers_per_task: (cores / 2).max(1),
                });

            let engine = Engine::new(Arc::clone(&db), reports_dir.clone(), config);
            engine.start(app.handle().clone());
            let telemetry = Telemetry::new(interval);
            let e2 = Arc::clone(&engine);
            telemetry.start(app.handle().clone(), Arc::clone(&db), move || e2.running_job_ids());
            let tracer = TraceManager::new(Arc::clone(&db), Arc::clone(&engine), Arc::clone(&telemetry));
            tracer.attach(app.handle().clone());

            app.manage(tracer);
            app.manage(db);
            app.manage(engine);
            app.manage(telemetry);
            app.manage(Paths { db_path, reports_dir });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_status,
            commands::telemetry_history,
            commands::set_telemetry_interval,
            commands::list_processes,
            commands::scan_folder,
            commands::engine_state,
            commands::engine_set_config,
            commands::submit_job,
            commands::pause_job,
            commands::resume_job,
            commands::cancel_job,
            commands::list_jobs,
            commands::job_detail,
            commands::job_series,
            commands::delete_job,
            commands::clear_history,
            commands::export_jobs_csv,
            commands::get_preferences,
            commands::set_preference,
            commands::open_path,
            commands::trace_capabilities,
            commands::trace_start,
            commands::trace_stop,
            commands::trace_cancel,
            commands::trace_current,
            commands::trace_sessions,
            commands::trace_session,
            commands::trace_events,
            commands::trace_telemetry,
            commands::trace_summary,
            commands::trace_delete,
            commands::trace_export,
        ])
        .build(tauri::generate_context!())
        .expect("error while building FlowDesk");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Never leave an ETW session running after FlowDesk closes.
            if let Some(t) = handle.try_state::<Arc<TraceManager>>() {
                t.shutdown();
            }
        }
    });
}
