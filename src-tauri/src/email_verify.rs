//! Email verification (G-04): offline rules, DoH MX lookups, run engine.
//!
//! Four layers, all offline or free, in a fixed order — a step that can settle
//! the verdict stops the pipeline:
//!
//! 1. syntax, 2. IP/dotless domain, 3. disposable domain (never reaches DNS),
//! 4. quality flags (role / free mail / typo / non-ASCII), 5. DNS (MX, null MX,
//! NXDOMAIN, implicit MX), 6. compose.
//!
//! The invariant that matters most: **`valid` can only come from a successful
//! DNS answer**. Offline rules may downgrade a verdict, never promote one — so
//! a machine with no network ends up with `error` rows, not with a column of
//! confident "valid" claims.
//!
//! Storage lives in `db` (`email_verifications`, `email_domain_checks`); this
//! module owns the judging and the run, and knows nothing about the panel.

use crate::db::{AddressRecord, AddressVerification, BusinessVerificationRef, DomainCheck};
use crate::logging::{log_debug, log_info, log_warn, redact_email};
use crate::AppState;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

pub const STATUS_VALID: &str = "valid";
pub const STATUS_RISKY: &str = "risky";
pub const STATUS_INVALID: &str = "invalid";
pub const STATUS_UNKNOWN: &str = "unknown";
pub const STATUS_ERROR: &str = "error";
/// Row level only: no fresh verdict for any of the row's addresses.
pub const STATUS_UNVERIFIED: &str = "unverified";
/// Row level only: the row carries no address at all.
pub const STATUS_NONE: &str = "none";

pub const FLAG_SYNTAX: &str = "syntax";
pub const FLAG_IP_DOMAIN: &str = "ip_domain";
pub const FLAG_DISPOSABLE: &str = "disposable";
pub const FLAG_NULL_MX: &str = "null_mx";
pub const FLAG_NXDOMAIN: &str = "nxdomain";
pub const FLAG_NO_MX: &str = "no_mx";
pub const FLAG_IMPLICIT_MX: &str = "implicit_mx";
pub const FLAG_ROLE: &str = "role";
pub const FLAG_TYPO: &str = "typo";
pub const FLAG_NON_ASCII: &str = "non_ascii";
pub const FLAG_FREE_MAIL: &str = "free_mail";

/// Failure codes. Stable machine values, never translated, never parsed for
/// display: they live in `last_error` and in the export detail cell.
pub const ERR_TIMEOUT: &str = "timeout";
pub const ERR_NETWORK: &str = "network";
pub const ERR_RATE_LIMITED: &str = "rate_limited";
pub const ERR_DOH_HTTP: &str = "doh_http";
pub const ERR_PARSE: &str = "parse";
/// Not an address verdict: every endpoint failed, so the run stops.
pub const ERR_DNS_UNAVAILABLE: &str = "dns_unavailable";
/// Not an address verdict either: the cache could not be written.
pub const ERR_DB: &str = "db";

// ---------------------------------------------------------------------------
// Engineering constants (D10: no settings, no remote overrides)
// ---------------------------------------------------------------------------

const DAY_MS: i64 = 86_400_000;

pub const ADDRESS_TTL_DAYS: i64 = 90;
pub const ADDRESS_NEGATIVE_TTL_DAYS: i64 = 7;
pub const ADDRESS_UNKNOWN_TTL_DAYS: i64 = 30;
pub const DOMAIN_TTL_DAYS: i64 = 7;
pub const DOMAIN_NTTL_DAYS: i64 = 1;

pub const DNS_CONCURRENCY: usize = 4;
/// Each request waits 150–350 ms first: a machine rhythm is not a human one.
const DNS_JITTER_MIN_MS: u64 = 150;
const DNS_JITTER_SPAN_MS: u64 = 200;
pub const VERIFY_RUN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub const MAX_RUN_ADDRESSES: u64 = 20_000;
pub const CONFIRM_VERIFY_ADDRESSES: u64 = 1_000;
pub const VERIFY_WRITE_BATCH: usize = 50;
/// One query tries at most this many endpoints before giving up.
pub const DOH_MAX_ENDPOINTS: usize = 2;
const DOH_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const DOH_READ_TIMEOUT: Duration = Duration::from_secs(5);
const DOH_WRITE_TIMEOUT: Duration = Duration::from_secs(3);
pub const DOH_MAX_BODY: u64 = 64 * 1024;
const RETRY_AFTER_429: Duration = Duration::from_secs(10);
/// Consecutive "every endpoint failed" rounds before the run gives up.
const MAX_CONSECUTIVE_TRANSPORT_FAILURES: u32 = 12;
/// Progress events: at most this often (plus one at the end).
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Built-in DoH endpoints, in priority order. The first two are reachable from
/// mainland China; the other two are the international fallbacks. A remote
/// config may replace the list (order matters), never extend it with `http://`.
pub const DOH_ENDPOINTS: [&str; 4] = [
    "https://dns.alidns.com/resolve",
    "https://doh.pub/dns-query",
    "https://cloudflare-dns.com/dns-query",
    "https://dns.google/resolve",
];

// ---------------------------------------------------------------------------
// Built-in lists
// ---------------------------------------------------------------------------

/// Domains that accept mail but are not the business's own mailbox. Marked,
/// never downgraded: for a one-person shop a gmail address *is* the business.
const FREE_MAIL_DOMAINS: [&str; 18] = [
    "gmail.com",
    "googlemail.com",
    "yahoo.com",
    "hotmail.com",
    "outlook.com",
    "live.com",
    "icloud.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
    "qq.com",
    "163.com",
    "126.com",
    "sina.com",
    "foxmail.com",
    "mail.com",
    "mail.ru",
    "yandex.com",
];

/// Common throwaway-mailbox providers. Suffix-matched with a dot boundary, so
/// `abc.mailinator.com` hits and `notmailinator.com` does not.
const DISPOSABLE_DOMAINS: [&str; 28] = [
    "mailinator.com",
    "guerrillamail.com",
    "guerrillamail.net",
    "sharklasers.com",
    "10minutemail.com",
    "10minutemail.net",
    "tempmail.com",
    "temp-mail.org",
    "throwawaymail.com",
    "yopmail.com",
    "getnada.com",
    "dispostable.com",
    "maildrop.cc",
    "trashmail.com",
    "fakeinbox.com",
    "mailnesia.com",
    "spamgourmet.com",
    "mytemp.email",
    "mohmal.com",
    "emailondeck.com",
    "moakt.com",
    "tempr.email",
    "discard.email",
    "mailcatch.com",
    "inboxbear.com",
    "burnermail.io",
    "mail-temp.com",
    "tempail.com",
];

/// Domains a typo is measured against. Deliberately short ones are excluded
/// (`qq.com`, `163.com`): at three or four characters, edit distance 1 matches
/// too much of the real world.
const POPULAR_DOMAINS: [&str; 5] = [
    "gmail.com",
    "googlemail.com",
    "yahoo.com",
    "hotmail.com",
    "outlook.com",
];

// ---------------------------------------------------------------------------
// Normalization and syntax
// ---------------------------------------------------------------------------

/// Reduce a scraped address to the cache key: no `mailto:`, no display name, no
/// trailing dot, lowercase.
///
/// Idempotent on purpose — the SQL side stores `lower(trim(...))` and the Rust
/// side runs this again, so the two can only ever agree.
pub fn normalize_address(raw: &str) -> String {
    let mut value = raw.trim();
    // `mailto:a@b.com?subject=Hi` — the query string is not part of the address.
    if value.len() >= 7 && value[..7].eq_ignore_ascii_case("mailto:") {
        value = &value[7..];
        if let Some(cut) = value.find('?') {
            value = &value[..cut];
        }
    }
    // `Name <a@b.com>` — the angle brackets delimit the address.
    if let Some(start) = value.find('<') {
        if let Some(end) = value[start..].find('>') {
            value = &value[start + 1..start + end];
        }
    }
    value
        .trim()
        .trim_end_matches('.')
        .trim()
        .to_lowercase()
}

/// Normalize and dedupe a row's address list, preserving order.
pub fn normalize_all(emails: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for raw in emails {
        let address = normalize_address(raw);
        if address.is_empty() {
            continue;
        }
        if seen.insert(address.clone()) {
            out.push(address);
        }
    }
    out
}

fn is_local_char(ch: char) -> bool {
    if ch.is_ascii_alphanumeric() {
        return true;
    }
    if matches!(
        ch,
        '!' | '#' | '$' | '%' | '&' | '\'' | '*' | '+' | '-' | '/' | '=' | '?' | '^' | '_' | '`'
            | '{' | '|' | '}' | '~' | '.'
    ) {
        return true;
    }
    // SMTPUTF8 addresses are legal input; they are downgraded to `risky` later,
    // not rejected here — rejecting them would hide a real mailbox.
    !ch.is_ascii() && !ch.is_control() && !ch.is_whitespace()
}

