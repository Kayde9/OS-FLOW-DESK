//! Target filtering and event correlation over decoded events. Independent of
//! the ETW API, so it is tested with synthetic input.
//!
//! Correlation rules (documented in the UI):
//! * File paths: Kernel-File Create carries `FileName` and `FileObject`; later
//!   requests on the same `FileObject` inherit that path. Files opened before
//!   the capture started have no known path.
//! * Durations: a request carrying `Irp` is matched to the next OperationEnd
//!   with the same `Irp`. duration = OperationEnd timestamp − request timestamp.
//!   Requests without an observed OperationEnd keep no duration.
//! * Disk I/O: Kernel-Disk events are usually logged outside the requesting
//!   process and (verified on Windows 11 26200) carry no issuing thread. They
//!   are attributed when the header process id is the target, or when their
//!   `FileObject` belongs to a file the target opened during the capture.
//!   Cache write-back and paging I/O without such a link are not attributed.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Map, Value};

use super::decode::{Decoded, Layout};
use super::model::{Completion, EventSource, TraceEvent};
use super::providers::{self, Kind, ProviderDef};
use crate::engine::AppEvent;

const MAX_TRACKED: usize = 200_000;

pub struct RawHeader {
    pub provider: &'static ProviderDef,
    pub id: u16,
    pub version: u8,
    pub opcode: u8,
    pub pid: u32,
    pub tid: u32,
    pub ts_us: i64,
    pub cpu: u8,
    pub keyword: u64,
}

#[derive(Default)]
pub struct Counters {
    pub delivered: AtomicU64,
    pub filtered: AtomicU64,
    pub self_excluded: AtomicU64,
    pub queue_dropped: AtomicU64,
    pub captured: AtomicU64,
    /// Tracking tables were reset because they hit their bound.
    pub table_resets: AtomicU64,
}

pub struct CollectorCfg {
    pub target_pid: u32,
    pub target_name: Option<String>,
    pub self_pid: u32,
    pub completions: bool,
    pub exclude_tids: HashSet<u32>,
    pub path_filter: Option<String>,
    /// (NT device prefix lowercase, e.g. "\device\harddiskvolume3", drive "C:")
    pub dos_map: Vec<(String, String)>,
    pub thread_names: HashMap<u32, String>,
}

pub enum Out {
    Event(TraceEvent),
    Completion(Completion),
}

pub struct Collector {
    cfg: CollectorCfg,
    seq: Arc<AtomicU64>,
    counters: Arc<Counters>,
    file_objects: HashMap<u64, String>,
    pending: HashMap<u64, (u64, i64)>,
}

fn is_op_end(layout: &Layout) -> bool {
    layout.task_name.as_deref() == Some("OperationEnd") || layout.event_name.as_deref() == Some("OperationEnd")
}

pub fn status_parts(code: u32) -> (String, String) {
    let hex = format!("0x{code:08X}");
    let rc = match providers::ntstatus_name(code) {
        Some(n) => format!("{hex} {n}"),
        None => hex,
    };
    (providers::ntstatus_class(code).to_string(), rc)
}

impl Collector {
    pub fn new(mut cfg: CollectorCfg, seq: Arc<AtomicU64>, counters: Arc<Counters>) -> Self {
        cfg.path_filter = cfg.path_filter.map(|s| s.to_lowercase());
        Collector { cfg, seq, counters, file_objects: HashMap::new(), pending: HashMap::new() }
    }

    fn filtered(&self) -> bool {
        self.counters.filtered.fetch_add(1, Ordering::Relaxed);
        false
    }

    fn excluded(&self, pid: u32, tid: u32) -> bool {
        pid == self.cfg.self_pid && self.cfg.exclude_tids.contains(&tid)
    }

    /// Cheap pre-check on the header: is the payload worth decoding?
    pub fn wants_payload(&self, h: &RawHeader, layout: &Layout) -> bool {
        match h.provider.kind {
            Kind::File => {
                if h.pid == self.cfg.target_pid {
                    if self.excluded(h.pid, h.tid) {
                        self.counters.self_excluded.fetch_add(1, Ordering::Relaxed);
                        return false;
                    }
                    true
                } else if self.cfg.completions && is_op_end(layout) && !self.pending.is_empty() {
                    true
                } else {
                    self.filtered()
                }
            }
            // Low volume, and attribution needs payload fields.
            Kind::Process | Kind::Disk => true,
        }
    }

