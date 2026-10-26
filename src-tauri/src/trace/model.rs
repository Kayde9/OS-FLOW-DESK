//! Normalized trace event model, session configuration and the capture
//! lifecycle state machine.
//!
//! Optional fields stay `None` when a provider does not supply them; nothing is
//! filled in with guessed values.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::engine::SubmitRequest;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Idle,
    Preparing,
    Capturing,
    Stopping,
    Finalizing,
    Completed,
    Failed,
    Cancelled,
}

impl SessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionState::Idle => "idle",
            SessionState::Preparing => "preparing",
            SessionState::Capturing => "capturing",
            SessionState::Stopping => "stopping",
            SessionState::Finalizing => "finalizing",
            SessionState::Completed => "completed",
            SessionState::Failed => "failed",
            SessionState::Cancelled => "cancelled",
        }
    }
    pub fn terminal(self) -> bool {
        matches!(self, SessionState::Completed | SessionState::Failed | SessionState::Cancelled)
    }
    /// Legal transitions of the capture lifecycle. Cancellation of a running
    /// capture still passes through Stopping and Finalizing so buffered events
    /// are flushed and saved.
    pub fn can_go(self, to: SessionState) -> bool {
        use SessionState::*;
        matches!(
            (self, to),
            (Idle, Preparing)
                | (Preparing, Capturing | Failed | Cancelled)
                | (Capturing, Stopping | Failed)
                | (Stopping, Finalizing | Failed)
                | (Finalizing, Completed | Cancelled | Failed)
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventSource {
    /// Observed by a Windows ETW provider.
    Etw,
    /// Emitted by FlowDesk's own job engine (application level).
    Flowdesk,
}

impl EventSource {
    pub fn as_str(self) -> &'static str {
        match self {
            EventSource::Etw => "etw",
            EventSource::Flowdesk => "flowdesk",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceEvent {
    /// Arrival order within the session (unique, monotonic).
    pub seq: u64,
    /// Event timestamp from the source, Unix epoch microseconds.
    pub ts_us: i64,
    /// When FlowDesk processed the event, Unix epoch microseconds.
    pub recv_us: i64,
    pub source: EventSource,
    pub provider: String,
    pub category: String,
    pub event_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_id: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opcode: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    /// Only set when a matching completion event was observed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_us: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_code: Option<String>,
    /// The request carries an IRP and a completion event may follow.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub awaits_completion: bool,
    pub fields: Map<String, Value>,
}

/// A completion (Kernel-File OperationEnd) matched to an earlier request by IRP.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub seq: u64,
    pub end_us: i64,
    pub duration_us: i64,
    pub status: String,
    pub result_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_information: Option<String>,
}

/// An event schema reported by TDH during capture (the verification record of
/// which provider fields were actually available on this machine).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub provider: String,
    pub event_id: u16,
    pub version: u8,
    pub name: String,
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TargetSpec {
    /// Start a FlowDesk job and trace the FlowDesk process while it runs.
    Workload { job: SubmitRequest },
    /// Trace an already-running process (subject to provider limits).
    Process { pid: u32, name: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceConfig {
    pub target: TargetSpec,
    #[serde(default)]
    pub name: Option<String>,
    /// ETW provider ids from `providers::ALL` ("file", "process", "disk").
    /// Empty = FlowDesk application events only (no ETW session).
    pub providers: Vec<String>,
    /// Kernel-File OperationEnd events: gives durations and NTSTATUS results.
    #[serde(default = "yes")]
    pub file_completions: bool,
    /// Kernel-File handle/metadata events (Cleanup, Close, Query/SetInformation, DirEnum…).
    #[serde(default)]
    pub file_metadata: bool,
    #[serde(default = "default_duration")]
    pub max_duration_s: u64,
    #[serde(default = "default_events")]
    pub max_events: u64,
    #[serde(default = "default_buffer_kb")]
    pub buffer_kb: u32,
    #[serde(default = "default_buffers")]
    pub max_buffers: u32,
    #[serde(default = "yes")]
    pub stop_with_workload: bool,
    /// Drop I/O issued by FlowDesk's own trace-writer thread (avoids a feedback loop).
    #[serde(default = "yes")]
    pub exclude_tracer_io: bool,
    #[serde(default)]
    pub path_filter: Option<String>,
}

fn yes() -> bool {
    true
}
fn default_duration() -> u64 {
    120
}
fn default_events() -> u64 {
    250_000
}
fn default_buffer_kb() -> u32 {
    256
}
fn default_buffers() -> u32 {
    64
}

impl TraceConfig {
    pub fn sanitize(mut self) -> Self {
        self.max_duration_s = self.max_duration_s.clamp(5, 1800);
        self.max_events = self.max_events.clamp(1_000, 2_000_000);
        self.buffer_kb = self.buffer_kb.clamp(64, 1024);
        self.max_buffers = self.max_buffers.clamp(16, 512);
        self.providers.retain(|p| super::providers::find(p).is_some());
        self.providers.dedup();
        self.path_filter = self.path_filter.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        self
    }
}

/// Live counters for the active session, assembled from the consumer and writer threads.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceStats {
    /// Events that matched the target and were queued for storage.
    pub captured: u64,
    pub persisted: u64,
    pub by_category: BTreeMap<String, u64>,
    /// Matched completions whose NTSTATUS indicates an error or warning.
    pub errors: u64,
    pub completions: u64,
    /// Every event ETW delivered to FlowDesk before target filtering.
    pub etw_delivered: u64,
    pub filtered_out: u64,
    pub self_excluded: u64,
    /// Events FlowDesk could not queue because its bounded buffer was full.
    pub queue_dropped: u64,
    /// Events that matched but were not streamed to the live view (still saved).
    pub not_streamed: u64,
    /// From ControlTrace(QUERY); `None` without an ETW session.
    pub etw_events_lost: Option<u64>,
    pub etw_buffers_lost: Option<u64>,
    pub etw_rt_buffers_lost: Option<u64>,
    pub first_event_us: Option<i64>,
    pub last_event_us: Option<i64>,
    pub limit_hit: Option<String>,
}

#[cfg(test)]
impl TraceStats {
    /// Events attributed to ETW providers (everything except FlowDesk workload events).
    pub fn etw_events(&self) -> u64 {
        self.by_category.iter().filter(|(k, _)| k.as_str() != "workload").map(|(_, v)| *v).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::SessionState::*;

    #[test]
    fn lifecycle_transitions() {
        let happy = [Idle, Preparing, Capturing, Stopping, Finalizing, Completed];
        assert!(happy.windows(2).all(|w| w[0].can_go(w[1])));
        assert!(Finalizing.can_go(Cancelled));
        assert!(Preparing.can_go(Failed));
        // Illegal: skipping the flush, resurrecting a finished session, double start.
        assert!(!Capturing.can_go(Completed));
        assert!(!Completed.can_go(Capturing));
        assert!(!Capturing.can_go(Preparing));
        assert!(!Idle.can_go(Capturing));
        for s in [Completed, Failed, Cancelled] {
            assert!(s.terminal());
            assert!([Idle, Preparing, Capturing, Stopping, Finalizing, Completed, Failed, Cancelled]
                .iter()
                .all(|t| !s.can_go(*t)));
        }
    }
}
