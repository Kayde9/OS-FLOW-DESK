//! SQLite persistence: migrations, job/experiment records, telemetry samples,
//! job events and preferences.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::telemetry::MetricRow;

pub struct Db {
    conn: Mutex<Connection>,
}

/// Each entry upgrades the schema by one version (tracked in `PRAGMA user_version`).
const MIGRATIONS: &[&str] = &[
    // v1 — initial schema
    r#"
    CREATE TABLE jobs (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        name                 TEXT    NOT NULL,
        op                   TEXT    NOT NULL,
        folder               TEXT    NOT NULL,
        dest                 TEXT,
        policy               TEXT    NOT NULL,
        priority             INTEGER NOT NULL,
        workers              INTEGER NOT NULL,
        quantum_ms           INTEGER NOT NULL,
        max_workers_per_task INTEGER NOT NULL,
        status               TEXT    NOT NULL,
        created_at           INTEGER NOT NULL,
        started_at           INTEGER,
        ended_at             INTEGER,
        files_total          INTEGER NOT NULL DEFAULT 0,
        files_done           INTEGER NOT NULL DEFAULT 0,
        files_failed         INTEGER NOT NULL DEFAULT 0,
        files_skipped        INTEGER NOT NULL DEFAULT 0,
        bytes_total          INTEGER NOT NULL DEFAULT 0,
        bytes_done           INTEGER NOT NULL DEFAULT 0,
        response_ms          INTEGER,
        preemptions          INTEGER NOT NULL DEFAULT 0,
        report_path          TEXT,
        error                TEXT,
        summary              TEXT
    );
    CREATE INDEX idx_jobs_created ON jobs(created_at DESC);

    CREATE TABLE telemetry_samples (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id    INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        ts        INTEGER NOT NULL,
        metric    TEXT    NOT NULL,
        value     REAL,
        unit      TEXT    NOT NULL,
        source    TEXT    NOT NULL,
        available INTEGER NOT NULL
    );
    CREATE INDEX idx_tel_job_metric ON telemetry_samples(job_id, metric, ts);

    CREATE TABLE job_events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id  INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        ts      INTEGER NOT NULL,
        level   TEXT    NOT NULL,
        message TEXT    NOT NULL
    );
    CREATE INDEX idx_events_job ON job_events(job_id, ts);

    CREATE TABLE preferences (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
    // v2 — System Call Observatory (ETW trace sessions)
    r#"
    CREATE TABLE trace_sessions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        name           TEXT    NOT NULL,
        state          TEXT    NOT NULL,
        mode           TEXT    NOT NULL,
        target_kind    TEXT    NOT NULL,
        target_pid     INTEGER,
        target_name    TEXT,
        job_id         INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
        providers      TEXT    NOT NULL,
        config         TEXT    NOT NULL,
        elevated       INTEGER NOT NULL,
        created_at     INTEGER NOT NULL,
        started_at     INTEGER,
        ended_at       INTEGER,
        first_event_us INTEGER,
        last_event_us  INTEGER,
        events         INTEGER NOT NULL DEFAULT 0,
        stats          TEXT,
        summary        TEXT,
        schemas        TEXT,
        error          TEXT
    );
    CREATE INDEX idx_trace_sessions_created ON trace_sessions(created_at DESC);

    CREATE TABLE trace_events (
        id           INTEGER PRIMARY KEY,
        session_id   INTEGER NOT NULL REFERENCES trace_sessions(id) ON DELETE CASCADE,
        seq          INTEGER NOT NULL,
        ts_us        INTEGER NOT NULL,
        recv_us      INTEGER NOT NULL,
        source       TEXT    NOT NULL,
        provider     TEXT    NOT NULL,
        category     TEXT    NOT NULL,
        event_name   TEXT    NOT NULL,
        event_id     INTEGER,
        version      INTEGER,
        opcode       INTEGER,
        pid          INTEGER,
        tid          INTEGER,
        process_name TEXT,
        thread_name  TEXT,
        cpu          INTEGER,
        operation    TEXT,
        file_path    TEXT,
        size         INTEGER,
        offset       INTEGER,
        duration_us  INTEGER,
        status       TEXT,
        result_code  TEXT,
        awaits       INTEGER NOT NULL DEFAULT 0,
        fields       TEXT    NOT NULL,
        UNIQUE (session_id, seq)
    );
    CREATE INDEX idx_trace_events_ts ON trace_events(session_id, ts_us);

    CREATE TABLE trace_telemetry (
        id         INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES trace_sessions(id) ON DELETE CASCADE,
        ts         INTEGER NOT NULL,
        metric     TEXT    NOT NULL,
        value      REAL,
        unit       TEXT    NOT NULL,
        source     TEXT    NOT NULL,
        available  INTEGER NOT NULL
    );
    CREATE INDEX idx_trace_tel ON trace_telemetry(session_id, metric, ts);
    "#,
];

