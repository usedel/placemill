//! Area-collection job runner (roadmap M3).
//!
//! The queue lives in SQLite (`search_jobs` / `search_tiles`) and this module is
//! the only thing that drives it. A single worker thread owns the `maps`
//! webview: one job runs at a time, and when it finishes the worker picks the
//! next `queued` job instead of exiting, so a six-job queue can run unattended.
//!
//! Tile outcomes are written back before the next navigation, which is what
//! makes "kill the process, restart, continue" work: the runner always starts
//! from `SELECT ... WHERE status = 'pending' ORDER BY seq`, so finished cells are
//! never visited twice and a half-scrolled cell is simply redone.

use crate::logging::{log_error, log_info, log_warn};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{self, JobRow, TileRow};
use crate::grid::VIEWPORT_KM_AT_Z0;
use crate::grid;
use crate::{now_ms, AppState};

/// A tile that never reports `collector:scroll-start` means the script did not
/// run (page load failed, consent page, wrong URL) — fail fast instead of
/// waiting out the full idle budget per tile.
pub const TILE_START_TIMEOUT_SECS: u64 = 30;
/// Scrolling can legitimately take a while on a dense area (up to 80 scrolls at
/// 1–3 s each); this is the budget after the start event.
pub const TILE_IDLE_TIMEOUT_SECS: u64 = 120;
/// Breathing room between tiles. Fixed rather than random so the run duration
/// is predictable, and 2.5 s is already far slower than a human.
pub const TILE_PAUSE_MS: u64 = 2500;
/// A tile is attempted twice at most; after that it is `skipped` and the job
/// moves on. Without a cap a dead page would stall the queue forever.
pub const TILE_MAX_ATTEMPTS: i64 = 2;
/// Safety cap on leaves per job.
///
/// The depth cap bounds each branch, not the number of branches: a 200-tile job
/// where every tile splits twice would reach 3200 leaves, i.e. hours of
/// requests. 400 leaves is already a multi-hour run, so beyond that something is
/// wrong (a parser bug duplicating rows, or a threshold set too low) and the job
/// should stop subdividing instead of growing without bound.
pub const MAX_LEAF_TILES: i64 = 400;
/// Consecutive tiles that end "dry" (no clean stop, no data) before the job is
/// paused automatically.
///
/// A consent page, a captcha or a dead webview produces exactly this: every
/// navigation loads, nothing scrolls, nothing arrives, the tile burns its two
/// attempts and the runner moves on — for every remaining tile of the grid, at
/// two timeouts each. A genuinely empty area never triggers this: it ends
/// cleanly through `no-results`, which does not count as dry — `no-feed` does
/// (P1-2), because it means the page never rendered a result list at all.
pub const DRY_TILE_PAUSE_STREAK: u32 = 2;
const POLL_MS: u64 = 400;

/// End-of-cell reasons the page may report. `navigate`, `settings` and
/// `manual` are stops that happen for other reasons and must not close a cell.
const CELL_END_REASONS: [&str; 5] = ["idle", "max-scrolls", "no-results", "no-feed", "drift"];

fn is_cell_end(reason: &str) -> bool {
    CELL_END_REASONS.contains(&reason)
}

/// Whether a finished tile is evidence of a dead page rather than an empty
/// area (P1-2).
///
/// `no-feed` ends the cell so the runner does not wait out the idle timeout on
/// a captcha, but it proves nothing about the area: the page had no result feed
/// and no usable Maps shell (a captcha / consent screen / dead render). Counting
/// it as dry is what stops a blocked map from walking the whole grid to `empty`.
fn counts_as_dry(received: u32, started: bool, finished: bool, reason: Option<&str>) -> bool {
    received == 0 && (!started || !finished || reason == Some("no-feed"))
}

/// The job state machine. Only some transitions are driven from Rust (the rest
/// happen through SQL strings in `commands.rs`), so several variants are never
/// constructed here — they still document the vocabulary the database uses.
///
/// Kept until those SQL writers are routed through this enum; tracked in
/// `docs/collector-roadmap.md` under the P2 job state machine.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Running,
    Paused,
    Completed,
    Cancelled,
    Failed,
}

impl JobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            JobStatus::Queued => "queued",
            JobStatus::Running => "running",
            JobStatus::Paused => "paused",
            JobStatus::Completed => "completed",
            JobStatus::Cancelled => "cancelled",
            JobStatus::Failed => "failed",
        }
    }
}

/// The job currently being scrolled. Everything else (list, counts, progress)
/// is read from SQLite; this exists so the `business-data` listener can attribute
/// a batch to a tile without a query per batch.
#[derive(Debug, Clone)]
pub struct ActiveJob {
    pub job_id: String,
    pub current_tile: Option<String>,
    /// Rows of the current tile that survived the radius filter: the split
    /// decision reads this, not the raw batch size.
    pub received: u32,
    /// Place ids already counted for the current tile. Google re-sends rows it
    /// has already delivered when the feed re-renders, and `insert_businesses`
    /// dedupes them in SQL — counting the raw batch made those repeats look
    /// like new rows and tripped `split_threshold` early (P2-2).
    pub seen: std::collections::HashSet<String>,
}

