use logging::{log_debug, log_error, log_info, log_warn};
use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Listener, Manager};

mod collector;
mod commands;
mod db;
mod email_miner;
mod grid;
mod logging;
mod remote_config;
mod settings;

pub use commands::*;
use settings::Settings;

pub const DEFAULT_SPLIT_RATIO: f64 = 0.46;
pub const MIN_SPLIT_RATIO: f64 = 0.26;
pub const MAX_SPLIT_RATIO: f64 = 0.80;

/// One entry of the "about" block (M8 / J-08c).
///
/// Google's search payload carries label/value pairs, e.g.
/// `["accessibility", "Accessibility"]`. The payment methods gosom reads
/// live on the detail page; the search payload carries accessibility and
/// similar labels.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AboutEntry {
    pub key: String,
    pub label: String,
}

/// Opening hours for one weekday (M8 / J-08c).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenHoursDay {
    /// "Monday" .. "Sunday", spelled the way Google's payload spells it.
    pub day: String,
    /// The periods, e.g. `["9 AM – 5 PM"]`. Empty means closed that day.
    pub periods: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Business {
    pub name: String,
    pub address: String,
    pub phone: String,
    pub rating: f64,
    pub reviews_total: u32,
    pub lat: f64,
    pub lng: f64,
    pub place_id: String,
    pub website: String,
    pub types: Vec<String>,
    /// Epoch milliseconds of the first write (UI-03). Assigned by Rust in
    /// `store_businesses`, never taken from the script; `0` on rows collected
    /// before the field shipped. `serde(default)` keeps the script payload,
    /// which does not send it, deserializing.
    #[serde(default)]
    pub collected_at: u64,
    /// Search that produced the row. `store_businesses` fills it from the batch
    /// metadata when the script does not provide one; empty on legacy rows.
    #[serde(default)]
    pub source_query: String,
    /// Mined contact data (M7 / G-03). JSON arrays; a row that was never mined
    /// is indistinguishable from one that yielded nothing (`email_status` ""
    /// means "not mined yet", which is also how the miner skips its targets).
    #[serde(default)]
    pub emails: Vec<String>,
    #[serde(default)]
    pub socials: Vec<String>,
    #[serde(default)]
    pub email_source_url: String,
    #[serde(default)]
    pub email_status: String,
    #[serde(default)]
    pub mined_at: u64,
    // ===== M8 / J-08c =====
    //
    // The fields the index probe confirmed as filled in the *search* payload
    // (`docs/field-index-map.md` §2). They arrive from the script and get
    // their own columns; a row collected before the migration keeps them
    // empty.
    /// Street part of the structured address.
    #[serde(default)]
    pub street: String,
    #[serde(default)]
    pub city: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub postal_code: String,
    #[serde(default)]
    pub country: String,
    #[serde(default)]
    pub borough: String,
    /// IANA time zone, e.g. "America/Los_Angeles".
    #[serde(default)]
    pub timezone: String,
    /// Google's internal place id ("0x…:0x…") — a cross-source key that does
    /// not change when the place moves.
    #[serde(default)]
    pub data_id: String,
    /// Link to the reviews page.
    #[serde(default)]
    pub reviews_link: String,
    #[serde(default)]
    pub thumbnail: String,
    /// The owner behind the listing, without Google's role tag.
    #[serde(default)]
    pub owner_name: String,
    #[serde(default)]
    pub about: Vec<AboutEntry>,
    #[serde(default)]
    pub open_hours: Vec<OpenHoursDay>,
    // ===== Tier-2 detail enrichment (2026-10-26) =====
    //
    // The fields the search payload never fills (field-index-map §6.8); the
    // enrichment runner writes them after a place-page visit. Empty on rows
    // that were never enriched — the search path keeps them untouched.
    /// Open Location Code, e.g. "74GC+2V San Jose, California".
    #[serde(default)]
    pub plus_code: String,
    /// The place's own long description ([32][1][1]); business-type dependent.
    #[serde(default)]
    pub description: String,
    /// Review counts per star, index 0 = 1-star … index 4 = 5-star.
    #[serde(default)]
    pub reviews_per_rating: Vec<u32>,
    /// Photo URLs from the detail payload, deduplicated (multi-container).
    #[serde(default)]
    pub photos: Vec<String>,
}

/// What `clear_data` captured so `undo_clear` can put it back (UI-02b).
///
/// The rows themselves live in `*_backup` tables inside the database (R-13);
/// this record only says a snapshot exists, how big it was, and when it was
/// taken — the 10 s window is checked against `cleared_at`, and the snapshot
/// dies with the process exactly like the memory-based one did.
#[derive(Clone)]
pub struct ClearBackup {
    pub row_count: usize,
    pub cleared_at: std::time::Instant,
}

/// Runtime counters shown in the diagnostics drawer.
#[derive(Debug, Clone, Default, Serialize)]
pub struct CollectorStats {
    pub events: u64,
    pub records: u64,
    pub new_records: u64,
    /// Rows discarded before storage (UI-09): the "only with phone" switch and
    /// the R-26 ingress guard. Part of the session summary, so it lives next to
    /// the counters it must agree with.
    pub dropped: u64,
    pub last_event_at: Option<u64>,
    pub last_error: Option<String>,
}

/// Live per-batch figures behind the session summary (UI-09).
///
/// Emitted next to `businesses:updated` from the same `store_businesses` call,
/// so the panel's running totals and the diagnostics drawer's session counters
/// cannot drift apart: one source, two consumers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectorBatch {
    /// Rows in the batch as it arrived, before any filtering.
    pub received: usize,
    /// Rows that were new to the database.
    pub inserted: usize,
    /// Rows discarded before storage: the "only with phone" switch, the
    /// ingress guard and the rate limit (R-26).
    pub dropped: usize,
}

/// Sliding window over the batches the maps webview may send (R-26).
///
/// The page holds `core:event:allow-emit`, so `business-data` is reachable by
/// any script that ends up there. The injected collector sends 20-row batches
/// every few seconds; the budget below is far above that and only trips on a
/// runaway or hostile producer.
#[derive(Default)]
pub struct BatchWindow {
    started: Option<std::time::Instant>,
    rows: usize,
    batches: usize,
    reported: bool,
}

/// How long one rate-limit window lasts.
const BATCH_WINDOW: Duration = Duration::from_secs(10);
/// Batches accepted per window. A full page scroll produces a few dozen.
const MAX_BATCHES_PER_WINDOW: usize = 200;
/// Rows accepted per window.
const MAX_ROWS_PER_WINDOW: usize = 5_000;

impl BatchWindow {
    /// Reserve `rows` inside the current window. `false` when the sender has
    /// exhausted the budget, in which case the caller drops the whole batch.
    fn admit(&mut self, rows: usize) -> bool {
        let now = std::time::Instant::now();
        let expired = self
            .started
            .map(|started| now.duration_since(started) >= BATCH_WINDOW)
            .unwrap_or(true);
        if expired {
            self.started = Some(now);
            self.rows = 0;
            self.batches = 0;
            self.reported = false;
        }
        if self.batches >= MAX_BATCHES_PER_WINDOW || self.rows + rows > MAX_ROWS_PER_WINDOW {
            return false;
        }
        self.batches += 1;
        self.rows += rows;
        true
    }

    /// True at most once per window, so a flood cannot spam the diagnostics.
    fn should_report(&mut self) -> bool {
        if self.reported {
            return false;
        }
        self.reported = true;
        true
    }
}

/// Who currently owns the Maps pane (P2-1).
///
/// Five commands replace the Maps document, and they must not do it at the same
/// time. The three that own the pane for a while (a grid job, the enrichment
/// runner, a reviews fetch) used to check three separate slots and then claim
/// their own — two different commands could both pass the check and both
/// navigate the pane. `claim_pane` makes the check and the claim one step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaneOwner {
    /// A grid job, by id.
    Job(String),
    /// The Tier-2 enrichment runner.
    Enrich,
    /// A reviews fetch.
    Reviews,
}

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    /// Persisted preferences. The single source of truth: the frontend and the
    /// injected maps script only hold copies.
    ///
    /// Lock order: never hold this lock while acquiring `db` or `stats`.
    /// Clone the value out first (see `update_settings`).
    pub settings: Mutex<Settings>,
    /// Serializes read-modify-write sequences on `settings` (`update_settings`,
    /// `reset_settings`, `remember_export`). The commands take this before
    /// snapshotting so a concurrent export cannot write a stale copy over a
    /// setting change (P2-11).
    pub settings_write: Mutex<()>,
    /// One export at a time (P2-12). Two concurrent exports could resolve the
    /// same `-1` path and the later rename would truncate the earlier file.
    pub export_in_flight: AtomicBool,
    pub split_ratio: Mutex<f64>,
    /// Maps pane collapsed to 1px (UI-11). Independent of `split_ratio`:
    /// restoring brings back the ratio the user dragged to.
    pub map_collapsed: Mutex<bool>,
    /// Whether a collecting session is active. Owned by the runner (see
    /// `collector::spawn_runner`); every write goes through
    /// `commands::apply_listening`.
    pub listening: Mutex<bool>,
    /// When the switch last went off, so a batch that was already parsed when
    /// the user stopped still lands (see `store_businesses`). Cleared when a
    /// new session starts, so the grace can never outlive its session.
    pub switch_off_at: Mutex<Option<std::time::Instant>>,
    /// Start of the current collecting session, epoch ms. Kept across a panel
    /// reload so the header clock and the "this session" filter keep their
    /// origin instead of snapping to the app start.
    pub session_started_at: Mutex<Option<u64>>,
    pub stats: Mutex<CollectorStats>,
    pub db_path: String,
    /// Job whose tiles are being scrolled right now; `None` between jobs.
    pub active_job: Mutex<Option<collector::ActiveJob>>,
    /// Single runner slot: the maps webview can only scroll one job at a time.
    pub active_runner: Mutex<Option<String>>,
    /// Lifecycle events from the injected script, consumed by the job runner.
    pub grid_signal: Mutex<collector::GridSignal>,
    /// Last map centre reported by the Maps page (needed to seed a grid job).
    pub map_view: Mutex<Option<collector::MapView>>,
    /// Validated remote field map (M5). `None` until a config passes
    /// validation; cleared again when the script reports a parse degradation.
    pub remote_field_map: Mutex<Option<remote_config::RemoteFieldMap>>,
    /// When the last degradation-driven refetch ran, so a burst of empty
    /// batches cannot hammer GitHub Pages.
    pub parse_degraded_at: Mutex<Option<std::time::Instant>>,
    /// Cancel flag of the running site-mining job (M7). `Some` while mining;
    /// single-flight: a second `start_email_mining` is refused until it is
    /// cleared.
    pub email_mining: Mutex<Option<Arc<AtomicBool>>>,
    /// Cancel flag of the running detail-enrichment job (Tier-2). Same
    /// single-flight contract as `email_mining`: the runner owns the maps
    /// pane for the whole batch, so a second `enrich_businesses` is refused
    /// until the flag is cleared.
    pub enrich_job: Mutex<Option<Arc<AtomicBool>>>,
    /// The single owner of the Maps pane (P2-1). Every claim and every refusal
    /// reads this slot; `active_runner` / `enrich_job` / `review_fetch` stay as
    /// the operational state of each owner.
    pub pane_owner: Mutex<Option<PaneOwner>>,
    /// Set while a reviews fetch owns the maps pane (M9 / C-01).
    ///
    /// The fetch is a hard navigation plus a timed sequence of evals
    /// (~12 s) running on its own thread; for that whole window the document
    /// can be replaced by any other pane-owning command, and the sequence
    /// would then read *that* page's state and store its reviews under the
    /// place id it was asked for. This flag is what lets the other four
    /// entry points refuse instead (see `commands::check_pane`).
    ///
    /// A plain flag rather than a cancel token: the sequence is short and has
    /// no cancellation UI, so there is nothing for a token to interrupt.
    pub review_fetch: Mutex<bool>,
    /// Latest `enrich:payload` answer from the maps page (Tier-2), keyed by
    /// the request sequence the runner stamped on its eval. The page can only
    /// answer through an event (webview `eval` returns nothing), so the
    /// runner polls this slot instead.
    pub enrich_payload: Mutex<Option<(u64, serde_json::Value)>>,
    /// Rolling window of `query_businesses` timings (M6 / J-06d). Nothing is
    /// persisted: the figure answers "is the panel still fast right now".
    pub query_latency: Mutex<std::collections::VecDeque<u64>>,
    /// Filter-independent half of a page query (R-14), keyed by the
    /// connection's write counter — see `db::DashboardCache`.
    pub dashboard: Mutex<db::DashboardCache>,
    /// Snapshot of the last `clear_data`, for `undo_clear` (UI-02b).
    pub clear_backup: Mutex<Option<ClearBackup>>,
    /// Rate budget for `business-data` (R-26).
    pub batch_window: Mutex<BatchWindow>,
    /// Independent rate budget for `business-reviews` (M9). Reviews arrive in
    /// tiny batches (one place at a time, a handful of rows), but the event is
    /// as reachable from the page as `business-data` is, so it gets its own
    /// window rather than sharing — a review flood must not starve the
    /// collector, and vice versa.
    pub reviews_window: Mutex<BatchWindow>,
    /// Set once the panel answered the close prompt. From then on the window's
    /// X is ignored, so `app.exit` and a second `CloseRequested` cannot race
    /// into a second prompt the user has already dismissed.
    pub closing: AtomicBool,
    /// Probe run in flight (§5.8 A1): the job id whose runner should pause
    /// right after its FIRST tile finishes. Set by `start_job(probe)`, cleared
    /// by the runner itself when it honours it — so a later resume continues
    /// with the full grid. One slot: the runner is single-flight anyway.
    pub probe_limit: Mutex<Option<String>>,
    /// Last time a blocking `maps:health` state (consent/captcha) paused the
    /// running task (P1-2). The page reports every state *change*, so a page
    /// flapping between two states would otherwise pause on each report.
    pub health_blocked_at: Mutex<Option<std::time::Instant>>,
    /// Bumped by `clear_data` (P1-4). The page stamps every batch it sends with
    /// the epoch it was collecting under; a batch produced before the clear is
    /// refused even though it arrives while the 3 s switch-off grace is still
    /// open. Without it, "cleared" could mean "cleared, then grew three rows".
    pub collection_epoch: std::sync::atomic::AtomicU64,
}