#[derive(Debug, Clone, Serialize)]
pub struct JobRecord {
    pub id: i64,
    pub name: String,
    pub op: String,
    pub folder: String,
    pub dest: Option<String>,
    pub policy: String,
    pub priority: i64,
    pub workers: i64,
    pub quantum_ms: i64,
    pub max_workers_per_task: i64,
    pub status: String,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub files_total: i64,
    pub files_done: i64,
    pub files_failed: i64,
    pub files_skipped: i64,
    pub bytes_total: i64,
    pub bytes_done: i64,
    pub response_ms: Option<i64>,
    pub preemptions: i64,
    pub report_path: Option<String>,
    pub error: Option<String>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetricAggregate {
    pub metric: String,
    pub unit: String,
    pub source: String,
    pub avg: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub samples: i64,
    pub unavailable_samples: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobEvent {
    pub ts: i64,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SeriesPoint {
    pub metric: String,
    pub ts: i64,
    pub value: Option<f64>,
}

/// Fields written when a job finishes.
pub struct JobFinal<'a> {
    pub status: &'a str,
    pub started_at: Option<i64>,
    pub ended_at: i64,
    pub files_done: i64,
    pub files_failed: i64,
    pub files_skipped: i64,
    pub bytes_done: i64,
    pub response_ms: Option<i64>,
    pub preemptions: i64,
    pub report_path: Option<&'a str>,
    pub error: Option<&'a str>,
    pub summary: Option<&'a str>,
}

pub struct NewJob<'a> {
    pub name: &'a str,
    pub op: &'a str,
    pub folder: &'a str,
    pub dest: Option<&'a str>,
    pub policy: &'a str,
    pub priority: i64,
    pub workers: i64,
    pub quantum_ms: i64,
    pub max_workers_per_task: i64,
    pub created_at: i64,
    pub files_total: i64,
    pub bytes_total: i64,
}

fn map_job(r: &rusqlite::Row<'_>) -> rusqlite::Result<JobRecord> {
    Ok(JobRecord {
        id: r.get("id")?,
        name: r.get("name")?,
        op: r.get("op")?,
        folder: r.get("folder")?,
        dest: r.get("dest")?,
        policy: r.get("policy")?,
        priority: r.get("priority")?,
        workers: r.get("workers")?,
        quantum_ms: r.get("quantum_ms")?,
        max_workers_per_task: r.get("max_workers_per_task")?,
        status: r.get("status")?,
        created_at: r.get("created_at")?,
        started_at: r.get("started_at")?,
        ended_at: r.get("ended_at")?,
        files_total: r.get("files_total")?,
        files_done: r.get("files_done")?,
        files_failed: r.get("files_failed")?,
        files_skipped: r.get("files_skipped")?,
        bytes_total: r.get("bytes_total")?,
        bytes_done: r.get("bytes_done")?,
        response_ms: r.get("response_ms")?,
        preemptions: r.get("preemptions")?,
        report_path: r.get("report_path")?,
        error: r.get("error")?,
        summary: r.get("summary")?,
    })
}

type R<T> = Result<T, String>;
pub(crate) fn e(err: rusqlite::Error) -> String {
    format!("database error: {err}")
}

impl Db {
    pub(crate) fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap()
    }

