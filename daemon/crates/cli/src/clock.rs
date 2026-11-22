//! Local wall-clock time for what a person reads: `ev3 status` and `ev3 telemetry --watch`.

use std::time::{SystemTime, UNIX_EPOCH};

/// A moment as the local calendar shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Local {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

impl Local {
    /// `22.11.2026 18:47:34`.
    pub fn date_time(self) -> String {
        format!(
            "{}.{}.{} {:02}:{:02}:{:02}",
            self.day, self.month, self.year, self.hour, self.minute, self.second
        )
    }

    /// `18:47:34`.
    pub fn time(self) -> String {
        format!("{:02}:{:02}:{:02}", self.hour, self.minute, self.second)
    }
}

/// Now, in milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// The UTC calendar of `ms` since the epoch (Howard Hinnant's civil-from-days).
pub fn utc(ms: i64) -> Local {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rest = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = (yoe + era * 400 + i64::from(month <= 2)) as i32;
    Local {
        year,
        month,
        day,
        hour: (rest / 3600) as u32,
        minute: ((rest % 3600) / 60) as u32,
        second: (rest % 60) as u32,
    }
}

/// The local calendar of `ms` since the epoch; UTC when the time zone cannot be read.
#[cfg(unix)]
pub fn local(ms: i64) -> Local {
    let secs: libc::time_t = ms.div_euclid(1000) as libc::time_t;
    // SAFETY: localtime_r writes only into the struct we pass.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&secs, &mut tm) }.is_null() {
        return utc(ms);
    }
    Local {
        year: tm.tm_year + 1900,
        month: (tm.tm_mon + 1) as u32,
        day: tm.tm_mday as u32,
        hour: tm.tm_hour as u32,
        minute: tm.tm_min as u32,
        second: tm.tm_sec as u32,
    }
}

/// The local calendar of `ms` since the epoch; UTC when the time zone cannot be read.
#[cfg(windows)]
pub fn local(ms: i64) -> Local {
    use windows_sys::Win32::Foundation::{FILETIME, SYSTEMTIME};
    use windows_sys::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime};
    // FILETIME counts 100 ns from 1601-01-01.
    let ticks = (ms + 11_644_473_600_000) as u64 * 10_000;
    let file = FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    };
    // SAFETY: plain conversions between locals.
    unsafe {
        let mut utc_time: SYSTEMTIME = std::mem::zeroed();
        let mut local_time: SYSTEMTIME = std::mem::zeroed();
        if FileTimeToSystemTime(&file, &mut utc_time) == 0
            || SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc_time, &mut local_time) == 0
        {
            return utc(ms);
        }
        Local {
            year: i32::from(local_time.wYear),
            month: u32::from(local_time.wMonth),
            day: u32::from(local_time.wDay),
            hour: u32::from(local_time.wHour),
            minute: u32::from(local_time.wMinute),
            second: u32::from(local_time.wSecond),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_utc_calendar_matches_known_moments() {
        assert_eq!(utc(0).date_time(), "1.1.1970 00:00:00");
        assert_eq!(utc(1_795_369_654_062).date_time(), "22.11.2026 17:47:34");
        assert_eq!(utc(951_782_400_000).date_time(), "29.2.2000 00:00:00");
    }

    #[test]
    fn local_time_differs_from_utc_by_whole_quarter_hours_at_most_a_day() {
        let ms = 1_795_369_654_062;
        let (l, u) = (local(ms), utc(ms));
        assert_eq!((l.minute % 15, l.second), (u.minute % 15, u.second));
    }
}