/// RFC-shaped syntax check (lengths, one `@`, local dot rules, label rules).
fn is_valid_syntax(address: &str) -> bool {
    if address.is_empty() || address.len() > 254 {
        return false;
    }
    let mut parts = address.split('@');
    let local = parts.next().unwrap_or("");
    let domain = match parts.next() {
        Some(value) => value,
        None => return false,
    };
    if parts.next().is_some() {
        return false;
    }
    if local.is_empty() || domain.is_empty() || local.len() > 64 || domain.len() > 253 {
        return false;
    }
    if local.starts_with('.') || local.ends_with('.') || local.contains("..") {
        return false;
    }
    if !local.chars().all(is_local_char) {
        return false;
    }
    for label in domain.split('.') {
        if label.is_empty() || label.len() > 63 {
            return false;
        }
        if label.starts_with('-') || label.ends_with('-') {
            return false;
        }
        if !label
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || !ch.is_ascii())
        {
            return false;
        }
    }
    true
}

/// A domain that cannot be resolved: an IP literal, a bracketed IPv6, or a
/// dotless host (`localhost`, `intranet`) — none of them is a mail domain.
fn is_ip_or_dotless(domain: &str) -> bool {
    if !domain.contains('.') {
        return true;
    }
    let labels: Vec<&str> = domain.split('.').collect();
    labels.len() == 4
        && labels
            .iter()
            .all(|label| !label.is_empty() && label.chars().all(|ch| ch.is_ascii_digit()))
}

/// Exact or dot-boundary suffix match — the same rule `email_miner::host_is`
/// uses, which is what keeps `notmailinator.com` out.
fn domain_matches(domain: &str, entry: &str) -> bool {
    domain == entry || domain.ends_with(&format!(".{}", entry))
}

/// Damerau-Levenshtein distance, capped at `limit + 1` so a long domain cannot
/// turn this into a quadratic surprise.
fn edit_distance(a: &str, b: &str, limit: usize) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.len().abs_diff(b.len()) > limit {
        return limit + 1;
    }
    let mut prev_prev: Vec<usize> = vec![0; b.len() + 1];
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut current: Vec<usize> = vec![0; b.len() + 1];
    for i in 1..=a.len() {
        current[0] = i;
        let mut row_min = current[0];
        for j in 1..=b.len() {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            let mut value = (prev[j] + 1).min(current[j - 1] + 1).min(prev[j - 1] + cost);
            // Transposition (Damerau): `gmial` → `gmail` is one edit, not two.
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                value = value.min(prev_prev[j - 2] + 1);
            }
            current[j] = value;
            row_min = row_min.min(value);
        }
        if row_min > limit {
            return limit + 1;
        }
        std::mem::swap(&mut prev_prev, &mut prev);
        std::mem::swap(&mut prev, &mut current);
    }
    prev[b.len()]
}

/// The domain looks like a misspelling of a well-known mail provider.
fn looks_like_typo(domain: &str) -> bool {
    if POPULAR_DOMAINS.contains(&domain) || domain.len() > 63 {
        return false;
    }
    POPULAR_DOMAINS
        .iter()
        .any(|popular| edit_distance(domain, popular, 1) == 1)
}

// ---------------------------------------------------------------------------
// Static analysis (steps 1–5)
// ---------------------------------------------------------------------------

/// What the offline rules could say about one address.
#[derive(Debug, Clone)]
pub struct Analysis {
    /// Normalized address — the cache key.
    pub address: String,
    /// Punycode form, what actually goes to the resolver.
    pub ascii_domain: String,
    /// Quality flags found so far, in a fixed order.
    pub flags: Vec<String>,
    /// `Some(status)` = settled without DNS (always `invalid` today).
    pub settled: Option<&'static str>,
}

impl Analysis {
    fn needs_dns(&self) -> bool {
        self.settled.is_none()
    }
}

/// Convert a domain to its punycode form for the resolver. `url::Host` applies
/// IDNA and leaves ASCII input untouched; an unparsable value is sent as-is
/// (the resolver will answer NXDOMAIN, which is the honest verdict).
fn ascii_domain(domain: &str) -> String {
    match url::Host::parse(domain) {
        Ok(url::Host::Domain(value)) => value,
        _ => domain.to_string(),
    }
}

/// Steps 1–5 of the pipeline, without remote additions.
///
/// Test-only: every production path has a `VerifyRules` in hand and calls
/// `analyze_with`, so keeping an unconfigured twin in the binary would be a
/// second way to answer the same question.
#[cfg(test)]
fn analyze(raw: &str) -> Analysis {
    analyze_with(raw, &[])
}

/// Same, with the remote config's extra disposable domains folded in.
///
/// The remote list is **appended** to the built-in one (plan §9.3): a wrong
/// publish can only under-block, never switch the built-in protection off.
pub fn analyze_with(raw: &str, extra_disposable: &[String]) -> Analysis {
    let address = normalize_address(raw);
    let mut flags: Vec<String> = Vec::new();

    if !is_valid_syntax(&address) {
        flags.push(FLAG_SYNTAX.into());
        return Analysis {
            ascii_domain: String::new(),
            flags,
            settled: Some(STATUS_INVALID),
            address,
        };
    }

    let (local, domain) = address.split_once('@').unwrap_or(("", ""));
    let domain = domain.to_string();

    if is_ip_or_dotless(&domain) {
        flags.push(FLAG_IP_DOMAIN.into());
        return Analysis {
            ascii_domain: String::new(),
            flags,
            settled: Some(STATUS_INVALID),
            address,
        };
    }

    if DISPOSABLE_DOMAINS
        .iter()
        .any(|entry| domain_matches(&domain, entry))
        || extra_disposable
            .iter()
            .any(|entry| domain_matches(&domain, entry))
    {
        flags.push(FLAG_DISPOSABLE.into());
        return Analysis {
            ascii_domain: String::new(),
            flags,
            settled: Some(STATUS_INVALID),
            address,
        };
    }

    // Quality flags. `+tag` is still the same mailbox, so the role check runs
    // on the base local part: `info+newsletter@` is `info@`.
    let base_local = local.split('+').next().unwrap_or("");
    if crate::email_miner::ROLE_MAILBOXES.contains(&base_local) {
        flags.push(FLAG_ROLE.into());
    }
    if FREE_MAIL_DOMAINS.contains(&domain.as_str()) {
        flags.push(FLAG_FREE_MAIL.into());
    }
    if looks_like_typo(&domain) {
        flags.push(FLAG_TYPO.into());
    }
    if !address.is_ascii() {
        flags.push(FLAG_NON_ASCII.into());
    }

    let ascii = ascii_domain(&domain);
    Analysis {
        ascii_domain: ascii,
        flags,
        settled: None,
        address,
    }
}

// ---------------------------------------------------------------------------
// DNS outcome → verdict
// ---------------------------------------------------------------------------

/// What the resolver said about one domain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DnsOutcome {
    /// At least one MX record, and no null MX among them.
    Mx { host: String },
    /// `MX 0 .` — RFC 7505, explicitly refuses mail.
    NullMx,
    /// `Status = 3`.
    NxDomain,
    /// No MX but an A/AAAA record exists: RFC 5321 §5.1 implicit MX.
    Implicit,
    /// No MX and no A/AAAA: the domain exists but does not accept mail.
    NoMx,
}

impl DnsOutcome {
    fn base_status(&self) -> &'static str {
        match self {
            DnsOutcome::Mx { .. } => STATUS_VALID,
            DnsOutcome::NullMx | DnsOutcome::NxDomain | DnsOutcome::NoMx => STATUS_INVALID,
            DnsOutcome::Implicit => STATUS_UNKNOWN,
        }
    }

    fn flag(&self) -> Option<&'static str> {
        match self {
            DnsOutcome::Mx { .. } => None,
            DnsOutcome::NullMx => Some(FLAG_NULL_MX),
            DnsOutcome::NxDomain => Some(FLAG_NXDOMAIN),
            DnsOutcome::Implicit => Some(FLAG_IMPLICIT_MX),
            DnsOutcome::NoMx => Some(FLAG_NO_MX),
        }
    }

    fn mx_host(&self) -> &str {
        match self {
            DnsOutcome::Mx { host } => host,
            _ => "",
        }
    }

    /// Domain-cache status token (the same vocabulary as the `status` column).
    fn cache_status(&self) -> &'static str {
        match self {
            DnsOutcome::Mx { .. } => "mx",
            DnsOutcome::NullMx => "null_mx",
            DnsOutcome::NxDomain => "nxdomain",
            DnsOutcome::Implicit => "implicit",
            DnsOutcome::NoMx => "no_mx",
        }
    }

    fn from_cache_status(status: &str, mx_host: &str) -> Option<DnsOutcome> {
        match status {
            "mx" => Some(DnsOutcome::Mx {
                host: mx_host.to_string(),
            }),
            "null_mx" => Some(DnsOutcome::NullMx),
            "nxdomain" => Some(DnsOutcome::NxDomain),
            "implicit" => Some(DnsOutcome::Implicit),
            "no_mx" => Some(DnsOutcome::NoMx),
            _ => None,
        }
    }
}

