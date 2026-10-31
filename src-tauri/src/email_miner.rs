//! Site email/social mining (roadmap M7 / G-03).
//!
//! For every business row that carries a website, visit the site (homepage,
//! then up to three same-domain contact pages when the homepage yields
//! nothing), extract email addresses and social profile links, and write them
//! back to `businesses`.
//!
//! Ground rules, all deliberate:
//! - **Rust-side HTTP only.** The maps webview stays on google.com; the miner
//!   never touches it, and every behavior is testable offline against fixture
//!   HTML.
//! - **Politeness over coverage.** One site is visited by one worker at a
//!   time, with a randomized delay between requests; a site that answers like
//!   an anti-bot challenge is marked `blocked` and left alone.
//! - **Deduplication by domain.** Several businesses often share one website;
//!   one visit covers all of their rows.
//! - **Pure-data config.** The blocklist and contact-page keywords come from
//!   the same remote config as the parser field map (M5), so false-positive
//!   rules can be corrected without shipping a new binary.

use crate::logging::{log_error, log_info, log_warn};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use regex::Regex;
use scraper::node::Node;
use scraper::{Html, Selector};
use std::sync::OnceLock;
use tauri::{Emitter, Manager};
use url::Url;

use crate::remote_config::EmailRules;

const HTTP_TIMEOUT: Duration = Duration::from_secs(5);
/// Scraping a whole page bundle (images, scripts) is pointless; 1 MB of HTML
/// covers any plausible contact page. Larger answers are treated as a fetch
/// error, not silently truncated, so the row can be retried later.
const MAX_PAGE_BYTES: usize = 1024 * 1024;
/// Body reads go through a bounded loop that checks the cancel flag between
/// chunks, so `cancel_email_mining` takes effect mid-download instead of after
/// the current request finishes (R-02). 16 KB keeps the check cheap while
/// bounding the cancel latency to one socket read.
const READ_CHUNK_BYTES: usize = 16 * 1024;
/// Hard cap on one mining run (R-02). A legitimate run is minutes; when this
/// trips, something is wedged in a way the per-request timeouts cannot see (a
/// server dribbling one byte per read, a stalled resolver). Setting the cancel
/// flag stops every worker at its next check and releases the single-flight
/// slot, so a wedged run can never lock mining until the next restart.
const MAX_RUN_DURATION: Duration = Duration::from_secs(30 * 60);
/// Redirect hops followed per request (R-05). Each hop is re-validated against
/// the SSRF guard before it is requested, so a public site cannot bounce the
/// miner into the user's network.
const MAX_REDIRECTS: usize = 5;
/// One bounded retry after a 429 (R-20). The old code treated 429 like any
/// other block and gave up on the site for the whole run; a single pause is
/// the polite middle ground between hammering and abandoning.
const RETRY_AFTER_429: Duration = Duration::from_secs(10);
const MAX_CONTACT_PAGES: usize = 3;
const MAX_EMAILS_PER_SITE: usize = 5;
const MAX_SOCIALS_PER_SITE: usize = 4;
/// How many sites are mined at the same time. Small on purpose: the target is
/// "polite visitor", not "parallel crawler", and every extra socket widens the
/// blocking surface on the user's home IP.
const GLOBAL_CONCURRENCY: usize = 3;
/// Minimum wait between two requests to the same site; jitter is added on top.
const REQUEST_DELAY_MS: u64 = 1500;
const REQUEST_JITTER_MS: u64 = 1500;
/// An honest, contactable bot identity (R-20). The old value impersonated a
/// Chrome install, which both invites bot-detection escalation and makes the
/// traffic impossible to attribute when a site operator wants to reach out.
/// Sites that answer an honest bot with a challenge are marked `blocked`,
/// which is the truthful outcome.
const USER_AGENT: &str = "Mozilla/5.0 (compatible; Placemill/0.1; +https://github.com/usedel/placemill; site-miner, respects robots.txt)";

pub const STATUS_FOUND: &str = "found";
pub const STATUS_NONE_FOUND: &str = "none-found";
pub const STATUS_BLOCKED: &str = "blocked";
pub const STATUS_ERROR: &str = "error";
/// A transient failure (timeout, DNS, 5xx). Deliberately stored as the empty
/// "not mined yet" status so `mining_targets` picks the row up on the next run;
/// `run_mining` still counts it as a failed site for the progress UI.
pub const STATUS_RETRYABLE: &str = "";

// ---------------------------------------------------------------------------
// Extraction (pure functions — the unit tests below run entirely on fixtures)
// ---------------------------------------------------------------------------

fn email_regex() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+").expect("email regex")
    })
}

fn mailto_regex() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"mailto:([^"'>\s?]+)"#).expect("mailto regex"))
}

/// Selector for anchors; used for `mailto:` targets and contact links.
fn anchor_selector() -> &'static Selector {
    static SEL: OnceLock<Selector> = OnceLock::new();
    SEL.get_or_init(|| Selector::parse("a[href]").expect("anchor selector"))
}

/// Anchors plus image maps: the two elements that carry a navigable URL.
fn link_selector() -> &'static Selector {
    static SEL: OnceLock<Selector> = OnceLock::new();
    SEL.get_or_init(|| Selector::parse("a[href], area[href]").expect("link selector"))
}

/// Cheap noise removal used by the regex fallback only (R-21b): script/style
/// bodies and HTML comments hold build hashes, e-mail-like ids and CSS that
/// only produce false positives. Patterns compile once and are reused for
/// every page.
fn strip_noise(html: &str) -> String {
    static NOISE: std::sync::OnceLock<Vec<Regex>> = std::sync::OnceLock::new();
    let noise = NOISE.get_or_init(|| {
        [
            r"(?is)<script\b[^>]*>.*?</script>",
            r"(?is)<style\b[^>]*>.*?</style>",
            r"(?is)<!--.*?-->",
            r"(?is)<noscript\b[^>]*>.*?</noscript>",
        ]
        .iter()
        .filter_map(|pattern| Regex::new(pattern).ok())
        .collect()
    });
    let mut text = html.to_string();
    for re in noise {
        text = re.replace_all(&text, " ").to_string();
    }
    text
}

/// `[at]`, `(at)`, ` dot ` and friends. Only run when the plain pass found
/// nothing — on prose the ` at ` variant fires too eagerly to be safe.
fn deobfuscate(text: &str) -> String {
    text.replace(" (at) ", "@")
        .replace(" [at] ", "@")
        .replace("（at）", "@")
        .replace("(at)", "@")
        .replace("[at]", "@")
        .replace("{at}", "@")
        .replace(" at ", "@")
        .replace(" (dot) ", ".")
        .replace(" [dot] ", ".")
        .replace("(dot)", ".")
        .replace("[dot]", ".")
}

/// File names masquerading as addresses: `logo@2x.png` matches the email
/// regex but is a retina asset, not a contact.
fn is_asset_extension(domain: &str) -> bool {
    matches!(
        domain.rsplit('.').next().unwrap_or(""),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "css" | "js" | "woff" | "woff2"
            | "ttf" | "eot" | "ico" | "mp4" | "json"
    )
}

fn is_plausible_email(candidate: &str) -> bool {
    let candidate = candidate.trim().trim_matches(|c: char| ".,;:()[]".contains(c));
    if candidate.len() < 6 || candidate.len() > 254 || !candidate.contains('@') {
        return false;
    }
    let (local, domain) = match candidate.split_once('@') {
        Some(parts) => parts,
        None => return false,
    };
    if local.is_empty() || domain.is_empty() || !domain.contains('.') {
        return false;
    }
    let tld = domain.rsplit('.').next().unwrap_or("");
    if tld.len() < 2 || !tld.chars().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    if is_asset_extension(domain) {
        return false;
    }
    candidate
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "@._%+-".contains(c))
}

fn push_email(into: &mut Vec<String>, candidate: &str) {
    let candidate = candidate
        .trim()
        .trim_matches(|c: char| ".,;:()[]<>\"'".contains(c));
    if !is_plausible_email(candidate) {
        return;
    }
    let lowered = candidate.to_lowercase();
    if !into.contains(&lowered) {
        into.push(lowered);
    }
}

/// The pre-R-21b implementation, kept as the last-resort fallback.
///
/// Only reached when `PageDoc::emails` finds no text at all in the parsed
/// document (truncated markup, a body that is not HTML), which is exactly the
/// case where a regex over the raw source can still recover an address.
fn emails_regex_fallback(html: &str) -> Vec<String> {
    let text = strip_noise(html);
    let mut found: Vec<String> = Vec::new();
    for caps in mailto_regex().captures_iter(&text) {
        push_email(&mut found, caps.get(1).map(|m| m.as_str()).unwrap_or(""));
    }
    for matched in email_regex().find_iter(&text) {
        push_email(&mut found, matched.as_str());
    }
    if found.is_empty() {
        for matched in email_regex().find_iter(&deobfuscate(&text)) {
            push_email(&mut found, matched.as_str());
        }
    }
    found.truncate(MAX_EMAILS_PER_SITE * 2);
    found
}

/// One parsed page, shared by the three extraction passes (R-21b).
///
/// The regex version re-scanned the whole body three times per page — once for
/// addresses, once for social links, once for contact pages — and each pass
/// ran its own `strip_noise`. A single tree is parsed once and queried three
/// times instead. Attribute order, quoting style, missing quotes, uppercase
/// tags, nesting and a `"</script>"` inside a script string no longer change
/// the result: html5ever builds the tree the browser would, and the queries
/// look at nodes rather than at text.
///
/// The raw source is retained for one purpose only: `emails()` falls back to
/// the regex path when the parsed document has no text, so a truncated body
/// still yields whatever the old code could recover.
pub struct PageDoc {
    doc: Html,
    raw: String,
}