    pub fn open(path: &Path) -> R<Self> {
        let conn = Connection::open(path).map_err(e)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;")
            .map_err(e)?;
        let db = Db { conn: Mutex::new(conn) };
        db.migrate()?;
        db.mark_interrupted()?;
        Ok(db)
    }

    fn migrate(&self) -> R<()> {
        let mut conn = self.conn.lock().unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(e)?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            let tx = conn.transaction().map_err(e)?;
            tx.execute_batch(sql).map_err(e)?;
            tx.execute_batch(&format!("PRAGMA user_version = {}", i + 1)).map_err(e)?;
            tx.commit().map_err(e)?;
        }
        Ok(())
    }

    /// Jobs that were queued or running when the app last exited never finished.
    fn mark_interrupted(&self) -> R<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE jobs SET status='interrupted', error=COALESCE(error,'FlowDesk exited before the task finished')
             WHERE status IN ('queued','running','paused')",
            [],
        )
        .map_err(e)?;
        conn.execute(
            "UPDATE trace_sessions SET state='failed', error=COALESCE(error,'FlowDesk exited before the trace was finalized')
             WHERE state IN ('idle','preparing','capturing','stopping','finalizing')",
            [],
        )
        .map_err(e)?;
        Ok(())
    }

    pub fn insert_job(&self, j: &NewJob<'_>) -> R<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO jobs (name, op, folder, dest, policy, priority, workers, quantum_ms, max_workers_per_task,
                               status, created_at, files_total, bytes_total)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'queued',?10,?11,?12)",
            params![
                j.name, j.op, j.folder, j.dest, j.policy, j.priority, j.workers, j.quantum_ms,
                j.max_workers_per_task, j.created_at, j.files_total, j.bytes_total
            ],
        )
        .map_err(e)?;
        Ok(conn.last_insert_rowid())
    }

    pub fn set_job_status(&self, id: i64, status: &str, started_at: Option<i64>) -> R<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE jobs SET status=?2, started_at=COALESCE(started_at, ?3) WHERE id=?1",
            params![id, status, started_at],
        )
        .map_err(e)?;
        Ok(())
    }

    pub fn finish_job(&self, id: i64, f: &JobFinal<'_>) -> R<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE jobs SET status=?2, started_at=COALESCE(started_at, ?3), ended_at=?4, files_done=?5,
                files_failed=?6, files_skipped=?7, bytes_done=?8, response_ms=?9, preemptions=?10,
                report_path=?11, error=?12, summary=?13
             WHERE id=?1",
            params![
                id, f.status, f.started_at, f.ended_at, f.files_done, f.files_failed, f.files_skipped,
                f.bytes_done, f.response_ms, f.preemptions, f.report_path, f.error, f.summary
            ],
        )
        .map_err(e)?;
        Ok(())
    }

    pub fn add_event(&self, job_id: i64, ts: i64, level: &str, message: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO job_events (job_id, ts, level, message) VALUES (?1,?2,?3,?4)",
            params![job_id, ts, level, message],
        );
    }

    pub fn insert_samples(&self, job_ids: &[i64], ts: i64, rows: &[MetricRow]) -> R<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(e)?;
        {
            let mut stmt = tx
                .prepare_cached(
                    "INSERT INTO telemetry_samples (job_id, ts, metric, value, unit, source, available)
                     VALUES (?1,?2,?3,?4,?5,?6,?7)",
                )
                .map_err(e)?;
            for id in job_ids {
                for r in rows {
                    stmt.execute(params![id, ts, r.metric, r.value, r.unit, r.source, r.available as i64])
                        .map_err(e)?;
                }
            }
        }
        tx.commit().map_err(e)
    }

    pub fn list_jobs(&self, limit: i64) -> R<Vec<JobRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?1")
            .map_err(e)?;
        let rows = stmt.query_map([limit], map_job).map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    pub fn get_job(&self, id: i64) -> R<Option<JobRecord>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT * FROM jobs WHERE id=?1", [id], map_job).optional().map_err(e)
    }

    pub fn job_aggregates(&self, id: i64) -> R<Vec<MetricAggregate>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT metric, MAX(unit), MAX(source), AVG(value), MIN(value), MAX(value), COUNT(value),
                        SUM(CASE WHEN available=0 THEN 1 ELSE 0 END)
                 FROM telemetry_samples WHERE job_id=?1 GROUP BY metric ORDER BY metric",
            )
            .map_err(e)?;
        let rows = stmt
            .query_map([id], |r| {
                Ok(MetricAggregate {
                    metric: r.get(0)?,
                    unit: r.get(1)?,
                    source: r.get(2)?,
                    avg: r.get(3)?,
                    min: r.get(4)?,
                    max: r.get(5)?,
                    samples: r.get(6)?,
                    unavailable_samples: r.get(7)?,
                })
            })
            .map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    pub fn job_series(&self, id: i64) -> R<Vec<SeriesPoint>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT metric, ts, value FROM telemetry_samples WHERE job_id=?1 ORDER BY ts")
            .map_err(e)?;
        let rows = stmt
            .query_map([id], |r| Ok(SeriesPoint { metric: r.get(0)?, ts: r.get(1)?, value: r.get(2)? }))
            .map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    pub fn job_events(&self, id: i64) -> R<Vec<JobEvent>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT ts, level, message FROM job_events WHERE job_id=?1 ORDER BY ts, id LIMIT 500")
            .map_err(e)?;
        let rows = stmt
            .query_map([id], |r| Ok(JobEvent { ts: r.get(0)?, level: r.get(1)?, message: r.get(2)? }))
            .map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    pub fn delete_job(&self, id: i64) -> R<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM jobs WHERE id=?1 AND status NOT IN ('queued','running','paused')", [id])
            .map_err(e)?;
        Ok(())
    }

    pub fn clear_history(&self) -> R<usize> {
        let conn = self.conn.lock().unwrap();
        let n = conn
            .execute("DELETE FROM jobs WHERE status NOT IN ('queued','running','paused')", [])
            .map_err(e)?;
        let _ = conn.execute_batch("VACUUM");
        Ok(n)
    }

    pub fn get_preferences(&self) -> R<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT key, value FROM preferences").map_err(e)?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    pub fn set_preference(&self, key: &str, value: &str) -> R<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO preferences (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )
        .map_err(e)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> (Db, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("flowdesk-db-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("t{}.sqlite", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        (Db::open(&path).unwrap(), path)
    }

    #[test]
    fn job_roundtrip_and_restart_marks_interrupted() {
        let (db, path) = temp_db();
        let id = db
            .insert_job(&NewJob {
                name: "t", op: "hash", folder: "C:/x", dest: None, policy: "fcfs", priority: 5,
                workers: 2, quantum_ms: 50, max_workers_per_task: 2, created_at: 1, files_total: 3,
                bytes_total: 30,
            })
            .unwrap();
        db.set_job_status(id, "running", Some(2)).unwrap();
        db.insert_samples(&[id], 3, &[MetricRow { metric: "cpu", value: Some(12.5), unit: "%", source: "test", available: true }])
            .unwrap();
        let agg = db.job_aggregates(id).unwrap();
        assert_eq!(agg[0].avg, Some(12.5));
        drop(db);
        // Re-open = simulated restart; the running job must be marked interrupted.
        let db = Db::open(&path).unwrap();
        assert_eq!(db.get_job(id).unwrap().unwrap().status, "interrupted");
        db.set_preference("k", "1").unwrap();
        db.set_preference("k", "2").unwrap();
        assert_eq!(db.get_preferences().unwrap(), vec![("k".into(), "2".into())]);
    }
}