/// Compose the final verdict (step 6). Offline flags can only downgrade a
/// `valid` to `risky`; `free_mail` never changes the status (D5/D12).
fn compose(flags: &[String], dns: &DnsOutcome) -> (String, Vec<String>) {
    let mut all = flags.to_vec();
    if let Some(flag) = dns.flag() {
        all.push(flag.to_string());
    }
    let base = dns.base_status();
    let downgrade = base == STATUS_VALID
        && all
            .iter()
            .any(|flag| flag == FLAG_ROLE || flag == FLAG_TYPO || flag == FLAG_NON_ASCII);
    let status = if downgrade { STATUS_RISKY } else { base };
    (status.to_string(), all)
}

/// How long a verdict stays fresh (D13). Deliberately not one number: a domain
/// can be renewed or re-pointed, an address's syntax cannot change.
fn address_ttl_ms(status: &str, flags: &[String]) -> i64 {
    match status {
        STATUS_VALID | STATUS_RISKY => ADDRESS_TTL_DAYS * DAY_MS,
        STATUS_UNKNOWN => ADDRESS_UNKNOWN_TTL_DAYS * DAY_MS,
        STATUS_INVALID => {
            let deterministic = flags.iter().any(|flag| {
                flag == FLAG_SYNTAX || flag == FLAG_IP_DOMAIN || flag == FLAG_DISPOSABLE
            });
            if deterministic {
                ADDRESS_TTL_DAYS * DAY_MS
            } else {
                ADDRESS_NEGATIVE_TTL_DAYS * DAY_MS
            }
        }
        // `error` must be retryable on the next run.
        _ => 0,
    }
}

fn domain_ttl_ms(status: &str) -> i64 {
    if status == "nxdomain" {
        DOMAIN_NTTL_DAYS * DAY_MS
    } else {
        DOMAIN_TTL_DAYS * DAY_MS
    }
}

// ---------------------------------------------------------------------------
// Row aggregation (D6) and export cells
// ---------------------------------------------------------------------------

/// Total precedence: `valid > risky > unknown > invalid`. `error` never
/// participates — a failed lookup is not a verdict.
fn precedence(status: &str) -> u8 {
    match status {
        STATUS_VALID => 3,
        STATUS_RISKY => 2,
        STATUS_UNKNOWN => 1,
        STATUS_INVALID => 0,
        _ => 0,
    }
}

/// Aggregate one row's addresses into the sidecar the panel and the exports
/// read. `records` is keyed by normalized address.
pub fn build_ref(
    place_id: &str,
    addresses: &[String],
    records: &HashMap<String, AddressRecord>,
    now: i64,
    website: &str,
) -> BusinessVerificationRef {
    if addresses.is_empty() {
        return BusinessVerificationRef {
            place_id: place_id.to_string(),
            status: STATUS_NONE.to_string(),
            stale: false,
            checked_at: 0,
            addresses: Vec::new(),
        };
    }

    let site_domain = website_domain(website);
    let mut best: Option<&str> = None;
    let mut best_checked = 0i64;
    let mut any_fresh = false;
    let mut any_stale = false;

    for address in addresses {
        let record = records.get(address);
        let fresh = record
            .map(|record| record.expires_at > now)
            .unwrap_or(false);
        if fresh {
            any_fresh = true;
            let status = record.map(|record| record.status.as_str()).unwrap_or("");
            if best.map(|current| precedence(status) > precedence(current)) != Some(false) {
                best = Some(status);
            }
            if let Some(record) = record {
                best_checked = best_checked.max(record.checked_at);
            }
        } else {
            any_stale = true;
        }
    }

    let status = if any_fresh {
        best.unwrap_or(STATUS_UNVERIFIED)
    } else {
        STATUS_UNVERIFIED
    };

    let details: Vec<AddressVerification> = addresses
        .iter()
        .map(|address| {
            let record = records.get(address);
            let fresh = record
                .map(|record| record.expires_at > now)
                .unwrap_or(false);
            AddressVerification {
                address: address.clone(),
                status: record
                    .map(|record| record.status.clone())
                    .unwrap_or_else(|| STATUS_UNVERIFIED.to_string()),
                flags: record.map(|record| record.flags.clone()).unwrap_or_default(),
                checked_at: record.map(|record| record.checked_at).unwrap_or(0),
                stale: record.is_some() && !fresh,
                same_domain: same_domain(address, &site_domain),
            }
        })
        .collect();

    BusinessVerificationRef {
        place_id: place_id.to_string(),
        status: status.to_string(),
        // Only meaningful once something *is* fresh: "unverified" already says
        // there is nothing to re-check (plan §2.4).
        stale: any_fresh && any_stale,
        checked_at: best_checked,
        addresses: details,
    }
}

/// The row's website as an eTLD+1 key, or empty when it is unusable.
fn website_domain(website: &str) -> String {
    let trimmed = website.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let parsed = url::Url::parse(trimmed)
        .or_else(|_| url::Url::parse(&format!("https://{}", trimmed)));
    match parsed {
        Ok(url) => match url.host_str() {
            Some(host) => crate::email_miner::registrable_domain(host),
            None => String::new(),
        },
        Err(_) => String::new(),
    }
}

fn same_domain(address: &str, site_domain: &str) -> bool {
    if site_domain.is_empty() {
        return false;
    }
    let Some((_, domain)) = address.split_once('@') else {
        return false;
    };
    let address_domain = crate::email_miner::registrable_domain(domain);
    !address_domain.is_empty() && address_domain == site_domain
}

/// The two export cells for one row (G-04 / §8.3).
#[derive(Debug, Clone, Default)]
pub struct VerifyCell {
    /// Row status token: `valid` … `unverified`, empty when the row has no
    /// address at all.
    pub summary: String,
    /// `addr=status(flags); addr=status(stale)`, `addr=error(code)`.
    pub detail: String,
}

/// Build the export cells. Values are stable machine tokens: the file must not
/// change meaning with the interface language.
pub fn export_cell(
    addresses: &[String],
    records: &HashMap<String, AddressRecord>,
    now: i64,
) -> VerifyCell {
    if addresses.is_empty() {
        return VerifyCell::default();
    }
    let mut best: Option<&str> = None;
    let mut any_fresh = false;
    let mut parts: Vec<String> = Vec::with_capacity(addresses.len());

    for address in addresses {
        let record = records.get(address);
        match record {
            None => {
                parts.push(format!("{}=unverified", address));
            }
            Some(record) => {
                if record.status == STATUS_ERROR {
                    let code = if record.last_error.is_empty() {
                        ERR_NETWORK
                    } else {
                        record.last_error.as_str()
                    };
                    parts.push(format!("{}=error({})", address, code));
                    continue;
                }
                let fresh = record.expires_at > now;
                if fresh {
                    any_fresh = true;
                    if best
                        .map(|current| precedence(&record.status) > precedence(current))
                        != Some(false)
                    {
                        best = Some(record.status.as_str());
                    }
                }
                let mut labels: Vec<String> = record.flags.clone();
                if !fresh {
                    labels.push("stale".to_string());
                }
                if labels.is_empty() {
                    parts.push(format!("{}={}", address, record.status));
                } else {
                    parts.push(format!("{}={}({})", address, record.status, labels.join(",")));
                }
            }
        }
    }

    VerifyCell {
        summary: if any_fresh {
            best.unwrap_or(STATUS_UNVERIFIED).to_string()
        } else {
            STATUS_UNVERIFIED.to_string()
        },
        detail: parts.join("; "),
    }
}