/// Why there is no "stop scrolling when results stop being local" rule.
///
/// It was tried and measured: Google's feed is relevance-ordered with a
/// distance decay that does not truncate, so local places are interleaved with
/// far-away ones across the whole ~120-place window instead of arriving as one
/// clean block. Stopping after 3 batches without a new local row cut a downtown
/// cell at 29 of its ~56 local rows (and again at 36 of ~60). The feed's own
/// end — no growth for a few rounds, or the scroll budget — is the only stop
/// that does not lose local results, so the budget (`max_scrolls_for_radius`)
/// is what actually curbs how far the feed walks, and the radius filter at
/// write time is what keeps the *data* inside the area.

/// Last lifecycle event seen from the injected script. The runner compares
/// sequence numbers against a snapshot taken before navigating, so a stale
/// event from the previous tile can never close the current one.
#[derive(Debug, Default)]
pub struct GridSignal {
    pub start_seq: u64,
    pub start_tile: String,
    pub idle_seq: u64,
    pub idle_tile: String,
    pub idle_reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapView {
    pub lat: f64,
    pub lng: f64,
    pub zoom: f64,
    /// Wall-clock time of the report, so the panel can show "read 2 s ago".
    pub at: u64,
}

enum Outcome {
    /// The job reached a terminal state; the worker may pick up the next one.
    Finished,
    /// Paused or cancelled: the worker must stop, not chain the queue.
    Halted,
}

// ---------------------------------------------------------------------------
// Active-tile bookkeeping (called from the business-data listener)
// ---------------------------------------------------------------------------

pub fn begin_tile(app: &AppHandle, job_id: &str, tile_id: &str) {
    let state = app.state::<AppState>();
    let Ok(mut slot) = state.active_job.lock() else {
        return;
    };
    *slot = Some(ActiveJob {
        job_id: job_id.to_string(),
        current_tile: Some(tile_id.to_string()),
        received: 0,
        seen: std::collections::HashSet::new(),
    });
}

/// Rows received for the tile that just finished, and clear the slot.
pub fn end_tile(app: &AppHandle) -> u32 {
    let state = app.state::<AppState>();
    let Ok(mut slot) = state.active_job.lock() else {
        return 0;
    };
    let rows = slot.as_ref().map(|active| active.received).unwrap_or(0);
    if let Some(active) = slot.as_mut() {
        active.current_tile = None;
        active.received = 0;
        active.seen.clear();
    }
    rows
}

/// Attribute a batch to the tile the runner is waiting on.
///
/// The job id comes from Rust, never from the page: `business-data` carries a
/// `jobId` that the page reads out of sessionStorage, and that context outlives
/// the job that wrote it. Trusting it meant a batch produced after a cancel or
/// a restart still counted towards the finished job — its result list grew
/// while no task was running. Returning the id here (or `None`) is what lets
/// the caller store the row unattributed instead.
///
/// Row counting is *not* done here: a batch still has to pass the ingress
/// guard, the session gate, the "only with phone" switch and the radius filter,
/// and the split decision must see what survived them. `count_tile_rows` is
/// called by `store_businesses` once the batch is known to be admissible.
pub fn attribute_batch(app: &AppHandle, tile_id: &str) -> Option<String> {
    if tile_id.is_empty() {
        return None;
    }
    let state = app.state::<AppState>();
    // The worker releases this slot on exit, so a leftover `active_job` (the
    // runner has not noticed a cancel yet) cannot keep attributing rows.
    let runner_job = state
        .active_runner
        .lock()
        .ok()
        .and_then(|slot| slot.clone())?;

    let Ok(slot) = state.active_job.lock() else {
        return None;
    };
    let active = slot.as_ref()?;
    if active.current_tile.as_deref() != Some(tile_id) || active.job_id != runner_job {
        return None;
    }
    Some(active.job_id.clone())
}

/// Upper bound on the ids remembered for one tile. The split threshold is 100
/// rows and Google caps a search at ~120, so this is far beyond any real cell;
/// it exists so a page that floods duplicate ids cannot grow this set without
/// bound.
const TILE_SEEN_LIMIT: usize = 5_000;

/// Rows of the current tile that survived every filter, for the split decision.
///
/// Google keeps loading further away as the page scrolls, so the raw batch size
/// is not evidence that the cell is dense: a 1.5 km cell used to receive 120
/// rows of which ~30 were inside the radius, hit the 100-row split threshold and
/// quadrupled the grid into territory it was never asked to cover. Counting the
/// kept rows is what stops that feedback loop.
///
/// P2-2: two more conditions on top of "survived the filters". The batch must
/// be *attributed to the running job* (a late batch from the previous cell used
/// to be counted against the current tile), and each `place_id` counts once
/// (Google re-sends rows it has already delivered, and SQL dedupes them, so the
/// raw count made a steady feed look denser than it was).
///
/// Returns how many rows the counter actually grew by.
pub fn count_tile_rows(app: &AppHandle, attributed_job: &str, rows: &[crate::Business]) -> u32 {
    if rows.is_empty() || attributed_job.is_empty() {
        return 0;
    }
    let state = app.state::<AppState>();
    let Ok(mut slot) = state.active_job.lock() else {
        return 0;
    };
    let Some(active) = slot.as_mut() else {
        return 0;
    };
    count_new_ids(active, attributed_job, rows.iter().map(|row| row.place_id.as_str()))
}

/// Pure core of `count_tile_rows`: attribution check + per-tile dedupe.
fn count_new_ids<'a>(
    active: &mut ActiveJob,
    attributed_job: &str,
    ids: impl Iterator<Item = &'a str>,
) -> u32 {
    // `attribute_batch` already refuses a batch whose tile is not the one the
    // runner waits on; repeating the job check here keeps the counter honest
    // for callers that reach this function directly.
    if active.current_tile.is_none() || active.job_id != attributed_job {
        return 0;
    }
    let before = active.received;
    for place_id in ids {
        if place_id.is_empty() || active.seen.len() >= TILE_SEEN_LIMIT {
            continue;
        }
        if active.seen.insert(place_id.to_string()) {
            active.received += 1;
        }
    }
    active.received - before
}

