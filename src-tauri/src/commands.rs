use crate::logging::{log_debug, log_error, log_info, log_warn};
use crate::collector::{self, MapView};
use crate::db;
use crate::settings::{validate_patch, Settings};
use crate::{
    apply_split, grid, now_ms, store_businesses, AboutEntry, AppState, Business, OpenHoursDay,
    DEFAULT_SPLIT_RATIO,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};

/// Percent-encode a search term so keywords like "bed & breakfast" or non-ASCII
/// text do not break the Maps URL (spaces become `+`).
pub(crate) fn encode_query(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for byte in input.trim().bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Single-flight slots (R-01 / W-03)
// ---------------------------------------------------------------------------

/// RAII release for a single-flight slot.
///
/// Three commands own a slot for the lifetime of a background thread
/// (`email_mining`, `enrich_job`, `review_fetch`), and each has several exits:
/// a poisoned lock, an empty target list, a database error, a worker that ends
/// normally or panics. Clearing by hand is how the miner's slot once leaked and
/// locked the feature until the next restart (R-01); holding the release in
/// `Drop` makes every path release by construction.
///
/// `enrich_businesses` acquires the slot before two fallible reads and had the
/// same hand-written release at the end of its worker only — a database error
/// there would keep `enrich_busy` forever (C-06).
struct SlotGuard {
    app: tauri::AppHandle,
    clear: fn(&AppState),
}

impl SlotGuard {
    fn new(app: &tauri::AppHandle, clear: fn(&AppState)) -> Self {
        Self {
            app: app.clone(),
            clear,
        }
    }
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        (self.clear)(&self.app.state::<AppState>());
    }
}

fn clear_mining_slot(state: &AppState) {
    if let Ok(mut slot) = state.email_mining.lock() {
        *slot = None;
    }
}

fn clear_verify_slot(state: &AppState) {
    if let Ok(mut slot) = state.email_verifying.lock() {
        *slot = None;
    }
}

/// Which of the two mutually exclusive contact jobs a caller wants to start.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ContactJob {
    Mining,
    Verification,
}

/// Claim one contact slot, refusing while the other job runs — atomically.
///
/// "Verification saw the mining slot empty, so it starts" plus "mining saw the
/// verification slot empty, so it starts" is a textbook check-then-act: both
/// commands run on their own async thread, both pass the check, both install
/// their flag, and the two progress bars spin at once. The fix is one critical
/// section around *check and claim*, which is what `contact_lock` is for.
///
/// Takes the three mutexes rather than `&AppState` so the race can be tested
/// without building the whole application state.
fn claim_exclusive(
    lock: &std::sync::Mutex<()>,
    mining: &std::sync::Mutex<Option<Arc<AtomicBool>>>,
    verifying: &std::sync::Mutex<Option<Arc<AtomicBool>>>,
    want: ContactJob,
) -> Result<Arc<AtomicBool>, String> {
    let _critical = lock
        .lock()
        .map_err(|_| "contact state poisoned".to_string())?;
    let mining_busy = mining
        .lock()
        .map(|slot| slot.is_some())
        .unwrap_or(false);
    let verifying_busy = verifying
        .lock()
        .map(|slot| slot.is_some())
        .unwrap_or(false);

    let cancel = Arc::new(AtomicBool::new(false));
    match want {
        ContactJob::Mining => {
            if mining_busy {
                return Err("already-running".to_string());
            }
            if verifying_busy {
                return Err("verify_running".to_string());
            }
            let mut slot = mining
                .lock()
                .map_err(|_| "mining state poisoned".to_string())?;
            *slot = Some(cancel.clone());
        }
        ContactJob::Verification => {
            if verifying_busy {
                return Err("already-running".to_string());
            }
            if mining_busy {
                return Err("mining_running".to_string());
            }
            let mut slot = verifying
                .lock()
                .map_err(|_| "verify state poisoned".to_string())?;
            *slot = Some(cancel.clone());
        }
    }
    Ok(cancel)
}

fn claim_contact_slot(state: &AppState, want: ContactJob) -> Result<Arc<AtomicBool>, String> {
    claim_exclusive(
        &state.contact_lock,
        &state.email_mining,
        &state.email_verifying,
        want,
    )
}

fn clear_enrich_slot(state: &AppState) {
    if let Ok(mut slot) = state.enrich_job.lock() {
        *slot = None;
    }
    // The pane claim is part of the slot's lifetime (P2-1): releasing one without
    // the other would leave the Maps pane owned by a runner that already ended.
    release_pane(state, &crate::PaneOwner::Enrich);
}

fn clear_review_slot(state: &AppState) {
    if let Ok(mut slot) = state.review_fetch.lock() {
        *slot = false;
    }
    release_pane(state, &crate::PaneOwner::Reviews);
}

/// Releases the export single-flight flag on every return path, including a
/// cancelled save dialog or a failed write.
struct ExportGuard<'a> {
    flag: &'a AtomicBool,
}

impl Drop for ExportGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::Release);
    }
}

/// Claim the one export slot. `try` semantics: a second click gets a readable
/// refusal instead of racing the first export's temp-file rename.
fn claim_export(flag: &AtomicBool) -> Result<ExportGuard<'_>, String> {
    if flag.swap(true, Ordering::AcqRel) {
        return Err("export_busy".to_string());
    }
    Ok(ExportGuard { flag })
}

// ---------------------------------------------------------------------------
// Maps-pane ownership (C-01 / W-02)
// ---------------------------------------------------------------------------

/// Which pane-owning states a command must respect before it touches `maps`.
///
/// Five commands replace the Maps document (locate, reviews, enrichment, job
/// start, map-locale change) and every one of them used to spell the checks out
/// on its own, which is how the reviews fetch ended up unchecked by all the
/// others: no command knew it existed. The flags below keep the *intent* of each
/// caller explicit while the check itself lives in exactly one place.
#[derive(Clone, Copy)]
pub(crate) struct PaneCheck {
    /// A grid job is running.
    pub job: bool,
    /// The Tier-2 enrichment runner owns the pane.
    pub enrich: bool,
    /// A reviews fetch is in flight.
    pub reviews: bool,
    /// A collecting session is active (the switch is on).
    pub session: bool,
}

impl PaneCheck {
    /// A pure borrower: locate and the map-locale change.
    pub const ALL: Self = Self {
        job: true,
        enrich: true,
        reviews: true,
        session: true,
    };
    /// `start_job`: it becomes the runner, so it must not refuse itself.
    pub const BECOMING_JOB: Self = Self {
        job: false,
        enrich: true,
        reviews: true,
        session: false,
    };
    /// `enrich_businesses`: takes `enrich_job` right after this check.
    pub const BECOMING_ENRICH: Self = Self {
        job: true,
        enrich: false,
        reviews: true,
        session: true,
    };
    /// `fetch_business_reviews`: takes `review_fetch` right after this check.
    pub const BECOMING_REVIEWS: Self = Self {
        job: true,
        enrich: true,
        reviews: false,
        session: true,
    };
}

/// Pure core of `check_pane`: which refusal a set of owners produces.
///
/// Kept apart from the locks so the priority order — and, more importantly,
/// which owners a *becoming* caller ignores — has a test instead of only a code
/// path. Errors carry the codes the panel parses (`map_busy:<id>`,
/// `enrich_busy`, `reviews_busy`, `session_active`).
fn pane_conflict(
    running_job: Option<&str>,
    owner: Option<&crate::PaneOwner>,
    session: bool,
    check: PaneCheck,
) -> Option<String> {
    if check.job {
        if let Some(crate::PaneOwner::Job(id)) = owner {
            return Some(format!("map_busy:{}", id));
        }
        if let Some(id) = running_job {
            return Some(format!("map_busy:{}", id));
        }
    }
    if check.enrich && matches!(owner, Some(crate::PaneOwner::Enrich)) {
        return Some("enrich_busy".to_string());
    }
    if check.reviews && matches!(owner, Some(crate::PaneOwner::Reviews)) {
        return Some("reviews_busy".to_string());
    }
    if check.session && session {
        return Some("session_active".to_string());
    }
    None
}

/// The refusal code for a pane another operation already holds.
fn owner_code(owner: &crate::PaneOwner) -> String {
    match owner {
        crate::PaneOwner::Job(id) => format!("map_busy:{}", id),
        crate::PaneOwner::Enrich => "enrich_busy".to_string(),
        crate::PaneOwner::Reviews => "reviews_busy".to_string(),
    }
}

/// Refuse when another operation owns the Maps pane.
///
/// Borrowers only (`navigate_maps`, the map-locale change): a command that
/// becomes an owner must use `claim_pane`, which checks and claims in one step.
pub(crate) fn check_pane(state: &AppState, check: PaneCheck) -> Result<(), String> {
    // The job row is read only when the caller actually respects it: a job
    // start is the owner, and querying for "another running job" would race its
    // own claim for no benefit.
    let running = if check.job {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::running_job_id(&conn).map_err(|e| e.to_string())?
    } else {
        None
    };
    let owner = state.pane_owner.lock().ok().and_then(|slot| slot.clone());
    // `switch_on`, not `session_active`: the latter answers `true` whenever the
    // e2e fixture override is set, which would make every pane command refuse
    // itself in the suites (C-01).
    let session = check.session && crate::switch_on(state);
    match pane_conflict(running.as_deref(), owner.as_ref(), session, check) {
        Some(code) => Err(code),
        None => Ok(()),
    }
}

/// Claim the Maps pane for `owner`, or say who already has it (P2-1).
///
/// The check and the claim are one step under `pane_owner`: the old shape read
/// `active_runner` / `enrich_job` / `review_fetch` in `check_pane` and each
/// command claimed its own slot afterwards, so a job start and a reviews fetch
/// could both pass the check and both navigate the pane. The three operational
/// slots stay as they are — they hold cancellation state and the runner id —
/// but nobody decides ownership from them any more.
pub(crate) fn claim_pane(
    state: &AppState,
    check: PaneCheck,
    owner: crate::PaneOwner,
) -> Result<(), String> {
    // Read the job row before taking the owner lock: no lock is held while
    // acquiring `db` (see AppState's lock order), and a job that is about to run
    // has already claimed the pane — `start_job` claims before it flips the
    // status.
    let running = if check.job {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::running_job_id(&conn).map_err(|e| e.to_string())?
    } else {
        None
    };
    let session = check.session && crate::switch_on(state);
    let blocked = if check.job {
        running.map(|id| format!("map_busy:{}", id))
    } else {
        None
    };

    let mut slot = state
        .pane_owner
        .lock()
        .map_err(|_| "pane_unavailable".to_string())?;
    claim_slot(&mut slot, blocked, session, owner)
}

/// Pure core of `claim_pane`: take the pane or explain why not.
///
/// The slot is the whole mutex, so two commands calling this concurrently
/// cannot both succeed — one of them always observes `Some`.
fn claim_slot(
    slot: &mut Option<crate::PaneOwner>,
    blocked: Option<String>,
    session: bool,
    owner: crate::PaneOwner,
) -> Result<(), String> {
    if let Some(existing) = slot.as_ref() {
        return Err(owner_code(existing));
    }
    if let Some(code) = blocked {
        return Err(code);
    }
    if session {
        return Err("session_active".to_string());
    }
    *slot = Some(owner);
    Ok(())
}

/// Release the pane if `owner` is still the one holding it.
///
/// The identity check matters: a paused job's runner can exit after the user
/// already started something else, and clearing the slot blindly would hand the
/// pane to a second operation at the same time.
pub(crate) fn release_pane(state: &AppState, owner: &crate::PaneOwner) {
    if let Ok(mut slot) = state.pane_owner.lock() {
        release_pane_slot(&mut slot, owner);
    }
}

/// Pure core of `release_pane`.
fn release_pane_slot(slot: &mut Option<crate::PaneOwner>, owner: &crate::PaneOwner) {
    if slot.as_ref() == Some(owner) {
        *slot = None;
    }
}

/// Hand the pane to `owner` without checking. Only the runner uses this, when
/// it chains to the next queued job while already holding it.
pub(crate) fn set_pane_owner(state: &AppState, owner: crate::PaneOwner) {
    if let Ok(mut slot) = state.pane_owner.lock() {
        *slot = Some(owner);
    }
}

/// Jump the Google Maps child webview to a specific business (used by the
/// "locate on map" action). Searching is intentionally left to the user, because
/// driving the URL from the sidebar changes the map location.
#[tauri::command]
pub async fn navigate_maps(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    keyword: String,
    lat: f64,
    lng: f64,
    zoom: Option<u8>,
) -> Result<(), String> {
    let keyword = keyword.trim().to_string();
    if keyword.is_empty() {
        return Err("Missing business name".to_string());
    }

    // A running task, the enrichment runner, a reviews fetch and an active
    // collecting session all own the pane. Navigating away would feed another
    // search into the cell that is scrolling, or make a reviews/enrich sequence
    // read a document it never loaded. The panel disables the button too; this
    // is the final guard for shortcuts and future callers.
    check_pane(state.inner(), PaneCheck::ALL)?;

    // Keep `hl`/`gl` in sync with the map pane, otherwise locating a business
    // would flip the map back to English while the panel says Chinese.
    let locale_query = state
        .settings
        .lock()
        .map(|settings| settings.maps_locale_query())
        .map_err(|e| e.to_string())?;

    let encoded_keyword = encode_query(&keyword);

    // Pinning the map only makes sense when we actually have coordinates.
    let url = if lat.abs() > 0.0001 || lng.abs() > 0.0001 {
        format!(
            "https://www.google.com/maps/search/{}/@{},{},{}z?{}",
            encoded_keyword,
            lat,
            lng,
            zoom.unwrap_or(17),
            locale_query
        )
    } else {
        format!(
            "https://www.google.com/maps/search/{}?{}",
            encoded_keyword, locale_query
        )
    };

    log_debug!("navigate_maps: keyword={}, url={}", keyword, url);

    let maps_webview = app
        .get_webview("maps")
        .ok_or("Maps view is not ready yet")?;

    // R-17: no panic surface in a command — a String serialization cannot
    // fail, and if it somehow did the fallback navigates to about:blank
    // instead of taking the process down.
    let js = format!(
        "window.location.href = {};",
        serde_json::to_string(&url).unwrap_or_else(|_| "\"about:blank\"".to_string())
    );
    maps_webview.eval(&js).map_err(|e| e.to_string())?;

    Ok(())
}

/// Called through invoke once the webview has intercepted data.
///
/// Legacy path (the injected script emits `business-data` instead): it has no
/// batch metadata, so the rows are stored without a source query or job id. It
/// is an IPC invoke rather than a page event, so it carries no epoch and is
/// stamped with the current one — the clear guard exists for batches that were
/// produced by the page before a clear (P1-4).
#[tauri::command(async)]
pub fn on_business_data(
    app: tauri::AppHandle,
    businesses: Vec<Business>,
) -> Result<(), String> {
    let epoch = app
        .state::<AppState>()
        .collection_epoch
        .load(Ordering::Acquire);
    store_businesses(&app, businesses, "", "", Some(epoch));
    Ok(())
}

/// Diagnostic helper: check whether IPC communication works.
///
/// R-29: debug builds only. The command answers anything that reaches the IPC
/// bridge, and `get_diagnostics` already covers what the panel needs, so a
/// release build gains nothing by keeping a free liveness probe around.
///
/// `cfg!` rather than `#[cfg(debug_assertions)]`: `generate_handler!` takes
/// command paths, not attributes, so a conditional registration would mean
/// duplicating the whole 40-entry list in `lib.rs`.
#[tauri::command]
pub async fn ping(msg: String) -> Result<String, String> {
    if !cfg!(debug_assertions) {
        return Err("ping is only available in debug builds".to_string());
    }
    log_info!("ping received: {}", msg);
    Ok(format!("pong: {}", msg))
}

// ---------------------------------------------------------------------------
// Site email/social mining (M7 / G-03)
// ---------------------------------------------------------------------------

/// Scope of one mining run: an explicit selection (place ids) or the current
/// browse filter — the same two scopes the export commands accept.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailMineRequest {
    #[serde(default)]
    pub place_ids: Vec<String>,
    pub filter: Option<BusinessQueryRequest>,
    /// Re-mine rows that already carry a mining result. Default keeps the
    /// miner idempotent: anything with an `email_status` is skipped.
    #[serde(default)]
    pub force: bool,
}

/// RAII holder for the `email_mining` single-flight slot (R-01).
///
/// Start mining the given scope. Returns the number of distinct domains that
/// will be visited (rows sharing a website are mined together). Single-flight:
/// a second run is refused while one is active. `email:progress` events fire
/// per site, `email:done` once the run ends.
#[tauri::command]
pub async fn start_email_mining(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: EmailMineRequest,
) -> Result<usize, String> {
    // Reserve the single-flight slot BEFORE any other work: two rapid
    // invocations run on separate runtime threads and can interleave between
    // sync statements, so a check-then-later-set pattern would let both pass.
    // Since G-04 the claim also excludes a running verification, in the same
    // critical section (see `claim_exclusive`).
    let cancel = claim_contact_slot(state.inner(), ContactJob::Mining)?;
    // The guard owns the slot from here on: every `?` below, the empty-target
    // return and the spawned worker all release it on the way out (R-01).
    let guard = SlotGuard::new(&app, clear_mining_slot);

    let rows: Vec<(String, String)> = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        if !request.place_ids.is_empty() {
            crate::db::mining_targets(
                &conn,
                Some(&request.place_ids),
                None,
                request.force,
            )
            .map_err(|e| e.to_string())?
        } else if let Some(filter_request) = &request.filter {
            crate::db::mining_targets(&conn, None, Some(&filter_request.filter()), request.force)
                .map_err(|e| e.to_string())?
        } else {
            Vec::new()
        }
    };
    let targets = crate::email_miner::group_by_domain(rows);
    let total = targets.len();
    if total == 0 {
        // Nothing to do — and the caller deserves to know *why*. An empty list
        // has three different causes, and the panel used to report all of them
        // as "no rows with a website", which is plainly wrong when the row has
        // one and was simply mined before (C-15).
        let filter = request
            .filter
            .as_ref()
            .filter(|_| request.place_ids.is_empty())
            .map(|request| request.filter());
        let ids = (!request.place_ids.is_empty()).then_some(request.place_ids.as_slice());
        let summary = {
            let conn = state.db.lock().map_err(|e| e.to_string())?;
            crate::db::mining_scope_summary(&conn, ids, filter.as_ref())
                .map_err(|e| e.to_string())?
        };
        let code = if summary.with_website == 0 {
            "nothing_to_mine:no_website"
        } else if summary.already_mined == summary.with_website {
            "nothing_to_mine:already_mined"
        } else {
            // The rows have websites and were never mined, yet produced no
            // target: `site_candidates` dropped every URL (private host, bad
            // scheme, unparsable). Worth saying out loud instead of blaming a
            // missing website.
            "nothing_to_mine:unusable_website"
        };
        log_info!(
            "mining: no targets ({}; {} row(s) with a website, {} already mined), slot released",
            code,
            summary.with_website,
            summary.already_mined
        );
        return Err(code.to_string());
    }

    let rules = state
        .remote_field_map
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|remote| remote.email_rules.clone()))
        .unwrap_or_default();

    let worker_app = app.clone();
    let worker_cancel = cancel.clone();
    std::thread::spawn(move || {
        // The worker owns the slot: the guard releases it when this thread
        // ends, whether `run_mining` returns normally or its panic is caught
        // below (R-01).
        let _slot_guard = guard;
        // A panic inside the engine must not leave the single-flight slot set
        // forever — that would kill mining until the next app restart.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::email_miner::run_mining(&worker_app, targets, rules, &worker_cancel)
        }));
        let summary = match outcome {
            Ok(summary) => summary,
            Err(panic) => {
                let reason = panic
                    .downcast_ref::<&str>()
                    .map(|text| text.to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown panic".to_string());
                log_error!("mining engine panicked: {}", reason);
                crate::email_miner::MineSummary {
                    total: 0,
                    done: 0,
                    found: 0,
                    blocked: 0,
                    failed: 0,
                    cancelled: true,
                }
            }
        };
        log_info!(
            "mining finished: {}/{} sites, {} with emails, {} blocked, {} failed{}",
            summary.done,
            summary.total,
            summary.found,
            summary.blocked,
            summary.failed,
            if summary.cancelled { " (cancelled)" } else { "" }
        );
        let _ = worker_app.emit(
            "email:done",
            serde_json::json!({
                "total": summary.total,
                "done": summary.done,
                "found": summary.found,
                "blocked": summary.blocked,
                "failed": summary.failed,
                "cancelled": summary.cancelled,
            }),
        );
    });

    log_info!("mining started: {} sites", total);
    Ok(total)
}

/// Ask the running mining job to stop. Sites already in flight finish their
/// current request; no further pages are fetched afterwards.
#[tauri::command]
pub async fn cancel_email_mining(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Ok(slot) = state.email_mining.lock() {
        if let Some(cancel) = slot.as_ref() {
            cancel.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Email verification (G-04)
// ---------------------------------------------------------------------------

/// Scope of one verification run — the same two scopes mining and export use.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailVerifyRequest {
    #[serde(default)]
    pub place_ids: Vec<String>,
    pub filter: Option<BusinessQueryRequest>,
    /// Re-check addresses that are still fresh. Default keeps the run cheap:
    /// anything with an unexpired verdict is skipped.
    #[serde(default)]
    pub force: bool,
}

/// What a run would do, decided in Rust so the panel never carries a second
/// copy of a threshold (D10).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyPlan {
    pub rows: u64,
    pub addresses: u64,
    pub cached: u64,
    pub pending: u64,
    pub local_invalid: u64,
    pub lookups: u64,
    pub too_many: bool,
    pub limit: u64,
    /// The backend decides whether the UI must confirm: filter scope and
    /// `pending` above `CONFIRM_VERIFY_ADDRESSES`. Keeping the threshold in
    /// Rust means the panel never carries a second copy of it.
    pub confirm: bool,
}

/// The plan plus the addresses it was computed from — `start` needs both, and
/// recomputing the scope between the two would let them disagree.
struct VerifyTarget {
    plan: VerifyPlan,
    addresses: Vec<String>,
}

fn verify_rules(state: &AppState) -> crate::remote_config::VerifyRules {
    state
        .remote_field_map
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|remote| remote.verify_rules.clone()))
        .unwrap_or_default()
}

/// Read the scope and derive the plan. Read-only: no slot, no network.
fn verify_target(state: &AppState, request: &EmailVerifyRequest) -> Result<VerifyTarget, String> {
    use crate::email_verify::{CONFIRM_VERIFY_ADDRESSES, MAX_RUN_ADDRESSES};

    let ids = (!request.place_ids.is_empty()).then_some(request.place_ids.as_slice());
    let filter = request
        .filter
        .as_ref()
        .filter(|_| ids.is_none())
        .map(|request| request.filter());
    let rules = verify_rules(state);

    // A read-only connection: scanning 20k addresses out of JSON arrays is fast
    // but there is no reason for the collector or the panel to queue behind it.
    let conn = db::open_read_connection(std::path::Path::new(&state.db_path))
        .map_err(|error| format!("verify_scope: {}", error))?;
    let now = now_ms() as i64;
    let scope = db::verify_scope(&conn, ids, filter.as_ref(), MAX_RUN_ADDRESSES, now)
        .map_err(|error| error.to_string())?;

    if scope.addresses.len() as u64 > MAX_RUN_ADDRESSES {
        return Ok(VerifyTarget {
            plan: VerifyPlan {
                rows: scope.rows,
                addresses: scope.addresses_total,
                cached: 0,
                pending: 0,
                local_invalid: 0,
                lookups: 0,
                too_many: true,
                limit: MAX_RUN_ADDRESSES,
                confirm: false,
            },
            addresses: Vec::new(),
        });
    }

    let fresh: std::collections::HashSet<String> = if request.force {
        std::collections::HashSet::new()
    } else {
        db::fresh_verifications(&conn, &scope.addresses, now)
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|(address, _)| address)
            .collect()
    };
    let pending: Vec<String> = scope
        .addresses
        .iter()
        .filter(|address| !fresh.contains(*address))
        .cloned()
        .collect();

    let mut local_invalid = 0u64;
    let mut domains: std::collections::HashSet<String> = std::collections::HashSet::new();
    for address in &pending {
        let analysis = crate::email_verify::analyze_with(address, &rules.disposable_domains);
        if analysis.settled.is_some() {
            local_invalid += 1;
        } else if !analysis.ascii_domain.is_empty() {
            domains.insert(analysis.ascii_domain);
        }
    }
    let domain_list: Vec<String> = domains.into_iter().collect();
    let lookups = if request.force || domain_list.is_empty() {
        domain_list.len() as u64
    } else {
        let cached = db::domain_checks(&conn, &domain_list).map_err(|error| error.to_string())?;
        let fresh_domains = cached.iter().filter(|check| check.expires_at > now).count() as u64;
        (domain_list.len() as u64).saturating_sub(fresh_domains)
    };

    Ok(VerifyTarget {
        plan: VerifyPlan {
            rows: scope.rows,
            addresses: scope.addresses_total,
            cached: scope.cached,
            pending: pending.len() as u64,
            local_invalid,
            lookups,
            too_many: false,
            limit: MAX_RUN_ADDRESSES,
            // A selection is an explicit act; a filter can be "everything".
            confirm: ids.is_none() && pending.len() as u64 > CONFIRM_VERIFY_ADDRESSES,
        },
        addresses: scope.addresses,
    })
}