/// How many query timings the p95 window keeps. 50 covers a page of browsing
/// while still reacting to a regression within a few seconds.
pub const QUERY_SAMPLES: usize = 50;

impl AppState {
    pub fn record_query(&self, millis: u64) {
        let Ok(mut window) = self.query_latency.lock() else {
            return;
        };
        window.push_back(millis);
        while window.len() > QUERY_SAMPLES {
            window.pop_front();
        }
    }

    /// Nearest-rank p95; `None` until at least one query has run.
    pub fn query_p95(&self) -> Option<u64> {
        let Ok(window) = self.query_latency.lock() else {
            return None;
        };
        if window.is_empty() {
            return None;
        }
        let mut sorted: Vec<u64> = window.iter().copied().collect();
        sorted.sort_unstable();
        let rank = ((sorted.len() as f64 * 0.95).ceil() as usize).clamp(1, sorted.len());
        Some(sorted[rank - 1])
    }

    pub fn query_samples(&self) -> usize {
        self.query_latency.lock().map(|window| window.len()).unwrap_or(0)
    }

    pub fn record_batch(&self, received: usize, inserted: usize, dropped: usize) {
        if let Ok(mut s) = self.stats.lock() {
            s.events += 1;
            s.records += received as u64;
            s.new_records += inserted as u64;
            s.dropped += dropped as u64;
            s.last_event_at = Some(now_ms());
        }
    }

    pub fn record_error(&self, msg: impl Into<String>) {
        if let Ok(mut s) = self.stats.lock() {
            s.last_error = Some(msg.into());
        }
    }

    pub fn reset_stats(&self) {
        if let Ok(mut s) = self.stats.lock() {
            *s = CollectorStats::default();
        }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Width of the collapsed maps pane (UI-11). 1px, never 0: WebView2's behaviour
/// at a zero size is undefined, and a hidden-but-alive webview keeps collecting.
const COLLAPSED_MAP_WIDTH: u32 = 1;

/// Resize the two webviews from the current state: `split_ratio` plus the
/// collapsed flag (UI-11).
///
/// Every geometry change funnels through here — drag, window resize, startup,
/// collapse/restore — so the four can never disagree about what the panes are.
pub fn apply_split_layout(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let ratio = state
        .split_ratio
        .lock()
        .map(|value| *value)
        .unwrap_or(DEFAULT_SPLIT_RATIO);
    let collapsed = state
        .map_collapsed
        .lock()
        .map(|value| *value)
        .unwrap_or(false);

    // Look the window up with `get_window`, NOT `get_webview_window`:
    // `Manager::get_webview_window(label)` resolves the webview and then requires
    // `Window::is_webview_window()`, which is `webviews().all(|w| w.label() ==
    // window.label())`. As soon as `add_child("maps")` attaches a second webview
    // to this window, that check is false forever, so `get_webview_window("main")`
    // returns None — the split handle then silently does nothing ("main window not
    // found"). `get_window` keys off the window map and is not affected.
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    // P3-10: a minimized window can report a 0×0 inner size; setting the
    // webviews to zero is undefined in WebView2 and contradicts the "never 0"
    // rule that `COLLAPSED_MAP_WIDTH` exists for.
    if size.width < 2 || size.height < 2 {
        return Ok(());
    }

    let (main_w, maps_w) = if collapsed {
        (
            size.width.saturating_sub(COLLAPSED_MAP_WIDTH),
            COLLAPSED_MAP_WIDTH,
        )
    } else {
        let ratio = ratio.clamp(MIN_SPLIT_RATIO, MAX_SPLIT_RATIO);
        let main_w = ((size.width as f64 * ratio).round() as u32)
            .min(size.width.saturating_sub(1));
        (main_w, size.width.saturating_sub(main_w))
    };

    if let Some(panel) = window.get_webview("main") {
        panel
            .set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
                main_w,
                size.height,
            )))
            .map_err(|e| e.to_string())?;
    } else {
        // Silently skipping here would look exactly like "the handle does nothing".
        log_warn!("apply_split_layout: panel webview 'main' not found");
    }
    if let Some(maps) = window.get_webview("maps") {
        maps.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            main_w as i32,
            0,
        )))
        .map_err(|e| e.to_string())?;
        maps.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
            maps_w,
            size.height,
        )))
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Resize the two webviews so that the React panel occupies `ratio` of the window.
pub fn apply_split(app: &tauri::AppHandle, ratio: f64) -> Result<(), String> {
    if let Ok(mut current) = app.state::<AppState>().split_ratio.lock() {
        *current = ratio.clamp(MIN_SPLIT_RATIO, MAX_SPLIT_RATIO);
    }
    apply_split_layout(app)
}

/// JavaScript that pushes the collector settings into the maps webview.
///
/// One builder for every call site (`on_page_load`, `push_collector_settings`
/// and `update_settings`) so the copies can never disagree. When a navigation
/// is requested it is appended to the *same* script, after the settings: the
/// new document must boot with the new values, otherwise it runs one round
/// with the previous delay.
pub fn collector_settings_script(
    settings: &Settings,
    field_map: Option<&remote_config::RemoteFieldMap>,
    reload_url: Option<&str>,
    enabled: bool,
    start_scroll: bool,
    epoch: u64,
) -> String {
    let mut payload = settings.collector_payload();
    if let (Some(remote), Some(object)) = (field_map, payload.as_object_mut()) {
        object.insert(
            "fieldMap".to_string(),
            serde_json::to_value(&remote.map).unwrap_or_default(),
        );
        object.insert(
            "fieldMapVersion".to_string(),
            serde_json::Value::String(remote.version.clone()),
        );
    }
    let payload =
        serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
    let mut script = format!(
        "if (window.__placemillApplySettings) {{ window.__placemillApplySettings({}); }}",
        payload
    );
    // The switch belongs to every page boot. The localStorage mirror alone let
    // a document start scrolling with no job behind it — an app restart after a
    // crash, `clear_data` writing only the in-memory flag — and the panel had
    // no way to notice. Rust is the owner now; the mirror is still written here
    // so the very first document of the next launch boots from the same value.
    //
    // `start_scroll` is only true for an actual page load: a settings push into
    // a live document must not restart the loop between two tiles.
    script.push_str(&format!(
        "window.__placemillEnabled = {enabled}; try {{ localStorage.setItem('__placemillEnabled', '{}'); }} catch (e) {{}} if ({enabled} && {start_scroll}) {{ try {{ window.__placemillAutoScroll.start(); }} catch (e) {{}} }} if (!{enabled}) {{ try {{ window.__placemillAutoScroll.stop('boot'); }} catch (e) {{}} }}",
        if enabled { "1" } else { "0" }
    ));
    // P1-4: the clear epoch travels with every document. A batch is stamped with
    // this value when it is *produced*, and `store_businesses` refuses a batch
    // whose epoch is no longer current — which is what keeps a batch that was
    // already in flight from landing in a table the user just emptied.
    script.push_str(&format!(" window.__placemillEpoch = {epoch};"));
    if let Some(url) = reload_url {
        // Serialize instead of interpolating: a stray quote would break the script.
        let quoted = serde_json::to_string(url)
            .unwrap_or_else(|_| "\"https://www.google.com/maps\"".to_string());
        script.push_str(&format!(" window.location.href = {};", quoted));
    }
    script
}