    pub fn nt_to_dos(&self, p: &str) -> String {
        let p = p.strip_prefix("\\??\\").unwrap_or(p);
        let lower = p.to_lowercase();
        for (dev, drive) in &self.cfg.dos_map {
            if lower.starts_with(dev.as_str()) && lower[dev.len()..].starts_with('\\') {
                return format!("{drive}{}", &p[dev.len()..]);
            }
        }
        p.to_string()
    }

    fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn base(&self, h: &RawHeader, layout: &Layout, d: &Decoded, category: &str, recv_us: i64) -> TraceEvent {
        let mut fields: Map<String, Value> = d.fields.iter().map(|(k, v)| (k.clone(), v.to_json())).collect();
        if let Some(why) = &d.incomplete {
            fields.insert("_undecoded".into(), json!(why));
        }
        fields.insert("_keyword".into(), json!(format!("0x{:X}", h.keyword)));
        fields.insert("_headerProcessId".into(), json!(h.pid));
        fields.insert("_headerThreadId".into(), json!(h.tid));
        TraceEvent {
            seq: 0,
            ts_us: h.ts_us,
            recv_us,
            source: EventSource::Etw,
            provider: h.provider.name.to_string(),
            category: category.to_string(),
            event_name: layout.display_name(h.id),
            event_id: Some(h.id),
            version: Some(h.version),
            opcode: Some(h.opcode),
            pid: Some(h.pid),
            tid: Some(h.tid),
            process_name: None,
            thread_name: None,
            cpu: Some(h.cpu),
            operation: layout.task_name.clone().filter(|s| !s.is_empty()),
            file_path: None,
            size: None,
            offset: None,
            duration_us: None,
            status: None,
            result_code: None,
            awaits_completion: false,
            fields,
        }
    }

    fn label(&self, ev: &mut TraceEvent) {
        if ev.pid == Some(self.cfg.target_pid) {
            ev.process_name = self.cfg.target_name.clone();
        }
        if ev.pid == Some(self.cfg.self_pid) {
            ev.thread_name = ev.tid.and_then(|t| self.cfg.thread_names.get(&t).cloned());
        }
    }

    pub fn on_event(&mut self, h: &RawHeader, layout: &Layout, d: &Decoded, recv_us: i64) -> Option<Out> {
        match h.provider.kind {
            Kind::File => self.on_file(h, layout, d, recv_us),
            Kind::Process => self.on_process(h, layout, d, recv_us),
            Kind::Disk => self.on_disk(h, layout, d, recv_us),
        }
    }

    fn on_file(&mut self, h: &RawHeader, layout: &Layout, d: &Decoded, recv_us: i64) -> Option<Out> {
        if is_op_end(layout) {
            let start = d.u64("Irp").and_then(|irp| self.pending.remove(&irp));
            let Some((seq, start_us)) = start else {
                self.filtered();
                return None;
            };
            let (status, result_code) = match d.u64("Status") {
                Some(code) => status_parts(code as u32),
                None => ("unknown".into(), "not reported".into()),
            };
            return Some(Out::Completion(Completion {
                seq,
                end_us: h.ts_us,
                duration_us: (h.ts_us - start_us).max(0),
                status,
                result_code,
                extra_information: d.get("ExtraInformation").map(|v| v.to_json().to_string().trim_matches('"').to_string()),
            }));
        }
        if h.pid != self.cfg.target_pid {
            self.filtered();
            return None;
        }
        let fo = d.u64("FileObject");
        let named = d.str("FileName").or_else(|| d.str("FilePath")).map(|p| self.nt_to_dos(p));
        let path = match (&named, fo) {
            (Some(p), Some(fo)) if layout.task_name.as_deref() == Some("Create") => {
                if self.file_objects.len() >= MAX_TRACKED {
                    self.file_objects.clear();
                    self.counters.table_resets.fetch_add(1, Ordering::Relaxed);
                }
                self.file_objects.insert(fo, p.clone());
                Some(p.clone())
            }
            (Some(p), _) => Some(p.clone()),
            (None, Some(fo)) => self.file_objects.get(&fo).cloned(),
            (None, None) => None,
        };
        if layout.task_name.as_deref() == Some("Close") {
            if let Some(fo) = fo {
                self.file_objects.remove(&fo);
            }
        }
        if let Some(f) = &self.cfg.path_filter {
            if !path.as_ref().is_some_and(|p| p.to_lowercase().contains(f.as_str())) {
                self.filtered();
                return None;
            }
        }
        let mut ev = self.base(h, layout, d, "file", recv_us);
        ev.file_path = path;
        ev.size = d.u64("IOSize");
        ev.offset = d.u64("ByteOffset");
        if fo.is_some() && ev.file_path.is_none() {
            ev.fields.insert("_path".into(), json!("unknown: file object opened before capture started"));
        }
        ev.seq = self.next_seq();
        if let (true, Some(irp)) = (self.cfg.completions, d.u64("Irp")) {
            if self.pending.len() >= MAX_TRACKED {
                self.pending.clear();
                self.counters.table_resets.fetch_add(1, Ordering::Relaxed);
            }
            self.pending.insert(irp, (ev.seq, h.ts_us));
            ev.awaits_completion = true;
        }
        self.label(&mut ev);
        Some(Out::Event(ev))
    }