pub fn clear_active(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Ok(mut slot) = state.active_job.lock() else {
        return;
    };
    *slot = None;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

/// Claim the single runner slot. Called by `start_job` *before* the job row flips
/// to `running`, so two concurrent clicks cannot both pass the "is anything
/// running" check.
pub fn claim_runner(state: &AppState, job_id: &str) -> bool {
    match state.active_runner.lock() {
        Ok(mut slot) => {
            if slot.is_some() {
                return false;
            }
            *slot = Some(job_id.to_string());
            true
        }
        Err(_) => false,
    }
}

/// Release whatever job holds the runner slot.
///
/// Only for the command error paths that claimed the slot themselves and have
/// no runner thread behind it. A runner must use `release_runner_for`: its exit
/// can race a `start_job` that already claimed the slot for the next job (the
/// grace window is exactly that moment), and taking the slot then would leave
/// the new runner unowned — no attribution, no pane claim.
pub fn release_runner(state: &AppState) {
    // Take the id out first: the pane claim is released with the identity
    // check, and holding `active_runner` while locking `pane_owner` is a lock
    // order nobody else uses (P2-1).
    let released = match state.active_runner.lock() {
        Ok(mut slot) => slot.take(),
        Err(_) => None,
    };
    if let Some(job_id) = released {
        crate::commands::release_pane(state, &crate::PaneOwner::Job(job_id));
    }
}

/// Release the runner slot only if it still belongs to `job_id`.
fn release_runner_for(state: &AppState, job_id: &str) {
    let released = match state.active_runner.lock() {
        Ok(mut slot) => {
            if slot.as_deref() == Some(job_id) {
                slot.take()
            } else {
                None
            }
        }
        Err(_) => None,
    };
    if released.is_some() {
        crate::commands::release_pane(state, &crate::PaneOwner::Job(job_id.to_string()));
    }
}

/// Move the runner slot — and the pane claim — to the next chained job.
///
/// `attribute_batch` requires `active_job.job_id == active_runner`, so a
/// chained job that never took the slot over collected its rows unattributed:
/// they were stored with no job id, `bump_job_inserted` was skipped and the
/// task view claimed it found nothing (P2-3).
fn hand_runner_to(app: &AppHandle, job_id: &str) {
    let state = app.state::<AppState>();
    if let Ok(mut slot) = state.active_runner.lock() {
        *slot = Some(job_id.to_string());
    }
    crate::commands::set_pane_owner(&state, crate::PaneOwner::Job(job_id.to_string()));
}

/// Releases everything the runner owns when it stops — including on a panic.
///
/// The worker is the last owner of the collector switch and it holds the single
/// runner slot. Both used to be released by straight lines at the end of the
/// loop, so a panic inside `run_job` skipped them and left the app claiming a
/// running job forever: every later `start_job` answered `job_running`, the page
/// kept collecting with no job behind it, and `active_job` kept attributing
/// batches to a runner that no longer existed (C-06 — the same failure R-01
/// fixed for the miner).
struct RunnerExitGuard {
    app: AppHandle,
    /// The job this runner currently owns. Follows the queue when it chains, so
    /// the release can be identity-checked against a slot a new `start_job` may
    /// already have claimed.
    job: std::sync::Mutex<String>,
}

impl RunnerExitGuard {
    fn new(app: AppHandle, job_id: String) -> Self {
        Self {
            app,
            job: std::sync::Mutex::new(job_id),
        }
    }

    fn set_job(&self, job_id: &str) {
        if let Ok(mut slot) = self.job.lock() {
            *slot = job_id.to_string();
        }
    }
}

impl Drop for RunnerExitGuard {
    fn drop(&mut self) {
        // Every exit path — queue dry, paused, cancelled, failed, panic — ends
        // the session here. This is the guarantee behind the panel never
        // claiming "collecting" after a task stopped: commands may turn the
        // switch off early for responsiveness, but nothing can leave it on.
        crate::commands::switch_from_worker(&self.app, false);
        clear_active(&self.app);
        let job_id = self
            .job
            .lock()
            .map(|slot| slot.clone())
            .unwrap_or_default();
        if !job_id.is_empty() {
            release_runner_for(&self.app.state::<AppState>(), &job_id);
        }
        log_info!("runner stopped");
    }
}

/// Message of a caught panic, for the log line.
fn panic_reason(panic: &(dyn std::any::Any + Send)) -> String {
    panic
        .downcast_ref::<&str>()
        .map(|text| text.to_string())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".to_string())
}

/// Start the worker for an already-claimed `job_id`. The slot must be held by
/// the caller (`claim_runner`); the thread releases it when the queue runs dry.
pub fn spawn_runner(app: AppHandle, job_id: String) {
    thread::spawn(move || {
        let exit = RunnerExitGuard::new(app.clone(), job_id.clone());
        let mut current = Some(job_id);
        while let Some(id) = current.take() {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_job(&app, &id)
            }));
            match outcome {
                Ok(Outcome::Finished) => {
                    current = match start_next_queued(&app) {
                        Some(next) => {
                            // The chained job collects from here on. A command
                            // may have switched collection off for the job that
                            // just finished (pause/cancel end the queue instead,
                            // so this is the only place that re-arms it). The
                            // switch is asserted *after* the conditional status
                            // flip, so a cancel that raced the queue cannot
                            // leave it on.
                            hand_runner_to(&app, &next);
                            exit.set_job(&next);
                            crate::commands::switch_from_worker(&app, true);
                            log_info!("queue: starting next job {}", next);
                            Some(next)
                        }
                        None => None,
                    };
                }
                Ok(Outcome::Halted) => break,
                Err(panic) => {
                    // A panicking tile loop must not leave the job `running`:
                    // the panel would show a task that cannot be paused and that
                    // blocks every other start until the app restarts. Pausing
                    // is the state the panel knows how to offer ("resume").
                    log_error!("job runner panicked on {}: {}", id, panic_reason(&*panic));
                    // Conditional: a cancel/pause that landed before the panic
                    // owns the status and must not be overwritten with paused.
                    let _ = db_call(&app, |conn| {
                        db::set_job_status_if_running(conn, &id, "paused")
                    });
                    let _ = db_call(&app, |conn| db::reset_running_tiles(conn, &id));
                    emit_progress(&app, &id);
                    break;
                }
            }
        }
    });
}