/// Preflight: what would a run over this scope do? Read-only, no slot.
#[tauri::command(async)]
pub fn verify_email_plan(
    state: tauri::State<'_, AppState>,
    request: EmailVerifyRequest,
) -> Result<VerifyPlan, String> {
    Ok(verify_target(state.inner(), &request)?.plan)
}

/// Start a verification run: claim the slot, enumerate the scope, spawn.
///
/// The returned plan is the one this run actually accepted — the panel uses it
/// to label the progress bar and must not recompute it.
#[tauri::command(async)]
pub async fn start_email_verification(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: EmailVerifyRequest,
) -> Result<VerifyPlan, String> {
    let cancel = claim_contact_slot(state.inner(), ContactJob::Verification)?;
    // The guard owns the slot from here on: every `?` below releases it.
    let guard = SlotGuard::new(&app, clear_verify_slot);

    let target = verify_target(state.inner(), &request)?;
    if target.plan.too_many {
        return Err("too_many".to_string());
    }
    if target.addresses.is_empty() {
        return Err("nothing_to_verify:no_emails".to_string());
    }
    if target.plan.pending == 0 && !request.force {
        return Err("nothing_to_verify:already_verified".to_string());
    }

    let rules = verify_rules(state.inner());
    let run = crate::email_verify::VerifyRun {
        addresses: target.addresses,
        endpoints: crate::email_verify::resolve_endpoints(&rules.doh_endpoints),
        disposable_extra: rules.disposable_domains,
        force: request.force,
        epoch: state.verification_epoch.load(Ordering::SeqCst),
    };
    let plan = target.plan;

    let worker_app = app.clone();
    let worker_cancel = cancel.clone();
    std::thread::spawn(move || {
        let _slot_guard = guard;
        // A panic must not leave the single-flight slot set until restart.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::email_verify::run_verification(&worker_app, run, &worker_cancel)
        }));
        if let Err(panic) = outcome {
            let reason = panic
                .downcast_ref::<&str>()
                .map(|text| text.to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());
            log_error!("verification engine panicked: {}", reason);
            let _ = worker_app.emit(
                "email:verify:done",
                serde_json::json!({
                    "total": 0, "done": 0, "cached": 0, "lookups": 0,
                    "valid": 0, "risky": 0, "invalid": 0, "unknown": 0, "error": 0,
                    "cancelled": true, "reason": "", "fatal": "panic",
                }),
            );
        }
    });

    log_info!(
        "verification started: {} address(es), {} pending, {} lookups",
        plan.addresses,
        plan.pending,
        plan.lookups
    );
    Ok(plan)
}

/// Ask the running verification to stop. No run = a harmless no-op.
#[tauri::command]
pub async fn cancel_email_verification(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Ok(slot) = state.email_verifying.lock() {
        if let Some(cancel) = slot.as_ref() {
            cancel.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Paged browsing (M6)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusinessQueryRequest {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub rating: String,
    #[serde(default)]
    pub contact: String,
    #[serde(default)]
    pub types: Vec<String>,
    #[serde(default)]
    pub job_id: String,
    /// Only rows no job has observed (T-02).
    #[serde(default)]
    pub unassigned: bool,
    /// With `job_id`: only places the job first saw at/after this epoch ms
    /// (P2 "only new").
    #[serde(default)]
    pub job_seen_since: i64,
    /// Epoch milliseconds; `0` (the default) means no time dimension.
    #[serde(default)]
    pub collected_since: i64,
    /// G-04: `all` | `valid` | `usable` | `invalid` | `unverified`. Unknown
    /// values mean "no filter", like every other dimension.
    #[serde(default)]
    pub verify: String,
    #[serde(default)]
    pub sort: String,
    #[serde(default)]
    pub direction: String,
    #[serde(default)]
    pub page: u32,
    #[serde(default)]
    pub page_size: u32,
}

impl BusinessQueryRequest {
    fn filter(&self) -> db::BusinessFilter {
        db::BusinessFilter {
            query: self.query.clone(),
            rating: self.rating.clone(),
            contact: self.contact.clone(),
            types: self.types.clone(),
            job_id: self.job_id.clone(),
            unassigned: self.unassigned,
            job_seen_since: self.job_seen_since,
            collected_since: self.collected_since,
            verify: self.verify.clone(),
        }
    }

    fn sort(&self) -> db::BusinessSort {
        db::BusinessSort {
            field: self.sort.clone(),
            direction: self.direction.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// G-16 · NAP normalization (read path)
// ---------------------------------------------------------------------------

/// The E.164 country code for the map-region setting, when the region is one
/// this build pins (`''` means "let Google decide" — then no country code can
/// be derived safely and non-`+` numbers stay exactly as Google formatted
/// them). Guessing a code from coordinates would be geocoding, which the G-16
/// scope excludes.
fn dial_code_for_region(region: &str) -> Option<&'static str> {
    match region {
        "US" => Some("1"),
        "CN" => Some("86"),
        "ES" => Some("34"),
        _ => None,
    }
}

/// G-16: normalize one phone number toward E.164 — one leading `+`, digits
/// only. `region` is the map-region setting (`"US"` / `"CN"` / `"ES"`, `""` =
/// let Google decide). The policy is deliberately **conservative**:
///
/// - a number that already carries `+` always canonicalizes (the country code
///   is the caller's own claim, re-formatting loses nothing);
/// - a bare number gets a country code **only** when the digit count matches
///   the pinned region's exact subscriber shape — a wrong-region guess must be
///   a no-op, not a mangled number, so anything implausible is returned as it
///   arrived;
/// - NANP shapes additionally require the area code and the exchange to start
///   2–9, which is what keeps a Chinese mobile (`138…`) from masquerading as
///   `+1 380…` under a US region.
///
/// No numbering-plan database: extensions are cut at the common markers, and
/// everything else is the three regions this build pins.
fn normalize_phone_e164(raw: &str, region: Option<&str>) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // Extensions first: `#`, `转`, `ext` — the letters would vanish in the
    // digit pass and their digits would splice onto the subscriber number.
    // `to_ascii_lowercase` keeps byte offsets valid for non-ASCII input.
    let lower = trimmed.to_ascii_lowercase();
    let cut = [
        trimmed.find('#'),
        trimmed.find('转'),
        lower.find("ext"),
    ]
    .into_iter()
    .flatten()
    .min()
    .unwrap_or(trimmed.len());
    let number_part = &trimmed[..cut];

    let has_plus = number_part.trim_start().starts_with('+');
    let digits: String = number_part.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return trimmed.to_string();
    }
    if has_plus {
        // E.164 caps at 15 digits; below 8 the `+` number is not dialable, so
        // both bounds keep the original rather than "normalize" a fragment.
        if (8..=15).contains(&digits.len()) {
            return format!("+{}", digits);
        }
        return trimmed.to_string();
    }

    let Some(dial) = region.and_then(dial_code_for_region) else {
        return trimmed.to_string();
    };
    let mut subscriber = digits.as_str();
    // CN landlines dial as 0AA-BBBB-BBBB; the trunk `0` is not part of E.164.
    if dial == "86" && subscriber.starts_with('0') {
        subscriber = &subscriber[1..];
    }
    // A dial code already glued onto the number (no `+`) is stripped, not
    // doubled.
    if let Some(rest) = subscriber.strip_prefix(dial) {
        if rest.len() >= 7 {
            subscriber = rest;
        }
    }
    let plausible = match dial {
        // NANP: 10 digits, area code and exchange both 2–9.
        "1" => {
            subscriber.len() == 10
                && subscriber.as_bytes()[0].is_ascii_digit()
                && (b'2'..=b'9').contains(&subscriber.as_bytes()[0])
                && (b'2'..=b'9').contains(&subscriber.as_bytes()[3])
        }
        // CN: landline 10 digits (after the trunk), mobile 11.
        "86" => (10..=11).contains(&subscriber.len()),
        // ES: every geographic and mobile number is 9 digits.
        "34" => {
            subscriber.len() == 9
                && matches!(subscriber.as_bytes()[0], b'6' | b'7' | b'8' | b'9')
        }
        _ => false,
    };
    if !plausible {
        return trimmed.to_string();
    }
    format!("+{}{}", dial, subscriber)
}

/// G-16: collapse the whitespace runs a scraped text can carry (double spaces,
/// stray tabs, the odd line break) and trim the ends. No separator rewriting —
/// the address is Google's format, only tidied. `true` when the value changed.
fn tidy_spaces(value: &mut String) -> bool {
    let collapsed: String = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed != *value {
        *value = collapsed;
        true
    } else {
        false
    }
}

/// Normalize one row in place: phones toward E.164, the NAP text fields
/// whitespace-tidied. Idempotent and read-path only — the raw values stay in
/// SQLite, every consumer (table pages, selections, all export formats) sees
/// the clean form, and rows collected before G-16 heal on sight.
fn normalize_nap_row(business: &mut Business, map_region: &str) {
    business.phone = normalize_phone_e164(&business.phone, Some(map_region));
    tidy_spaces(&mut business.address);
    tidy_spaces(&mut business.street);
    tidy_spaces(&mut business.city);
    tidy_spaces(&mut business.state);
    tidy_spaces(&mut business.postal_code);
    tidy_spaces(&mut business.country);
    tidy_spaces(&mut business.borough);
}

/// The batch form, for callers that already hold the rows.
fn normalize_nap_rows(rows: &mut [Business], map_region: &str) {
    for business in rows.iter_mut() {
        normalize_nap_row(business, map_region);
    }
}

/// The `map_region` snapshot for normalization; a poisoned lock degrades to
/// "no region" (bare numbers stay as stored) rather than failing the read.
fn region_for_normalization(state: &AppState) -> String {
    state
        .settings
        .lock()
        .map(|settings| settings.map_region.clone())
        .unwrap_or_default()
}

/// One page of rows plus the aggregates the panel used to compute client-side.
/// The duration is recorded for the diagnostics p95 (J-06d) and also returned so
/// the caller can show it without another round trip.
/// `(async)`: at 100k rows a page query is ~50 ms, and a synchronous command
/// would spend that on the UI thread.
#[tauri::command(async)]
pub async fn query_businesses(
    state: tauri::State<'_, AppState>,
    request: BusinessQueryRequest,
) -> Result<db::BusinessPage, String> {
    let started = std::time::Instant::now();
    let mut page = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::query_businesses(
            &conn,
            &request.filter(),
            &request.sort(),
            request.page,
            if request.page_size == 0 { 50 } else { request.page_size },
            // R-14: the filter-independent half of the answer (unfiltered
            // count + type census) is cached next to the connection and
            // invalidated by its write counter.
            Some(&state.dashboard),
        )
        .map_err(|e| e.to_string())?
    };
    // G-16: the table reads normalized rows, so legacy data heals on sight and
    // the panel never argues with its own exports about a number's shape.
    normalize_nap_rows(&mut page.rows, &region_for_normalization(state.inner()));
    state.record_query(started.elapsed().as_millis() as u64);
    Ok(page)
}

/// Fresh copies of the rows the panel currently has selected (R-23).
///
/// The selection is a snapshot taken at click time, so a later writer (email
/// mining, a duplicate-strategy upsert) can leave it carrying old emails. The
/// panel calls this after such a writer finishes and swaps the returned rows
/// into its selection. Unknown ids are simply absent from the answer.
#[tauri::command(async)]
pub fn selected_businesses(
    state: tauri::State<'_, AppState>,
    place_ids: Vec<String>,
) -> Result<Vec<Business>, String> {
    if place_ids.is_empty() {
        return Ok(Vec::new());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut rows = db::businesses_by_ids(&conn, &place_ids).map_err(|e| e.to_string())?;
    drop(conn);
    // G-16: selections feed copy-phones, the drawer and (as explicit rows) the
    // export commands — same normalized shape the table shows.
    normalize_nap_rows(&mut rows, &region_for_normalization(state.inner()));
    Ok(rows)
}

/// Where an export's rows come from (P2-12).
///
/// An explicit selection is already in memory and bounded by what the panel can
/// hold. A filter is counted before the save dialog and then *streamed* from a
/// dedicated read-only connection: the shared `state.db` mutex is never held
/// during the scan, so the panel and the collector keep working while a large
/// file is written.
enum ExportSource {
    Rows(Vec<Business>),
    Query {
        request: BusinessQueryRequest,
        db_path: std::path::PathBuf,
        /// The `map_region` snapshot, taken before the dialog so the stream
        /// normalizes exactly like the table does.
        region: String,
    },
}

impl ExportSource {
    /// How many rows the export will write, without materializing them.
    fn count(&self) -> Result<usize, String> {
        match self {
            Self::Rows(rows) => Ok(rows.len()),
            Self::Query {
                request, db_path, ..
            } => {
                let conn = db::open_read_connection(db_path)
                    .map_err(|error| format!("Failed to open the export snapshot: {}", error))?;
                let total = db::count_businesses_filtered(&conn, &request.filter())
                    .map_err(|error| error.to_string())?;
                usize::try_from(total.max(0))
                    .map_err(|_| "the export row count does not fit this build".to_string())
            }
        }
    }

    /// Visit every row exactly once, in the export's order.
    fn for_each<F>(&self, mut visit: F) -> Result<usize, String>
    where
        F: FnMut(&Business) -> Result<(), String>,
    {
        match self {
            Self::Rows(rows) => {
                for row in rows {
                    visit(row)?;
                }
                Ok(rows.len())
            }
            Self::Query {
                request,
                db_path,
                region,
            } => {
                let conn = db::open_read_connection(db_path)
                    .map_err(|error| format!("Failed to open the export snapshot: {}", error))?;
                db::stream_businesses_filtered(
                    &conn,
                    &request.filter(),
                    &request.sort(),
                    |mut business| {
                        // G-16: the export heals legacy rows exactly like the
                        // table, one row at a time.
                        normalize_nap_row(&mut business, region);
                        visit(&business)
                    },
                )
            }
        }
    }
}

/// Resolve the export source: an explicit selection, or a filter to stream.
fn prepare_export_source(
    state: &AppState,
    businesses: Vec<Business>,
    filter: Option<BusinessQueryRequest>,
) -> Result<ExportSource, String> {
    // R-35: the panel sends exactly one of the two. Preferring the rows when
    // both arrived used to be silent, which is how "export all filtered" could
    // ship a single page without anyone noticing.
    if !businesses.is_empty() && filter.is_some() {
        return Err("export_ambiguous: pass either rows or a filter".to_string());
    }
    if !businesses.is_empty() {
        // Explicit rows came from the panel's selection — already normalized
        // by `selected_businesses`, but the pass is idempotent and a stale
        // snapshot must not leak raw values into a file.
        let mut businesses = businesses;
        normalize_nap_rows(&mut businesses, &region_for_normalization(state));
        return Ok(ExportSource::Rows(businesses));
    }
    let Some(request) = filter else {
        return Err("Nothing to export".to_string());
    };
    Ok(ExportSource::Query {
        request,
        db_path: std::path::PathBuf::from(&state.db_path),
        region: region_for_normalization(state),
    })
}

/// One job row, or the error the panel already understands (R-35).
///
/// Eight commands repeated `load_job(..)?.ok_or_else(|| "job_not_found")`, which
/// is easy to get subtly wrong — dropping the `ok_or_else` turns a missing row
/// into `Ok(None)` and the caller then reports a blank job instead of an error.
fn job_by_id(conn: &rusqlite::Connection, id: &str) -> Result<db::JobRow, String> {
    db::load_job(conn, id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "job_not_found".to_string())
}

/// Same lookup for commands that no longer hold the connection and go through
/// the collector (which keeps its own connection thread).
fn loaded_job(app: &tauri::AppHandle, id: &str) -> Result<db::JobRow, String> {
    collector::load_job(app, id).ok_or_else(|| "job_not_found".to_string())
}

/// Reduce a user-provided template to a safe file name.
///
/// Only the file stem is kept, so a template full of `../` cannot escape the
/// directory the user picked, and characters Windows rejects become `-`.
fn safe_file_name(raw: &str, extension: &str) -> String {
    // Split on both separators by hand instead of using `Path::file_name()`:
    // on Windows a leading `X:` is parsed as a *drive prefix*, so a template like
    // "leads: {date}" would silently lose everything before the colon.
    let stem = raw.trim().rsplit(['/', '\\']).next().unwrap_or("").trim();
    let stem = if stem == "." || stem == ".." { "" } else { stem };

    let cleaned: String = stem
        .chars()
        .map(|ch| {
            if ch.is_control() || "\\/:*?\"<>|".contains(ch) {
                '-'
            } else {
                ch
            }
        })
        .collect();

    let cleaned = cleaned.trim().trim_end_matches('.').trim().to_string();
    let mut base = if cleaned.is_empty() {
        "placemill-export".to_string()
    } else {
        cleaned.chars().take(100).collect::<String>()
    };

    // R-35: Windows reserves these stems (plus COM1..9 / LPT1..9) in *every*
    // directory; `CreateFile` on them fails no matter what the extension is, so
    // a template like "CON" produced a download that could never be written.
    // Checked on the stem only, and case-insensitively, which is how Windows
    // compares them.
    if is_reserved_windows_name(&base) {
        // Rename the head only: "CON.csv" becomes "CON-export.csv", not
        // "CON.csv-export" (which would then also double the extension).
        let head_end = base.find('.').unwrap_or(base.len());
        let (head, rest) = base.split_at(head_end);
        base = format!("{}-export{}", head, rest);
    }

    let suffix = format!(".{}", extension);
    if base.to_lowercase().ends_with(&suffix) {
        base
    } else {
        format!("{}{}", base, suffix)
    }
}

/// Windows device names that cannot be used as a file stem (R-35).
fn is_reserved_windows_name(stem: &str) -> bool {
    // "CON.txt" is reserved too, so compare the part before the first dot.
    let head = stem.split('.').next().unwrap_or("").trim_end();
    let upper = head.to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$") {
        return true;
    }
    let bytes = upper.as_bytes();
    if bytes.len() == 4 {
        let prefix = &upper[..3];
        let digit = bytes[3];
        if (prefix == "COM" || prefix == "LPT") && digit.is_ascii_digit() {
            return true;
        }
    }
    false
}

/// Remember where the user saved and which file was written, so the next export
/// dialog opens there and `reveal_export` can reopen the folder later.
///
/// Writes straight to the settings row instead of going through the command: no
/// side effect (split/maps/collector) depends on these fields, and it must not
/// broadcast a `settings:changed` storm on every export.
///
/// Returns the absolute path, which doubles as the `export:completed` payload.
fn remember_export(app: &tauri::AppHandle, path: &std::path::Path) -> String {
    let absolute = path.to_string_lossy().to_string();
    let state = app.state::<AppState>();

    // P2-11: this is a read-modify-write on the settings row, exactly like
    // `update_settings`; the shared write lock keeps one from overwriting the
    // other's fields.
    let _write = match state.settings_write.lock() {
        Ok(guard) => guard,
        Err(error) => {
            log_warn!("settings write lock unavailable after export: {}", error);
            return absolute;
        }
    };

    let updated = {
        // R-25: the file is already on disk, so this is a degraded follow-up
        // rather than a failed export — but it must leave a trace instead of
        // quietly forgetting where the export went.
        let mut settings = match state.settings.lock() {
            Ok(settings) => settings,
            Err(error) => {
                log_warn!("settings unavailable after export: {}", error);
                state.record_error(format!(
                    "Could not remember the export location: settings lock poisoned ({})",
                    error
                ));
                return absolute;
            }
        };
        settings.last_export_dir = path
            .parent()
            .map(|parent| parent.to_string_lossy().to_string())
            .unwrap_or_default();
        settings.last_export_path = absolute.clone();
        settings.clone()
    };

    // `settings` is released before the db lock (lock order, see AppState).
    let conn = match state.db.lock() {
        Ok(conn) => conn,
        Err(error) => {
            log_warn!("failed to lock the database: {}", error);
            return absolute;
        }
    };
    if let Err(error) = crate::db::save_settings(&conn, &updated) {
        log_warn!("failed to remember the export path: {}", error);
    }
    absolute
}

/// Pick a name that is not taken in `dir`, and take it (R-27).
///
/// A silent export must never overwrite: without a dialog the user gets no
/// chance to say "yes, replace it", so a taken name gets a `-1`, `-2`, …
/// suffix instead. The counter stops at 99 rather than looping forever — a
/// folder with a hundred copies of the same export is a user problem, not a
/// numbering problem.
///
/// "Taking" is `create_new`, not an `exists()` probe: between "this name was
/// free" and "the rename lands here" another concurrent export could pick the
/// same `-1` file, and the later rename would truncate the earlier one. The
/// empty claimed file is replaced when the finished content is renamed over
/// it; if the export fails before that, the caller's cleanup removes it.
fn unique_export_path(
    dir: &std::path::Path,
    file_name: &str,
) -> Result<std::path::PathBuf, String> {
    let claim = |candidate: &std::path::Path| -> Result<bool, std::io::Error> {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(candidate)
        {
            Ok(_file) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(error),
        }
    };

    let direct = dir.join(file_name);
    match claim(&direct) {
        Ok(true) => return Ok(direct),
        Ok(false) => {}
        Err(error) => return Err(format!("Cannot create {}: {}", direct.display(), error)),
    }

    let stem = std::path::Path::new(file_name)
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.to_string());
    let extension = std::path::Path::new(file_name)
        .extension()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();

    for index in 1..=99u32 {
        let candidate = if extension.is_empty() {
            dir.join(format!("{}-{}", stem, index))
        } else {
            dir.join(format!("{}-{}.{}", stem, index, extension))
        };
        match claim(&candidate) {
            Ok(true) => return Ok(candidate),
            Ok(false) => continue,
            Err(error) => return Err(format!("Cannot create {}: {}", candidate.display(), error)),
        }
    }

    Err(format!(
        "Too many files named \"{}\" in {} — rename or move some of them first",
        stem,
        dir.display()
    ))
}

/// Decide where an export goes, showing the save dialog only when needed.
///
/// Precedence: `save_as` ("save as…" in the toolbar) always asks; then
/// `export_save_mode == "auto"` with a usable `export_dir` writes straight into
/// that folder; everything else opens the dialog.
///
/// When the pinned folder is gone (unplugged drive, deleted folder) the export
/// falls back to the dialog and emits `export:dirUnavailable`, so the panel can
/// explain why a window the user thought they had turned off just appeared.
///
/// `Ok(None)` means the user dismissed the dialog.
///
/// The `bool` in `Ok(Some(..))` is `may_overwrite` (R-27): `true` when the
/// path came from the dialog (the user saw the existing file and confirmed
/// the replace), `false` for a silent auto export, where the name has been
/// claimed with `create_new` and must never replace anything.
/// Resolve where an export goes: the pinned folder in silent mode, or the save
/// dialog. `async` because the dialog blocks — it runs on the dedicated
/// blocking pool (R-17), so the async runtime stays free for the panel's
/// queries while the dialog is open.
async fn resolve_export_path(
    app: &tauri::AppHandle,
    settings: &Settings,
    file_name: &str,
    extension: &str,
    filter_label: &str,
    save_as: bool,
) -> Result<Option<(std::path::PathBuf, bool)>, String> {
    use tauri_plugin_dialog::DialogExt;

    let suggested = safe_file_name(file_name, extension);
    let configured = std::path::PathBuf::from(settings.export_dir.trim());
    // `normalized()` already drops "auto" when no folder is set; the emptiness
    // check is repeated so a hand-edited settings row cannot reach a silent
    // write into the process CWD.
    let silent_mode =
        !save_as && settings.export_save_mode == "auto" && !settings.export_dir.trim().is_empty();

    if silent_mode && configured.is_dir() {
        let path = unique_export_path(&configured, &suggested)?;
        log_info!(
        "export target (no dialog): {}",
        crate::logging::redact_path(&path.display().to_string())
    );
        return Ok(Some((path, false)));
    }

    if silent_mode {
        log_info!(
            "export folder is unusable, falling back to the dialog: {}",
            settings.export_dir
        );
        let _ = app.emit("export:dirUnavailable", settings.export_dir.clone());
    }

    // A valid pinned folder is where the user expects the dialog to open;
    // otherwise reopen wherever the last export went.
    let start_dir = if configured.is_dir() {
        configured
    } else {
        std::path::PathBuf::from(settings.last_export_dir.trim())
    };

    let dialog_app = app.clone();
    let suggested = suggested.clone();
    let filter_label = filter_label.to_string();
    let extension = extension.to_string();
    // The blocking save dialog moves to the dedicated blocking pool: the async
    // runtime must not spend a worker on a window that waits on the user.
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = dialog_app
            .dialog()
            .file()
            .add_filter(&filter_label, &[extension.as_str()])
            .set_file_name(&suggested);

        if start_dir.is_dir() {
            dialog = dialog.set_directory(start_dir);
        }
        dialog.blocking_save_file()
    })
    .await
    .map_err(|error| format!("the save dialog failed: {}", error))?;

    let Some(path) = picked else {
        return Ok(None);
    };
    Ok(Some((
        path.as_path().ok_or("Cannot resolve file path")?.to_path_buf(),
        true,
    )))
}

