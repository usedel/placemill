//! Level-filtered stdout logging with redaction (R-36b).
//!
//! Every module used to call `println!("[Placemill] ...")` directly. Two things
//! went wrong with that:
//!
//! - the `log_level` setting (`silent` / `normal` / `verbose`) only ever applied
//!   to the injected script. Rust ignored it, so "silent" still printed a line
//!   per stored batch to the console;
//! - paths and place ids were printed verbatim. `database path: "C:\Users\<name>
//!   \..."` ends up in a log file the user may hand to someone else, and a place
//!   id identifies a specific business.
//!
//! The format is deliberately unchanged (`[Placemill] message`, one line), because
//! the e2e harness and the troubleshooting workflow read that prefix. Only
//! non-info levels get a short tag, and `info` stays byte-identical to the old
//! `println!`.

use std::sync::atomic::{AtomicU8, Ordering};

/// Severity of one log line, ordered from most to least important.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    /// Failures the user may have to act on. Survives `silent`.
    Error = 0,
    /// Degraded but recoverable.
    Warn = 1,
    /// Lifecycle and command-level facts. The default.
    Info = 2,
    /// Per-batch / per-request detail. `verbose` only.
    Debug = 3,
}

/// Current threshold; everything above it is dropped. Defaults to `normal`.
static THRESHOLD: AtomicU8 = AtomicU8::new(Level::Info as u8);

/// Apply the `log_level` setting (`silent` | `normal` | `verbose`).
///
/// Called at startup and after `update_settings`/`reset_settings`, so a change
/// in the drawer takes effect on the next line rather than on the next launch.
pub fn set_level(name: &str) {
    THRESHOLD.store(level_for(name) as u8, Ordering::Relaxed);
}

/// Map the stored setting onto a threshold. Unknown values mean `normal`,
/// matching `Settings::normalize_with_report`, which already rejects them.
fn level_for(name: &str) -> Level {
    match name {
        "silent" => Level::Error,
        "verbose" => Level::Debug,
        _ => Level::Info,
    }
}

/// Whether `level` passes a `threshold`. Pure, so the tests do not have to
/// mutate the global the other tests are reading.
fn allows(threshold: Level, level: Level) -> bool {
    level <= threshold
}

/// Current threshold.
pub fn threshold() -> Level {
    match THRESHOLD.load(Ordering::Relaxed) {
        0 => Level::Error,
        1 => Level::Warn,
        2 => Level::Info,
        _ => Level::Debug,
    }
}

/// Whether a line at `level` would be printed.
pub fn enabled(level: Level) -> bool {
    allows(threshold(), level)
}

/// Emit one line. Prefer the `log_*!` macros below.
pub fn record(level: Level, args: std::fmt::Arguments<'_>) {
    if !enabled(level) {
        return;
    }
    match level {
        Level::Error => println!("[Placemill] ERROR {}", args),
        Level::Warn => println!("[Placemill] WARN  {}", args),
        Level::Info => println!("[Placemill] {}", args),
        Level::Debug => println!("[Placemill] DBG   {}", args),
    }
}

/// Mask the user's home directory segment in a path.
///
/// `C:\Users\alice\AppData\...` and `/home/alice/...` both become
/// `...\Users\***\...`, which still shows where the file is without naming the
/// account. Anything else is returned unchanged.
pub fn redact_path(value: &str) -> String {
    // P3-8: Windows paths are case-insensitive; a lowercase `c:\users\…`
    // used to leave the account name in the log.
    let lower = value.to_ascii_lowercase();
    for marker in ["\\users\\", "/users/", "/home/"] {
        if let Some(start) = lower.find(marker) {
            let rest_start = start + marker.len();
            let rest = &value[rest_start..];
            let end = rest
                .find(['\\', '/'])
                .map(|offset| rest_start + offset)
                .unwrap_or(value.len());
            let mut masked = String::with_capacity(value.len());
            masked.push_str(&value[..rest_start]);
            masked.push_str("***");
            masked.push_str(&value[end..]);
            return masked;
        }
    }
    value.to_string()
}