fn run_job(app: &AppHandle, job_id: &str) -> Outcome {
    // P2: one row per execution. Idempotent, so a job the worker picked up from
    // the queue and a job started by hand share the same path.
    let _ = db_call(app, |conn| db::open_run(conn, job_id));
    let mut dry_streak: u32 = 0;
    loop {
        if !is_running(app, job_id) {
            return Outcome::Halted;
        }

        let Some(tile) = db_call(app, |conn| db::next_pending_tile(conn, job_id)).flatten() else {
            return if finish_job(app, job_id) {
                Outcome::Finished
            } else {
                Outcome::Halted
            };
        };

        // Spacing between cells, paid only when there is another cell to visit.
        // Sleeping at the end of every iteration instead would keep the runner
        // slot for 2.5 s after the last tile, and a "start" click in that window
        // was rejected as `job_running` even though the job had finished.
        thread::sleep(Duration::from_millis(TILE_PAUSE_MS));
        if !is_running(app, job_id) {
            return Outcome::Halted;
        }

        begin_tile(app, job_id, &tile.id);
        let _ = db_call(app, |conn| db::mark_tile_running(conn, &tile.id));

        let context = match load_context(app, job_id) {
            Some(context) => context,
            None => return Outcome::Halted,
        };
        let url = tile_url(&context.keyword, tile.lat, tile.lng, tile.zoom, &context.locale);
        let (start_seq, idle_seq) = read_sequences(app);

        let mut started = false;
        let mut finished = false;
        let mut navigated = false;
        let mut idle_reason: Option<String> = None;

        if navigate(
            app,
            job_id,
            &tile.id,
            &url,
            tile.lat,
            tile.lng,
            tile.zoom,
            context.radius_km,
        ) {
            navigated = true;
            log_info!(
                "grid {}: tile {}/{} {} depth {} (attempt {}) -> {}",
                job_id,
                tile.seq + 1,
                context.total_tiles,
                tile.id,
                tile.depth,
                tile.attempts + 1,
                url
            );
            started = wait_for_start(
                app,
                job_id,
                &tile.id,
                start_seq,
                Duration::from_secs(TILE_START_TIMEOUT_SECS),
            );
            if started {
                // The page's own end reason (idle / max-scrolls / no-results /
                // drift) — `drift` with zero rows is the one worth surfacing.
                idle_reason = wait_for_idle(
                    app,
                    job_id,
                    &tile.id,
                    idle_seq,
                    Duration::from_secs(TILE_IDLE_TIMEOUT_SECS),
                );
                finished = idle_reason.is_some();
            }
        }

        // Paused or cancelled mid-tile: put the tile back to `pending` so a
        // resume redoes it, and leave the job's status alone.
        if !is_running(app, job_id) {
            end_tile(app);
            let _ = db_call(app, |conn| {
                db::finish_tile(conn, &tile.id, "pending", 0, tile.attempts, None)
            });
            return Outcome::Halted;
        }

        let received = end_tile(app);

        // Quadtree split (M4 / J-04a): a cell that hit the per-tile cap is only a
        // sample of its area, so it is replaced by four children half its size.
        // Only a clean end qualifies — a timed-out tile may have rows but not all
        // of them, and subdividing on partial data would double-collect.
        let wants_split =
            started && finished && i64::from(received) >= context.split_threshold;
        if wants_split && context.total_tiles + 3 > MAX_LEAF_TILES {
            log_info!(
                "tile {} not split: job already has {} leaves (cap {})",
                tile.id, context.total_tiles, MAX_LEAF_TILES
            );
        } else if wants_split && grid::can_split(tile.depth, context.cell_km) {
            let parent_cell = grid::cell_at_depth(context.cell_km, tile.depth);
            let child_cell = parent_cell / 2.0;
            let children: Vec<db::ChildTile> =
                grid::quadrant_centers(tile.lat, tile.lng, parent_cell)
                    .iter()
                    .enumerate()
                    .map(|(index, (lat, lng))| db::ChildTile {
                        // `split_tile` shifts the pending queue to make room.
                        seq: (tile.seq + 1 + index as i64) as u32,
                        lat: *lat,
                        lng: *lng,
                        zoom: grid::zoom_for_cell(child_cell),
                        depth: tile.depth + 1,
                    })
                    .collect();

            let split = db_call(app, |conn| {
                db::split_tile(
                    conn,
                    job_id,
                    &tile.id,
                    tile.seq,
                    i64::from(received),
                    &children,
                )
            })
            .unwrap_or(0);

            if split > 0 {
                let _ = db_call(app, |conn| db::refresh_job_counts(conn, job_id, None));
                emit_progress(app, job_id);
                log_info!(
                    "tile {} split into 4 ({} rows, depth {} -> {}, {:.3} km each)",
                    tile.id,
                    received,
                    tile.depth,
                    tile.depth + 1,
                    child_cell
                );
                // The next loop iteration pauses before the first child.
                continue;
            }
            // Fall through on a DB error: keeping the rows as `done` beats
            // dropping the cell because the subdivision could not be written.
        }

        let attempts = tile.attempts + 1;
        let status = if started && finished {
            if received > 0 {
                "done"
            } else {
                "empty"
            }
        } else if received > 0 {
            // Rows arrived but the cell never reported a clean end (slow network,
            // a missed event). The data is already stored and re-scrolling would
            // duplicate work, so treat it as done instead of retrying it away.
            "done"
        } else if attempts < TILE_MAX_ATTEMPTS {
            "pending"
        } else {
            "skipped"
        };

        // A5: every non-success final state carries one short code, so the task
        // view can say why without the diagnostics drawer. `drift` is only
        // worth surfacing when the re-fitted cell yielded nothing at all.
        let error_reason = match status {
            "empty" => Some(match idle_reason.as_deref() {
                Some("drift") => "drift",
                // The page had no result list and no usable Maps shell: "nothing
                // here" is not what this tile proved (P1-2).
                Some("no-feed") => "no-feed",
                _ => "parse-empty",
            }),
            "pending" | "skipped" => Some(if navigated { "timeout" } else { "nav-failed" }),
            _ => None,
        };

        let _ = db_call(app, |conn| {
            db::finish_tile(conn, &tile.id, status, i64::from(received), attempts, error_reason)
        });
        let _ = db_call(app, |conn| db::refresh_job_counts(conn, job_id, None));
        emit_progress(app, job_id);

        // Probe (§5.8 A1): the first finished tile IS the verdict. Pause the
        // job through the same path the pause button uses — the flag is
        // consumed here, so a resume continues with the full grid.
        let state = app.state::<AppState>();
        let probe_hit = state
            .probe_limit
            .lock()
            .map(|slot| slot.as_ref().map(|id| id == job_id).unwrap_or(false))
            .unwrap_or(false);
        if probe_hit {
            if let Ok(mut slot) = state.probe_limit.lock() {
                *slot = None;
            }
            match crate::commands::pause_running_job(app, &state, job_id) {
                Ok(job) => {
                    let _ = app.emit(
                        "probe:completed",
                        serde_json::json!({ "jobId": job_id, "count": job.found_count }),
                    );
                    log_info!("probe pause: job {} stopped after its first tile ({} rows)", job_id, job.found_count);
                }
                Err(error) => log_warn!("probe pause failed for {}: {}", job_id, error),
            }
        }

        log_info!(
            "tile {} -> {} ({} rows, attempt {})",
            tile.id, status, received, attempts
        );

        // Dead-page watchdog: pause instead of burning through the grid.
        if counts_as_dry(received, started, finished, idle_reason.as_deref()) {
            dry_streak += 1;
        } else {
            dry_streak = 0;
        }
        if dry_streak >= DRY_TILE_PAUSE_STREAK {
            // Conditional: a cancel/pause that landed while this tile was
            // running owns the status now. The old unconditional update could
            // turn a cancelled job back into `paused`.
            let changed = db_call(app, |conn| {
                db::set_job_status_if_running(conn, job_id, "paused")
            })
            .unwrap_or(0);
            if changed > 0 {
                log_info!(
                    "job {} paused automatically: {} tiles in a row ended \
                     without data and without a clean stop (consent page, captcha or \
                     a dead map?) — handle the page and press resume",
                    job_id, dry_streak
                );
                let state = app.state::<AppState>();
                let _ = crate::commands::apply_listening(app, state.inner(), false);
                emit_progress(app, job_id);
            } else {
                log_info!(
                    "job {}: dead-page watchdog tripped, but the status was no longer \
                     running; leaving the user's state untouched",
                    job_id
                );
            }
            return Outcome::Halted;
        }

        if status == "pending" {
            // Immediate retry of the same tile; the pause happens at the top of
            // the next iteration alongside every other navigation.
            continue;
        }
    }
}