/// Show the written file in the OS file manager when the user asked for it.
///
/// Only useful in "auto" mode, where no dialog confirmed where the file went.
/// Failures are logged instead of returned: the export itself already succeeded.
fn reveal_after_export(settings: &Settings, path: &std::path::Path) {
    if !settings.open_export_folder {
        return;
    }
    if let Err(error) = tauri_plugin_opener::reveal_item_in_dir(path) {
        log_warn!(
        "failed to reveal {}: {}",
        crate::logging::redact_path(&path.display().to_string()),
        error
    );
    }
}

/// Payload of `export:completed`.
///
/// The panel builds the sentence (it owns the UI language) and needs the path so
/// the toast can offer "open folder", so no pre-rendered text is sent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCompleted {
    pub path: String,
    pub count: usize,
    /// "csv" | "xlsx"
    pub format: String,
    /// Rows the writer could not fully write (R-25). Only the Excel path can
    /// report a non-zero value: `write_string` rejects cells Excel cannot hold,
    /// and the old `let _ =` swallowed that, shipping a file with holes while
    /// the panel said "exported N records".
    pub failed_rows: usize,
}

/// Native folder picker behind the "export directory" setting.
///
/// Returns the chosen directory, or `None` when the dialog was dismissed. It
/// lives on the Rust side so the folder picker uses the same dialog plugin as
/// the export itself and needs no extra frontend permission.
#[tauri::command]
pub async fn pick_export_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    initial: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let start = initial
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            // R-25: a poisoned lock only costs the starting folder here, so the
            // dialog still opens — but the reason is logged instead of looking
            // like the user never picked a folder.
            match state.settings.lock() {
                Ok(settings) => Some(settings.last_export_dir.clone()),
                Err(error) => {
                    log_warn!(
                        "settings unavailable for the folder dialog: {}",
                        error
                    );
                    None
                }
            }
        })
        .unwrap_or_default();

    // R-17: the folder dialog blocks on the user, so it runs on the dedicated
    // blocking pool instead of parking an async-runtime worker for as long as
    // the window stays open.
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file();
        let start = std::path::PathBuf::from(start.trim());
        if start.is_dir() {
            dialog = dialog.set_directory(start);
        }
        dialog.blocking_pick_folder()
    })
    .await
    .map_err(|error| format!("the folder dialog failed: {}", error))?;

    Ok(picked.and_then(|path| {
        path.as_path()
            .map(|value| value.to_string_lossy().to_string())
    }))
}

/// Reveal the file from the last export in the OS file manager (with the file
/// selected where the platform supports it).
///
/// Deliberately takes no argument: the frontend is untrusted input, and a
/// command that opens an arbitrary path would also open arbitrary files.
#[tauri::command(async)]
pub fn reveal_export(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let path = state
        .settings
        .lock()
        .map_err(|e| e.to_string())?
        .last_export_path
        .clone();

    if path.is_empty() {
        return Err("Nothing has been exported yet".to_string());
    }
    if !std::path::Path::new(&path).is_file() {
        return Err("The exported file no longer exists".to_string());
    }

    log_debug!("reveal_export: {}", crate::logging::redact_path(&path));
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

/// `collected_at` (epoch ms) as a local `YYYY-MM-DD HH:mm` string (UI-03).
///
/// Empty for rows collected before the field shipped (`0`): data consumers get
/// a blank cell instead of a fake 1970 timestamp.
fn format_collected_at(ms: u64) -> String {
    use chrono::{Local, TimeZone};
    if ms == 0 {
        return String::new();
    }
    Local
        .timestamp_millis_opt(i64::try_from(ms).unwrap_or(i64::MAX))
        .single()
        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

/// One export column (M10 / G-11): the stable machine key, the default
/// header, the table column that controls its visibility, and whether the
/// value is one of the numbers we produce.
///
/// The order is the one true order (R-03). M8 / J-08e appended the thirteen
/// payload-confirmed columns, so the position of every earlier column is
/// unchanged — a user who mapped the file to a CRM keeps that mapping.
struct ExportColumn {
    /// Stable machine key. The JSON object key when no preset renames it, and
    /// what tests address instead of a brittle position.
    key: &'static str,
    /// The default header ("default" preset).
    header: &'static str,
    /// The table column whose visibility controls this export column. `None`
    /// = the table has no counterpart (identifiers, structured address parts,
    /// mining provenance), so the column always exports: the linkage is
    /// "hide what you see hidden", not "hide what has no toggle".
    table_key: Option<&'static str>,
    /// Written as a number in Excel and JSON — these values are produced by
    /// the app, never scraped text.
    numeric: bool,
}

const EXPORT_COLUMNS: [ExportColumn; 34] = [
    ExportColumn { key: "name", header: "Name", table_key: Some("name"), numeric: false },
    ExportColumn { key: "address", header: "Address", table_key: Some("address"), numeric: false },
    ExportColumn { key: "phone", header: "Phone", table_key: Some("phone"), numeric: false },
    ExportColumn { key: "rating", header: "Rating", table_key: Some("rating"), numeric: true },
    ExportColumn { key: "reviews_total", header: "Reviews", table_key: Some("reviews"), numeric: true },
    ExportColumn { key: "lat", header: "Latitude", table_key: None, numeric: true },
    ExportColumn { key: "lng", header: "Longitude", table_key: None, numeric: true },
    ExportColumn { key: "website", header: "Website", table_key: Some("website"), numeric: false },
    ExportColumn { key: "types", header: "Types", table_key: Some("types"), numeric: false },
    ExportColumn { key: "place_id", header: "place_id", table_key: None, numeric: false },
    ExportColumn { key: "collected_at", header: "Collected At", table_key: Some("collectedAt"), numeric: false },
    ExportColumn { key: "source_query", header: "Source Query", table_key: None, numeric: false },
    ExportColumn { key: "emails", header: "Emails", table_key: Some("emails"), numeric: false },
    ExportColumn { key: "socials", header: "Socials", table_key: Some("socials"), numeric: false },
    ExportColumn { key: "email_source_url", header: "Email Source", table_key: None, numeric: false },
    ExportColumn { key: "street", header: "Street", table_key: None, numeric: false },
    ExportColumn { key: "city", header: "City", table_key: Some("city"), numeric: false },
    ExportColumn { key: "state", header: "State", table_key: None, numeric: false },
    ExportColumn { key: "postal_code", header: "Postal Code", table_key: None, numeric: false },
    ExportColumn { key: "country", header: "Country", table_key: None, numeric: false },
    ExportColumn { key: "borough", header: "Borough", table_key: None, numeric: false },
    ExportColumn { key: "timezone", header: "Time Zone", table_key: None, numeric: false },
    ExportColumn { key: "data_id", header: "Data ID", table_key: None, numeric: false },
    ExportColumn { key: "reviews_link", header: "Reviews Link", table_key: None, numeric: false },
    ExportColumn { key: "thumbnail", header: "Thumbnail", table_key: None, numeric: false },
    ExportColumn { key: "owner_name", header: "Owner", table_key: Some("owner_name"), numeric: false },
    ExportColumn { key: "about", header: "About", table_key: None, numeric: false },
    ExportColumn { key: "open_hours", header: "Open Hours", table_key: Some("open_hours"), numeric: false },
    // Tier-2 detail enrichment: filled by the runner, not the search ingest —
    // appended, so the position of every earlier column is unchanged (R-03).
    ExportColumn { key: "plus_code", header: "Plus Code", table_key: None, numeric: false },
    ExportColumn { key: "description", header: "Description", table_key: None, numeric: false },
    ExportColumn { key: "reviews_per_rating", header: "Rating Distribution", table_key: None, numeric: false },
    ExportColumn { key: "photos", header: "Photos", table_key: None, numeric: false },
    // G-04: verification. Appended for the same R-03 reason as every other
    // addition — a CRM mapping must not shift under an existing column. Both
    // hang off the `email_verify` table column, so hiding the column drops the
    // pair together ("hide what you see hidden").
    ExportColumn { key: "email_verify", header: "Email Status", table_key: Some("email_verify"), numeric: false },
    ExportColumn { key: "email_verify_detail", header: "Email Verification", table_key: Some("email_verify"), numeric: false },
];

/// The columns an export keeps, given the panel's visible table keys.
///
/// `None` (the parameter was not sent — an older panel, or a caller that does
/// not care) exports every column. A column whose `table_key` is `None` always
/// survives; the rest survive exactly when their table column is visible.
fn resolve_export_columns(visible_keys: Option<&[String]>) -> Vec<&'static ExportColumn> {
    match visible_keys {
        None => EXPORT_COLUMNS.iter().collect(),
        Some(keys) => EXPORT_COLUMNS
            .iter()
            .filter(|column| match column.table_key {
                None => true,
                Some(table_key) => keys.iter().any(|k| k == table_key),
            })
            .collect(),
    }
}

/// The preset's name for one machine key, or `None` when the preset does not
/// rename it.
///
/// A preset only **renames** the columns the CRM's import wizard knows
/// (HubSpot company properties, Pipedrive organization fields); everything it
/// does not name keeps its default name, so choosing a preset never drops
/// data — worst case a column stays unmapped in the wizard, exactly as with
/// the default headers today.
fn preset_rename(preset: &str, key: &str) -> Option<&'static str> {
    if preset == "hubspot" {
        match key {
            // HubSpot companies: name/phone/address/city/state/country already
            // match; the two that differ are the website and the zip.
            "website" => Some("domain"),
            "postal_code" => Some("zip"),
            _ => None,
        }
    } else if preset == "pipedrive" {
        match key {
            // Pipedrive organizations: `name`/`address` already match; the
            // structured address parts map onto the address sub-fields.
            "street" => Some("addr_street"),
            "city" => Some("addr_locality"),
            "state" => Some("addr_state"),
            "postal_code" => Some("addr_zip"),
            "country" => Some("addr_country"),
            _ => None,
        }
    } else {
        None
    }
}

/// The header for one column under the settings' preset (`export_preset`).
fn column_header(column: &ExportColumn, preset: &str) -> &'static str {
    preset_rename(preset, column.key).unwrap_or(column.header)
}

/// The JSON object key for one column under the preset. The default preset
/// keeps the **machine key** (snake_case — what agents and scripts read); a
/// CRM preset renames to the CRM's property names.
fn column_json_key(column: &ExportColumn, preset: &str) -> &'static str {
    preset_rename(preset, column.key).unwrap_or(column.key)
}

/// The opening hours as one readable cell: "Saturday: 9 AM – 5 PM; Sunday: …".
///
/// A day with no periods is closed; the em dash says so without inventing a
/// word, and the day's name stays so the row still shows *which* day is shut.
fn format_open_hours(days: &[OpenHoursDay]) -> String {
    days.iter()
        .map(|day| {
            if day.periods.is_empty() {
                format!("{}: —", day.day)
            } else {
                format!("{}: {}", day.day, day.periods.join(", "))
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// The about block as one cell: "accessibility: Accessibility".
fn format_about(entries: &[AboutEntry]) -> String {
    entries
        .iter()
        .map(|entry| format!("{}: {}", entry.key, entry.label))
        .collect::<Vec<_>>()
        .join("; ")
}

/// One export column's value for a row, in export shape: the string form the
/// CSV and Excel writers use (the numeric columns stringify the same way they
/// always did).
fn export_value(b: &Business, key: &str) -> String {
    match key {
        "name" => b.name.clone(),
        "address" => b.address.clone(),
        "phone" => b.phone.clone(),
        "rating" => b.rating.to_string(),
        "reviews_total" => b.reviews_total.to_string(),
        "lat" => b.lat.to_string(),
        "lng" => b.lng.to_string(),
        "website" => b.website.clone(),
        "types" => b.types.join(", "),
        "place_id" => b.place_id.clone(),
        "collected_at" => format_collected_at(b.collected_at),
        "source_query" => b.source_query.clone(),
        "emails" => b.emails.join("; "),
        "socials" => b.socials.join("; "),
        "email_source_url" => b.email_source_url.clone(),
        // M8 / J-08e
        "street" => b.street.clone(),
        "city" => b.city.clone(),
        "state" => b.state.clone(),
        "postal_code" => b.postal_code.clone(),
        "country" => b.country.clone(),
        "borough" => b.borough.clone(),
        "timezone" => b.timezone.clone(),
        "data_id" => b.data_id.clone(),
        "reviews_link" => b.reviews_link.clone(),
        "thumbnail" => b.thumbnail.clone(),
        "owner_name" => b.owner_name.clone(),
        "about" => format_about(&b.about),
        "open_hours" => format_open_hours(&b.open_hours),
        // Tier-2 detail enrichment
        "plus_code" => b.plus_code.clone(),
        "description" => b.description.clone(),
        "reviews_per_rating" => b
            .reviews_per_rating
            .iter()
            .map(|count| count.to_string())
            .collect::<Vec<_>>()
            .join("/"),
        "photos" => b.photos.join("; "),
        _ => String::new(),
    }
}

/// One export column's value, with the two verification columns filled from
/// `cell`.
///
/// `export_value` stays a pure function of the row: the verification verdict
/// lives in a different table, keyed by address, and threading a database
/// handle through the pure value mapper would make every other column pay for
/// it. This wrapper is the only place that knows the two new keys exist.
fn export_value_with_verify(b: &Business, key: &str, cell: &crate::email_verify::VerifyCell) -> String {
    match key {
        "email_verify" => cell.summary.clone(),
        "email_verify_detail" => cell.detail.clone(),
        _ => export_value(b, key),
    }
}

/// Per-row verification cells for one export (G-04 §8.3).
///
/// Reads through a **second, read-only connection** (P2-12): the export must
/// never hold `state.db` while writing a 100k-row file, or the panel and the
/// collector queue behind it. The lookup is a primary-key equality over at most
/// five addresses per row — tens to hundreds of milliseconds for a whole file,
/// well under one Excel write.
struct VerifyLookup {
    conn: Option<rusqlite::Connection>,
    now: i64,
}

impl VerifyLookup {
    fn new(state: &AppState) -> Self {
        let conn = db::open_read_connection(std::path::Path::new(&state.db_path)).ok();
        if conn.is_none() {
            log_warn!("export: verification cache unavailable; the two email columns stay empty");
        }
        VerifyLookup {
            conn,
            now: now_ms() as i64,
        }
    }

    fn cell(&self, b: &Business) -> crate::email_verify::VerifyCell {
        let Some(conn) = self.conn.as_ref() else {
            return crate::email_verify::VerifyCell::default();
        };
        let addresses = crate::email_verify::normalize_all(&b.emails);
        if addresses.is_empty() {
            return crate::email_verify::VerifyCell::default();
        }
        match db::verification_records(conn, &addresses) {
            Ok(records) => {
                let map: std::collections::HashMap<String, db::AddressRecord> = records
                    .into_iter()
                    .map(|record| (record.address.clone(), record))
                    .collect();
                crate::email_verify::export_cell(&addresses, &map, self.now)
            }
            Err(error) => {
                log_warn!("export: reading a verification row failed: {}", error);
                crate::email_verify::VerifyCell::default()
            }
        }
    }
}

/// One export row as strings, in `EXPORT_COLUMNS` order (R-03). The full 34 —
/// visibility filtering happens on the resolved column list, not here.
/// Test-only today: the writers resolve columns individually, but the layout
/// assertion stays the cheapest whole-row check we have.
#[cfg(test)]
fn export_cells(b: &Business, cell: &crate::email_verify::VerifyCell) -> Vec<String> {
    EXPORT_COLUMNS
        .iter()
        .map(|column| export_value_with_verify(b, column.key, cell))
        .collect()
}

/// `collected_at` (epoch ms) as an RFC 3339 UTC string for the JSON exports.
///
/// The CSV keeps the local "YYYY-MM-DD HH:mm" display form; a JSON consumer
/// is an agent or a script, and RFC 3339 is what `Date.parse` and every
/// serde/timelib read without a locale in the room. Empty for legacy rows
/// (`0`), like the CSV cell.
fn collected_at_rfc3339(ms: u64) -> String {
    use chrono::{SecondsFormat, TimeZone};
    if ms == 0 {
        return String::new();
    }
    chrono::Utc
        .timestamp_millis_opt(i64::try_from(ms).unwrap_or(i64::MAX))
        .single()
        // `use_z = true`: the canonical "…Z" form every `Date.parse` reads.
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}

/// One export column as a JSON value (the JSON/JSONL exports keep types:
/// numbers stay numbers, lists stay lists, `about`/`open_hours` stay
/// structured — an agent reads the file without string surgery).
fn export_json_value(
    b: &Business,
    column: &ExportColumn,
    cell: &crate::email_verify::VerifyCell,
) -> serde_json::Value {
    match column.key {
        "rating" => serde_json::json!(b.rating),
        "reviews_total" => serde_json::json!(b.reviews_total),
        "lat" => serde_json::json!(b.lat),
        "lng" => serde_json::json!(b.lng),
        "types" => serde_json::json!(b.types),
        "emails" => serde_json::json!(b.emails),
        "socials" => serde_json::json!(b.socials),
        "about" => serde_json::json!(b.about),
        "open_hours" => serde_json::json!(b.open_hours),
        // Tier-2 detail enrichment
        "plus_code" => serde_json::json!(b.plus_code),
        "description" => serde_json::json!(b.description),
        "reviews_per_rating" => serde_json::json!(b.reviews_per_rating),
        "photos" => serde_json::json!(b.photos),
        "collected_at" => serde_json::json!(collected_at_rfc3339(b.collected_at)),
        other => serde_json::json!(export_value_with_verify(b, other, cell)),
    }
}

/// One business as a JSON object under the resolved columns and preset. Keys
/// are machine keys by default, CRM property names under a preset — so a file
/// written with a preset imports without remapping.
fn export_row_object(
    b: &Business,
    columns: &[&'static ExportColumn],
    preset: &str,
    cell: &crate::email_verify::VerifyCell,
) -> serde_json::Map<String, serde_json::Value> {
    let mut out = serde_json::Map::with_capacity(columns.len());
    for column in columns {
        out.insert(
            column_json_key(column, preset).to_string(),
            export_json_value(b, column, cell),
        );
    }
    out
}

/// Digits and phone punctuation only: the carve-out that lets `+1 415-555-0123`
/// survive a CSV export unescaped. No formula metacharacter is in this set, so
/// a match cannot be a payload.
fn looks_like_phone_number(rest: &str) -> bool {
    !rest.is_empty()
        && rest
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, ' ' | '-' | '(' | ')' | '.' | '/'))
}

/// Escape one CSV cell against formula injection (R-03).
///
/// Excel, LibreOffice and Google Sheets evaluate a cell that starts with `=`,
/// `+`, `-`, `@`, tab or CR as a formula — and every field here comes from
/// scraped third-party pages, so a business can literally set its own name to
/// `=cmd|' /C calc'!A0`. The fix is OWASP's single-quote prefix. One carve-out:
/// a `+`/`-` followed by phone-shaped text cannot be a payload, and E.164
/// numbers are far too common in this data to corrupt for no gain.
///
/// The Excel writer needs none of this: `write_string` produces a real string
/// cell, which Excel never re-evaluates.
fn csv_cell(value: &str) -> String {
    let Some(first) = value.chars().next() else {
        return value.to_string();
    };
    let needs_escape = match first {
        '=' | '@' | '\t' | '\r' => true,
        '+' | '-' => !looks_like_phone_number(&value[1..]),
        _ => false,
    };
    if needs_escape {
        format!("'{}", value)
    } else {
        value.to_string()
    }
}

/// Temp sibling for an atomic export write (R-04): the same directory so the
/// final `rename` stays on one volume (a cross-volume rename fails), pid plus
/// a per-process counter so two concurrent exports never share a temp file.
static EXPORT_TEMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn sibling_temp_path(target: &std::path::Path) -> std::path::PathBuf {
    use std::sync::atomic::Ordering;
    let seq = EXPORT_TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut name = target
        .file_name()
        .map(|value| value.to_os_string())
        .unwrap_or_default();
    name.push(format!(".{}.{}.tmp", std::process::id(), seq));
    target.with_file_name(name)
}

/// Export to CSV
#[tauri::command]
pub async fn export_csv(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    businesses: Vec<Business>,
    filter: Option<BusinessQueryRequest>,
    file_name: Option<String>,
    save_as: Option<bool>,
    visible_keys: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    let _export = claim_export(&state.export_in_flight)?;
    // P2-12: count now, stream after the dialog. The pre-count keeps the
    // "nothing to export" answer ahead of a save prompt; the scan itself runs
    // on its own read-only connection, so the shared connection stays free.
    let source = prepare_export_source(state.inner(), businesses, filter)?;
    if source.count()? == 0 {
        return Err("Nothing to export".to_string());
    }

    // Snapshot the settings: the dialog below blocks, and holding the lock
    // across it would stall every other settings command.
    //
    // R-25: no `unwrap_or(default)` here. Falling back silently would export
    // with settings the user never chose (BOM off, a different template) while
    // the panel reported a normal success.
    let (csv_bom, settings) = state
        .settings
        .lock()
        .map(|settings| (settings.csv_bom, settings.clone()))
        .map_err(|error| format!("settings_unavailable: {}", error))?;

    // M10: the columns the panel still shows (the hiddenColumns↔export
    // linkage) under the preset's names. Unsent `visible_keys` = every column.
    let columns = resolve_export_columns(visible_keys.as_deref());
    let headers: Vec<&'static str> = columns
        .iter()
        .map(|column| column_header(column, &settings.export_preset))
        .collect();

    let Some((file_path, may_overwrite)) = resolve_export_path(
        &app,
        &settings,
        file_name.as_deref().unwrap_or(""),
        "csv",
        "CSV Files",
        save_as.unwrap_or(false),
    )
    .await?
    else {
        return Ok(None);
    };

    // R-04: write to a temp sibling and rename, so a failure mid-write (disk
    // full, antivirus lock, drive gone) leaves no half-written file behind —
    // and never truncates the file the user just confirmed to replace. The
    // whole write runs on the blocking pool: a 100k-row file must not stall
    // the async runtime the panel's commands share.
    let temp_path = sibling_temp_path(&file_path);
    let write_file = file_path.clone();
    let verify = VerifyLookup::new(state.inner());
    let count = tauri::async_runtime::spawn_blocking(move || {
        let write_result: Result<usize, String> = (|| {
            // The BOM is what makes Excel read the file as UTF-8 instead of the ANSI code
            // page, which is the whole "Chinese turns into garbage" bug. It has to be
            // written before the csv writer takes ownership of the handle.
            let mut file = std::fs::File::create(&temp_path).map_err(|e| e.to_string())?;
            if csv_bom {
                use std::io::Write;
                file.write_all(&[0xEF, 0xBB, 0xBF])
                    .map_err(|e| e.to_string())?;
            }
            let mut wtr = csv::Writer::from_writer(file);
            wtr.write_record(&headers).map_err(|e| e.to_string())?;
            let count = source.for_each(|b| {
                let cell = verify.cell(b);
                let cells: Vec<String> = columns
                    .iter()
                    .map(|column| csv_cell(&export_value_with_verify(b, column.key, &cell)))
                    .collect();
                wtr.write_record(cells.iter().map(String::as_str))
                    .map_err(|e| e.to_string())
            })?;
            wtr.flush().map_err(|e| e.to_string())?;
            Ok(count)
        })();
        finish_export(&temp_path, &write_file, may_overwrite, write_result)
    })
    .await
    .map_err(|error| format!("the export task failed: {}", error))??;

    let Some(count) = count else {
        return Err("Nothing to export".to_string());
    };

    let exported = remember_export(&app, &file_path);
    reveal_after_export(&settings, &file_path);

    app.emit(
        "export:completed",
        ExportCompleted {
            path: exported.clone(),
            count,
            format: "csv".to_string(),
            // Every cell goes through `csv::Writer`, whose errors abort the
            // export instead of being skipped: nothing to report here.
            failed_rows: 0,
        },
    )
    .map_err(|e| e.to_string())?;
    Ok(Some(exported))
}

/// The reviews-export columns (M9). Deliberately independent of
/// `EXPORT_COLUMNS`: the business file's column order is a promise to users
/// who mapped it into a CRM, and the reviews file is a different document
/// with different consumers.
const REVIEWS_EXPORT_HEADERS: [&str; 12] = [
    "Business Name",
    "place_id",
    "Review ID",
    "Author",
    "Stars",
    "Posted",
    "Relative Time",
    "Text",
    "Owner Reply",
    "Helpful Votes",
    "Channel",
    "Fetched At",
];

/// Excel's hard limit for one sheet is 1,048,576 rows, header included. A
/// longer export used to fail cell by cell and still report the original row
/// count; reject it before asking for a path instead.
const EXCEL_MAX_DATA_ROWS: usize = 1_048_575;

/// One reviews-export row as strings, in `REVIEWS_EXPORT_HEADERS` order.
fn review_export_cells(row: &db::ReviewExportRow) -> Vec<String> {
    vec![
        row.business_name.clone(),
        row.place_id.clone(),
        row.review_id.clone(),
        row.author.clone(),
        row.stars.to_string(),
        row.posted.clone(),
        row.relative_time.clone(),
        row.text.clone(),
        row.owner_reply.clone(),
        row.helpful_votes.to_string(),
        row.channel.clone(),
        row.fetched_at.clone(),
    ]
}

/// The rows a reviews export should contain: one place when the drawer asked
/// for it, all stored reviews otherwise. An empty result is a normal outcome
/// (nothing fetched yet) and the caller reports it, not an error.
fn resolve_review_export_rows(
    state: &AppState,
    place_id: Option<&str>,
) -> Result<Vec<db::ReviewExportRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::reviews_for_export(&conn, place_id).map_err(|e| e.to_string())
}

/// Export a business's reviews (or all stored reviews) to CSV (M9). The write
/// path is the R-04 temp-then-rename dance the business export uses; the CSV
/// formula-injection escaping applies with full force — review text is
/// user-typed content.
#[tauri::command]
pub async fn export_reviews_csv(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    place_id: Option<String>,
    file_name: Option<String>,
    save_as: Option<bool>,
) -> Result<Option<String>, String> {
    let _export = claim_export(&state.export_in_flight)?;

    let rows = resolve_review_export_rows(state.inner(), place_id.as_deref())?;
    if rows.is_empty() {
        return Err("nothing_to_export".to_string());
    }

    // The user asked for a recognizable default: reviews + the local time
    // (`reviews_2026-10-26_1530.csv`); an explicitly passed name still wins.
    let file_name = match file_name.as_deref() {
        Some(name) if !name.trim().is_empty() => name.trim().to_string(),
        _ => format!("reviews_{}", chrono::Local::now().format("%Y-%m-%d_%H%M")),
    };

    let (csv_bom, settings) = state
        .settings
        .lock()
        .map(|settings| (settings.csv_bom, settings.clone()))
        .map_err(|error| format!("settings_unavailable: {}", error))?;

    let Some((file_path, may_overwrite)) = resolve_export_path(
        &app,
        &settings,
        &file_name,
        "csv",
        "CSV Files",
        save_as.unwrap_or(false),
    )
    .await?
    else {
        return Ok(None);
    };

    let temp_path = sibling_temp_path(&file_path);
    let write_result: Result<(), String> = (|| {
        let mut file = std::fs::File::create(&temp_path).map_err(|e| e.to_string())?;
        if csv_bom {
            use std::io::Write;
            file.write_all(&[0xEF, 0xBB, 0xBF])
                .map_err(|e| e.to_string())?;
        }
        let mut wtr = csv::Writer::from_writer(file);

        wtr.write_record(REVIEWS_EXPORT_HEADERS)
            .map_err(|e| e.to_string())?;

        for row in &rows {
            let cells: Vec<String> = review_export_cells(row)
                .into_iter()
                .map(|cell| csv_cell(&cell))
                .collect();
            wtr.write_record(cells.iter().map(String::as_str))
                .map_err(|e| e.to_string())?;
        }
        wtr.flush().map_err(|e| e.to_string())?;
        drop(wtr);
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temp_path);
        if !may_overwrite {
            let _ = std::fs::remove_file(&file_path);
        }
        return Err(error);
    }

    std::fs::rename(&temp_path, &file_path).map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        if !may_overwrite {
            let _ = std::fs::remove_file(&file_path);
        }
        e.to_string()
    })?;

    let exported = remember_export(&app, &file_path);
    reveal_after_export(&settings, &file_path);

    app.emit(
        "export:completed",
        ExportCompleted {
            path: exported.clone(),
            count: rows.len(),
            format: "csv".to_string(),
            failed_rows: 0,
        },
    )
    .map_err(|e| e.to_string())?;
    Ok(Some(exported))
}

