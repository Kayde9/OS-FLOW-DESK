//! SQLite persistence for trace sessions: batched event inserts, completion
//! updates, session records, telemetry snapshots, analysis summaries and
//! retention.

use std::collections::BTreeMap;

use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::model::{Completion, EventSource, TraceEvent};
use crate::db::{e, Db};
use crate::telemetry::MetricRow;

type R<T> = Result<T, String>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: i64,
    pub name: String,
    pub state: String,
    pub mode: String,
    pub target_kind: String,
    pub target_pid: Option<i64>,
    pub target_name: Option<String>,
    pub job_id: Option<i64>,
    pub providers: Value,
    pub config: Value,
    pub elevated: bool,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub first_event_us: Option<i64>,
    pub last_event_us: Option<i64>,
    pub events: i64,
    pub stats: Option<Value>,
    pub summary: Option<Value>,
    /// Event schemas TDH reported during capture.
    pub schemas: Option<Value>,
    pub error: Option<String>,
}

pub struct NewSession<'a> {
    pub name: &'a str,
    pub mode: &'a str,
    pub target_kind: &'a str,
    pub target_pid: Option<i64>,
    pub target_name: Option<&'a str>,
    pub providers: &'a Value,
    pub config: &'a Value,
    pub elevated: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryPoint {
    pub metric: String,
    pub ts: i64,
    pub value: Option<f64>,
    pub unit: String,
    pub source: String,
    pub available: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpStat {
    pub category: String,
    pub operation: String,
    pub count: i64,
    pub bytes: i64,
    /// Requests whose completion was observed (have a duration).
    pub matched: i64,
    /// Requests that expected a completion but none was observed.
    pub unmatched: i64,
    pub errors: i64,
    pub p50_us: Option<i64>,
    pub p95_us: Option<i64>,
    pub max_us: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub events: i64,
    pub read_bytes: i64,
    pub write_bytes: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub events: i64,
    pub first_event_us: Option<i64>,
    pub last_event_us: Option<i64>,
    pub by_source: BTreeMap<String, i64>,
    pub by_provider: BTreeMap<String, i64>,
    pub by_category: BTreeMap<String, i64>,
    pub operations: Vec<OpStat>,
    pub processes: Vec<(Option<i64>, Option<String>, i64)>,
    pub top_files: Vec<FileStat>,
    pub results: Vec<(String, i64)>,
    pub unknown_path_events: i64,
}

fn map_session(r: &Row<'_>) -> rusqlite::Result<SessionRecord> {
    let json = |s: Option<String>| s.and_then(|s| serde_json::from_str(&s).ok());
    Ok(SessionRecord {
        id: r.get("id")?,
        name: r.get("name")?,
        state: r.get("state")?,
        mode: r.get("mode")?,
        target_kind: r.get("target_kind")?,
        target_pid: r.get("target_pid")?,
        target_name: r.get("target_name")?,
        job_id: r.get("job_id")?,
        providers: json(r.get("providers")?).unwrap_or(Value::Null),
        config: json(r.get("config")?).unwrap_or(Value::Null),
        elevated: r.get::<_, i64>("elevated")? != 0,
        created_at: r.get("created_at")?,
        started_at: r.get("started_at")?,
        ended_at: r.get("ended_at")?,
        first_event_us: r.get("first_event_us")?,
        last_event_us: r.get("last_event_us")?,
        events: r.get("events")?,
        stats: json(r.get("stats")?),
        summary: json(r.get("summary")?),
        schemas: json(r.get("schemas")?),
        error: r.get("error")?,
    })
}

fn map_event(r: &Row<'_>) -> rusqlite::Result<TraceEvent> {
    let fields: String = r.get("fields")?;
    let source: String = r.get("source")?;
    Ok(TraceEvent {
        seq: r.get::<_, i64>("seq")? as u64,
        ts_us: r.get("ts_us")?,
        recv_us: r.get("recv_us")?,
        source: if source == "flowdesk" { EventSource::Flowdesk } else { EventSource::Etw },
        provider: r.get("provider")?,
        category: r.get("category")?,
        event_name: r.get("event_name")?,
        event_id: r.get("event_id")?,
        version: r.get("version")?,
        opcode: r.get("opcode")?,
        pid: r.get("pid")?,
        tid: r.get("tid")?,
        process_name: r.get("process_name")?,
        thread_name: r.get("thread_name")?,
        cpu: r.get("cpu")?,
        operation: r.get("operation")?,
        file_path: r.get("file_path")?,
        size: r.get::<_, Option<i64>>("size")?.map(|v| v as u64),
        offset: r.get::<_, Option<i64>>("offset")?.map(|v| v as u64),
        duration_us: r.get("duration_us")?,
        status: r.get("status")?,
        result_code: r.get("result_code")?,
        awaits_completion: r.get::<_, i64>("awaits")? != 0,
        fields: serde_json::from_str(&fields).unwrap_or_default(),
    })
}

fn percentile(sorted: &[i64], p: f64) -> Option<i64> {
    if sorted.is_empty() {
        return None;
    }
    // Nearest-rank percentile.
    let rank = ((p / 100.0) * sorted.len() as f64).ceil().max(1.0) as usize;
    Some(sorted[rank.min(sorted.len()) - 1])
}

impl Db {
    pub fn insert_trace_session(&self, s: &NewSession<'_>) -> R<i64> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO trace_sessions (name, state, mode, target_kind, target_pid, target_name, providers, config, elevated, created_at)
             VALUES (?1,'preparing',?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                s.name,
                s.mode,
                s.target_kind,
                s.target_pid,
                s.target_name,
                s.providers.to_string(),
                s.config.to_string(),
                s.elevated as i64,
                s.created_at
            ],
        )
        .map_err(e)?;
        Ok(conn.last_insert_rowid())
    }

    pub fn update_trace_session(&self, id: i64, state: &str, started_at: Option<i64>, job_id: Option<i64>, providers: Option<&Value>) -> R<()> {
        self.conn()
            .execute(
                "UPDATE trace_sessions SET state=?2, started_at=COALESCE(started_at, ?3), job_id=COALESCE(job_id, ?4),
                    providers=COALESCE(?5, providers) WHERE id=?1",
                params![id, state, started_at, job_id, providers.map(|p| p.to_string())],
            )
            .map_err(e)?;
        Ok(())
    }

    pub fn finish_trace_session(&self, id: i64, state: &str, ended_at: i64, stats: &Value, summary: Option<&Value>, error: Option<&str>) -> R<()> {
        let conn = self.conn();
        conn.execute(
            "UPDATE trace_sessions SET state=?2, ended_at=?3, stats=?4, summary=?5, error=COALESCE(?6, error),
                events=(SELECT COUNT(*) FROM trace_events WHERE session_id=?1),
                first_event_us=(SELECT MIN(ts_us) FROM trace_events WHERE session_id=?1),
                last_event_us=(SELECT MAX(ts_us) FROM trace_events WHERE session_id=?1)
             WHERE id=?1",
            params![id, state, ended_at, stats.to_string(), summary.map(|s| s.to_string()), error],
        )
        .map_err(e)?;
        Ok(())
    }

    pub fn set_trace_schemas(&self, id: i64, schemas: &Value) -> R<()> {
        self.conn()
            .execute("UPDATE trace_sessions SET schemas=?2 WHERE id=?1", params![id, schemas.to_string()])
            .map_err(e)?;
        Ok(())
    }

    /// One transaction per batch: inserts events, then applies completions
    /// (which may refer to events in this or earlier batches).
    pub fn insert_trace_batch(&self, session: i64, events: &[TraceEvent], completions: &[Completion]) -> R<usize> {
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(e)?;
        let mut applied = 0;
        {
            let mut ins = tx
                .prepare_cached(
                    "INSERT OR IGNORE INTO trace_events (session_id, seq, ts_us, recv_us, source, provider, category, event_name,
                        event_id, version, opcode, pid, tid, process_name, thread_name, cpu, operation, file_path, size, offset,
                        duration_us, status, result_code, awaits, fields)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)",
                )
                .map_err(e)?;
            for ev in events {
                ins.execute(params![
                    session,
                    ev.seq as i64,
                    ev.ts_us,
                    ev.recv_us,
                    ev.source.as_str(),
                    ev.provider,
                    ev.category,
                    ev.event_name,
                    ev.event_id,
                    ev.version,
                    ev.opcode,
                    ev.pid,
                    ev.tid,
                    ev.process_name,
                    ev.thread_name,
                    ev.cpu,
                    ev.operation,
                    ev.file_path,
                    ev.size.map(|v| v as i64),
                    ev.offset.map(|v| v as i64),
                    ev.duration_us,
                    ev.status,
                    ev.result_code,
                    ev.awaits_completion as i64,
                    Value::Object(ev.fields.clone()).to_string(),
                ])
                .map_err(e)?;
            }
            let mut upd = tx
                .prepare_cached(
                    "UPDATE trace_events SET duration_us=?3, status=?4, result_code=?5,
                        fields=CASE WHEN ?6 IS NULL THEN fields ELSE json_set(fields, '$.completionExtraInformation', ?6) END
                     WHERE session_id=?1 AND seq=?2",
                )
                .map_err(e)?;
            for c in completions {
                applied += upd
                    .execute(params![session, c.seq as i64, c.duration_us, c.status, c.result_code, c.extra_information])
                    .map_err(e)?;
            }
        }
        tx.commit().map_err(e)?;
        Ok(applied)
    }

    pub fn insert_trace_telemetry(&self, session: i64, samples: &[(i64, Vec<MetricRow>)]) -> R<()> {
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(e)?;
        {
            let mut st = tx
                .prepare_cached(
                    "INSERT INTO trace_telemetry (session_id, ts, metric, value, unit, source, available) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                )
                .map_err(e)?;
            for (ts, rows) in samples {
                for r in rows {
                    st.execute(params![session, ts, r.metric, r.value, r.unit, r.source, r.available as i64]).map_err(e)?;
                }
            }
        }
        tx.commit().map_err(e)
    }

    pub fn trace_telemetry(&self, session: i64) -> R<Vec<TelemetryPoint>> {
        let conn = self.conn();
        let mut st = conn
            .prepare("SELECT metric, ts, value, unit, source, available FROM trace_telemetry WHERE session_id=?1 ORDER BY ts")
            .map_err(e)?;
        let rows = st
            .query_map([session], |r| {
                Ok(TelemetryPoint {
                    metric: r.get(0)?,
                    ts: r.get(1)?,
                    value: r.get(2)?,
                    unit: r.get(3)?,
                    source: r.get(4)?,
                    available: r.get::<_, i64>(5)? != 0,
                })
            })
            .map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    pub fn trace_events(&self, session: i64, after_seq: i64, limit: i64) -> R<Vec<TraceEvent>> {
        let conn = self.conn();
        let mut st = conn
            .prepare_cached("SELECT * FROM trace_events WHERE session_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3")
            .map_err(e)?;
        let rows = st.query_map(params![session, after_seq, limit], map_event).map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    pub fn list_trace_sessions(&self, limit: i64) -> R<Vec<SessionRecord>> {
        let conn = self.conn();
        let mut st = conn.prepare("SELECT * FROM trace_sessions ORDER BY created_at DESC, id DESC LIMIT ?1").map_err(e)?;
        let rows = st.query_map([limit], map_session).map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    pub fn get_trace_session(&self, id: i64) -> R<Option<SessionRecord>> {
        self.conn().query_row("SELECT * FROM trace_sessions WHERE id=?1", [id], map_session).optional().map_err(e)
    }

    pub fn delete_trace_session(&self, id: i64) -> R<usize> {
        self.conn()
            .execute("DELETE FROM trace_sessions WHERE id=?1 AND state IN ('completed','failed','cancelled')", [id])
            .map_err(e)
    }

    /// Keeps the newest `keep` finished sessions and at most `max_events`
    /// stored events overall (oldest sessions go first). `current` is never removed.
    pub fn enforce_trace_retention(&self, keep: i64, max_events: i64, current: i64) -> R<usize> {
        let conn = self.conn();
        let mut st = conn
            .prepare("SELECT id, events FROM trace_sessions WHERE state IN ('completed','failed','cancelled') AND id<>?1 ORDER BY created_at DESC, id DESC")
            .map_err(e)?;
        let rows: Vec<(i64, i64)> = st.query_map([current], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?.collect::<Result<_, _>>().map_err(e)?;
        let current_events: i64 = conn
            .query_row("SELECT COUNT(*) FROM trace_events WHERE session_id=?1", [current], |r| r.get(0))
            .map_err(e)?;
        let mut total = current_events;
        let mut doomed = Vec::new();
        for (i, (id, n)) in rows.iter().enumerate() {
            total += n;
            if i as i64 >= keep - 1 || total > max_events {
                doomed.push(*id);
            }
        }
        for id in &doomed {
            conn.execute("DELETE FROM trace_sessions WHERE id=?1", [id]).map_err(e)?;
        }
        Ok(doomed.len())
    }

    pub fn trace_summary(&self, session: i64) -> R<Summary> {
        let conn = self.conn();
        let mut s = Summary::default();
        let count = |sql: &str| -> R<BTreeMap<String, i64>> {
            let mut st = conn.prepare(sql).map_err(e)?;
            let rows = st.query_map([session], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map_err(e)?;
            rows.collect::<Result<_, _>>().map_err(e)
        };
        s.by_source = count("SELECT source, COUNT(*) FROM trace_events WHERE session_id=?1 GROUP BY source")?;
        s.by_provider = count("SELECT provider, COUNT(*) FROM trace_events WHERE session_id=?1 GROUP BY provider")?;
        s.by_category = count("SELECT category, COUNT(*) FROM trace_events WHERE session_id=?1 GROUP BY category")?;
        (s.events, s.first_event_us, s.last_event_us, s.unknown_path_events) = conn
            .query_row(
                "SELECT COUNT(*), MIN(ts_us), MAX(ts_us),
                        SUM(CASE WHEN category='file' AND file_path IS NULL THEN 1 ELSE 0 END)
                 FROM trace_events WHERE session_id=?1",
                [session],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, Option<i64>>(3)?.unwrap_or(0))),
            )
            .map_err(e)?;

        let mut st = conn
            .prepare(
                "SELECT category, COALESCE(operation, event_name), COUNT(*), COALESCE(SUM(size),0),
                        SUM(CASE WHEN duration_us IS NOT NULL THEN 1 ELSE 0 END),
                        SUM(CASE WHEN awaits=1 AND duration_us IS NULL THEN 1 ELSE 0 END),
                        SUM(CASE WHEN status IN ('error','warning') THEN 1 ELSE 0 END)
                 FROM trace_events WHERE session_id=?1 GROUP BY 1, 2 ORDER BY 3 DESC",
            )
            .map_err(e)?;
        let mut ops: Vec<OpStat> = st
            .query_map([session], |r| {
                Ok(OpStat {
                    category: r.get(0)?,
                    operation: r.get(1)?,
                    count: r.get(2)?,
                    bytes: r.get(3)?,
                    matched: r.get(4)?,
                    unmatched: r.get(5)?,
                    errors: r.get(6)?,
                    ..Default::default()
                })
            })
            .map_err(e)?
            .collect::<Result<_, _>>()
            .map_err(e)?;
        let mut dst = conn
            .prepare_cached(
                "SELECT duration_us FROM trace_events WHERE session_id=?1 AND category=?2 AND COALESCE(operation, event_name)=?3
                 AND duration_us IS NOT NULL ORDER BY duration_us",
            )
            .map_err(e)?;
        for op in ops.iter_mut().filter(|o| o.matched > 0) {
            let d: Vec<i64> = dst
                .query_map(params![session, op.category, op.operation], |r| r.get(0))
                .map_err(e)?
                .collect::<Result<_, _>>()
                .map_err(e)?;
            op.p50_us = percentile(&d, 50.0);
            op.p95_us = percentile(&d, 95.0);
            op.max_us = d.last().copied();
        }
        s.operations = ops;

        let mut st = conn
            .prepare(
                "SELECT pid, MAX(process_name), COUNT(*) FROM trace_events WHERE session_id=?1 GROUP BY pid ORDER BY 3 DESC LIMIT 20",
            )
            .map_err(e)?;
        s.processes = st
            .query_map([session], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(e)?
            .collect::<Result<_, _>>()
            .map_err(e)?;

        let mut st = conn
            .prepare(
                "SELECT file_path, COUNT(*),
                        COALESCE(SUM(CASE WHEN operation='Read' THEN size END),0),
                        COALESCE(SUM(CASE WHEN operation='Write' THEN size END),0)
                 FROM trace_events WHERE session_id=?1 AND category='file' AND file_path IS NOT NULL
                 GROUP BY file_path ORDER BY 3+4 DESC, 2 DESC LIMIT 15",
            )
            .map_err(e)?;
        s.top_files = st
            .query_map([session], |r| Ok(FileStat { path: r.get(0)?, events: r.get(1)?, read_bytes: r.get(2)?, write_bytes: r.get(3)? }))
            .map_err(e)?
            .collect::<Result<_, _>>()
            .map_err(e)?;

        let mut st = conn
            .prepare(
                "SELECT result_code, COUNT(*) FROM trace_events WHERE session_id=?1 AND status IN ('error','warning')
                 GROUP BY result_code ORDER BY 2 DESC LIMIT 20",
            )
            .map_err(e)?;
        s.results = st
            .query_map([session], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(e)?
            .collect::<Result<_, _>>()
            .map_err(e)?;
        Ok(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::synthetic;

    fn temp_db() -> Db {
        let dir = std::env::temp_dir().join(format!("flowdesk-trace-db-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("t{}.sqlite", crate::util::now_us()));
        Db::open(&p).unwrap()
    }

    fn session(db: &Db) -> i64 {
        let v = serde_json::json!([]);
        db.insert_trace_session(&NewSession {
            name: "t",
            mode: "etw",
            target_kind: "process",
            target_pid: Some(1),
            target_name: None,
            providers: &v,
            config: &v,
            elevated: false,
            created_at: 1,
        })
        .unwrap()
    }

    #[test]
    fn batch_insert_completion_update_summary_and_replay() {
        let db = temp_db();
        let id = session(&db);
        let events = synthetic::file_reads(1, 0, 10, 1_000);
        db.insert_trace_batch(id, &events[..5], &[]).unwrap();
        // Completion for an event from the previous batch, and for one in this batch.
        let comps = [synthetic::completion(&events[1], 120, 0), synthetic::completion(&events[7], 900, 0xC000_0011)];
        assert_eq!(db.insert_trace_batch(id, &events[5..], &comps).unwrap(), 2);

        let back = db.trace_events(id, 0, 100).unwrap();
        assert_eq!(back.len(), 10);
        assert!(back.windows(2).all(|w| w[0].seq < w[1].seq));
        assert_eq!(back[1].duration_us, Some(120));
        assert_eq!(back[7].status.as_deref(), Some("error"));
        assert_eq!(back[0].duration_us, None, "unmatched stays without duration");
        assert_eq!(back[3].fields, events[3].fields, "fields survive the round trip");
        // Paging by seq.
        assert_eq!(db.trace_events(id, back[4].seq as i64, 3).unwrap()[0].seq, back[5].seq);

        db.finish_trace_session(id, "completed", 5, &serde_json::json!({}), None, None).unwrap();
        let s = db.trace_summary(id).unwrap();
        assert_eq!(s.events, 10);
        let read = s.operations.iter().find(|o| o.operation == "Read").unwrap();
        assert_eq!((read.count, read.matched, read.unmatched, read.errors), (10, 2, 8, 1));
        assert_eq!(read.max_us, Some(900));
        assert_eq!(db.get_trace_session(id).unwrap().unwrap().events, 10);
    }

    #[test]
    fn retention_removes_oldest_finished_sessions() {
        let db = temp_db();
        let ids: Vec<i64> = (0..4).map(|_| session(&db)).collect();
        for id in &ids[..3] {
            db.insert_trace_batch(*id, &synthetic::file_reads(1, 0, 3, 10), &[]).unwrap();
            db.finish_trace_session(*id, "completed", 1, &serde_json::json!({}), None, None).unwrap();
        }
        // Keep 2 sessions in total (current + newest finished).
        let removed = db.enforce_trace_retention(2, 1_000, ids[3]).unwrap();
        assert_eq!(removed, 2);
        assert!(db.get_trace_session(ids[0]).unwrap().is_none());
        assert!(db.get_trace_session(ids[2]).unwrap().is_some());
        assert!(db.trace_events(ids[0], 0, 10).unwrap().is_empty(), "events cascade");
    }

    #[test]
    fn nearest_rank_percentile() {
        let v: Vec<i64> = (1..=100).collect();
        assert_eq!(percentile(&v, 50.0), Some(50));
        assert_eq!(percentile(&v, 95.0), Some(95));
        assert_eq!(percentile(&[7], 95.0), Some(7));
        assert_eq!(percentile(&[], 50.0), None);
    }
}