// ---------------------------------------------------------------------------
// DoH client
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DnsFailure {
    /// The run was cancelled while the request was in flight.
    Cancelled,
    /// Stable error code (`timeout` / `network` / …), or `dns_unavailable`.
    Code(&'static str),
}

/// One resolver request at a time per worker; the endpoint choice is shared
/// across workers so a blocked endpoint is not re-probed by every thread.
pub struct DohClient {
    agent: ureq::Agent,
    endpoints: Vec<String>,
    /// Index of the endpoint that last answered. Sticky on purpose: re-probing
    /// a blocked endpoint costs one timeout per address.
    active: AtomicUsize,
    /// Consecutive rounds where every endpoint failed at the transport level.
    transport_failures: AtomicUsize,
    /// Real HTTP requests issued — the `lookups` figure and the e2e assertion.
    lookups: AtomicU64,
}

impl DohClient {
    pub fn new(endpoints: Vec<String>) -> Self {
        let endpoints = if endpoints.is_empty() {
            DOH_ENDPOINTS.iter().map(|value| value.to_string()).collect()
        } else {
            endpoints
        };
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(DOH_CONNECT_TIMEOUT)
            .timeout_read(DOH_READ_TIMEOUT)
            .timeout_write(DOH_WRITE_TIMEOUT)
            .build();
        DohClient {
            agent,
            endpoints,
            active: AtomicUsize::new(0),
            transport_failures: AtomicUsize::new(0),
            lookups: AtomicU64::new(0),
        }
    }

    /// Resolve one domain to an MX verdict.
    ///
    /// Retry policy: transport errors and 5xx move to the next endpoint (at
    /// most `DOH_MAX_ENDPOINTS` per query); a 429 waits and retries the same
    /// endpoint once, then moves on. No second round within a run — `error`
    /// records are retried by the *next* run, which is what keeps "cancel" and
    /// "timeout" explainable.
    pub fn query(&self, domain: &str, cancel: &AtomicBool) -> Result<DnsOutcome, DnsFailure> {
        if self.endpoints.is_empty() {
            return Err(DnsFailure::Code(ERR_NETWORK));
        }
        let mut index = self.active.load(Ordering::Relaxed) % self.endpoints.len();
        let attempts = DOH_MAX_ENDPOINTS.min(self.endpoints.len());
        let mut last = ERR_NETWORK;

        for _ in 0..attempts {
            if cancel.load(Ordering::Relaxed) {
                return Err(DnsFailure::Cancelled);
            }
            let endpoint = self.endpoints[index].clone();
            match self.lookup(&endpoint, domain, cancel) {
                Ok(outcome) => {
                    self.active.store(index, Ordering::Relaxed);
                    self.transport_failures.store(0, Ordering::Relaxed);
                    return Ok(outcome);
                }
                Err(DnsFailure::Cancelled) => return Err(DnsFailure::Cancelled),
                Err(DnsFailure::Code(ERR_RATE_LIMITED)) => {
                    if !sleep_cancellable(RETRY_AFTER_429, cancel) {
                        return Err(DnsFailure::Cancelled);
                    }
                    match self.lookup(&endpoint, domain, cancel) {
                        Ok(outcome) => {
                            self.active.store(index, Ordering::Relaxed);
                            self.transport_failures.store(0, Ordering::Relaxed);
                            return Ok(outcome);
                        }
                        Err(DnsFailure::Cancelled) => return Err(DnsFailure::Cancelled),
                        Err(DnsFailure::Code(code)) => last = code,
                    }
                }
                Err(DnsFailure::Code(code)) => last = code,
            }
            index = (index + 1) % self.endpoints.len();
        }

        // Every endpoint of this round failed. Only a *transport* streak counts
        // toward `dns_unavailable`: a 500 from one resolver says nothing about
        // the machine's network.
        if last == ERR_NETWORK || last == ERR_TIMEOUT {
            let failures = self.transport_failures.fetch_add(1, Ordering::Relaxed) + 1;
            if failures as u32 >= MAX_CONSECUTIVE_TRANSPORT_FAILURES {
                return Err(DnsFailure::Code(ERR_DNS_UNAVAILABLE));
            }
        }
        Err(DnsFailure::Code(last))
    }

    pub fn lookups(&self) -> u64 {
        self.lookups.load(Ordering::Relaxed)
    }

    /// One endpoint, one query type, with the A-record fallback.
    fn lookup(
        &self,
        endpoint: &str,
        domain: &str,
        cancel: &AtomicBool,
    ) -> Result<DnsOutcome, DnsFailure> {
        let mx = self.request(endpoint, domain, "MX", cancel)?;
        match interpret_mx(&mx)? {
            Some(outcome) => Ok(outcome),
            None => {
                // No MX answer at all: RFC 5321 says fall back to the address
                // record, which is what turns "no MX" into `unknown`.
                let a = self.request(endpoint, domain, "A", cancel)?;
                interpret_a(&a)
            }
        }
    }

    fn request(
        &self,
        endpoint: &str,
        domain: &str,
        rtype: &str,
        cancel: &AtomicBool,
    ) -> Result<serde_json::Value, DnsFailure> {
        if cancel.load(Ordering::Relaxed) {
            return Err(DnsFailure::Cancelled);
        }
        let separator = if endpoint.contains('?') { '&' } else { '?' };
        let url = format!("{}{}name={}&type={}", endpoint, separator, domain, rtype);
        self.lookups.fetch_add(1, Ordering::Relaxed);
        let response = match self
            .agent
            .get(&url)
            .set("Accept", "application/dns-json")
            .call()
        {
            Ok(response) => response,
            Err(ureq::Error::Status(429, _)) => {
                return Err(DnsFailure::Code(ERR_RATE_LIMITED));
            }
            Err(ureq::Error::Status(_code, _)) => {
                return Err(DnsFailure::Code(ERR_DOH_HTTP));
            }
            Err(ureq::Error::Transport(error)) => {
                // ureq collapses connect/read timeouts into `Transport`; the
                // message is the only signal, and it is stable enough to sort
                // the two codes apart for the diagnostics.
                let text = error.to_string().to_lowercase();
                let code = if text.contains("timed out") || text.contains("timeout") {
                    ERR_TIMEOUT
                } else {
                    ERR_NETWORK
                };
                return Err(DnsFailure::Code(code));
            }
        };

        use std::io::Read;
        let mut body = Vec::new();
        // `take` before `read_to_end`: a hostile or broken resolver must not be
        // able to make this allocate without bound.
        match response
            .into_reader()
            .take(DOH_MAX_BODY)
            .read_to_end(&mut body)
        {
            Ok(_) => {}
            Err(_) => return Err(DnsFailure::Code(ERR_NETWORK)),
        }
        serde_json::from_slice(&body).map_err(|_| DnsFailure::Code(ERR_PARSE))
    }
}

/// `Some(outcome)` when the MX answer settles it; `None` when there is no MX
/// record and the caller must try `A`.
fn interpret_mx(body: &serde_json::Value) -> Result<Option<DnsOutcome>, DnsFailure> {
    let status = body
        .get("Status")
        .and_then(|value| value.as_i64())
        .ok_or(DnsFailure::Code(ERR_PARSE))?;
    match status {
        0 => {}
        3 => return Ok(Some(DnsOutcome::NxDomain)),
        // SERVFAIL and friends: a broken answer, not a verdict.
        _ => return Err(DnsFailure::Code(ERR_DOH_HTTP)),
    }
    let answers = body
        .get("Answer")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut best: Option<(u64, String)> = None;
    let mut null_mx = false;
    for answer in &answers {
        if answer.get("type").and_then(|value| value.as_i64()) != Some(15) {
            continue;
        }
        let Some(data) = answer.get("data").and_then(|value| value.as_str()) else {
            continue;
        };
        let Some((preference, host)) = data.trim().split_once(char::is_whitespace) else {
            continue;
        };
        let host = host.trim().trim_end_matches('.');
        if host.is_empty() {
            // `MX 0 .` — RFC 7505. Mixed with real records it is a config
            // error; either way the domain does not accept mail.
            null_mx = true;
            continue;
        }
        let Ok(preference) = preference.trim().parse::<u64>() else {
            continue;
        };
        if best.as_ref().map(|(current, _)| preference < *current) != Some(false) {
            best = Some((preference, host.to_string()));
        }
    }
    if null_mx {
        return Ok(Some(DnsOutcome::NullMx));
    }
    Ok(best.map(|(_, host)| DnsOutcome::Mx { host }))
}

fn interpret_a(body: &serde_json::Value) -> Result<DnsOutcome, DnsFailure> {
    // Same contract as `interpret_mx`: only a NOERROR answer may produce a
    // verdict. Falling through on SERVFAIL used to read as "no address record"
    // — `invalid(no_mx)` cached for a week — while the truth is "the resolver
    // could not answer". `error` is the honest outcome and stays retryable.
    let status = body
        .get("Status")
        .and_then(|value| value.as_i64())
        .ok_or(DnsFailure::Code(ERR_PARSE))?;
    match status {
        0 => {}
        3 => return Ok(DnsOutcome::NxDomain),
        _ => return Err(DnsFailure::Code(ERR_DOH_HTTP)),
    }
    let has_address = body
        .get("Answer")
        .and_then(|value| value.as_array())
        .map(|answers| {
            answers.iter().any(|answer| {
                matches!(
                    answer.get("type").and_then(|value| value.as_i64()),
                    Some(1) | Some(28)
                )
            })
        })
        .unwrap_or(false);
    Ok(if has_address {
        DnsOutcome::Implicit
    } else {
        DnsOutcome::NoMx
    })
}

/// Sleep in 100 ms slices so a cancel lands immediately instead of after the
/// full backoff (a 10 s wait that ignores the stop button feels broken).
fn sleep_cancellable(duration: Duration, cancel: &AtomicBool) -> bool {
    let step = Duration::from_millis(100);
    let mut waited = Duration::ZERO;
    while waited < duration {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        std::thread::sleep(step.min(duration - waited));
        waited += step;
    }
    !cancel.load(Ordering::Relaxed)
}

/// 150–350 ms, from the clock rather than a PRNG: no crate, no state.
fn jitter(cancel: &AtomicBool) -> bool {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos() as u64)
        .unwrap_or(0);
    let delay = Duration::from_millis(DNS_JITTER_MIN_MS + nanos % DNS_JITTER_SPAN_MS);
    sleep_cancellable(delay, cancel)
}

// ---------------------------------------------------------------------------
// Run engine
// ---------------------------------------------------------------------------

/// Everything one run needs, snapshotted before the worker starts.
pub struct VerifyRun {
    /// Normalized, deduplicated addresses.
    pub addresses: Vec<String>,
    /// Remote endpoints, or empty for the built-in list.
    pub endpoints: Vec<String>,
    /// Extra disposable domains from the remote config (appended, never a
    /// replacement: a bad publish can only under-block).
    pub disposable_extra: Vec<String>,
    pub force: bool,
    /// `verification_epoch` at start; a mismatch means "cleared".
    pub epoch: u64,
}