/// Push the current settings + field map into the maps webview, if it exists.
/// Used after a late field-map fetch: the first page load may already be done.
fn push_collector_settings(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    // R-25: skipping the push silently would leave the maps page on old
    // collector settings with nothing in the diagnostics drawer.
    let settings = match state.settings.lock() {
        Ok(guard) => Some(guard.clone()),
        Err(error) => {
            log_warn!(
                "push_collector_settings: settings unavailable: {}",
                error
            );
            state.record_error(format!(
                "Could not push the collector settings to the map: {}",
                error
            ));
            None
        }
    };
    let field_map = state
        .remote_field_map
        .lock()
        .ok()
        .and_then(|guard| guard.clone());
    if let Some(settings) = settings {
        // A late field-map push must not change the switch: read it, never
        // re-derive it from the page.
        let enabled = state
            .listening
            .lock()
            .map(|value| *value)
            .unwrap_or(false);
        // A late field-map push lands in an already-loaded document: re-assert
        // the switch, never start or stop the loop under the runner's feet.
        let epoch = state
            .collection_epoch
            .load(std::sync::atomic::Ordering::Acquire);
        let script = collector_settings_script(
            &settings,
            field_map.as_ref(),
            None,
            enabled,
            false,
            epoch,
        );
        if let Some(maps) = app.get_webview("maps") {
            if let Err(error) = maps.eval(&script) {
                log_warn!("push_collector_settings failed: {}", error);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// `business-data` ingress guard (R-26)
// ---------------------------------------------------------------------------

/// Ceilings for one batch. The injected script sends ~20 rows; these numbers
/// exist to bound a hostile or broken producer, not normal traffic.
const MAX_BATCH_ROWS: usize = 500;
/// One reviews payload is much smaller than a search batch, but it is still
/// page-controlled. The cap keeps a hostile/broken response from allocating an
/// unbounded vector before the store path's own rate window sees it.
const MAX_REVIEW_ROWS: usize = 2_000;
const MAX_NAME_CHARS: usize = 200;
const MAX_ADDRESS_CHARS: usize = 300;
const MAX_PHONE_CHARS: usize = 60;
const MAX_WEBSITE_CHARS: usize = 500;
const MAX_PLACE_ID_CHARS: usize = 300;
const MAX_QUERY_CHARS: usize = 200;
const MAX_EMAIL_CHARS: usize = 254;
const MAX_URL_CHARS: usize = 300;
const MAX_TYPES: usize = 10;
const MAX_TYPE_CHARS: usize = 60;
const MAX_TEXT_LIST: usize = 10;
// M8 / J-08c: the new columns. The address parts are short; the two links
// (reviews, thumbnail) are URLs and get their own ceiling, a little above
// `website`'s.
const MAX_STREET_CHARS: usize = 200;
const MAX_CITY_CHARS: usize = 120;
const MAX_REGION_CHARS: usize = 120;
const MAX_POSTAL_CHARS: usize = 20;
const MAX_COUNTRY_CHARS: usize = 60;
const MAX_TIMEZONE_CHARS: usize = 60;
const MAX_DATA_ID_CHARS: usize = 120;
const MAX_LINK_CHARS: usize = 600;
const MAX_OWNER_CHARS: usize = 200;
const MAX_ABOUT_ENTRIES: usize = 20;
const MAX_OPEN_HOURS_DAYS: usize = 7;
const MAX_PERIODS_PER_DAY: usize = 8;

/// What `sanitize_batch` had to do.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct IngressReport {
    /// Rows past `MAX_BATCH_ROWS`.
    pub over_cap: usize,
    /// Rows whose `place_id` cannot be a Google place id.
    pub invalid: usize,
    /// Rows with at least one over-long field that was cut.
    pub trimmed: usize,
}

impl IngressReport {
    fn rejected(&self) -> usize {
        self.over_cap + self.invalid
    }
}

/// Remove the NUL bytes from a text value; `true` when there were any.
///
/// M8 / J-08f: a NUL in a stored value is not something SQLite or Excel can
/// live with — `length()` stops at the first NUL, and the exported file
/// carries a byte no spreadsheet wants. The bytes go here, at the trust
/// boundary, so nothing downstream has to know about them.
fn strip_nuls(value: &mut String) -> bool {
    if !value.contains('\0') {
        return false;
    }
    value.retain(|c| c != '\0');
    true
}

/// Trim in place; `true` when something was cut.
///
/// M8 / J-08f: NUL bytes go too (see `strip_nuls`). A row that carried one
/// is a row that was touched, so the report counts it.
fn clamp_chars(value: &mut String, max: usize) -> bool {
    let mut touched = strip_nuls(value);
    if value.chars().count() > max {
        *value = value.chars().take(max).collect();
        touched = true;
    }
    touched
}

/// A place id is Google's opaque key. Real Maps ids are `ChIJ…`-shaped
/// base64url (ASCII alphanumerics plus `-`, `_`, occasionally `.`), but the
/// e2e fixtures and some older payloads use other ASCII shapes, so this guard
/// enforces the conservative wire shape (non-empty ASCII, bounded length)
/// rather than a `ChIJ` prefix.
fn is_valid_place_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_PLACE_ID_CHARS
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn clamp_list(items: &mut Vec<String>, max_items: usize, max_chars: usize) -> bool {
    let mut touched = false;
    let before = items.len();
    items.retain(|item| !item.trim().is_empty());
    touched |= items.len() != before;
    if items.len() > max_items {
        items.truncate(max_items);
        touched = true;
    }
    for item in items.iter_mut() {
        // Trim as well as cap: the miner deduplicates by value, so a stray
        // space would otherwise store the "same" email twice.
        let trimmed = item.trim();
        if trimmed.len() != item.len() {
            *item = trimmed.to_string();
            touched = true;
        }
        touched |= clamp_chars(item, max_chars);
    }
    touched
}

/// Bound the about block: a list of label/value pairs, each side capped.
fn clamp_about(entries: &mut Vec<AboutEntry>) -> bool {
    let mut touched = false;
    if entries.len() > MAX_ABOUT_ENTRIES {
        entries.truncate(MAX_ABOUT_ENTRIES);
        touched = true;
    }
    for entry in entries.iter_mut() {
        touched |= clamp_chars(&mut entry.key, MAX_TYPE_CHARS);
        touched |= clamp_chars(&mut entry.label, MAX_NAME_CHARS);
    }
    touched
}

/// Bound the opening hours: the day list, the periods per day and each
/// period's text.
fn clamp_open_hours(days: &mut Vec<OpenHoursDay>) -> bool {
    let mut touched = false;
    if days.len() > MAX_OPEN_HOURS_DAYS {
        days.truncate(MAX_OPEN_HOURS_DAYS);
        touched = true;
    }
    for day in days.iter_mut() {
        touched |= clamp_chars(&mut day.day, MAX_TYPE_CHARS);
        touched |= clamp_list(&mut day.periods, MAX_PERIODS_PER_DAY, MAX_NAME_CHARS);
    }
    touched
}

/// Bound one batch before it reaches SQLite: cap the row count, clean every
/// free-text field and the two JSON lists, then drop rows with no usable
/// `place_id`.
///
/// The order matters: the row is cleaned first, so a NUL byte in the place id
/// (M8 / J-08f) costs the byte and not the business.
///
/// Returns what was changed so the caller can report it; the caller decides
/// whether the batch survives.
pub fn sanitize_batch(businesses: &mut Vec<Business>) -> IngressReport {
    let mut report = IngressReport::default();

    if businesses.len() > MAX_BATCH_ROWS {
        report.over_cap = businesses.len() - MAX_BATCH_ROWS;
        businesses.truncate(MAX_BATCH_ROWS);
    }

    // M8 / J-08f: a NUL in the place id is a wire artifact, not a different
    // place. It is stripped here, together with the rest of the row, and the
    // id is judged afterwards: dropping a business over one byte would lose a
    // row that is perfectly identifiable once the byte is gone, and the id is
    // what the collection deduplicates on.
    for business in businesses.iter_mut() {
        let mut touched = strip_nuls(&mut business.place_id);
        touched |= clamp_chars(&mut business.name, MAX_NAME_CHARS);
        touched |= clamp_chars(&mut business.address, MAX_ADDRESS_CHARS);
        touched |= clamp_chars(&mut business.phone, MAX_PHONE_CHARS);
        touched |= clamp_chars(&mut business.website, MAX_WEBSITE_CHARS);
        touched |= clamp_chars(&mut business.source_query, MAX_QUERY_CHARS);
        touched |= clamp_chars(&mut business.email_source_url, MAX_URL_CHARS);
        touched |= clamp_list(&mut business.types, MAX_TYPES, MAX_TYPE_CHARS);
        touched |= clamp_list(&mut business.emails, MAX_TEXT_LIST, MAX_EMAIL_CHARS);
        touched |= clamp_list(&mut business.socials, MAX_TEXT_LIST, MAX_URL_CHARS);
        // M8 / J-08c
        touched |= clamp_chars(&mut business.street, MAX_STREET_CHARS);
        touched |= clamp_chars(&mut business.city, MAX_CITY_CHARS);
        touched |= clamp_chars(&mut business.state, MAX_REGION_CHARS);
        touched |= clamp_chars(&mut business.borough, MAX_REGION_CHARS);
        touched |= clamp_chars(&mut business.postal_code, MAX_POSTAL_CHARS);
        touched |= clamp_chars(&mut business.country, MAX_COUNTRY_CHARS);
        touched |= clamp_chars(&mut business.timezone, MAX_TIMEZONE_CHARS);
        touched |= clamp_chars(&mut business.data_id, MAX_DATA_ID_CHARS);
        touched |= clamp_chars(&mut business.reviews_link, MAX_LINK_CHARS);
        touched |= clamp_chars(&mut business.thumbnail, MAX_LINK_CHARS);
        touched |= clamp_chars(&mut business.owner_name, MAX_OWNER_CHARS);
        touched |= clamp_about(&mut business.about);
        touched |= clamp_open_hours(&mut business.open_hours);

        // Non-finite numbers would poison averages and map links; out-of-range
        // coordinates are just as unusable as zero.
        if !business.rating.is_finite() || !(0.0..=5.0).contains(&business.rating) {
            business.rating = 0.0;
            touched = true;
        }
        if !business.lat.is_finite() || !(-90.0..=90.0).contains(&business.lat) {
            business.lat = 0.0;
            touched = true;
        }
        if !business.lng.is_finite() || !(-180.0..=180.0).contains(&business.lng) {
            business.lng = 0.0;
            touched = true;
        }
        if touched {
            report.trimmed += 1;
        }
    }

    // The place id is judged after the row was cleaned, so a NUL byte in it
    // cannot cost the business its row.
    let before = businesses.len();
    businesses.retain(|business| is_valid_place_id(&business.place_id));
    report.invalid = before - businesses.len();

    report
}

/// Parse the `businesses` array from a page event.
///
/// P2-7: the cap and the per-row tolerance both matter here. The old code
/// cloned the whole array and used one `from_value::<Vec<Business>>`, so a
/// payload of 100k rows was parsed before `sanitize_batch` truncated it, and a
/// single row missing `name`/`website` dropped the other 499. Rows past the cap
/// are reported, not parsed; malformed rows are skipped and counted.
fn parse_business_batch(
    value: &serde_json::Value,
) -> Result<(Vec<Business>, usize, usize), String> {
    let array = value
        .as_array()
        .ok_or_else(|| "businesses is not an array".to_string())?;
    let over_cap = array.len().saturating_sub(MAX_BATCH_ROWS);
    let mut rows = Vec::with_capacity(array.len().min(MAX_BATCH_ROWS));
    let mut invalid = 0usize;
    for item in array.iter().take(MAX_BATCH_ROWS) {
        match serde_json::from_value::<Business>(item.clone()) {
            Ok(row) => rows.push(row),
            Err(_) => invalid += 1,
        }
    }
    Ok((rows, over_cap, invalid))
}

/// The reviews counterpart of `parse_business_batch`: bounded, tolerant of one
/// malformed row, and never a reason to drop the rows that did parse.
fn parse_review_batch(
    value: &serde_json::Value,
) -> Result<(Vec<db::ReviewRow>, usize, usize), String> {
    let array = value
        .as_array()
        .ok_or_else(|| "reviews is not an array".to_string())?;
    let over_cap = array.len().saturating_sub(MAX_REVIEW_ROWS);
    let mut rows = Vec::with_capacity(array.len().min(MAX_REVIEW_ROWS));
    let mut invalid = 0usize;
    for item in array.iter().take(MAX_REVIEW_ROWS) {
        match serde_json::from_value::<db::ReviewRow>(item.clone()) {
            Ok(row) => rows.push(row),
            Err(_) => invalid += 1,
        }
    }
    Ok((rows, over_cap, invalid))
}

/// How long after the switch goes off a batch may still land: it was already
/// parsed and in flight when the user stopped. `intercept.js` checks the flag
/// before parsing (R-08), so anything older than one IPC round trip belongs to
/// a page that should not be collecting any more.
const SWITCH_OFF_GRACE: Duration = Duration::from_secs(3);
/// How rarely a consent/captcha report may pause a task (P1-2). The injected
/// probe emits on every state change, and a page that alternates between two
/// blocking states must not turn each report into another pause attempt.
const HEALTH_PAUSE_COOLDOWN: Duration = Duration::from_secs(60);
/// The switch itself: on, or off for less than `SWITCH_OFF_GRACE`.
///
/// Pure and fixture-free, so both the write gate and pane ownership can share
/// one definition of "collecting" while only the write gate honours the e2e
/// override.
fn switch_gate(listening: bool, since_off: Option<Duration>) -> bool {
    listening
        || since_off
            .map(|elapsed| elapsed < SWITCH_OFF_GRACE)
            .unwrap_or(false)
}

/// Whether a batch may be written, given the switch and how long ago it went
/// off. Pure so the rule has a test instead of only a code path: the grace is
/// what keeps a stop from eating the batch that was already on the wire.
fn session_gate(listening: bool, since_off: Option<Duration>, fixture: bool) -> bool {
    fixture || switch_gate(listening, since_off)
}

/// Whether a batch produced under `epoch` may be written while the table is at
/// `expected` (P1-4).
///
/// Pure so the rule has a test: the epoch is what separates "already on the
/// wire when the user cleared" from "belongs to the session that was cleared".
///
/// A payload that *declares* an epoch is always judged on it — the exemption for
/// the e2e fixtures only covers the absence of the field, so the rule can still
/// be exercised end to end. The injected script always sends one; a declared
/// value that no longer matches can only be a batch from before the clear.
fn epoch_admits(epoch: Option<u64>, expected: u64, fixture: bool) -> bool {
    match epoch {
        Some(epoch) => epoch == expected,
        None => fixture,
    }
}

/// Debug-build fixture switch, same shape as `PLACE_MILL_ALLOW_PRIVATE_TARGETS`.
///
/// The e2e suites inject rows for jobs that are not running (they emit
/// `business-data` or call `on_business_data` directly, with no maps session),
/// so the write gate and the Rust-side attribution would both refuse them. A
/// release binary ignores the flag: the check is `cfg!`-gated.
fn fixture_batches_allowed() -> bool {
    static ALLOWED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ALLOWED.get_or_init(|| {
        cfg!(debug_assertions)
            && std::env::var("PLACE_MILL_ALLOW_OFF_SESSION_BATCHES")
                .map(|value| value == "1")
                .unwrap_or(false)
    })
}

/// Whether a collecting session is active.
///
/// `switch_off_at` is only set on an actual on→off transition and cleared when
/// a session starts, so repeated stops cannot keep the grace window alive.
fn session_active(state: &AppState) -> bool {
    let listening = state.listening.lock().map(|value| *value).unwrap_or(false);
    let since_off = state
        .switch_off_at
        .lock()
        .ok()
        .and_then(|at| *at)
        .map(|at| at.elapsed());
    session_gate(listening, since_off, fixture_batches_allowed())
}

/// Whether the collector switch is on, ignoring the e2e fixture override.
///
/// `session_active` answers `true` whenever fixtures are allowed, so a suite can
/// seed batches with no session behind them. That override must not reach pane
/// ownership: a suite that seeds rows off-session would otherwise see every
/// pane-owning command refused with `session_active` — which is exactly what
/// `e2e:pane` caught (C-01).
pub(crate) fn switch_on(state: &AppState) -> bool {
    let listening = state.listening.lock().map(|value| *value).unwrap_or(false);
    let since_off = state
        .switch_off_at
        .lock()
        .ok()
        .and_then(|at| *at)
        .map(|at| at.elapsed());
    switch_gate(listening, since_off)
}

#[cfg(test)]
mod session_tests {
    use super::*;

    #[test]
    fn a_running_session_always_writes() {
        assert!(session_gate(true, None, false));
        assert!(session_gate(true, Some(Duration::from_secs(60)), false));
    }

    #[test]
    fn the_grace_covers_an_in_flight_batch() {
        assert!(session_gate(false, Some(Duration::from_secs(1)), false));
        assert!(!session_gate(false, Some(Duration::from_secs(4)), false));
    }

    #[test]
    fn a_stopped_session_writes_nothing() {
        assert!(!session_gate(false, None, false));
    }

    #[test]
    fn fixtures_may_write_without_a_session() {
        assert!(session_gate(false, None, true));
    }

    /// P1-4: a batch produced before the last clear is refused even while the
    /// switch-off grace would otherwise admit it.
    #[test]
    fn a_batch_from_before_the_clear_is_refused() {
        assert!(
            epoch_admits(Some(0), 0, false),
            "a fresh app accepts its own epoch"
        );
        assert!(epoch_admits(Some(3), 3, false));
        assert!(
            !epoch_admits(Some(3), 4, false),
            "a batch produced under the cleared epoch must not land in the emptied table"
        );
        assert!(
            !epoch_admits(Some(0), 1, false),
            "the first clear bumps 0 -> 1"
        );
        // A payload without the field comes from the e2e fixtures; the
        // exemption covers only its absence, never a declared mismatch.
        assert!(epoch_admits(None, 7, true));
        assert!(!epoch_admits(None, 7, false));
        assert!(!epoch_admits(Some(0), 7, true));
    }

    /// The fixture override belongs to the write gate only. Pane ownership asks
    /// `switch_on`, which must stay honest inside the suites — otherwise every
    /// pane command refuses itself with `session_active` (C-01).
    #[test]
    fn the_fixture_override_does_not_turn_the_switch_on() {
        assert!(!switch_gate(false, None));
        assert!(switch_gate(false, Some(Duration::from_secs(1))));
        assert!(!switch_gate(false, Some(Duration::from_secs(4))));
        assert!(session_gate(false, None, true));
    }
}

#[cfg(test)]
mod review_place_tests {
    use super::*;

    fn review(own_place: &str) -> db::ReviewRow {
        db::ReviewRow {
            review_id: "r1".to_string(),
            payload_place_id: own_place.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn rows_of_another_place_are_dropped() {
        // The hex tail is the part both shapes share; a review whose own field
        // names a different tail is another place's row.
        let mut rows = vec![
            review("0x0:0xabc123"),
            review("0x0:0xdef456"),
            review(""),
        ];
        let dropped = retain_reviews_of_place(&mut rows, "0x8848:0xabc123");
        assert_eq!(dropped, 1);
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn a_missing_data_id_disables_the_check() {
        let mut rows = vec![review("0x0:0xdef456")];
        assert_eq!(retain_reviews_of_place(&mut rows, ""), 0);
        assert_eq!(rows.len(), 1);
    }
}

/// The circle an area job was created with, read once per batch.
///
/// `None` means "no circle to enforce": no job id was passed, or the job row is
/// gone (an e2e fixture attributing rows to an id it never inserted). Both keep
/// storing whatever arrives — dropping them would silently break the suites,
/// and neither can claim a radius the user chose.
///
/// Callers must resolve an unattributed batch to the running job *before*
/// calling this (P2-3); `store_businesses` does.
fn job_area(state: &tauri::State<'_, AppState>, job_id: &str) -> Option<(f64, f64, f64)> {
    if job_id.is_empty() {
        return None;
    }
    let conn = state.db.lock().ok()?;
    let job = db::load_job(&conn, job_id).ok().flatten()?;
    if !(job.radius_km.is_finite() && job.radius_km > 0.0) {
        return None;
    }
    // Coordinates are snapshotted at creation and never updated, so reading
    // them per batch cannot race with anything.
    Some((job.center_lat, job.center_lng, job.radius_km))
}

/// Store one batch and tell the panel.
///
/// `source_query` / `job_id` come from the event metadata, not from the rows:
/// they describe the search that produced them and are what M6's SQL filters
/// query. Nothing is kept in memory any more — the panel reads pages from
/// SQLite, so memory does not grow with the number of collected rows.
pub fn store_businesses(
    app: &tauri::AppHandle,
    mut businesses: Vec<Business>,
    source_query: &str,
    job_id: &str,
    epoch: Option<u64>,
) -> usize {
    if businesses.is_empty() {
        return 0;
    }

    let state = app.state::<AppState>();

    // P1-4: a batch produced before the last `clear_data` must not land in the
    // emptied table. The switch-off grace exists to rescue a batch that was
    // already on the wire, and that is exactly the window this check closes —
    // the epoch says whether the batch belongs to the session that was cleared.
    //
    // The e2e fixtures emit `business-data` without an epoch, so a payload that
    // omits the field is exempt (debug builds only, same gate as the session
    // override); a payload that declares one is always judged on it.
    let expected_epoch = state
        .collection_epoch
        .load(std::sync::atomic::Ordering::Acquire);
    if !epoch_admits(epoch, expected_epoch, fixture_batches_allowed()) {
        let received = businesses.len();
        state.record_batch(received, 0, received);
        log_debug!(
            "business-data refused: produced under epoch {:?}, the table is at epoch {}",
            epoch,
            expected_epoch
        );
        return 0;
    }

    // Only an active session may write. `business-data` is reachable from any
    // script on the maps page (R-26 bounds the volume, not the timing), and the
    // page's own switch used to be the only gate — which is exactly how a
    // cancelled, cleared or restarted session kept writing rows. The page is a
    // follower; the authority is here.
    if !session_active(&state) {
        let received = businesses.len();
        state.record_batch(received, 0, received);
        log_debug!(
            "business-data without an active session: {} row(s) dropped",
            received
        );
        return 0;
    }

    // R-26: the maps page holds `core:event:allow-emit`, so this function is
    // reachable from any script that ends up there. Bound the batch before it
    // costs memory or a write, and refuse it entirely once the sender has spent
    // the rate budget.
    let ingress = sanitize_batch(&mut businesses);
    let mut dropped = ingress.rejected();

    let admitted = {
        let mut window = state
            .batch_window
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        window.admit(businesses.len())
    };
    if !admitted {
        dropped += businesses.len();
        businesses.clear();
        // Once per window: a flood must not fill the diagnostics drawer with
        // one line per batch.
        let report = state
            .batch_window
            .lock()
            .map(|mut window| window.should_report())
            .unwrap_or(false);
        if report {
            state.record_error(format!(
                "business-data rate limit exceeded: {} row(s) dropped in {} s",
                dropped,
                BATCH_WINDOW.as_secs()
            ));
            log_warn!(
                "business-data rate limit exceeded, dropped {} row(s)",
                dropped
            );
        }
    } else if ingress.rejected() > 0 || ingress.trimmed > 0 {
        log_debug!(
            "business-data ingress: {} rejected ({} over cap, {} invalid place_id), {} trimmed",
            ingress.rejected(),
            ingress.over_cap,
            ingress.invalid,
            ingress.trimmed
        );
    }

    // Snapshot both switches and release the `settings` lock before touching
    // `db` (lock order, see AppState).
    //
    // R-25: a poisoned lock means the batch would be stored under guessed
    // switches (`only with phone` silently off), so it is reported instead of
    // being mistaken for "the user turned both switches off".
    let (only_with_phone, update_duplicates) = match state.settings.lock() {
        Ok(settings) => (
            settings.only_with_phone,
            settings.duplicate_strategy == "update",
        ),
        Err(error) => {
            state.record_error(format!(
                "Settings unavailable while storing a batch; the batch switches were not applied ({})",
                error
            ));
            (false, false)
        }
    };

    // UI-09: rows as the batch arrived, before any filtering. Rejected rows are
    // counted as `dropped` rather than vanishing, so `received - inserted -
    // dropped` keeps meaning "already known" on the panel.
    let received = businesses.len() + dropped;

    // Backstop for the "only with phone" switch: the injected script already
    // filters, but the switch can change while a batch is in flight. Only new
    // rows are affected — nothing already stored is deleted.
    if only_with_phone {
        let before = businesses.len();
        businesses.retain(|business| !business.phone.is_empty());
        dropped += before - businesses.len();
    }

    // Area jobs: enforce the radius the user asked for.
    //
    // The grid only decides *where to look*; what Google sends back is a much
    // wider set. Its feed keeps loading further away as the page scrolls, so a
    // 1.5 km job arrives holding rows 8–12 km out (Sha Tin, Ma On Shan) and the
    // occasional one on another continent (Shanghai, Manila). Nothing used to
    // check this, which is why "1.5 km around this point" shipped 360 rows of
    // which 62 were inside the circle. Unattributed batches have no job and
    // therefore no circle: those keep the old behaviour.
    //
    // P2-3: an unattributed batch still belongs to whichever job is running.
    // `attribute_batch` refuses a late batch from the previous cell by design,
    // but skipping the radius check for it let rows up to kilometres outside the
    // circle in under the "unattributed" label — the same rows the filter exists
    // to remove. With no runner there is no circle, and that stays the case.
    let area_job = if job_id.is_empty() {
        state
            .active_runner
            .lock()
            .ok()
            .and_then(|slot| slot.clone())
            .unwrap_or_default()
    } else {
        job_id.to_string()
    };

    // `batch_seen` is what Google actually sent (after the switch backstop,
    // before the area filter); `count_tile_rows` takes both numbers.
    let batch_seen = businesses.len();
    if let Some((center_lat, center_lng, radius_km)) = job_area(&state, &area_job) {
        businesses.retain(|business| {
            grid::within_radius(center_lat, center_lng, business.lat, business.lng, radius_km)
        });
        let removed = batch_seen - businesses.len();
        if removed > 0 {
            dropped += removed;
            log_debug!(
                "business-data outside the {} km radius: {} of {} row(s) dropped",
                radius_km,
                removed,
                batch_seen
            );
        }
    }

    // What survived every filter is this cell's real yield, and the split
    // decision reads it (see `collector::count_tile_rows`). Counting the raw
    // batch made a 1.5 km cell subdivide — 120 rows arrived, ~30 were inside
    // the radius, the 100-row threshold tripped and the quadtree grew into
    // territory the job never covered. The counter also checks attribution and
    // counts each place id once (P2-2).
    collector::count_tile_rows(app, job_id, &businesses);

    // A batch that is entirely filtered out still happened: the summary must
    // see it, but there is nothing to write or announce.
    if businesses.is_empty() {
        state.record_batch(received, 0, dropped);
        let _ = app.emit(
            "collector:batch",
            &CollectorBatch {
                received,
                inserted: 0,
                dropped,
            },
        );
        return 0;
    }

    // UI-03: the collection time is assigned here rather than trusted from the
    // script, so one batch shares a stamp (same or increasing within a batch).
    // `source_query` falls back to the batch metadata; the upsert in `db` keeps
    // the first `collected_at` when a known row is refreshed.
    let stamp = now_ms();
    for business in businesses.iter_mut() {
        business.collected_at = stamp;
        if business.source_query.is_empty() {
            business.source_query = source_query.to_string();
        }
    }

    let mut write_error: Option<String> = None;
    let inserted = if let Ok(conn) = state.db.lock() {
        match db::insert_businesses(
            &conn,
            &businesses,
            source_query,
            job_id,
            update_duplicates,
        ) {
            Ok(count) => count,
            Err(error) => {
                write_error = Some(format!("Failed to store a business row: {}", error));
                0
            }
        }
    } else {
        0
    };
    // Recorded after the db lock is released: `record_error` takes the stats lock.
    if let Some(error) = write_error {
        // The panel's diagnostics drawer shows it, but a lost batch deserves a
        // line in the log too: a failed write is otherwise invisible outside
        // the app. (A missing column after a schema change cost an afternoon
        // this way — the panel said "0 rows inserted" and nothing else.)
        log_warn!("business-data write failed: {}", error);
        state.record_error(error);
    }

    state.record_batch(received, inserted, dropped);
    let _ = app.emit("businesses:updated", &businesses);
    let _ = app.emit(
        "collector:batch",
        &CollectorBatch {
            received,
            inserted,
            dropped,
        },
    );
    inserted
}

/// M9: sanitize one review row in place. The payload is Google's own, but the
/// write path is reachable from any script on the maps page, so every text
/// field gets the same NUL/clamp treatment a business row gets, and the
/// numeric fields are range-checked rather than trusted.
fn sanitize_review(review: &mut db::ReviewRow) -> bool {
    clamp_chars(&mut review.review_id, 128);
    clamp_chars(&mut review.payload_place_id, 128);
    clamp_chars(&mut review.author, 200);
    clamp_chars(&mut review.author_avatar, 2_000);
    clamp_chars(&mut review.author_id, 128);
    clamp_chars(&mut review.author_link, 2_000);
    clamp_chars(&mut review.relative_time, 64);
    clamp_chars(&mut review.text, 8_000);
    clamp_chars(&mut review.owner_reply, 8_000);
    clamp_chars(&mut review.owner_reply_relative, 64);
    clamp_chars(&mut review.photo_url, 2_000);
    clamp_chars(&mut review.report_url, 2_000);
    clamp_chars(&mut review.channel, 32);
    review.stars = review.stars.clamp(0, 5);
    review.helpful_votes = review.helpful_votes.clamp(0, 1_000_000);
    // Microsecond epoch sanity: a parser that read the field as seconds or
    // milliseconds would store a date in 1970 or the year 55000. Empty is
    // allowed (the payload may omit it); wrong is not.
    for us in [&mut review.created_at_us, &mut review.updated_at_us] {
        if *us != 0 && (*us < 1_000_000_000_000_000 || *us > 2_000_000_000_000_000) {
            *us = 0;
        }
    }
    !review.review_id.is_empty()
}

/// C-02: drop review rows that name a different place than the one requested.
///
/// The fetch is a migration of the pane to a place page and back through a
/// timed sequence, so it can read a document it did not navigate to — another
/// place, or a search page whose state still holds the previous place's
/// reviews. Rust stamps the panel's key on every row, so without this check
/// those rows would be stored under the wrong business and `INSERT OR REPLACE`
/// would overwrite the right ones.
///
/// `payload_place_id` is the parser's own place field; the hex tail of
/// `data_id` is the part that survives both shapes (`0x0:0x…` in the payload,
/// `0x…:0x…` in the business row). A row without the field cannot be judged and
/// is kept — dropping it would lose real data whenever the parser omits the id.
/// Returns how many rows were dropped, for the diagnostic log.
fn retain_reviews_of_place(reviews: &mut Vec<db::ReviewRow>, data_id: &str) -> usize {
    let tail = data_id.rsplit(':').next().unwrap_or("").trim();
    if tail.is_empty() {
        return 0;
    }
    let before = reviews.len();
    reviews.retain(|review| {
        let own = review.payload_place_id.trim();
        own.is_empty() || own.contains(tail)
    });
    before - reviews.len()
}

/// M9: store one place's reviews and tell the panel they changed. Unlike
/// `business-data`, no session gate: reviews are fetched per business on
/// demand, outside any collecting session. The rate window is what bounds a
/// runaway producer.
fn store_reviews(
    app: &tauri::AppHandle,
    mut reviews: Vec<db::ReviewRow>,
    place_id: &str,
    data_id: &str,
) -> usize {
    if place_id.is_empty() {
        return 0;
    }
    let state = app.state::<AppState>();

    let mismatched = retain_reviews_of_place(&mut reviews, data_id);
    if mismatched > 0 {
        log_warn!(
            "business-reviews for {}: {} row(s) belonged to another place and were dropped",
            crate::logging::redact_place_id(place_id),
            mismatched
        );
        state.record_error(format!(
            "Reviews fetch for {} returned {} row(s) of another place; dropped",
            crate::logging::redact_place_id(place_id),
            mismatched
        ));
    }

    // Rust stamps the panel's key on every row — the payload's own place
    // field has a different shape and is kept only for reference.
    for review in reviews.iter_mut() {
        review.place_id = place_id.to_string();
        if review.payload_place_id.is_empty() && !data_id.is_empty() {
            review.payload_place_id = data_id.to_string();
        }
    }
    reviews.retain_mut(sanitize_review);

    let admitted = {
        let mut window = state
            .reviews_window
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        window.admit(reviews.len())
    };
    if !admitted {
        let report = state
            .reviews_window
            .lock()
            .map(|mut window| window.should_report())
            .unwrap_or(false);
        if report {
            state.record_error(format!(
                "business-reviews rate limit exceeded: batches dropped in {} s",
                BATCH_WINDOW.as_secs()
            ));
            log_warn!("business-reviews rate limit exceeded, batch dropped");
        }
        return 0;
    }

    let inserted = if let Ok(conn) = state.db.lock() {
        match db::insert_reviews(&conn, &reviews) {
            Ok(count) => count,
            Err(error) => {
                log_warn!("business-reviews write failed: {}", error);
                state.record_error(format!("Failed to store review rows: {}", error));
                0
            }
        }
    } else {
        0
    };

    // The completion event is emitted by the `business-reviews` listener, once
    // per payload — including the zero-row, mismatch and failure cases (P2-5).
    // Emitting here as well would answer twice for the same sequence.
    inserted
}

// Injection script: embedded into the webview to intercept Google Maps APIs
const INTERCEPT_SCRIPT: &str = include_str!("../scripts/intercept.js");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // ========== Initialize SQLite (system data dir, avoids dev watcher restarts) ==========
            let data_dir = match app.path().app_data_dir() {
                Ok(dir) => dir,
                Err(error) => {
                    log_error!("app data directory unavailable: {}", error);
                    return Err(format!("app data directory unavailable: {}", error).into());
                }
            };
            let db_path = data_dir.join("placemill.db");
            log_info!(
                "database path: {}",
                logging::redact_path(&db_path.to_string_lossy())
            );

            // R-06: a database that cannot be opened or migrated must not take
            // the app (and the user's collected data) down in a panic. The
            // recovery backs the broken file up under a timestamped name and
            // rebuilds; only a failure of that rebuild aborts startup, with a
            // readable error instead of a panic.
            let (db, db_backup) = match db::open_with_recovery(&db_path) {
                Ok(pair) => pair,
                Err(error) => {
                    log_error!("database unrecoverable: {}", error);
                    return Err(error.into());
                }
            };
            if let Some(backup) = db_backup {
                log_info!(
                    "the previous database is preserved at {}; the app started with an empty one",
                    logging::redact_path(&backup.to_string_lossy())
                );
            }

            // A job that was `running` when the process died cannot still be
            // running. Downgrade it to `paused` so the panel can offer "resume"
            // instead of showing a job that will never progress (M3 / J-03d).
            match db::recover_interrupted_jobs(&db) {
                Ok(0) => {}
                Ok(count) => log_info!(
                    "recovered {} interrupted job(s) -> paused",
                    count
                ),
                Err(error) => log_warn!("job recovery failed: {}", error),
            }

            // Settings must be read before the window is created: the first paint
            // has to use the persisted theme / language / page size / split, and
            // the split is needed by the layout math below. A read failure is
            // fatal here: starting with defaults would let the first save
            // overwrite the user's real settings row (P2-11).
            let (settings, settings_warning) = match db::load_settings(&db) {
                Ok(pair) => pair,
                Err(error) => {
                    log_error!("settings unavailable: {}", error);
                    return Err(format!("settings unavailable: {}", error).into());
                }
            };
            // R-36b: the stored level is the first thing to apply, so the very
            // next line (including a settings warning) is already filtered.
            logging::set_level(&settings.log_level);
            let startup_ratio = if settings.remember_split {
                settings.split_ratio
            } else {
                DEFAULT_SPLIT_RATIO
            };

            // Serialized once, injected into the React webview so the very first
            // render already has the real settings (no flash, and no duplicate
            // defaults on the JS side).
            let settings_json = serde_json::to_string(&settings)
                .map_err(|error| format!("Failed to serialize settings: {}", error))?;
            let bootstrap_script = format!(
                "window.__PLACE_MILL_SETTINGS__ = {};",
                settings_json
            );

            app.manage(AppState {
                db: Mutex::new(db),
                settings: Mutex::new(settings.clone()),
                settings_write: Mutex::new(()),
                export_in_flight: AtomicBool::new(false),
                split_ratio: Mutex::new(startup_ratio),
                map_collapsed: Mutex::new(settings.map_collapsed),
                listening: Mutex::new(false),
                switch_off_at: Mutex::new(None),
                session_started_at: Mutex::new(None),
                stats: Mutex::new(CollectorStats::default()),
                db_path: db_path.to_string_lossy().to_string(),
                active_job: Mutex::new(None),
                active_runner: Mutex::new(None),
                grid_signal: Mutex::new(collector::GridSignal::default()),
                map_view: Mutex::new(None),
                remote_field_map: Mutex::new(None),
                parse_degraded_at: Mutex::new(None),
                email_mining: Mutex::new(None),
                enrich_job: Mutex::new(None),
                pane_owner: Mutex::new(None),
                review_fetch: Mutex::new(false),
                enrich_payload: Mutex::new(None),
                probe_limit: Mutex::new(None),
                health_blocked_at: Mutex::new(None),
                collection_epoch: std::sync::atomic::AtomicU64::new(0),
                query_latency: Mutex::new(std::collections::VecDeque::new()),
                clear_backup: Mutex::new(None),
                dashboard: Mutex::new(db::DashboardCache::new()),
                batch_window: Mutex::new(BatchWindow::default()),
                reviews_window: Mutex::new(BatchWindow::default()),
                closing: AtomicBool::new(false),
            });

            if let Some(warning) = settings_warning {
                log_warn!("settings warning: {}", warning);
                app.state::<AppState>().record_error(warning);
            }

            log_info!(
                "SQLite initialized, AppState managed (theme={}, page_size={}, split={})",
                settings.theme,
                settings.page_size,
                startup_ratio
            );

            // ========== Remote field map (M5 / G-05) ==========
            // One blocking fetch on a worker thread: the first page load runs
            // on the built-in map (or the script's localStorage mirror), and
            // once the fetch lands the fresh map is pushed into the running
            // webview. Every failure path silently degrades to built-in.
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let data_dir = match handle.path().app_data_dir() {
                        Ok(dir) => dir,
                        Err(error) => {
                            log_error!("app data dir unavailable: {}", error);
                            return;
                        }
                    };
                    let app_version = handle.package_info().version.to_string();
                    if let Some(map) =
                        remote_config::load_remote_field_map(&data_dir, &app_version)
                    {
                        let state = handle.state::<AppState>();
                        if let Ok(mut slot) = state.remote_field_map.lock() {
                            *slot = Some(map);
                        }
                        push_collector_settings(&handle);
                    }
                });
            }

            // ========== Create the main window ==========
            let main_window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("PlaceMill · Google Maps Business Collector")
            .inner_size(1440.0, 900.0)
            .min_inner_size(1000.0, 640.0)
            // The panel/map split needs horizontal room, so start maximized
            .maximized(true)
            // Synchronous settings for the very first React render.
            .initialization_script(&bootstrap_script)
            .build()?;

            log_info!("main window created");

            // The main webview takes the left part and renders the React UI.
            // Use the persisted ratio directly: starting from the default and
            // letting the delayed apply_split correct it makes the panel visibly
            // jump on startup.
            let window_size = main_window.inner_size()?;
            if let Some(main_webview) = main_window.get_webview("main") {
                main_webview.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
                    (window_size.width as f64 * startup_ratio) as u32,
                    window_size.height,
                )))?;
            }

            // ========== Create the Maps child webview (right part) ==========
            let maps_x = (window_size.width as f64 * startup_ratio) as i32;
            let maps_w = window_size.width - maps_x as u32;
            let maps_url = settings.maps_home_url();
            log_debug!(
                "creating maps webview: x={}, w={}, h={}, url={}",
                maps_x, maps_w, window_size.height, maps_url
            );
            let maps_url: url::Url = maps_url
                .parse()
                .map_err(|error| format!("invalid maps URL: {}", error))?;

            // R-31: `intercept.js` gates its debug helpers (`__placemillDiag`,
            // `__placemillTest`) on this flag. They write rows into SQLite from
            // the page, so a release build must not define them at all.
            let intercept_script = format!(
                "window.__PLACE_MILL_DEBUG__ = {};\n{}",
                cfg!(debug_assertions),
                INTERCEPT_SCRIPT
            );

            let _maps_webview = main_window
                .as_ref()
                .window()
                .add_child(
                    tauri::WebviewBuilder::new(
                        "maps",
                        // `hl`/`gl` come from the settings, so the map language is
                        // independent from the OS locale and from the panel UI.
                        tauri::WebviewUrl::External(maps_url),
                    )
                    // NOTE: do not call additional_browser_args() here. WebView2
                    // creates one environment per webview and requires identical
                    // arguments for the same user data folder; passing custom args
                    // only for this webview makes its creation fail (blank panel).
                    .initialization_script(&intercept_script)
                    .on_page_load(|webview, _payload| {
                        // Every load starts with an empty JS context: `intercept.js`
                        // can only seed itself from the localStorage mirror, which is
                        // empty on the very first launch. Push the real values here.
                        // The script itself is a no-op if `intercept.js` has not run
                        // yet, so firing on both events is safe (Google Maps also
                        // redirects on first load, and `Finished` lands on the second
                        // document).
                        let handle = webview.app_handle().clone();
                        // Bind the `State` to a local: the guard borrows from it.
                        let state = handle.state::<AppState>();
                        let settings = state
                            .settings
                            .lock()
                            .map(|settings| settings.clone());
                        let field_map = state
                            .remote_field_map
                            .lock()
                            .ok()
                            .and_then(|guard| guard.clone());
                        // Every document boots from Rust's switch, not from the
                        // localStorage mirror: that mirror is what kept a page
                        // scrolling after an app restart (no job behind it) and
                        // after `clear_data` wrote only the in-memory flag.
                        let enabled = state
                            .listening
                            .lock()
                            .map(|value| *value)
                            .unwrap_or(false);

                        match settings {
                            Ok(settings) => {
                                let epoch = state
                                    .collection_epoch
                                    .load(std::sync::atomic::Ordering::Acquire);
                                let script = collector_settings_script(
                                    &settings,
                                    field_map.as_ref(),
                                    None,
                                    enabled,
                                    true,
                                    epoch,
                                );
                                if let Err(error) = webview.eval(&script) {
                                    log_warn!("on_page_load eval failed: {}", error);
                                }
                            }
                            Err(error) => {
                                log_warn!(
                                    "on_page_load: settings unavailable: {}",
                                    error
                                );
                                state.record_error(format!(
                                    "Could not push the collector settings on page load: {}",
                                    error
                                ));
                            }
                        }
                    }),
                    tauri::Position::Physical(tauri::PhysicalPosition::new(maps_x, 0)),
                    tauri::Size::Physical(tauri::PhysicalSize::new(
                        maps_w,
                        window_size.height,
                    )),
                )?;

            log_info!(
                "maps webview created, intercept script length: {}",
                INTERCEPT_SCRIPT.len()
            );

            // ========== Listen for the business-data event from the maps webview ==========
            let app_handle = app.handle().clone();
            app.listen("business-data", move |event| {
                match serde_json::from_str::<serde_json::Value>(event.payload()) {
                    Ok(value) => {
                        let Some(biz_json) = value.get("businesses") else {
                            log_error!("business-data payload has no businesses array");
                            app_handle.state::<AppState>().record_error(
                                "business-data payload has no businesses array".to_string(),
                            );
                            return;
                        };
                        // P2-7: cap before deserializing, and let one malformed
                        // row cost itself instead of the whole batch.
                        let (businesses, over_cap, invalid) =
                            match parse_business_batch(biz_json) {
                                Ok(parsed) => parsed,
                                Err(error) => {
                                    log_error!("event deserialize businesses error: {}", error);
                                    app_handle
                                        .state::<AppState>()
                                        .record_error(format!(
                                            "Failed to parse business data: {}",
                                            error
                                        ));
                                    return;
                                }
                            };
                        if over_cap > 0 || invalid > 0 {
                            log_warn!(
                                "business-data: {} row(s) over the {} cap, {} invalid row(s) skipped",
                                over_cap,
                                MAX_BATCH_ROWS,
                                invalid
                            );
                            app_handle.state::<AppState>().record_error(format!(
                                "business-data: {} row(s) over the {} cap and {} invalid row(s) skipped",
                                over_cap, MAX_BATCH_ROWS, invalid
                            ));
                        }

                        // Batch attribution lives on the event, not on
                        // `Business`: it describes the search that produced the
                        // rows. The grid runner reads the same fields to close a
                        // cell.
                        let field = |key: &str| {
                            value
                                .get(key)
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string()
                        };
                        let source_query = field("sourceQuery");
                        // The page's `jobId` is deliberately ignored: it is read
                        // from sessionStorage, outlives the job that wrote it,
                        // and made a cancelled job's result list keep growing.
                        // Rust decides the attribution below; the payload only
                        // names the tile the page thinks it is scrolling.
                        let tile_id = field("tileId");

                        // Which job/tile this batch belongs to. Only the tile
                        // the runner is waiting on is attributed, so a late batch
                        // from the previous cell cannot inflate the current one.
                        let attributed = collector::attribute_batch(&app_handle, &tile_id);
                        // Fixture mode (debug build + explicit flag): the e2e
                        // suites attribute rows to a job that is not running,
                        // which is what the payload id used to do for every
                        // caller. Release builds never take this branch.
                        let attributed = attributed.or_else(|| {
                            let payload_id = field("jobId");
                            (fixture_batches_allowed() && !payload_id.is_empty())
                                .then_some(payload_id)
                        });
                        let job_id = attributed.clone().unwrap_or_default();
                        // P1-4: the epoch the page was collecting under when it
                        // produced this batch. `None` means the payload never
                        // declared one — only the e2e fixtures do that; the
                        // injected script always sends the number.
                        let epoch = value.get("epoch").and_then(|v| v.as_u64());

                        let inserted = store_businesses(
                            &app_handle,
                            businesses,
                            &source_query,
                            &job_id,
                            epoch,
                        );

                        if let Some(job_id) = attributed {
                            if inserted > 0 {
                                let state = app_handle.state::<AppState>();
                                let Ok(conn) = state.db.lock() else {
                                    return;
                                };
                                let _ = db::bump_job_inserted(&conn, &job_id, inserted);
                                drop(conn);
                                collector::emit_progress(&app_handle, &job_id);
                            }
                        }
                        log_debug!(
                            "batch stored, newly inserted: {} (query: {:?}, job: {:?}, tile: {:?})",
                            inserted,
                            source_query,
                            job_id,
                            tile_id
                        );
                    }
                    Err(e) => {
                        log_error!("event parse payload error: {}", e);
                        app_handle
                            .state::<AppState>()
                            .record_error(format!("Failed to parse event payload: {}", e));
                    }
                }
            });

            // ========== Listen for the business-reviews event (M9) ==========
            // The eval'd fetch resolves and emits here: one payload per
            // place, carrying the place id Rust stamped on the request.
            //
            // P2-5: every payload ends the sequence for the panel, whatever it
            // carried. The old code emitted `reviews:updated` only when rows were
            // *inserted*, so a business with zero reviews — a common case — left
            // the drawer spinning until its own 15 s timeout and kept every pane
            // action disabled for that whole window.
            let reviews_handle = app.handle().clone();
            app.listen("business-reviews", move |event| {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
                    // Unparseable is still an answer the panel must not wait on,
                    // but there is no place id to address it to here.
                    log_error!("event parse reviews payload error: {}", event.payload());
                    return;
                };
                let field = |key: &str| {
                    value
                        .get(key)
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string()
                };
                let place_id = field("placeId");
                let data_id = field("dataId");
                let mut inserted = 0usize;
                match value.get("reviews") {
                    Some(reviews_json) => match parse_review_batch(reviews_json) {
                        Ok((reviews, over_cap, invalid)) => {
                            if over_cap > 0 || invalid > 0 {
                                log_warn!(
                                    "business-reviews: {} row(s) over the {} cap, {} invalid row(s) skipped",
                                    over_cap,
                                    MAX_REVIEW_ROWS,
                                    invalid
                                );
                                reviews_handle
                                    .state::<AppState>()
                                    .record_error(format!(
                                        "business-reviews: {} row(s) over the {} cap and {} invalid row(s) skipped",
                                        over_cap, MAX_REVIEW_ROWS, invalid
                                    ));
                            }
                            inserted =
                                store_reviews(&reviews_handle, reviews, &place_id, &data_id);
                            log_debug!(
                                "reviews stored, newly inserted: {} (place: {})",
                                inserted,
                                crate::logging::redact_place_id(&place_id)
                            );
                        }
                        Err(e) => {
                            reviews_handle
                                .state::<AppState>()
                                .record_error(format!("Failed to parse review rows: {}", e));
                        }
                    },
                    None => {
                        // An error payload (no rows) — surface the reason.
                        let error = field("error");
                        if !error.is_empty() {
                            reviews_handle.state::<AppState>().record_error(format!(
                                "Reviews fetch for {} failed: {}",
                                place_id, error
                            ));
                        }
                    }
                }
                let _ = reviews_handle.emit(
                    "reviews:updated",
                    &serde_json::json!({ "placeId": place_id, "count": inserted }),
                );
            });

            // ========== Listen for the enrich:payload event (Tier-2) ==========
            // The enrichment runner polls for its sequence number; the slot
            // simply keeps the latest answer so a late response can never be
            // mistaken for the current request.
            let enrich_handle = app.handle().clone();
            app.listen("enrich:payload", move |event| {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
                    return;
                };
                let seq = value.get("seq").and_then(|v| v.as_u64()).unwrap_or(0);
                let state = enrich_handle.state::<AppState>();
                if let Ok(mut slot) = state.enrich_payload.lock() {
                    *slot = Some((seq, value));
                };
            });

            // ========== Collector lifecycle ==========
            // The grid runner waits on these two events, so they carry the tile
            // id: matching on the id (plus a sequence number taken before
            // navigating) is what keeps a late event from the previous cell from
            // closing the current one.
            let start_handle = app.handle().clone();
            app.listen("collector:scroll-start", move |event| {
                log_debug!("collector:scroll-start {:?}", event.payload());
                let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
                    return;
                };
                let tile_id = value
                    .get("tileId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string();
                let state = start_handle.state::<AppState>();
                let Ok(mut signal) = state.grid_signal.lock() else {
                    return;
                };
                signal.start_seq += 1;
                signal.start_tile = tile_id;
            });

            let idle_handle = app.handle().clone();
            app.listen("collector:scroll-idle", move |event| {
                log_debug!("collector:scroll-idle {:?}", event.payload());
                let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
                    return;
                };
                let tile_id = value
                    .get("tileId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string();
                let reason = value
                    .get("reason")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string();
                let state = idle_handle.state::<AppState>();
                let Ok(mut signal) = state.grid_signal.lock() else {
                    return;
                };
                signal.idle_seq += 1;
                signal.idle_tile = tile_id;
                signal.idle_reason = reason;
            });

            // ========== Map view reports ==========
            // The grid dialog seeds its centre from what the user is looking at.
            // `eval` cannot return a value, so the page pushes this instead.
            let view_handle = app.handle().clone();
            app.listen("maps:view", move |event| {
                if let Some(view) = collector::parse_map_view(event.payload()) {
                    let state = view_handle.state::<AppState>();
                    log_debug!(
                        "maps:view lat={:.5}, lng={:.5}, zoom={}",
                        view.lat, view.lng, view.zoom
                    );
                    let Ok(mut slot) = state.map_view.lock() else {
                        return;
                    };
                    *slot = Some(view);
                }
            });

            // ========== Dead-page health (P1-2) ==========
            // The injected probe reports consent / captcha / no-results changes
            // while the switch is on. `no-results` is informational — an empty
            // area looks the same from the page — but a consent screen or a
            // captcha means every further navigation is wasted, so a running
            // task is paused here through the same path the pause button takes
            // (job `paused`, tile back to `pending`, switch off, progress
            // emitted). Leaving it to the dead-page streak alone cost two full
            // cells per blocking page before anything happened.
            let health_handle = app.handle().clone();
            app.listen("maps:health", move |event| {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
                    return;
                };
                let health = value.get("state").and_then(|v| v.as_str()).unwrap_or("");
                if health != "consent" && health != "captcha" {
                    return;
                }
                let state = health_handle.state::<AppState>();
                // Nothing to pause: returning before the cooldown is touched
                // matters, because a blocked page reported while the app is idle
                // would otherwise use up the window and leave the next task
                // unpaused for a minute.
                let job_id = state
                    .active_runner
                    .lock()
                    .ok()
                    .and_then(|slot| slot.clone());
                let Some(job_id) = job_id else {
                    return;
                };
                let due = match state.health_blocked_at.lock() {
                    Ok(mut last) => {
                        let due = last
                            .map(|at| at.elapsed() >= HEALTH_PAUSE_COOLDOWN)
                            .unwrap_or(true);
                        if due {
                            *last = Some(std::time::Instant::now());
                        }
                        due
                    }
                    Err(_) => false,
                };
                if !due {
                    return;
                }
                log_warn!(
                    "maps:health {} — pausing task {} until the map page is usable again",
                    health,
                    job_id
                );
                state.record_error(format!(
                    "The Maps page reports {}; the task was paused",
                    health
                ));
                if let Err(error) =
                    crate::commands::pause_running_job(&health_handle, state.inner(), &job_id)
                {
                    log_warn!("maps:health pause failed for {}: {}", job_id, error);
                }
            });

            // ========== Parse degradation (M5 / J-05d) ==========
            // The script has already reset itself to the built-in map before
            // sending this. Drop the remote map so later page loads do not
            // re-apply it, clear the on-disk cache (a bad publish must not
            // survive a restart via the offline path), and refetch once in
            // case a corrected config is already published.
            let degraded_handle = app.handle().clone();
            app.listen("collector:parse-degraded", move |event| {
                log_warn!("parse degraded reported: {:?}", event.payload());
                let state = degraded_handle.state::<AppState>();
                if let Ok(mut slot) = state.remote_field_map.lock() {
                    *slot = None;
                }
                let should_refetch = match state.parse_degraded_at.lock() {
                    Ok(mut last) => {
                        let due = last
                            .map(|at| at.elapsed() >= Duration::from_secs(60))
                            .unwrap_or(true);
                        if due {
                            *last = Some(std::time::Instant::now());
                        }
                        due
                    }
                    Err(_) => false,
                };
                let handle = degraded_handle.clone();
                std::thread::spawn(move || {
                    let data_dir = match handle.path().app_data_dir() {
                        Ok(dir) => dir,
                        Err(_) => return,
                    };
                    remote_config::clear_cache(&data_dir);
                    if !should_refetch {
                        return;
                    }
                    let app_version = handle.package_info().version.to_string();
                    if let Some(map) =
                        remote_config::load_remote_field_map(&data_dir, &app_version)
                    {
                        let state = handle.state::<AppState>();
                        if let Ok(mut slot) = state.remote_field_map.lock() {
                            *slot = Some(map);
                        }
                        push_collector_settings(&handle);
                    }
                });
            });

            // ========== Resize both webviews together with the window ==========
            let handle = app.handle().clone();
            main_window.on_window_event(move |event| match event {
                tauri::WindowEvent::Resized(_) => {
                    // Collapse state and ratio both live in AppState, so the
                    // shared layout function is the whole handler (UI-11).
                    if let Err(error) = crate::apply_split_layout(&handle) {
                        log_warn!("resize apply_split_layout failed: {}", error);
                    }
                }
                // P3-10: a move to a monitor with a different DPI changes the
                // physical inner size without necessarily producing the same
                // `Resized` sequence; re-apply the split so the child webviews
                // still fill the window.
                tauri::WindowEvent::ScaleFactorChanged { .. } => {
                    if let Err(error) = crate::apply_split_layout(&handle) {
                        log_warn!("DPI change apply_split_layout failed: {}", error);
                    }
                }
                // The panel's X used to be a hard kill: the process died mid-tile
                // and a running task only survived as "paused after restart".
                // While work is running the close is forked into a prompt, and
                // the panel is what decides (pause first, or leave immediately).
                // Idle closes stay instant — no extra click for the normal case.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let state = handle.state::<AppState>();
                    if state.closing.load(std::sync::atomic::Ordering::SeqCst) {
                        return;
                    }
                    let job_id = state
                        .db
                        .lock()
                        .ok()
                        .and_then(|conn| db::running_job_id(&conn).ok())
                        .flatten();
                    let mining = state
                        .email_mining
                        .lock()
                        .map(|slot| slot.is_some())
                        .unwrap_or(false);
                    if job_id.is_none() && !mining {
                        return;
                    }
                    api.prevent_close();
                    let _ = handle.emit(
                        "app:close-requested",
                        serde_json::json!({ "jobId": job_id, "emailMining": mining }),
                    );
                }
                _ => {}
            });

            // Maximizing is applied asynchronously, and child webviews do not resize
            // with their window on their own. Re-apply the split once the maximized
            // size is final so both panes fill the window.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                let main_thread_handle = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    let _ = crate::apply_split_layout(&main_thread_handle);
                });
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::navigate_maps,
            commands::on_business_data,
            commands::export_csv,
            commands::export_excel,
            commands::export_json,
            commands::export_jsonl,
            commands::enrich_businesses,
            commands::enrich_stop,
            commands::reveal_export,
            commands::pick_export_dir,
            commands::clear_data,
            commands::undo_clear,
            commands::reload_maps,
            commands::query_businesses,
            commands::selected_businesses,
            commands::set_listening,
            commands::get_collector_state,
            commands::plan_grid,
            commands::create_jobs,
            commands::rename_job,
            commands::duplicate_job,
            commands::rerun_job,
            commands::retry_tile,
            commands::list_job_runs,
            commands::mark_job_exported,
            commands::list_jobs,
            commands::get_job_tiles,
            commands::start_job,
            commands::resume_job,
            commands::pause_job,
            commands::close_app,
            commands::cancel_job,
            commands::job_delete_preview,
            commands::delete_job,
            commands::get_map_view,
            commands::request_map_view,
            commands::fetch_business_reviews,
            commands::get_business_reviews,
            commands::export_reviews_csv,
            commands::export_reviews_excel,
            commands::set_split_ratio,
            commands::set_map_collapsed,
            commands::get_settings,
            commands::update_settings,
            commands::reset_settings,
            commands::get_diagnostics,
            commands::start_email_mining,
            commands::cancel_email_mining,
            commands::ping,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod ingress_tests {
    use super::*;

    fn row(place_id: &str) -> Business {
        Business {
            name: "Shop".into(),
            address: String::new(),
            phone: String::new(),
            rating: 4.5,
            reviews_total: 3,
            lat: 34.05,
            lng: -118.24,
            place_id: place_id.into(),
            website: String::new(),
            types: vec!["store".into()],
            collected_at: 0,
            source_query: String::new(),
            emails: Vec::new(),
            socials: Vec::new(),
            email_source_url: String::new(),
            email_status: String::new(),
            mined_at: 0,
            ..Default::default()
        }
    }

    #[test]
    fn a_clean_batch_is_left_alone() {
        let mut rows = vec![row("ChIJN1t_tDeuEmsRUsoyG83frY4")];
        let report = sanitize_batch(&mut rows);
        assert_eq!(report, IngressReport::default());
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn rows_without_a_usable_place_id_are_dropped() {
        let mut rows = vec![
            row(""),
            row("javascript:alert(1)"),
            row("has space"),
            row("ChIJ-valid_id.1"),
        ];
        let report = sanitize_batch(&mut rows);
        assert_eq!(report.invalid, 3);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].place_id, "ChIJ-valid_id.1");
    }

    /// M8 / J-08f: a NUL byte in a field must not reach the database —
    /// SQLite's `length()` stops at the first NUL, and the exported file
    /// would carry a byte no spreadsheet wants. A NUL in the place id is a
    /// wire artifact rather than a different place, so the row is kept with
    /// the byte removed instead of being dropped.
    #[test]
    fn nul_bytes_are_stripped() {
        let mut business = row("ChIJN1t_tDeuEmsRUsoyG83frY4");
        business.name = "Den\u{0}tal".into();
        business.address = "1 Main\u{0} St".into();
        business.website = "https://x.test/\u{0}".into();
        business.source_query = "dent\u{0}ist".into();
        business.place_id = "ChIJN1t_tDeuEmsRUsoyG83frY\u{0}4".into();
        business.types = vec!["dent\u{0}ist".into()];
        business.emails = vec!["hi@x.test\u{0}".into()];
        business.about = vec![AboutEntry {
            key: "access\u{0}ibility".into(),
            label: "Access\u{0}ibility".into(),
        }];
        business.open_hours = vec![OpenHoursDay {
            day: "Mon\u{0}day".into(),
            periods: vec!["9 AM\u{0} – 5 PM".into()],
        }];

        let mut rows = vec![business];
        let report = sanitize_batch(&mut rows);

        assert_eq!(rows.len(), 1, "a NUL in the place id must not drop the row");
        assert_eq!(rows[0].place_id, "ChIJN1t_tDeuEmsRUsoyG83frY4");
        assert_eq!(rows[0].name, "Dental");
        assert_eq!(rows[0].address, "1 Main St");
        assert_eq!(rows[0].website, "https://x.test/");
        assert_eq!(rows[0].source_query, "dentist");
        assert_eq!(rows[0].types, vec!["dentist".to_string()]);
        assert_eq!(rows[0].emails, vec!["hi@x.test".to_string()]);
        assert_eq!(rows[0].about[0].key, "accessibility");
        assert_eq!(rows[0].about[0].label, "Accessibility");
        assert_eq!(rows[0].open_hours[0].day, "Monday");
        assert_eq!(rows[0].open_hours[0].periods, vec!["9 AM – 5 PM".to_string()]);
        // The row was touched, so the report says so.
        assert_eq!(report.trimmed, 1);
        assert_eq!(report.invalid, 0);
    }

    #[test]
    fn a_batch_is_capped_and_long_fields_are_cut() {
        let mut rows: Vec<Business> = (0..MAX_BATCH_ROWS + 5)
            .map(|index| row(&format!("ChIJ{index}")))
            .collect();
        rows[0].name = "x".repeat(MAX_NAME_CHARS + 10);
        rows[0].types = (0..MAX_TYPES + 3)
            .map(|index| format!("type{index}"))
            .collect();
        rows[0].rating = f64::INFINITY;
        rows[0].lat = 999.0;

        let report = sanitize_batch(&mut rows);
        assert_eq!(report.over_cap, 5);
        assert_eq!(rows.len(), MAX_BATCH_ROWS);
        assert_eq!(report.trimmed, 1);
        assert_eq!(rows[0].name.chars().count(), MAX_NAME_CHARS);
        assert_eq!(rows[0].types.len(), MAX_TYPES);
        assert_eq!(rows[0].rating, 0.0);
        assert_eq!(rows[0].lat, 0.0);
    }

    #[test]
    fn the_rate_window_accepts_normal_traffic_and_rejects_a_flood() {
        let mut window = BatchWindow::default();
        for _ in 0..MAX_BATCHES_PER_WINDOW {
            assert!(window.admit(20));
        }
        // Budget for batches is gone; the report fires once per window.
        assert!(!window.admit(1));
        assert!(window.should_report());
        assert!(!window.should_report());
    }

    #[test]
    fn the_rate_window_also_caps_rows() {
        let mut window = BatchWindow::default();
        assert!(window.admit(MAX_ROWS_PER_WINDOW));
        assert!(!window.admit(1));
    }

    /// P2-7: the cap must apply before deserialization, and one malformed row
    /// must not cost the valid rows in the same payload.
    #[test]
    fn a_business_batch_is_capped_and_skips_only_the_bad_row() {
        let good = serde_json::to_value(row("ChIJN1t_tDeuEmsRUsoyG83frY4"))
            .expect("serialize a row");
        let capped: Vec<serde_json::Value> = (0..MAX_BATCH_ROWS + 5)
            .map(|_| good.clone())
            .collect();
        let (rows, over_cap, invalid) =
            parse_business_batch(&serde_json::Value::Array(capped)).expect("parse capped");
        assert_eq!(rows.len(), MAX_BATCH_ROWS);
        assert_eq!(over_cap, 5);
        assert_eq!(invalid, 0);

        let mixed = serde_json::Value::Array(vec![
            good.clone(),
            serde_json::json!({ "name": "missing everything else" }),
            good,
        ]);
        let (rows, over_cap, invalid) = parse_business_batch(&mixed).expect("parse mixed");
        assert_eq!(rows.len(), 2, "the two good rows survive");
        assert_eq!(over_cap, 0);
        assert_eq!(invalid, 1);
    }

    /// P2-7: the reviews path gets the same bound and the same tolerance.
    #[test]
    fn a_review_batch_is_capped_and_skips_only_the_bad_row() {
        let good = serde_json::to_value(db::ReviewRow::default()).expect("serialize review");
        let capped: Vec<serde_json::Value> = (0..MAX_REVIEW_ROWS + 2)
            .map(|_| good.clone())
            .collect();
        let (rows, over_cap, invalid) =
            parse_review_batch(&serde_json::Value::Array(capped)).expect("parse capped");
        assert_eq!(rows.len(), MAX_REVIEW_ROWS);
        assert_eq!(over_cap, 2);
        assert_eq!(invalid, 0);

        let mixed = serde_json::Value::Array(vec![
            good.clone(),
            serde_json::json!({ "stars": "not a number" }),
            good,
        ]);
        let (rows, over_cap, invalid) = parse_review_batch(&mixed).expect("parse mixed");
        assert_eq!(rows.len(), 2);
        assert_eq!(over_cap, 0);
        assert_eq!(invalid, 1);
    }
}