    fn on_process(&mut self, h: &RawHeader, layout: &Layout, d: &Decoded, recv_us: i64) -> Option<Out> {
        let t = self.cfg.target_pid;
        let pid = d.u64("ProcessID").map(|v| v as u32);
        let parent = d.u64("ParentProcessID").map(|v| v as u32);
        if !(h.pid == t || pid == Some(t) || parent == Some(t)) {
            self.filtered();
            return None;
        }
        let task = layout.task_name.as_deref().unwrap_or("");
        let category = if task.contains("Thread") {
            "thread"
        } else if task.contains("Image") {
            "image"
        } else {
            "process"
        };
        let tid = d.u64("ThreadID").map(|v| v as u32);
        let mut ev = self.base(h, layout, d, category, recv_us);
        // The process/thread the event is about (the header names the logging context).
        ev.pid = pid.or(Some(h.pid));
        ev.tid = tid.or(Some(h.tid));
        ev.file_path = d.str("ImageName").or_else(|| d.str("FileName")).map(|p| self.nt_to_dos(p));
        ev.size = d.u64("ImageSize");
        ev.seq = self.next_seq();
        self.label(&mut ev);
        Some(Out::Event(ev))
    }

    fn on_disk(&mut self, h: &RawHeader, layout: &Layout, d: &Decoded, recv_us: i64) -> Option<Out> {
        if self.excluded(h.pid, h.tid) {
            self.counters.self_excluded.fetch_add(1, Ordering::Relaxed);
            return None;
        }
        let file = d.u64("FileObject").and_then(|fo| self.file_objects.get(&fo).cloned());
        let attribution = if h.pid == self.cfg.target_pid {
            "header process id"
        } else if file.is_some() {
            "file object opened by target"
        } else {
            self.filtered();
            return None;
        };
        let mut ev = self.base(h, layout, d, "disk", recv_us);
        ev.fields.insert("_attribution".into(), json!(attribution));
        if file.is_some() {
            // The logging context is not the requester; only the process is known.
            ev.pid = Some(self.cfg.target_pid);
            ev.tid = None;
        }
        ev.file_path = file;
        ev.size = d.u64("TransferSize");
        ev.offset = d.u64("ByteOffset");
        ev.seq = self.next_seq();
        self.label(&mut ev);
        Some(Out::Event(ev))
    }
}

