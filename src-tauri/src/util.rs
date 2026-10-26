use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Wall clock in microseconds. On Windows std uses GetSystemTimePreciseAsFileTime,
/// the same clock ETW converts its timestamps to, so the two are comparable.
pub fn now_us() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros() as i64).unwrap_or(0)
}

/// OS thread id of the calling thread (0 where unsupported).
pub fn current_tid() -> u32 {
    #[cfg(windows)]
    {
        unsafe { windows::Win32::System::Threading::GetCurrentThreadId() }
    }
    #[cfg(not(windows))]
    {
        0
    }
}

fn thread_registry() -> &'static Mutex<HashMap<u32, String>> {
    static R: OnceLock<Mutex<HashMap<u32, String>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// Records the calling thread's OS id under `name` so traces can label FlowDesk's own threads.
pub fn register_thread(name: &str) -> u32 {
    let tid = current_tid();
    thread_registry().lock().unwrap().insert(tid, name.to_string());
    tid
}

pub fn thread_names() -> HashMap<u32, String> {
    thread_registry().lock().unwrap().clone()
}

pub fn system_time_ms(t: std::io::Result<SystemTime>) -> Option<i64> {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64)
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 0xf) as usize] as char);
    }
    s
}

pub fn human_bytes(b: u64) -> String {
    const U: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = b as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 { format!("{b} B") } else { format!("{v:.1} {}", U[i]) }
}

/// Quote a CSV field when needed.
pub fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}