/// Subtrees that never describe the page's visible content: their text is
/// build noise and their links are templates, not presence.
fn is_noise_tag(name: &str) -> bool {
    matches!(name, "script" | "style" | "noscript" | "template")
}

impl PageDoc {
    pub fn parse(html: &str) -> Self {
        Self {
            doc: Html::parse_document(html),
            raw: html.to_string(),
        }
    }

    /// True when the element lives inside a noise subtree. Selector matches
    /// are document order over the whole tree, so every query has to skip
    /// these explicitly — `<template>` in particular parses into real child
    /// elements that a selector would happily return.
    fn inside_noise(element: &scraper::ElementRef<'_>) -> bool {
        // `ElementRef` derefs to `NodeRef`, so `ancestors()` is available here.
        element.ancestors().any(|ancestor| match ancestor.value() {
            Node::Element(node) => is_noise_tag(node.name.local.as_ref()),
            _ => false,
        })
    }

    /// Text of every text node in document order, skipping subtrees that only
    /// ever produce noise. Comments are not text nodes, so `<!-- a@b.com -->`
    /// is excluded for free.
    fn text(&self) -> String {
        let mut out = String::new();
        for node in self.doc.tree.nodes() {
            let Node::Text(text) = node.value() else {
                continue;
            };
            let noisy = node.ancestors().any(|ancestor| match ancestor.value() {
                Node::Element(element) => is_noise_tag(element.name.local.as_ref()),
                _ => false,
            });
            if noisy {
                continue;
            }
            out.push_str(&text.text);
            out.push(' ');
        }
        out
    }

    /// Addresses on this page: `mailto:` targets first, then plain-text
    /// matches, then deobfuscated variants — the order matters because
    /// `rank_emails` prefers the first occurrences.
    pub fn emails(&self) -> Vec<String> {
        let text = self.text();
        if text.trim().is_empty() {
            log_warn!("mining: the parsed page has no text, using the regex fallback");
            return emails_regex_fallback(&self.raw);
        }

        let mut found: Vec<String> = Vec::new();
        for element in self.doc.select(anchor_selector()) {
            let Some(href) = element.value().attr("href") else {
                continue;
            };
            let Some(target) = href.strip_prefix("mailto:") else {
                continue;
            };
            if Self::inside_noise(&element) {
                continue;
            }
            // `mailto:a@b.com?subject=hi` — the query is not part of the address.
            push_email(&mut found, target.split('?').next().unwrap_or(target));
        }
        for matched in email_regex().find_iter(&text) {
            push_email(&mut found, matched.as_str());
        }
        if found.is_empty() {
            for matched in email_regex().find_iter(&deobfuscate(&text)) {
                push_email(&mut found, matched.as_str());
            }
        }
        found.truncate(MAX_EMAILS_PER_SITE * 2);
        found
    }

    /// Social profile links, at most one per platform, ordered by platform.
    ///
    /// Scoped to `a[href]`/`area[href]` (R-21b): the old `href` regex also
    /// picked up `<link rel="alternate" href="…">`, which is not a presence
    /// link a visitor could click. The parser also decodes entities, so
    /// `?a=1&amp;b=2` reaches `Url::join` as a valid URL.
    pub fn socials(&self, base: Option<&Url>) -> Vec<String> {
        let mut per_kind: Vec<Option<(SocialKind, String)>> = vec![None; 4];
        for element in self.doc.select(link_selector()) {
            let Some(raw) = element.value().attr("href") else {
                continue;
            };
            if Self::inside_noise(&element) {
                continue;
            }
            let resolved = match base {
                Some(base) => base.join(raw),
                None => Url::parse(raw),
            };
            let Ok(url) = resolved else { continue };
            if let Some((kind, clean)) = classify_social(&url) {
                let slot = &mut per_kind[kind.rank()];
                if slot.is_none() {
                    *slot = Some((kind, clean));
                }
            }
        }
        let mut ordered: Vec<(SocialKind, String)> = per_kind.into_iter().flatten().collect();
        ordered.sort_by_key(|(kind, _)| kind.rank());
        ordered
            .into_iter()
            .map(|(_, url)| url)
            .take(MAX_SOCIALS_PER_SITE)
            .collect()
    }

    /// Same-domain anchors whose href or text looks like a contact page.
    pub fn contact_pages(&self, base_url: &Url, keywords: &[String]) -> Vec<String> {
        let base_host = base_url.host_str().unwrap_or("").trim_start_matches("www.");
        let mut found: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for element in self.doc.select(anchor_selector()) {
            let Some(href) = element.value().attr("href") else {
                continue;
            };
            if href.starts_with("mailto:")
                || href.starts_with("tel:")
                || href.starts_with("javascript:")
            {
                continue;
            }
            if Self::inside_noise(&element) {
                continue;
            }
            let Ok(absolute) = base_url.join(href) else {
                continue;
            };
            if absolute.host_str().unwrap_or("").trim_start_matches("www.") != base_host {
                continue;
            }
            // `a.text()` is the anchor's own text, so nested markup no longer
            // shifts the window the old `<a ...>(.*?)</a>` regex matched.
            let anchor_text: String = element.text().collect::<Vec<_>>().concat();
            let haystack = format!(
                "{} {}",
                absolute.path().to_lowercase(),
                anchor_text.to_lowercase()
            );
            if !keywords.iter().any(|keyword| haystack.contains(keyword)) {
                continue;
            }
            let clean = absolute.as_str().split('#').next().unwrap_or("").to_string();
            if clean != base_url.as_str() && seen.insert(clean.clone()) {
                found.push(clean);
            }
            if found.len() >= MAX_CONTACT_PAGES {
                break;
            }
        }
        found
    }
}

