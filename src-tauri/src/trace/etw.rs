//! Native Event Tracing for Windows: a real-time trace session (controller)
//! and its consumer, through advapi32/tdh from the `windows` crate.
//!
//! Lifecycle: StartTrace → OpenTrace + ProcessTrace thread → EnableTraceEx2
//! per provider → … → ControlTrace(STOP) (ETW flushes remaining buffers to the
//! consumer, then ProcessTrace returns) → CloseTrace.
//!
//! Controlling a session needs administrator rights or membership in the
//! "Performance Log Users" group; access-denied is reported as a permission
//! error so the UI can explain it.

use std::sync::atomic::Ordering;
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::Arc;

use super::collector::{Collector, Counters, Out, RawHeader};
use super::providers::ProviderDef;
use super::Msg;

pub const SESSION_NAME: &str = "FlowDesk-Observatory";

#[derive(Debug)]
pub enum EtwError {
    Permission(String),
    Other(String),
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Loss {
    pub events_lost: u64,
    pub log_buffers_lost: u64,
    pub rt_buffers_lost: u64,
}

pub struct StartOptions {
    pub buffer_kb: u32,
    pub max_buffers: u32,
    pub providers: Vec<(&'static ProviderDef, u64)>,
}

/// State owned by the consumer callback (only ever touched on the ProcessTrace thread).
pub struct Consumer {
    pub collector: Collector,
    pub tx: SyncSender<Msg>,
    pub counters: Arc<Counters>,
    pub schemas: Arc<std::sync::Mutex<Vec<super::model::SchemaInfo>>>,
}

impl Consumer {
    fn send(&self, out: Out) {
        let is_event = matches!(out, Out::Event(_));
        let msg = match out {
            Out::Event(e) => Msg::Event(e),
            Out::Completion(c) => Msg::Completion(c),
        };
        match self.tx.try_send(msg) {
            Ok(()) if is_event => {
                self.counters.captured.fetch_add(1, Ordering::Relaxed);
            }
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.counters.queue_dropped.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Disconnected(_)) => {}
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::thread::JoinHandle;
    use std::time::Duration;

    use windows::core::{GUID, PCWSTR, PWSTR};
    use windows::Win32::Foundation::*;
    use windows::Win32::System::Diagnostics::Etw::*;

    use super::super::decode::{self, Layout, PropDef};
    use super::super::providers;
    use super::*;
    use crate::util::{now_us, register_thread};

    struct Ctx {
        consumer: Consumer,
        layouts: HashMap<(u128, u16, u8), Arc<Layout>>,
    }

    struct SendPtr(*mut Ctx);
    unsafe impl Send for SendPtr {}

    pub struct EtwSession {
        handle: CONTROLTRACE_HANDLE,
        trace: PROCESSTRACE_HANDLE,
        thread: Option<JoinHandle<u32>>,
        done: std::sync::mpsc::Receiver<()>,
        pub enabled: Vec<(&'static str, Result<(), String>)>,
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain([0]).collect()
    }

    /// EVENT_TRACE_PROPERTIES followed by room for the logger and log-file names.
    fn props_buffer() -> Vec<u64> {
        let size = std::mem::size_of::<EVENT_TRACE_PROPERTIES>() + 2 * 1024 * 2;
        let mut buf = vec![0u64; size.div_ceil(8)];
        let p = buf.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES;
        unsafe {
            (*p).Wnode.BufferSize = (buf.len() * 8) as u32;
            (*p).LoggerNameOffset = std::mem::size_of::<EVENT_TRACE_PROPERTIES>() as u32;
            (*p).LogFileNameOffset = (std::mem::size_of::<EVENT_TRACE_PROPERTIES>() + 1024 * 2) as u32;
        }
        buf
    }

    fn loss_of(p: &EVENT_TRACE_PROPERTIES) -> Loss {
        Loss {
            events_lost: p.EventsLost as u64,
            log_buffers_lost: p.LogBuffersLost as u64,
            rt_buffers_lost: p.RealTimeBuffersLost as u64,
        }
    }

    /// Stops a session left behind by an earlier FlowDesk run (real-time
    /// sessions outlive their controller if it crashes).
    pub fn stop_stale() -> bool {
        let mut buf = props_buffer();
        let name = wide(SESSION_NAME);
        let st = unsafe {
            ControlTraceW(
                CONTROLTRACE_HANDLE::default(),
                PCWSTR(name.as_ptr()),
                buf.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES,
                EVENT_TRACE_CONTROL_STOP,
            )
        };
        st == ERROR_SUCCESS
    }

    pub fn is_elevated() -> bool {
        unsafe { windows::Win32::UI::Shell::IsUserAnAdmin().as_bool() }
    }

    /// NT device prefixes for each drive letter, e.g. "\device\harddiskvolume3" → "C:".
    pub fn dos_map() -> Vec<(String, String)> {
        let mut out = Vec::new();
        for l in b'A'..=b'Z' {
            let drive = format!("{}:", l as char);
            let w = wide(&drive);
            let mut buf = vec![0u16; 1024];
            let n = unsafe { windows::Win32::Storage::FileSystem::QueryDosDeviceW(PCWSTR(w.as_ptr()), Some(&mut buf)) };
            if n == 0 {
                continue;
            }
            let end = buf.iter().position(|&c| c == 0).unwrap_or(0);
            if end > 0 {
                out.push((String::from_utf16_lossy(&buf[..end]).to_lowercase(), drive));
            }
        }
        out
    }

    unsafe fn wstr_at(base: *const u8, off: u32) -> Option<String> {
        if off == 0 {
            return None;
        }
        let mut p = unsafe { base.add(off as usize) } as *const u16;
        let mut v = Vec::new();
        unsafe {
            while *p != 0 && v.len() < 4096 {
                v.push(*p);
                p = p.add(1);
            }
        }
        let s = String::from_utf16_lossy(&v).trim().to_string();
        (!s.is_empty()).then_some(s)
    }

    /// Reads the event's schema from its provider manifest via TDH.
    fn tdh_layout(rec: &EVENT_RECORD) -> Layout {
        let mut size = 0u32;
        let st = unsafe { TdhGetEventInformation(rec, None, None, &mut size) };
        if st != ERROR_INSUFFICIENT_BUFFER.0 || size == 0 {
            return Layout::default();
        }
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        let info_ptr = buf.as_mut_ptr() as *mut TRACE_EVENT_INFO;
        if unsafe { TdhGetEventInformation(rec, None, Some(info_ptr), &mut size) } != 0 {
            return Layout::default();
        }
        unsafe {
            let info = &*info_ptr;
            let base = info_ptr as *const u8;
            let arr = std::ptr::addr_of!(info.EventPropertyInfoArray) as *const EVENT_PROPERTY_INFO;
            let props = (0..info.TopLevelPropertyCount as usize)
                .map(|i| {
                    let p = &*arr.add(i);
                    PropDef {
                        name: wstr_at(base, p.NameOffset).unwrap_or_else(|| format!("Property{i}")),
                        in_type: p.Anonymous1.nonStructType.InType,
                        out_type: p.Anonymous1.nonStructType.OutType,
                        flags: p.Flags.0,
                        count: p.Anonymous2.count,
                        length: p.Anonymous3.length,
                    }
                })
                .collect();
            Layout {
                provider_name: wstr_at(base, info.ProviderNameOffset),
                event_name: wstr_at(base, info.Anonymous1.EventNameOffset),
                task_name: wstr_at(base, info.TaskNameOffset),
                opcode_name: wstr_at(base, info.OpcodeNameOffset),
                props,
            }
        }
    }

    unsafe extern "system" fn on_event(rec: *mut EVENT_RECORD) {
        let rec = unsafe { &*rec };
        if rec.UserContext.is_null() {
            return;
        }
        let ctx = unsafe { &mut *(rec.UserContext as *mut Ctx) };
        let hdr = &rec.EventHeader;
        let g = hdr.ProviderId.to_u128();
        // Session header events from the EventTrace provider etc. are not ours.
        let Some(provider) = providers::by_guid(g) else { return };
        let c = &ctx.consumer.counters;
        c.delivered.fetch_add(1, Ordering::Relaxed);
        let d = &hdr.EventDescriptor;
        let layout = match ctx.layouts.get(&(g, d.Id, d.Version)) {
            Some(l) => Arc::clone(l),
            None => {
                let l = Arc::new(tdh_layout(rec));
                ctx.consumer.schemas.lock().unwrap().push(l.describe(provider.name, d.Id, d.Version));
                ctx.layouts.insert((g, d.Id, d.Version), Arc::clone(&l));
                l
            }
        };
        let h = RawHeader {
            provider,
            id: d.Id,
            version: d.Version,
            opcode: d.Opcode,
            pid: hdr.ProcessId,
            tid: hdr.ThreadId,
            ts_us: decode::filetime_to_unix_us(hdr.TimeStamp),
            cpu: unsafe { rec.BufferContext.Anonymous.Anonymous.ProcessorNumber },
            keyword: d.Keyword,
        };
        if !ctx.consumer.collector.wants_payload(&h, &layout) {
            return;
        }
        let data: &[u8] = if rec.UserData.is_null() || rec.UserDataLength == 0 {
            &[]
        } else {
            unsafe { std::slice::from_raw_parts(rec.UserData as *const u8, rec.UserDataLength as usize) }
        };
        let ptr = if hdr.Flags as u32 & EVENT_HEADER_FLAG_32_BIT_HEADER != 0 { 4 } else { 8 };
        let mut decoded = decode::decode(&layout, data, ptr);
        if layout.props.is_empty() && !data.is_empty() {
            decoded.incomplete = Some("no TDH schema available for this event".into());
        }
        if let Some(out) = ctx.consumer.collector.on_event(&h, &layout, &decoded, now_us()) {
            ctx.consumer.send(out);
        }
    }

    pub fn start(opts: StartOptions, consumer: Consumer) -> Result<EtwSession, EtwError> {
        let name = wide(SESSION_NAME);
        let mut handle = CONTROLTRACE_HANDLE::default();
        let mut st = ERROR_SUCCESS;
        for attempt in 0..2 {
            let mut buf = props_buffer();
            let p = buf.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES;
            unsafe {
                (*p).Wnode.Flags = WNODE_FLAG_TRACED_GUID;
                (*p).Wnode.ClientContext = 1; // QueryPerformanceCounter timestamps
                (*p).BufferSize = opts.buffer_kb;
                (*p).MinimumBuffers = opts.max_buffers.min(16);
                (*p).MaximumBuffers = opts.max_buffers;
                (*p).LogFileMode = EVENT_TRACE_REAL_TIME_MODE;
                (*p).FlushTimer = 1;
                st = StartTraceW(&mut handle, PCWSTR(name.as_ptr()), p);
            }
            if st == ERROR_ALREADY_EXISTS && attempt == 0 {
                stop_stale();
                continue;
            }
            break;
        }
        if st == ERROR_ACCESS_DENIED {
            return Err(EtwError::Permission(
                "Windows denied access to start an ETW trace session (StartTrace returned ERROR_ACCESS_DENIED). \
                 Controlling trace sessions requires administrator rights or membership in the Performance Log Users group."
                    .into(),
            ));
        }
        if st != ERROR_SUCCESS {
            return Err(EtwError::Other(format!("StartTrace failed with Win32 error {}", st.0)));
        }

        let ctx = Box::into_raw(Box::new(Ctx { consumer, layouts: HashMap::new() }));
        let mut lname = name.clone();
        let mut logfile = EVENT_TRACE_LOGFILEW::default();
        logfile.LoggerName = PWSTR(lname.as_mut_ptr());
        logfile.Anonymous1.ProcessTraceMode = PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD;
        logfile.Anonymous2.EventRecordCallback = Some(on_event);
        logfile.Context = ctx as *mut _;
        let trace = unsafe { OpenTraceW(&mut logfile) };
        if trace.Value == u64::MAX {
            let err = unsafe { GetLastError() };
            stop_handle(handle);
            drop(unsafe { Box::from_raw(ctx) });
            return Err(EtwError::Other(format!("OpenTrace failed with Win32 error {}", err.0)));
        }

        let (done_tx, done) = std::sync::mpsc::channel();
        let sp = SendPtr(ctx);
        let thread = std::thread::Builder::new()
            .name("flowdesk-etw-consumer".into())
            .spawn(move || {
                let sp = sp;
                register_thread("flowdesk-etw-consumer");
                let st = unsafe { ProcessTrace(&[trace], None, None) };
                // ProcessTrace returned: no more callbacks; release the context
                // (drops the sender, which lets the writer drain and finish).
                drop(unsafe { Box::from_raw(sp.0) });
                let _ = done_tx.send(());
                st.0
            })
            .map_err(|e| EtwError::Other(format!("consumer thread: {e}")))?;

        let mut enabled = Vec::new();
        for (p, kw) in &opts.providers {
            let g = GUID::from_u128(p.guid);
            let st = unsafe {
                EnableTraceEx2(handle, &g, EVENT_CONTROL_CODE_ENABLE_PROVIDER.0, 5, *kw, 0, 0, None)
            };
            enabled.push((p.id, if st == ERROR_SUCCESS { Ok(()) } else { Err(format!("EnableTraceEx2 failed with Win32 error {}", st.0)) }));
        }
        let session = EtwSession { handle, trace, thread: Some(thread), done, enabled };
        if session.enabled.iter().all(|(_, r)| r.is_err()) {
            let why = session.enabled.iter().filter_map(|(id, r)| r.as_ref().err().map(|e| format!("{id}: {e}"))).collect::<Vec<_>>().join("; ");
            session.stop();
            return Err(EtwError::Other(format!("No provider could be enabled ({why})")));
        }
        Ok(session)
    }

    fn stop_handle(h: CONTROLTRACE_HANDLE) -> Option<Loss> {
        let mut buf = props_buffer();
        let p = buf.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES;
        let st = unsafe { ControlTraceW(h, PCWSTR::null(), p, EVENT_TRACE_CONTROL_STOP) };
        (st == ERROR_SUCCESS).then(|| loss_of(unsafe { &*p }))
    }

    impl EtwSession {
        pub fn query(&self) -> Option<Loss> {
            let mut buf = props_buffer();
            let p = buf.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES;
            let st = unsafe { ControlTraceW(self.handle, PCWSTR::null(), p, EVENT_TRACE_CONTROL_QUERY) };
            (st == ERROR_SUCCESS).then(|| loss_of(unsafe { &*p }))
        }

        /// Stops the session; ETW delivers the remaining buffered events before
        /// ProcessTrace returns. Returns the final loss counters.
        pub fn stop(mut self) -> Option<Loss> {
            let loss = stop_handle(self.handle);
            // ProcessTrace normally returns right after the final flush; if it
            // does not, CloseTrace forces it to.
            if self.done.recv_timeout(Duration::from_secs(5)).is_err() {
                let _ = unsafe { CloseTrace(self.trace) };
            }
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
            let _ = unsafe { CloseTrace(self.trace) };
            loss
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub struct EtwSession {
        pub enabled: Vec<(&'static str, Result<(), String>)>,
    }
    impl EtwSession {
        pub fn query(&self) -> Option<Loss> {
            None
        }
        pub fn stop(self) -> Option<Loss> {
            None
        }
    }
    pub fn start(_: StartOptions, _: Consumer) -> Result<EtwSession, EtwError> {
        Err(EtwError::Other("ETW is only available on Windows".into()))
    }
    pub fn stop_stale() -> bool {
        false
    }
    pub fn is_elevated() -> bool {
        false
    }
    pub fn dos_map() -> Vec<(String, String)> {
        Vec::new()
    }
}

pub use imp::*;
