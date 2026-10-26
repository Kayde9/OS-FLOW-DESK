//! Normalized exports (CSV / JSON) and a Markdown summary report, with
//! optional path redaction. These are FlowDesk's normalized event records —
//! not native ETL files (the real-time session keeps no .etl on disk).

use std::io::{BufWriter, Write};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::model::TraceEvent;
use super::store::{SessionRecord, Summary};
use crate::db::Db;
use crate::util::{csv_field, hex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Redact {
    /// Paths exported as captured.
    None,
    /// The user-profile folder is replaced with %USERPROFILE%.
    User,
    /// Every path becomes a stable pseudonym; the extension is kept.
    Paths,
}

pub struct Redactor {
    mode: Redact,
    profile: Option<String>,
}

impl Redactor {
    pub fn new(mode: Redact) -> Self {
        let profile = std::env::var("USERPROFILE").ok().filter(|p| p.len() > 3);
        Redactor { mode, profile }
    }

    #[cfg(test)]
    fn with_profile(mode: Redact, profile: &str) -> Self {
        Redactor { mode, profile: Some(profile.into()) }
    }

    fn looks_like_path(s: &str) -> bool {
        s.contains(":\\") || s.starts_with("\\Device\\") || s.starts_with("\\\\")
    }

    pub fn path(&self, p: &str) -> String {
        match self.mode {
            Redact::None => p.to_string(),
            Redact::User => match &self.profile {
                Some(prof)
                    if p.to_lowercase().starts_with(&prof.to_lowercase())
                        && (p.len() == prof.len() || p[prof.len()..].starts_with('\\')) =>
                {
                    format!("%USERPROFILE%{}", &p[prof.len()..])
                }
                _ => p.to_string(),
            },
            Redact::Paths => {
                let digest = Sha256::digest(p.to_lowercase().as_bytes());
                let ext = p.rsplit(['\\', '/']).next().and_then(|n| n.rsplit_once('.')).map(|(_, e)| e).filter(|e| e.len() <= 8);
                match ext {
                    Some(e) => format!("<redacted:{}>.{e}", &hex(&digest)[..10]),
                    None => format!("<redacted:{}>", &hex(&digest)[..10]),
                }
            }
        }
    }

    pub fn event(&self, ev: &mut TraceEvent) {
        if self.mode == Redact::None {
            return;
        }
        ev.file_path = ev.file_path.as_deref().map(|p| self.path(p));
        for v in ev.fields.values_mut() {
            if let Value::String(s) = v {
                if Self::looks_like_path(s) {
                    *s = self.path(s);
                }
            }
        }
    }
}

const CSV_HEADER: &str = "seq,ts_us,recv_us,source,provider,category,event_name,event_id,version,opcode,pid,tid,process_name,thread_name,cpu,operation,file_path,size,offset,duration_us,status,result_code,awaits_completion,fields_json\n";

pub fn csv_row(ev: &TraceEvent) -> String {
    let o = |v: Option<String>| v.unwrap_or_default();
    let n = |v: Option<i64>| v.map(|v| v.to_string()).unwrap_or_default();
    format!(
        "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
        ev.seq,
        ev.ts_us,
        ev.recv_us,
        ev.source.as_str(),
        csv_field(&ev.provider),
        ev.category,
        csv_field(&ev.event_name),
        n(ev.event_id.map(i64::from)),
        n(ev.version.map(i64::from)),
        n(ev.opcode.map(i64::from)),
        n(ev.pid.map(i64::from)),
        n(ev.tid.map(i64::from)),
        csv_field(&o(ev.process_name.clone())),
        csv_field(&o(ev.thread_name.clone())),
        n(ev.cpu.map(i64::from)),
        csv_field(&o(ev.operation.clone())),
        csv_field(&o(ev.file_path.clone())),
        n(ev.size.map(|v| v as i64)),
        n(ev.offset.map(|v| v as i64)),
        n(ev.duration_us),
        o(ev.status.clone()),
        csv_field(&o(ev.result_code.clone())),
        ev.awaits_completion,
        csv_field(&Value::Object(ev.fields.clone()).to_string()),
    )
}

fn meta(s: &SessionRecord, redact: Redact) -> Value {
    json!({
        "format": "flowdesk.trace.normalized/v1",
        "notice": "Normalized FlowDesk event records decoded from ETW real-time delivery (plus FlowDesk application events). This is not a native ETL trace file.",
        "redaction": format!("{redact:?}").to_lowercase(),
        "session": {
            "id": s.id, "name": s.name, "state": s.state, "mode": s.mode,
            "targetKind": s.target_kind, "targetPid": s.target_pid, "targetName": s.target_name,
            "jobId": s.job_id, "providers": s.providers, "config": s.config,
            "createdAt": s.created_at, "startedAt": s.started_at, "endedAt": s.ended_at,
            "events": s.events, "stats": s.stats, "error": s.error,
        }
    })
}

/// Streams all events of `session` to `path`. Returns the number of events written.
pub fn export(db: &Db, session: &SessionRecord, format: &str, path: &str, redact: Redact) -> Result<usize, String> {
    let r = Redactor::new(redact);
    let file = std::fs::File::create(path).map_err(|e| format!("Creating {path}: {e}"))?;
    let mut w = BufWriter::new(file);
    let io = |e: std::io::Error| format!("Writing {path}: {e}");
    let mut n = 0;
    let mut after = 0i64;
    match format {
        "csv" => w.write_all(CSV_HEADER.as_bytes()).map_err(io)?,
        "json" => {
            let m = meta(session, redact);
            let head = m.to_string();
            // Open the object and leave "events" for streaming.
            write!(w, "{},\"events\":[", &head[..head.len() - 1]).map_err(io)?;
        }
        _ => return Err(format!("Unknown export format '{format}'")),
    }
    loop {
        let page = db.trace_events(session.id, after, 5_000)?;
        let Some(last) = page.last() else { break };
        after = last.seq as i64;
        for mut ev in page {
            r.event(&mut ev);
            if format == "csv" {
                w.write_all(csv_row(&ev).as_bytes()).map_err(io)?;
            } else {
                if n > 0 {
                    w.write_all(b",").map_err(io)?;
                }
                serde_json::to_writer(&mut w, &ev).map_err(|e| e.to_string())?;
            }
            n += 1;
        }
    }
    if format == "json" {
        w.write_all(b"]}").map_err(io)?;
    }
    w.flush().map_err(io)?;
    Ok(n)
}

pub fn summary_markdown(s: &SessionRecord, sum: &Summary, redact: Redact) -> String {
    let r = Redactor::new(redact);
    let mut md = String::new();
    let span = match (sum.first_event_us, sum.last_event_us) {
        (Some(a), Some(b)) => format!("{:.3} s", (b - a) as f64 / 1e6),
        _ => "—".into(),
    };
    md.push_str(&format!("# FlowDesk trace summary — {}\n\n", s.name));
    md.push_str("> Normalized FlowDesk export, not a native ETL trace. Observed facts are separated from derived statistics; overlapping timestamps are not evidence of causation.\n\n");
    md.push_str("## Session\n\n| | |\n|---|---|\n");
    md.push_str(&format!("| Session id | {} |\n| State | {} |\n| Mode | {} |\n", s.id, s.state, s.mode));
    md.push_str(&format!(
        "| Target | {} {} (PID {}) |\n",
        s.target_kind,
        s.target_name.as_deref().unwrap_or(""),
        s.target_pid.map(|p| p.to_string()).unwrap_or_else(|| "—".into())
    ));
    if let Some(j) = s.job_id {
        md.push_str(&format!("| Linked FlowDesk task | #{j} |\n"));
    }
    md.push_str(&format!("| Events stored | {} |\n| Event time span | {span} |\n", sum.events));
    if let Some(st) = &s.stats {
        for (k, label) in [
            ("etwDelivered", "ETW events delivered (before filtering)"),
            ("filteredOut", "Filtered out (other processes / filters)"),
            ("selfExcluded", "Excluded tracer I/O"),
            ("queueDropped", "Dropped by FlowDesk (queue full)"),
            ("etwEventsLost", "ETW events lost (session)"),
            ("etwRtBuffersLost", "ETW real-time buffers lost"),
        ] {
            let v = st.get(k).filter(|v| !v.is_null()).map(|v| v.to_string()).unwrap_or_else(|| "not reported".into());
            md.push_str(&format!("| {label} | {v} |\n"));
        }
    }
    if let Some(e) = &s.error {
        md.push_str(&format!("| Error | {} |\n", e.replace('|', "\\|")));
    }
    md.push_str("\n## Observed: events by provider\n\n| Provider | Events |\n|---|---:|\n");
    for (k, v) in &sum.by_provider {
        md.push_str(&format!("| {k} | {v} |\n"));
    }
    md.push_str("\n## Derived: operations\n\nDurations exist only for requests matched to an OperationEnd by IRP (nearest-rank percentiles).\n\n");
    md.push_str("| Category | Operation | Count | Bytes | Matched | Unmatched | Errors/warnings | p50 µs | p95 µs | max µs |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|\n");
    let o = |v: Option<i64>| v.map(|v| v.to_string()).unwrap_or_else(|| "—".into());
    for op in &sum.operations {
        md.push_str(&format!(
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |\n",
            op.category, op.operation, op.count, op.bytes, op.matched, op.unmatched, op.errors, o(op.p50_us), o(op.p95_us), o(op.max_us)
        ));
    }
    if !sum.top_files.is_empty() {
        md.push_str("\n## Observed: files by bytes transferred\n\n| File | Events | Read bytes | Write bytes |\n|---|---:|---:|---:|\n");
        for f in &sum.top_files {
            md.push_str(&format!("| `{}` | {} | {} | {} |\n", r.path(&f.path), f.events, f.read_bytes, f.write_bytes));
        }
    }
    if sum.unknown_path_events > 0 {
        md.push_str(&format!(
            "\n{} file events have no known path (their file object was opened before the capture started).\n",
            sum.unknown_path_events
        ));
    }
    if !sum.results.is_empty() {
        md.push_str("\n## Observed: non-success results\n\n| NTSTATUS | Count |\n|---|---:|\n");
        for (code, n) in &sum.results {
            md.push_str(&format!("| {code} | {n} |\n"));
        }
    }
    md.push_str("\n_Generated by FlowDesk System Call Observatory (ETW mode)._\n");
    md
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::synthetic;

    #[test]
    fn redaction_modes() {
        let r = Redactor::with_profile(Redact::User, "C:\\Users\\alex");
        assert_eq!(r.path("C:\\Users\\Alex\\Docs\\a.txt"), "%USERPROFILE%\\Docs\\a.txt");
        assert_eq!(r.path("D:\\data\\b.bin"), "D:\\data\\b.bin");
        let r = Redactor::with_profile(Redact::Paths, "C:\\Users\\alex");
        let a = r.path("C:\\Users\\alex\\secret\\plan.docx");
        assert!(a.starts_with("<redacted:") && a.ends_with(".docx"));
        assert_eq!(a, r.path("c:\\users\\ALEX\\secret\\plan.docx"), "stable pseudonym");
        assert!(!a.contains("secret"));

        let mut ev = synthetic::file_reads(1, 0, 1, 1).remove(0);
        ev.fields.insert("FileName".into(), json!("\\Device\\HarddiskVolume3\\secret.txt"));
        r.event(&mut ev);
        assert!(!ev.file_path.unwrap().contains("synthetic"));
        assert!(ev.fields["FileName"].as_str().unwrap().starts_with("<redacted:"));
    }

    #[test]
    fn csv_row_has_every_column_and_quotes() {
        let mut ev = synthetic::file_reads(1, 0, 1, 1).remove(0);
        ev.file_path = Some("C:\\a,b\\c.txt".into());
        let row = csv_row(&ev);
        assert!(row.contains("\"C:\\a,b\\c.txt\""));
        assert!(row.ends_with('\n'));
        let header_cols = CSV_HEADER.trim_end().split(',').count();
        assert_eq!(header_cols, 24);
    }
}