/// Candidate addresses on one page (R-21b: DOM first, regex only as fallback).
///
/// Test-only convenience: the miner itself keeps one `PageDoc` and asks it
/// three times, while the fixtures below each describe a single page.
#[cfg(test)]
fn extract_emails(html: &str) -> Vec<String> {
    PageDoc::parse(html).emails()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SocialKind {
    Linkedin,
    Facebook,
    Instagram,
    X,
}

impl SocialKind {
    fn rank(self) -> usize {
        match self {
            SocialKind::Linkedin => 0,
            SocialKind::Facebook => 1,
            SocialKind::Instagram => 2,
            SocialKind::X => 3,
        }
    }
}

/// Profile pages only: share dialogs, intent links and platform chrome are
/// not the business's social presence.
fn is_social_path(platform: SocialKind, path: &str) -> bool {
    let path = path.trim_matches('/');
    match platform {
        SocialKind::Linkedin => path.starts_with("company/") || path.starts_with("in/"),
        SocialKind::Facebook => {
            !path.is_empty()
                && !path.starts_with("sharer")
                && !path.starts_with("plugins")
                && !path.starts_with("dialog")
                && !path.starts_with("events")
                && !path.starts_with("watch")
                && !path.starts_with("hashtag")
                && !path.starts_with("reel")
        }
        SocialKind::Instagram => {
            !path.is_empty()
                && !path.starts_with("p/")
                && !path.starts_with("reel/")
                && !path.starts_with("explore")
                && !path.starts_with("accounts")
                && !path.starts_with("stories")
        }
        SocialKind::X => {
            !path.is_empty()
                && !path.starts_with("intent")
                && !path.starts_with("share")
                && !path.starts_with("home")
                && !path.starts_with("search")
                && !path.starts_with("i/")
                && !path.starts_with("hashtag")
        }
    }
}

/// Exact or dot-boundary host match (R-21). `ends_with("linkedin.com")` used
/// to accept `notlinkedin.com`, which let any site dress its own domain up as
/// a social profile; the dot boundary closes that.
fn host_is(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{}", domain))
}

fn classify_social(url: &Url) -> Option<(SocialKind, String)> {
    let host = url.host_str()?.to_lowercase();
    let path = url.path().trim_matches('/').to_string();
    let platform = if host_is(&host, "linkedin.com") {
        SocialKind::Linkedin
    } else if host_is(&host, "facebook.com") || host_is(&host, "fb.com") {
        SocialKind::Facebook
    } else if host_is(&host, "instagram.com") {
        SocialKind::Instagram
    } else if host_is(&host, "twitter.com") || host_is(&host, "x.com") {
        SocialKind::X
    } else {
        return None;
    };
    if !is_social_path(platform, &path) {
        return None;
    }
    let mut clean = format!("{}://{}", url.scheme(), host);
    clean.push_str(url.path());
    Some((platform, clean))
}

/// Social profile links on one page, at most one per platform.
///
/// `base` resolves relative hrefs — the previous version called `Url::parse`
/// on the raw attribute, so `/company/foo` on a root-relative site was always
/// dropped, while `discover_contact_pages` resolved the same link fine (R-21).
#[cfg(test)]
fn extract_socials(html: &str, base: Option<&Url>) -> Vec<String> {
    PageDoc::parse(html).socials(base)
}

/// Same-domain links whose href or anchor text looks like a contact page.
///
/// R-21b replaced the `<a …>(.*?)</a>` regex: nested anchors used to shift the
/// match window, and a `</script>` inside a script string truncated the search
/// entirely. Both are ordinary DOM queries now.
#[cfg(test)]
fn discover_contact_pages(
    base_url: &Url,
    html: &str,
    keywords: &[String],
) -> Vec<String> {
    PageDoc::parse(html).contact_pages(base_url, keywords)
}

/// Mailboxes that belong to a role rather than a person.
///
/// One list, two consumers (G-04): the miner scores them up (a business's
/// `info@` is the address you want), the verifier downgrades them to `risky`
/// (nobody maintains `sales@` reliably). Keeping two copies is exactly the
/// "change one, forget the other" bug this constant exists to prevent —
/// widening the list therefore changes both behaviours on purpose.
pub(crate) const ROLE_MAILBOXES: &[&str] = &[
    "info", "contact", "hello", "office", "sales", "admin", "support", "team", "mail",
    "enquiries", "inquiries", "billing", "accounts", "hr", "jobs", "careers", "privacy",
    "press", "marketing", "webmaster",
];

/// Rank addresses: same-domain first, then role mailboxes, then anything not
/// on the blocklist. The blocklist is a hard filter — one hit disqualifies.
pub fn rank_emails(
    candidates: Vec<String>,
    site_domain: &str,
    blocklist: &[String],
) -> Vec<String> {
    let site_domain = site_domain
        .trim_start_matches("www.")
        .trim_end_matches('/')
        .to_lowercase();
    let mut scored: Vec<(i32, usize, String)> = Vec::new();
    for (position, candidate) in candidates.into_iter().enumerate() {
        let lowered = candidate.to_lowercase();
        if blocklist
            .iter()
            .any(|entry| lowered.contains(entry.to_lowercase().as_str()))
        {
            continue;
        }
        let mut score = 0;
        if lowered.ends_with(&format!("@{}", site_domain))
            || lowered.ends_with(&format!(".{}", site_domain))
        {
            score += 100;
        }
        let local = lowered.split('@').next().unwrap_or("");
        if ROLE_MAILBOXES.contains(&local) {
            score += 50;
        }
        scored.push((score, usize::MAX - position, lowered));
    }
    scored.sort_by(|a, b| (b.0, b.1).cmp(&(a.0, a.1)));
    scored
        .into_iter()
        .map(|(_, _, email)| email)
        .take(MAX_EMAILS_PER_SITE)
        .collect()
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum FetchError {
    /// The site (or its edge) actively refused automated access. Never retried
    /// within a run, never followed by a scheme fallback.
    Blocked(String),
    /// A non-2xx HTTP status. Kept distinct from `Transport` so robots.txt can
    /// follow RFC 9309 (4xx = unavailable/allow, 5xx = unreachable/deny) and so
    /// a transient 5xx can be retried by a later mining run.
    Status(u16),
    /// Anything else: DNS, timeout, oversized page.
    Transport(String),
    /// The run was cancelled while this fetch was in flight (R-02). Distinguished
    /// from `Transport` so the worker loop can tell "user pressed stop" from
    /// "the site failed" — a cancelled site is not written back and not counted.
    Cancelled,
}

/// HTTP client for the miner (R-02).
///
/// The overall `timeout` bounds one request-response cycle, and the granular
/// limits make the intent explicit and version-proof: a server that dribbles
/// bytes cannot hold a worker past `HTTP_TIMEOUT`, and a connect cannot hang
/// past it either. Cancel propagation during the body read is handled by
/// `read_body_limited`, which the timeout cannot express.
fn build_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(HTTP_TIMEOUT)
        .timeout_connect(HTTP_TIMEOUT)
        .timeout_read(HTTP_TIMEOUT)
        // R-05: redirects are followed by hand in `fetch_page`, hop by hop,
        // each re-validated against `is_safe_target`. With 0, ureq returns the
        // 3xx response itself instead of chasing `Location`.
        .redirects(0)
        .build()
}

fn looks_like_challenge(body: &str) -> bool {
    let lowered = body.to_lowercase();
    [
        "just a moment",
        "cf-browser-verification",
        "cf_chl_",
        "attention required",
        "ddos protection by",
        "captcha-delivery",
        "checking your browser",
    ]
    .iter()
    .any(|marker| lowered.contains(marker))
}

/// Read the response body in chunks, checking the cancel flag between reads
/// (R-02). `read_to_end` cannot be interrupted, so a slow server used to keep
/// the worker (and with it the single-flight slot) busy until the socket gave
/// up on its own. With the chunked loop a cancel request lands within one
/// socket read, and the size cap still produces a transport error rather than
/// silently truncating.
fn read_body_limited<R: Read>(
    mut reader: R,
    max: usize,
    cancel: &AtomicBool,
) -> Result<Vec<u8>, FetchError> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; READ_CHUNK_BYTES];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(FetchError::Cancelled);
        }
        match reader.read(&mut chunk) {
            Ok(0) => return Ok(bytes),
            Ok(n) => {
                bytes.extend_from_slice(&chunk[..n]);
                if bytes.len() > max {
                    return Err(FetchError::Transport(format!(
                        "page larger than {} bytes",
                        max
                    )));
                }
            }
            Err(error) => return Err(FetchError::Transport(error.to_string())),
        }
    }
}

/// Status-code → error mapping shared by the request paths.
fn classify_status(code: u16) -> FetchError {
    FetchError::Status(code)
}

fn fetch_page(
    agent: &ureq::Agent,
    url: &str,
    cancel: &AtomicBool,
) -> Result<(Url, String), FetchError> {
    if cancel.load(Ordering::Relaxed) {
        return Err(FetchError::Cancelled);
    }
    let send = |target: &str| {
        agent
            .get(target)
            // R-05: redirect following is done by hand so every hop can be
            // re-validated against `is_safe_target` — ureq's built-in
            // following would bounce straight into whatever `Location` says.
            // The 0-redirect setting lives on the agent (see `build_agent`).
            .set("User-Agent", USER_AGENT)
            .set(
                "Accept",
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            .set("Accept-Language", "en-US,en;q=0.9")
            .call()
    };

    let mut current = url.to_string();
    for _hop in 0..=MAX_REDIRECTS {
        if cancel.load(Ordering::Relaxed) {
            return Err(FetchError::Cancelled);
        }
        let Ok(parsed) = Url::parse(&current) else {
            return Err(FetchError::Transport(format!("invalid URL: {}", current)));
        };
        if !is_safe_target(&parsed) {
            return Err(FetchError::Blocked(format!(
                "non-public target: {}",
                parsed.host_str().unwrap_or("")
            )));
        }

        let response = match send(&current) {
            Ok(response) => response,
            // One bounded retry on 429 (R-20): a single pause instead of
            // hammering or abandoning the site for the run.
            Err(ureq::Error::Status(429, _)) => {
                wait_if_cancelled(RETRY_AFTER_429, cancel);
                if cancel.load(Ordering::Relaxed) {
                    return Err(FetchError::Cancelled);
                }
                match send(&current) {
                    Ok(response) => response,
                    Err(ureq::Error::Status(code, _)) => return Err(classify_status(code)),
                    Err(other) => return Err(FetchError::Transport(other.to_string())),
                }
            }
            Err(ureq::Error::Status(code, _)) => return Err(classify_status(code)),
            Err(other) => return Err(FetchError::Transport(other.to_string())),
        };

        let status = response.status();
        if (300..400).contains(&status) {
            let Some(location) = response.header("location") else {
                return Err(FetchError::Transport(format!(
                    "HTTP {} redirect without Location",
                    status
                )));
            };
            let Ok(next) = parsed.join(location) else {
                return Err(FetchError::Transport(format!(
                    "unreadable redirect target: {}",
                    location
                )));
            };
            current = next.to_string();
            continue;
        }
        if !(200..300).contains(&status) {
            return Err(FetchError::Status(status));
        }

        // `take` keeps a hostile Content-Length from promising more than the cap;
        // `read_body_limited` enforces the same cap on what actually arrives.
        let reader = response.into_reader().take((MAX_PAGE_BYTES + 1) as u64);
        let bytes = read_body_limited(reader, MAX_PAGE_BYTES, cancel)?;
        let html = String::from_utf8_lossy(&bytes).to_string();
        if looks_like_challenge(&html) {
            return Err(FetchError::Blocked("challenge page".to_string()));
        }
        return Ok((parsed, html));
    }
    Err(FetchError::Transport("too many redirects".to_string()))
}

// ---------------------------------------------------------------------------
// Site visits
// ---------------------------------------------------------------------------

/// One site's mining result, shared by every row that points at its domain.
pub struct SiteOutcome {
    pub emails: Vec<String>,
    pub socials: Vec<String>,
    pub source_url: String,
    pub status: &'static str,
    /// The run was cancelled while this site was being visited (R-02). Such a
    /// site is neither written back nor counted: its stored data must survive
    /// untouched, and the progress counters must not report a failure that
    /// never happened. Kept off the `status` vocabulary on purpose — the
    /// `email_status` column and the panel only know the four real outcomes.
    pub was_cancelled: bool,
}

impl SiteOutcome {
    fn empty(status: &'static str) -> SiteOutcome {
        SiteOutcome {
            emails: Vec::new(),
            socials: Vec::new(),
            source_url: String::new(),
            status,
            was_cancelled: false,
        }
    }

    fn cancelled() -> SiteOutcome {
        let mut outcome = SiteOutcome::empty(STATUS_ERROR);
        outcome.was_cancelled = true;
        outcome
    }
}

/// Whether a URL is a public http(s) target the miner may touch (R-05).
///
/// The `website` field comes from scraped third-party pages, so a malicious
/// row can aim the miner at the user's own network: loopback services, the
/// LAN, or the cloud metadata endpoint (`169.254.169.254`). Only public
/// http(s) hosts pass; redirect hops are checked with the same guard.
///
/// Known limits, documented on purpose: DNS rebinding (a public name that
/// resolves to a private address) cannot be seen here without a resolver, and
/// exotic IP spellings that `Url` keeps as domains (e.g. `0x7f.1`) are not
/// decoded. Both need a connecting-side check that the std stack cannot
/// express today; the guard still closes every direct and every redirect path.
fn is_safe_target(url: &Url) -> bool {
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    // Test-only escape hatch. The e2e fixture (`scripts/e2e/emails.mjs`) serves
    // from 127.0.0.2/3, which the guard below is supposed to reject. The flag is
    // read only in debug builds and only when the launcher sets it explicitly
    // (`cfg!` is a constant, so a release binary drops the branch entirely).
    if allow_private_targets() {
        return true;
    }
    match url.host() {
        Some(url::Host::Domain(domain)) => {
            let domain = domain.to_ascii_lowercase();
            if domain.is_empty() {
                return false;
            }
            // A trailing dot is legal DNS syntax; strip it for the checks.
            let domain = domain.strip_suffix('.').unwrap_or(&domain);
            if domain == "localhost" || domain.ends_with(".localhost") {
                return false;
            }
            // Private-network name suffixes. No public business site lives on
            // one of these, and the cost of a false negative here is a request
            // into the user's own network.
            const PRIVATE_SUFFIXES: [&str; 7] = [
                ".local", ".internal", ".lan", ".home", ".localdomain", ".intranet", ".corp",
            ];
            !PRIVATE_SUFFIXES
                .iter()
                .any(|suffix| domain.ends_with(suffix))
        }
        Some(url::Host::Ipv4(ip)) => !is_private_ipv4(ip),
        Some(url::Host::Ipv6(ip)) => !is_private_ipv6(ip),
        None => false,
    }
}

/// `PLACE_MILL_ALLOW_PRIVATE_TARGETS=1` in a debug build (R-05 test hook).
fn allow_private_targets() -> bool {
    cfg!(debug_assertions) && std::env::var("PLACE_MILL_ALLOW_PRIVATE_TARGETS").as_deref() == Ok("1")
}

fn is_private_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 0                                        // "this network" + unspecified
        || o[0] == 127                               // loopback
        || o[0] == 10                                // RFC1918
        || (o[0] == 172 && (16..=31).contains(&o[1])) // RFC1918
        || (o[0] == 192 && o[1] == 168)               // RFC1918
        || (o[0] == 169 && o[1] == 254)               // link-local, cloud metadata
        || (o[0] == 100 && (64..=127).contains(&o[1])) // CGNAT
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19)) // benchmarking
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)    // IETF protocol assignments
        || (o[0] == 192 && o[1] == 0 && o[2] == 2)    // TEST-NET-1
        || (o[0] == 198 && o[1] == 51 && o[2] == 100) // TEST-NET-2
        || (o[0] == 203 && o[1] == 0 && o[2] == 113)  // TEST-NET-3
        || (o[0] == 192 && o[1] == 88 && o[2] == 99)  // 6to4 relay anycast
        || (224..=239).contains(&o[0])                // multicast
        || o[0] >= 240                                // reserved + broadcast
}