/// FlowDesk engine event → normalized event (source = flowdesk).
pub fn app_event(seq: u64, e: &AppEvent, self_pid: u32, thread_names: &HashMap<u32, String>, recv_us: i64) -> TraceEvent {
    let mut fields = Map::new();
    fields.insert("jobId".into(), json!(e.job_id));
    if let Some(w) = e.worker {
        fields.insert("worker".into(), json!(w));
    }
    if let Some(d) = &e.detail {
        fields.insert("detail".into(), json!(d));
    }
    TraceEvent {
        seq,
        ts_us: e.ts_us,
        recv_us,
        source: EventSource::Flowdesk,
        provider: "FlowDesk.Engine".into(),
        category: "workload".into(),
        event_name: e.kind.into(),
        event_id: None,
        version: None,
        opcode: None,
        pid: Some(self_pid),
        tid: Some(e.tid),
        process_name: Some("FlowDesk".into()),
        thread_name: thread_names.get(&e.tid).cloned(),
        cpu: None,
        operation: Some(e.kind.into()),
        file_path: e.file.clone(),
        size: None,
        offset: None,
        duration_us: None,
        status: None,
        result_code: None,
        awaits_completion: false,
        fields,
    }
}

#[cfg(test)]
mod tests {
    use super::super::decode::tests::prop;
    use super::super::decode::{Decoded, Val};
    use super::*;

    const TARGET: u32 = 500;

    fn collector(completions: bool, filter: Option<&str>) -> Collector {
        Collector::new(
            CollectorCfg {
                target_pid: TARGET,
                target_name: Some("flowdesk.exe".into()),
                self_pid: TARGET,
                completions,
                exclude_tids: [99].into_iter().collect(),
                path_filter: filter.map(Into::into),
                dos_map: vec![("\\device\\harddiskvolume3".into(), "C:".into())],
                thread_names: [(7, "flowdesk-worker-0".to_string())].into_iter().collect(),
            },
            Arc::new(AtomicU64::new(0)),
            Arc::new(Counters::default()),
        )
    }

    fn layout(task: &str) -> Layout {
        Layout { task_name: Some(task.into()), props: vec![prop("Irp", 16, 0)], ..Default::default() }
    }

    fn hdr(provider: &'static ProviderDef, pid: u32, tid: u32, ts_us: i64) -> RawHeader {
        RawHeader { provider, id: 1, version: 1, opcode: 0, pid, tid, ts_us, cpu: 0, keyword: 0 }
    }

    fn dec(f: &[(&str, Val)]) -> Decoded {
        Decoded { fields: f.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(), incomplete: None }
    }

    fn feed(c: &mut Collector, h: RawHeader, task: &str, d: Decoded) -> Option<Out> {
        let l = layout(task);
        if !c.wants_payload(&h, &l) {
            return None;
        }
        c.on_event(&h, &l, &d, h.ts_us)
    }

    #[test]
    fn file_path_tracking_and_irp_completion() {
        let mut c = collector(true, None);
        let create = feed(
            &mut c,
            hdr(&providers::FILE, TARGET, 7, 1_000),
            "Create",
            dec(&[
                ("Irp", Val::Hex(1)),
                ("FileObject", Val::Hex(0xF0)),
                ("FileName", Val::S("\\Device\\HarddiskVolume3\\data\\a.bin".into())),
            ]),
        );
        let Some(Out::Event(create)) = create else { panic!("create dropped") };
        assert_eq!(create.file_path.as_deref(), Some("C:\\data\\a.bin"));
        assert_eq!(create.thread_name.as_deref(), Some("flowdesk-worker-0"));
        assert!(create.awaits_completion);

        let Some(Out::Event(read)) = feed(
            &mut c,
            hdr(&providers::FILE, TARGET, 7, 2_000),
            "Read",
            dec(&[("Irp", Val::Hex(2)), ("FileObject", Val::Hex(0xF0)), ("IOSize", Val::U(262_144))]),
        ) else {
            panic!("read dropped")
        };
        assert_eq!(read.file_path.as_deref(), Some("C:\\data\\a.bin"));
        assert_eq!(read.size, Some(262_144));
        assert!(read.duration_us.is_none(), "no duration before a completion is seen");

        // Completion logged in another process context is still matched by IRP.
        let Some(Out::Completion(done)) = feed(
            &mut c,
            hdr(&providers::FILE, 4, 1, 2_350),
            "OperationEnd",
            dec(&[("Irp", Val::Hex(2)), ("Status", Val::Hex(0xC000_0011))]),
        ) else {
            panic!("completion not matched")
        };
        assert_eq!((done.seq, done.duration_us), (read.seq, 350));
        assert_eq!(done.status, "error");
        assert!(done.result_code.contains("STATUS_END_OF_FILE"));

        // A second OperationEnd for the same IRP has nothing to match.
        assert!(feed(&mut c, hdr(&providers::FILE, 4, 1, 2_400), "OperationEnd", dec(&[("Irp", Val::Hex(2))])).is_none());
        // Unrelated process is filtered; tracer thread is excluded.
        assert!(feed(&mut c, hdr(&providers::FILE, 777, 1, 3_000), "Read", dec(&[])).is_none());
        assert!(feed(&mut c, hdr(&providers::FILE, TARGET, 99, 3_000), "Write", dec(&[])).is_none());
        assert_eq!(c.counters.self_excluded.load(Ordering::Relaxed), 1);
        assert!(read.seq > create.seq);
    }

