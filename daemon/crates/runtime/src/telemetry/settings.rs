//! The telemetry settings a person can change, and the ranges that make a value usable.
//!
//! The values live in the daemon's settings, whose spec in the contract holds the defaults; the
//! defaults here are read from that spec, so a default cannot drift from what clients see.

use ev3_contract::{SettingScalar, setting_specs};

use super::error::TelemetryError;

/// How the read model decides a value is stale, and when it drops it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StaleSettings {
    /// A value is stale once it is this many of its own reading intervals old. 1 or more.
    pub stale_factor: f64,
    /// How long a stale value is kept, marked, before it is dropped, in milliseconds. 0 or more.
    pub stale_timeout_ms: f64,
}

/// How a brick's tick slows down when its round trips grow, and comes back.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ThrottleSettings {
    pub enabled: bool,
    /// Frames per window; the decision is taken at the end of each. 5 or more.
    pub window_size: u32,
    /// The window's p95 may reach this many of the link's usual round trips. 1 or more.
    pub tail_factor: f64,
    /// How much one step slows the tick, or speeds it back. More than 1.
    pub step: f64,
    /// The most the tick is slowed, as a multiple of the plan's. 1 or more.
    pub max_slowdown: f64,
    /// Windows in a row within the limit before the tick speeds up a step. 1 or more.
    pub calm_windows: u32,
}

/// How a running program slows its brick's telemetry.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProgramPresetSettings {
    /// While a program runs, the tick is at least this, in milliseconds; 0 turns it off.
    pub program_running_tick_ms: f64,
}

fn invalid(name: &str, rule: &str, value: impl std::fmt::Display) -> TelemetryError {
    TelemetryError::InvalidSetting(format!(
        "Telemetry setting {name} must be {rule}, not {value}."
    ))
}

fn at_least(name: &str, value: f64, min: f64) -> Result<(), TelemetryError> {
    if value.is_finite() && value >= min {
        Ok(())
    } else {
        Err(invalid(name, &format!("a number of at least {min}"), value))
    }
}

fn whole_at_least(name: &str, value: u32, min: u32) -> Result<(), TelemetryError> {
    if value >= min {
        Ok(())
    } else {
        Err(invalid(
            name,
            &format!("a whole number of at least {min}"),
            value,
        ))
    }
}

impl StaleSettings {
    pub fn check(&self) -> Result<(), TelemetryError> {
        at_least("staleFactor", self.stale_factor, 1.0)?;
        at_least("staleTimeoutMs", self.stale_timeout_ms, 0.0)
    }
}

impl ThrottleSettings {
    pub fn check(&self) -> Result<(), TelemetryError> {
        whole_at_least("windowSize", self.window_size, 5)?;
        at_least("tailFactor", self.tail_factor, 1.0)?;
        if !(self.step.is_finite() && self.step > 1.0) {
            return Err(invalid("step", "a number greater than 1", self.step));
        }
        at_least("maxSlowdown", self.max_slowdown, 1.0)?;
        whole_at_least("calmWindows", self.calm_windows, 1)
    }
}

impl ProgramPresetSettings {
    pub fn check(&self) -> Result<(), TelemetryError> {
        at_least("programRunningTickMs", self.program_running_tick_ms, 0.0)
    }
}

fn spec_default(key: &str) -> SettingScalar {
    setting_specs()
        .into_iter()
        .find(|spec| spec.key == key)
        .unwrap_or_else(|| panic!("the settings spec declares {key}"))
        .default
}

fn number(key: &str) -> f64 {
    match spec_default(key) {
        SettingScalar::Number(n) => n,
        other => panic!("the default of {key} is a number, not {other}"),
    }
}

fn whole(key: &str) -> u32 {
    let n = number(key);
    u32::try_from(n as i64).unwrap_or_else(|_| panic!("the default of {key} is a whole number"))
}

fn flag(key: &str) -> bool {
    match spec_default(key) {
        SettingScalar::Boolean(b) => b,
        other => panic!("the default of {key} is true or false, not {other}"),
    }
}

impl Default for StaleSettings {
    fn default() -> Self {
        Self {
            stale_factor: number("telemetry.staleFactor"),
            stale_timeout_ms: number("telemetry.staleTimeoutMs"),
        }
    }
}

impl Default for ThrottleSettings {
    fn default() -> Self {
        Self {
            enabled: flag("telemetry.throttle.enabled"),
            window_size: whole("telemetry.throttle.windowSize"),
            tail_factor: number("telemetry.throttle.tailFactor"),
            step: number("telemetry.throttle.step"),
            max_slowdown: number("telemetry.throttle.maxSlowdown"),
            calm_windows: whole("telemetry.throttle.calmWindows"),
        }
    }
}

impl Default for ProgramPresetSettings {
    fn default() -> Self {
        Self {
            program_running_tick_ms: number("telemetry.programRunningTickMs"),
        }
    }
}