fn is_private_ipv6(ip: std::net::Ipv6Addr) -> bool {
    let segments = ip.segments();
    ip.is_loopback()
        || ip.is_unspecified()
        || (segments[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
        || (segments[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
        || (segments[0] & 0xff00) == 0xff00 // multicast ff00::/8
        || (segments[0] == 0x2001 && segments[1] == 0x0db8) // documentation
        || (segments[0] == 0x0064 && segments[1] == 0xff9b) // NAT64 64:ff9b::/96
        || segments[0] == 0x2002            // 6to4 2002::/16 (embeds IPv4)
        || match ip.to_ipv4() {
            // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d).
            Some(v4) => is_private_ipv4(v4),
            None => false,
        }
}

/// URL candidates for a website cell. Most cells carry a bare host, so https
/// is tried first; a transport failure falls back to http exactly once.
/// Candidates that fail the SSRF guard (wrong scheme, private host) are
/// dropped here, so a hostile website cell yields zero requests (R-05).
pub fn site_candidates(website: &str) -> Vec<Url> {
    let trimmed = website.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Vec::new();
    }
    let parsed: Vec<Url> = if trimmed.contains("://") {
        Url::parse(trimmed).into_iter().collect()
    } else {
        ["https://", "http://"]
            .iter()
            .filter_map(|scheme| Url::parse(&format!("{}{}", scheme, trimmed)).ok())
            .collect()
    };
    parsed.into_iter().filter(is_safe_target).collect()
}

fn domain_key(url: &Url) -> String {
    registrable_domain(url.host_str().unwrap_or(""))
}

/// Registrable domain (eTLD+1) — the grouping key that makes "50 branches of
/// one bank" one visit instead of fifty. `locations.bankofamerica.com` and
/// `www.bankofamerica.com` collapse onto `bankofamerica.com`; IP hosts (loopback
/// fixtures, intranet) and unknown suffixes are never suffix-split.
///
/// P1-6: this used to be a hand-written 39-entry two-label table with a
/// "last two labels" fallback. That grouped every unrelated `.com.ru` site
/// under `com.ru` and every blog under `blogspot.com`, and the miner then wrote
/// one site's emails to all of them (see `group_by_domain` /
/// `update_email_mining`). The embedded Public Suffix List, including its
/// private section, is the only correct source for this boundary.
///
/// `pub(crate)` since G-04: the verifier's same-domain evidence compares the
/// address domain against the row's website with the same boundary, and two
/// eTLD+1 implementations would disagree on exactly the exotic suffixes this
/// comment is about.
pub(crate) fn registrable_domain(host: &str) -> String {
    let host = host.trim().trim_end_matches('.').to_lowercase();
    if host.is_empty() {
        return host;
    }
    // PSL answers `None` for an IP literal, but it does not always: it read
    // `127.0.0.2` as the domain `0.2`. IP hosts are their own grouping key.
    let numeric_labels = host
        .split('.')
        .all(|label| !label.is_empty() && label.chars().all(|c| c.is_ascii_digit()));
    if numeric_labels || host.starts_with('[') {
        return host;
    }
    psl::domain_str(&host)
        .map(str::to_string)
        .unwrap_or(host)
}

fn jitter_delay() -> Duration {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    Duration::from_millis(REQUEST_DELAY_MS + nanos % REQUEST_JITTER_MS)
}

fn wait_if_cancelled(duration: Duration, cancel: &AtomicBool) {
    let step = Duration::from_millis(100);
    let mut waited = Duration::ZERO;
    while waited < duration {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        std::thread::sleep(step.min(duration - waited));
        waited += step;
    }
}

// ---------------------------------------------------------------------------
// Politeness (R-20): per-domain pacing + robots.txt
// ---------------------------------------------------------------------------

/// The `User-agent: *` group of one robots.txt (R-20).
///
/// Deliberately minimal: prefix `Disallow` matching and `Crawl-delay`, which
/// is all a well-behaved visitor needs. Wildcards (`Disallow: /*.pdf`) are
/// ignored — a plain-prefix miss means we fetch a page the site would rather
/// not serve us, never that we fetch something forbidden outright, because the
/// common `Disallow: /` and directory-prefix forms do match exactly.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RobotsRules {
    disallow: Vec<String>,
    crawl_delay: Option<Duration>,
}

impl RobotsRules {
    fn parse(body: &str) -> RobotsRules {
        let mut in_star_group = false;
        let mut disallow = Vec::new();
        let mut crawl_delay = None;
        for raw_line in body.lines() {
            // Everything after `#` is a comment.
            let line = raw_line.split('#').next().unwrap_or("").trim();
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let key = key.trim().to_ascii_lowercase();
            let value = value.trim();
            match key.as_str() {
                // Only the `*` group applies: identifying as another agent
                // (say, Googlebot) to get better rules is not ours to do.
                "user-agent" => in_star_group = value.eq_ignore_ascii_case("*"),
                "disallow" if in_star_group && !value.is_empty() => {
                    disallow.push(value.to_string())
                }
                "crawl-delay" if in_star_group => {
                    if let Ok(seconds) = value.parse::<u64>() {
                        let seconds = seconds.clamp(0, 3_600);
                        crawl_delay = Some(Duration::from_secs(seconds));
                    }
                }
                _ => {}
            }
        }
        RobotsRules {
            disallow,
            crawl_delay,
        }
    }

    /// RFC 9309-style prefix check against the star group.
    fn is_allowed(&self, path_and_query: &str) -> bool {
        !self
            .disallow
            .iter()
            .any(|prefix| path_and_query.starts_with(prefix.as_str()))
    }

}

/// What one `scheme://host:port` said in its robots.txt.
///
/// The three cases are kept apart because they call for different behaviour:
/// `Rules`/`DenyAll` are answers about *this* site, while `Unreachable` only
/// says the file could not be read — a plain-HTTP server that fails the TLS
/// probe has an unreadable `https://` robots file, not a refusal, and the
/// miner must still be allowed to try the other scheme.
#[derive(Debug, Clone)]
enum CachedRobots {
    Rules(RobotsRules),
    DenyAll,
    Unreachable,
}

/// Interpret a failed robots.txt fetch.
///
/// RFC 9309: 4xx (other than auth/rate limits) means "unavailable" — allow all;
/// 5xx and transport failures mean "unreachable" — do not crawl, but do not
/// pretend the site forbade us either. Keeping auth/rate limits as a denial is
/// deliberate: a site that answers 403 to a polite bot is telling us to leave.
fn robots_on_fetch_error(error: &FetchError) -> CachedRobots {
    match error {
        FetchError::Status(404 | 410) => CachedRobots::Rules(RobotsRules {
            disallow: Vec::new(),
            crawl_delay: None,
        }),
        FetchError::Status(401 | 403 | 429) => CachedRobots::DenyAll,
        // A 5xx is "unreachable" for this run, not "gone".
        FetchError::Status(code) if (500..=599).contains(code) => CachedRobots::Unreachable,
        // Any other status is "unavailable" per RFC 9309.
        FetchError::Status(_) => CachedRobots::Rules(RobotsRules {
            disallow: Vec::new(),
            crawl_delay: None,
        }),
        FetchError::Blocked(_) | FetchError::Transport(_) | FetchError::Cancelled => {
            CachedRobots::Unreachable
        }
    }
}

/// Per-domain politeness state for one mining run (R-20).
///
/// The old code only delayed between contact pages *within* one site, so three
/// workers hit different sites back-to-back at network speed — and ignored
/// robots.txt entirely. Every request now goes through here: a per-domain
/// slot first (spaced by `REQUEST_DELAY_MS` + jitter, widened by the site's
/// own `Crawl-delay` when robots.txt asks for more), then the robots check.
struct Politeness<'a> {
    agent: &'a ureq::Agent,
    cancel: &'a AtomicBool,
    /// robots.txt per `scheme://host:port`. The key is the real host *and port*
    /// — robots.txt is host-specific, and two servers on one machine can be
    /// different sites (the e2e fixtures are exactly that).
    robots: Mutex<HashMap<String, CachedRobots>>,
    /// Next `Instant` each registrable domain may be contacted.
    next_slot: Mutex<HashMap<String, Instant>>,
}

/// `scheme://host:port/robots.txt` for a site URL.
///
/// Built from the URL itself, not from `host_str()`: a hand-formatted
/// `scheme://host/robots.txt` drops the port, so `127.0.0.2:14300` asked *:443*
/// for its rules and every site on a non-default port looked unreachable.
fn robots_url_for(base: &Url) -> Url {
    let mut url = base.clone();
    url.set_path("/robots.txt");
    url.set_query(None);
    url.set_fragment(None);
    url
}

/// Cache key for one robots file. The port is part of the origin, and two
/// servers on one host can be different sites (the e2e fixtures are exactly
/// that), so it must not be dropped here either.
fn robots_cache_key(base: &Url) -> String {
    format!(
        "{}://{}:{}",
        base.scheme(),
        base.host_str().unwrap_or(""),
        base.port_or_known_default().unwrap_or(0)
    )
}

impl Politeness<'_> {
    /// robots.txt answer for one scheme+host+port, fetched and cached on first
    /// contact.
    ///
    /// RFC 9309: a 4xx robots response means "unavailable" (allow all), while
    /// a 5xx / transport failure means "unreachable" (do not crawl). The old
    /// code turned every error into allow-all, which is how a broken site became
    /// an unlimited crawl target. One request per host per run is the cost of
    /// learning the rules.
    fn robots_for(&self, base: &Url) -> CachedRobots {
        let key = robots_cache_key(base);
        if let Ok(robots) = self.robots.lock() {
            if let Some(cached) = robots.get(&key) {
                return cached.clone();
            }
        }
        let robots_url = robots_url_for(base);
        let cached = match fetch_page(self.agent, robots_url.as_str(), self.cancel) {
            Ok((_final_url, body)) => CachedRobots::Rules(RobotsRules::parse(&body)),
            Err(error) => robots_on_fetch_error(&error),
        };
        if let Ok(mut robots) = self.robots.lock() {
            robots.insert(key, cached.clone());
        }
        cached
    }

    /// Wait until the domain's next slot is due, then claim it.
    fn acquire_slot(&self, domain: &str, base: &Url) {
        let crawl_delay = match self.robots_for(base) {
            CachedRobots::Rules(rules) => rules.crawl_delay,
            CachedRobots::DenyAll | CachedRobots::Unreachable => None,
        };
        loop {
            let due = {
                let Ok(mut slots) = self.next_slot.lock() else {
                    return;
                };
                let now = Instant::now();
                let claimed = slots.get(domain).copied().unwrap_or(now);
                if claimed <= now {
                    let spacing = crawl_delay.unwrap_or_default().max(jitter_delay());
                    slots.insert(domain.to_string(), now + spacing);
                    return;
                }
                claimed
            };
            wait_if_cancelled(due.saturating_duration_since(Instant::now()), self.cancel);
            if self.cancel.load(Ordering::Relaxed) {
                return;
            }
        }
    }

    /// Whether this URL may be fetched under the site's robots.txt. A missing
    /// robots file allows everything. RFC 9309 matches on path *and* query, so
    /// a `Disallow: /search?` style rule is honored too.
    fn robots_verdict(&self, url: &Url) -> RobotsVerdict {
        match self.robots_for(url) {
            CachedRobots::Rules(rules) => {
                let path_and_query = match url.query() {
                    Some(query) => format!("{}?{}", url.path(), query),
                    None => url.path().to_string(),
                };
                if rules.is_allowed(&path_and_query) {
                    RobotsVerdict::Allowed
                } else {
                    RobotsVerdict::Denied
                }
            }
            CachedRobots::DenyAll => RobotsVerdict::Denied,
            CachedRobots::Unreachable => RobotsVerdict::Unreachable,
        }
    }
}

