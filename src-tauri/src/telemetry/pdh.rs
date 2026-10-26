//! Windows Performance Data Helper (PDH) counters for disk throughput, disk
//! active time and GPU engine utilisation.
//!
//! The query handle is not `Send`; create and use it on the telemetry thread.

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use windows::core::{w, PCWSTR};
    use windows::Win32::System::Performance::*;

    const PDH_MORE_DATA: u32 = 0x8000_07D2;

    pub struct Pdh {
        query: PDH_HQUERY,
        disk_read: Option<PDH_HCOUNTER>,
        disk_write: Option<PDH_HCOUNTER>,
        disk_idle: Option<PDH_HCOUNTER>,
        gpu_engine: Option<PDH_HCOUNTER>,
    }

    #[derive(Default)]
    pub struct PdhReading {
        pub disk_read_bps: Option<f64>,
        pub disk_write_bps: Option<f64>,
        pub disk_active_pct: Option<f64>,
        /// Busiest (adapter, engine type) pair, summed over processes — the same
        /// definition Task Manager uses for its headline GPU percentage.
        pub gpu_util_pct: Option<f64>,
    }

    impl Pdh {
        pub fn new() -> Option<Self> {
            let mut query = PDH_HQUERY::default();
            if unsafe { PdhOpenQueryW(PCWSTR::null(), 0, &mut query) } != 0 {
                return None;
            }
            let add = |path: PCWSTR| -> Option<PDH_HCOUNTER> {
                let mut c = PDH_HCOUNTER::default();
                (unsafe { PdhAddEnglishCounterW(query, path, 0, &mut c) } == 0).then_some(c)
            };
            let pdh = Pdh {
                query,
                disk_read: add(w!("\\PhysicalDisk(_Total)\\Disk Read Bytes/sec")),
                disk_write: add(w!("\\PhysicalDisk(_Total)\\Disk Write Bytes/sec")),
                disk_idle: add(w!("\\PhysicalDisk(_Total)\\% Idle Time")),
                gpu_engine: add(w!("\\GPU Engine(*)\\Utilization Percentage")),
            };
            // Rate counters need a baseline sample.
            unsafe { PdhCollectQueryData(query) };
            Some(pdh)
        }

        pub fn has_disk(&self) -> bool {
            self.disk_read.is_some() && self.disk_write.is_some()
        }
        pub fn has_gpu(&self) -> bool {
            self.gpu_engine.is_some()
        }

        fn single(c: Option<PDH_HCOUNTER>) -> Option<f64> {
            let c = c?;
            let mut v = PDH_FMT_COUNTERVALUE::default();
            let status = unsafe { PdhGetFormattedCounterValue(c, PDH_FMT_DOUBLE, None, &mut v) };
            if status != 0 || (v.CStatus != PDH_CSTATUS_VALID_DATA && v.CStatus != PDH_CSTATUS_NEW_DATA) {
                return None;
            }
            Some(unsafe { v.Anonymous.doubleValue })
        }

        fn gpu(&self) -> Option<f64> {
            let c = self.gpu_engine?;
            let mut size = 0u32;
            let mut count = 0u32;
            let st = unsafe { PdhGetFormattedCounterArrayW(c, PDH_FMT_DOUBLE, &mut size, &mut count, None) };
            if st != PDH_MORE_DATA || size == 0 {
                // No GPU engine instances (or no WDDM 2.x driver).
                return None;
            }
            let item = std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
            let mut buf: Vec<PDH_FMT_COUNTERVALUE_ITEM_W> = Vec::with_capacity(size as usize / item + 1);
            let st = unsafe {
                PdhGetFormattedCounterArrayW(c, PDH_FMT_DOUBLE, &mut size, &mut count, Some(buf.as_mut_ptr()))
            };
            if st != 0 {
                return None;
            }
            unsafe { buf.set_len(count as usize) };
            // Instance names look like: pid_1234_luid_0x00000000_0x0000C2F3_phys_0_eng_0_engtype_3D
            let mut per_engine: HashMap<String, f64> = HashMap::new();
            for it in &buf {
                if it.FmtValue.CStatus != PDH_CSTATUS_VALID_DATA && it.FmtValue.CStatus != PDH_CSTATUS_NEW_DATA {
                    continue;
                }
                let name = unsafe { it.szName.to_string() }.unwrap_or_default();
                let luid = name.split("_luid_").nth(1).and_then(|s| s.split("_phys").next()).unwrap_or("");
                let eng = name.split("_engtype_").nth(1).unwrap_or("");
                *per_engine.entry(format!("{luid}/{eng}")).or_default() += unsafe { it.FmtValue.Anonymous.doubleValue };
            }
            let max = per_engine.values().cloned().fold(0.0_f64, f64::max).min(100.0);
            Some(max)
        }

        pub fn sample(&mut self) -> PdhReading {
            if unsafe { PdhCollectQueryData(self.query) } != 0 {
                return PdhReading::default();
            }
            let gpu_util_pct = self.gpu();
            PdhReading {
                disk_read_bps: Self::single(self.disk_read),
                disk_write_bps: Self::single(self.disk_write),
                disk_active_pct: Self::single(self.disk_idle).map(|idle| (100.0 - idle).clamp(0.0, 100.0)),
                gpu_util_pct,
            }
        }
    }

    impl Drop for Pdh {
        fn drop(&mut self) {
            unsafe { PdhCloseQuery(self.query) };
        }
    }
}

#[cfg(not(windows))]
mod imp {
    #[derive(Default)]
    pub struct PdhReading {
        pub disk_read_bps: Option<f64>,
        pub disk_write_bps: Option<f64>,
        pub disk_active_pct: Option<f64>,
        pub gpu_util_pct: Option<f64>,
    }
    pub struct Pdh;
    impl Pdh {
        pub fn new() -> Option<Self> {
            None
        }
        pub fn has_disk(&self) -> bool {
            false
        }
        pub fn has_gpu(&self) -> bool {
            false
        }
        pub fn sample(&mut self) -> PdhReading {
            PdhReading::default()
        }
    }
}

pub use imp::*;