/// R-38: regression guard for the release-only outage of 2026-10-27.
///
/// `fetch_business_reviews` and the Tier-2 enrichment runner name their page
/// entry points in `eval`, so `intercept.js` must define them in *every*
/// build. They once sat inside the `if (DEBUG_BUILD)` block: `tauri dev`
/// worked and the bundled app failed with `window.__placemillX is not a
/// function` — a 20 s timeout in the drawer and a silent "failed" place in
/// enrichment. The markers in the script are the machine-readable form of
/// the rule; keep them.
#[cfg(test)]
mod intercept_script_tests {
    use super::*;

    const PRODUCTION_ENTRY_POINTS: [&str; 2] =
        ["__placemillFetchReviews", "__placemillParsePlaceState"];

    fn production_section() -> &'static str {
        let begin = "// ---- R-38 production entry points begin ----";
        let end = "// ---- R-38 production entry points end ----";
        let start = INTERCEPT_SCRIPT
            .find(begin)
            .expect("R-38: production entry-point section has no begin marker");
        let stop = INTERCEPT_SCRIPT
            .find(end)
            .expect("R-38: production entry-point section has no end marker");
        assert!(start < stop, "R-38: the section markers are out of order");
        &INTERCEPT_SCRIPT[start..stop]
    }

    #[test]
    fn production_entry_points_are_not_debug_gated() {
        let section = production_section();
        assert!(
            !section
                .lines()
                .any(|line| line.trim_start().starts_with("if (DEBUG_BUILD)")),
            "R-38: a production entry point may not sit inside the debug gate — \
             a release build would lose it"
        );
        for name in PRODUCTION_ENTRY_POINTS {
            let definition = format!("defineEntryPoint('{name}'");
            assert_eq!(
                section.matches(definition.as_str()).count(),
                1,
                "R-38: {name} must be defined exactly once inside the production section"
            );
            assert_eq!(
                INTERCEPT_SCRIPT.matches(definition.as_str()).count(),
                1,
                "R-38: {name} must not be defined a second time outside the section"
            );
        }
    }

    #[test]
    fn the_debug_gate_still_hides_the_development_helpers() {
        let section = production_section();
        assert!(
            INTERCEPT_SCRIPT.contains("if (DEBUG_BUILD) {"),
            "R-31: the debug gate disappeared — check what it used to hide"
        );
        for name in ["__placemillDiag", "__placemillTest"] {
            assert!(
                !section.contains(name),
                "R-31: {name} writes rows into SQLite and must stay debug-only"
            );
        }
    }
}