/// Export reviews to Excel (M9). Same structure as `export_excel`, with the
/// reviews columns; stars and votes are written as numbers so they stay
/// right-aligned and summable.
#[tauri::command]
pub async fn export_reviews_excel(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    place_id: Option<String>,
    file_name: Option<String>,
    save_as: Option<bool>,
) -> Result<Option<String>, String> {
    use rust_xlsxwriter::*;

    let _export = claim_export(&state.export_in_flight)?;
    let rows = resolve_review_export_rows(state.inner(), place_id.as_deref())?;
    if rows.is_empty() {
        return Err("nothing_to_export".to_string());
    }
    if rows.len() > EXCEL_MAX_DATA_ROWS {
        return Err(format!("excel_row_limit:{}", rows.len()));
    }

    let file_name = match file_name.as_deref() {
        Some(name) if !name.trim().is_empty() => name.trim().to_string(),
        _ => format!("reviews_{}", chrono::Local::now().format("%Y-%m-%d_%H%M")),
    };

    let settings = state
        .settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|error| format!("settings_unavailable: {}", error))?;

    let Some((file_path, may_overwrite)) = resolve_export_path(
        &app,
        &settings,
        &file_name,
        "xlsx",
        "Excel Files",
        save_as.unwrap_or(false),
    )
    .await?
    else {
        return Ok(None);
    };

    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();

    let header_format = Format::new().set_bold().set_background_color(Color::RGB(0xEFF3FF));
    for (col, h) in REVIEWS_EXPORT_HEADERS.iter().enumerate() {
        worksheet
            .write_string_with_format(0, col as u16, *h, &header_format)
            .map_err(|e| e.to_string())?;
    }

    let mut failed_cells = 0usize;
    let mut failed_rows = 0usize;
    let mut first_error: Option<String> = None;

    for (index, row) in rows.iter().enumerate() {
        let r = (index + 1) as u32;
        let cells = review_export_cells(row);
        let mut row_failed = false;
        for (col, cell) in cells.iter().enumerate() {
            // Stars (4) and votes (9) are numbers we produced; everything
            // else is a string, which Excel never re-evaluates (R-03).
            let written = if matches!(col, 4 | 9) {
                match cell.parse::<f64>() {
                    Ok(number) => worksheet.write_number(r, col as u16, number).map(|_| ()),
                    Err(_) => worksheet.write_string(r, col as u16, cell).map(|_| ()),
                }
            } else {
                worksheet.write_string(r, col as u16, cell).map(|_| ())
            };
            if let Err(error) = written {
                failed_cells += 1;
                row_failed = true;
                if first_error.is_none() {
                    first_error = Some(format!("row {}, column {}: {}", r + 1, col + 1, error));
                }
            }
        }
        if row_failed {
            failed_rows += 1;
        }
    }

    let _ = worksheet.set_column_width(0, 32);
    let _ = worksheet.set_column_width(1, 34);
    let _ = worksheet.set_column_width(2, 36);
    let _ = worksheet.set_column_width(3, 20);
    let _ = worksheet.set_column_width(6, 14);
    let _ = worksheet.set_column_width(7, 60);
    let _ = worksheet.set_column_width(8, 46);
    let _ = worksheet.set_column_width(10, 12);
    let _ = worksheet.set_column_width(11, 17);
    worksheet.set_freeze_panes(1, 0).map_err(|e| e.to_string())?;

    // R-04: same temp-then-rename as the CSV writer.
    let temp_path = sibling_temp_path(&file_path);
    if let Err(error) = workbook.save(&temp_path).map_err(|e| e.to_string()) {
        let _ = std::fs::remove_file(&temp_path);
        if !may_overwrite {
            let _ = std::fs::remove_file(&file_path);
        }
        return Err(error);
    }
    std::fs::rename(&temp_path, &file_path).map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        if !may_overwrite {
            let _ = std::fs::remove_file(&file_path);
        }
        e.to_string()
    })?;

    if failed_cells > 0 {
        let note = format!(
            "Reviews Excel export wrote {} of {} row(s); {} cell(s) were rejected (first: {})",
            rows.len().saturating_sub(failed_rows),
            rows.len(),
            failed_cells,
            first_error.unwrap_or_else(|| "unknown error".to_string())
        );
        log_warn!("{}", note);
        app.state::<AppState>().record_error(note);
    }

    let exported = remember_export(&app, &file_path);
    reveal_after_export(&settings, &file_path);

    app.emit(
        "export:completed",
        ExportCompleted {
            path: exported.clone(),
            count: rows.len(),
            format: "xlsx".to_string(),
            failed_rows,
        },
    )
    .map_err(|e| e.to_string())?;
    Ok(Some(exported))
}

/// Export to Excel
#[tauri::command]
pub async fn export_excel(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    businesses: Vec<Business>,
    filter: Option<BusinessQueryRequest>,
    file_name: Option<String>,
    save_as: Option<bool>,
    visible_keys: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    use rust_xlsxwriter::*;

    let _export = claim_export(&state.export_in_flight)?;
    // P2-12: the pre-count applies the Excel row limit before a save dialog
    // opens, and the sheet is then filled from the stream — the table is never
    // materialized as a second in-memory copy of every row.
    let source = prepare_export_source(state.inner(), businesses, filter)?;
    let total = source.count()?;
    if total == 0 {
        return Err("Nothing to export".to_string());
    }
    if total > EXCEL_MAX_DATA_ROWS {
        return Err(format!("excel_row_limit:{}", total));
    }

    // R-25: same as the CSV path — a poisoned settings lock must abort the
    // export, not silently write the file with built-in defaults.
    let settings = state
        .settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|error| format!("settings_unavailable: {}", error))?;

    // M10: the same resolved columns and preset names the CSV path uses, so
    // the two formats can never disagree about what a column means.
    let columns = resolve_export_columns(visible_keys.as_deref());
    let headers: Vec<&'static str> = columns
        .iter()
        .map(|column| column_header(column, &settings.export_preset))
        .collect();

    let Some((file_path, may_overwrite)) = resolve_export_path(
        &app,
        &settings,
        file_name.as_deref().unwrap_or(""),
        "xlsx",
        "Excel Files",
        save_as.unwrap_or(false),
    )
    .await?
    else {
        return Ok(None);
    };

    // The workbook is built and saved on the blocking pool: filling a large
    // sheet is CPU-bound and must not occupy an async-runtime worker.
    let temp_path = sibling_temp_path(&file_path);
    let write_file = file_path.clone();
    let verify = VerifyLookup::new(state.inner());
    let (count, failed_cells, failed_rows, first_error) =
        tauri::async_runtime::spawn_blocking(move || {
            let mut workbook = Workbook::new();

            // R-25: `write_string` rejects what Excel cannot hold (a value past
            // the 32 767-character cell limit, a stray control character
            // scraped from a listing). Those errors used to be discarded, so
            // the export reported a clean file while silently missing cells.
            // Count them and report both the row count and the first error.
            let mut failed_cells = 0usize;
            let mut failed_rows = 0usize;
            let mut first_error: Option<String> = None;

            let write_result: Result<usize, String> = (|| {
                // The worksheet borrow ends with this block so the workbook can
                // be saved below; keeping it alive across `save` is a double
                // mutable borrow.
                let count = {
                    let worksheet = workbook.add_worksheet();

                    let header_format = Format::new()
                        .set_bold()
                        .set_background_color(Color::RGB(0xEFF3FF));
                    for (col, h) in headers.iter().enumerate() {
                        worksheet
                            .write_string_with_format(0, col as u16, *h, &header_format)
                            .map_err(|e| e.to_string())?;
                    }

                    let mut rows_written = 0usize;
                    let count = source.for_each(|b| {
                        // The pre-count and the scan are not one transaction: a
                        // collector batch can land in between. Stop at Excel's
                        // own limit instead of writing rows the format rejects.
                        if rows_written >= EXCEL_MAX_DATA_ROWS {
                            return Err(format!("excel_row_limit:{}", rows_written + 1));
                        }
                        let r = (rows_written + 1) as u32;
                        rows_written += 1;
                        let mut row_failed = false;
                        let verify_cell = verify.cell(b);
                        for (col, column) in columns.iter().enumerate() {
                            // The numeric columns are the four values the app
                            // produces, not scraped text — `write_number` keeps
                            // them right-aligned. Every other cell is a string —
                            // `write_string` writes a real string cell, which
                            // Excel never re-evaluates, so the CSV
                            // formula-injection escaping does not apply here
                            // (R-03).
                            let cell = export_value_with_verify(b, column.key, &verify_cell);
                            let written = if column.numeric {
                                match cell.parse::<f64>() {
                                    Ok(number) => {
                                        worksheet.write_number(r, col as u16, number).map(|_| ())
                                    }
                                    Err(_) => {
                                        worksheet.write_string(r, col as u16, &cell).map(|_| ())
                                    }
                                }
                            } else {
                                worksheet.write_string(r, col as u16, &cell).map(|_| ())
                            };
                            if let Err(error) = written {
                                failed_cells += 1;
                                row_failed = true;
                                if first_error.is_none() {
                                    first_error = Some(format!(
                                        "row {}, column {}: {}",
                                        r + 1,
                                        col + 1,
                                        error
                                    ));
                                }
                            }
                        }
                        if row_failed {
                            failed_rows += 1;
                        }
                        Ok(())
                    })?;

                    // Column widths travel with the column key, not the
                    // position: after the hiddenColumns linkage drops columns,
                    // the fixed indices would dress the wrong headers.
                    const COLUMN_WIDTHS: [(&str, f64); 12] = [
                        ("name", 32.0),
                        ("address", 46.0),
                        ("phone", 20.0),
                        ("website", 32.0),
                        ("place_id", 34.0),
                        ("collected_at", 17.0),
                        ("source_query", 24.0),
                        ("emails", 28.0),
                        ("socials", 28.0),
                        ("email_source_url", 30.0),
                        ("email_verify", 14.0),
                        ("email_verify_detail", 48.0),
                    ];
                    for (col, column) in columns.iter().enumerate() {
                        if let Some((_, width)) =
                            COLUMN_WIDTHS.iter().find(|(key, _)| *key == column.key)
                        {
                            let _ = worksheet.set_column_width(col as u16, *width);
                        }
                    }
                    worksheet.set_freeze_panes(1, 0).map_err(|e| e.to_string())?;
                    count
                };

                // R-04: same temp-then-rename as the CSV writer — a failed
                // `save` must not leave a corrupt workbook, and must not
                // destroy the file the user confirmed to replace.
                workbook.save(&temp_path).map_err(|e| e.to_string())?;
                Ok(count)
            })();

            let settled = finish_export(&temp_path, &write_file, may_overwrite, write_result);
            match settled {
                Ok(count) => Ok((count, failed_cells, failed_rows, first_error)),
                Err(error) => Err(error),
            }
        })
        .await
        .map_err(|error| format!("the export task failed: {}", error))??;

    let Some(count) = count else {
        return Err("Nothing to export".to_string());
    };

    // R-25: a workbook with holes must leave a trace where the user can find it
    // (diagnostics drawer) and in the event, not only in the terminal.
    if failed_cells > 0 {
        let note = format!(
            "Excel export wrote {} of {} row(s); {} cell(s) were rejected (first: {})",
            count.saturating_sub(failed_rows),
            count,
            failed_cells,
            first_error.unwrap_or_else(|| "unknown error".to_string())
        );
        log_warn!("{}", note);
        app.state::<AppState>().record_error(note);
    }

    let exported = remember_export(&app, &file_path);
    reveal_after_export(&settings, &file_path);

    app.emit(
        "export:completed",
        ExportCompleted {
            path: exported.clone(),
            count,
            format: "xlsx".to_string(),
            failed_rows,
        },
    )
    .map_err(|e| e.to_string())?;
    Ok(Some(exported))
}

/// R-04 / P2-12 tail shared by the streaming writers: move the temp file into
/// place, or clean up after a failed or empty scan.
///
/// A failure mid-write or mid-rename leaves no half-written file behind, and
/// never destroys the file the user confirmed to replace before the new content
/// was complete. `Ok(None)` means the scan produced zero rows (a clear or a
/// filter change landed between the pre-count and the scan): the temp file is
/// dropped and, for a silent export, so is the placeholder `unique_export_path`
/// claimed — but an existing file from the dialog stays untouched.
fn finish_export(
    temp_path: &std::path::Path,
    file_path: &std::path::Path,
    may_overwrite: bool,
    write_result: Result<usize, String>,
) -> Result<Option<usize>, String> {
    let count = match write_result {
        Ok(count) => count,
        Err(error) => {
            let _ = std::fs::remove_file(temp_path);
            if !may_overwrite {
                let _ = std::fs::remove_file(file_path);
            }
            return Err(error);
        }
    };
    if count == 0 {
        let _ = std::fs::remove_file(temp_path);
        if !may_overwrite {
            let _ = std::fs::remove_file(file_path);
        }
        return Ok(None);
    }
    std::fs::rename(temp_path, file_path).map_err(|error| {
        let _ = std::fs::remove_file(temp_path);
        if !may_overwrite {
            let _ = std::fs::remove_file(file_path);
        }
        error.to_string()
    })?;
    Ok(Some(count))
}

/// Export to JSON (M10 / G-11): an array of row objects, keys under the
/// preset's names, values typed. This is the exit agents and scripts consume;
/// CSV is for spreadsheets, JSON is for programs.
#[tauri::command]
pub async fn export_json(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    businesses: Vec<Business>,
    filter: Option<BusinessQueryRequest>,
    file_name: Option<String>,
    save_as: Option<bool>,
    visible_keys: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    let _export = claim_export(&state.export_in_flight)?;
    let source = prepare_export_source(state.inner(), businesses, filter)?;
    let expected = source.count()?;
    if expected == 0 {
        return Err("Nothing to export".to_string());
    }

    let settings = state
        .settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|error| format!("settings_unavailable: {}", error))?;
    let columns = resolve_export_columns(visible_keys.as_deref());

    let Some((file_path, may_overwrite)) = resolve_export_path(
        &app,
        &settings,
        file_name.as_deref().unwrap_or(""),
        "json",
        "JSON Files",
        save_as.unwrap_or(false),
    )
    .await?
    else {
        return Ok(None);
    };

    // R-04 / P2-12: same temp-then-rename as the CSV writer — and deliberately
    // no BOM: strict JSON parsers reject one. Rows are streamed straight into
    // the serializer on the blocking pool, so neither the whole table nor one
    // giant string is ever resident.
    let temp_path = sibling_temp_path(&file_path);
    let write_file = file_path.clone();
    let preset = settings.export_preset.clone();
    let verify = VerifyLookup::new(state.inner());
    let count = tauri::async_runtime::spawn_blocking(move || {
        let write_result: Result<usize, String> = (|| {
            use serde::ser::{SerializeSeq, Serializer};
            let file = std::fs::File::create(&temp_path).map_err(|e| e.to_string())?;
            let mut serializer = serde_json::Serializer::pretty(file);
            // The pre-count is a capacity hint only: a row added between the
            // count and the scan still serializes, and a row removed does not
            // leave a hole.
            let mut seq = serializer
                .serialize_seq(Some(expected))
                .map_err(|e| e.to_string())?;
            let count = source.for_each(|b| {
                let cell = verify.cell(b);
                let object = export_row_object(b, &columns, &preset, &cell);
                seq.serialize_element(&object).map_err(|e| e.to_string())
            })?;
            seq.end().map_err(|e| e.to_string())?;
            Ok(count)
        })();
        finish_export(&temp_path, &write_file, may_overwrite, write_result)
    })
    .await
    .map_err(|error| format!("the export task failed: {}", error))??;

    let Some(count) = count else {
        return Err("Nothing to export".to_string());
    };

    let exported = remember_export(&app, &file_path);
    reveal_after_export(&settings, &file_path);

    app.emit(
        "export:completed",
        ExportCompleted {
            path: exported.clone(),
            count,
            format: "json".to_string(),
            // serde_json errors abort the export, nothing is skipped.
            failed_rows: 0,
        },
    )
    .map_err(|e| e.to_string())?;
    Ok(Some(exported))
}

/// Export to JSON Lines (M10 / G-11): one compact row object per line — the
/// format `jq -c`, streaming parsers and most log pipelines want. Same
/// columns, preset names and typed values as `export_json`.
#[tauri::command]
pub async fn export_jsonl(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    businesses: Vec<Business>,
    filter: Option<BusinessQueryRequest>,
    file_name: Option<String>,
    save_as: Option<bool>,
    visible_keys: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    let _export = claim_export(&state.export_in_flight)?;
    let source = prepare_export_source(state.inner(), businesses, filter)?;
    if source.count()? == 0 {
        return Err("Nothing to export".to_string());
    }

    let settings = state
        .settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|error| format!("settings_unavailable: {}", error))?;
    let columns = resolve_export_columns(visible_keys.as_deref());

    let Some((file_path, may_overwrite)) = resolve_export_path(
        &app,
        &settings,
        file_name.as_deref().unwrap_or(""),
        "jsonl",
        "JSON Lines Files",
        save_as.unwrap_or(false),
    )
    .await?
    else {
        return Ok(None);
    };

    // P2-12: one row in, one line out — the stream never holds more than the
    // row being written, and the whole loop runs off the async runtime.
    let temp_path = sibling_temp_path(&file_path);
    let write_file = file_path.clone();
    let preset = settings.export_preset.clone();
    let verify = VerifyLookup::new(state.inner());
    let count = tauri::async_runtime::spawn_blocking(move || {
        let write_result: Result<usize, String> = (|| {
            use std::io::Write as _;
            let file = std::fs::File::create(&temp_path).map_err(|e| e.to_string())?;
            let mut writer = std::io::BufWriter::new(file);
            let count = source.for_each(|b| {
                let cell = verify.cell(b);
                let object = export_row_object(b, &columns, &preset, &cell);
                serde_json::to_writer(&mut writer, &object).map_err(|e| e.to_string())?;
                writer.write_all(b"\n").map_err(|e| e.to_string())
            })?;
            writer.flush().map_err(|e| e.to_string())?;
            Ok(count)
        })();
        finish_export(&temp_path, &write_file, may_overwrite, write_result)
    })
    .await
    .map_err(|error| format!("the export task failed: {}", error))??;

    let Some(count) = count else {
        return Err("Nothing to export".to_string());
    };

    let exported = remember_export(&app, &file_path);
    reveal_after_export(&settings, &file_path);

    app.emit(
        "export:completed",
        ExportCompleted {
            path: exported.clone(),
            count,
            format: "jsonl".to_string(),
            failed_rows: 0,
        },
    )
    .map_err(|e| e.to_string())?;
    Ok(Some(exported))
}

