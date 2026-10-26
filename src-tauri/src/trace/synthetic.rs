//! SYNTHETIC trace events — for automated tests only.
//!
//! Compiled only under `cfg(test)`; nothing here can reach a running FlowDesk
//! build or be presented as a Windows trace. Every generated event is tagged
//! with `provider = "SYNTHETIC-TEST"` and `fields._synthetic = true`.

use serde_json::{json, Map};

use super::collector::status_parts;
use super::model::{Completion, EventSource, TraceEvent};

pub const PROVIDER: &str = "SYNTHETIC-TEST";

pub fn file_reads(pid: u32, start_seq: u64, n: usize, step_us: i64) -> Vec<TraceEvent> {
    (0..n)
        .map(|i| {
            let mut fields = Map::new();
            fields.insert("_synthetic".into(), json!(true));
            fields.insert("Irp".into(), json!(format!("0x{:X}", 0x1000 + i)));
            TraceEvent {
                seq: start_seq + i as u64 + 1,
                ts_us: 1_700_000_000_000_000 + i as i64 * step_us,
                recv_us: 1_700_000_000_000_000 + i as i64 * step_us + 50,
                source: EventSource::Etw,
                provider: PROVIDER.into(),
                category: "file".into(),
                event_name: "Read".into(),
                event_id: Some(15),
                version: Some(1),
                opcode: Some(0),
                pid: Some(pid),
                tid: Some(100 + (i % 3) as u32),
                process_name: Some("synthetic.exe".into()),
                thread_name: None,
                cpu: Some((i % 4) as u8),
                operation: Some("Read".into()),
                file_path: Some(format!("C:\\synthetic\\file{}.bin", i % 4)),
                size: Some(262_144),
                offset: Some(i as u64 * 262_144),
                duration_us: None,
                status: None,
                result_code: None,
                awaits_completion: true,
                fields,
            }
        })
        .collect()
}

pub fn completion(ev: &TraceEvent, duration_us: i64, status: u32) -> Completion {
    let (status, result_code) = status_parts(status);
    Completion { seq: ev.seq, end_us: ev.ts_us + duration_us, duration_us, status, result_code, extra_information: None }
}