/// The answer the caller acts on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RobotsVerdict {
    Allowed,
    /// The site forbade this path.
    Denied,
    /// robots.txt could not be read for this scheme; the other scheme may still
    /// answer (`https://` on a plain-HTTP server fails the handshake).
    Unreachable,
}

/// Visit one site. Homepage first; when no address is found there, up to
/// `MAX_CONTACT_PAGES` same-domain contact pages. Socials are collected from
/// every page that was fetched anyway. Every request goes through the
/// politeness gate first: a per-domain slot (R-20), then the robots.txt check.
fn mine_site(politeness: &Politeness, rules: &EmailRules, website: &str) -> SiteOutcome {
    let cancel = politeness.cancel;
    let candidates = site_candidates(website);
    if candidates.is_empty() {
        return SiteOutcome::empty(STATUS_ERROR);
    }

    let mut base: Option<(Url, String)> = None;
    // P2-9: distinguish "this site really is gone" from "the network/5xx was
    // transient". Only the latter is written as `STATUS_RETRYABLE` (empty), so
    // the next run will include the row again.
    let mut saw_permanent_failure = false;
    // Every candidate's robots.txt was unreadable: the site is off-limits for
    // this run (RFC 9309), and it is a block rather than a transient failure.
    let mut robots_unreachable = false;
    for url in &candidates {
        if cancel.load(Ordering::Relaxed) {
            return SiteOutcome::cancelled();
        }
        let domain = domain_key(url);
        politeness.acquire_slot(&domain, url);
        match politeness.robots_verdict(url) {
            RobotsVerdict::Allowed => {}
            RobotsVerdict::Denied => {
                log_info!(
                    "mining {}: not fetched (robots.txt)",
                    url.host_str().unwrap_or("")
                );
                return SiteOutcome::empty(STATUS_BLOCKED);
            }
            RobotsVerdict::Unreachable => {
                // Do not crawl a site whose rules could not be read, but do not
                // end the site on one scheme either: `https://host/robots.txt`
                // fails the handshake on a plain-HTTP server, while the http
                // candidate would answer normally.
                robots_unreachable = true;
                log_info!(
                    "mining {}: robots.txt unreachable over {}, trying the next target",
                    url.host_str().unwrap_or(""),
                    url.scheme()
                );
                continue;
            }
        }
        match fetch_page(politeness.agent, url.as_str(), cancel) {
            Ok((final_url, html)) => {
                // Relative contact links must resolve against where the page
                // actually landed, not the URL that started the redirect chain.
                base = Some((final_url, html));
                break;
            }
            Err(FetchError::Blocked(reason)) => {
                log_info!("mining {}: blocked ({})", url.host_str().unwrap_or(""), reason);
                return SiteOutcome::empty(STATUS_BLOCKED);
            }
            Err(FetchError::Cancelled) => return SiteOutcome::cancelled(),
            Err(FetchError::Status(code)) => {
                if matches!(code, 401 | 403 | 429) {
                    log_info!(
                        "mining {}: blocked (HTTP {})",
                        url.host_str().unwrap_or(""),
                        code
                    );
                    return SiteOutcome::empty(STATUS_BLOCKED);
                }
                if (500..=599).contains(&code) {
                    log_warn!(
                        "mining {}: HTTP {} (transient), trying next scheme",
                        url.host_str().unwrap_or(""),
                        code
                    );
                } else {
                    saw_permanent_failure = true;
                    log_warn!(
                        "mining {}: HTTP {} (permanent), trying next scheme",
                        url.host_str().unwrap_or(""),
                        code
                    );
                }
            }
            Err(FetchError::Transport(reason)) => {
                log_warn!(
                    "mining {}: fetch failed ({}), trying next scheme",
                    url.host_str().unwrap_or(""),
                    reason
                );
            }
        }
    }
    let Some((base_url, base_html)) = base else {
        return SiteOutcome::empty(if robots_unreachable {
            STATUS_BLOCKED
        } else if saw_permanent_failure {
            STATUS_ERROR
        } else {
            STATUS_RETRYABLE
        });
    };

    // R-21b: one parse, three queries. The page used to be re-scanned for
    // addresses, social links and contact links separately.
    let base_doc = PageDoc::parse(&base_html);
    // P2-9: rank the homepage addresses *before* deciding whether to visit
    // contact pages. A homepage that only carries a placeholder address
    // (`noreply@…`, `example@…`) used to look non-empty, so the real contact
    // page was never fetched.
    let site_domain = registrable_domain(base_url.host_str().unwrap_or(""));
    let mut emails = rank_emails(base_doc.emails(), &site_domain, &rules.blocklist);
    let mut socials = base_doc.socials(Some(&base_url));
    let mut source_url = if emails.is_empty() {
        String::new()
    } else {
        base_url.as_str().to_string()
    };

    if emails.is_empty() {
        let pages = base_doc.contact_pages(&base_url, &rules.contact_keywords);
        for page_url in pages {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let Ok(page) = Url::parse(&page_url) else { continue };
            let domain = domain_key(&page);
            politeness.acquire_slot(&domain, &page);
            if politeness.robots_verdict(&page) != RobotsVerdict::Allowed {
                continue;
            }
            match fetch_page(politeness.agent, &page_url, cancel) {
                Ok((final_url, page_html)) => {
                    let page_doc = PageDoc::parse(&page_html);
                    if emails.is_empty() {
                        let page_emails =
                            rank_emails(page_doc.emails(), &site_domain, &rules.blocklist);
                        if !page_emails.is_empty() {
                            emails = page_emails;
                            source_url = final_url.as_str().to_string();
                        }
                    }
                    for social in page_doc.socials(Some(&final_url)) {
                        if socials.len() >= MAX_SOCIALS_PER_SITE {
                            break;
                        }
                        if !socials.contains(&social) {
                            socials.push(social);
                        }
                    }
                }
                Err(_) => continue,
            }
        }
    }

    // Score the combined list once more: contact pages can contribute more
    // than one address, and `rank_emails` is also the dedupe pass.
    let emails = rank_emails(emails, &site_domain, &rules.blocklist);
    let status = if emails.is_empty() {
        STATUS_NONE_FOUND
    } else {
        STATUS_FOUND
    };
    SiteOutcome {
        emails,
        socials,
        source_url,
        status,
        was_cancelled: false,
    }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/// One mined domain and every row that shares it.
#[derive(Debug, Clone)]
pub struct MineTarget {
    pub place_ids: Vec<String>,
    pub website: String,
}

/// Group rows by normalized website domain so one visit covers all of them.
/// Rows without a parsable website are dropped here.
pub fn group_by_domain(rows: Vec<(String, String)>) -> Vec<MineTarget> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, MineTarget> = HashMap::new();
    for (place_id, website) in rows {
        if website.trim().is_empty() {
            continue;
        }
        let Some(url) = site_candidates(&website).into_iter().next() else {
            continue;
        };
        let key = domain_key(&url);
        if key.is_empty() {
            continue;
        }
        let entry = groups.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            MineTarget {
                place_ids: Vec::new(),
                website: website.clone(),
            }
        });
        entry.place_ids.push(place_id);
    }
    order
        .into_iter()
        .map(|key| groups.remove(&key).expect("tracked group"))
        .collect()
}