/// How long a clear stays reversible (UI-02b). The panel's toast offers the
/// button for exactly this long (`duration` in its `data:cleared` listener);
/// once it lapses the snapshot is dropped rather than kept — a later undo must
/// not resurrect rows the user has moved on from.
const UNDO_CLEAR_WINDOW: std::time::Duration = std::time::Duration::from_secs(6);

/// Clear all data (memory + SQLite + counters) and stop collecting.
///
/// UI-02b: every row is snapshotted first, so a mistaken clear is recoverable
/// through `undo_clear` within `UNDO_CLEAR_WINDOW`. The snapshot lives in
/// `*_backup` tables inside the database (R-13) — the Rust heap stays flat
/// regardless of table size, instead of holding three full-table copies.
#[tauri::command(async)]
pub fn clear_data(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // Clearing is also a stop: a task left running would keep navigating, the
    // next document would boot from the page mirror and refill the table the
    // user just emptied — and the job's own counts would silently disagree with
    // the rows. Pausing is the supported way to stop a task; the panel offers
    // "resume" on the card.
    //
    // P1-4: the switch goes off *before* the snapshot, and the epoch is bumped
    // in the same breath. That ordering matters: while the switch was still on
    // (and for the 3 s grace after it), a batch that had already been parsed was
    // admitted and written into the table that had just been emptied. The page
    // learns the new epoch from the same eval that stops it, so anything it
    // produced earlier is refused by `store_businesses` instead of landing here.
    let epoch = state
        .collection_epoch
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    log_info!("clear: collection epoch -> {}", epoch);
    // G-04: the verifier writes address verdicts that describe rows this clear
    // is about to delete, and a batch may already be queued on the `db` lock.
    // The epoch is what makes "cleared" mean "cleared" — the worker compares it
    // inside the lock, right before its transaction.
    let verify_epoch = state
        .verification_epoch
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    log_info!("clear: verification epoch -> {}", verify_epoch);
    if let Err(error) = apply_listening(&app, state.inner(), false) {
        log_warn!("clear_data: could not stop the collector switch: {}", error);
    }

    // C-05: the pause and the snapshot share one lock on purpose. Split across
    // two, a `start_job` that flipped a job to `running` between them survived
    // the clear and kept collecting into the emptied table.
    let (paused, queued, captured) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let paused = match db::running_job_id(&conn).map_err(|e| e.to_string())? {
            Some(id) => {
                db::set_job_status(&conn, &id, "paused").map_err(|e| e.to_string())?;
                // The runner may be mid-tile; put it back so resume redoes it.
                db::reset_running_tiles(&conn, &id).map_err(|e| e.to_string())?;
                Some(id)
            }
            None => None,
        };
        // P1-4: a queued job is a promise to keep collecting. The worker chains
        // to it as soon as the current one reaches a terminal state, which
        // re-arms the switch and refills the table — so the queue is paused with
        // the same lock that pauses the running job.
        let queued = db::pause_queued_jobs(&conn).map_err(|e| e.to_string())?;
        let captured = crate::db::snapshot_for_clear(&conn)
            .map_err(|e| format!("Failed to snapshot before clearing: {}", e))?;
        // D9: the address caches describe the rows that just went away, so they
        // go with them — a "clear" that leaves a searchable list of addresses
        // behind is a privacy bug, not a cache. Same lock region as the business
        // tables on purpose. A failure here is logged and ignored: the rows are
        // already gone, and failing the whole command now would be worse.
        if let Err(error) = crate::db::clear_verification_cache(&conn) {
            log_warn!("clear_data: could not drop the verification cache: {}", error);
        }
        (paused, queued, captured)
    };
    if queued > 0 {
        log_info!("clear: {} queued job(s) paused too", queued);
    }
    // A probe run belongs to the job that was just paused; keeping the flag
    // would pause that job again after its very first tile on resume.
    if let Ok(mut slot) = state.probe_limit.lock() {
        *slot = None;
    }

    // C-04: clearing also stops the work that writes without owning the runner.
    // The enrichment runner would keep navigating the maps pane for minutes
    // (one page load per place), and the miner would keep hitting websites only
    // to update rows that no longer exist — both then reporting finds the table
    // does not contain (C-03 covers the counting side).
    //
    // A reviews fetch needs no flag: it owns no rows of its own (the reviews
    // table is not part of the clear) and its sequence ends by itself.
    if let Ok(slot) = state.email_mining.lock() {
        if let Some(cancel) = slot.as_ref() {
            cancel.store(true, Ordering::Relaxed);
        }
    }
    // Same for the verifier: it writes only the two cache tables, but those are
    // being emptied in this very command.
    if let Ok(slot) = state.email_verifying.lock() {
        if let Some(cancel) = slot.as_ref() {
            cancel.store(true, Ordering::Relaxed);
        }
    }
    if let Ok(slot) = state.enrich_job.lock() {
        if let Some(cancel) = slot.as_ref() {
            cancel.store(true, Ordering::Relaxed);
        }
    }
    if let Ok(mut slot) = state.clear_backup.lock() {
        // An empty table leaves nothing to undo: keeping a snapshot would let a
        // later `undo_clear` report a success that restored zero rows.
        *slot = (captured > 0).then(|| crate::ClearBackup {
            row_count: captured,
            cleared_at: std::time::Instant::now(),
        });
    }
    state.reset_stats();
    // C-12: the "this session" filter and the header clock start over with the
    // table — the rows they described are gone.
    if let Ok(mut started) = state.session_started_at.lock() {
        *started = None;
    }

    // `clear` is not an idle cell: the scheduler must not treat it as one. The
    // switch was turned off through the single writer before the snapshot, so
    // the page flag, the localStorage mirror, `state.listening` and the panel
    // all agree — writing only the in-memory flag used to leave the mirror at
    // '1', and the next page load resumed collecting into the emptied table.
    if let Some(id) = paused {
        collector::emit_progress(&app, &id);
    }

    app.emit("data:cleared", ()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Put back the rows captured by the last `clear_data` (UI-02b).
///
/// Fails loudly once the window has lapsed instead of silently succeeding: a
/// no-op undo that reported success would tell the user their data is back
/// when the table is still empty.
#[tauri::command(async)]
pub fn undo_clear(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    // Read the permit without consuming it: a failed restore must leave the
    // in-memory undo window usable, otherwise the preserved backup tables are
    // unreachable and the user's only retry path is gone. The permit is
    // consumed only after the restore commits.
    let permit = {
        let mut slot = state.clear_backup.lock().map_err(|e| e.to_string())?;
        match slot.as_ref() {
            Some(backup) if backup.cleared_at.elapsed() <= UNDO_CLEAR_WINDOW => {
                Some(backup.clone())
            }
            _ => {
                // Expired or already consumed: drop it so a later call cannot
                // resurrect stale rows.
                *slot = None;
                None
            }
        }
    };
    let Some(permit) = permit else {
        return Err(format!(
            "Nothing to undo: the clear window ({} s) has passed",
            UNDO_CLEAR_WINDOW.as_secs()
        ));
    };

    let restored = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        crate::db::restore_clear_snapshot(&conn)
            .map_err(|e| format!("Failed to restore the cleared rows: {}", e))?
    };
    // Compare the timestamp before clearing: a new clear that landed while the
    // restore was running owns its own snapshot and must not be dropped here.
    if let Ok(mut slot) = state.clear_backup.lock() {
        if slot
            .as_ref()
            .map(|backup| backup.cleared_at == permit.cleared_at)
            .unwrap_or(false)
        {
            *slot = None;
        }
    }
    // The panel refresh rides the same event as a live batch, but the payload
    // is empty: the rows were never in Rust memory (R-13), and the listener
    // treats an empty batch as "refresh the page" (App.tsx scheduleRefresh).
    // Stats stay at zero on purpose — a restore is not new collection, and
    // re-counting would inflate the session figures.
    app.emit("businesses:updated", &Vec::<Business>::new())
        .map_err(|e| e.to_string())?;
    log_info!("undo_clear: restored {} rows", restored);
    Ok(restored)
}

/// Reload the Maps webview (UI-01a).
///
/// The controlled entry point for `location.reload()` the stale-collector
/// card offers: a consent page or captcha clears on a fresh load, and the
/// collector switch survives it because intercept.js mirrors the flag into
/// localStorage and resumes the auto-scroll after the reload.
#[tauri::command]
pub async fn reload_maps(app: tauri::AppHandle) -> Result<(), String> {
    let maps = app
        .get_webview("maps")
        .ok_or("Maps view is not ready yet")?;
    maps.eval("location.reload()")
        .map_err(|e| e.to_string())?;
    log_info!("reload_maps: Maps webview reloaded");
    Ok(())
}

/// Switch collection off (or, for the e2e fixtures, on).
///
/// Collection is task-driven now: `start_job` is what normally turns the switch
/// on, and enabling it here does not start the scroll loop — a page load does
/// that. The value of this command is `enabled: false`: turning the switch off
/// is also a pause, because a running task is fed by this switch and letting it
/// keep navigating would burn three cells (and possibly a captcha) before the
/// dry-streak watchdog noticed.
#[tauri::command(async)]
pub fn set_listening(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    // C-14: turning collection ON is the runner's job (`start_job` arms the
    // switch). This entry point exists for the e2e fixtures, which run debug
    // builds; in a release build a free-form enable would start the scroll loop
    // with no job behind it and fight whichever operation owns the pane.
    if enabled && !cfg!(debug_assertions) {
        return Err("listening is runner-owned in release builds".to_string());
    }
    apply_listening(&app, state.inner(), enabled)?;

    if !enabled {
        let paused = {
            let conn = state.db.lock().map_err(|e| e.to_string())?;
            let running = db::running_job_id(&conn).map_err(|e| e.to_string())?;
            if let Some(id) = running {
                db::set_job_status(&conn, &id, "paused").map_err(|e| e.to_string())?;
                // The runner may be mid-tile; put it back so resume redoes it.
                db::reset_running_tiles(&conn, &id).map_err(|e| e.to_string())?;
                Some(id)
            } else {
                None
            }
        };
        if let Some(id) = paused {
            collector::emit_progress(&app, &id);
        }
    }
    Ok(())
}

/// The only place the collector switch changes.
///
/// The switch exists in four places — `state.listening`, the page flag, the
/// localStorage mirror and the panel — and every task exit path used to
/// remember (or forget) them on its own: `cancel_job` and a finished queue left
/// the page collecting, `clear_data` wrote only two of the four. This function
/// is the single writer: the page is a follower, the bookkeeping and the panel
/// event always happen, and a missing webview can no longer leave the panel
/// claiming a session that does not exist.
pub(crate) fn apply_listening(
    app: &tauri::AppHandle,
    state: &AppState,
    enabled: bool,
) -> Result<(), String> {
    // Turning the switch off also forgets the tile context: a batch that
    // arrives after the session must not be attributed to the cell the job
    // stopped on. Starting the scroll is *not* done here — every page load
    // asserts the switch (`collector_settings_script`), so the runner's own
    // navigation is what starts collecting, without a stray round on whatever
    // search happened to be open.
    // P1-4: the epoch is asserted together with the switch. Turning the switch
    // off after a clear must also move the page to the new epoch, or a batch
    // produced in the next few milliseconds would still carry the old one.
    let epoch = state.collection_epoch.load(Ordering::Acquire);
    let js = format!(
        "window.__placemillEpoch = {}; {}",
        epoch,
        if enabled {
            "window.__placemillEnabled = true; try { localStorage.setItem('__placemillEnabled', '1'); } catch (e) {}"
        } else {
            "window.__placemillEnabled = false; try { localStorage.setItem('__placemillEnabled', '0'); } catch (e) {} try { window.__placemillAutoScroll.stop('settings'); } catch (e) {} try { window.__placemillSetTileContext(null); } catch (e) {}"
        }
    );

    // Best effort: `eval` fails only when the webview is gone (the window is
    // closing). The bookkeeping below is authoritative and must still land.
    match app.get_webview("maps") {
        Some(maps) => {
            if let Err(error) = maps.eval(&js) {
                log_warn!("apply_listening: eval failed: {}", error);
            }
        }
        None => log_warn!("apply_listening: maps webview is not ready"),
    }

    let previous = {
        // A poisoned lock must not cost the user their stop button.
        let mut slot = state
            .listening
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = *slot;
        *slot = enabled;
        previous
    };

    if previous != enabled {
        if enabled {
            // Only the first start of the app session sets the origin: the
            // panel uses it for the header clock and the "this session" filter,
            // and a queue that chains jobs must not move it forward.
            if let Ok(mut started) = state.session_started_at.lock() {
                if started.is_none() {
                    *started = Some(now_ms());
                }
            }
            if let Ok(mut off) = state.switch_off_at.lock() {
                *off = None;
            }
        } else if let Ok(mut off) = state.switch_off_at.lock() {
            // Stamped once per real transition, never refreshed by a repeated
            // stop: `store_businesses` treats this as a fixed grace window.
            *off = Some(std::time::Instant::now());
        }

        app.emit("listening:changed", enabled)
            .map_err(|e| e.to_string())?;
        log_info!("collector switch: enabled={}", enabled);
    }
    Ok(())
}

/// Worker-side form: the switch must never abort the runner, so a failure is
/// logged and ignored. The runner is the last owner of the switch (see
/// `collector::spawn_runner`), which is what makes every exit path safe.
pub(crate) fn switch_from_worker(app: &tauri::AppHandle, enabled: bool) {
    let state = app.state::<AppState>();
    if let Err(error) = apply_listening(app, state.inner(), enabled) {
        log_warn!(
            "worker: could not turn the collector switch {}: {}",
            if enabled { "on" } else { "off" },
            error
        );
    }
}

/// The panel's snapshot of the switch, fetched once after its listeners are
/// installed.
///
/// React used to learn `listening` only from `listening:changed`; a panel
/// reload (dev HMR, a rebuilt webview) therefore sat on a stale `false` until
/// the next task started. The session origin rides along so the header clock
/// and the "this session" filter survive the same reload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectorState {
    pub listening: bool,
    pub session_started_at: Option<u64>,
}

#[tauri::command(async)]
pub fn get_collector_state(state: tauri::State<'_, AppState>) -> CollectorState {
    CollectorState {
        listening: state.listening.lock().map(|value| *value).unwrap_or(false),
        session_started_at: state.session_started_at.lock().ok().and_then(|value| *value),
    }
}

// ---------------------------------------------------------------------------
// Area collection (grid jobs)
// ---------------------------------------------------------------------------