/// Shorten a place id to a stable prefix: enough to correlate log lines, not
/// enough to identify the business on its own.
pub fn redact_place_id(value: &str) -> String {
    const KEEP: usize = 8;
    if value.chars().count() <= KEEP {
        return "***".to_string();
    }
    let mut out: String = value.chars().take(KEEP).collect();
    out.push('…');
    out
}

/// Mask an email address: `alice@example.com` → `a***@example.com`.
///
/// Production since G-04: the verification run logs a failing address this way
/// when it needs to be correlated with a domain, and a full address in a log
/// file the user may hand to someone else is a leak.
pub fn redact_email(value: &str) -> String {
    match value.split_once('@') {
        Some((local, domain)) if !local.is_empty() => {
            let first = local.chars().next().unwrap_or('*');
            format!("{}***@{}", first, domain)
        }
        _ => "***".to_string(),
    }
}

/// Mask a phone number, keeping the last four digits.
#[cfg(test)]
pub fn redact_phone(value: &str) -> String {
    let digits: String = value.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() <= 4 {
        return "***".to_string();
    }
    let tail = &digits[digits.len() - 4..];
    format!("***{}", tail)
}

macro_rules! log_error {
    ($($arg:tt)*) => {
        $crate::logging::record($crate::logging::Level::Error, format_args!($($arg)*))
    };
}

macro_rules! log_warn {
    ($($arg:tt)*) => {
        $crate::logging::record($crate::logging::Level::Warn, format_args!($($arg)*))
    };
}

macro_rules! log_info {
    ($($arg:tt)*) => {
        $crate::logging::record($crate::logging::Level::Info, format_args!($($arg)*))
    };
}

macro_rules! log_debug {
    ($($arg:tt)*) => {
        $crate::logging::record($crate::logging::Level::Debug, format_args!($($arg)*))
    };
}

pub(crate) use {log_debug, log_error, log_info, log_warn};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silent_keeps_only_errors() {
        let threshold = level_for("silent");
        assert!(allows(threshold, Level::Error));
        assert!(!allows(threshold, Level::Warn));
        assert!(!allows(threshold, Level::Info));
        assert!(!allows(threshold, Level::Debug));
    }

    #[test]
    fn normal_keeps_warnings_and_info_but_not_debug() {
        let threshold = level_for("normal");
        assert!(allows(threshold, Level::Error));
        assert!(allows(threshold, Level::Warn));
        assert!(allows(threshold, Level::Info));
        assert!(!allows(threshold, Level::Debug));
    }

    #[test]
    fn verbose_enables_everything() {
        let threshold = level_for("verbose");
        assert!(allows(threshold, Level::Error));
        assert!(allows(threshold, Level::Debug));
    }

    #[test]
    fn an_unknown_level_falls_back_to_normal() {
        assert_eq!(level_for("loud"), Level::Info);
        assert_eq!(level_for(""), Level::Info);
    }

    #[test]
    fn redact_path_hides_the_account_segment() {
        assert_eq!(
            redact_path(r"C:\Users\alice\AppData\Roaming\com.placemill.app\placemill.db"),
            r"C:\Users\***\AppData\Roaming\com.placemill.app\placemill.db"
        );
        assert_eq!(
            redact_path("/home/alice/.local/share/placemill.db"),
            "/home/***/.local/share/placemill.db"
        );
        assert_eq!(
            redact_path(r"c:\users\alice\placemill.db"),
            r"c:\users\***\placemill.db",
            "Windows paths are case-insensitive (P3-8)"
        );
        assert_eq!(redact_path("relative/path.db"), "relative/path.db");
    }

    #[test]
    fn redact_place_id_keeps_only_a_prefix() {
        assert_eq!(redact_place_id("ChIJN1t_tDeuEmsRUsoyG83frY4"), "ChIJN1t_…");
        assert_eq!(redact_place_id("short"), "***");
    }

    #[test]
    fn redact_email_keeps_the_domain() {
        assert_eq!(redact_email("alice@example.com"), "a***@example.com");
        assert_eq!(redact_email("not-an-address"), "***");
    }

    #[test]
    fn redact_phone_keeps_the_last_four_digits() {
        assert_eq!(redact_phone("+1 (415) 555-0123"), "***0123");
        assert_eq!(redact_phone("12"), "***");
    }
}