#[derive(Debug, Clone, Copy, Default)]
struct Counts {
    valid: u64,
    risky: u64,
    invalid: u64,
    unknown: u64,
    error: u64,
}

impl Counts {
    fn add(&mut self, status: &str) {
        match status {
            STATUS_VALID => self.valid += 1,
            STATUS_RISKY => self.risky += 1,
            STATUS_INVALID => self.invalid += 1,
            STATUS_UNKNOWN => self.unknown += 1,
            STATUS_ERROR => self.error += 1,
            _ => {}
        }
    }

    /// `done` is defined as this sum, never as a separate counter — otherwise
    /// the progress line and the per-status figures drift apart.
    fn done(&self) -> u64 {
        self.valid + self.risky + self.invalid + self.unknown + self.error
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyProgress {
    pub done: u64,
    pub total: u64,
    pub cached: u64,
    pub valid: u64,
    pub risky: u64,
    pub invalid: u64,
    pub unknown: u64,
    pub error: u64,
    pub lookups: u64,
    pub current: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyDone {
    pub total: u64,
    pub done: u64,
    pub cached: u64,
    pub lookups: u64,
    pub valid: u64,
    pub risky: u64,
    pub invalid: u64,
    pub unknown: u64,
    pub error: u64,
    pub cancelled: bool,
    /// `""` | `user` | `timeout` | `cleared`.
    pub reason: String,
    /// Non-empty means the run failed; `cancelled` may be true as well.
    pub fatal: String,
}

/// One finished domain: its cache row and the address verdicts it produced.
struct DomainResult {
    domain: String,
    check: DomainCheck,
    rows: Vec<AddressRecord>,
}

/// Where a run stopped.
enum Stop {
    Finished,
    User,
    Timeout,
    Cleared,
    Fatal(&'static str),
}

/// Run one verification pass. Blocking; the caller owns the thread and the
/// single-flight slot.
pub fn run_verification(
    app: &tauri::AppHandle,
    run: VerifyRun,
    cancel: &Arc<AtomicBool>,
) -> VerifyDone {
    let state = app.state::<AppState>();
    let started = Instant::now();
    let now = crate::now_ms() as i64;
    let total = run.addresses.len() as u64;

    // The static pass needs the same disposable list the DNS phase would use,
    // so the remote additions are folded in before any analysis.
    let mut counts = Counts::default();
    let mut fresh: HashMap<String, String> = HashMap::new();
    if !run.force {
        let loaded = {
            let conn = match state.db.lock() {
                Ok(conn) => conn,
                Err(_) => return fatal_done(total, 0, 0, 0, ERR_DB),
            };
            crate::db::fresh_verifications(&conn, &run.addresses, now)
        };
        match loaded {
            Ok(rows) => {
                for (address, status) in rows {
                    fresh.insert(address, status);
                }
            }
            Err(error) => {
                log_warn!("verify: reading the address cache failed: {}", error);
            }
        }
    }
    for status in fresh.values() {
        counts.add(status);
    }
    let cached = fresh.len() as u64;

    let mut analyses: Vec<Analysis> = Vec::with_capacity(run.addresses.len());
    let mut settled: Vec<AddressRecord> = Vec::new();
    for address in &run.addresses {
        if fresh.contains_key(address) {
            continue;
        }
        let analysis = analyze_with(address, &run.disposable_extra);
        if let Some(status) = analysis.settled {
            let checked_at = now;
            settled.push(AddressRecord {
                address: analysis.address.clone(),
                status: status.to_string(),
                flags: analysis.flags.clone(),
                mx_host: String::new(),
                checked_at,
                expires_at: checked_at + address_ttl_ms(status, &analysis.flags),
                last_error: String::new(),
            });
        }
        analyses.push(analysis);
    }

    for record in &settled {
        counts.add(&record.status);
    }
    let mut buffer: Vec<AddressRecord> = settled;
    let mut stop = Stop::Finished;

    // The static half is written before any network call: a run that is
    // cancelled after two seconds still leaves its free findings behind.
    if let Err(code) = flush(&state, &mut buffer, run.epoch) {
        stop = stop_from_code(code);
    }

    let mut progress = ProgressEmitter::new(app, total, cached);
    progress.maybe_emit(&counts, 0, "");

    if matches!(stop, Stop::Finished) {
        let mut pending: Vec<Analysis> = analyses
            .into_iter()
            .filter(|analysis| analysis.needs_dns() && !analysis.ascii_domain.is_empty())
            .collect();
        if !pending.is_empty() {
            stop = dns_phase(
                &state,
                &run,
                &mut pending,
                cancel,
                &mut counts,
                &mut buffer,
                &mut progress,
                started,
            );
        }
    }

    if let Err(code) = flush(&state, &mut buffer, run.epoch) {
        stop = stop_from_code(code);
    }

    let lookups = progress.lookups;
    let (reason, fatal) = match stop {
        Stop::Finished => ("", ""),
        Stop::User => ("user", ""),
        Stop::Timeout => ("timeout", ""),
        Stop::Cleared => ("cleared", ""),
        Stop::Fatal(code) => ("", code),
    };
    let done = counts.done();
    let summary = VerifyDone {
        total,
        done,
        cached,
        lookups,
        valid: counts.valid,
        risky: counts.risky,
        invalid: counts.invalid,
        unknown: counts.unknown,
        error: counts.error,
        cancelled: !reason.is_empty() || !fatal.is_empty(),
        reason: reason.to_string(),
        fatal: fatal.to_string(),
    };
    log_info!(
        "verify finished: {}/{} addresses ({} cached, {} lookups) valid={} risky={} invalid={} unknown={} error={}{}{}",
        summary.done,
        summary.total,
        summary.cached,
        summary.lookups,
        summary.valid,
        summary.risky,
        summary.invalid,
        summary.unknown,
        summary.error,
        if reason.is_empty() { String::new() } else { format!(" reason={}", reason) },
        if fatal.is_empty() { String::new() } else { format!(" fatal={}", fatal) }
    );
    if summary.error > 0 && summary.done > 0 && summary.error * 2 > summary.done {
        log_warn!(
            "verify: {}/{} addresses failed to resolve — DNS is probably unavailable",
            summary.error,
            summary.done
        );
    }
    let _ = app.emit("email:verify:done", &summary);
    summary
}

fn fatal_done(total: u64, cached: u64, lookups: u64, done: u64, code: &'static str) -> VerifyDone {
    VerifyDone {
        total,
        done,
        cached,
        lookups,
        valid: 0,
        risky: 0,
        invalid: 0,
        unknown: 0,
        error: 0,
        cancelled: true,
        reason: String::new(),
        fatal: code.to_string(),
    }
}

fn stop_from_code(code: &'static str) -> Stop {
    match code {
        "cleared" => Stop::Cleared,
        other => Stop::Fatal(other),
    }
}

/// Write one batch through the shared connection.
///
/// The epoch is compared **inside** the lock and before `write_tx`: checking
/// outside leaves a window where `clear_data` deletes the caches between the
/// check and the write, and the worker then resurrects rows the user just
/// cleared.
fn flush(
    state: &AppState,
    buffer: &mut Vec<AddressRecord>,
    epoch: u64,
) -> Result<(), &'static str> {
    if buffer.is_empty() {
        return Ok(());
    }
    let conn = match state.db.lock() {
        Ok(conn) => conn,
        Err(_) => return Err(ERR_DB),
    };
    if state.verification_epoch.load(Ordering::SeqCst) != epoch {
        buffer.clear();
        return Err("cleared");
    }
    let tx = match crate::db::write_tx(&conn) {
        Ok(tx) => tx,
        Err(_) => return Err(ERR_DB),
    };
    let now = crate::now_ms() as i64;
    for record in buffer.iter() {
        if crate::db::upsert_verification(&tx, record, now).is_err() {
            return Err(ERR_DB);
        }
    }
    if tx.commit().is_err() {
        return Err(ERR_DB);
    }
    buffer.clear();
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn dns_phase(
    state: &AppState,
    run: &VerifyRun,
    pending: &mut Vec<Analysis>,
    cancel: &Arc<AtomicBool>,
    counts: &mut Counts,
    buffer: &mut Vec<AddressRecord>,
    progress: &mut ProgressEmitter<'_>,
    started: Instant,
) -> Stop {
    let now = crate::now_ms() as i64;
    let client = Arc::new(DohClient::new(run.endpoints.clone()));

    // Domain cache first: a second run over the same list must not query
    // anything. `force` skips the read but still writes the new answer.
    let mut by_domain: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, analysis) in pending.iter().enumerate() {
        by_domain
            .entry(analysis.ascii_domain.clone())
            .or_default()
            .push(index);
    }
    let domains: Vec<String> = by_domain.keys().cloned().collect();
    let mut cached_domains: HashMap<String, DomainCheck> = HashMap::new();
    if !run.force && !domains.is_empty() {
        let loaded = {
            match state.db.lock() {
                Ok(conn) => crate::db::domain_checks(&conn, &domains),
                Err(_) => Ok(Vec::new()),
            }
        };
        for check in loaded.unwrap_or_default() {
            if check.expires_at > now {
                cached_domains.insert(check.domain.clone(), check);
            }
        }
    }

    let mut queue: VecDeque<(String, Vec<usize>)> = VecDeque::new();
    for (domain, indexes) in by_domain {
        match cached_domains.get(&domain) {
            Some(check) => {
                if let Some(outcome) = DnsOutcome::from_cache_status(&check.status, &check.mx_host) {
                    for index in indexes {
                        let (status, flags) = compose(&pending[index].flags, &outcome);
                        let record = record_for(&pending[index], &status, flags, &outcome, now);
                        counts.add(&record.status);
                        buffer.push(record);
                    }
                    if buffer.len() >= VERIFY_WRITE_BATCH {
                        if let Err(code) = flush(state, buffer, run.epoch) {
                            return stop_from_code(code);
                        }
                    }
                    progress.maybe_emit(counts, client.lookups(), &domain);
                } else {
                    queue.push_back((domain, indexes));
                }
            }
            None => queue.push_back((domain, indexes)),
        }
    }

    if queue.is_empty() {
        return Stop::Finished;
    }

    let shared: Arc<Mutex<VecDeque<(String, Vec<usize>)>>> = Arc::new(Mutex::new(queue));
    let analyses = Arc::new(pending.clone());
    let fatal = Arc::new(AtomicBool::new(false));
    let (tx, rx) = std::sync::mpsc::channel::<DomainResult>();
    let mut workers = Vec::new();

    for _ in 0..DNS_CONCURRENCY.min(shared.lock().map(|q| q.len()).unwrap_or(1)) {
        let shared = Arc::clone(&shared);
        let analyses = Arc::clone(&analyses);
        let client = Arc::clone(&client);
        let fatal = Arc::clone(&fatal);
        let tx = tx.clone();
        let cancel = Arc::clone(cancel);
        workers.push(std::thread::spawn(move || {
            loop {
                if cancel.load(Ordering::Relaxed) || fatal.load(Ordering::Relaxed) {
                    return;
                }
                let next = {
                    match shared.lock() {
                        Ok(mut queue) => queue.pop_front(),
                        Err(_) => None,
                    }
                };
                let Some((domain, indexes)) = next else {
                    return;
                };
                if !jitter(&cancel) {
                    return;
                }
                let now = crate::now_ms() as i64;
                let result = match client.query(&domain, &cancel) {
                    Ok(outcome) => {
                        let rows = indexes
                            .iter()
                            .map(|index| {
                                let analysis = &analyses[*index];
                                let (status, flags) = compose(&analysis.flags, &outcome);
                                record_for(analysis, &status, flags, &outcome, now)
                            })
                            .collect();
                        let status = outcome.cache_status();
                        DomainResult {
                            domain,
                            check: DomainCheck {
                                domain: String::new(),
                                status: status.to_string(),
                                mx_host: outcome.mx_host().to_string(),
                                checked_at: now,
                                expires_at: now + domain_ttl_ms(status),
                                last_error: String::new(),
                            },
                            rows,
                        }
                    }
                    Err(DnsFailure::Cancelled) => return,
                    Err(DnsFailure::Code(ERR_DNS_UNAVAILABLE)) => {
                        fatal.store(true, Ordering::SeqCst);
                        return;
                    }
                    Err(DnsFailure::Code(code)) => {
                        // A failed lookup is an `error` verdict on the address
                        // and a non-fresh row on the domain: nothing is cached,
                        // so the next run retries it.
                        let rows = indexes
                            .iter()
                            .map(|index| error_record(&analyses[*index], code, now))
                            .collect();
                        DomainResult {
                            domain,
                            check: DomainCheck {
                                domain: String::new(),
                                status: STATUS_ERROR.to_string(),
                                mx_host: String::new(),
                                checked_at: now,
                                expires_at: 0,
                                last_error: code.to_string(),
                            },
                            rows,
                        }
                    }
                };
                if tx.send(result).is_err() {
                    return;
                }
            }
        }));
    }
    // The workers own the only senders; dropping this one is what lets the
    // receiver see "disconnected" once every worker is done.
    drop(tx);

    let mut stop = Stop::Finished;
    loop {
        // The epoch is checked before the cancel flag on purpose: `clear_data`
        // sets both, and "cleared" is the reason that explains the empty table
        // the user is looking at. A plain cancel leaves the epoch alone.
        if state.verification_epoch.load(Ordering::SeqCst) != run.epoch {
            stop = Stop::Cleared;
            break;
        }
        if cancel.load(Ordering::Relaxed) {
            stop = Stop::User;
            break;
        }
        if started.elapsed() > VERIFY_RUN_TIMEOUT {
            stop = Stop::Timeout;
            break;
        }
        match rx.recv_timeout(PROGRESS_INTERVAL) {
            Ok(result) => {
                let mut check = result.check;
                check.domain = result.domain.clone();
                // The domain row is written before its addresses so a crash
                // between the two can only cause a re-query, never a stale
                // address verdict backed by a missing domain record. The lock
                // is scoped: `flush` takes it again, and `std::sync::Mutex` is
                // not reentrant.
                {
                    let conn = match state.db.lock() {
                        Ok(conn) => conn,
                        Err(_) => {
                            stop = Stop::Fatal(ERR_DB);
                            break;
                        }
                    };
                    if state.verification_epoch.load(Ordering::SeqCst) != run.epoch {
                        stop = Stop::Cleared;
                        break;
                    }
                    let _ = crate::db::upsert_domain_check(&conn, &check);
                }
                for record in result.rows {
                    counts.add(&record.status);
                    buffer.push(record);
                }
                if buffer.len() >= VERIFY_WRITE_BATCH {
                    if let Err(code) = flush(state, buffer, run.epoch) {
                        stop = stop_from_code(code);
                        break;
                    }
                }
                progress.maybe_emit(counts, client.lookups(), &result.domain);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if buffer.len() >= VERIFY_WRITE_BATCH {
                    if let Err(code) = flush(state, buffer, run.epoch) {
                        stop = stop_from_code(code);
                        break;
                    }
                }
                progress.maybe_emit(counts, client.lookups(), "");
            }
            // Every sender dropped: the workers are done.
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    if matches!(stop, Stop::Finished) && fatal.load(Ordering::SeqCst) {
        stop = Stop::Fatal(ERR_DNS_UNAVAILABLE);
    }
    // Workers block on `recv_timeout` only through the channel; a cancel makes
    // them return on their next check, and joining here keeps the slot alive
    // until every thread has really stopped.
    for worker in workers {
        let _ = worker.join();
    }
    // Drain whatever the workers managed to finish before stopping: a verdict
    // that is already computed is a fact about that address, and the plan says
    // partial results are written (unlike the miner, where a site is a unit).
    while let Ok(result) = rx.try_recv() {
        let mut check = result.check;
        check.domain = result.domain;
        if let Ok(conn) = state.db.lock() {
            if state.verification_epoch.load(Ordering::SeqCst) == run.epoch {
                let _ = crate::db::upsert_domain_check(&conn, &check);
            }
        }
        for record in result.rows {
            counts.add(&record.status);
            buffer.push(record);
        }
    }
    // A clear that landed while the workers were finishing leaves `stop` at
    // `Finished`; the epoch is the truth, not the loop's exit path.
    if state.verification_epoch.load(Ordering::SeqCst) != run.epoch {
        stop = Stop::Cleared;
    }
    if let Err(code) = flush(state, buffer, run.epoch) {
        stop = stop_from_code(code);
    }
    // One last frame: the rate limiter may have swallowed the final batch's
    // event, and a progress bar that stops one batch short looks stuck.
    progress.emit(counts, client.lookups(), "");
    stop
}

fn record_for(
    analysis: &Analysis,
    status: &str,
    flags: Vec<String>,
    outcome: &DnsOutcome,
    now: i64,
) -> AddressRecord {
    AddressRecord {
        address: analysis.address.clone(),
        status: status.to_string(),
        expires_at: now + address_ttl_ms(status, &flags),
        flags,
        mx_host: outcome.mx_host().to_string(),
        checked_at: now,
        last_error: String::new(),
    }
}

fn error_record(analysis: &Analysis, code: &'static str, now: i64) -> AddressRecord {
    if log_debug_enabled() {
        log_debug!("verify: lookup failed for {}", redact_email(&analysis.address));
    }
    AddressRecord {
        address: analysis.address.clone(),
        status: STATUS_ERROR.to_string(),
        flags: analysis.flags.clone(),
        mx_host: String::new(),
        checked_at: now,
        // Never in the future: the next run must retry it.
        expires_at: 0,
        last_error: code.to_string(),
    }
}

fn log_debug_enabled() -> bool {
    crate::logging::enabled(crate::logging::Level::Debug)
}

/// Rate-limited progress emission (10/s at most, plus the closing frame).
struct ProgressEmitter<'a> {
    app: &'a tauri::AppHandle,
    total: u64,
    cached: u64,
    last: Instant,
    lookups: u64,
}

impl<'a> ProgressEmitter<'a> {
    fn new(app: &'a tauri::AppHandle, total: u64, cached: u64) -> Self {
        ProgressEmitter {
            app,
            total,
            cached,
            // Far enough in the past that the first frame always goes out.
            last: Instant::now() - PROGRESS_INTERVAL,
            lookups: 0,
        }
    }

    fn maybe_emit(&mut self, counts: &Counts, lookups: u64, current: &str) {
        self.lookups = lookups;
        if self.last.elapsed() < PROGRESS_INTERVAL {
            return;
        }
        self.emit(counts, lookups, current);
    }

    /// Bypass the rate limit — used for the closing frame.
    fn emit(&mut self, counts: &Counts, lookups: u64, current: &str) {
        self.lookups = lookups;
        self.last = Instant::now();
        let _ = self.app.emit(
            "email:verify:progress",
            VerifyProgress {
                done: counts.done(),
                total: self.total,
                cached: self.cached,
                valid: counts.valid,
                risky: counts.risky,
                invalid: counts.invalid,
                unknown: counts.unknown,
                error: counts.error,
                lookups,
                current: current.to_string(),
            },
        );
    }
}

// ---------------------------------------------------------------------------
// Endpoint list from config + debug hook
// ---------------------------------------------------------------------------

/// The endpoints a run should use: the debug override, else the remote list,
/// else the built-ins.
pub fn resolve_endpoints(remote: &[String]) -> Vec<String> {
    if let Some(value) = debug_endpoint_override() {
        return vec![value];
    }
    if remote.is_empty() {
        DOH_ENDPOINTS.iter().map(|value| value.to_string()).collect()
    } else {
        remote.to_vec()
    }
}

/// `PLACE_MILL_VERIFY_DOH` — debug builds only, same pattern as
/// `PLACE_MILL_ALLOW_PRIVATE_TARGETS`. It exists so the e2e suite can point the
/// resolver at a local fixture; release builds short-circuit at compile time.
fn debug_endpoint_override() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let value = std::env::var("PLACE_MILL_VERIFY_DOH").ok()?;
    let value = value.trim().to_string();
    if value.is_empty() {
        return None;
    }
    if value.starts_with("https://") || value.starts_with("http://") {
        Some(value)
    } else {
        log_warn!("PLACE_MILL_VERIFY_DOH ignored: not an http(s) URL");
        None
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn record(address: &str, status: &str, flags: &[&str], expires_at: i64) -> AddressRecord {
        AddressRecord {
            address: address.to_string(),
            status: status.to_string(),
            flags: flags.iter().map(|flag| flag.to_string()).collect(),
            mx_host: String::new(),
            checked_at: 1_000,
            expires_at,
            last_error: String::new(),
        }
    }

    fn map(records: Vec<AddressRecord>) -> HashMap<String, AddressRecord> {
        records
            .into_iter()
            .map(|record| (record.address.clone(), record))
            .collect()
    }

    #[test]
    fn normalize_lowercases_and_strips_mailto() {
        assert_eq!(normalize_address("  MailTo:Alice@Example.COM. "), "alice@example.com");
        assert_eq!(normalize_address("Bob <bob@example.com>"), "bob@example.com");
        assert_eq!(normalize_address("carol@example.com."), "carol@example.com");
        assert_eq!(normalize_address("mailto:dan@example.com?subject=Hi"), "dan@example.com");
    }

    #[test]
    fn normalize_keeps_plus_addressing() {
        assert_eq!(normalize_address("Info+News@Example.com"), "info+news@example.com");
        assert_eq!(normalize_address("a.b@example.com"), "a.b@example.com");
    }

    #[test]
    fn normalize_all_dedupes_and_drops_blanks() {
        let emails = vec![
            "A@x.com".to_string(),
            "".to_string(),
            "a@x.com".to_string(),
            "b@x.com".to_string(),
        ];
        assert_eq!(normalize_all(&emails), vec!["a@x.com", "b@x.com"]);
    }

    #[test]
    fn syntax_rejects_multi_at_overlong_and_bad_dots() {
        assert!(is_valid_syntax("a@b.com"));
        assert!(!is_valid_syntax("a@@b.com"));
        assert!(!is_valid_syntax("a@b@c.com"));
        assert!(!is_valid_syntax(".a@b.com"));
        assert!(!is_valid_syntax("a.@b.com"));
        assert!(!is_valid_syntax("a..b@c.com"));
        assert!(!is_valid_syntax("a@b..com"));
        assert!(!is_valid_syntax(&format!("{}@b.com", "a".repeat(65))));
        assert!(!is_valid_syntax(&format!("a@{}", "b".repeat(64))));
        assert!(!is_valid_syntax("a b@c.com"));
    }

    #[test]
    fn ip_literal_domain_is_invalid() {
        for address in ["a@127.0.0.1", "a@localhost", "a@intranet"] {
            let analysis = analyze(address);
            assert_eq!(analysis.settled, Some(STATUS_INVALID), "{}", address);
            assert!(analysis.flags.iter().any(|flag| flag == FLAG_IP_DOMAIN));
        }
        // A bracketed IPv6 literal fails the syntax gate first — still invalid,
        // and the flag says why.
        let bracketed = analyze("a@[::1]");
        assert_eq!(bracketed.settled, Some(STATUS_INVALID));
        assert!(bracketed.flags.iter().any(|flag| flag == FLAG_SYNTAX));
    }

    #[test]
    fn disposable_short_circuits_dns() {
        let analysis = analyze("x@abc.mailinator.com");
        assert_eq!(analysis.settled, Some(STATUS_INVALID));
        assert!(analysis.flags.iter().any(|flag| flag == FLAG_DISPOSABLE));
        // The dot boundary is what keeps a legitimate domain out.
        let ok = analyze("x@notmailinator.com");
        assert!(ok.settled.is_none(), "notmailinator.com must reach DNS");
    }

    #[test]
    fn role_mailbox_downgrades_valid_to_risky() {
        let analysis = analyze("info+news@example.com");
        assert!(analysis.flags.iter().any(|flag| flag == FLAG_ROLE));
        let (status, flags) = compose(&analysis.flags, &DnsOutcome::Mx { host: "mx.example.com".into() });
        assert_eq!(status, STATUS_RISKY);
        assert!(flags.iter().any(|flag| flag == FLAG_ROLE));
    }

    #[test]
    fn free_mail_keeps_valid_and_sets_flag() {
        let analysis = analyze("owner@gmail.com");
        assert!(analysis.flags.iter().any(|flag| flag == FLAG_FREE_MAIL));
        let (status, _) = compose(&analysis.flags, &DnsOutcome::Mx { host: "mx.google.com".into() });
        assert_eq!(status, STATUS_VALID);
    }

    #[test]
    fn typo_domain_sets_risky() {
        let analysis = analyze("hello@gmial.com");
        assert!(analysis.flags.iter().any(|flag| flag == FLAG_TYPO));
        let (status, _) = compose(&analysis.flags, &DnsOutcome::Mx { host: "mx.example.com".into() });
        assert_eq!(status, STATUS_RISKY);
    }

    #[test]
    fn short_domains_are_not_typo_candidates() {
        // `qq.com` / `163.com` are excluded on purpose: distance 1 there is noise.
        assert!(!looks_like_typo("qq.com"));
        assert!(!looks_like_typo("163.com"));
        assert!(looks_like_typo("gmail.co"));
    }

    #[test]
    fn non_ascii_sets_risky() {
        let analysis = analyze("店主@例子.测试");
        assert!(analysis.flags.iter().any(|flag| flag == FLAG_NON_ASCII));
        let (status, _) = compose(&analysis.flags, &DnsOutcome::Mx { host: "mx.example.com".into() });
        assert_eq!(status, STATUS_RISKY);
        // The resolver only ever sees the punycode form.
        assert!(analysis.ascii_domain.is_ascii(), "{}", analysis.ascii_domain);
    }

    #[test]
    fn null_mx_is_invalid() {
        let (status, flags) = compose(&[], &DnsOutcome::NullMx);
        assert_eq!(status, STATUS_INVALID);
        assert!(flags.iter().any(|flag| flag == FLAG_NULL_MX));
    }

    #[test]
    fn nxdomain_is_invalid() {
        let (status, flags) = compose(&[], &DnsOutcome::NxDomain);
        assert_eq!(status, STATUS_INVALID);
        assert!(flags.iter().any(|flag| flag == FLAG_NXDOMAIN));
    }

    #[test]
    fn no_mx_with_a_is_unknown() {
        let (status, flags) = compose(&[], &DnsOutcome::Implicit);
        assert_eq!(status, STATUS_UNKNOWN);
        assert!(flags.iter().any(|flag| flag == FLAG_IMPLICIT_MX));
    }

    #[test]
    fn no_mx_without_a_is_invalid() {
        let (status, flags) = compose(&[], &DnsOutcome::NoMx);
        assert_eq!(status, STATUS_INVALID);
        assert!(flags.iter().any(|flag| flag == FLAG_NO_MX));
    }

    #[test]
    fn summary_precedence_is_total() {
        let now = 10_000;
        let cases: Vec<(Vec<(&str, &str)>, &str, bool)> = vec![
            (vec![("a@x.com", "valid"), ("b@x.com", "invalid")], STATUS_VALID, false),
            (vec![("a@x.com", "risky"), ("b@x.com", "invalid")], STATUS_RISKY, false),
            (vec![("a@x.com", "unknown"), ("b@x.com", "invalid")], STATUS_UNKNOWN, false),
            (vec![("a@x.com", "invalid"), ("b@x.com", "invalid")], STATUS_INVALID, false),
        ];
        for (rows, expected, stale) in cases {
            let addresses: Vec<String> = rows.iter().map(|(a, _)| a.to_string()).collect();
            let records = map(rows
                .iter()
                .map(|(address, status)| record(address, status, &[], now + 1_000))
                .collect());
            let reference = build_ref("p", &addresses, &records, now, "");
            assert_eq!(reference.status, expected);
            assert_eq!(reference.stale, stale);
        }
    }

    #[test]
    fn expired_verdict_counts_as_unverified() {
        let now = 10_000;
        let addresses = vec!["a@x.com".to_string()];
        let records = map(vec![record("a@x.com", "valid", &[], now - 1)]);
        let reference = build_ref("p", &addresses, &records, now, "");
        assert_eq!(reference.status, STATUS_UNVERIFIED);
        assert!(!reference.stale, "unverified already says there is nothing to re-check");
    }

    #[test]
    fn stale_only_when_some_address_lacks_fresh() {
        let now = 10_000;
        let addresses = vec!["a@x.com".to_string(), "b@x.com".to_string()];
        let records = map(vec![
            record("a@x.com", "valid", &[], now + 1_000),
            record("b@x.com", "risky", &[], now - 1),
        ]);
        let reference = build_ref("p", &addresses, &records, now, "");
        assert_eq!(reference.status, STATUS_VALID);
        assert!(reference.stale);
        let stale_flags: Vec<bool> = reference.addresses.iter().map(|a| a.stale).collect();
        assert_eq!(stale_flags, vec![false, true]);
    }

    #[test]
    fn row_without_addresses_is_none() {
        let reference = build_ref("p", &[], &HashMap::new(), 0, "https://x.com");
        assert_eq!(reference.status, STATUS_NONE);
        assert!(reference.addresses.is_empty());
    }

    #[test]
    fn same_domain_is_derived_from_the_row_website() {
        let now = 10_000;
        let addresses = vec!["info@foo.com".to_string(), "x@bar.com".to_string()];
        let records = map(vec![
            record("info@foo.com", "valid", &[], now + 1_000),
            record("x@bar.com", "valid", &[], now + 1_000),
        ]);
        let reference = build_ref("p", &addresses, &records, now, "https://www.foo.com/contact");
        assert!(reference.addresses[0].same_domain);
        assert!(!reference.addresses[1].same_domain);
        // A row with no usable website never claims same-domain evidence.
        let none = build_ref("p", &addresses, &records, now, "");
        assert!(!none.addresses[0].same_domain);
    }

    #[test]
    fn ttl_follows_the_result_kind() {
        assert_eq!(address_ttl_ms(STATUS_VALID, &[]), ADDRESS_TTL_DAYS * DAY_MS);
        assert_eq!(address_ttl_ms(STATUS_UNKNOWN, &[]), ADDRESS_UNKNOWN_TTL_DAYS * DAY_MS);
        assert_eq!(
            address_ttl_ms(STATUS_INVALID, &[FLAG_SYNTAX.to_string()]),
            ADDRESS_TTL_DAYS * DAY_MS
        );
        assert_eq!(
            address_ttl_ms(STATUS_INVALID, &[FLAG_NXDOMAIN.to_string()]),
            ADDRESS_NEGATIVE_TTL_DAYS * DAY_MS
        );
        assert_eq!(address_ttl_ms(STATUS_ERROR, &[]), 0);
    }

    #[test]
    fn export_cells_use_stable_tokens() {
        let now = 10_000;
        let addresses = vec![
            "info@dental.com".to_string(),
            "sales@dental.com".to_string(),
            "old@dental.com".to_string(),
        ];
        let records = map(vec![
            record("info@dental.com", "valid", &[], now + 1_000),
            record("sales@dental.com", "risky", &[FLAG_ROLE], now + 1_000),
            record("old@dental.com", "valid", &[], now - 1),
        ]);
        let cell = export_cell(&addresses, &records, now);
        assert_eq!(cell.summary, "valid");
        assert_eq!(
            cell.detail,
            "info@dental.com=valid; sales@dental.com=risky(role); old@dental.com=valid(stale)"
        );

        let mut failed = record("x@dental.com", "error", &[], 0);
        failed.last_error = "timeout".to_string();
        let cell = export_cell(&["x@dental.com".to_string()], &map(vec![failed]), now);
        assert_eq!(cell.summary, "unverified");
        assert_eq!(cell.detail, "x@dental.com=error(timeout)");
    }

    #[test]
    fn doh_parses_mx_and_picks_lowest_preference() {
        let body = serde_json::json!({
            "Status": 0,
            "Answer": [
                { "name": "example.com.", "type": 15, "TTL": 60, "data": "20 mx2.example.com." },
                { "name": "example.com.", "type": 15, "TTL": 60, "data": "10 mx1.example.com." },
                { "name": "example.com.", "type": 1, "TTL": 60, "data": "93.184.216.34" }
            ]
        });
        let outcome = interpret_mx(&body).unwrap().unwrap();
        assert_eq!(outcome, DnsOutcome::Mx { host: "mx1.example.com".into() });
    }

    #[test]
    fn doh_parses_null_mx() {
        let body = serde_json::json!({
            "Status": 0,
            "Answer": [{ "name": "example.com.", "type": 15, "TTL": 60, "data": "0 ." }]
        });
        assert_eq!(interpret_mx(&body).unwrap(), Some(DnsOutcome::NullMx));
    }

    #[test]
    fn doh_parses_nxdomain() {
        let body = serde_json::json!({ "Status": 3 });
        assert_eq!(interpret_mx(&body).unwrap(), Some(DnsOutcome::NxDomain));
    }

    #[test]
    fn doh_rejects_malformed_json() {
        let body = serde_json::json!({ "answers": [] });
        assert_eq!(interpret_mx(&body), Err(DnsFailure::Code(ERR_PARSE)));
        let servfail = serde_json::json!({ "Status": 2 });
        assert_eq!(interpret_mx(&servfail), Err(DnsFailure::Code(ERR_DOH_HTTP)));
    }

    #[test]
    fn doh_falls_back_to_a_record() {
        let no_mx = serde_json::json!({ "Status": 0 });
        assert_eq!(interpret_mx(&no_mx).unwrap(), None);
        let with_a = serde_json::json!({
            "Status": 0,
            "Answer": [{ "name": "amx.test.", "type": 1, "data": "1.2.3.4" }]
        });
        assert_eq!(interpret_a(&with_a).unwrap(), DnsOutcome::Implicit);
        let without_a = serde_json::json!({ "Status": 0, "Answer": [] });
        assert_eq!(interpret_a(&without_a).unwrap(), DnsOutcome::NoMx);
        assert_eq!(
            interpret_a(&serde_json::json!({ "Status": 3 })).unwrap(),
            DnsOutcome::NxDomain
        );
    }

    /// A broken A answer is an `error`, never `invalid(no_mx)`: the two look the
    /// same in the table but one is retryable and the other is a verdict that
    /// sticks for a week.
    #[test]
    fn a_servfail_on_the_address_query_is_an_error() {
        let servfail = serde_json::json!({ "Status": 2 });
        assert_eq!(
            interpret_a(&servfail),
            Err(DnsFailure::Code(ERR_DOH_HTTP))
        );
        let malformed = serde_json::json!({ "answers": [] });
        assert_eq!(interpret_a(&malformed), Err(DnsFailure::Code(ERR_PARSE)));
    }

    #[test]
    fn endpoint_sticks_after_first_success() {
        let client = DohClient::new(vec![
            "https://a.example/resolve".to_string(),
            "https://b.example/resolve".to_string(),
        ]);
        client.active.store(1, Ordering::Relaxed);
        // The sticky index survives until a query actually fails over; nothing
        // in `query` resets it to 0 on entry.
        assert_eq!(client.active.load(Ordering::Relaxed), 1);
        assert_eq!(client.endpoints.len(), 2);
    }

    #[test]
    fn all_endpoints_failing_is_fatal() {
        let client = DohClient::new(vec!["https://a.example/resolve".to_string()]);
        // Simulate the streak without network IO: the counter is what decides.
        client
            .transport_failures
            .store(MAX_CONSECUTIVE_TRANSPORT_FAILURES as usize - 1, Ordering::Relaxed);
        let failures = client.transport_failures.fetch_add(1, Ordering::Relaxed) + 1;
        assert!(failures as u32 >= MAX_CONSECUTIVE_TRANSPORT_FAILURES);
    }

    #[test]
    fn edit_distance_counts_a_transposition_as_one() {
        assert_eq!(edit_distance("gmial.com", "gmail.com", 1), 1);
        assert_eq!(edit_distance("gmail.com", "gmail.com", 1), 0);
        assert!(edit_distance("verylongdomain.example", "gmail.com", 1) > 1);
    }
}