/// Seconds per tile used for the pre-flight estimate: page load + scroll until
/// idle + the 2.5 s pause. Measured on a 2 km cell; good enough to set
/// expectations, not a promise.
const SECONDS_PER_TILE: u32 = 20;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEntry {
    pub keyword: String,
    /// Display label ("Los Angeles"). The centre is explicit rather than
    /// geocoded: the app has no geocoder, and inventing one would silently send
    /// jobs to the wrong place.
    #[serde(default)]
    pub city: String,
    pub center_lat: f64,
    pub center_lng: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateJobsRequest {
    pub entries: Vec<JobEntry>,
    pub radius_km: f64,
    pub cell_km: f64,
    /// Result count that triggers a quadtree split (M4). `None` keeps the
    /// default; the UI exposes it because "how dense is too dense" depends on
    /// the vertical.
    #[serde(default)]
    pub split_threshold: Option<i64>,
}

/// A queue is meant for "10 keywords in one city", not for a script enqueueing
/// thousands of jobs; the cap also bounds the blocking work in `create_jobs`.
const MAX_JOBS_PER_REQUEST: usize = 30;

/// Google caps a viewport at roughly 120 places, so a threshold above that can
/// never trigger, and one far below it would subdivide every city block.
const DEFAULT_SPLIT_THRESHOLD: i64 = 100;
const MIN_SPLIT_THRESHOLD: i64 = 20;
const MAX_SPLIT_THRESHOLD: i64 = 120;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridPlanView {
    pub tiles: usize,
    pub zoom: u8,
    pub cell_km: f64,
    pub estimated_seconds: u32,
    /// True when the grid hits `MAX_TILES`: the caller must raise the cell size.
    pub limited: bool,
}

/// Dry run for the dialog: how many tiles, how long, which zoom.
#[tauri::command(async)]
pub fn plan_grid(
    center_lat: f64,
    center_lng: f64,
    radius_km: f64,
    cell_km: f64,
) -> Result<GridPlanView, String> {
    let plan = grid::generate(center_lat, center_lng, radius_km, cell_km)?;
    Ok(GridPlanView {
        tiles: plan.tiles.len(),
        zoom: plan.zoom,
        cell_km: plan.cell_km,
        estimated_seconds: plan.tiles.len() as u32 * SECONDS_PER_TILE,
        limited: plan.tiles.len() >= grid::MAX_TILES,
    })
}

static JOB_ID_SEQ: AtomicU64 = AtomicU64::new(0);

/// A job id that cannot collide with another submit in the same millisecond.
/// The old `job-{now_ms}-{index}` scheme made two `create_jobs`/`duplicate_job`
/// calls in the same millisecond hit the primary key and abort a half-inserted
/// batch (P2-14). The process id keeps two app instances apart; the sequence
/// keeps calls within one process apart.
fn next_job_id() -> String {
    format!(
        "job-{}-{}-{}",
        now_ms(),
        std::process::id(),
        JOB_ID_SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

/// Insert one job per keyword/centre pair, all `queued`.
///
/// The caller starts the first job; the worker then chains through the rest, so
/// "6 jobs overnight" needs exactly one click.
#[tauri::command(async)]
pub fn create_jobs(
    state: tauri::State<'_, AppState>,
    request: CreateJobsRequest,
) -> Result<Vec<db::JobRow>, String> {
    if request.entries.is_empty() {
        return Err("entries_required".to_string());
    }
    if request.entries.len() > MAX_JOBS_PER_REQUEST {
        return Err("too_many_jobs".to_string());
    }

    let split_threshold = request.split_threshold.unwrap_or(DEFAULT_SPLIT_THRESHOLD);
    if !(MIN_SPLIT_THRESHOLD..=MAX_SPLIT_THRESHOLD).contains(&split_threshold) {
        return Err("split_threshold_out_of_range".to_string());
    }

    // Snapshot the locale once: a settings change mid-queue would otherwise send
    // half the tiles in one map language.
    let locale_query = state
        .settings
        .lock()
        .map(|settings| settings.maps_locale_query())
        .map_err(|e| e.to_string())?;

    // Validate and build every grid before writing anything: an error on entry 5
    // must not leave four jobs behind as if the request had half succeeded.
    let stamp = now_ms();
    // Local time, unlike the legacy UTC `created_at`: the name is for humans.
    let name_stamp = chrono::Local::now().format("%m-%d %H:%M").to_string();
    // Only multi-keyword submits are collapsed into a batch; a single job with a
    // batch id would make the list render one extra group for no reason.
    let batch_id = if request.entries.len() > 1 {
        format!("batch-{}", stamp)
    } else {
        String::new()
    };
    let mut planned = Vec::new();
    for entry in &request.entries {
        let keyword = entry.keyword.trim().to_string();
        if keyword.is_empty() {
            return Err("keyword_required".to_string());
        }
        let plan = grid::generate(
            entry.center_lat,
            entry.center_lng,
            request.radius_km,
            request.cell_km,
        )?;
        let city = entry.city.trim();
        let name = if city.is_empty() {
            format!("{} · {}", keyword, name_stamp)
        } else {
            format!("{} · {} · {}", keyword, city, name_stamp)
        };
        planned.push((next_job_id(), keyword, name, plan));
    }

    // Build the whole batch before touching the database, then insert it in one
    // transaction. A failure on the N-th row now leaves no jobs behind instead
    // of a half-created queue.
    let mut batch: Vec<(db::NewJob<'_>, Vec<db::NewTile>)> = Vec::with_capacity(planned.len());
    for (index, (id, keyword, name, plan)) in planned.iter().enumerate() {
        let entry = &request.entries[index];
        let job = db::NewJob {
            id,
            name,
            batch_id: &batch_id,
            keyword,
            city: entry.city.trim(),
            center_lat: entry.center_lat,
            center_lng: entry.center_lng,
            radius_km: request.radius_km,
            cell_km: plan.cell_km,
            split_threshold,
            locale: &locale_query,
        };
        let tiles: Vec<db::NewTile> = plan
            .tiles
            .iter()
            .map(|tile| db::NewTile {
                id: format!("{}-{}", id, tile.id),
                seq: tile.seq,
                lat: tile.lat,
                lng: tile.lng,
                zoom: tile.zoom,
            })
            .collect();
        batch.push((job, tiles));
    }

    let mut created = Vec::new();
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::insert_jobs(&conn, &batch).map_err(|e| e.to_string())?;
        for (id, _, _, _) in &planned {
            if let Some(row) = db::load_job(&conn, id).map_err(|e| e.to_string())? {
                created.push(row);
            }
        }
    }

    for job in &created {
        log_info!(
            "job enqueued: {} {:?} ({} tiles, cell {} km, split at {} rows)",
            job.id, job.keyword, job.total_tiles, job.cell_km, job.split_threshold
        );
    }
    Ok(created)
}

/// Claim the single runner slot, tolerating the moment between "last tile
/// finished" and "worker released the slot".
///
/// Retrying only while no job is actually running keeps a genuine conflict
/// fast: two jobs cannot both own the maps webview, but starting a job right
/// after the previous one finished must not fail with `job_running`.
fn claim_runner_with_grace(state: &AppState, id: &str) -> bool {
    if collector::claim_runner(state, id) {
        return true;
    }
    for _ in 0..20 {
        let running = state
            .db
            .lock()
            .map(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM search_jobs WHERE status = 'running'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(1)
            })
            .unwrap_or(1);
        if running > 0 {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
        if collector::claim_runner(state, id) {
            return true;
        }
    }
    false
}

/// Start a queued job or resume a paused one.
///
/// Single-flight: the maps webview can only scroll one search at a time, so the
/// runner slot is claimed before the row flips to `running`. Claiming first
/// means two concurrent clicks cannot both pass the check.
///
/// `(async)` runs the command on a worker thread: `claim_runner_with_grace` may
/// sleep for up to two seconds, and a synchronous command would freeze the
/// panel for that long.
#[tauri::command(async)]
pub fn start_job(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    // Probe run (§5.8 A1): pause right after the FIRST tile, so the user can
    // judge the keyword for ~20 s before committing to the full grid. Resume
    // then continues tile 2 — the probe data IS the job's data, nothing is
    // re-collected.
    probe: Option<bool>,
) -> Result<db::JobRow, String> {
    // The enrichment runner owns the maps pane for its whole batch, and a
    // reviews fetch is mid-sequence: a job started under either would navigate
    // the pane out from under it. (This command becomes the job owner, so it
    // does not check the job/session slots itself.) P2-1: the claim is what
    // makes the check atomic with the next command's claim.
    claim_pane(
        state.inner(),
        PaneCheck::BECOMING_JOB,
        crate::PaneOwner::Job(id.clone()),
    )?;
    if !claim_runner_with_grace(state.inner(), &id) {
        release_pane(state.inner(), &crate::PaneOwner::Job(id.clone()));
        return Err("job_running".to_string());
    }
    // Arm the probe BEFORE the runner can look at it. A plain start (and a
    // resume, which passes no flag) clears any stale slot: the flag belongs to
    // the job currently running its first tile, nothing else.
    if let Ok(mut slot) = state.probe_limit.lock() {
        *slot = if probe.unwrap_or(false) {
            Some(id.clone())
        } else {
            None
        };
    }

    let prepared = (|| -> Result<String, String> {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let job = job_by_id(&conn, &id)?;
        if job.status != "queued" && job.status != "paused" {
            return Err(format!("job_not_startable:{}", job.status));
        }
        let running: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM search_jobs WHERE status = 'running'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if running > 0 {
            return Err("job_running".to_string());
        }
        // Restored if the maps webview turns out to be unavailable below.
        let previous = job.status.clone();
        db::set_job_status(&conn, &id, "running").map_err(|e| e.to_string())?;
        Ok(previous)
    })();

    let previous_status = match prepared {
        Ok(status) => status,
        Err(error) => {
            collector::release_runner(state.inner());
            return Err(error);
        }
    };

    // Navigate + scroll only produce data while the switch is on.
    if let Err(error) = apply_listening(&app, state.inner(), true) {
        // Without a maps webview there is no worker to run this job. Leaving it
        // `running` with the slot claimed would block the queue until restart.
        collector::release_runner(state.inner());
        if let Ok(conn) = state.db.lock() {
            let _ = db::set_job_status(&conn, &id, &previous_status);
        }
        return Err(error);
    }

    collector::emit_progress(&app, &id);
    collector::spawn_runner(app.clone(), id.clone());

    loaded_job(&app, &id)
}

/// Resume is `start_job` with a different name on purpose: the panel wording
/// differs ("resume" after a restart), the mechanics must not.
#[tauri::command(async)]
pub fn resume_job(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<db::JobRow, String> {
    // A resume NEVER probes: resuming after a probe pause is the "run the full
    // grid" answer, and resuming any other pause is a plain continuation.
    start_job(app, state, id, None)
}

/// Pause a running job, shared by the `pause_job` command and the close prompt.
///
/// The closing path has to leave exactly what pressing pause leaves behind
/// (job `paused`, the tile the runner was on back to `pending`, switch off);
/// anything else makes the next start resume on a half-scrolled tile.
pub(crate) fn pause_running_job(
    app: &tauri::AppHandle,
    state: &AppState,
    id: &str,
) -> Result<db::JobRow, String> {
    let paused = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let job = job_by_id(&conn, id)?;
        if job.status == "running" {
            db::set_job_status(&conn, id, "paused").map_err(|e| e.to_string())?;
            // The runner may be mid-tile; put it back so a resume redoes it.
            db::reset_running_tiles(&conn, id).map_err(|e| e.to_string())?;
            true
        } else {
            false
        }
    };

    if paused {
        // J-03e: pausing must stop the scroll and turn the switch off, otherwise
        // a queued job would start with the previous search still running.
        apply_listening(app, state, false)?;
        collector::emit_progress(app, id);
    }

    loaded_job(app, id)
}

#[tauri::command(async)]
pub fn pause_job(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<db::JobRow, String> {
    pause_running_job(&app, state.inner(), &id)
}

/// Leave the app after the user pressed the window's X while work was running.
///
/// `mode == "pause"` runs the normal pause path first, so the next start
/// resumes from the tile the runner was on. `mode == "force"` is the user
/// accepting the loss of the batch in flight; startup recovery still turns the
/// leftover `running` rows into `paused`/`pending`.
#[tauri::command(async)]
pub fn close_app(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    mode: String,
) -> Result<(), String> {
    if mode == "pause" {
        let running = {
            let conn = state.db.lock().map_err(|e| e.to_string())?;
            db::running_job_id(&conn).map_err(|e| e.to_string())?
        };
        if let Some(id) = running {
            // A failing pause must not trap the user in a window that refuses to
            // close: recovery at the next start covers the dirty state.
            if let Err(error) = pause_running_job(&app, state.inner(), &id) {
                log_warn!("close_app pause failed for {}: {}", id, error);
            }
        }
    }

    // Mining has nothing to persist; asking it to stop only avoids cutting one
    // site off mid-request.
    if let Ok(slot) = state.email_mining.lock() {
        if let Some(cancel) = slot.as_ref() {
            cancel.store(true, Ordering::Relaxed);
        }
    }

    // Set before `exit`: a second CloseRequested must fall through instead of
    // re-opening a prompt the user already answered.
    state.closing.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

#[tauri::command(async)]
pub fn cancel_job(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<db::JobRow, String> {
    let was_running = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let job = job_by_id(&conn, &id)?;
        let active = job.status == "running";
        if active || job.status == "paused" || job.status == "queued" {
            db::set_job_status(&conn, &id, "cancelled").map_err(|e| e.to_string())?;
            db::reset_running_tiles(&conn, &id).map_err(|e| e.to_string())?;
            // A cancelled execution is over; a paused one stays open so resuming
            // continues the same run (P2).
            db::close_run(&conn, &id, "cancelled").map_err(|e| e.to_string())?;
        }
        active
    };

    // Only the job that was actually driving the map may stop it: cancelling a
    // queued job must not interrupt whatever is scrolling right now.
    //
    // Cancelling ends the session, so the switch goes off here and now — the
    // panel must not keep claiming "collecting" while the runner notices on its
    // next poll (and a cancelled job no longer owns the switch, so nothing else
    // would ever turn it off).
    if was_running {
        if let Err(error) = apply_listening(&app, state.inner(), false) {
            log_warn!("cancel_job: could not stop the collector switch: {}", error);
        }
        collector::emit_progress(&app, &id);
    }

    loaded_job(&app, &id)
}

/// What the delete confirmation needs to say: how many places go with the job
/// and how many are kept because another job saw them too (T-10).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDeletePreview {
    pub exclusive: i64,
    pub shared: i64,
}

#[tauri::command(async)]
pub fn job_delete_preview(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<JobDeletePreview, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let (exclusive, shared) =
        db::job_delete_preview(&conn, &id).map_err(|e| e.to_string())?;
    Ok(JobDeletePreview { exclusive, shared })
}

/// `delete_exclusive` also drops the places no other job has seen (T-10).
#[tauri::command(async)]
pub fn delete_job(
    state: tauri::State<'_, AppState>,
    id: String,
    delete_exclusive: Option<bool>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let job = job_by_id(&conn, &id)?;
    if job.status == "running" {
        return Err("job_running".to_string());
    }
    let (_, rows) = db::delete_job(&conn, &id, delete_exclusive.unwrap_or(false))
        .map_err(|e| e.to_string())?;
    log_info!("job deleted: {} ({} businesses removed)", id, rows);
    Ok(())
}

#[tauri::command(async)]
pub fn list_jobs(app: tauri::AppHandle) -> Vec<db::JobRow> {
    collector::list_jobs(&app)
}

#[tauri::command(async)]
pub fn list_job_runs(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Vec<db::RunRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_runs(&conn, &id).map_err(|e| e.to_string())
}

/// Reset every leaf tile so the task can run again (P2). The collected rows are
/// kept: a re-run adds to the same list and only refreshes `last_seen_at`.
#[tauri::command(async)]
pub fn rerun_job(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<db::JobRow, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let job = job_by_id(&conn, &id)?;
    if job.status == "running" {
        return Err("job_running".to_string());
    }
    db::reset_job_for_rerun(&conn, &id).map_err(|e| e.to_string())?;
    db::refresh_job_counts(&conn, &id, Some("queued")).map_err(|e| e.to_string())?;
    job_by_id(&conn, &id)
}

/// Create a new queued task with the same parameters (P2). Tiles are regenerated
/// from the parameters rather than copied: a copied quadtree would carry the old
/// split decisions into an area that may have changed.
#[tauri::command(async)]
pub fn duplicate_job(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<db::JobRow, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let source = job_by_id(&conn, &id)?;
    let plan = grid::generate(
        source.center_lat,
        source.center_lng,
        source.radius_km,
        source.cell_km,
    )?;

    let new_id = next_job_id();
    let city = source.city.trim();
    let name = if city.is_empty() {
        format!("{} · {}", source.keyword, chrono::Local::now().format("%m-%d %H:%M"))
    } else {
        format!(
            "{} · {} · {}",
            source.keyword,
            city,
            chrono::Local::now().format("%m-%d %H:%M")
        )
    };
    let job = db::NewJob {
        id: &new_id,
        name: &name,
        batch_id: "",
        keyword: &source.keyword,
        city,
        center_lat: source.center_lat,
        center_lng: source.center_lng,
        radius_km: source.radius_km,
        cell_km: source.cell_km,
        split_threshold: source.split_threshold,
        locale: &source.locale,
    };
    let tiles: Vec<db::NewTile> = plan
        .tiles
        .iter()
        .map(|tile| db::NewTile {
            id: format!("{}-{}", new_id, tile.id),
            seq: tile.seq,
            lat: tile.lat,
            lng: tile.lng,
            zoom: tile.zoom,
        })
        .collect();
    db::insert_job(&conn, &job, &tiles).map_err(|e| e.to_string())?;
    job_by_id(&conn, &new_id)
}

/// Put one skipped tile back in the queue (P2). A finished task goes back to
/// `queued` so the panel offers "start" instead of silently doing nothing.
#[tauri::command(async)]
pub fn retry_tile(
    state: tauri::State<'_, AppState>,
    job_id: String,
    tile_id: String,
) -> Result<db::JobRow, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let job = job_by_id(&conn, &job_id)?;
    if job.status == "running" {
        return Err("job_running".to_string());
    }
    let changed = db::retry_tile(&conn, &job_id, &tile_id).map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("tile_not_retryable".to_string());
    }
    if matches!(job.status.as_str(), "completed" | "failed" | "cancelled") {
        db::set_job_status(&conn, &job_id, "queued").map_err(|e| e.to_string())?;
    }
    db::refresh_job_counts(&conn, &job_id, None).map_err(|e| e.to_string())?;
    job_by_id(&conn, &job_id)
}

/// Remember when this task was last exported (P2). The panel owns the clock, so
/// it passes `at`; the backend only stores it.
#[tauri::command(async)]
pub fn mark_job_exported(
    state: tauri::State<'_, AppState>,
    id: String,
    at: Option<i64>,
) -> Result<db::JobRow, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let now = now_ms().min(i64::MAX as u64) as i64;
    // R-35: `at` comes from the panel. A timestamp in the future (clock skew, a
    // hand-built call) would move the "only new" watermark past rows that have
    // not been collected yet, so only a plausible past value is accepted.
    let stamp = at
        .filter(|value| *value > 0 && *value <= now)
        .unwrap_or(now);
    db::mark_job_exported(&conn, &id, stamp).map_err(|e| e.to_string())?;
    job_by_id(&conn, &id)
}

/// Rename a job (T-03). The name is the only editable field: changing the
/// radius or grid after tiles exist would make the progress numbers lie.
#[tauri::command(async)]
pub fn rename_job(
    state: tauri::State<'_, AppState>,
    id: String,
    name: String,
) -> Result<db::JobRow, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("name_required".to_string());
    }
    if trimmed.chars().count() > 120 {
        return Err("name_too_long".to_string());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::rename_job(&conn, &id, trimmed).map_err(|e| e.to_string())?;
    job_by_id(&conn, &id)
}

#[tauri::command(async)]
pub fn get_job_tiles(app: tauri::AppHandle, id: String) -> Vec<db::TileRow> {
    collector::list_tiles(&app, &id)
}

/// Last view the Maps page reported. The panel needs it because a grid job must
/// start from what the user is actually looking at.
#[tauri::command]
pub async fn get_map_view(state: tauri::State<'_, AppState>) -> Result<Option<MapView>, String> {
    Ok(state
        .map_view
        .lock()
        .ok()
        .and_then(|view| view.as_ref().cloned()))
}

#[tauri::command]
pub async fn request_map_view(app: tauri::AppHandle) -> Result<(), String> {
    app.get_webview("maps")
        .ok_or("Maps view is not ready yet")?
        .eval("try { window.__placemillReportView && window.__placemillReportView(); } catch (e) {}")
        .map_err(|e| e.to_string())
}

/// M9: opens the reviews tab on the place page. The tab's label is
/// locale-dependent ("评价" / "Reviews"), so both are tried; the click is
/// what makes the page fetch the reviews-link payload into its state.
const CLICK_REVIEWS_JS: &str = "(function () { \
    const labels = ['评价', 'Reviews']; \
    const nodes = Array.from(document.querySelectorAll('button, [role=tab], li')); \
    for (const label of labels) { \
        const hit = nodes.find(function (n) { \
            const text = n.textContent ? n.textContent.trim() : ''; \
            return text === label; \
        }); \
        if (hit) { hit.click(); return 'clicked:' + label; } \
    } \
    return 'not-found'; \
})()";

/// M9: ask the maps page for a business's reviews.
///
/// The featured-review payload is **server-rendered into the place page**
/// (field-index-map.md §6.6): it only exists once the maps pane is actually
/// ON that place. So the flow is: navigate the pane to the place page (a full
/// reload — `navigate_maps`'s mechanism), wait for the load and the injected
/// script, then eval the fetch, whose state_cache channel reads the payload
/// with no network at all. A direct fetch of the reviews_link URL is
/// CORS-blocked, and the qv9Egd rpc currently answers an empty frame to
/// everyone — navigation is the only working path today.
///
/// `eval` cannot return the Promise, so the script's `.then` emits the
/// `business-reviews` event and lib.rs's listener stores the rows.
#[tauri::command(async)]
pub fn fetch_business_reviews(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    place_id: String,
) -> Result<String, String> {
    let (reviews_link, data_id) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::business_review_sources(&conn, &place_id).map_err(|e| e.to_string())?
    };

    // A running task, the enrichment runner, another reviews fetch or an active
    // collecting session owns the pane. This command navigates it and then
    // reads whatever document is loaded ~8 s later, so it must have the pane to
    // itself for the whole sequence: a page it did not load has another place's
    // reviews in its state (C-01). P2-1: the claim below is what keeps two
    // rapid clicks — or a click and a job start — from both passing.
    claim_pane(
        state.inner(),
        PaneCheck::BECOMING_REVIEWS,
        crate::PaneOwner::Reviews,
    )?;

    // Take the slot here, before the navigation. The pane claim above already
    // excludes a concurrent fetch; this flag is what the fetch thread releases.
    {
        let mut slot = match state.review_fetch.lock() {
            Ok(slot) => slot,
            Err(_) => {
                release_pane(state.inner(), &crate::PaneOwner::Reviews);
                return Err("reviews_unavailable".to_string());
            }
        };
        if *slot {
            drop(slot);
            release_pane(state.inner(), &crate::PaneOwner::Reviews);
            return Err("reviews_busy".to_string());
        }
        *slot = true;
    }
    // Released by the fetch thread when the sequence ends, or from this stack
    // frame if a step below fails before the thread starts.
    let guard = SlotGuard::new(&app, clear_review_slot);

    let locale_query = state
        .settings
        .lock()
        .map(|settings| settings.maps_locale_query())
        .map_err(|e| e.to_string())?;

    // The place page by id: `/maps/place/?q=place_id:<ChIJ>` — the same URL
    // shape the spike used, and the one whose payload carries the reviews.
    let place_url = format!(
        "https://www.google.com/maps/place/?q=place_id:{}&{}",
        encode_query(&place_id),
        locale_query
    );

    // JSON-encode the strings once here: the JS below interpolates them as
    // literals, and a quote inside a place id must not break the eval.
    let place_json = serde_json::to_string(&place_id).map_err(|e| e.to_string())?;
    let data_json = serde_json::to_string(&data_id).map_err(|e| e.to_string())?;
    let link_json = serde_json::to_string(&reviews_link).map_err(|e| e.to_string())?;

    // The sequence runs ~8 s after the navigation, so the document it lands on
    // is whatever owns the pane *then*. Check the place first: reading the
    // bootstrap state of another place — or of a search page — would store its
    // reviews under this place's id. A page that cannot report an id (the
    // parser returns nothing on a search page) is let through, because the
    // Rust side validates the rows it actually receives (C-02); an explicit
    // mismatch aborts without a payload the store path could mistake for data.
    let fetch_js = format!(
        "(function () {{ \
            var emit = function (payload) {{ \
                if (window.__TAURI__ && window.__TAURI__.event) {{ window.__TAURI__.event.emit('business-reviews', payload); }} \
                else if (window.__TAURI_INTERNALS__) {{ window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{ event: 'business-reviews', payload: payload }}); }} \
            }}; \
            var want = {place_json}; \
            var got = ''; \
            try {{ var s = window.__placemillParsePlaceState(); got = (s && s.placeId) || ''; }} catch (e) {{}} \
            if (got && got !== want) {{ \
                try {{ emit({{ channel: 'aborted', error: 'place-mismatch:' + got, placeId: want, dataId: {data_json} }}); }} catch (e) {{}} \
                return; \
            }} \
            window.__placemillFetchReviews(want, {link_json}, {{ dataId: {data_json} }}) \
                .then(function (r) {{ try {{ emit({{ channel: r.channel, reviews: r.reviews || [], error: r.error || null, linkNote: r.linkNote || null, placeId: want, dataId: {data_json} }}); }} catch (e) {{}} }}) \
                .catch(function (e) {{ try {{ emit({{ channel: 'error', reviews: [], error: String(e && e.message || e), placeId: want, dataId: {data_json} }}); }} catch (e2) {{}} }}); \
        }})()"
    );

    let webview = app
        .get_webview("maps")
        .ok_or("Maps view is not ready yet")?;
    webview
        .eval(&format!(
            "window.location.href = {};",
            serde_json::to_string(&place_url).unwrap_or_else(|_| "\"about:blank\"".to_string())
        ))
        .map_err(|e| e.to_string())?;

    // The navigation reloads the document, which kills this command's eval
    // context: the timed sequence (load → open the reviews tab → fetch → one
    // retry) runs on its own thread. Opening the tab is what makes the page
    // fetch the reviews-link payload into the bootstrap state (measured: on a
    // freshly loaded place page the state's list slots are still null). The
    // rows land through the event either way; a duplicate retry just replaces
    // the same rows (INSERT OR REPLACE).
    std::thread::spawn(move || {
        // The slot lives until the last eval and the retry are done: releasing
        // it before the sequence ends would let a job start mid-way and hand
        // the remaining evals a page they never navigated to.
        let _guard = guard;
        std::thread::sleep(std::time::Duration::from_millis(4_500));
        if let Some(webview) = app.get_webview("maps") {
            let _ = webview.eval(CLICK_REVIEWS_JS);
        }
        std::thread::sleep(std::time::Duration::from_millis(3_000));
        if let Some(webview) = app.get_webview("maps") {
            let _ = webview.eval(&fetch_js);
        }
        std::thread::sleep(std::time::Duration::from_millis(4_000));
        if let Some(webview) = app.get_webview("maps") {
            let _ = webview.eval(&fetch_js);
        }
    });

    Ok("requested".to_string())
}

/// M9: a business's stored reviews for the drawer.
#[tauri::command(async)]
pub fn get_business_reviews(
    state: tauri::State<'_, AppState>,
    place_id: String,
) -> Result<Vec<db::ReviewRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_reviews(&conn, &place_id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tier-2 detail enrichment (2026-10-26)
// ---------------------------------------------------------------------------

/// One `enrich:progress` frame.
#[derive(Clone, Serialize)]
pub struct EnrichProgress {
    pub done: usize,
    pub total: usize,
    pub ok: usize,
    pub failed: usize,
    /// The place the runner just finished with (for the toast).
    pub name: String,
    pub place_id: String,
}

/// The parsed payload must be the place we asked for: the ChIJ id is
/// authoritative when the payload carries one (a mismatch is a navigation
/// that landed somewhere else — a failed place, not a wrong write); the hex
/// `data_id` only decides when the payload has no ChIJ id at all.
fn payload_matches(
    place_id: &str,
    data_id: &str,
    payload_place_id: &str,
    payload_data_id: &str,
) -> bool {
    if !payload_place_id.is_empty() {
        return payload_place_id == place_id;
    }
    if !payload_data_id.is_empty() && !data_id.is_empty() {
        return payload_data_id == data_id;
    }
    false
}

/// Column shapes for the enriched detail: NUL-free, trimmed, capped. Same
/// insurance the ingress guard applies to the search path, scaled to what
/// these columns hold.
fn enrich_sanitize(
    plus_code: String,
    description: String,
    reviews_per_rating: Vec<u32>,
    photos: Vec<String>,
) -> (String, String, Vec<u32>, Vec<String>) {
    let cut = |text: String, max: usize| -> String {
        let trimmed = text.trim().replace('\u{0}', "");
        trimmed.chars().take(max).collect()
    };
    let photos: Vec<String> = photos
        .into_iter()
        .filter(|url| url.starts_with("https://") && !url.contains('\u{0}'))
        .map(|url| url.chars().take(2_000).collect::<String>())
        .take(12)
        .collect();
    (
        cut(plus_code, 64),
        cut(description, 2_000),
        reviews_per_rating.into_iter().take(5).collect(),
        photos,
    )
}

/// Enrichment is one place per ~35 s, all while owning the whole Maps pane.
/// A 500-row selection would hold it for hours; cap the batch and drop
/// duplicates before the slot is claimed (P2-13).
const MAX_ENRICH_TARGETS: usize = 200;

fn normalize_enrich_targets(place_ids: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    place_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .filter(|id| seen.insert(id.clone()))
        .take(MAX_ENRICH_TARGETS)
        .collect()
}

/// Tier-2: enrich the given places by visiting each place page and reading
/// the detail payload out of the bootstrap state (field-index-map §6.8).
///
/// One hard navigation per place — the same mechanism the collector's tile
/// loop uses, which is the only navigation that rebuilds the state (an SPA
/// click does not, measured). The runner owns the maps pane for the whole
/// batch: refused while a job runs, while a collection session is active, or
/// while another enrichment is running, and the reviews fetch refuses the
/// other way round. Progress flows through `enrich:progress` /
/// `enrich:completed`; the per-place answers ride `enrich:payload` into
/// `AppState::enrich_payload`, where the runner polls for its sequence.
#[tauri::command(async)]
pub fn enrich_businesses(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    place_ids: Vec<String>,
) -> Result<(), String> {
    let mut targets = normalize_enrich_targets(place_ids);
    if targets.is_empty() {
        return Err("Nothing to enrich".to_string());
    }

    // A running task, a reviews fetch or an active collecting session owns the
    // pane; the enrichment runner claims it right below (P2-1: claim, not just
    // check, so a concurrent job start cannot slip in between).
    claim_pane(
        state.inner(),
        PaneCheck::BECOMING_ENRICH,
        crate::PaneOwner::Enrich,
    )?;

    // Single-flight: take the slot or refuse.
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = match state.enrich_job.lock() {
            Ok(slot) => slot,
            Err(error) => {
                release_pane(state.inner(), &crate::PaneOwner::Enrich);
                return Err(format!("enrich_unavailable: {}", error));
            }
        };
        if slot.is_some() {
            // Only reachable if a runner was left behind without the pane claim;
            // giving the pane back keeps the refusal honest instead of leaving
            // the pane owned by a run that never started.
            drop(slot);
            release_pane(state.inner(), &crate::PaneOwner::Enrich);
            return Err("enrich_busy".to_string());
        }
        *slot = Some(cancel.clone());
    }
    // Owns the slot from here on. The two fallible reads below, the spawned
    // worker's normal exit and its panic all release it; the old code cleared
    // the slot only at the very end of the worker, so a database error between
    // the claim and the spawn left `enrich_busy` set until restart (C-06).
    let guard = SlotGuard::new(&app, clear_enrich_slot);

    // C-13: drop a payload left over from a cancelled run. Its sequence number
    // (also starting at 1) would be taken as this run's answer for whatever
    // place shares that number, fail the identity check, and cost that place
    // its full 35 s deadline before being counted as failed.
    if let Ok(mut slot) = state.enrich_payload.lock() {
        *slot = None;
    }

    // Fresh copies of the rows: the hex `data_id` is the second identity
    // check, and the locale pins the map language during the batch.
    let locale_query = state
        .settings
        .lock()
        .map(|settings| settings.maps_locale_query())
        .map_err(|e| e.to_string())?;
    let known = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::businesses_by_ids(&conn, &targets).map_err(|e| e.to_string())?
    };
    let known_by_id: std::collections::HashMap<String, String> = known
        .iter()
        .map(|row| (row.place_id.clone(), row.data_id.clone()))
        .collect();

    // P2-13: a deleted row or a stale selection id used to burn the full 35 s
    // deadline. Keep only ids that still exist.
    let requested = targets.len();
    targets.retain(|id| known_by_id.contains_key(id));
    if targets.len() < requested {
        log_info!(
            "enrich: {} of {} target(s) no longer exist and were skipped",
            requested - targets.len(),
            requested
        );
    }
    if targets.is_empty() {
        return Err("Nothing to enrich".to_string());
    }

    let total = targets.len();
    let _ = app.emit(
        "enrich:progress",
        EnrichProgress {
            done: 0,
            total,
            ok: 0,
            failed: 0,
            name: String::new(),
            place_id: String::new(),
        },
    );

    // The navigation reloads the maps document, so the per-place sequence
    // (navigate → poll → store) runs on its own thread, like the reviews
    // fetch. The panel keeps working; only the maps pane is occupied.
    std::thread::spawn(move || {
        // Holds the slot for the whole batch, and releases it on a panic too.
        let _guard = guard;
        let state = app.state::<AppState>();
        let mut ok = 0usize;
        let mut failed = 0usize;
        let mut cancelled = false;

        for (index, place_id) in targets.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break;
            }
            let seq = (index as u64) + 1;
            let data_id = known_by_id.get(place_id).cloned().unwrap_or_default();
            let place_url = format!(
                "https://www.google.com/maps/place/?q=place_id:{}&{}",
                encode_query(place_id),
                locale_query
            );

            if let Some(webview) = app.get_webview("maps") {
                let _ = webview.eval(&format!(
                    "window.location.href = {};",
                    serde_json::to_string(&place_url)
                        .unwrap_or_else(|_| "\"about:blank\"".to_string())
                ));
            }

            // Poll for this sequence's answer: the page emits
            // `enrich:payload` with the seq we stamped. The first answer can
            // only be trusted after the boot (~4.5 s), the deadline is
            // generous because a cold place page loads slower than a tile.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(35);
            std::thread::sleep(std::time::Duration::from_millis(4_500));
            let mut payload: Option<serde_json::Value> = None;
            while std::time::Instant::now() < deadline {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                if let Some(webview) = app.get_webview("maps") {
                    let _ = webview.eval(&format!(
                        "(function () {{ \
                            var emit = function (payload) {{ \
                                if (window.__TAURI__ && window.__TAURI__.event) {{ window.__TAURI__.event.emit('enrich:payload', payload); }} \
                                else if (window.__TAURI_INTERNALS__) {{ window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{ event: 'enrich:payload', payload: payload }}); }} \
                            }}; \
                            try {{ var r = window.__placemillParsePlaceState(); r.seq = {seq}; emit(r); }} \
                            catch (e) {{ var r = {{ ok: false, error: String(e && e.message || e), seq: {seq} }}; emit(r); }} \
                        }})()"
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(1_500));
                let answer = state
                    .enrich_payload
                    .lock()
                    .ok()
                    .and_then(|mut slot| slot.take())
                    .filter(|(answer_seq, _)| *answer_seq == seq)
                    .map(|(_, value)| value);
                if let Some(value) = answer {
                    payload = Some(value);
                    break;
                }
            }
            if cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break;
            }

            // Parse + verify + store. An empty, mismatched or errored payload
            // is a failed place — never a partial write.
            let mut place_name = String::new();
            let mut succeeded = false;
            if let Some(value) = payload {
                let field = |key: &str| {
                    value
                        .get(key)
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string()
                };
                let payload_ok = value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                let error = field("error");
                if payload_ok {
                    let payload_place_id = field("placeId");
                    let payload_data_id = field("dataId");
                    place_name = field("name");
                    if payload_matches(place_id, &data_id, &payload_place_id, &payload_data_id) {
                        let rating: Vec<u32> = value
                            .get("reviewsPerRating")
                            .and_then(|v| v.as_array())
                            .map(|list| {
                                list.iter()
                                    .filter_map(|v| v.as_u64().map(|n| n.min(u32::MAX as u64) as u32))
                                    .collect()
                            })
                            .unwrap_or_default();
                        let photos: Vec<String> = value
                            .get("photos")
                            .and_then(|v| v.as_array())
                            .map(|list| {
                                list.iter()
                                    .filter_map(|v| v.as_str().map(String::from))
                                    .collect()
                            })
                            .unwrap_or_default();
                        let (plus_code, description, rating, photos) = enrich_sanitize(
                            field("plusCode"),
                            field("description"),
                            rating,
                            photos,
                        );
                        // C-03: a write that matched no row (the business was
                        // cleared or deleted while this batch ran) is a failed
                        // place, not an ok one — the count must not claim a
                        // detail that is not in the table.
                        let stored = state
                            .db
                            .lock()
                            .ok()
                            .and_then(|conn| {
                                db::update_business_details(
                                    &conn,
                                    place_id,
                                    &plus_code,
                                    &description,
                                    &rating,
                                    &photos,
                                )
                                .ok()
                            })
                            .unwrap_or(0)
                            > 0;
                        succeeded = stored;
                        if !stored {
                            log_warn!("enrich write failed for {}", place_id);
                        }
                    } else {
                        log_debug!(
                            "enrich payload mismatch: asked {}, got {} / {}",
                            place_id,
                            payload_place_id,
                            payload_data_id
                        );
                    }
                } else if !error.is_empty() {
                    log_debug!("enrich payload error for {}: {}", place_id, error);
                }
            }

            if succeeded {
                ok += 1;
            } else {
                failed += 1;
            }
            let _ = app.emit(
                "enrich:progress",
                EnrichProgress {
                    done: index + 1,
                    total,
                    ok,
                    failed,
                    name: place_name,
                    place_id: place_id.clone(),
                },
            );

            // Pacing: a place page per ~8-10 s is the budget. The endpoint is
            // the page load itself — the same class of traffic a browsing user
            // produces — but a machine-gun loop invites exactly the kind of
            // attention the reviews work measured.
            std::thread::sleep(std::time::Duration::from_millis(2_500));
        }

        let _ = app.emit(
            "enrich:completed",
            serde_json::json!({ "ok": ok, "failed": failed, "cancelled": cancelled }),
        );
    });

    Ok(())
}