fn finish_job(app: &AppHandle, job_id: &str) -> bool {
    let status = db_call(app, |conn| db::load_job(conn, job_id))
        .flatten()
        .map(|job| {
            if job.done_tiles == 0 && job.failed_tiles > 0 {
                JobStatus::Failed.as_str()
            } else {
                JobStatus::Completed.as_str()
            }
        })
        .unwrap_or(JobStatus::Completed.as_str());

    // C-07: only a job that is still `running` may be finished. A cancel or a
    // pause that landed between the last tile and this call owns the status
    // now, and overwriting it would show a cancelled task as completed. The
    // counters are refreshed either way.
    let _ = db_call(app, |conn| {
        db::set_job_status_if_running(conn, job_id, status)?;
        db::refresh_job_counts(conn, job_id, None)
    });
    // Closed after the counts are refreshed, and with the status that actually
    // won: `close_run` writes the string it is given, and reusing the computed
    // one would record a run as completed for a task the user cancelled.
    let stored_status = db_call(app, |conn| db::load_job(conn, job_id))
        .flatten()
        .map(|job| job.status);
    let final_status = stored_status.clone().unwrap_or_else(|| status.to_string());
    let _ = db_call(app, |conn| db::close_run(conn, job_id, &final_status));
    emit_progress(app, job_id);

    if let Some(job) = db_call(app, |conn| db::load_job(conn, job_id)).flatten() {
        log_info!(
            "grid {} {}: {}/{} tiles, {} failed, {} rows inserted",
            job.id,
            job.status,
            job.done_tiles,
            job.total_tiles,
            job.failed_tiles,
            job.inserted
        );
    }
    // P2-4: no stored status (DB error) must not chain either — the queue is
    // safer stopped than started on a guess.
    stored_status.as_deref().map(queue_continues).unwrap_or(false)
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

fn db_call<T>(
    app: &AppHandle,
    query: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>,
) -> Option<T> {
    let state = app.state::<AppState>();
    let conn = state.db.lock().ok()?;
    match query(&conn) {
        Ok(value) => Some(value),
        Err(error) => {
            log_warn!("job db error: {}", error);
            None
        }
    }
}

/// Everything the per-tile loop needs from the job row. Read once per tile: the
/// split threshold is fixed at creation, so it cannot change mid-job.
struct JobContext {
    keyword: String,
    locale: String,
    total_tiles: i64,
    cell_km: f64,
    radius_km: f64,
    split_threshold: i64,
}

fn load_context(app: &AppHandle, job_id: &str) -> Option<JobContext> {
    let job = db_call(app, |conn| db::load_job(conn, job_id)).flatten()?;
    Some(JobContext {
        keyword: job.keyword,
        locale: job.locale,
        total_tiles: job.total_tiles,
        cell_km: job.cell_km,
        radius_km: job.radius_km,
        split_threshold: job.split_threshold,
    })
}

fn next_queued(app: &AppHandle) -> Option<String> {
    db_call(app, |conn| db::next_queued_job(conn)).flatten().map(|job| job.id)
}

/// Claim the oldest job that is *still* queued. A cancel/pause can land
/// between `next_queued_job` reading the row and the worker starting it; the
/// conditional update loses that race on purpose, and the loop moves on to the
/// next candidate instead of reviving a cancelled task.
fn start_next_queued(app: &AppHandle) -> Option<String> {
    loop {
        let next = next_queued(app)?;
        match db_call(app, |conn| {
            db::set_job_status_if_queued(conn, &next, "running")
        }) {
            Some(changed) if changed > 0 => return Some(next),
            Some(_) => continue,
            None => return None,
        }
    }
}

/// Whether a finished job may hand the queue to the next one. Only a job that
/// really reached a terminal state may chain: a pause/cancel that landed
/// between the last tile and `finish_job` must end the queue, not start the
/// next task behind the user's back.
fn queue_continues(status: &str) -> bool {
    matches!(status, "completed" | "failed")
}

fn is_running(app: &AppHandle, job_id: &str) -> bool {
    db_call(app, |conn| db::load_job(conn, job_id))
        .flatten()
        .map(|job| job.status == JobStatus::Running.as_str())
        .unwrap_or(false)
}

/// Persist the current state and tell the panel. Fired on every tile transition
/// and on finalization; the queue dialog listens for it instead of polling.
pub fn emit_progress(app: &AppHandle, job_id: &str) {
    let Some(job) = db_call(app, |conn| db::load_job(conn, job_id)).flatten() else {
        return;
    };
    if let Err(error) = app.emit("job:progress", &job) {
        log_warn!("job:progress emit failed: {}", error);
    }
}

/// Load the job for command handlers that need to emit after a status change.
pub fn load_job(app: &AppHandle, job_id: &str) -> Option<JobRow> {
    db_call(app, |conn| db::load_job(conn, job_id)).flatten()
}

pub fn list_jobs(app: &AppHandle) -> Vec<JobRow> {
    db_call(app, |conn| db::list_jobs(conn)).unwrap_or_default()
}

pub fn list_tiles(app: &AppHandle, job_id: &str) -> Vec<TileRow> {
    db_call(app, |conn| db::job_tiles(conn, job_id)).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Navigation + waits
// ---------------------------------------------------------------------------

/// Scroll budget for one cell, derived from the job radius.
///
/// Google caps one search at ~120 places (6 batches of 20), and local results
/// are interleaved with far-away ones across the whole window — so the budget
/// must always reach the end of the feed (`+4` covers the cap plus slack), or
/// local rows in the tail are lost. The upper clamp is what curbs how far the
/// feed walks: 80 scrolls could never show 1 600 distinct places inside a
/// 1.5 km circle, they only fetch districts the job never asked about.
pub fn max_scrolls_for_radius(radius_km: f64) -> u32 {
    if !radius_km.is_finite() || radius_km <= 0.0 {
        return 8;
    }
    ((radius_km * 2.0).round() as i64 + 4).clamp(6, 40) as u32
}

/// Assumed width of the `maps` pane in CSS px, for the drift allowance only.
/// Measured on a 1536 px window at 1.25 scale with the default split; the value
/// is deliberately an approximation because the allowance is a fuzzy threshold.
const MAPS_VIEWPORT_PX: f64 = 830.0;

/// Camera drift that counts as "Google re-fitted the map away from the cell":
/// one full viewport width. A smaller threshold misfires on wide zooms — at
/// zoom 13 the viewport is ~16 km, so re-fitting by 4 km is ordinary map
/// behaviour, not a reason to abandon the cell.
fn drift_allowance_km(zoom: u8) -> f64 {
    let viewport_km = VIEWPORT_KM_AT_Z0 / 2f64.powi(i32::from(zoom)) * (MAPS_VIEWPORT_PX / 1000.0);
    viewport_km.max(0.5)
}

fn navigate(
    app: &AppHandle,
    job_id: &str,
    tile_id: &str,
    url: &str,
    lat: f64,
    lng: f64,
    zoom: u8,
    radius_km: f64,
) -> bool {
    let script = format!(
        "try {{ window.__placemillGoto({}, {{ jobId: {}, tileId: {}, lat: {:.6}, lng: {:.6}, maxScrolls: {}, maxDriftKm: {:.3} }}); }}
         catch (e) {{ console.warn('[Placemill] goto failed', e); }}",
        json_string(url),
        json_string(job_id),
        json_string(tile_id),
        lat,
        lng,
        max_scrolls_for_radius(radius_km),
        drift_allowance_km(zoom)
    );
    app.get_webview("maps")
        .map(|webview| webview.eval(&script).is_ok())
        .unwrap_or(false)
}

fn read_sequences(app: &AppHandle) -> (u64, u64) {
    let state = app.state::<AppState>();
    let Ok(signal) = state.grid_signal.lock() else {
        return (0, 0);
    };
    (signal.start_seq, signal.idle_seq)
}

fn wait_for_start(
    app: &AppHandle,
    job_id: &str,
    tile_id: &str,
    after: u64,
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !is_running(app, job_id) {
            return false;
        }
        let state = app.state::<AppState>();
        if let Ok(signal) = state.grid_signal.lock() {
            if signal.start_seq > after && signal.start_tile == tile_id {
                return true;
            }
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(POLL_MS));
    }
}

fn wait_for_idle(
    app: &AppHandle,
    job_id: &str,
    tile_id: &str,
    after: u64,
    timeout: Duration,
) -> Option<String> {
    let deadline = Instant::now() + timeout;
    loop {
        if !is_running(app, job_id) {
            return None;
        }
        let state = app.state::<AppState>();
        if let Ok(signal) = state.grid_signal.lock() {
            // Only a real end-of-cell counts: `navigate`, `settings`, `cancel`
            // are stops that happen for other reasons. `no-results` means the
            // cell is empty and has nothing more to load; `drift` means the map
            // re-fitted itself away from the cell. `no-feed` ends the cell too —
            // waiting out the full idle timeout on a captcha page only makes the
            // grid burn two minutes per tile — but the runner counts it towards
            // the dead-page streak (P1-2).
            let reason_ok = is_cell_end(&signal.idle_reason);
            if signal.idle_seq > after && signal.idle_tile == tile_id && reason_ok {
                return Some(signal.idle_reason.clone());
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        thread::sleep(Duration::from_millis(POLL_MS));
    }
}

fn tile_url(keyword: &str, lat: f64, lng: f64, zoom: u8, locale_query: &str) -> String {
    format!(
        "https://www.google.com/maps/search/{}/@{:.6},{:.6},{}z?{}",
        crate::commands::encode_query(keyword),
        lat,
        lng,
        zoom,
        locale_query
    )
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// Parse a `maps:view` payload. Kept free of Tauri types so it stays testable.
pub fn parse_map_view(payload: &str) -> Option<MapView> {
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    let lat = value.get("lat")?.as_f64()?;
    let lng = value.get("lng")?.as_f64()?;
    if !lat.is_finite() || !lng.is_finite() || lat.abs() > 85.0 || lng.abs() > 180.0 {
        return None;
    }
    let zoom = value.get("zoom").and_then(|z| z.as_f64()).unwrap_or(15.0);
    Some(MapView {
        lat,
        lng,
        zoom: if zoom.is_finite() { zoom } else { 15.0 },
        at: now_ms(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scroll_budget_reaches_the_end_of_the_feed() {
        // Google caps one search at ~120 places = 6 batches of 20, and local
        // rows are interleaved across the whole window. The budget must always
        // reach that end, or small radii lose the tail of their own results.
        assert_eq!(max_scrolls_for_radius(0.5), 6);
        assert_eq!(max_scrolls_for_radius(1.5), 7);
        assert_eq!(max_scrolls_for_radius(3.0), 10);
        // Large radii keep a sane cap instead of the panel's 80, whose only
        // effect was walking the feed into districts the job never asked about.
        assert_eq!(max_scrolls_for_radius(30.0), 40);
        assert!(max_scrolls_for_radius(f64::NAN) > 0);
    }

    #[test]
    fn a_cell_ends_on_every_page_reason_but_not_on_a_switch_stop() {
        for reason in ["idle", "max-scrolls", "no-results", "no-feed", "drift"] {
            assert!(is_cell_end(reason), "{} must end a cell", reason);
        }
        // Stops that happen for other reasons: closing the cell here would make
        // Rust record a tile as done while the user is still toggling settings.
        for reason in ["navigate", "settings", "manual", "cancel", ""] {
            assert!(!is_cell_end(reason), "{} must not end a cell", reason);
        }
    }

    #[test]
    fn tile_rows_count_once_and_only_when_attributed() {
        let mut active = ActiveJob {
            job_id: "job-1".to_string(),
            current_tile: Some("job-1-t0".to_string()),
            received: 0,
            seen: std::collections::HashSet::new(),
        };

        // A late batch attributed to another job must not touch this counter.
        assert_eq!(
            count_new_ids(&mut active, "job-2", ["a"].into_iter()),
            0
        );
        assert_eq!(active.received, 0);

        // First sighting counts; a repeat of the same place id does not, and
        // neither does an empty id (a malformed row is not a place).
        assert_eq!(
            count_new_ids(&mut active, "job-1", ["a", "b", "a", ""].into_iter()),
            2
        );
        assert_eq!(active.received, 2);
        // A second batch re-sending the same rows is not new data.
        assert_eq!(
            count_new_ids(&mut active, "job-1", ["a", "b"].into_iter()),
            0
        );

        // Between tiles the slot has no tile: rows that arrive then are late.
        active.current_tile = None;
        assert_eq!(
            count_new_ids(&mut active, "job-1", ["c"].into_iter()),
            0
        );
    }

    #[test]
    fn only_a_live_empty_cell_is_not_dry() {
        // An empty area the page could actually show: a clean stop on a
        // working Maps document.
        assert!(!counts_as_dry(0, true, true, Some("no-results")));
        assert!(!counts_as_dry(0, true, true, Some("idle")));
        assert!(!counts_as_dry(5, true, true, Some("no-results")));

        // P1-2: the page never rendered a feed — a captcha, a consent screen or
        // a broken parser must count towards the dead-page streak even though
        // the cell ended "cleanly".
        assert!(counts_as_dry(0, true, true, Some("no-feed")));
        // A cell that started and never stopped is the old dead-page case.
        assert!(counts_as_dry(0, true, false, None));
        // A navigation that never even started the script.
        assert!(counts_as_dry(0, false, false, None));
    }

    #[test]
    fn tile_url_uses_the_search_path_and_encodes_keyword() {
        let url = tile_url("bed & breakfast", 34.0522, -118.2437, 16, "hl=en&gl=us");
        assert!(url.starts_with(
            "https://www.google.com/maps/search/bed+%26+breakfast/@34.052200,-118.243700,16z?hl=en&gl=us"
        ));
    }

    #[test]
    fn map_view_rejects_garbage() {
        assert!(parse_map_view("not json").is_none());
        assert!(parse_map_view(r#"{"lat":1.0}"#).is_none());
        assert!(parse_map_view(r#"{"lat":89,"lng":0}"#).is_none());
        assert!(parse_map_view(r#"{"lat":"34","lng":-118}"#).is_none());
    }

    #[test]
    fn map_view_accepts_a_report() {
        let view = parse_map_view(r#"{"lat":34.05,"lng":-118.24,"zoom":16,"url":"x"}"#).expect("view");
        assert!((view.lat - 34.05).abs() < 1e-9);
        assert!((view.zoom - 16.0).abs() < 1e-9);
        assert!(view.at > 0);
    }

    #[test]
    fn zoom_defaults_when_absent() {
        let view = parse_map_view(r#"{"lat":1,"lng":2}"#).expect("view");
        assert!((view.zoom - 15.0).abs() < 1e-9);
    }

    #[test]
    fn job_status_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&JobStatus::Cancelled).unwrap(),
            "\"cancelled\""
        );
        assert_eq!(JobStatus::Paused.as_str(), "paused");
        assert_eq!(JobStatus::Queued.as_str(), "queued");
    }

    /// P2-4: only a job that really finished may hand the queue to the next
    /// one. A stop that landed at the last tile must end the queue.
    #[test]
    fn only_terminal_jobs_continue_the_queue() {
        assert!(queue_continues("completed"));
        assert!(queue_continues("failed"));
        assert!(!queue_continues("paused"));
        assert!(!queue_continues("cancelled"));
        assert!(!queue_continues("running"));
        assert!(!queue_continues(""));
    }
}
