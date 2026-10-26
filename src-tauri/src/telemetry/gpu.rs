//! NVIDIA sensors via NVML (nvml.dll ships with the NVIDIA driver and is loaded
//! at runtime — systems without it simply report the sensors as unavailable).

use nvml_wrapper::bitmasks::device::ThrottleReasons;
use nvml_wrapper::enum_wrappers::device::TemperatureSensor;
use nvml_wrapper::Nvml;

pub struct NvmlReading {
    pub util_pct: Option<f64>,
    pub temp_c: Option<f64>,
    pub power_w: Option<f64>,
    pub fan_pct: Option<f64>,
    pub mem_used: Option<f64>,
    pub mem_total: Option<f64>,
    /// None when the driver does not report throttle reasons.
    pub throttle: Option<Vec<&'static str>>,
}

pub struct NvGpu {
    nvml: Nvml,
    pub name: String,
}

impl NvGpu {
    pub fn new() -> Result<Self, String> {
        let nvml = Nvml::init().map_err(|e| format!("NVML unavailable: {e}"))?;
        let count = nvml.device_count().map_err(|e| e.to_string())?;
        if count == 0 {
            return Err("NVML reports no NVIDIA devices".into());
        }
        let name = nvml.device_by_index(0).and_then(|d| d.name()).unwrap_or_else(|_| "NVIDIA GPU".into());
        Ok(NvGpu { nvml, name })
    }

    pub fn sample(&self) -> Option<NvmlReading> {
        let d = self.nvml.device_by_index(0).ok()?;
        let mem = d.memory_info().ok();
        let throttle = d.current_throttle_reasons().ok().map(|r| {
            let mut v = Vec::new();
            if r.contains(ThrottleReasons::SW_THERMAL_SLOWDOWN) || r.contains(ThrottleReasons::HW_THERMAL_SLOWDOWN) {
                v.push("thermal");
            }
            if r.contains(ThrottleReasons::SW_POWER_CAP) || r.contains(ThrottleReasons::HW_POWER_BRAKE_SLOWDOWN) {
                v.push("power cap");
            }
            if r.contains(ThrottleReasons::HW_SLOWDOWN) {
                v.push("hardware slowdown");
            }
            v
        });
        Some(NvmlReading {
            util_pct: d.utilization_rates().ok().map(|u| u.gpu as f64),
            temp_c: d.temperature(TemperatureSensor::Gpu).ok().map(|t| t as f64),
            power_w: d.power_usage().ok().map(|mw| mw as f64 / 1000.0),
            fan_pct: d.fan_speed(0).ok().map(|f| f as f64),
            mem_used: mem.as_ref().map(|m| m.used as f64),
            mem_total: mem.as_ref().map(|m| m.total as f64),
            throttle,
        })
    }
}