/// Rolling counters shared by the workers and the progress events.
#[derive(Debug, Default)]
pub struct MiningProgress {
    pub done: AtomicUsize,
    pub found: AtomicUsize,
    pub blocked: AtomicUsize,
    pub failed: AtomicUsize,
}

pub struct MineSummary {
    pub total: usize,
    pub done: usize,
    pub found: usize,
    pub blocked: usize,
    pub failed: usize,
    pub cancelled: bool,
}

/// Run the whole mining job on the calling thread (the command spawns this on
/// a worker). Concurrency is bounded and each domain is visited serially with
/// randomized delays; results are written through `update_email_mining` and a
/// `email:progress` event is emitted after every site.
pub fn run_mining(
    app: &tauri::AppHandle,
    targets: Vec<MineTarget>,
    rules: EmailRules,
    cancel: &AtomicBool,
) -> MineSummary {
    let total = targets.len();
    let queue: Mutex<VecDeque<MineTarget>> = Mutex::new(targets.into_iter().collect());
    let progress = Arc::new(MiningProgress::default());
    let agent = build_agent();
    let politeness = Politeness {
        agent: &agent,
        cancel,
        robots: Mutex::new(HashMap::new()),
        next_slot: Mutex::new(HashMap::new()),
    };
    // Watchdog (R-02): one wall-clock cap for the whole run, so a wedged
    // network condition that slips past the per-request timeouts still ends
    // the run and releases the single-flight slot.
    let run_deadline = Instant::now() + MAX_RUN_DURATION;

    std::thread::scope(|scope| {
        for _ in 0..GLOBAL_CONCURRENCY {
            scope.spawn(|| loop {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                // The watchdog cannot abort a socket that is already blocked,
                // but it sets the cancel flag, which every later check honors:
                // this loop, `read_body_limited` between chunks and
                // `wait_if_cancelled` between requests. The run therefore ends
                // at the next check instead of running on unbounded.
                if Instant::now() >= run_deadline {
                    log_warn!(
                        "mining run exceeded {}s, forcing stop (watchdog)",
                        MAX_RUN_DURATION.as_secs()
                    );
                    cancel.store(true, Ordering::Relaxed);
                    return;
                }
                let target = match queue.lock() {
                    Ok(mut guard) => guard.pop_front(),
                    Err(_) => return,
                };
                let Some(target) = target else { return };

                let outcome = mine_site(&politeness, &rules, &target.website);
                // Precise, not inferred: a site aborted mid-fetch reports
                // itself through `was_cancelled`, so a plain DNS failure that
                // happens while cancel is pending is still counted as a
                // failure instead of silently vanishing.
                let cancelled = outcome.was_cancelled;
                // C-03: "found" means the rows were written. A site whose
                // business rows were cleared or deleted mid-run matches
                // nothing, and reporting it as a find would put a number in
                // `email:done` that the table does not contain.
                let mut wrote = !cancelled;
                if !cancelled {
                    let state = app.state::<crate::AppState>();
                    let write = state.db.lock();
                    match write {
                        Ok(conn) => {
                            match crate::db::update_email_mining(
                                &conn,
                                &target.place_ids,
                                &outcome.emails,
                                &outcome.socials,
                                &outcome.source_url,
                                outcome.status,
                            ) {
                                Ok(0) => {
                                    wrote = false;
                                    log_warn!(
                                        "mining write matched no row for {}",
                                        target.website
                                    );
                                }
                                Ok(_) => {}
                                Err(error) => {
                                    wrote = false;
                                    log_warn!(
                                        "mining write failed for {}: {}",
                                        target.website, error
                                    );
                                }
                            }
                        }
                        Err(error) => {
                            wrote = false;
                            log_error!("mining db lock failed: {}", error);
                        }
                    }
                }

                if !cancelled {
                    if wrote {
                        match outcome.status {
                            STATUS_FOUND => {
                                progress.found.fetch_add(1, Ordering::Relaxed);
                            }
                            STATUS_BLOCKED => {
                                progress.blocked.fetch_add(1, Ordering::Relaxed);
                            }
                            STATUS_ERROR => {
                                progress.failed.fetch_add(1, Ordering::Relaxed);
                            }
                            STATUS_RETRYABLE => {
                                // The row stays unmined so the next run retries
                                // it, but the progress UI still reports a
                                // failure for this attempt.
                                progress.failed.fetch_add(1, Ordering::Relaxed);
                            }
                            _ => {}
                        }
                    } else {
                        // Work that could not be recorded is a failure, not a
                        // find and not a silent success.
                        progress.failed.fetch_add(1, Ordering::Relaxed);
                    }
                    progress.done.fetch_add(1, Ordering::Relaxed);
                }

                let done = progress.done.load(Ordering::Relaxed);
                let found = progress.found.load(Ordering::Relaxed);
                let blocked = progress.blocked.load(Ordering::Relaxed);
                let failed = progress.failed.load(Ordering::Relaxed);
                log_info!(
                    "mining {}/{}: {} -> {} ({} email(s))",
                    done,
                    total,
                    target.website,
                    outcome.status,
                    outcome.emails.len()
                );
                let _ = app.emit(
                    "email:progress",
                    serde_json::json!({
                        "done": done,
                        "total": total,
                        "found": found,
                        "blocked": blocked,
                        "failed": failed,
                        "current": target.website,
                    }),
                );
            });
        }
    });

    let done = progress.done.load(Ordering::Relaxed);
    MineSummary {
        total,
        done,
        found: progress.found.load(Ordering::Relaxed),
        blocked: progress.blocked.load(Ordering::Relaxed),
        failed: progress.failed.load(Ordering::Relaxed),
        cancelled: cancel.load(Ordering::Relaxed),
    }
}