/// Tier-2: cancel the running enrichment. The runner checks the flag between
/// places and at every poll, so a stop lands within seconds.
#[tauri::command(async)]
pub fn enrich_stop(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Some(cancel) = state
        .enrich_job
        .lock()
        .map_err(|e| format!("enrich_unavailable: {}", e))?
        .as_ref()
    {
        cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Adjust the panel/map split (ratio = share of the window used by the React panel).
#[tauri::command(async)]
pub fn set_split_ratio(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ratio: f64,
) -> Result<f64, String> {
    let clamped = ratio.clamp(crate::MIN_SPLIT_RATIO, crate::MAX_SPLIT_RATIO);

    // Dragging calls this on every animation frame; only log visible changes so
    // the terminal stays readable while still showing whether the command ran.
    let previous = state
        .split_ratio
        .lock()
        .map(|value| *value)
        .unwrap_or(clamped);
    if (clamped - previous).abs() >= 0.01 {
        // The window size is part of the message on purpose: `apply_split` derives
        // every rectangle from it, so a wrong or missing size here explains a
        // handle that moves but never resizes anything.
        let size = app
            .get_window("main")
            .and_then(|window| window.inner_size().ok());
        log_info!(
            "set_split_ratio: {:.3} -> {:.3}, window={:?}",
            previous, clamped, size
        );
    }

    if let Err(error) = apply_split(&app, clamped) {
        log_warn!("set_split_ratio failed: {}", error);
        return Err(error);
    }

    if let Ok(mut current) = state.split_ratio.lock() {
        *current = clamped;
    }
    Ok(clamped)
}

/// Collapse or restore the Maps pane (UI-11).
///
/// Geometry only: the flag itself is persisted through `update_settings`, so
/// the panel stays the single writer and a reset restores an expanded layout.
/// Collapsing leaves the webview alive at 1px — collection continues, and the
/// pre-collapse ratio is untouched for the restore.
#[tauri::command(async)]
pub fn set_map_collapsed(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    collapsed: bool,
) -> Result<(), String> {
    if let Ok(mut slot) = state.map_collapsed.lock() {
        *slot = collapsed;
    }
    crate::apply_split_layout(&app)?;
    log_info!("set_map_collapsed: {}", collapsed);
    Ok(())
}

/// Shallow merge: the settings struct is flat, so a per-key merge is enough.
fn merge_patch(base: &mut serde_json::Value, patch: &serde_json::Value) {
    if let (Some(base_obj), Some(patch_obj)) = (base.as_object_mut(), patch.as_object()) {
        for (key, value) in patch_obj {
            base_obj.insert(key.clone(), value.clone());
        }
    }
}

/// Push the collector settings into the maps webview, optionally reloading it.
///
/// Both actions go out as **one** eval, settings first: when a language/region
/// change navigates, the document that loads must already find the new values in
/// `localStorage`, otherwise it runs one round with the previous delay.
fn push_to_maps(app: &tauri::AppHandle, settings: &Settings, reload: bool) {
    let Some(maps) = app.get_webview("maps") else {
        log_warn!("push_to_maps: maps webview is not ready, skipping");
        return;
    };

    let url = reload.then(|| settings.maps_home_url());
    let field_map = app
        .state::<AppState>()
        .remote_field_map
        .lock()
        .ok()
        .and_then(|guard| guard.clone());
    // A settings push must not touch the switch: the script re-asserts it, and
    // guessing would either stop a running task or start an idle page.
    let enabled = app
        .state::<AppState>()
        .listening
        .lock()
        .map(|value| *value)
        .unwrap_or(false);
    let epoch = app
        .state::<AppState>()
        .collection_epoch
        .load(Ordering::Acquire);
    // A live settings push (no reload) must not restart the scroll loop; when
    // it does navigate, the new document starts from its own page load.
    let script = crate::collector_settings_script(
        settings,
        field_map.as_ref(),
        url.as_deref(),
        enabled,
        false,
        epoch,
    );

    if let Some(url) = url.as_deref() {
        log_debug!("reloading maps: {}", url);
    }

    if let Err(error) = maps.eval(&script) {
        log_warn!("push_to_maps failed: {}", error);
        app.state::<AppState>()
            .record_error(format!("Failed to update the map view: {}", error));
    }
}

/// Persist, publish and apply one new settings value.
///
/// Order matters: the row is written to SQLite *before* memory is updated. If
/// the write fails the command returns `Err` and nothing changed anywhere —
/// returning `Err` while memory already held the new value would show the user
/// "save failed" while the app silently behaved as if it had succeeded.
fn commit_settings(
    app: &tauri::AppHandle,
    state: &AppState,
    current: &Settings,
    mut next: Settings,
    adopt_live_split: bool,
) -> Result<Settings, String> {
    // Turning "remember split" off forgets the stored ratio, but must not move
    // the panel the user is currently looking at. Turning it back on adopts the
    // width that is on screen right now instead of snapping back to the old one.
    let forgetting_split = current.remember_split && !next.remember_split;
    let remembering_split = !current.remember_split && next.remember_split;

    if forgetting_split {
        next.split_ratio = DEFAULT_SPLIT_RATIO;
    }
    if adopt_live_split && remembering_split {
        let live = state
            .split_ratio
            .lock()
            .map(|value| *value)
            .unwrap_or(next.split_ratio);
        next.split_ratio = live.clamp(crate::MIN_SPLIT_RATIO, crate::MAX_SPLIT_RATIO);
    }

    let ratio_changed = (next.split_ratio - current.split_ratio).abs() > 1e-9;

    // Google Maps reads `hl`/`gl` from the URL at load time, so a language or
    // region change navigates the pane (`push_to_maps`). Doing that under a
    // running tile yanks the page away mid-cell: the runner times the cell out,
    // and the destination's empty feed can close it as `no-results` — a cell
    // marked empty that is never collected again. Refuse instead of losing data.
    let maps_locale_changed =
        next.map_language != current.map_language || next.map_region != current.map_region;
    if maps_locale_changed {
        // The push below reloads the pane, so every pane owner must be clear —
        // not just a running job. A reviews fetch or an enrichment poll would
        // otherwise read a document that was replaced under it (C-08).
        check_pane(state, PaneCheck::ALL)?;
    }

    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        crate::db::save_settings(&conn, &next).map_err(|e| {
            state.record_error(format!("Failed to save settings: {}", e));
            e.to_string()
        })?;
    }

    {
        let mut guard = state.settings.lock().map_err(|e| e.to_string())?;
        *guard = next.clone();
    }

    // R-36b: the level applies to the next line, not the next launch.
    crate::logging::set_level(&next.log_level);

    if ratio_changed && !forgetting_split {
        if let Ok(mut ratio) = state.split_ratio.lock() {
            *ratio = next.split_ratio;
        }
        apply_split(app, next.split_ratio)?;
    }

    // Collector knobs are pushed into the running script; everything else
    // (theme, page size, UI language) stays in the panel and costs no eval.
    // `maps_locale_changed` was decided before the write (it can refuse).
    let collector_changed = next.collector_payload() != current.collector_payload();

    if collector_changed || maps_locale_changed {
        push_to_maps(app, &next, maps_locale_changed);
    }

    let _ = app.emit("settings:changed", &next);
    log_info!(
        "settings updated: language={}, theme={}, page_size={}, split={} (remember={})",
        next.language, next.theme, next.page_size, next.split_ratio, next.remember_split
    );
    Ok(next)
}

/// The persisted preferences owned by the Rust side.
#[tauri::command]
pub async fn get_settings(state: tauri::State<'_, AppState>) -> Result<Settings, String> {
    state
        .settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|e| e.to_string())
}

/// Merge a partial update, validate it, persist it and broadcast the result.
#[tauri::command(async)]
pub fn update_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    patch: serde_json::Value,
) -> Result<Settings, String> {
    validate_patch(&patch)?;

    // P2-11: serialize the whole snapshot→merge→save sequence. Without this a
    // `remember_export` finishing at the same time could write a stale settings
    // snapshot over this update (or the other way round).
    let _write = state
        .settings_write
        .lock()
        .map_err(|e| format!("settings_write_unavailable: {}", e))?;

    // Snapshot first and drop the lock: the DB write below must not happen while
    // the settings lock is held (see the lock-order note on `AppState`).
    let current = state
        .settings
        .lock()
        .map_err(|e| e.to_string())?
        .clone();

    let mut base = serde_json::to_value(&current).map_err(|e| e.to_string())?;
    merge_patch(&mut base, &patch);
    let (next, corrected) = serde_json::from_value::<Settings>(base)
        .map_err(|e| format!("invalid_setting_value: {}", e))?
        .normalize_with_report();

    // `adopt_live_split`: re-enabling "remember split" stores the width that is
    // currently on screen, so turning the switch on does not jump the panel.
    let saved = commit_settings(&app, state.inner(), &current, next, true)?;

    // R-25: a clamped or discarded value must not look like a successful save.
    // The settings themselves are still returned (the panel keeps rendering the
    // stored truth); this event is what lets it say which fields changed.
    if !corrected.is_empty() {
        log_info!("update_settings corrected: {:?}", corrected);
        let _ = app.emit("settings:corrected", &corrected);
    }
    Ok(saved)
}

/// Restore every preference to its built-in default.
///
/// Lives on the Rust side on purpose: the frontend must not carry a second copy
/// of the defaults (principle: Rust is the single source of truth).
#[tauri::command(async)]
pub fn reset_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Settings, String> {
    // Same write serialization as `update_settings`: a reset must not race an
    // export-completion write of `last_export_*`.
    let _write = state
        .settings_write
        .lock()
        .map_err(|e| format!("settings_write_unavailable: {}", e))?;
    let current = state
        .settings
        .lock()
        .map_err(|e| e.to_string())?
        .clone();

    // `adopt_live_split = false`: a reset must also put the panel back to the
    // default width, even if "remember split" happened to be off.
    commit_settings(
        &app,
        state.inner(),
        &current,
        Settings::default().normalized(),
        false,
    )
}

#[cfg(test)]
mod pane_conflict_tests {
    use super::*;

    /// C-01: every borrower must refuse while another owner holds the pane.
    #[test]
    fn every_owner_is_reported_to_a_borrower() {
        assert_eq!(
            pane_conflict(Some("job-1"), None, false, PaneCheck::ALL),
            Some("map_busy:job-1".to_string())
        );
        assert_eq!(
            pane_conflict(None, Some(&crate::PaneOwner::Job("job-1".into())), false, PaneCheck::ALL),
            Some("map_busy:job-1".to_string())
        );
        assert_eq!(
            pane_conflict(None, Some(&crate::PaneOwner::Enrich), false, PaneCheck::ALL),
            Some("enrich_busy".to_string())
        );
        assert_eq!(
            pane_conflict(None, Some(&crate::PaneOwner::Reviews), false, PaneCheck::ALL),
            Some("reviews_busy".to_string())
        );
        assert_eq!(
            pane_conflict(None, None, true, PaneCheck::ALL),
            Some("session_active".to_string())
        );
        assert_eq!(pane_conflict(None, None, false, PaneCheck::ALL), None);
    }

    /// A borrower that becomes an owner must not refuse itself, but still
    /// refuses the owners it cannot share the pane with.
    #[test]
    fn a_caller_never_refuses_itself() {
        assert_eq!(
            pane_conflict(Some("job-1"), None, true, PaneCheck::BECOMING_JOB),
            None
        );
        assert_eq!(
            pane_conflict(None, Some(&crate::PaneOwner::Enrich), false, PaneCheck::BECOMING_JOB),
            Some("enrich_busy".to_string())
        );
        assert_eq!(
            pane_conflict(None, Some(&crate::PaneOwner::Enrich), false, PaneCheck::BECOMING_ENRICH),
            None
        );
        assert_eq!(
            pane_conflict(None, Some(&crate::PaneOwner::Reviews), false, PaneCheck::BECOMING_REVIEWS),
            None
        );
    }

    /// The gap the whole check exists for: a reviews fetch used to be invisible
    /// to job start and enrichment.
    #[test]
    fn a_reviews_fetch_blocks_the_other_owners() {
        for check in [
            PaneCheck::ALL,
            PaneCheck::BECOMING_JOB,
            PaneCheck::BECOMING_ENRICH,
        ] {
            assert_eq!(
                pane_conflict(None, Some(&crate::PaneOwner::Reviews), false, check),
                Some("reviews_busy".to_string())
            );
        }
        assert_eq!(
            pane_conflict(
                None,
                Some(&crate::PaneOwner::Enrich),
                false,
                PaneCheck::BECOMING_JOB
            ),
            Some("enrich_busy".to_string()),
            "the first owner in the priority order wins"
        );
    }

    /// P2-1: checking and claiming must be one step. Reading three slots and
    /// then claiming one let a job start and a reviews fetch both proceed.
    #[test]
    fn a_pane_can_only_be_claimed_once() {
        let mut slot: Option<crate::PaneOwner> = None;
        claim_slot(&mut slot, None, false, crate::PaneOwner::Job("job-1".into()))
            .expect("the first claim wins");

        // Any later claimant is refused with the code of whoever holds it —
        // including the same job claiming again, which is how two rapid clicks
        // used to start the same work twice.
        assert_eq!(
            claim_slot(&mut slot, None, false, crate::PaneOwner::Reviews).unwrap_err(),
            "map_busy:job-1"
        );
        assert_eq!(
            claim_slot(&mut slot, None, false, crate::PaneOwner::Job("job-1".into())).unwrap_err(),
            "map_busy:job-1"
        );
        assert_eq!(
            slot,
            Some(crate::PaneOwner::Job("job-1".into())),
            "a refused claim must not overwrite the owner"
        );

        // Released, the pane is claimable again — and the release only drops the
        // owner it was given, so a stale runner cannot clear a newer claim.
        release_pane_slot(&mut slot, &crate::PaneOwner::Job("job-2".into()));
        assert!(slot.is_some(), "a different owner must not release it");
        release_pane_slot(&mut slot, &crate::PaneOwner::Job("job-1".into()));
        assert!(slot.is_none());
        claim_slot(&mut slot, None, false, crate::PaneOwner::Reviews).expect("re-claim");
    }

    /// A collecting session or a job row that is already running blocks a claim
    /// even when the owner slot is empty (the job row is written by recovery
    /// and by the runner before it exits).
    #[test]
    fn a_running_job_or_session_blocks_a_claim() {
        let mut slot = None;
        assert_eq!(
            claim_slot(
                &mut slot,
                Some("map_busy:job-9".into()),
                false,
                crate::PaneOwner::Enrich
            )
            .unwrap_err(),
            "map_busy:job-9"
        );
        assert_eq!(
            claim_slot(&mut slot, None, true, crate::PaneOwner::Enrich).unwrap_err(),
            "session_active"
        );
        assert!(slot.is_none(), "a refused claim leaves the pane free");
    }

    /// P2-14: ids minted in the same millisecond (or the same `create_jobs`
    /// request) must not collide.
    #[test]
    fn job_ids_are_unique_within_one_millisecond() {
        let mut ids = std::collections::HashSet::new();
        for _ in 0..1_000 {
            assert!(ids.insert(next_job_id()), "duplicate job id");
        }
    }

    /// P2-12: two exports must not write the same file; the guard releases on
    /// every return path (including a cancelled dialog).
    #[test]
    fn exports_are_single_flight_and_release_on_drop() {
        let flag = AtomicBool::new(false);
        let first = claim_export(&flag).expect("first export");
        assert_eq!(
            claim_export(&flag).err(),
            Some("export_busy".to_string())
        );
        drop(first);
        assert!(claim_export(&flag).is_ok(), "the slot must be reusable");
    }

    /// P2-13: enrichment targets are trimmed, deduplicated and capped before
    /// the pane slot is claimed.
    #[test]
    fn enrich_targets_are_trimmed_deduped_and_capped() {
        let mut input = vec![
            " a ".to_string(),
            "a".to_string(),
            String::new(),
            "b".to_string(),
        ];
        input.extend((0..MAX_ENRICH_TARGETS + 5).map(|index| format!("extra{index}")));
        let out = normalize_enrich_targets(input);
        assert_eq!(out.len(), MAX_ENRICH_TARGETS);
        assert_eq!(out[0], "a");
        assert_eq!(out[1], "b");
        let unique: std::collections::HashSet<&String> = out.iter().collect();
        assert_eq!(unique.len(), out.len());
    }
}

#[cfg(test)]
mod safe_file_name_tests {
    use super::safe_file_name;

    #[test]
    fn keeps_a_plain_template_and_appends_the_extension() {
        assert_eq!(
            safe_file_name("placemill-20261020-12", "csv"),
            "placemill-20261020-12.csv"
        );
    }

    #[test]
    fn does_not_double_the_extension() {
        assert_eq!(safe_file_name("report.CSV", "csv"), "report.CSV");
        assert_eq!(safe_file_name("report.csv", "csv"), "report.csv");
    }

    #[test]
    fn strips_directories_so_the_template_cannot_escape_the_folder() {
        assert_eq!(safe_file_name("../../etc/passwd", "csv"), "passwd.csv");
        assert_eq!(safe_file_name("C:\\temp\\leads", "xlsx"), "leads.xlsx");
    }

    #[test]
    fn replaces_characters_windows_rejects() {
        assert_eq!(safe_file_name("a:b*c?d|e", "csv"), "a-b-c-d-e.csv");
    }

    #[test]
    fn falls_back_when_the_template_renders_empty() {
        assert_eq!(safe_file_name("", "csv"), "placemill-export.csv");
        assert_eq!(safe_file_name("   ", "xlsx"), "placemill-export.xlsx");
    }

    #[test]
    fn keeps_placeholders_that_were_not_rendered() {
        assert_eq!(
            safe_file_name("leads-{date}-{count}", "csv"),
            "leads-{date}-{count}.csv"
        );
    }

    #[test]
    fn reserved_device_names_are_renamed() {
        // R-35: Windows refuses these stems in every directory, extension or not.
        assert_eq!(safe_file_name("CON", "csv"), "CON-export.csv");
        assert_eq!(safe_file_name("con.csv", "csv"), "con-export.csv");
        assert_eq!(safe_file_name("LPT1", "xlsx"), "LPT1-export.xlsx");
        assert_eq!(safe_file_name("nul", "csv"), "nul-export.csv");
        // Not reserved: COM10 and CONSOLE are ordinary names.
        assert_eq!(safe_file_name("COM10", "csv"), "COM10.csv");
        assert_eq!(safe_file_name("CONSOLE", "csv"), "CONSOLE.csv");
    }
}

#[derive(Serialize)]
pub struct Diagnostics {
    pub db_path: String,
    pub total_in_db: i64,
    /// p95 of the last `QUERY_SAMPLES` page queries (M6 / J-06d). `None` until
    /// the panel has loaded at least one page.
    pub query_p95_ms: Option<u64>,
    pub query_samples: usize,
    pub listening: bool,
    pub split_ratio: f64,
    pub events: u64,
    pub records: u64,
    pub new_records: u64,
    /// Rows removed by the "only with phone" switch this session (UI-09).
    pub dropped: u64,
    pub last_event_at: Option<u64>,
    pub last_error: Option<String>,
    pub maps_ready: bool,
}