    #[test]
    fn unknown_path_is_reported_not_invented_and_filter_applies() {
        let mut c = collector(false, Some("\\data\\"));
        // File object opened before capture: path unknown → filtered when a path filter is set.
        assert!(feed(&mut c, hdr(&providers::FILE, TARGET, 7, 10), "Read", dec(&[("FileObject", Val::Hex(5))])).is_none());
        let mut c = collector(false, None);
        let Some(Out::Event(e)) = feed(&mut c, hdr(&providers::FILE, TARGET, 7, 10), "Read", dec(&[("FileObject", Val::Hex(5)), ("Irp", Val::Hex(9))])) else {
            panic!()
        };
        assert!(e.file_path.is_none());
        assert!(e.fields["_path"].as_str().unwrap().starts_with("unknown"));
        assert!(!e.awaits_completion, "completions disabled");
    }

    #[test]
    fn process_and_disk_attribution() {
        let mut c = collector(true, None);
        // Child process started by the target: header pid = target.
        let Some(Out::Event(p)) = feed(
            &mut c,
            hdr(&providers::PROCESS, TARGET, 7, 5),
            "ProcessStart",
            dec(&[("ProcessID", Val::U(600)), ("ParentProcessID", Val::U(TARGET as u64)), ("ImageName", Val::S("\\Device\\HarddiskVolume3\\x.exe".into()))]),
        ) else {
            panic!()
        };
        assert_eq!((p.category.as_str(), p.pid), ("process", Some(600)));
        assert_eq!(p.file_path.as_deref(), Some("C:\\x.exe"));
        // Thread start of the target, logged by another context.
        let Some(Out::Event(t)) = feed(&mut c, hdr(&providers::PROCESS, 4, 1, 6), "ThreadStart", dec(&[("ProcessID", Val::U(TARGET as u64)), ("ThreadID", Val::U(42))])) else {
            panic!()
        };
        assert_eq!((t.category.as_str(), t.pid, t.tid), ("thread", Some(TARGET), Some(42)));
        // Disk I/O logged in System context for a file the target opened.
        feed(
            &mut c,
            hdr(&providers::FILE, TARGET, 7, 6),
            "Create",
            dec(&[("FileObject", Val::Hex(0xAB)), ("FileName", Val::S("\\Device\\HarddiskVolume3\\d.bin".into()))]),
        );
        let Some(Out::Event(d)) = feed(&mut c, hdr(&providers::DISK, 4, 1, 7), "", dec(&[("FileObject", Val::Hex(0xAB)), ("TransferSize", Val::U(4096))])) else {
            panic!()
        };
        assert_eq!(d.fields["_attribution"], json!("file object opened by target"));
        assert_eq!((d.pid, d.tid, d.size), (Some(TARGET), None, Some(4096)));
        assert_eq!(d.file_path.as_deref(), Some("C:\\d.bin"));
        // Disk I/O with no link to the target is not attributed.
        assert!(feed(&mut c, hdr(&providers::DISK, 4, 1, 8), "", dec(&[("FileObject", Val::Hex(0xCD))])).is_none());
        // Unrelated process start.
        assert!(feed(&mut c, hdr(&providers::PROCESS, 4, 1, 9), "ProcessStart", dec(&[("ProcessID", Val::U(1)), ("ParentProcessID", Val::U(2))])).is_none());
    }
}