// ---------------------------------------------------------------------------
// Tests — fixture HTML only, no network
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const CONTACT_PAGE: &str = r#"
        <html><head><style>body { font-family: 'a@b.com'; }</style>
        <script>var buildId = "ci@2024";</script></head>
        <body>
          <a href="/contact">Contact us</a>
          <a href="/about/team">About</a>
          <a href="https://other-site.com/contact">Other site</a>
          <a href="mailto:Info@DowntownDental.com">Mail</a>
          <p>Write to hello@downtowndental.com or call.</p>
          <a href="https://www.linkedin.com/company/downtown-dental">LinkedIn</a>
          <a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a>
          <a href="https://www.facebook.com/downtowndental">FB</a>
          <a href="https://www.instagram.com/downtowndental/">IG</a>
          <a href="https://twitter.com/intent/tweet?text=x">Intent</a>
          <a href="https://x.com/downtowndental">X</a>
        </body></html>"#;

    #[test]
    fn extracts_mailto_and_text_emails_but_not_script_or_style_noise() {
        let emails = extract_emails(CONTACT_PAGE);
        assert!(emails.contains(&"info@downtowndental.com".to_string()));
        assert!(emails.contains(&"hello@downtowndental.com".to_string()));
        // The style font and the script build id must not leak in.
        assert!(!emails.iter().any(|email| email.ends_with("b.com")));
        assert!(!emails.iter().any(|email| email.contains("ci@2024")));
    }

    #[test]
    fn asset_lookalikes_and_malformed_addresses_are_rejected() {
        let html = r#"<img src="logo@2x.png"> <span>logo@2x.png</span>
            <a href="mailto:office@dental.com">ok</a>
            <p>not-an-email@@broken and short@x</p>"#;
        let emails = extract_emails(html);
        assert_eq!(emails, vec!["office@dental.com".to_string()]);
    }

    #[test]
    fn obfuscated_addresses_are_a_last_resort() {
        let plain = "<p>mail us: hello@dental.com</p>";
        assert_eq!(extract_emails(plain), vec!["hello@dental.com".to_string()]);

        let obfuscated = "<p>mail us: hello [at] dental [dot] com</p>";
        assert_eq!(extract_emails(obfuscated), vec!["hello@dental.com".to_string()]);
    }

    #[test]
    fn socials_keep_profiles_and_drop_share_dialogs() {
        let socials = extract_socials(CONTACT_PAGE, None);
        assert_eq!(
            socials,
            vec![
                "https://www.linkedin.com/company/downtown-dental".to_string(),
                "https://www.facebook.com/downtowndental".to_string(),
                "https://www.instagram.com/downtowndental/".to_string(),
                "https://x.com/downtowndental".to_string(),
            ]
        );
    }

    #[test]
    fn contact_page_discovery_stays_on_domain_and_respects_keywords() {
        let base = Url::parse("https://downtowndental.com/").expect("base");
        let rules = EmailRules::default();
        let pages = discover_contact_pages(&base, CONTACT_PAGE, &rules.contact_keywords);
        assert_eq!(pages.len(), 2);
        assert!(pages[0].starts_with("https://downtowndental.com/contact"));
        assert!(pages[1].contains("/about/team"));
        // The other-domain link must never appear.
        assert!(!pages.iter().any(|page| page.contains("other-site.com")));
    }

    #[test]
    fn ranking_prefers_domain_match_and_role_mailboxes_and_applies_blocklist() {
        let blocklist = EmailRules::default().blocklist;
        let ranked = rank_emails(
            vec![
                "random.person@gmail.com".to_string(),
                "noreply@downtowndental.com".to_string(),
                "contact@downtowndental.com".to_string(),
                "team@downtown.org".to_string(),
            ],
            "downtowndental.com",
            &blocklist,
        );
        assert_eq!(ranked[0], "contact@downtowndental.com");
        assert!(ranked.contains(&"team@downtown.org".to_string()));
        assert!(!ranked.contains(&"noreply@downtowndental.com".to_string()));
    }

    #[test]
    fn grouping_merges_www_variants_and_drops_unparsable_websites() {
        let grouped = group_by_domain(vec![
            ("a".to_string(), "https://www.dental.com/clinic".to_string()),
            ("b".to_string(), "dental.com".to_string()),
            ("c".to_string(), String::new()),
            ("d".to_string(), "not a url at all".to_string()),
        ]);
        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[0].place_ids, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn branches_sharing_a_company_site_group_across_subdomains() {
        // A "bank" search returns branches whose rows carry the corporate
        // site, a locations subdomain, and a www variant — all one company.
        let grouped = group_by_domain(vec![
            ("branch-1".to_string(), "bankofamerica.com".to_string()),
            (
                "branch-2".to_string(),
                "https://www.bankofamerica.com/".to_string(),
            ),
            (
                "branch-3".to_string(),
                "https://locations.bankofamerica.com/ca/los-angeles".to_string(),
            ),
            // A different company stays separate.
            ("other".to_string(), "chase.com".to_string()),
        ]);
        assert_eq!(grouped.len(), 2);
        let bank = grouped
            .iter()
            .find(|target| target.place_ids.contains(&"branch-1".to_string()))
            .expect("bank group");
        assert_eq!(bank.place_ids, vec!["branch-1", "branch-2", "branch-3"]);
    }

    #[test]
    fn registrable_domain_handles_suffixes_ips_and_www() {
        assert_eq!(registrable_domain("www.bankofamerica.com"), "bankofamerica.com");
        assert_eq!(registrable_domain("locations.bankofamerica.com"), "bankofamerica.com");
        assert_eq!(registrable_domain("dental.co.uk"), "dental.co.uk");
        assert_eq!(registrable_domain("www.smiles.dental.co.uk"), "dental.co.uk");
        assert_eq!(registrable_domain("127.0.0.2"), "127.0.0.2");
        assert_eq!(registrable_domain("localhost"), "localhost");
        assert_eq!(registrable_domain(""), "");
    }

    /// P1-6: the old hand-written table grouped unrelated `.com.ru` sites under
    /// `com.ru` and every blog under `blogspot.com`. The PSL keeps both apart,
    /// so a mined site's contacts can no longer be written to another business.
    #[test]
    fn registrable_domain_uses_the_public_suffix_list() {
        assert_eq!(registrable_domain("a.com.ru"), "a.com.ru");
        assert_eq!(registrable_domain("b.com.ru"), "b.com.ru");
        assert_eq!(registrable_domain("foo.blogspot.com"), "foo.blogspot.com");
        assert_eq!(registrable_domain("bar.blogspot.com"), "bar.blogspot.com");
        assert_eq!(registrable_domain("x.github.io"), "x.github.io");
        assert_eq!(registrable_domain("shop.example.com.es"), "example.com.es");
        assert_eq!(registrable_domain("WWW.Example.COM."), "example.com");
        assert_eq!(registrable_domain("com.ru"), "com.ru");
    }

    #[test]
    fn shared_hosting_sites_are_not_grouped_together() {
        let grouped = group_by_domain(vec![
            ("a".to_string(), "https://foo.blogspot.com/".to_string()),
            ("b".to_string(), "https://bar.blogspot.com/".to_string()),
            ("c".to_string(), "https://a.com.ru/".to_string()),
            ("d".to_string(), "https://b.com.ru/".to_string()),
        ]);
        assert_eq!(grouped.len(), 4, "each private-suffix site stays separate");
    }

    // ----- read_body_limited (R-02): cancel-aware, size-capped body read -----

    /// Yields one byte per call and flips the cancel flag after `flip_after`
    /// reads — the test double for a server dribbling bytes while the user
    /// presses stop.
    struct DribbleReader {
        reads: u32,
        flip_after: u32,
        cancel: Arc<AtomicBool>,
    }

    impl Read for DribbleReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if buf.is_empty() {
                return Ok(0);
            }
            self.reads += 1;
            if self.reads > self.flip_after {
                self.cancel.store(true, Ordering::Relaxed);
            }
            buf[0] = b'x';
            Ok(1)
        }
    }

    #[test]
    fn body_read_returns_the_full_body_across_chunk_boundaries() {
        // Larger than one READ_CHUNK_BYTES, so the loop iterates several times.
        let body = vec![b'a'; 40_000];
        let cancel = AtomicBool::new(false);
        let read = read_body_limited(std::io::Cursor::new(body.clone()), MAX_PAGE_BYTES, &cancel)
            .expect("body");
        assert_eq!(read, body);
    }

    #[test]
    fn body_read_rejects_an_oversized_page_instead_of_truncating() {
        let body = vec![b'a'; MAX_PAGE_BYTES + 2];
        let cancel = AtomicBool::new(false);
        let error =
            read_body_limited(std::io::Cursor::new(body), MAX_PAGE_BYTES, &cancel).unwrap_err();
        assert!(matches!(error, FetchError::Transport(_)));
    }

    #[test]
    fn body_read_honours_a_cancel_that_is_already_set() {
        let cancel = AtomicBool::new(true);
        let error = read_body_limited(
            DribbleReader {
                reads: 0,
                flip_after: u32::MAX,
                cancel: Arc::new(AtomicBool::new(false)),
            },
            MAX_PAGE_BYTES,
            &cancel,
        )
        .unwrap_err();
        assert!(matches!(error, FetchError::Cancelled));
    }

    #[test]
    fn body_read_stops_when_the_cancel_flag_flips_mid_download() {
        let shared = Arc::new(AtomicBool::new(false));
        let error = read_body_limited(
            DribbleReader {
                reads: 0,
                flip_after: 5,
                cancel: Arc::clone(&shared),
            },
            MAX_PAGE_BYTES,
            &shared,
        )
        .unwrap_err();
        assert!(matches!(error, FetchError::Cancelled));
    }

    // ----- R-05: SSRF guard -----

    #[test]
    fn site_candidates_drop_private_and_non_http_targets() {
        assert!(site_candidates("file:///etc/passwd").is_empty());
        assert!(site_candidates("ftp://example.com").is_empty());
        assert!(site_candidates("http://127.0.0.1:8080/admin").is_empty());
        assert!(site_candidates("https://169.254.169.254/latest/meta-data/").is_empty());
        assert!(site_candidates("http://192.168.1.10/").is_empty());
        assert!(site_candidates("http://10.0.0.5/").is_empty());
        assert!(site_candidates("http://localhost:3000").is_empty());
        assert!(site_candidates("https://printer.local").is_empty());
        assert!(site_candidates("http://[::1]/").is_empty());
        assert!(site_candidates("http://[fc00::1]/").is_empty());
        assert!(site_candidates("http://[::ffff:192.168.0.1]/").is_empty());
        // P2-10: NAT64, 6to4, multicast, documentation and TEST-NET ranges.
        assert!(site_candidates("http://[64:ff9b::7f00:1]/").is_empty());
        assert!(site_candidates("http://[2002:7f00:1::]/").is_empty());
        assert!(site_candidates("http://[ff02::1]/").is_empty());
        assert!(site_candidates("http://[2001:db8::1]/").is_empty());
        assert!(site_candidates("http://224.0.0.1/").is_empty());
        assert!(site_candidates("http://192.0.2.1/").is_empty());
        assert!(site_candidates("http://198.51.100.1/").is_empty());
        assert!(site_candidates("http://203.0.113.1/").is_empty());
    }

    #[test]
    fn site_candidates_still_accept_public_sites() {
        let bare = site_candidates("downtowndental.com");
        assert_eq!(bare.len(), 2, "https first, http fallback");
        assert_eq!(bare[0].as_str(), "https://downtowndental.com/");
        assert_eq!(bare[1].as_str(), "http://downtowndental.com/");

        let explicit = site_candidates("https://www.downtowndental.com/clinic");
        assert_eq!(explicit.len(), 1);
        assert_eq!(
            explicit[0].as_str(),
            "https://www.downtowndental.com/clinic"
        );
    }

    // ----- R-20: robots.txt -----

    #[test]
    fn robots_rules_parse_the_star_group_and_ignore_other_agents() {
        let rules = RobotsRules::parse(
            "User-agent: Googlebot\r\nDisallow: /\r\n\r\n# comment\r\n\
             User-agent: *\r\nDisallow: /admin # keep out\r\nDisallow:\r\n\
             Crawl-delay: 7\r\n",
        );
        assert_eq!(rules.crawl_delay, Some(Duration::from_secs(7)));
        assert_eq!(rules.disallow, vec!["/admin".to_string()]);
        assert!(rules.is_allowed("/contact"));
        assert!(rules.is_allowed("/"));
        assert!(!rules.is_allowed("/admin/users"));
    }

    #[test]
    fn robots_rules_block_everything_when_the_root_is_disallowed() {
        let rules = RobotsRules::parse("User-agent: *\nDisallow: /\n");
        assert!(!rules.is_allowed("/"));
        assert!(!rules.is_allowed("/anything"));

        // Missing rules (no robots.txt) allow everything.
        let empty = RobotsRules::parse("");
        assert!(empty.is_allowed("/"));
    }

    /// P2-9: RFC 9309 distinguishes "unavailable" (4xx, allow) from
    /// "unreachable" (5xx/transport, do not crawl). The old code allowed both,
    /// and the three cases stay distinguishable here because the caller tries
    /// the other scheme before giving up on a site.
    #[test]
    fn robots_fetch_failures_follow_rfc_9309() {
        let allow_all = |cached: CachedRobots| match cached {
            CachedRobots::Rules(rules) => rules.is_allowed("/"),
            other => panic!("expected allow-all rules, got {:?}", other),
        };
        assert!(allow_all(robots_on_fetch_error(&FetchError::Status(404))));
        assert!(allow_all(robots_on_fetch_error(&FetchError::Status(400))));

        for code in [401, 403, 429] {
            assert!(
                matches!(
                    robots_on_fetch_error(&FetchError::Status(code)),
                    CachedRobots::DenyAll
                ),
                "HTTP {code} must deny the site"
            );
        }
        for code in [500, 502, 503] {
            assert!(
                matches!(
                    robots_on_fetch_error(&FetchError::Status(code)),
                    CachedRobots::Unreachable
                ),
                "HTTP {code} must be unreachable, not a refusal"
            );
        }
        assert!(matches!(
            robots_on_fetch_error(&FetchError::Transport("dns".into())),
            CachedRobots::Unreachable
        ));
        assert!(matches!(
            robots_on_fetch_error(&FetchError::Blocked("challenge".into())),
            CachedRobots::Unreachable
        ));
    }

    /// The robots URL is built from the site URL, so it must keep the port: a
    /// hand-formatted `scheme://host/robots.txt` asked port 443 for the rules of
    /// a server on `:14300`, every such site looked unreachable, and the
    /// documented `https`-then-`http` fallback never ran.
    #[test]
    fn the_robots_url_keeps_the_port_and_drops_the_path() {
        let base = Url::parse("http://127.0.0.2:14300/contact?x=1").expect("url");
        assert_eq!(
            robots_url_for(&base).as_str(),
            "http://127.0.0.2:14300/robots.txt"
        );
        // A plain host keeps the default port out of the URL but not out of the
        // cache key, so `:80` spelled out and `:80` implied share one entry.
        let plain = Url::parse("https://downtowndental.com/about").expect("url");
        assert_eq!(
            robots_url_for(&plain).as_str(),
            "https://downtowndental.com/robots.txt"
        );
        assert_eq!(robots_cache_key(&plain), "https://downtowndental.com:443");
        assert_ne!(robots_cache_key(&base), robots_cache_key(&plain));
    }

    /// P2-9: an HTTP failure keeps its code until the caller decides whether it
    /// is a transient/retryable failure or a permanent one.
    #[test]
    fn http_failures_keep_their_status_code() {
        assert!(matches!(classify_status(418), FetchError::Status(418)));
        assert!(matches!(classify_status(503), FetchError::Status(503)));
    }

    // ----- R-21: social extraction -----

    #[test]
    fn social_suffix_spoofing_is_rejected() {
        // `notlinkedin.com` used to match `ends_with("linkedin.com")`.
        let spoof = extract_socials(
            r#"<a href="https://notlinkedin.com/company/foo">fake</a>"#,
            None,
        );
        assert!(spoof.is_empty());

        let real = extract_socials(
            r#"<a href="https://www.linkedin.com/company/downtown-dental">real</a>"#,
            None,
        );
        assert_eq!(
            real,
            vec!["https://www.linkedin.com/company/downtown-dental".to_string()]
        );
    }

    #[test]
    fn relative_social_links_resolve_against_the_page() {
        let base = Url::parse("https://downtowndental.com/").expect("base");
        // Protocol-relative hrefs are common in the wild and `Url::parse` on
        // the raw attribute rejects them outright; `base.join` resolves them.
        let socials = extract_socials(
            r#"<a href="//www.linkedin.com/company/downtown-dental">LinkedIn</a>"#,
            Some(&base),
        );
        assert_eq!(
            socials,
            vec!["https://www.linkedin.com/company/downtown-dental".to_string()]
        );
    }

    // ----- R-21b: malformed markup the regexes got wrong -----

    fn base() -> Url {
        Url::parse("https://downtowndental.com/").expect("base")
    }

    #[test]
    fn an_unquoted_uppercase_href_is_still_a_link() {
        // The old `href\s*=\s*["']` regex required quotes and lowercase `href`,
        // so both of these were invisible: one contact page lost, one social
        // profile lost, on pages that are perfectly valid HTML5.
        let html = r#"
            <A HREF=/contact>Contact us</A>
            <a href=https://www.linkedin.com/company/downtown-dental>LinkedIn</a>"#;
        let pages = discover_contact_pages(&base(), html, &["contact".to_string()]);
        assert_eq!(pages, vec!["https://downtowndental.com/contact".to_string()]);

        let socials = extract_socials(html, Some(&base()));
        assert_eq!(
            socials,
            vec!["https://www.linkedin.com/company/downtown-dental".to_string()]
        );
    }

    #[test]
    fn an_angle_bracket_inside_an_attribute_does_not_break_the_anchor() {
        // `[^>]*` stopped at the `>` inside `title`, so the href was cut off and
        // the page was skipped.
        let html = r#"<a title="a > b" href="/contact">Contact</a>"#;
        let pages = discover_contact_pages(&base(), html, &["contact".to_string()]);
        assert_eq!(pages, vec!["https://downtowndental.com/contact".to_string()]);
    }

    #[test]
    fn anchors_inside_comments_are_not_contact_candidates() {
        // `discover_contact_pages` used to run on the raw source without any
        // noise pass, so a commented-out template counted as a real link.
        let html = r#"
            <!-- <a href="/contact">Contact</a> -->
            <a href="/about">About</a>"#;
        let pages = discover_contact_pages(&base(), html, &["contact".to_string()]);
        assert!(pages.is_empty(), "{:?}", pages);
    }

    #[test]
    fn anchors_inside_scripts_are_not_contact_candidates() {
        let html = r#"
            <script>var tpl = '<a href="/contact">Contact</a>';</script>
            <a href="/about">About</a>"#;
        let pages = discover_contact_pages(&base(), html, &["contact".to_string()]);
        assert!(pages.is_empty(), "{:?}", pages);
    }

    #[test]
    fn entities_in_a_contact_href_are_decoded() {
        // The raw attribute carried `&amp;`; `Url::parse` accepts it as text, so
        // the old code produced a URL that no request would ever match.
        let html = r#"<a href="/contact?a=1&amp;b=2">Contact</a>"#;
        let pages = discover_contact_pages(&base(), html, &["contact".to_string()]);
        assert_eq!(
            pages,
            vec!["https://downtowndental.com/contact?a=1&b=2".to_string()]
        );
    }

    #[test]
    fn template_content_is_not_mined() {
        // `<template>` is inert markup the browser never shows. The old
        // `strip_noise` only handled script/style/comment/noscript, so a
        // template holding a ghost social link and a placeholder address was
        // mined as if it were real.
        let html = r#"
            <template>
              <a href="https://www.linkedin.com/company/ghost">Ghost</a>
              <p>ghost@example.com</p>
            </template>
            <p>Write to hello@downtowndental.com</p>"#;
        assert!(extract_socials(html, None).is_empty());
        assert_eq!(
            extract_emails(html),
            vec!["hello@downtowndental.com".to_string()]
        );
    }

    #[test]
    fn nested_inline_markup_keeps_the_contact_keyword() {
        // `a.text()` walks the subtree, so a styled anchor still matches even
        // when the keyword is split across tags.
        let html = r#"<a href="/reach-us"><span>Con</span><b>tact</b></a>"#;
        let pages = discover_contact_pages(&base(), html, &["contact".to_string()]);
        assert_eq!(pages, vec!["https://downtowndental.com/reach-us".to_string()]);
    }
}
