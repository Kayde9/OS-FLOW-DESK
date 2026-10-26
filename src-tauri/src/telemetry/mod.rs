//! Telemetry service: samples real device measurements on a background thread,
//! keeps a ring buffer for charts, emits `telemetry://sample` events and records
//! samples to SQLite while FlowDesk tasks are running.
//!
//! Every metric carries its unit, source and availability. Values that the
//! hardware/OS does not expose are reported as unavailable with an explanation —
//! never estimated or invented.

mod gpu;
mod pdh;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{Components, CpuRefreshKind, Disks, DiskRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter};

use crate::db::Db;
use crate::util::now_ms;

const HISTORY_CAP: usize = 3600;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metric {
    pub value: Option<f64>,
    pub unit: &'static str,
    pub source: &'static str,
    /// The sensor/counter exists on this system.
    pub available: bool,
    pub note: Option<String>,
}

impl Metric {
    fn val(value: f64, unit: &'static str, source: &'static str) -> Self {
        Metric { value: Some(value), unit, source, available: true, note: None }
    }
    fn opt(value: Option<f64>, unit: &'static str, source: &'static str, missing: &str) -> Self {
        match value {
            Some(v) => Self::val(v, unit, source),
            None => Self::na(unit, source, missing),
        }
    }
    fn na(unit: &'static str, source: &'static str, note: &str) -> Self {
        Metric { value: None, unit, source, available: false, note: Some(note.to_string()) }
    }
    fn warming(unit: &'static str, source: &'static str) -> Self {
        Metric { value: None, unit, source, available: true, note: Some("Collecting baseline sample".into()) }
    }
    fn with_note(mut self, note: &str) -> Self {
        self.note = Some(note.to_string());
        self
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Throttle {
    pub available: bool,
    pub active: bool,
    pub reasons: Vec<&'static str>,
    pub source: &'static str,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub ts: i64,
    pub cpu: Metric,
    pub cores: Vec<f64>,
    pub cpu_freq: Metric,
    pub cpu_temp: Metric,
    pub mem_used: Metric,
    pub mem_total: Metric,
    pub mem_available: Metric,
    pub swap_used: Metric,
    pub swap_total: Metric,
    pub disk_read: Metric,
    pub disk_write: Metric,
    pub disk_active: Metric,
    pub gpu_util: Metric,
    pub gpu_temp: Metric,
    pub gpu_power: Metric,
    pub gpu_fan: Metric,
    pub gpu_mem_used: Metric,
    pub gpu_mem_total: Metric,
    pub gpu_throttle: Throttle,
    pub fan: Metric,
    pub app_cpu: Metric,
    pub app_mem: Metric,
    pub process_count: Option<usize>,
}

/// One long-format row as persisted in `telemetry_samples`.
pub struct MetricRow {
    pub metric: &'static str,
    pub value: Option<f64>,
    pub unit: &'static str,
    pub source: &'static str,
    pub available: bool,
}

impl Sample {
    pub fn rows(&self) -> Vec<MetricRow> {
        let r = |metric: &'static str, m: &Metric| MetricRow {
            metric,
            value: m.value,
            unit: m.unit,
            source: m.source,
            available: m.available,
        };
        vec![
            r("cpu", &self.cpu),
            r("cpu_temp", &self.cpu_temp),
            r("mem_used", &self.mem_used),
            r("disk_read", &self.disk_read),
            r("disk_write", &self.disk_write),
            r("disk_active", &self.disk_active),
            r("gpu_util", &self.gpu_util),
            r("gpu_temp", &self.gpu_temp),
            r("gpu_power", &self.gpu_power),
            r("app_cpu", &self.app_cpu),
            r("app_mem", &self.app_mem),
        ]
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub host: Option<String>,
    pub os: Option<String>,
    pub cpu_brand: String,
    pub logical_cores: usize,
    pub physical_cores: Option<usize>,
    pub total_memory: u64,
    pub gpu_name: Option<String>,
    pub gpu_note: Option<String>,
    pub pdh_disk: bool,
    pub pdh_gpu: bool,
    pub thermal_zones: usize,
    pub self_pid: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub pid: u32,
    pub parent: Option<u32>,
    pub name: String,
    pub exe: Option<String>,
    /// Percentage of total CPU capacity (0–100 across all logical cores).
    pub cpu: f64,
    pub memory: u64,
    pub virtual_memory: u64,
    pub status: String,
    pub disk_read_bps: f64,
    pub disk_write_bps: f64,
    pub run_time: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessList {
    pub ts: i64,
    /// CPU % needs two refreshes; false on the very first call.
    pub cpu_ready: bool,
    pub processes: Vec<ProcInfo>,
}

struct ProcSampler {
    sys: System,
    last: Option<Instant>,
}

pub struct Telemetry {
    history: Mutex<VecDeque<Sample>>,
    info: Mutex<SystemInfo>,
    pub interval_ms: AtomicU64,
    last_ok: AtomicU64,
    procs: Mutex<ProcSampler>,
}

impl Telemetry {
    pub fn new(interval_ms: u64) -> Arc<Self> {
        Arc::new(Telemetry {
            history: Mutex::new(VecDeque::with_capacity(HISTORY_CAP)),
            info: Mutex::new(SystemInfo::default()),
            interval_ms: AtomicU64::new(interval_ms.clamp(500, 10_000)),
            last_ok: AtomicU64::new(0),
            procs: Mutex::new(ProcSampler { sys: System::new(), last: None }),
        })
    }

    pub fn history(&self) -> Vec<Sample> {
        self.history.lock().unwrap().iter().cloned().collect()
    }
    pub fn info(&self) -> SystemInfo {
        self.info.lock().unwrap().clone()
    }
    pub fn last_ok(&self) -> u64 {
        self.last_ok.load(Ordering::Relaxed)
    }

    pub fn list_processes(&self) -> ProcessList {
        let mut p = self.procs.lock().unwrap();
        let ncpu = p.sys.cpus().len().max(1);
        if ncpu == 1 {
            p.sys.refresh_cpu_list(CpuRefreshKind::nothing());
        }
        let ncpu = p.sys.cpus().len().max(1) as f64;
        p.sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory()
                .with_disk_usage()
                .with_exe(sysinfo::UpdateKind::OnlyIfNotSet),
        );
        let now = Instant::now();
        let cpu_ready = p.last.is_some();
        let dt = p.last.map(|l| now.duration_since(l).as_secs_f64()).unwrap_or(1.0).max(0.001);
        p.last = Some(now);
        let processes = p
            .sys
            .processes()
            .values()
            .map(|pr| {
                let du = pr.disk_usage();
                ProcInfo {
                    pid: pr.pid().as_u32(),
                    parent: pr.parent().map(|x| x.as_u32()),
                    name: pr.name().to_string_lossy().into_owned(),
                    exe: pr.exe().map(|e| e.to_string_lossy().into_owned()),
                    cpu: if cpu_ready { pr.cpu_usage() as f64 / ncpu } else { 0.0 },
                    memory: pr.memory(),
                    virtual_memory: pr.virtual_memory(),
                    status: pr.status().to_string(),
                    disk_read_bps: if cpu_ready { du.read_bytes as f64 / dt } else { 0.0 },
                    disk_write_bps: if cpu_ready { du.written_bytes as f64 / dt } else { 0.0 },
                    run_time: pr.run_time(),
                }
            })
            .collect();
        ProcessList { ts: now_ms(), cpu_ready, processes }
    }

    /// Spawns the sampling thread. `running_jobs` returns the ids of tasks whose
    /// telemetry should be persisted for this tick.
    pub fn start<F>(self: &Arc<Self>, app: AppHandle, db: Arc<Db>, running_jobs: F)
    where
        F: Fn() -> Vec<i64> + Send + 'static,
    {
        let me = Arc::clone(self);
        std::thread::Builder::new()
            .name("flowdesk-telemetry".into())
            .spawn(move || me.run(app, db, running_jobs))
            .expect("spawn telemetry thread");
    }

    fn run<F: Fn() -> Vec<i64>>(&self, app: AppHandle, db: Arc<Db>, running_jobs: F) {
        crate::util::register_thread("flowdesk-telemetry");
        let self_pid = Pid::from_u32(std::process::id());
        let mut sys = System::new();
        sys.refresh_cpu_all();
        sys.refresh_memory();
        let mut pdh = pdh::Pdh::new();
        let mut disks = Disks::new_with_refreshed_list_specifics(DiskRefreshKind::nothing().with_io_usage());
        let nv = gpu::NvGpu::new();
        let mut components = Components::new_with_refreshed_list();
        let thermal_zones = components.list().iter().filter(|c| c.temperature().is_some()).count();

        {
            let mut info = self.info.lock().unwrap();
            *info = SystemInfo {
                host: System::host_name(),
                os: System::long_os_version(),
                cpu_brand: sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default(),
                logical_cores: sys.cpus().len(),
                physical_cores: System::physical_core_count(),
                total_memory: sys.total_memory(),
                gpu_name: nv.as_ref().ok().map(|g| g.name.clone()),
                gpu_note: nv.as_ref().err().cloned(),
                pdh_disk: pdh.as_ref().map(|p| p.has_disk()).unwrap_or(false),
                pdh_gpu: pdh.as_ref().map(|p| p.has_gpu()).unwrap_or(false),
                thermal_zones,
                self_pid: std::process::id(),
            };
        }

        let ncpu = sys.cpus().len().max(1) as f64;
        let mut tick: u64 = 0;
        let mut last = Instant::now();
        loop {
            let interval = Duration::from_millis(self.interval_ms.load(Ordering::Relaxed));
            std::thread::sleep(interval.saturating_sub(last.elapsed()));
            let dt = last.elapsed().as_secs_f64().max(0.001);
            last = Instant::now();
            tick += 1;

            sys.refresh_cpu_usage();
            if tick % 5 == 1 {
                sys.refresh_cpu_frequency();
            }
            sys.refresh_memory();
            sys.refresh_processes_specifics(
                ProcessesToUpdate::Some(&[self_pid]),
                false,
                ProcessRefreshKind::nothing().with_cpu().with_memory(),
            );
            let process_count = self.procs.lock().ok().map(|p| p.sys.processes().len()).filter(|n| *n > 0);

            // --- Disk & GPU engine (PDH), with sysinfo volume I/O as disk fallback
            let reading = pdh.as_mut().map(|p| p.sample()).unwrap_or_default();
            const PDH_DISK: &str = "PDH \\PhysicalDisk(_Total)";
            let (disk_read, disk_write, disk_active) = if pdh.as_ref().map(|p| p.has_disk()).unwrap_or(false) {
                let m = |v: Option<f64>, unit| match v {
                    Some(v) => Metric::val(v, unit, PDH_DISK),
                    None => Metric::warming(unit, PDH_DISK),
                };
                (
                    m(reading.disk_read_bps, "B/s"),
                    m(reading.disk_write_bps, "B/s"),
                    m(reading.disk_active_pct, "%").with_note("100 − % Idle Time, averaged over physical disks"),
                )
            } else {
                disks.refresh_specifics(true, DiskRefreshKind::nothing().with_io_usage());
                let (r, w) = disks.list().iter().fold((0u64, 0u64), |(r, w), d| {
                    let u = d.usage();
                    (r + u.read_bytes, w + u.written_bytes)
                });
                const SRC: &str = "Volume IOCTL_DISK_PERFORMANCE";
                (
                    Metric::val(r as f64 / dt, "B/s", SRC),
                    Metric::val(w as f64 / dt, "B/s", SRC),
                    Metric::na("%", SRC, "Disk active time requires PDH counters, which are unavailable"),
                )
            };

            // --- GPU
            let nvr = nv.as_ref().ok().and_then(|g| g.sample());
            let no_nv = nv.as_ref().err().map(|s| s.as_str()).unwrap_or("NVML returned no data");
            let gpu_util = match (&reading.gpu_util_pct, nvr.as_ref().and_then(|r| r.util_pct)) {
                (Some(v), _) => Metric::val(*v, "%", "PDH \\GPU Engine (busiest engine)"),
                (None, Some(v)) => Metric::val(v, "%", "NVML"),
                (None, None) if pdh.as_ref().map(|p| p.has_gpu()).unwrap_or(false) => {
                    Metric::val(0.0, "%", "PDH \\GPU Engine (busiest engine)")
                        .with_note("No GPU engine instances currently active")
                }
                _ => Metric::na("%", "PDH \\GPU Engine", "GPU engine counters require a WDDM 2.x driver"),
            };
            let nv_metric = |f: fn(&gpu::NvmlReading) -> Option<f64>, unit, what: &str| match nvr.as_ref() {
                Some(r) => Metric::opt(f(r), unit, "NVML", &format!("The driver does not report {what} for this GPU")),
                None => Metric::na(unit, "NVML", &format!("{what}: {no_nv} (vendor-specific; only NVIDIA is supported)")),
            };
            let gpu_temp = nv_metric(|r| r.temp_c, "°C", "temperature");
            let gpu_power = nv_metric(|r| r.power_w, "W", "power draw");
            let gpu_fan = nv_metric(|r| r.fan_pct, "%", "fan speed");
            let gpu_mem_used = nv_metric(|r| r.mem_used, "B", "memory usage");
            let gpu_mem_total = nv_metric(|r| r.mem_total, "B", "memory size");
            let gpu_throttle = match nvr.as_ref().and_then(|r| r.throttle.clone()) {
                Some(reasons) => Throttle { available: true, active: !reasons.is_empty(), reasons, source: "NVML", note: None },
                None => Throttle {
                    available: false,
                    active: false,
                    reasons: vec![],
                    source: "NVML",
                    note: Some("GPU clock-throttle reasons are not reported on this system".into()),
                },
            };

            // --- CPU temperature: Windows only exposes ACPI thermal zones via WMI,
            // which typically needs administrator rights and is not the CPU package sensor.
            if tick % 5 == 1 && thermal_zones > 0 {
                components.refresh(false);
            }
            let zone = components.list().iter().filter_map(|c| c.temperature()).fold(None, |a: Option<f32>, t| {
                Some(a.map_or(t, |a| a.max(t)))
            });
            let cpu_temp = match zone {
                Some(t) => Metric::val(t as f64, "°C", "WMI MSAcpi_ThermalZoneTemperature")
                    .with_note("ACPI thermal zone (hottest); may differ from the CPU package sensor"),
                None => Metric::na(
                    "°C",
                    "WMI MSAcpi_ThermalZoneTemperature",
                    "Windows exposes no CPU temperature API to normal processes; ACPI thermal zones were not readable (often requires administrator rights or firmware support)",
                ),
            };

            let freq = sys.cpus().iter().map(|c| c.frequency()).max().unwrap_or(0);
            let me = sys.process(self_pid);
            let sample = Sample {
                ts: now_ms(),
                cpu: Metric::val(sys.global_cpu_usage() as f64, "%", "sysinfo"),
                cores: sys.cpus().iter().map(|c| c.cpu_usage() as f64).collect(),
                cpu_freq: if freq > 0 {
                    Metric::val(freq as f64, "MHz", "sysinfo")
                        .with_note("Windows reports the processor's current/nominal frequency; turbo boost may not be reflected")
                } else {
                    Metric::na("MHz", "sysinfo", "Processor frequency not reported")
                },
                cpu_temp,
                mem_used: Metric::val(sys.used_memory() as f64, "B", "sysinfo (GlobalMemoryStatusEx)"),
                mem_total: Metric::val(sys.total_memory() as f64, "B", "sysinfo (GlobalMemoryStatusEx)"),
                mem_available: Metric::val(sys.available_memory() as f64, "B", "sysinfo (GlobalMemoryStatusEx)"),
                swap_used: Metric::val(sys.used_swap() as f64, "B", "sysinfo (page file)"),
                swap_total: Metric::val(sys.total_swap() as f64, "B", "sysinfo (page file)"),
                disk_read,
                disk_write,
                disk_active,
                gpu_util,
                gpu_temp,
                gpu_power,
                gpu_fan,
                gpu_mem_used,
                gpu_mem_total,
                gpu_throttle,
                fan: Metric::na(
                    "RPM",
                    "—",
                    "Windows has no standard API for chassis/CPU fan speed; it requires vendor-specific embedded-controller drivers",
                ),
                app_cpu: me
                    .map(|p| Metric::val(p.cpu_usage() as f64 / ncpu, "%", "sysinfo"))
                    .unwrap_or_else(|| Metric::na("%", "sysinfo", "FlowDesk process not found")),
                app_mem: me
                    .map(|p| Metric::val(p.memory() as f64, "B", "sysinfo (working set)"))
                    .unwrap_or_else(|| Metric::na("B", "sysinfo", "FlowDesk process not found")),
                process_count,
            };

            let jobs = running_jobs();
            if !jobs.is_empty() {
                let _ = db.insert_samples(&jobs, sample.ts, &sample.rows());
            }
            {
                let mut h = self.history.lock().unwrap();
                if h.len() == HISTORY_CAP {
                    h.pop_front();
                }
                h.push_back(sample.clone());
            }
            self.last_ok.store(sample.ts as u64, Ordering::Relaxed);
            let _ = app.emit("telemetry://sample", &sample);
        }
    }
}