/// Snapshot of the collector state for the diagnostics drawer.
#[tauri::command(async)]
pub fn get_diagnostics(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Diagnostics, String> {
    let total_in_db = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.query_row("SELECT COUNT(*) FROM businesses", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0)
    };

    let stats = state
        .stats
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default();

    Ok(Diagnostics {
        db_path: state.db_path.clone(),
        total_in_db,
        query_p95_ms: state.query_p95(),
        query_samples: state.query_samples(),
        listening: state.listening.lock().map(|l| *l).unwrap_or(false),
        split_ratio: state.split_ratio.lock().map(|r| *r).unwrap_or(crate::DEFAULT_SPLIT_RATIO),
        events: stats.events,
        records: stats.records,
        new_records: stats.new_records,
        dropped: stats.dropped,
        last_event_at: stats.last_event_at,
        last_error: stats.last_error,
        maps_ready: app.get_webview("maps").is_some(),
    })
}

// ---------------------------------------------------------------------------
// Tests — pure helpers and real temp dirs, no Tauri state (R-03 / R-04 / R-27)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn business() -> Business {
        Business {
            name: "Downtown Dental".into(),
            address: "1 Main St".into(),
            phone: "+1 415-555-0123".into(),
            rating: 4.5,
            reviews_total: 120,
            lat: 34.05,
            lng: -118.24,
            place_id: "ChIJabc123".into(),
            website: "https://downtowndental.com".into(),
            types: vec!["dentist".into(), "health".into()],
            collected_at: 0,
            source_query: "dentist".into(),
            emails: vec!["hi@downtowndental.com".into()],
            socials: vec![],
            email_source_url: String::new(),
            email_status: String::new(),
            mined_at: 0,
            ..Default::default()
        }
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "placemill-export-test-{}-{}",
            std::process::id(),
            tag
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn csv_cells_with_formula_prefixes_are_escaped() {
        assert_eq!(csv_cell("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0");
        assert_eq!(csv_cell("@SUM(A1)"), "'@SUM(A1)");
        assert_eq!(csv_cell("=1+1"), "'=1+1");
        assert_eq!(csv_cell("+cmd|' /C calc'!A0"), "'+cmd|' /C calc'!A0");
        assert_eq!(csv_cell("-2+3+cmd|' /C calc'!A0"), "'-2+3+cmd|' /C calc'!A0");
        assert_eq!(csv_cell("\t=1"), "'\t=1");
        assert_eq!(csv_cell("\r=1"), "'\r=1");
    }

    #[test]
    fn csv_cells_leave_normal_text_and_phone_numbers_alone() {
        assert_eq!(csv_cell("+1 415-555-0123"), "+1 415-555-0123");
        assert_eq!(csv_cell("+8613800138000"), "+8613800138000");
        assert_eq!(csv_cell("(555) 123-4567"), "(555) 123-4567");
        assert_eq!(csv_cell("Downtown Dental"), "Downtown Dental");
        assert_eq!(csv_cell(""), "");
        assert_eq!(csv_cell("4.5"), "4.5");
    }

    #[test]
    fn phone_shape_recognition_is_strict() {
        assert!(looks_like_phone_number("1 415-555-0123"));
        assert!(looks_like_phone_number("8613800138000"));
        assert!(looks_like_phone_number("(555) 123-4567"));
        assert!(!looks_like_phone_number("cmd|' /C calc'!A0"));
        assert!(!looks_like_phone_number(""));
        assert!(!looks_like_phone_number("1+1"));
    }

    #[test]
    fn export_cells_match_the_header_layout() {
        let cells = export_cells(&business(), &crate::email_verify::VerifyCell::default());
        assert_eq!(cells.len(), EXPORT_COLUMNS.len());
        assert_eq!(cells[0], "Downtown Dental");
        assert_eq!(cells[2], "+1 415-555-0123");
        assert_eq!(cells[8], "dentist, health");
        assert_eq!(cells[12], "hi@downtowndental.com");
        // Legacy row (collected_at = 0) gets a blank cell, not a fake 1970.
        assert_eq!(cells[10], format_collected_at(0));
        assert_eq!(cells[10], "");
        assert_eq!(cells[11], "dentist");
    }

    /// M10 / G-11: the hiddenColumns↔export linkage. "Hide what you see
    /// hidden" — a column with a table counterpart drops when the panel hides
    /// it; a column with none (identifiers, structured address parts) always
    /// exports; an unsent list exports every column.
    #[test]
    fn visible_keys_drop_only_their_own_columns() {
        let all = resolve_export_columns(None);
        assert_eq!(all.len(), EXPORT_COLUMNS.len());

        let visible: Vec<String> = vec![
            "name", "phone", "rating", "reviews", "task", "collectedAt", "website", "types",
            "emails", "socials", "open_hours", "owner_name", "email_verify", "actions",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let resolved = resolve_export_columns(Some(&visible));
        let keys: Vec<&str> = resolved.iter().map(|c| c.key).collect();

        // The table counterparts are gone…
        assert!(!keys.contains(&"address"));
        assert!(!keys.contains(&"city"));
        // …everything without a table toggle survives (the table key is None)…
        assert!(keys.contains(&"lat"));
        assert!(keys.contains(&"place_id"));
        assert!(keys.contains(&"source_query"));
        assert!(keys.contains(&"street"));
        assert!(keys.contains(&"state"));
        assert!(keys.contains(&"about"));
        // …and 'task'/'actions' map to nothing — an unknown key never drops a
        // column by accident.
        assert!(keys.contains(&"name"));
        assert!(keys.contains(&"open_hours"));
        // G-04: both verification columns hang off the one `email_verify` table
        // column, so they appear and disappear together.
        assert!(keys.contains(&"email_verify"));
        assert!(keys.contains(&"email_verify_detail"));
        assert_eq!(keys.len(), EXPORT_COLUMNS.len() - 2);
    }

    /// M10 / G-11: a preset renames only the columns the CRM knows; the rest
    /// keep their default headers, and the machine keys never move.
    #[test]
    fn presets_rename_only_their_known_columns() {
        let name = EXPORT_COLUMNS.iter().find(|c| c.key == "name").unwrap();
        let website = EXPORT_COLUMNS.iter().find(|c| c.key == "website").unwrap();
        let zip = EXPORT_COLUMNS.iter().find(|c| c.key == "postal_code").unwrap();
        let street = EXPORT_COLUMNS.iter().find(|c| c.key == "street").unwrap();
        let rating = EXPORT_COLUMNS.iter().find(|c| c.key == "rating").unwrap();

        assert_eq!(column_header(name, "default"), "Name");
        assert_eq!(column_header(website, "hubspot"), "domain");
        assert_eq!(column_header(zip, "hubspot"), "zip");
        assert_eq!(column_header(rating, "hubspot"), "Rating");
        assert_eq!(column_header(website, "pipedrive"), "Website");
        assert_eq!(column_header(street, "pipedrive"), "addr_street");
        assert_eq!(column_header(zip, "pipedrive"), "addr_zip");
        // An unknown preset is the default by construction (settings.rs), but
        // the lookup itself must not crash on one.
        assert_eq!(column_header(name, "salesforce"), "Name");
    }

    /// M10 / G-11: the JSON row keeps types — numbers stay numbers, lists
    /// stay lists, `about`/`open_hours` stay structured — and the keys follow
    /// the preset.
    #[test]
    fn the_json_row_keeps_types_and_follows_the_preset() {
        let mut row = business();
        row.collected_at = 1_792_000_000_000; // 2026-10-21-ish, nonzero on purpose
        row.about = vec![AboutEntry {
            key: "accessibility".into(),
            label: "Accessibility".into(),
        }];
        row.open_hours = vec![OpenHoursDay {
            day: "Saturday".into(),
            periods: vec!["9 AM - 5 PM".into()],
        }];

        let columns = resolve_export_columns(None);
        let object = export_row_object(&row, &columns, "default", &crate::email_verify::VerifyCell::default());
        assert_eq!(object.get("name").and_then(|v| v.as_str()), Some("Downtown Dental"));
        assert_eq!(object.get("rating").and_then(|v| v.as_f64()), Some(4.5));
        assert_eq!(object.get("reviews_total").and_then(|v| v.as_u64()), Some(120));
        assert_eq!(
            object.get("types").and_then(|v| v.as_array()).map(|a| a.len()),
            Some(2)
        );
        assert_eq!(
            object
                .get("about")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|e| e.get("key"))
                .and_then(|v| v.as_str()),
            Some("accessibility")
        );
        // RFC 3339 (UTC) for agents, not the local display form.
        assert!(object.get("collected_at").and_then(|v| v.as_str()).unwrap_or("").ends_with("Z"));

        let hubspot = export_row_object(&row, &columns, "hubspot", &crate::email_verify::VerifyCell::default());
        assert!(hubspot.contains_key("domain"));
        assert!(hubspot.contains_key("zip"));
        assert!(!hubspot.contains_key("website"));
    }

    /// G-16: a `+` number always canonicalizes — the country code is already
    /// the caller's claim, re-formatting loses nothing.
    #[test]
    fn plus_numbers_canonicalize() {
        let region = Some("US");
        assert_eq!(normalize_phone_e164("+1 415-555-0123", region), "+14155550123");
        assert_eq!(normalize_phone_e164("+86 139 1234 5678", region), "+8613912345678");
        assert_eq!(normalize_phone_e164("+8610 1234 5678", region), "+861012345678");
        // A double `+` is a typo, not a plan: the stray one drops.
        assert_eq!(normalize_phone_e164("++1 415 555 0123", region), "+14155550123");
        // Out of E.164 bounds — keep the original rather than "normalize".
        assert_eq!(normalize_phone_e164("+12345", region), "+12345");
        assert_eq!(normalize_phone_e164("+1 415 555 0123 4567 89", region), "+1 415 555 0123 4567 89");
    }

    /// G-16: a bare number only gains a country code when its digit count
    /// matches the pinned region's exact shape; a wrong-region guess must be a
    /// no-op.
    #[test]
    fn bare_numbers_follow_the_pinned_region_shape() {
        // US: 10 digits, area/exchange 2–9; an 11-digit 1-prefixed variant.
        assert_eq!(normalize_phone_e164("(415) 555-0123", Some("US")), "+14155550123");
        assert_eq!(normalize_phone_e164("1-800-356-9377", Some("US")), "+18003569377");
        // Exchange `123` is not a NANP exchange (starts 0/1) — leave it.
        assert_eq!(normalize_phone_e164("(555) 123-4567", Some("US")), "(555) 123-4567");
        // Too short / too long for the shape.
        assert_eq!(normalize_phone_e164("555-0123", Some("US")), "555-0123");
        assert_eq!(normalize_phone_e164("555-0123-9999-1", Some("US")), "555-0123-9999-1");

        // CN: trunk `0` dropped, mobile as-is, a glued dial code not doubled.
        assert_eq!(normalize_phone_e164("010-1234 5678", Some("CN")), "+861012345678");
        assert_eq!(normalize_phone_e164("13800138000", Some("CN")), "+8613800138000");
        assert_eq!(normalize_phone_e164("86 139 1234 5678", Some("CN")), "+8613912345678");
        // A CN mobile under a US region must NOT become +1 380… (exchange 0).
        assert_eq!(normalize_phone_e164("13800138000", Some("US")), "13800138000");

        // ES: 9 digits starting 6/7/8/9.
        assert_eq!(normalize_phone_e164("912 345 678", Some("ES")), "+34912345678");
        assert_eq!(normalize_phone_e164("612 345 678", Some("ES")), "+34612345678");
        assert_eq!(normalize_phone_e164("34 912 345 678", Some("ES")), "+34912345678");
        // A 9-digit number does not fit the US shape — no-op.
        assert_eq!(normalize_phone_e164("912 345 678", Some("US")), "912 345 678");
        // The honest limit of a shape check without a numbering-plan database:
        // a 10-digit number that happens to be a valid NANP form IS normalized
        // even if it was a foreign number. Dial-first users prefer this.
        assert_eq!(normalize_phone_e164("912 345 6789", Some("US")), "+19123456789");

        // No region pinned, nothing numeric, extension cut.
        assert_eq!(normalize_phone_e164("(415) 555-0123", None), "(415) 555-0123");
        assert_eq!(normalize_phone_e164("", Some("US")), "");
        assert_eq!(normalize_phone_e164("555-CALL-NOW", Some("US")), "555-CALL-NOW");
        assert_eq!(
            normalize_phone_e164("010-1234-5678 转12", Some("CN")),
            "+861012345678",
        );
        assert_eq!(
            normalize_phone_e164("+1 415-555-0123 ext. 9", Some("US")),
            "+14155550123",
        );
    }

    /// G-16: whitespace tidying on the NAP fields, and idempotence — a row
    /// that is already clean passes through byte-identical.
    #[test]
    fn nap_rows_tidy_and_normalize_idempotently() {
        let mut rows = vec![business()];
        rows[0].phone = "(415) 555-0123".into();
        rows[0].address = "  1  Main   St., ".into();
        rows[0].city = "Los\nAngeles".into();

        normalize_nap_rows(&mut rows, "US");
        assert_eq!(rows[0].phone, "+14155550123");
        assert_eq!(rows[0].address, "1 Main St.,");
        assert_eq!(rows[0].city, "Los Angeles");

        let snapshot = rows[0].phone.clone();
        let address = rows[0].address.clone();
        normalize_nap_rows(&mut rows, "US");
        assert_eq!(rows[0].phone, snapshot);
        assert_eq!(rows[0].address, address);
    }

    /// Tier-2: the payload must be the place we asked for — either identity.
    #[test]
    fn enrich_payload_identity_is_strict() {
        assert!(payload_matches("ChIJabc", "0x1:0x2", "ChIJabc", ""));
        assert!(payload_matches("ChIJabc", "0x1:0x2", "", "0x1:0x2"));
        assert!(payload_matches("ChIJabc", "0x1:0x2", "ChIJabc", "0x1:0x2"));
        // A navigation that landed on another place is a failed place.
        assert!(!payload_matches("ChIJabc", "0x1:0x2", "ChIJother", "0x1:0x2"));
        assert!(!payload_matches("ChIJabc", "", "", "0x1:0x2"), "no stored data_id, hex alone must not match");
        assert!(!payload_matches("ChIJabc", "0x1:0x2", "", ""));
    }

    /// Tier-2: the enriched detail is capped to its column shapes and NUL-free.
    #[test]
    fn enrich_sanitize_caps_and_cleans() {
        let long = "x".repeat(5_000);
        let (plus, description, rating, photos) = enrich_sanitize(
            format!("74GC+2V\u{0}"),
            long,
            vec![1, 2, 3, 4, 5, 6, 7],
            vec![
                "https://lh3.example/a.jpg".to_string(),
                "http://insecure/a.jpg".to_string(),
                "javascript:alert(1)".to_string(),
            ],
        );
        assert_eq!(plus, "74GC+2V");
        assert_eq!(description.chars().count(), 2_000);
        assert_eq!(rating, vec![1, 2, 3, 4, 5]);
        assert_eq!(photos, vec!["https://lh3.example/a.jpg".to_string()]);
    }

    /// M8 / J-08e: the new columns reach the file, and the two structured
    /// ones are rendered as one readable cell instead of raw JSON.
    #[test]
    fn the_new_export_cells_carry_the_new_fields() {
        let mut row = business();
        row.street = "281 Columbia Ave".into();
        row.city = "Los Angeles".into();
        row.state = "California".into();
        row.postal_code = "90026".into();
        row.country = "US".into();
        row.borough = "Westlake".into();
        row.timezone = "America/Los_Angeles".into();
        row.data_id = "0x80c2:0x49fd".into();
        row.reviews_link = "https://search.google.com/local/reviews?placeid=x".into();
        row.thumbnail = "https://streetviewpixels-pa.googleapis.com/v1/thumb".into();
        row.owner_name = "Lilia Martinez".into();
        row.about = vec![AboutEntry {
            key: "accessibility".into(),
            label: "Accessibility".into(),
        }];
        row.open_hours = vec![
            OpenHoursDay {
                day: "Saturday".into(),
                periods: vec!["9 AM - 5 PM".into()],
            },
            OpenHoursDay {
                day: "Sunday".into(),
                periods: Vec::new(),
            },
        ];

        let cells = export_cells(&row, &crate::email_verify::VerifyCell::default());
        assert_eq!(cells.len(), EXPORT_COLUMNS.len());
        assert_eq!(cells[15], "281 Columbia Ave");
        assert_eq!(cells[16], "Los Angeles");
        assert_eq!(cells[18], "90026");
        assert_eq!(cells[21], "America/Los_Angeles");
        assert_eq!(cells[22], "0x80c2:0x49fd");
        assert_eq!(cells[25], "Lilia Martinez");
        assert_eq!(cells[26], "accessibility: Accessibility");
        // A day with no periods is closed, and the em dash says so without
        // inventing an English word in a file that may be read anywhere.
        assert_eq!(cells[27], "Saturday: 9 AM - 5 PM; Sunday: —");
    }

    #[test]
    fn temp_paths_are_siblings_and_unique_per_call() {
        let target = std::path::PathBuf::from("/tmp/exports/leads.csv");
        let first = sibling_temp_path(&target);
        let second = sibling_temp_path(&target);
        assert_eq!(first.parent(), target.parent());
        assert_ne!(first, second);
        assert!(first.to_string_lossy().ends_with(".tmp"));
    }

    #[test]
    fn unique_export_path_claims_the_name_so_the_next_call_moves_aside() {
        let dir = temp_dir("claim");
        let first = unique_export_path(&dir, "leads.csv").expect("first");
        assert_eq!(first, dir.join("leads.csv"));
        assert!(first.is_file(), "the claim must materialise the file");

        // The claimed name is taken, so the next export moves aside.
        let second = unique_export_path(&dir, "leads.csv").expect("second");
        assert_eq!(second, dir.join("leads-1.csv"));
        assert!(second.is_file());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P2-12: the filtered path counts without loading, then streams from its
    /// own read-only connection — the shared `state.db` mutex is never held —
    /// and each row is normalized on the way out, exactly like the table.
    #[test]
    fn filtered_exports_stream_from_a_read_connection() {
        let dir = temp_dir("stream");
        let db_path = dir.join("placemill.db");
        let conn = db::init_database(&db_path).expect("db");

        let mut dental = business();
        dental.place_id = "p1".into();
        dental.name = "Dental One".into();
        dental.address = "  1  Main   St., ".into();
        dental.phone = "(415) 555-0123".into();
        dental.website = "https://one.example".into();

        let mut plumber = business();
        plumber.place_id = "p2".into();
        plumber.name = "Plumber".into();
        plumber.phone = "+1 444".into();
        plumber.website = "https://two.example".into();

        db::insert_businesses(&conn, &[dental, plumber], "dentist", "", false).expect("insert");
        drop(conn);

        let filtered = ExportSource::Query {
            request: BusinessQueryRequest {
                query: "dental".into(),
                ..Default::default()
            },
            db_path: db_path.clone(),
            region: "US".into(),
        };
        assert_eq!(filtered.count().expect("count"), 1);

        let mut seen = Vec::new();
        assert_eq!(
            filtered
                .for_each(|row| {
                    seen.push((row.name.clone(), row.address.clone(), row.phone.clone()));
                    Ok(())
                })
                .expect("stream"),
            1
        );
        // Whitespace tidied and the phone pushed to E.164, like the table.
        assert_eq!(seen[0].0, "Dental One");
        assert_eq!(seen[0].1, "1 Main St.,");
        assert_eq!(seen[0].2, "+14155550123");

        // The unfiltered source sees every row, in the export's sort order.
        let all = ExportSource::Query {
            request: BusinessQueryRequest::default(),
            db_path,
            region: String::new(),
        };
        assert_eq!(all.count().expect("count"), 2);
        let mut names = Vec::new();
        all.for_each(|row| {
            names.push(row.name.clone());
            Ok(())
        })
        .expect("stream");
        assert_eq!(names, vec!["Dental One", "Plumber"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P2-12: a scan that ends with zero rows leaves no empty file behind, and
    /// never deletes a file the save dialog confirmed for replacement.
    #[test]
    fn an_empty_stream_leaves_no_file_behind() {
        let dir = temp_dir("empty");
        let target = dir.join("out.csv");
        let temp = dir.join("out.csv.1.tmp");

        // Auto export: `unique_export_path` claimed an empty placeholder.
        std::fs::write(&temp, b"Name\r\n").expect("temp");
        std::fs::write(&target, b"").expect("placeholder");
        assert!(finish_export(&temp, &target, false, Ok(0))
            .expect("settle")
            .is_none());
        assert!(!temp.exists());
        assert!(!target.exists());

        // Dialog export: the existing file was confirmed for replacement, so an
        // empty stream leaves it exactly as it was.
        std::fs::write(&temp, b"Name\r\n").expect("temp");
        std::fs::write(&target, b"keep me").expect("existing");
        assert!(finish_export(&temp, &target, true, Ok(0))
            .expect("settle")
            .is_none());
        assert!(!temp.exists());
        assert_eq!(std::fs::read_to_string(&target).expect("read"), "keep me");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ===== G-04: contact slots and export columns =====

    /// §4.3.1: two jobs that each check "the other slot is free" then claim
    /// their own would both start. The critical section is what makes exactly
    /// one win, and this test races the two claims for real.
    #[test]
    fn contact_slots_exclude_each_other_atomically() {
        use std::sync::{Arc, Barrier, Mutex};

        for _round in 0..50 {
            let lock = Arc::new(Mutex::new(()));
            let mining: Arc<Mutex<Option<Arc<AtomicBool>>>> = Arc::new(Mutex::new(None));
            let verifying: Arc<Mutex<Option<Arc<AtomicBool>>>> = Arc::new(Mutex::new(None));
            let barrier = Arc::new(Barrier::new(2));

            let mut handles = Vec::new();
            for want in [ContactJob::Mining, ContactJob::Verification] {
                let lock = Arc::clone(&lock);
                let mining = Arc::clone(&mining);
                let verifying = Arc::clone(&verifying);
                let barrier = Arc::clone(&barrier);
                handles.push(std::thread::spawn(move || {
                    barrier.wait();
                    claim_exclusive(&lock, &mining, &verifying, want).is_ok()
                }));
            }
            let winners = handles
                .into_iter()
                .map(|handle| handle.join().expect("join"))
                .filter(|claimed| *claimed)
                .count();
            assert_eq!(winners, 1, "exactly one contact job may start");
        }
    }

    #[test]
    fn a_second_claim_reports_which_job_is_running() {
        use std::sync::Mutex;

        let lock = Mutex::new(());
        let mining: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);
        let verifying: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

        assert!(claim_exclusive(&lock, &mining, &verifying, ContactJob::Mining).is_ok());
        assert_eq!(
            claim_exclusive(&lock, &mining, &verifying, ContactJob::Mining).unwrap_err(),
            "already-running"
        );
        assert_eq!(
            claim_exclusive(&lock, &mining, &verifying, ContactJob::Verification).unwrap_err(),
            "mining_running"
        );

        // Release the mining slot, take the verification one, and check the
        // other direction reports the mirror-image code.
        *mining.lock().expect("mining") = None;
        assert!(claim_exclusive(&lock, &mining, &verifying, ContactJob::Verification).is_ok());
        assert_eq!(
            claim_exclusive(&lock, &mining, &verifying, ContactJob::Mining).unwrap_err(),
            "verify_running"
        );
    }

    /// R-03: the two verification columns are *appended*, so a user's existing
    /// CRM mapping keeps pointing at the same field.
    #[test]
    fn export_columns_append_without_moving_existing() {
        let keys: Vec<&str> = EXPORT_COLUMNS.iter().map(|column| column.key).collect();
        assert_eq!(keys[0], "name");
        assert_eq!(keys[1], "address");
        assert_eq!(keys[12], "emails");
        // The pre-G-04 tail is still the tail of the pre-G-04 columns.
        let tail = &keys[keys.len() - 4..keys.len() - 2];
        assert_eq!(tail, &["reviews_per_rating", "photos"]);
        assert_eq!(keys[keys.len() - 2], "email_verify");
        assert_eq!(keys[keys.len() - 1], "email_verify_detail");
    }
}
