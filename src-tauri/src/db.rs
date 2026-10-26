use crate::logging::{log_debug, log_error, log_info, log_warn};
use crate::settings::{migrate, Settings};
use crate::{AboutEntry, Business, OpenHoursDay};
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Result, Transaction};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub fn init_database(db_path: &PathBuf) -> Result<Connection> {
    // Make sure the parent directory exists
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let conn = Connection::open(db_path)?;
    // R-15: the mining threads write while the panel reads through the same
    // connection mutex. WAL lets those writers commit without blocking the
    // readers' snapshots, busy_timeout absorbs the residual contention on the
    // file lock instead of surfacing random SQLITE_BUSY, and synchronous=NORMAL
    // is the standard pairing with WAL (consistent on power loss, no fsync per
    // commit). journal_mode returns its value, so read it back and log the
    // reality instead of assuming — an in-memory or legacy journal would say so.
    let journal_mode: String =
        conn.query_row("PRAGMA journal_mode = WAL;", [], |row| row.get(0))?;
    conn.execute_batch(
        "PRAGMA busy_timeout = 5000;
         PRAGMA synchronous = NORMAL;",
    )?;
    // Explicitly on: the tile rows are deleted with their job, and relying on
    // SQLite's default (off) would silently leave orphans behind.
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    log_debug!(
        "SQLite pragmas: journal_mode={}, busy_timeout=5000, synchronous=NORMAL, foreign_keys=ON",
        journal_mode
    );
    init_schema(&conn)?;
    // R-13: the undo snapshot now lives in `*_backup` tables, but the undo
    // window is in-memory (AppState) — a restart has no undo to offer, so
    // backups left behind by a crash are pure waste. `clear_data` also drops
    // them defensively before taking a new snapshot.
    conn.execute_batch(
        "DROP TABLE IF EXISTS businesses_backup;
         DROP TABLE IF EXISTS job_businesses_backup;",
    )?;
    Ok(conn)
}

/// Open the database, and if that is impossible, keep the app alive (R-06).
///
/// `lib.rs` used to `.expect()` straight into a panic: one corrupt file or one
/// failed `ALTER TABLE` and an app holding months of collected leads simply
/// refused to start, with the data still inside the broken file. The recovery
/// is deliberately boring: move the unusable file aside under a timestamped
/// name (never deleted, so nothing is lost), rebuild an empty database so the
/// app works, and only abort startup when even the rebuild fails — at that
/// point the error is environmental (locked file, full disk) and the caller
/// reports it instead of panicking.
///
/// Returns the connection and, when a backup was made, its path for logging.
/// The error is a formatted message (both failures), meant for the startup log.
pub fn open_with_recovery(
    db_path: &PathBuf,
) -> std::result::Result<(Connection, Option<PathBuf>), String> {
    match init_database(db_path) {
        Ok(conn) => Ok((conn, None)),
        Err(error) => {
            log_error!("database init failed: {}", error);
            let backup = backup_broken_database(db_path);
            match &backup {
                Some(path) => log_info!(
                    "original database preserved at {}",
                    crate::logging::redact_path(&path.to_string_lossy())
                ),
                None => log_info!(
                    "the original database could not be backed up; it is left in place"
                ),
            }
            let conn = init_database(db_path).map_err(|second| {
                format!(
                    "database init failed ({}) and the rebuilt attempt also failed ({})",
                    error, second
                )
            })?;
            Ok((conn, backup))
        }
    }
}

/// Move an unusable database file aside under `<name>.corrupt-<timestamp>` (R-06).
///
/// Rename keeps the original bytes under the new name; if rename is refused
/// (a locked file), a copy is taken instead and the original stays where it is,
/// which makes the caller's rebuild attempt fail loudly rather than overwrite.
/// Stale `-wal`/`-shm`/`-journal` sidecars from a crashed previous run are
/// moved with the main file, best effort — a fresh database must not inherit
/// them.
fn backup_broken_database(db_path: &PathBuf) -> Option<PathBuf> {
    let file_name = db_path.file_name()?.to_string_lossy().to_string();
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let backup = db_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join(format!("{}.corrupt-{}", file_name, stamp));

    let moved = match std::fs::rename(db_path, &backup) {
        Ok(()) => true,
        Err(_) => std::fs::copy(db_path, &backup).map(|_| ()).is_ok(),
    };
    if moved {
        for suffix in ["-wal", "-shm", "-journal"] {
            let sidecar = db_path
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .join(format!("{}{}", file_name, suffix));
            let sidecar_backup = db_path
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .join(format!("{}{}.corrupt-{}", file_name, suffix, stamp));
            let _ = std::fs::rename(&sidecar, &sidecar_backup);
        }
        Some(backup)
    } else {
        None
    }
}

/// The schema version this build knows how to produce. `PRAGMA user_version`
/// on the database records how far it has come; `init_schema` walks the
/// `MIGRATIONS` list from there (R-06).
const LATEST_SCHEMA_VERSION: i32 = 6;

type Migration = fn(&Connection) -> Result<()>;

/// Ordered migrations: entry `i` upgrades a database at version `i` to version
/// `i + 1`, each inside its own transaction together with the version stamp.
///
/// Adding a schema change means appending `migrate_vN_to_vNplus1` here — never
/// editing an older migration (applied databases would never see it) and never
/// touching the `CREATE TABLE` block alone (fresh installs would diverge:
/// they walk the same list from v0).
const MIGRATIONS: &[Migration] = &[
    migrate_v0_to_v1,
    migrate_v1_to_v2,
    migrate_v2_to_v3,
    migrate_v3_to_v4,
    migrate_v4_to_v5,
    migrate_v5_to_v6,
];

fn schema_version(conn: &Connection) -> Result<i32> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
}

/// The one sanctioned way to open a write transaction in this module (R-28).
///
/// `Connection::transaction` requires `&mut`, but every write path here takes
/// `&Connection` because the app serializes all database access through the
/// `Mutex<Connection>`; `unchecked_transaction` is the `&`-friendly equivalent
/// and skips rusqlite's borrow/nesting check. Nesting is therefore FORBIDDEN
/// by convention: a nested BEGIN makes SQLite fail with "cannot start a
/// transaction within a transaction" at runtime, which is the intended alarm.
/// Keep every BEGIN in this module going through this helper so the invariant
/// has exactly one place to live — and so a future switch to `&mut` signatures
/// is a one-function change.
fn write_tx(conn: &Connection) -> Result<Transaction<'_>> {
    conn.unchecked_transaction()
}

/// Bring a database to `LATEST_SCHEMA_VERSION`.
///
/// Split out of `init_database` so tests can run it against an in-memory
/// connection. Every database this app ever shipped is at v0 (the column had
/// no keeper before R-06), and fresh files start at v0 too, so migration 1
/// covers both: it is the historical full schema, idempotent by construction
/// (`IF NOT EXISTS` + `PRAGMA table_info`-guarded `ALTER`s).
pub fn init_schema(conn: &Connection) -> Result<()> {
    let current = schema_version(conn)?;
    if current >= LATEST_SCHEMA_VERSION {
        return Ok(());
    }
    for (index, migration) in MIGRATIONS.iter().enumerate() {
        let version = (index + 1) as i32;
        if version <= current {
            continue;
        }
        // One transaction per migration, with the version stamp inside it: a
        // crash mid-migration rolls the schema and the version back together,
        // so the next start retries from the same known state.
        let tx = write_tx(conn)?;
        migration(&tx)?;
        tx.execute_batch(&format!("PRAGMA user_version = {};", version))?;
        tx.commit()?;
        log_debug!("database migrated to schema v{}", version);
    }
    Ok(())
}

/// v0 → v1: the complete schema as it shipped through 2026-10.
fn migrate_v0_to_v1(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS businesses (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            place_id      TEXT UNIQUE NOT NULL,
            name          TEXT,
            address       TEXT,
            phone         TEXT,
            rating        REAL DEFAULT 0,
            reviews_total INTEGER DEFAULT 0,
            lat           REAL DEFAULT 0,
            lng           REAL DEFAULT 0,
            website       TEXT,
            types         TEXT,
            -- Which search and which job produced this row. Written from the
            -- batch metadata, not from the script payload: the script does not
            -- know the job id, the runner does.
            source_query  TEXT NOT NULL DEFAULT '',
            job_id        TEXT NOT NULL DEFAULT '',
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_place_id ON businesses(place_id);
        CREATE INDEX IF NOT EXISTS idx_name ON businesses(name);
        CREATE INDEX IF NOT EXISTS idx_rating ON businesses(rating DESC);
        -- M6: the panel sorts and filters in SQL, so these are the access paths
        -- it actually uses. `idx_name_nocase` matches the ORDER BY on name.
        -- The indexes on the new columns are created after `ensure_column`:
        -- putting them here would abort startup on a database created before
        -- those columns existed.
        CREATE INDEX IF NOT EXISTS idx_collected_at ON businesses(created_at);
        CREATE INDEX IF NOT EXISTS idx_name_nocase ON businesses(name COLLATE NOCASE);

        CREATE TABLE IF NOT EXISTS settings (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- One row per keyword x centre. `failed_tiles` is not in the roadmap
        -- draft: the panel already shows a failed count, and recomputing it from
        -- the tiles on every render would be a query per frame.
        CREATE TABLE IF NOT EXISTS search_jobs (
            id            TEXT PRIMARY KEY,
            keyword       TEXT NOT NULL,
            city          TEXT NOT NULL DEFAULT '',
            center_lat    REAL NOT NULL,
            center_lng    REAL NOT NULL,
            radius_km     REAL NOT NULL,
            cell_km       REAL NOT NULL,
            -- Result count that triggers a quadtree split (roadmap M4). A column
            -- rather than a setting: the same job replayed months later must
            -- subdivide exactly as it did the first time.
            split_threshold INTEGER NOT NULL DEFAULT 100,
            locale        TEXT NOT NULL DEFAULT 'en',
            status        TEXT NOT NULL,
            total_tiles   INTEGER NOT NULL DEFAULT 0,
            done_tiles    INTEGER NOT NULL DEFAULT 0,
            failed_tiles  INTEGER NOT NULL DEFAULT 0,
            inserted      INTEGER NOT NULL DEFAULT 0,
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_status ON search_jobs(status);

        CREATE TABLE IF NOT EXISTS search_tiles (
            id            TEXT PRIMARY KEY,
            job_id        TEXT NOT NULL REFERENCES search_jobs(id) ON DELETE CASCADE,
            seq           INTEGER NOT NULL,
            lat           REAL NOT NULL,
            lng           REAL NOT NULL,
            zoom          INTEGER NOT NULL DEFAULT 15,
            depth         INTEGER NOT NULL DEFAULT 0,
            status        TEXT NOT NULL,
            attempts      INTEGER NOT NULL DEFAULT 0,
            result_count  INTEGER NOT NULL DEFAULT 0,
            started_at    DATETIME,
            finished_at   DATETIME
        );

        CREATE INDEX IF NOT EXISTS idx_tiles_job ON search_tiles(job_id, seq);

        -- Which jobs have seen a business (T-01). `businesses` keeps one row per
        -- place_id; this table records every job that observed it, so a job's
        -- result view is not limited to the rows it happened to insert first.
        -- No FK on place_id: businesses rows must be allowed to outlive a job.
        CREATE TABLE IF NOT EXISTS job_businesses (
            job_id        TEXT NOT NULL REFERENCES search_jobs(id) ON DELETE CASCADE,
            place_id      TEXT NOT NULL,
            first_seen_at INTEGER NOT NULL,
            last_seen_at  INTEGER NOT NULL,
            times_seen    INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (job_id, place_id)
        );

        CREATE INDEX IF NOT EXISTS idx_job_businesses_place ON job_businesses(place_id);

        -- One row per execution of a task (P2). `base_found` is the membership
        -- count when the run started, so `new_count` can be computed at the end
        -- without touching the per-batch write path.
        CREATE TABLE IF NOT EXISTS task_runs (
            id           TEXT PRIMARY KEY,
            job_id       TEXT NOT NULL REFERENCES search_jobs(id) ON DELETE CASCADE,
            started_at   INTEGER NOT NULL,
            finished_at  INTEGER,
            status       TEXT NOT NULL,
            tiles_done   INTEGER NOT NULL DEFAULT 0,
            tiles_failed INTEGER NOT NULL DEFAULT 0,
            base_found   INTEGER NOT NULL DEFAULT 0,
            new_count    INTEGER NOT NULL DEFAULT 0,
            error        TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_task_runs_job ON task_runs(job_id, started_at DESC);",
    )?;

    // Columns added after their table shipped: `CREATE TABLE IF NOT EXISTS` does
    // not touch an existing table, so an upgrade needs an explicit ALTER.
    ensure_column(
        conn,
        "search_jobs",
        "split_threshold",
        "split_threshold INTEGER NOT NULL DEFAULT 100",
    )?;
    // T-03: a user-facing name. Rows created before this shipped are backfilled
    // below from keyword/city/time instead of being left blank in the picker.
    ensure_column(
        conn,
        "search_jobs",
        "name",
        "name TEXT NOT NULL DEFAULT ''",
    )?;
    // Jobs created by one submit share a batch id so the panel can collapse
    // "10 keywords in one city" into one row (T-03).
    ensure_column(
        conn,
        "search_jobs",
        "batch_id",
        "batch_id TEXT NOT NULL DEFAULT ''",
    )?;
    // P2: epoch ms of the last export of this task. 0 = never exported, which is
    // also what "only new rows" keys off.
    ensure_column(
        conn,
        "search_jobs",
        "last_exported_at",
        "last_exported_at INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        conn,
        "businesses",
        "source_query",
        "source_query TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        conn,
        "businesses",
        "job_id",
        "job_id TEXT NOT NULL DEFAULT ''",
    )?;
    // UI-03: epoch milliseconds of the first write. Kept as INTEGER rather than
    // reusing the legacy `created_at` DATETIME string so the panel can filter
    // with plain `>= since` comparisons and render in local time without
    // parsing a UTC string.
    ensure_column(
        conn,
        "businesses",
        "collected_at",
        "collected_at INTEGER NOT NULL DEFAULT 0",
    )?;
    // M7: mined contact data. `emails`/`socials` hold JSON arrays; a row that
    // was never mined keeps `email_status` empty, which is exactly how the
    // miner skips already-processed rows.
    ensure_column(conn, "businesses", "emails", "emails TEXT")?;
    ensure_column(conn, "businesses", "socials", "socials TEXT")?;
    ensure_column(
        conn,
        "businesses",
        "email_source_url",
        "email_source_url TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(conn, "businesses", "email_status", "email_status TEXT")?;
    ensure_column(
        conn,
        "businesses",
        "mined_at",
        "mined_at INTEGER NOT NULL DEFAULT 0",
    )?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_source_query ON businesses(source_query);
         CREATE INDEX IF NOT EXISTS idx_job_id ON businesses(job_id);
         CREATE INDEX IF NOT EXISTS idx_business_collected_at ON businesses(collected_at);
         CREATE INDEX IF NOT EXISTS idx_jobs_batch ON search_jobs(batch_id);",
    )?;

    // Backfill names once: the picker must not show blank entries after an
    // upgrade. `created_at` is the legacy UTC datetime string, good enough for a
    // developer-only backfill; new rows are named in the caller's local time.
    conn.execute_batch(
        "UPDATE search_jobs
            SET name = TRIM(keyword ||
                CASE WHEN city = '' THEN '' ELSE ' · ' || city END ||
                ' · ' || substr(created_at, 6, 11))
          WHERE name = '';",
    )?;

    // One-time backfill: rows written before UI-03 carry their real collection
    // time in the legacy `created_at` (UTC datetime string). Convert it so old
    // rows keep their place in "newest first" instead of sorting as unknown.
    // After the first run the `collected_at = 0` predicate is an index lookup,
    // so the statement is effectively free on every later startup.
    if has_column(conn, "businesses", "created_at")? {
        conn.execute_batch(
            "UPDATE businesses
             SET collected_at = CAST(strftime('%s', created_at) AS INTEGER) * 1000
             WHERE collected_at = 0 AND created_at IS NOT NULL;",
        )?;
    }
    Ok(())
}

/// v1 → v2: index cleanup and the missing access paths (R-16).
fn migrate_v1_to_v2(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        // `place_id TEXT UNIQUE` already maintains an implicit index; this
        // explicit twin only cost write throughput.
        "DROP INDEX IF EXISTS idx_place_id;

         -- refresh_job_counts runs three COUNT(*) subqueries per tile
         -- decision (no ORDER BY, pure counting): this composite is their
         -- access path. (next_pending_tile keeps idx_tiles_job on purpose --
         -- its ORDER BY seq makes (job_id, seq) the sort-free better plan.)
         CREATE INDEX IF NOT EXISTS idx_tiles_job_status
             ON search_tiles(job_id, status);
         -- Startup recovery and the list_jobs current-tile subquery look for
         -- running tiles across all jobs; the partial form keeps the index at
         -- a handful of live rows instead of one entry per tile.
         CREATE INDEX IF NOT EXISTS idx_tiles_running
             ON search_tiles(status) WHERE status = 'running';

         -- The contact filters and mining_targets only ever want rows that
         -- carry the datum, so the partial form stays proportional to real
         -- data instead of the whole table.
         CREATE INDEX IF NOT EXISTS idx_business_phone
             ON businesses(phone) WHERE phone <> '';
         CREATE INDEX IF NOT EXISTS idx_business_website
             ON businesses(website) WHERE website <> '';
         -- mining_targets without `force` only queues never-mined rows; the
         -- partial index turns their lookup into a bounded scan.
         CREATE INDEX IF NOT EXISTS idx_business_unmined
            ON businesses(id) WHERE (email_status IS NULL OR email_status = '');",
    )?;
    Ok(())
}

/// v2 → v3: the columns M8 / J-08c adds.
///
/// A **new** migration, not an edit to an older one: the list is walked from
/// the version stored in the database, so a column added to an already
/// applied migration would never reach an installed database — the write
/// would fail with "no such column" and every batch would be lost (R-06).
/// The fields are the ones the index probe confirmed as filled in the search
/// payload (`docs/parser.md`). `about` and `open_hours` hold JSON
/// arrays, like `types` and `emails` do; a row collected before this
/// migration keeps them empty.
fn migrate_v2_to_v3(conn: &Connection) -> Result<()> {
    ensure_column(conn, "businesses", "street", "street TEXT")?;
    ensure_column(conn, "businesses", "city", "city TEXT")?;
    ensure_column(conn, "businesses", "state", "state TEXT")?;
    ensure_column(conn, "businesses", "postal_code", "postal_code TEXT")?;
    ensure_column(conn, "businesses", "country", "country TEXT")?;
    ensure_column(conn, "businesses", "borough", "borough TEXT")?;
    ensure_column(conn, "businesses", "timezone", "timezone TEXT")?;
    ensure_column(conn, "businesses", "data_id", "data_id TEXT")?;
    ensure_column(conn, "businesses", "reviews_link", "reviews_link TEXT")?;
    ensure_column(conn, "businesses", "thumbnail", "thumbnail TEXT")?;
    ensure_column(conn, "businesses", "owner_name", "owner_name TEXT")?;
    ensure_column(conn, "businesses", "about", "about TEXT")?;
    ensure_column(conn, "businesses", "open_hours", "open_hours TEXT")?;
    Ok(())
}

/// M9 / J-09a: per-business review rows. One table, keyed by Google's own
/// review id; the business link is the panel's `place_id` (ChIJ), stamped by
/// Rust when the fetch was requested — the payload's own place field is a
/// different shape (`0x0:0x…`) and is kept only for reference.
fn migrate_v3_to_v4(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS business_reviews (
            review_id             TEXT PRIMARY KEY,
            place_id              TEXT NOT NULL,
            payload_place_id      TEXT,
            author                TEXT,
            author_avatar         TEXT,
            author_id             TEXT,
            author_link           TEXT,
            stars                 INTEGER,
            text                  TEXT,
            created_at_us         INTEGER,
            updated_at_us         INTEGER,
            relative_time         TEXT,
            owner_reply           TEXT,
            owner_reply_at_us     INTEGER,
            owner_reply_relative  TEXT,
            helpful_votes         INTEGER,
            photo_url             TEXT,
            report_url            TEXT,
            channel               TEXT,
            fetched_at            INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_business_reviews_place
            ON business_reviews(place_id);",
    )?;
    Ok(())
}

/// v4 → v5: the Tier-2 detail-enrichment columns (2026-10-26). The search
/// ingest never writes them — the enrichment runner fills them after a
/// place-page visit — so they default to empty on every row.
fn migrate_v4_to_v5(conn: &Connection) -> Result<()> {
    ensure_column(conn, "businesses", "plus_code", "plus_code TEXT")?;
    ensure_column(conn, "businesses", "description", "description TEXT")?;
    ensure_column(
        conn,
        "businesses",
        "reviews_per_rating",
        "reviews_per_rating TEXT",
    )?;
    ensure_column(conn, "businesses", "photos", "photos TEXT")?;
    Ok(())
}

/// v5 → v6: the per-tile failure reason (2026-10-26). A skipped or empty tile
/// carries one short code — `nav-failed` / `timeout` / `parse-empty` / `drift`
/// — so the task view can say *why* without digging through logs. Set on the
/// final failed state, cleared on a retry.
fn migrate_v5_to_v6(conn: &Connection) -> Result<()> {
    ensure_column(conn, "search_tiles", "error_reason", "error_reason TEXT")?;
    Ok(())
}

fn ensure_column(conn: &Connection, table: &str, column: &str, ddl: &str) -> Result<()> {
    if !has_column(conn, table, column)? {
        conn.execute(&format!("ALTER TABLE {} ADD COLUMN {}", table, ddl), [])?;
        log_debug!("migrated {}.{}", table, column);
    }
    Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let names: Vec<String> = rows.collect::<Result<Vec<_>>>()?;
    Ok(names.iter().any(|name| name == column))
}

// ---------------------------------------------------------------------------
// Reviews (M9)
// ---------------------------------------------------------------------------

/// One stored review. Field names are snake_case on the wire — the same
/// convention the `business-data` payload uses (`Business` carries no
/// `rename_all` either): the injected script emits these keys verbatim, and a
/// camelCase rename here would silently deserialize every field to empty
/// (measured, M9's first live fetch stored zero rows for exactly that reason).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ReviewRow {
    pub review_id: String,
    /// The panel's business key (ChIJ form), stamped by Rust.
    pub place_id: String,
    /// The payload's own place field (`0x0:0x…` shape), kept for reference.
    pub payload_place_id: String,
    pub author: String,
    pub author_avatar: String,
    pub author_id: String,
    pub author_link: String,
    pub stars: i64,
    pub text: String,
    pub created_at_us: i64,
    pub updated_at_us: i64,
    pub relative_time: String,
    pub owner_reply: String,
    pub owner_reply_at_us: i64,
    pub owner_reply_relative: String,
    pub helpful_votes: i64,
    pub photo_url: String,
    pub report_url: String,
    /// Which channel served it: `state_cache`, `reviews_link` or `qv9Egd`.
    pub channel: String,
    /// Rust-side fetch stamp, epoch ms.
    pub fetched_at: i64,
}

impl Default for ReviewRow {
    fn default() -> Self {
        Self {
            review_id: String::new(),
            place_id: String::new(),
            payload_place_id: String::new(),
            author: String::new(),
            author_avatar: String::new(),
            author_id: String::new(),
            author_link: String::new(),
            stars: 0,
            text: String::new(),
            created_at_us: 0,
            updated_at_us: 0,
            relative_time: String::new(),
            owner_reply: String::new(),
            owner_reply_at_us: 0,
            owner_reply_relative: String::new(),
            helpful_votes: 0,
            photo_url: String::new(),
            report_url: String::new(),
            channel: String::new(),
            fetched_at: 0,
        }
    }
}

/// The two columns a fetch needs before it can be requested: the reviews_link
/// URL (possibly empty — the featured-review channel needs it only as a
/// fallback) and the hex data_id the payload filters by.
pub fn business_review_sources(
    conn: &Connection,
    place_id: &str,
) -> Result<(String, String)> {
    let mut stmt =
        conn.prepare("SELECT reviews_link, data_id FROM businesses WHERE place_id = ?1")?;
    let row = stmt
        .query_row([place_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .optional()?;
    row.ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)
}

/// Store one place's reviews. `INSERT OR REPLACE` keyed by Google's review id:
/// a refetch replaces the row wholesale (the source of truth is the payload,
/// not an edit history).
pub fn insert_reviews(conn: &Connection, rows: &[ReviewRow]) -> Result<usize> {
    if rows.is_empty() {
        return Ok(0);
    }
    let tx = write_tx(conn)?;
    let mut inserted = 0usize;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO business_reviews
             (review_id, place_id, payload_place_id, author, author_avatar, author_id,
              author_link, stars, text, created_at_us, updated_at_us, relative_time,
              owner_reply, owner_reply_at_us, owner_reply_relative, helpful_votes,
              photo_url, report_url, channel, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        )?;
        for row in rows {
            if row.review_id.is_empty() || row.place_id.is_empty() {
                continue;
            }
            stmt.execute(params![
                row.review_id,
                row.place_id,
                row.payload_place_id,
                row.author,
                row.author_avatar,
                row.author_id,
                row.author_link,
                row.stars,
                row.text,
                row.created_at_us,
                row.updated_at_us,
                row.relative_time,
                row.owner_reply,
                row.owner_reply_at_us,
                row.owner_reply_relative,
                row.helpful_votes,
                row.photo_url,
                row.report_url,
                row.channel,
                row.fetched_at,
            ])?;
            inserted += 1;
        }
    }
    tx.commit()?;
    Ok(inserted)
}

/// A place's reviews, newest first (Google's relative time is displayed as-is;
/// the sort key is our fetch stamp, since `created_at_us` misses for reviews
/// whose payload omitted it).
pub fn list_reviews(conn: &Connection, place_id: &str) -> Result<Vec<ReviewRow>> {
    let mut stmt = conn.prepare(
        "SELECT review_id, place_id, payload_place_id, author, author_avatar, author_id,
                author_link, stars, text, created_at_us, updated_at_us, relative_time,
                owner_reply, owner_reply_at_us, owner_reply_relative, helpful_votes,
                photo_url, report_url, channel, fetched_at
         FROM business_reviews WHERE place_id = ?1
         ORDER BY created_at_us DESC, fetched_at DESC",
    )?;
    let rows = stmt
        .query_map([place_id], |row| {
            Ok(ReviewRow {
                review_id: row.get(0)?,
                place_id: row.get(1)?,
                payload_place_id: row.get(2)?,
                author: row.get(3)?,
                author_avatar: row.get(4)?,
                author_id: row.get(5)?,
                author_link: row.get(6)?,
                stars: row.get(7)?,
                text: row.get(8)?,
                created_at_us: row.get(9)?,
                updated_at_us: row.get(10)?,
                relative_time: row.get(11)?,
                owner_reply: row.get(12)?,
                owner_reply_at_us: row.get(13)?,
                owner_reply_relative: row.get(14)?,
                helpful_votes: row.get(15)?,
                photo_url: row.get(16)?,
                report_url: row.get(17)?,
                channel: row.get(18)?,
                fetched_at: row.get(19)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;
    Ok(rows)
}

/// One reviews-export row, flat and pre-formatted (M9). `business_name` comes
/// from the JOIN with `businesses`; a review whose business row was deleted
/// still exports (the name falls back to the place id).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewExportRow {
    pub business_name: String,
    pub place_id: String,
    pub review_id: String,
    pub author: String,
    pub stars: i64,
    /// Local `YYYY-MM-DD HH:mm` from `created_at_us`; blank when the payload
    /// omitted it.
    pub posted: String,
    pub relative_time: String,
    pub text: String,
    pub owner_reply: String,
    pub helpful_votes: i64,
    pub channel: String,
    /// Local `YYYY-MM-DD HH:mm` from our own fetch stamp.
    pub fetched_at: String,
}

/// Reviews for the export, optionally scoped to one place (`None` = all of
/// them). Business name first, newest first: a spreadsheet reads top-down.
pub fn reviews_for_export(
    conn: &Connection,
    place_id: Option<&str>,
) -> Result<Vec<ReviewExportRow>> {
    use chrono::{Local, TimeZone};

    let stamp = |us: i64| -> String {
        if us == 0 {
            return String::new();
        }
        // Microseconds → millis: the same local-time treatment the business
        // export gives `collected_at`.
        Local
            .timestamp_millis_opt(us.div_euclid(1000))
            .single()
            .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_default()
    };

    let mut stmt = conn.prepare(
        "SELECT b.name, r.place_id, r.review_id, r.author, r.stars, r.created_at_us,
                r.relative_time, r.text, r.owner_reply, r.helpful_votes, r.channel, r.fetched_at
         FROM business_reviews r
         LEFT JOIN businesses b ON b.place_id = r.place_id
         WHERE (?1 IS NULL OR r.place_id = ?1)
         ORDER BY b.name COLLATE NOCASE, r.created_at_us DESC",
    )?;
    let rows = stmt
        .query_map([place_id], |row| {
            let created_at_us: i64 = row.get(5)?;
            let place: Option<String> = row.get(0)?;
            let place_ref: String = row.get(1)?;
            Ok(ReviewExportRow {
                business_name: place.unwrap_or_else(|| place_ref.clone()),
                place_id: place_ref,
                review_id: row.get(2)?,
                author: row.get(3)?,
                stars: row.get(4)?,
                posted: stamp(created_at_us),
                relative_time: row.get(6)?,
                text: row.get(7)?,
                owner_reply: row.get(8)?,
                helpful_votes: row.get(9)?,
                channel: row.get(10)?,
                fetched_at: stamp(row.get(11)?),
            })
        })?
        .collect::<Result<Vec<_>>>()?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Area jobs (M3)
// ---------------------------------------------------------------------------

/// A job as the panel sees it. Field names are camelCase on the wire so the
/// TypeScript side does not have to rename anything.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRow {
    pub id: String,
    /// User-facing name; never empty for rows created after T-03.
    pub name: String,
    /// Shared by the jobs of one submit; empty for single-job requests.
    pub batch_id: String,
    pub keyword: String,
    pub city: String,
    pub center_lat: f64,
    pub center_lng: f64,
    pub radius_km: f64,
    pub cell_km: f64,
    /// Result count per tile that triggers a quadtree split.
    pub split_threshold: i64,
    pub locale: String,
    pub status: String,
    pub total_tiles: i64,
    pub done_tiles: i64,
    pub failed_tiles: i64,
    /// Rows this job actually inserted (duplicates skipped), bumped by the
    /// `business-data` listener.
    pub inserted: i64,
    /// Places attributed to this job (T-01). Unlike `inserted`, this counts a
    /// place another job stored first, which is what the list should show.
    pub found_count: i64,
    /// Epoch ms of the last export of this task; `0` = never exported (P2).
    pub last_exported_at: i64,
    /// Tile currently being scrolled, resolved from `search_tiles`.
    pub current_tile: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TileRow {
    pub id: String,
    pub seq: i64,
    pub lat: f64,
    pub lng: f64,
    pub zoom: u8,
    /// Quadtree depth: 0 for the initial grid, +1 per split.
    pub depth: i64,
    pub status: String,
    pub attempts: i64,
    pub result_count: i64,
    /// Why a tile did not produce data: `nav-failed` / `timeout` /
    /// `parse-empty` / `drift`. `None` on success and on queued work.
    pub error_reason: Option<String>,
}

pub struct NewJob<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub batch_id: &'a str,
    pub keyword: &'a str,
    pub city: &'a str,
    pub center_lat: f64,
    pub center_lng: f64,
    pub radius_km: f64,
    pub cell_km: f64,
    pub split_threshold: i64,
    pub locale: &'a str,
}

pub struct NewTile {
    pub id: String,
    pub seq: u32,
    pub lat: f64,
    pub lng: f64,
    pub zoom: u8,
}

/// One quadrant produced by `split_tile`.
pub struct ChildTile {
    pub seq: u32,
    pub lat: f64,
    pub lng: f64,
    pub zoom: u8,
    pub depth: i64,
}

/// The job row plus the tile it is currently scrolling, read in one query so
/// `list_jobs` cannot report a stale current tile.
const JOB_SELECT: &str = "SELECT j.id, j.name, j.batch_id, j.keyword, j.city, j.center_lat,
        j.center_lng, j.radius_km, j.cell_km, j.split_threshold, j.locale, j.status,
        j.total_tiles, j.done_tiles, j.failed_tiles, j.inserted,
        (SELECT t.id FROM search_tiles t WHERE t.job_id = j.id AND t.status = 'running' LIMIT 1),
        (SELECT COUNT(*) FROM job_businesses jb WHERE jb.job_id = j.id),
        j.last_exported_at,
        j.created_at
     FROM search_jobs j";

fn map_job(row: &rusqlite::Row<'_>) -> Result<JobRow> {
    Ok(JobRow {
        id: row.get(0)?,
        name: row.get(1)?,
        batch_id: row.get(2)?,
        keyword: row.get(3)?,
        city: row.get(4)?,
        center_lat: row.get(5)?,
        center_lng: row.get(6)?,
        radius_km: row.get(7)?,
        cell_km: row.get(8)?,
        split_threshold: row.get(9)?,
        locale: row.get(10)?,
        status: row.get(11)?,
        total_tiles: row.get(12)?,
        done_tiles: row.get(13)?,
        failed_tiles: row.get(14)?,
        inserted: row.get(15)?,
        current_tile: row.get(16)?,
        found_count: row.get(17)?,
        last_exported_at: row.get(18)?,
        created_at: row.get(19)?,
    })
}

fn map_tile(row: &rusqlite::Row<'_>) -> Result<TileRow> {
    Ok(TileRow {
        id: row.get(0)?,
        seq: row.get(1)?,
        lat: row.get(2)?,
        lng: row.get(3)?,
        zoom: row.get::<_, i64>(4)?.clamp(0, 25) as u8,
        depth: row.get(5)?,
        status: row.get(6)?,
        attempts: row.get(7)?,
        result_count: row.get(8)?,
        error_reason: row.get(9)?,
    })
}

/// Insert a job and its tiles atomically: a job without tiles would look like a
/// finished queue entry and never run.
pub fn insert_job(conn: &Connection, job: &NewJob, tiles: &[NewTile]) -> Result<()> {
    let tx = write_tx(conn)?;
    tx.execute(
        "INSERT INTO search_jobs
            (id, name, batch_id, keyword, city, center_lat, center_lng, radius_km, cell_km,
             split_threshold, locale, status, total_tiles)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'queued', ?12)",
        rusqlite::params![
            job.id,
            job.name,
            job.batch_id,
            job.keyword,
            job.city,
            job.center_lat,
            job.center_lng,
            job.radius_km,
            job.cell_km,
            job.split_threshold,
            job.locale,
            tiles.len() as i64
        ],
    )?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO search_tiles (id, job_id, seq, lat, lng, zoom, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending')",
        )?;
        for tile in tiles {
            stmt.execute(rusqlite::params![
                tile.id,
                job.id,
                tile.seq,
                tile.lat,
                tile.lng,
                tile.zoom
            ])?;
        }
    }
    tx.commit()
}

pub fn list_jobs(conn: &Connection) -> Result<Vec<JobRow>> {
    let sql = format!("{} ORDER BY j.rowid DESC", JOB_SELECT);
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], map_job)?;
    rows.collect()
}

pub fn load_job(conn: &Connection, id: &str) -> Result<Option<JobRow>> {
    let sql = format!("{} WHERE j.id = ?1", JOB_SELECT);
    conn.query_row(&sql, [id], map_job).optional()
}

pub fn next_queued_job(conn: &Connection) -> Result<Option<JobRow>> {
    let sql = format!("{} WHERE j.status = 'queued' ORDER BY j.rowid ASC LIMIT 1", JOB_SELECT);
    conn.query_row(&sql, [], map_job).optional()
}

/// The job currently driving the map, if any. Single-flight means at most one.
pub fn running_job_id(conn: &Connection) -> Result<Option<String>> {
    conn.query_row(
        "SELECT id FROM search_jobs WHERE status = 'running' ORDER BY rowid ASC LIMIT 1",
        [],
        |row| row.get(0),
    )
    .optional()
}

pub fn next_pending_tile(conn: &Connection, job_id: &str) -> Result<Option<TileRow>> {
    conn.query_row(
        "SELECT id, seq, lat, lng, zoom, depth, status, attempts, result_count, error_reason
         FROM search_tiles WHERE job_id = ?1 AND status = 'pending'
         ORDER BY seq ASC LIMIT 1",
        [job_id],
        map_tile,
    )
    .optional()
}

pub fn job_tiles(conn: &Connection, job_id: &str) -> Result<Vec<TileRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, seq, lat, lng, zoom, depth, status, attempts, result_count, error_reason
         FROM search_tiles WHERE job_id = ?1 ORDER BY seq ASC",
    )?;
    let rows = stmt.query_map([job_id], map_tile)?;
    rows.collect()
}

pub fn set_job_status(conn: &Connection, id: &str, status: &str) -> Result<usize> {
    conn.execute(
        "UPDATE search_jobs SET status = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        rusqlite::params![id, status],
    )
}

/// Rename a job (T-03). The panel is the only writer; an empty name is rejected
/// by the command so the picker never shows a blank entry.
pub fn rename_job(conn: &Connection, id: &str, name: &str) -> Result<usize> {
    conn.execute(
        "UPDATE search_jobs SET name = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        rusqlite::params![id, name],
    )
}

pub fn mark_tile_running(conn: &Connection, tile_id: &str) -> Result<usize> {
    conn.execute(
        "UPDATE search_tiles SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?1",
        [tile_id],
    )
}

/// Retry accounting for one tile outcome.
///
/// `pending` + an incremented attempt means "the runner will pick it again"; the
/// caller stops doing that once `TILE_MAX_ATTEMPTS` is reached.
pub fn finish_tile(
    conn: &Connection,
    tile_id: &str,
    status: &str,
    result_count: i64,
    attempts: i64,
    error_reason: Option<&str>,
) -> Result<usize> {
    if status == "pending" {
        // Retry queued: clear the bookkeeping so a resume sees a clean tile.
        conn.execute(
            "UPDATE search_tiles SET status = 'pending', attempts = ?2, result_count = ?3,
                 started_at = NULL, finished_at = NULL, error_reason = NULL WHERE id = ?1",
            rusqlite::params![tile_id, attempts, result_count],
        )
    } else {
        conn.execute(
            "UPDATE search_tiles SET status = ?2, attempts = ?3, result_count = ?4,
                 error_reason = ?5, finished_at = CURRENT_TIMESTAMP WHERE id = ?1",
            rusqlite::params![tile_id, status, attempts, result_count, error_reason],
        )
    }
}

/// Recompute the progress counters from the tiles, so a retry or a resume can
/// never double-count.
///
/// `total_tiles` is the *leaf* count (roadmap M4 / J-04c): a tile that split is
/// an interior node and its four children carry the remaining work. Counting
/// interior nodes would make the progress bar jump backwards every time a dense
/// cell is subdivided.
pub fn refresh_job_counts(conn: &Connection, job_id: &str, status: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE search_jobs SET
            total_tiles = (SELECT COUNT(*) FROM search_tiles
                           WHERE job_id = ?1 AND status <> 'split'),
            done_tiles = (SELECT COUNT(*) FROM search_tiles
                          WHERE job_id = ?1 AND status IN ('done', 'empty')),
            failed_tiles = (SELECT COUNT(*) FROM search_tiles
                            WHERE job_id = ?1 AND status = 'skipped'),
            status = COALESCE(?2, status),
            updated_at = CURRENT_TIMESTAMP
         WHERE id = ?1",
        rusqlite::params![job_id, status],
    )?;
    Ok(())
}

/// Subdivide a dense tile in one transaction (roadmap M4 / J-04a).
///
/// The parent becomes `split`, the pending queue shifts by `children.len()` and
/// the four children are inserted in the freed sequence numbers, so they run
/// immediately after the cell that produced them instead of at the end of the
/// job. Atomic on purpose: a crash between "mark split" and "insert children"
/// would silently lose that part of the area.
///
/// Returns 0 when the tile was already split or no longer running/pending, which
/// makes a retried call harmless.
pub fn split_tile(
    conn: &Connection,
    job_id: &str,
    parent_id: &str,
    parent_seq: i64,
    result_count: i64,
    children: &[ChildTile],
) -> Result<usize> {
    if children.is_empty() {
        return Ok(0);
    }
    let tx = write_tx(conn)?;
    let marked = tx.execute(
        "UPDATE search_tiles SET status = 'split', result_count = ?3,
             finished_at = CURRENT_TIMESTAMP
         WHERE id = ?1 AND job_id = ?2 AND status IN ('running', 'pending')",
        rusqlite::params![parent_id, job_id, result_count],
    )?;
    if marked == 0 {
        return Ok(0);
    }

    tx.execute(
        "UPDATE search_tiles SET seq = seq + ?3
         WHERE job_id = ?1 AND seq > ?2 AND status = 'pending'",
        rusqlite::params![job_id, parent_seq, children.len() as i64],
    )?;

    {
        let mut stmt = tx.prepare(
            "INSERT INTO search_tiles (id, job_id, seq, lat, lng, zoom, depth, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending')",
        )?;
        for (index, child) in children.iter().enumerate() {
            // Child ids hang off the parent, not the sequence number: the shift
            // above changes the seq of existing tiles but cannot rename them, so
            // `{job}-t{seq}` would collide with a tile that just moved.
            stmt.execute(rusqlite::params![
                format!("{}-q{}", parent_id, index),
                job_id,
                child.seq,
                child.lat,
                child.lng,
                child.zoom,
                child.depth
            ])?;
        }
    }

    tx.commit()?;
    Ok(marked)
}

pub fn bump_job_inserted(conn: &Connection, job_id: &str, inserted: usize) -> Result<usize> {
    conn.execute(
        "UPDATE search_jobs SET inserted = inserted + ?2, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?1",
        rusqlite::params![job_id, inserted as i64],
    )
}

/// A tile left `running` by a crash is unknown: it goes back to `pending` and
/// will be re-scrolled. Rows are deduped by `place_id`, so the redo is free.
pub fn reset_running_tiles(conn: &Connection, job_id: &str) -> Result<usize> {
    conn.execute(
        "UPDATE search_tiles SET status = 'pending', started_at = NULL
         WHERE job_id = ?1 AND status = 'running'",
        [job_id],
    )
}

/// Startup recovery: a `running` job cannot still be running, the process that
/// owned it is gone. Downgrade to `paused` so the panel can offer "resume".
pub fn recover_interrupted_jobs(conn: &Connection) -> Result<usize> {
    let jobs = conn.execute(
        "UPDATE search_jobs SET status = 'paused', updated_at = CURRENT_TIMESTAMP
         WHERE status = 'running'",
        [],
    )?;
    conn.execute(
        "UPDATE search_tiles SET status = 'pending', started_at = NULL WHERE status = 'running'",
        [],
    )?;
    Ok(jobs)
}

/// How many places a job would take with it: `exclusive` are seen only by this
/// job, `shared` are also attributed to at least one other job (T-10).
pub fn job_delete_preview(conn: &Connection, id: &str) -> Result<(i64, i64)> {
    conn.query_row(
        "SELECT
            COALESCE(SUM(CASE WHEN (SELECT COUNT(*) FROM job_businesses p
                                 WHERE p.place_id = jb.place_id) = 1 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN (SELECT COUNT(*) FROM job_businesses p
                                 WHERE p.place_id = jb.place_id) > 1 THEN 1 ELSE 0 END), 0)
           FROM job_businesses jb
          WHERE jb.job_id = ?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
}

/// Delete a job, its tiles and its attribution rows.
///
/// `delete_exclusive` also removes the business entities no other job has seen.
/// Shared entities always stay: another task's list would silently lose rows
/// otherwise. Returns `(jobs_removed, businesses_removed)`.
pub fn delete_job(
    conn: &Connection,
    id: &str,
    delete_exclusive: bool,
) -> Result<(usize, usize)> {
    let tx = write_tx(conn)?;
    // Runs before the job row goes: once the attribution rows cascade away the
    // "seen only by this job" predicate has nothing left to match.
    let removed_businesses = if delete_exclusive {
        tx.execute(
            "DELETE FROM businesses WHERE place_id IN (
                 SELECT jb.place_id FROM job_businesses jb
                  WHERE jb.job_id = ?1
                    AND (SELECT COUNT(*) FROM job_businesses p
                          WHERE p.place_id = jb.place_id) = 1)",
            [id],
        )?
    } else {
        0
    };
    tx.execute("DELETE FROM search_tiles WHERE job_id = ?1", [id])?;
    let removed_jobs = tx.execute("DELETE FROM search_jobs WHERE id = ?1", [id])?;
    tx.commit()?;
    Ok((removed_jobs, removed_businesses))
}

/// Load the single `key = 'app'` row.
///
/// A missing row is normal (first launch). A corrupt row is not: it is reported
/// back so the caller can surface it in the diagnostics drawer, instead of
/// silently resetting every preference with no trace.
pub fn load_settings(conn: &Connection) -> (Settings, Option<String>) {
    let raw = conn
        .query_row("SELECT value FROM settings WHERE key = 'app'", [], |row| {
            row.get::<_, String>(0)
        })
        .ok();

    let Some(raw) = raw else {
        return (Settings::default().normalized(), None);
    };

    let mut value = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(value) => value,
        Err(e) => {
            return (
                Settings::default().normalized(),
                Some(format!("Corrupted settings row, falling back to defaults: {}", e)),
            )
        }
    };

    migrate(&mut value);

    match serde_json::from_value::<Settings>(value) {
        Ok(settings) => (settings.normalized(), None),
        Err(e) => (
            Settings::default().normalized(),
            Some(format!("Failed to parse stored settings: {}", e)),
        ),
    }
}

pub fn save_settings(conn: &Connection, settings: &Settings) -> Result<()> {
    // Never `unwrap_or_default()` here: a serialization failure would write an
    // empty string, and the next load would reset every setting to its default.
    let raw = serde_json::to_string(settings)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES ('app', ?1, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
        [raw],
    )?;
    Ok(())
}

fn row_to_business(row: &rusqlite::Row<'_>) -> Result<Business> {
    let types_raw: Option<String> = row.get(9)?;
    Ok(Business {
        place_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
        name: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        address: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        phone: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        rating: row.get::<_, Option<f64>>(4)?.unwrap_or(0.0),
        reviews_total: row.get::<_, Option<i64>>(5)?.unwrap_or(0).max(0) as u32,
        lat: row.get::<_, Option<f64>>(6)?.unwrap_or(0.0),
        lng: row.get::<_, Option<f64>>(7)?.unwrap_or(0.0),
        website: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
        types: types_raw
            .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
            .unwrap_or_default(),
        source_query: row.get::<_, Option<String>>(10)?.unwrap_or_default(),
        collected_at: row.get::<_, Option<i64>>(11)?.unwrap_or(0).max(0) as u64,
        emails: parse_string_array(row.get::<_, Option<String>>(12)?),
        socials: parse_string_array(row.get::<_, Option<String>>(13)?),
        email_source_url: row.get::<_, Option<String>>(14)?.unwrap_or_default(),
        email_status: row.get::<_, Option<String>>(15)?.unwrap_or_default(),
        mined_at: row.get::<_, Option<i64>>(16)?.unwrap_or(0).max(0) as u64,
        // M8 / J-08c
        street: row.get::<_, Option<String>>(17)?.unwrap_or_default(),
        city: row.get::<_, Option<String>>(18)?.unwrap_or_default(),
        state: row.get::<_, Option<String>>(19)?.unwrap_or_default(),
        postal_code: row.get::<_, Option<String>>(20)?.unwrap_or_default(),
        country: row.get::<_, Option<String>>(21)?.unwrap_or_default(),
        borough: row.get::<_, Option<String>>(22)?.unwrap_or_default(),
        timezone: row.get::<_, Option<String>>(23)?.unwrap_or_default(),
        data_id: row.get::<_, Option<String>>(24)?.unwrap_or_default(),
        reviews_link: row.get::<_, Option<String>>(25)?.unwrap_or_default(),
        thumbnail: row.get::<_, Option<String>>(26)?.unwrap_or_default(),
        owner_name: row.get::<_, Option<String>>(27)?.unwrap_or_default(),
        about: parse_about(row.get::<_, Option<String>>(28)?),
        open_hours: parse_open_hours(row.get::<_, Option<String>>(29)?),
        // Tier-2 detail enrichment
        plus_code: row.get::<_, Option<String>>(30)?.unwrap_or_default(),
        description: row.get::<_, Option<String>>(31)?.unwrap_or_default(),
        reviews_per_rating: parse_u32_array(row.get::<_, Option<String>>(32)?),
        photos: parse_string_array(row.get::<_, Option<String>>(33)?),
    })
}

/// The about block, stored as a JSON array of label/value pairs (M8 / J-08c).
fn parse_about(raw: Option<String>) -> Vec<AboutEntry> {
    raw.and_then(|text| serde_json::from_str::<Vec<AboutEntry>>(&text).ok())
        .unwrap_or_default()
}

/// Opening hours, stored as a JSON array of day/period pairs (M8 / J-08c).
fn parse_open_hours(raw: Option<String>) -> Vec<OpenHoursDay> {
    raw.and_then(|text| serde_json::from_str::<Vec<OpenHoursDay>>(&text).ok())
        .unwrap_or_default()
}

/// A JSON string array column (`emails`/`socials`); anything broken or NULL
/// reads as empty so a corrupt write can never break a whole page load.
fn parse_string_array(raw: Option<String>) -> Vec<String> {
    raw.and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
        .unwrap_or_default()
}

/// A JSON number array column (`reviews_per_rating`); same tolerance.
fn parse_u32_array(raw: Option<String>) -> Vec<u32> {
    raw.and_then(|text| serde_json::from_str::<Vec<u32>>(&text).ok())
        .unwrap_or_default()
}

/// Persist the outcome of one site visit (M7). `emails`/`socials` are stored
/// as JSON arrays (`[]` when empty, so exports never see NULL). One visit can
/// cover several rows: two businesses sharing a website domain are mined once.
///
/// R-22: an empty result (re-mined site now answers "none-found" or the site
/// turned unfetchable) must not wipe what an earlier run had already found.
/// The write is therefore conditional: mined fields are only overwritten by a
/// *non-empty* result, and a row whose status is `found` keeps that status
/// together with its data. First-time rows (and rows already in an
/// empty-result state) still get the new status, so the miner stays
/// idempotent — a visited site is never queued again without `force`.
/// Persist one place's Tier-2 detail enrichment. Only the four detail columns
/// are touched — a re-collection (duplicate-strategy update) keeps them, and a
/// second enrichment simply replaces them.
pub fn update_business_details(
    conn: &Connection,
    place_id: &str,
    plus_code: &str,
    description: &str,
    reviews_per_rating: &[u32],
    photos: &[String],
) -> Result<()> {
    let rating_json =
        serde_json::to_string(reviews_per_rating).unwrap_or_else(|_| "[]".to_string());
    let photos_json = serde_json::to_string(photos).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "UPDATE businesses
         SET plus_code         = ?2,
             description       = ?3,
             reviews_per_rating = ?4,
             photos            = ?5
         WHERE place_id = ?1",
        rusqlite::params![place_id, plus_code, description, rating_json, photos_json],
    )?;
    Ok(())
}

pub fn update_email_mining(
    conn: &Connection,
    place_ids: &[String],
    emails: &[String],
    socials: &[String],
    source_url: &str,
    status: &str,
) -> Result<()> {
    let emails_json = serde_json::to_string(emails).unwrap_or_else(|_| "[]".to_string());
    let socials_json = serde_json::to_string(socials).unwrap_or_else(|_| "[]".to_string());
    let tx = write_tx(conn)?;
    {
        let mut stmt = tx.prepare(
            "UPDATE businesses
             SET emails            = CASE WHEN ?1 <> '[]' THEN ?1 ELSE emails END,
                 socials           = CASE WHEN ?2 <> '[]' THEN ?2 ELSE socials END,
                 email_source_url  = CASE WHEN ?1 <> '[]' THEN ?3 ELSE email_source_url END,
                 email_status      = CASE
                     WHEN ?1 <> '[]' OR ?2 <> '[]' THEN ?4
                     WHEN email_status = 'found' THEN email_status
                     ELSE ?4 END,
                 mined_at          = ?5
             WHERE place_id = ?6",
        )?;
        for place_id in place_ids {
            stmt.execute(rusqlite::params![
                emails_json,
                socials_json,
                source_url,
                status,
                now_i64(),
                place_id,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// `(place_id, website)` pairs the miner should visit (M7).
///
/// Scope is an explicit id list or a browse filter — the same two scopes the
/// export paths use. Empty-website rows are excluded here, as are already
/// mined rows (`email_status` set) unless `force`. Domain grouping happens in
/// the miner: several rows can share one website.
pub fn mining_targets(
    conn: &Connection,
    ids: Option<&[String]>,
    filter: Option<&BusinessFilter>,
    force: bool,
) -> Result<Vec<(String, String)>> {
    let mut conditions: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();

    if let Some(ids) = ids {
        // Chunked OR-groups keep the bound-variable count comfortably below
        // SQLITE_MAX_VARIABLE_NUMBER even for "select everything" runs.
        let mut groups: Vec<String> = Vec::new();
        for chunk in ids.chunks(400) {
            let marks = vec!["?"; chunk.len()].join(", ");
            for id in chunk {
                values.push(Value::Text(id.clone()));
            }
            groups.push(format!("place_id IN ({})", marks));
        }
        conditions.push(format!("({})", groups.join(" OR ")));
    }
    if let Some(filter) = filter {
        let clause = build_where(filter, &mut values);
        let trimmed = clause.trim_start_matches(" WHERE ").trim().to_string();
        if !trimmed.is_empty() {
            conditions.push(trimmed);
        }
    }
    if !force {
        conditions.push("(email_status IS NULL OR email_status = '')".to_string());
    }
    // Plain `website <> ''` instead of the old TRIM(COALESCE(...)): NULL and
    // blank rows are excluded either way, a whitespace-only site reaches the
    // Rust side and is skipped there after trimming — and the plain form is
    // exactly the predicate of idx_business_website, so the partial index
    // actually serves this query (R-16).
    conditions.push("website <> ''".to_string());

    let where_sql = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let sql = format!(
        "SELECT place_id, website FROM businesses{} ORDER BY id ASC",
        where_sql
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?.trim().to_string(),
        ))
    })?;
    let mut targets: Vec<(String, String)> = Vec::new();
    for row in rows {
        let (place_id, website) = row?;
        if !website.is_empty() {
            targets.push((place_id, website));
        }
    }
    Ok(targets)
}

/// Insert one batch. Returns how many rows were new, which is what the job's
/// `inserted` counter and the diagnostics "new records" figure report.
///
/// The upsert path cannot tell an insert from an update through `changes()`, so
/// it checks existence first; batches are small enough for the extra query.
pub fn insert_businesses(
    conn: &Connection,
    rows: &[Business],
    source_query: &str,
    job_id: &str,
    update_duplicates: bool,
) -> Result<usize> {
    if rows.is_empty() {
        return Ok(0);
    }
    let tx = write_tx(conn)?;
    let sql = if update_duplicates {
        // `collected_at` is deliberately absent from DO UPDATE SET: a refreshed
        // row keeps its first-collection time (UI-03), while `source_query`
        // follows the latest search that produced it.
        "INSERT INTO businesses
         (place_id, name, address, phone, rating, reviews_total, lat, lng, website, types,
          source_query, job_id, collected_at,
          street, city, state, postal_code, country, borough, timezone, data_id,
          reviews_link, thumbnail, owner_name, about, open_hours)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)
         ON CONFLICT(place_id) DO UPDATE SET
            name          = excluded.name,
            address       = excluded.address,
            phone         = excluded.phone,
            rating        = excluded.rating,
            reviews_total = excluded.reviews_total,
            lat           = excluded.lat,
            lng           = excluded.lng,
            website       = excluded.website,
            types         = excluded.types,
            source_query  = excluded.source_query,
            street        = excluded.street,
            city          = excluded.city,
            state         = excluded.state,
            postal_code   = excluded.postal_code,
            country       = excluded.country,
            borough       = excluded.borough,
            timezone      = excluded.timezone,
            data_id       = excluded.data_id,
            reviews_link  = excluded.reviews_link,
            thumbnail     = excluded.thumbnail,
            owner_name    = excluded.owner_name,
            about         = excluded.about,
            open_hours    = excluded.open_hours"
    } else {
        "INSERT OR IGNORE INTO businesses
         (place_id, name, address, phone, rating, reviews_total, lat, lng, website, types,
          source_query, job_id, collected_at,
          street, city, state, postal_code, country, borough, timezone, data_id,
          reviews_link, thumbnail, owner_name, about, open_hours)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)"
    };

    // T-01: the attribution row. Upsert, not insert: a re-run refreshes
    // `last_seen_at` and bumps the counter, and a place another job stored
    // earlier still gets its own row here.
    let link_sql = "INSERT INTO job_businesses
            (job_id, place_id, first_seen_at, last_seen_at, times_seen)
         VALUES (?1, ?2, ?3, ?4, 1)
         ON CONFLICT(job_id, place_id) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            times_seen   = times_seen + 1";

    let mut inserted = 0usize;
    {
        let mut exists = tx.prepare("SELECT 1 FROM businesses WHERE place_id = ?1")?;
        let mut stmt = tx.prepare(sql)?;
        let mut link = tx.prepare(link_sql)?;
        for row in rows {
            let was_known = if update_duplicates {
                exists
                    .query_row([&row.place_id], |_| Ok(()))
                    .optional()?
                    .is_some()
            } else {
                false
            };
            let types_json =
                serde_json::to_string(&row.types).unwrap_or_else(|_| "[]".to_string());
            // M8 / J-08c: the two JSON columns, same shape as `types`.
            let about_json =
                serde_json::to_string(&row.about).unwrap_or_else(|_| "[]".to_string());
            let open_hours_json =
                serde_json::to_string(&row.open_hours).unwrap_or_else(|_| "[]".to_string());
            // The batch metadata is the fallback; a per-row value (not sent by
            // the script today) wins when present.
            let source = if row.source_query.is_empty() {
                source_query
            } else {
                row.source_query.as_str()
            };
            let collected = row.collected_at.min(i64::MAX as u64) as i64;
            let changed = stmt.execute(rusqlite::params![
                row.place_id,
                row.name,
                row.address,
                row.phone,
                row.rating,
                row.reviews_total,
                row.lat,
                row.lng,
                row.website,
                types_json,
                source,
                job_id,
                collected,
                row.street,
                row.city,
                row.state,
                row.postal_code,
                row.country,
                row.borough,
                row.timezone,
                row.data_id,
                row.reviews_link,
                row.thumbnail,
                row.owner_name,
                about_json,
                open_hours_json,
            ])?;
            // A batch from a job that was deleted while it was in flight would
            // otherwise abort the whole write through the foreign key; the link
            // is the only thing worth losing here.
            if !job_id.is_empty() {
                if let Err(error) =
                    link.execute(rusqlite::params![job_id, row.place_id, collected, collected])
                {
                    log_warn!(
                        "job link skipped for {}: {}",
                        crate::logging::redact_place_id(&row.place_id),
                        error
                    );
                }
            }
            if !update_duplicates && changed > 0 {
                inserted += 1;
            } else if update_duplicates && !was_known && changed > 0 {
                inserted += 1;
            }
        }
    }
    tx.commit()?;
    Ok(inserted)
}

/// Snapshot the live tables and clear them in ONE transaction (R-13).
///
/// The undo snapshot used to be three full-table reads materialised as Rust
/// structures — hundreds of MB at 100k rows, held under the db mutex for the
/// whole load. SQLite does the copying now: the rows land in `*_backup` tables
/// inside the database itself, so the Rust heap stays flat regardless of size.
/// Returns how many rows were captured; zero means there was nothing to undo.
pub fn snapshot_for_clear(conn: &Connection) -> Result<usize> {
    let tx = write_tx(conn)?;
    // A second clear inside the undo window replaces the snapshot; the old
    // backup tables must go first, or the copy would snapshot the empty table.
    tx.execute_batch(
        "DROP TABLE IF EXISTS businesses_backup;
         DROP TABLE IF EXISTS job_businesses_backup;",
    )?;
    let rows: i64 = tx.query_row("SELECT COUNT(*) FROM businesses", [], |row| row.get(0))?;
    if rows > 0 {
        // `CREATE TABLE AS SELECT` copies columns and rows without touching
        // the Rust heap; job_businesses rides along so an undo restores the
        // task attribution (T-01), not just the rows.
        tx.execute_batch(
            "CREATE TABLE businesses_backup AS SELECT * FROM businesses;
             CREATE TABLE job_businesses_backup AS SELECT * FROM job_businesses;",
        )?;
    }
    tx.execute("DELETE FROM job_businesses", [])?;
    tx.execute("DELETE FROM businesses", [])?;
    tx.commit()?;
    Ok(rows as usize)
}

/// Restore the snapshot taken by `snapshot_for_clear`, then drop it (R-13).
///
/// The businesses side keeps the original contract: `INSERT OR REPLACE`, the
/// snapshot is the truth, so a row re-collected during the 10 s window comes
/// back exactly as it was cleared — `collected_at` and mined emails included —
/// instead of keeping its newer copy. The links side uses OR IGNORE (see the
/// inline note). Returns how many business rows were written.
///
/// Missing backup tables mean "nothing was captured" (an empty clear, or a
/// restart already dropped them): an honest zero, not an error — the undo
/// window itself is in-memory, so a restart never gets here anyway.
pub fn restore_clear_snapshot(conn: &Connection) -> Result<usize> {
    let tx = write_tx(conn)?;
    let restored = tx
        .execute(
            "INSERT OR REPLACE INTO businesses SELECT * FROM businesses_backup",
            [],
        )
        .unwrap_or(0);
    // OR IGNORE, not OR REPLACE: a job deleted during the undo window makes
    // its links violate the FK, and IGNORE skips those rows one by one —
    // exactly what the old per-row `is_ok()` loop did. OR REPLACE would fail
    // the whole statement and restore no links at all.
    tx.execute(
        "INSERT OR IGNORE INTO job_businesses SELECT * FROM job_businesses_backup",
        [],
    )
    .ok();
    tx.execute_batch(
        "DROP TABLE IF EXISTS businesses_backup;
         DROP TABLE IF EXISTS job_businesses_backup;",
    )?;
    tx.commit()?;
    Ok(restored)
}

// ---------------------------------------------------------------------------
// Runs (P2)
// ---------------------------------------------------------------------------

/// One execution of a task. `new_count` is filled in when the run closes, from
/// the membership delta since it started — the per-batch write path stays
/// untouched.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub status: String,
    pub tiles_done: i64,
    pub tiles_failed: i64,
    pub new_count: i64,
}

fn now_i64() -> i64 {
    crate::now_ms().min(i64::MAX as u64) as i64
}

/// Open a run, reusing one that is still open: resuming after a pause is the
/// same execution, not a second one.
pub fn open_run(conn: &Connection, job_id: &str) -> Result<()> {
    let open: Option<String> = conn
        .query_row(
            "SELECT id FROM task_runs WHERE job_id = ?1 AND finished_at IS NULL
              ORDER BY started_at DESC LIMIT 1",
            [job_id],
            |row| row.get(0),
        )
        .optional()?;
    if open.is_some() {
        return Ok(());
    }
    let found: i64 = conn.query_row(
        "SELECT COUNT(*) FROM job_businesses WHERE job_id = ?1",
        [job_id],
        |row| row.get(0),
    )?;
    let stamp = now_i64();
    // The sequence keeps the id unique when a run closes and reopens inside the
    // same millisecond; an `INSERT OR IGNORE` would silently drop the new run.
    let seq: i64 = conn.query_row(
        "SELECT COUNT(*) FROM task_runs WHERE job_id = ?1",
        [job_id],
        |row| row.get(0),
    )?;
    conn.execute(
        "INSERT INTO task_runs (id, job_id, started_at, status, base_found)
         VALUES (?1, ?2, ?3, 'running', ?4)",
        rusqlite::params![
            format!("run-{}-{}-{}", job_id, stamp, seq),
            job_id,
            stamp,
            found
        ],
    )?;
    Ok(())
}

pub fn close_run(conn: &Connection, job_id: &str, status: &str) -> Result<usize> {
    let open: Option<String> = conn
        .query_row(
            "SELECT id FROM task_runs WHERE job_id = ?1 AND finished_at IS NULL
              ORDER BY started_at DESC LIMIT 1",
            [job_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(run_id) = open else {
        return Ok(0);
    };
    let Some(job) = load_job(conn, job_id)? else {
        return Ok(0);
    };
    conn.execute(
        "UPDATE task_runs
            SET finished_at = ?2, status = ?3, tiles_done = ?4, tiles_failed = ?5,
                new_count = CASE WHEN ?6 > base_found THEN ?6 - base_found ELSE 0 END
          WHERE id = ?1",
        rusqlite::params![
            run_id,
            now_i64(),
            status,
            job.done_tiles,
            job.failed_tiles,
            job.found_count
        ],
    )?;
    Ok(1)
}

pub fn list_runs(conn: &Connection, job_id: &str) -> Result<Vec<RunRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, started_at, finished_at, status, tiles_done, tiles_failed, new_count
           FROM task_runs WHERE job_id = ?1 ORDER BY started_at DESC",
    )?;
    let rows = stmt.query_map([job_id], |row| {
        Ok(RunRow {
            id: row.get(0)?,
            started_at: row.get(1)?,
            finished_at: row.get(2)?,
            status: row.get(3)?,
            tiles_done: row.get(4)?,
            tiles_failed: row.get(5)?,
            new_count: row.get(6)?,
        })
    })?;
    rows.collect()
}

/// Reset every leaf tile so the task can be executed again. Split nodes stay
/// `split`: they are interior nodes of the quadtree, not work items.
pub fn reset_job_for_rerun(conn: &Connection, id: &str) -> Result<usize> {
    let tx = write_tx(conn)?;
    let reset = tx.execute(
        "UPDATE search_tiles
            SET status = 'pending', attempts = 0, result_count = 0,
                started_at = NULL, finished_at = NULL, error_reason = NULL
          WHERE job_id = ?1 AND status <> 'split'",
        [id],
    )?;
    tx.execute(
        "UPDATE search_jobs
            SET status = 'queued', done_tiles = 0, failed_tiles = 0,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?1",
        [id],
    )?;
    // A run left open by an interrupted execution must not be extended by the
    // next one; the new execution gets its own row.
    tx.execute(
        "UPDATE task_runs SET finished_at = ?2, status = 'cancelled'
          WHERE job_id = ?1 AND finished_at IS NULL",
        rusqlite::params![id, now_i64()],
    )?;
    tx.commit()?;
    Ok(reset)
}

/// Put one skipped tile back in the queue (P2). The caller decides whether the
/// job should be restarted.
pub fn retry_tile(conn: &Connection, job_id: &str, tile_id: &str) -> Result<usize> {
    conn.execute(
        "UPDATE search_tiles
            SET status = 'pending', attempts = 0, started_at = NULL, finished_at = NULL,
                error_reason = NULL
          WHERE id = ?1 AND job_id = ?2 AND status = 'skipped'",
        rusqlite::params![tile_id, job_id],
    )
}

pub fn mark_job_exported(conn: &Connection, id: &str, at: i64) -> Result<usize> {
    conn.execute(
        "UPDATE search_jobs SET last_exported_at = ?2 WHERE id = ?1",
        rusqlite::params![id, at],
    )
}

// ---------------------------------------------------------------------------
// Browsing (M6)
// ---------------------------------------------------------------------------

/// Filters accepted by the panel. Unknown values fall through as "no filter"
/// rather than erroring: a stale frontend must not be able to break browsing.
#[derive(Debug, Clone, Default)]
pub struct BusinessFilter {
    pub query: String,
    /// `all`, `none`, or a rating step as shown in the UI (`30` ..= `50`).
    pub rating: String,
    /// `all`, `phone`, `website` or `both`.
    pub contact: String,
    pub types: Vec<String>,
    /// Only rows this job has observed (T-02). Matches against
    /// `job_businesses`, not the legacy `businesses.job_id` column.
    pub job_id: String,
    /// Only rows no job has observed: free-listening leftovers.
    pub unassigned: bool,
    /// With `job_id`: only places this job first saw at/after this epoch ms
    /// (P2 "only new since last export").
    pub job_seen_since: i64,
    /// Epoch milliseconds; rows collected before this instant are excluded.
    /// `0` disables the time dimension (UI-03: session / today / 7 days).
    pub collected_since: i64,
}

#[derive(Debug, Clone, Default)]
pub struct BusinessSort {
    /// `name`, `rating`, `reviews`, `collectedAt`; anything else means insertion
    /// order, which is what the live view follows.
    pub field: String,
    pub direction: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BusinessPage {
    pub rows: Vec<Business>,
    /// Rows matching the filters.
    pub total: i64,
    /// Rows in the database, ignoring filters.
    pub all: i64,
    /// Averages over the filtered rows, so the strip describes the current view.
    pub avg_rating: f64,
    pub rated: i64,
    pub with_phone: i64,
    pub types: Vec<TypeCount>,
    /// Job attribution for the rows on this page only (T-02). A sidecar rather
    /// than a `Business` field: the entity is serialized to the maps script and
    /// the export writer, neither of which should carry a join result.
    pub job_refs: Vec<BusinessJobRef>,
}

/// One "job saw this place" pair, attached to a page for the task column.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BusinessJobRef {
    pub place_id: String,
    pub job_id: String,
    /// Empty only for legacy rows that predate `name` (the backfill covers them).
    pub name: String,
    pub times_seen: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeCount {
    pub label: String,
    pub count: i64,
}

fn build_where(filter: &BusinessFilter, values: &mut Vec<Value>) -> String {
    let mut clauses: Vec<String> = Vec::new();

    let needle = filter.query.trim();
    if !needle.is_empty() {
        clauses.push("(name LIKE ? OR address LIKE ? OR phone LIKE ? OR website LIKE ?)".into());
        let like = format!("%{}%", needle);
        for _ in 0..4 {
            values.push(Value::Text(like.clone()));
        }
    }

    match filter.rating.as_str() {
        "none" => clauses.push("(rating IS NULL OR rating = 0)".into()),
        step if !step.is_empty() && step != "all" => {
            if let Ok(value) = step.parse::<f64>() {
                clauses.push("rating >= ?".into());
                values.push(Value::Real(value / 10.0));
            }
        }
        _ => {}
    }

    match filter.contact.as_str() {
        "phone" => clauses.push("phone <> ''".into()),
        "website" => clauses.push("website <> ''".into()),
        "both" => clauses.push("(phone <> '' AND website <> '')".into()),
        _ => {}
    }

    if !filter.types.is_empty() {
        let mut any = Vec::new();
        for kind in &filter.types {
            // The panel shows `dentist` for `dentist`, but `shoe_store` for
            // `shoe store`; compare the display label so the filter matches what
            // the user clicked.
            any.push(
                "EXISTS (SELECT 1 FROM json_each(businesses.types)
                         WHERE REPLACE(json_each.value, '_', ' ') = ?)",
            );
            values.push(Value::Text(kind.clone()));
        }
        clauses.push(format!("({})", any.join(" OR ")));
    }

    if !filter.job_id.trim().is_empty() {
        // EXISTS rather than JOIN: the page query must not multiply rows when a
        // place belongs to several jobs, and COUNT(*) stays exact.
        let job = Value::Text(filter.job_id.trim().to_string());
        if filter.job_seen_since > 0 {
            clauses.push(
                "EXISTS (SELECT 1 FROM job_businesses jb
                         WHERE jb.place_id = businesses.place_id AND jb.job_id = ?
                           AND jb.first_seen_at >= ?)"
                    .into(),
            );
            values.push(job);
            values.push(Value::Integer(filter.job_seen_since));
        } else {
            clauses.push(
                "EXISTS (SELECT 1 FROM job_businesses jb
                         WHERE jb.place_id = businesses.place_id AND jb.job_id = ?)"
                    .into(),
            );
            values.push(job);
        }
    } else if filter.unassigned {
        clauses.push(
            "NOT EXISTS (SELECT 1 FROM job_businesses jb
                          WHERE jb.place_id = businesses.place_id)"
                .into(),
        );
    }

    if filter.collected_since > 0 {
        clauses.push("collected_at >= ?".into());
        values.push(Value::Integer(filter.collected_since));
    }

    if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    }
}

fn order_by(sort: &BusinessSort) -> String {
    let direction = if sort.direction.eq_ignore_ascii_case("desc") {
        "DESC"
    } else {
        "ASC"
    };
    // Whitelisted on purpose: the field name reaches SQL text.
    match sort.field.as_str() {
        "name" => format!(" ORDER BY name COLLATE NOCASE {}, id ASC", direction),
        "rating" => format!(" ORDER BY rating {}, id ASC", direction),
        "reviews" => format!(" ORDER BY reviews_total {}, id ASC", direction),
        // `collected_at` beats the legacy `created_at`: rows from before UI-03
        // sort by their backfilled value, and `0` lands last in DESC ("newest
        // first"), which is exactly where unknown times belong.
        "collectedAt" => format!(" ORDER BY collected_at {}, id {}", direction, direction),
        _ => " ORDER BY id ASC".to_string(),
    }
}

const BUSINESS_COLUMNS: &str = "place_id, name, address, phone, rating, reviews_total, lat, lng, website, types, source_query, collected_at, emails, socials, email_source_url, email_status, mined_at, street, city, state, postal_code, country, borough, timezone, data_id, reviews_link, thumbnail, owner_name, about, open_hours, plus_code, description, reviews_per_rating, photos";

/// The filter-independent half of a page query (R-14): the unfiltered row
/// count and the type census are identical on every page turn until a write
/// happens, yet each turn used to re-scan the whole table (the `json_each`
/// census is the expensive one — tens to hundreds of ms at 100k rows).
///
/// `PRAGMA data_version` cannot key the cache: it deliberately ignores the
/// connection's own commits, and this app has exactly one connection. The key
/// is `Connection::total_changes`, which moves on every local write. The cache
/// lives next to that one connection (AppState); tests pass `None` and always
/// recompute, which keeps every in-memory fixture independent.
#[derive(Default)]
pub struct DashboardCache {
    entry: Option<(u64, i64, Vec<TypeCount>)>,
}

impl DashboardCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, writes: u64) -> Option<(i64, Vec<TypeCount>)> {
        let (cached_writes, all, types) = self.entry.as_ref()?;
        (*cached_writes == writes).then(|| (*all, types.clone()))
    }

    fn put(&mut self, writes: u64, all: i64, types: Vec<TypeCount>) {
        self.entry = Some((writes, all, types));
    }
}

/// Cumulative rows changed by this connection — the cache key (R-14).
///
/// rusqlite 0.31 does not wrap `sqlite3_total_changes` (the wrapper arrived in
/// 0.32), so the FFI call is made directly — the same one-liner 0.32 performs
/// internally. Sound: the handle belongs to this connection, and the bundled
/// SQLite is compiled in serialized threading mode.
fn total_changes(conn: &Connection) -> u64 {
    // The C signature returns `int`; the wrapper casts to u64.
    unsafe { rusqlite::ffi::sqlite3_total_changes(conn.handle()) as u64 }
}

pub fn query_businesses(
    conn: &Connection,
    filter: &BusinessFilter,
    sort: &BusinessSort,
    page: u32,
    page_size: u32,
    cache: Option<&std::sync::Mutex<DashboardCache>>,
) -> Result<BusinessPage> {
    let mut values = Vec::new();
    let where_sql = build_where(filter, &mut values);

    // One scan for the filtered total and the three aggregates: they used to
    // be two separate passes over the same filtered set (R-14).
    let (total, avg_rating, rated, with_phone): (i64, f64, i64, i64) = conn.query_row(
        &format!(
            "SELECT COUNT(*),
                    COALESCE(AVG(CASE WHEN rating > 0 THEN rating END), 0),
                    COALESCE(SUM(CASE WHEN rating > 0 THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN phone <> '' THEN 1 ELSE 0 END), 0)
             FROM businesses{}",
            where_sql
        ),
        params_from_iter(values.iter()),
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;

    // The filter-independent pair comes from the cache when the connection has
    // not written since it was filled (R-14); a write invalidates it.
    let writes = total_changes(conn);
    let (all, types) = match cache {
        Some(shared) => {
            let mut guard = shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            match guard.get(writes) {
                Some(hit) => hit,
                None => {
                    let fresh = (
                        conn.query_row("SELECT COUNT(*) FROM businesses", [], |row| row.get(0))?,
                        type_counts(conn)?,
                    );
                    guard.put(writes, fresh.0, fresh.1.clone());
                    fresh
                }
            }
        }
        None => (
            conn.query_row("SELECT COUNT(*) FROM businesses", [], |row| row.get(0))?,
            type_counts(conn)?,
        ),
    };

    let size = i64::from(page_size.clamp(1, 500));
    let offset = i64::from(page.max(1) - 1) * size;
    let mut page_values = values.clone();
    page_values.push(Value::Integer(size));
    page_values.push(Value::Integer(offset));

    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM businesses{}{} LIMIT ? OFFSET ?",
        BUSINESS_COLUMNS,
        where_sql,
        order_by(sort)
    ))?;
    let rows = stmt.query_map(params_from_iter(page_values.iter()), row_to_business)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }

    let job_refs = load_job_refs(conn, &out)?;
    Ok(BusinessPage {
        rows: out,
        total,
        all,
        avg_rating,
        rated,
        with_phone,
        types,
        job_refs,
    })
}

/// Attribution for one page of rows, in a single query.
fn load_job_refs(conn: &Connection, rows: &[Business]) -> Result<Vec<BusinessJobRef>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; rows.len()].join(",");
    let sql = format!(
        "SELECT jb.place_id, jb.job_id, COALESCE(NULLIF(j.name, ''), j.keyword), jb.times_seen
           FROM job_businesses jb
           JOIN search_jobs j ON j.id = jb.job_id
          WHERE jb.place_id IN ({})",
        placeholders
    );
    let values: Vec<Value> = rows
        .iter()
        .map(|row| Value::Text(row.place_id.clone()))
        .collect();
    let mut stmt = conn.prepare(&sql)?;
    let mapped = stmt.query_map(params_from_iter(values.iter()), |row| {
        Ok(BusinessJobRef {
            place_id: row.get(0)?,
            job_id: row.get(1)?,
            name: row.get(2)?,
            times_seen: row.get(3)?,
        })
    })?;
    mapped.collect()
}

/// Export path: every row matching the filters, no pagination. Reached only when
/// the user explicitly asks for "all filtered rows", never while browsing.
pub fn load_businesses_filtered(
    conn: &Connection,
    filter: &BusinessFilter,
    sort: &BusinessSort,
) -> Result<Vec<Business>> {
    let mut values = Vec::new();
    let where_sql = build_where(filter, &mut values);
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM businesses{}{}",
        BUSINESS_COLUMNS,
        where_sql,
        order_by(sort)
    ))?;
    let rows = stmt.query_map(params_from_iter(values.iter()), row_to_business)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Fresh copies of specific rows, by `place_id` (R-23).
///
/// The panel keeps the selected rows as a snapshot because exporting needs the
/// entities and re-reading them on every render would defeat paging. A write
/// that lands while the selection spans several pages — email mining is the
/// routine case — leaves that snapshot stale, so the panel asks for the
/// affected rows once the writer reports it is done.
///
/// Chunked: SQLite's parameter limit is 999 on older builds and "select all
/// filtered" can hold thousands of ids.
pub fn businesses_by_ids(conn: &Connection, place_ids: &[String]) -> Result<Vec<Business>> {
    const CHUNK: usize = 400;
    let mut out = Vec::with_capacity(place_ids.len());
    for chunk in place_ids.chunks(CHUNK) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT {} FROM businesses WHERE place_id IN ({})",
            BUSINESS_COLUMNS, placeholders
        );
        let values: Vec<Value> = chunk.iter().map(|id| Value::Text(id.clone())).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(values.iter()), row_to_business)?;
        for row in rows {
            out.push(row?);
        }
    }
    Ok(out)
}

/// Type labels for the filter dropdown, counted across the whole table: options
/// that vanish as soon as they are selected would be a dead end.
fn type_counts(conn: &Connection) -> Result<Vec<TypeCount>> {
    let mut stmt = conn.prepare(
        "SELECT json_each.value AS label, COUNT(*) AS count
         FROM businesses, json_each(businesses.types)
         GROUP BY label
         ORDER BY count DESC, label ASC
         LIMIT 40",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(TypeCount {
            label: row.get::<_, String>(0)?.replace('_', " "),
            count: row.get(1)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        init_schema(&conn).expect("schema");
        conn
    }

    fn add_job(conn: &Connection, id: &str, keyword: &str, tiles: usize) {
        let job = NewJob {
            id,
            name: keyword,
            batch_id: "",
            keyword,
            city: "Test",
            center_lat: 1.0,
            center_lng: 2.0,
            radius_km: 5.0,
            cell_km: 2.0,
            split_threshold: 100,
            locale: "hl=en",
        };
        let seeds: Vec<NewTile> = (0..tiles)
            .map(|index| NewTile {
                id: format!("{}-t{}", id, index),
                seq: index as u32,
                lat: 1.0,
                lng: 2.0,
                zoom: 16,
            })
            .collect();
        insert_job(conn, &job, &seeds).expect("insert job");
    }

    /// R-22: a re-mine that comes up empty must not wipe what an earlier run
    /// found, and a first-time empty result must still record its status so
    /// the row is not re-queued forever.
    #[test]
    fn update_email_mining_never_downgrades_found_data_to_empty() {
        let conn = setup();
        conn.execute(
            "INSERT INTO businesses (place_id, name, types, emails, socials, email_status, mined_at)
             VALUES ('a', 'A', '[]', '[]', '[]', '', 0)",
            [],
        )
        .expect("seed row a");

        update_email_mining(
            &conn,
            &["a".to_string()],
            &["hi@dental.com".to_string()],
            &["https://www.linkedin.com/company/dental".to_string()],
            "https://dental.com/contact",
            "found",
        )
        .expect("first mine");

        // The re-mine comes up empty: data and the `found` status survive.
        update_email_mining(&conn, &["a".to_string()], &[], &[], "", "none-found")
            .expect("empty re-mine");
        let (emails, status): (String, String) = conn
            .query_row(
                "SELECT emails, email_status FROM businesses WHERE place_id = 'a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("row a");
        assert_eq!(emails, r#"["hi@dental.com"]"#);
        assert_eq!(status, "found");

        // A first-time row that yields nothing records the status, so the
        // miner does not queue the same site again without `force`.
        conn.execute(
            "INSERT INTO businesses (place_id, name, types) VALUES ('b', 'B', '[]')",
            [],
        )
        .expect("seed row b");
        update_email_mining(&conn, &["b".to_string()], &[], &[], "", "none-found")
            .expect("first-time empty");
        let status_b: String = conn
            .query_row(
                "SELECT email_status FROM businesses WHERE place_id = 'b'",
                [],
                |row| row.get(0),
            )
            .expect("row b");
        assert_eq!(status_b, "none-found");
    }

    #[test]
    fn insert_and_list_newest_first() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 2);
        add_job(&conn, "job-b", "plumber", 1);

        let jobs = list_jobs(&conn).expect("list");
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0].id, "job-b");
        assert_eq!(jobs[0].status, "queued");
        assert_eq!(jobs[0].total_tiles, 1);
        assert_eq!(jobs[1].keyword, "dentist");
        assert_eq!(jobs[1].total_tiles, 2);
    }

    #[test]
    fn pending_tiles_are_returned_in_seq_order() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 3);

        let first = next_pending_tile(&conn, "job-a").expect("query").expect("tile");
        assert_eq!(first.seq, 0);
        mark_tile_running(&conn, &first.id).expect("running");

        let second = next_pending_tile(&conn, "job-a").expect("query").expect("tile");
        assert_eq!(second.seq, 1, "a running tile must not be picked again");
    }

    #[test]
    fn counts_are_recomputed_from_the_tiles() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 3);

        finish_tile(&conn, "job-a-t0", "done", 20, 1, None).expect("done");
        finish_tile(&conn, "job-a-t1", "empty", 0, 1, Some("parse-empty")).expect("empty");
        finish_tile(&conn, "job-a-t2", "skipped", 0, 2, Some("timeout")).expect("skipped");
        refresh_job_counts(&conn, "job-a", None).expect("refresh");

        let job = load_job(&conn, "job-a").expect("load").expect("job");
        assert_eq!(job.done_tiles, 2, "done + empty both count as processed");
        assert_eq!(job.failed_tiles, 1);
        assert_eq!(job.status, "queued", "refresh must not touch the status");
    }

    #[test]
    fn a_failed_tile_can_be_queued_for_retry() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 1);

        finish_tile(&conn, "job-a-t0", "pending", 0, 1, None).expect("retry");
        let tile = next_pending_tile(&conn, "job-a").expect("query").expect("tile");
        assert_eq!(tile.attempts, 1);
    }

    /// A5: the failure reason survives on the finished tile and a retry clears
    /// it — queued work has no failure to explain.
    #[test]
    fn a_failed_tile_keeps_its_reason_until_a_retry_clears_it() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 1);

        finish_tile(&conn, "job-a-t0", "skipped", 0, 2, Some("nav-failed")).expect("finish");
        let tiles = job_tiles(&conn, "job-a").expect("tiles");
        assert_eq!(tiles[0].status, "skipped");
        assert_eq!(tiles[0].error_reason.as_deref(), Some("nav-failed"));

        retry_tile(&conn, "job-a", "job-a-t0").expect("retry");
        let tiles = job_tiles(&conn, "job-a").expect("tiles");
        assert_eq!(tiles[0].status, "pending");
        assert_eq!(tiles[0].error_reason, None);
    }

    #[test]
    fn recovery_downgrades_a_running_job() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 2);
        set_job_status(&conn, "job-a", "running").expect("running");
        mark_tile_running(&conn, "job-a-t0").expect("tile running");

        let recovered = recover_interrupted_jobs(&conn).expect("recover");
        assert_eq!(recovered, 1);

        let job = load_job(&conn, "job-a").expect("load").expect("job");
        assert_eq!(job.status, "paused");
        assert_eq!(job.current_tile, None);
        let tile = next_pending_tile(&conn, "job-a").expect("query").expect("tile");
        assert_eq!(tile.id, "job-a-t0", "the interrupted tile is retried");
    }

    #[test]
    fn deleting_a_job_keeps_collected_rows() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 2);
        conn.execute(
            "INSERT INTO businesses (place_id, name) VALUES ('p1', 'Kept')",
            [],
        )
        .expect("business");

        delete_job(&conn, "job-a", false).expect("delete");

        let jobs: i64 = conn
            .query_row("SELECT COUNT(*) FROM search_jobs", [], |row| row.get(0))
            .expect("count jobs");
        let tiles: i64 = conn
            .query_row("SELECT COUNT(*) FROM search_tiles", [], |row| row.get(0))
            .expect("count tiles");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM businesses", [], |row| row.get(0))
            .expect("count rows");
        assert_eq!(jobs, 0);
        assert_eq!(tiles, 0, "tiles must not be orphaned");
        assert_eq!(rows, 1, "deleting a job must not delete data");
    }

    #[test]
    fn deleting_a_job_can_remove_only_its_exclusive_rows() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 1);
        add_job(&conn, "job-b", "plumber", 1);

        let only_a = vec![sample("p1", "Only A", "+1 111", 4.0, &["dentist"])];
        let both = vec![sample("p2", "Both", "+1 222", 4.0, &["dentist"])];
        insert_businesses(&conn, &only_a, "dentist", "job-a", false).expect("a exclusive");
        insert_businesses(&conn, &both, "dentist", "job-a", false).expect("a shared");
        insert_businesses(&conn, &both, "plumber", "job-b", false).expect("b shared");

        let (exclusive, shared) = job_delete_preview(&conn, "job-a").expect("preview");
        assert_eq!(exclusive, 1);
        assert_eq!(shared, 1);

        let (jobs, rows) = delete_job(&conn, "job-a", true).expect("delete");
        assert_eq!(jobs, 1);
        assert_eq!(rows, 1, "only the place no other job saw is removed");

        let leftovers: i64 = conn
            .query_row("SELECT COUNT(*) FROM businesses", [], |row| row.get(0))
            .expect("count");
        assert_eq!(leftovers, 1, "the shared place survives");
        let b = query_businesses(
            &conn,
            &BusinessFilter {
                job_id: "job-b".to_string(),
                ..Default::default()
            },
            &BusinessSort::default(),
            1,
            50,
            None,
        )
        .expect("job b");
        assert_eq!(b.total, 1);
    }

    #[test]
    fn runs_record_new_places_between_open_and_close() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 2);

        open_run(&conn, "job-a").expect("open");
        let first = list_runs(&conn, "job-a").expect("runs");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].finished_at, None);

        let rows = vec![sample("p1", "Dental One", "+1 111", 4.5, &["dentist"])];
        insert_businesses(&conn, &rows, "dentist", "job-a", false).expect("rows");
        close_run(&conn, "job-a", "completed").expect("close");

        let runs = list_runs(&conn, "job-a").expect("runs");
        assert_eq!(runs[0].status, "completed");
        assert_eq!(runs[0].new_count, 1);
        assert!(runs[0].finished_at.is_some());

        // Two opens in a row (the worker picking the job up) stay one run.
        open_run(&conn, "job-a").expect("reopen");
        open_run(&conn, "job-a").expect("reopen again");
        assert_eq!(list_runs(&conn, "job-a").expect("runs").len(), 2);
    }

    #[test]
    fn rerun_resets_leaf_tiles_and_closes_the_open_run() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 2);
        mark_tile_running(&conn, "job-a-t0").expect("running");
        finish_tile(&conn, "job-a-t0", "done", 3, 1, None).expect("done");
        refresh_job_counts(&conn, "job-a", Some("completed")).expect("counts");
        open_run(&conn, "job-a").expect("open");

        let reset = reset_job_for_rerun(&conn, "job-a").expect("reset");
        assert_eq!(reset, 2);
        let job = load_job(&conn, "job-a").expect("load").expect("job");
        assert_eq!(job.status, "queued");
        assert_eq!(job.done_tiles, 0);
        assert_eq!(list_runs(&conn, "job-a").expect("runs")[0].status, "cancelled");
    }

    #[test]
    fn only_new_filters_by_when_the_job_first_saw_a_place() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 1);
        let rows = vec![sample("p1", "Dental One", "+1 111", 4.5, &["dentist"])];
        insert_businesses(&conn, &rows, "dentist", "job-a", false).expect("rows");

        let all = BusinessFilter {
            job_id: "job-a".to_string(),
            ..Default::default()
        };
        assert_eq!(
            query_businesses(&conn, &all, &BusinessSort::default(), 1, 50, None)
                .expect("all")
                .total,
            1
        );

        // `sample` carries collected_at = 0, so any positive watermark excludes it.
        let newer = BusinessFilter {
            job_id: "job-a".to_string(),
            job_seen_since: 1,
            ..Default::default()
        };
        assert_eq!(
            query_businesses(&conn, &newer, &BusinessSort::default(), 1, 50, None)
                .expect("newer")
                .total,
            0
        );
    }

    #[test]
    fn next_queued_job_picks_the_oldest() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 1);
        add_job(&conn, "job-b", "plumber", 1);
        set_job_status(&conn, "job-a", "completed").expect("complete");

        let next = next_queued_job(&conn).expect("query").expect("job");
        assert_eq!(next.id, "job-b");
    }

    #[test]
    fn inserted_rows_accumulate() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 1);
        bump_job_inserted(&conn, "job-a", 7).expect("bump");
        bump_job_inserted(&conn, "job-a", 3).expect("bump");
        let job = load_job(&conn, "job-a").expect("load").expect("job");
        assert_eq!(job.inserted, 10);
    }

    fn quadrants(parent_seq: i64) -> Vec<ChildTile> {
        (1..=4)
            .map(|offset| ChildTile {
                seq: (parent_seq as u32) + offset,
                lat: 1.0,
                lng: 2.0,
                zoom: 17,
                depth: 1,
            })
            .collect()
    }

    #[test]
    fn splitting_marks_the_parent_and_queues_four_children() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 5);
        conn.execute("UPDATE search_tiles SET status = 'running' WHERE id = 'job-a-t2'", [])
            .expect("running");
        conn.execute("UPDATE search_tiles SET status = 'done' WHERE id = 'job-a-t0'", [])
            .expect("done");

        let split = split_tile(&conn, "job-a", "job-a-t2", 2, 120, &quadrants(2)).expect("split");
        assert_eq!(split, 1);
        refresh_job_counts(&conn, "job-a", None).expect("refresh");

        let tiles = job_tiles(&conn, "job-a").expect("tiles");
        let parent = tiles.iter().find(|tile| tile.id == "job-a-t2").expect("parent");
        assert_eq!(parent.status, "split");
        assert_eq!(parent.result_count, 120);

        let children: Vec<&TileRow> = tiles.iter().filter(|tile| tile.depth == 1).collect();
        assert_eq!(children.len(), 4);
        assert!(children.iter().all(|tile| tile.status == "pending"));
        assert!(children
            .iter()
            .all(|tile| tile.id.starts_with("job-a-t2-q")));
        let seqs: Vec<i64> = children.iter().map(|tile| tile.seq).collect();
        assert_eq!(seqs, vec![3, 4, 5, 6], "children run right after the parent");

        // The pending tiles that followed keep their ids but move down the queue.
        let shifted = tiles.iter().find(|tile| tile.id == "job-a-t3").expect("shifted");
        assert_eq!(shifted.seq, 7);

        let job = load_job(&conn, "job-a").expect("load").expect("job");
        assert_eq!(job.total_tiles, 8, "5 leaves - 1 interior + 4 children");
        assert_eq!(job.done_tiles, 1);
    }

    fn sample(place_id: &str, name: &str, phone: &str, rating: f64, types: &[&str]) -> Business {
        Business {
            place_id: place_id.to_string(),
            name: name.to_string(),
            address: "1 Main St".to_string(),
            phone: phone.to_string(),
            rating,
            reviews_total: 10,
            lat: 1.0,
            lng: 2.0,
            website: "https://example.com".to_string(),
            types: types.iter().map(|kind| kind.to_string()).collect(),
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

    fn seed_browse(conn: &Connection) {
        // Attribution rows reference `search_jobs`, so the job must exist before
        // the businesses are written; the filter tests below query by its id.
        add_job(conn, "job-a", "dentist", 1);
        let rows = vec![
            sample("p1", "Dental One", "+1 111", 4.5, &["dentist"]),
            sample("p2", "Dental Two", "", 3.5, &["dentist", "orthodontist"]),
            sample("p3", "Shoe Store", "+1 333", 0.0, &["shoe_store"]),
            sample("p4", "Plumber", "+1 444", 4.9, &["plumber"]),
            sample("p5", "Dental Three", "+1 555", 4.1, &["dentist"]),
        ];
        insert_businesses(conn, &rows, "dentist", "job-a", false).expect("seed");
    }

    #[test]
    fn job_filter_is_per_job_not_first_writer() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 1);
        add_job(&conn, "job-b", "plumber", 1);
        let rows = vec![sample("p1", "Dental One", "+1 111", 4.5, &["dentist"])];

        insert_businesses(&conn, &rows, "dentist", "job-a", false).expect("first job");
        // The entity already exists; the second job must still get a link.
        insert_businesses(&conn, &rows, "plumber", "job-b", false).expect("second job");

        let a = query_businesses(
            &conn,
            &BusinessFilter {
                job_id: "job-a".to_string(),
                ..Default::default()
            },
            &BusinessSort::default(),
            1,
            50,
            None,
        )
        .expect("job a");
        let b = query_businesses(
            &conn,
            &BusinessFilter {
                job_id: "job-b".to_string(),
                ..Default::default()
            },
            &BusinessSort::default(),
            1,
            50,
            None,
        )
        .expect("job b");

        assert_eq!(a.total, 1);
        assert_eq!(b.total, 1, "job b must see a place job a inserted first");
        assert_eq!(b.job_refs.len(), 2, "both jobs are attributed to the place");

        // Deleting a job drops its links but keeps the entity for the other job.
        delete_job(&conn, "job-a", false).expect("delete");
        let b_after = query_businesses(
            &conn,
            &BusinessFilter {
                job_id: "job-b".to_string(),
                ..Default::default()
            },
            &BusinessSort::default(),
            1,
            50,
            None,
        )
        .expect("job b after delete");
        assert_eq!(b_after.total, 1);
        let all = query_businesses(&conn, &BusinessFilter::default(), &BusinessSort::default(), 1, 50, None)
            .expect("all");
        assert_eq!(all.total, 1, "the business row itself survives");
    }

    #[test]
    fn paging_counts_every_match_but_returns_one_page() {
        let conn = setup();
        seed_browse(&conn);

        let first = query_businesses(
            &conn,
            &BusinessFilter::default(),
            &BusinessSort::default(),
            1,
            2,
            None,
        )
        .expect("query");
        assert_eq!(first.total, 5);
        assert_eq!(first.all, 5);
        assert_eq!(first.rows.len(), 2);
        assert_eq!(first.rows[0].place_id, "p1", "insertion order by default");

        let last = query_businesses(
            &conn,
            &BusinessFilter::default(),
            &BusinessSort::default(),
            3,
            2,
            None,
        )
        .expect("query");
        assert_eq!(last.rows.len(), 1);
        assert_eq!(last.rows[0].place_id, "p5");
    }

    #[test]
    fn filters_run_in_sql() {
        let conn = setup();
        seed_browse(&conn);

        let text = BusinessFilter {
            query: "dental".to_string(),
            ..Default::default()
        };
        let page = query_businesses(&conn, &text, &BusinessSort::default(), 1, 50, None).expect("q");
        assert_eq!(page.total, 3);
        assert_eq!(page.rated, 3);
        assert!((page.avg_rating - (4.5 + 3.5 + 4.1) / 3.0).abs() < 1e-9);

        let rated = BusinessFilter {
            rating: "40".to_string(),
            ..Default::default()
        };
        let page = query_businesses(&conn, &rated, &BusinessSort::default(), 1, 50, None).expect("q");
        assert_eq!(page.total, 3, "4.5, 4.9 and 4.1 are at least 4.0");

        let no_rating = BusinessFilter {
            rating: "none".to_string(),
            ..Default::default()
        };
        let page = query_businesses(&conn, &no_rating, &BusinessSort::default(), 1, 50, None).expect("q");
        assert_eq!(page.total, 1);

        let with_phone = BusinessFilter {
            contact: "phone".to_string(),
            ..Default::default()
        };
        let page = query_businesses(&conn, &with_phone, &BusinessSort::default(), 1, 50, None).expect("q");
        assert_eq!(page.total, 4);
        assert_eq!(page.with_phone, 4);

        // Stored as `shoe_store`, displayed and filtered as `shoe store`.
        let shoe = BusinessFilter {
            types: vec!["shoe store".to_string()],
            ..Default::default()
        };
        let page = query_businesses(&conn, &shoe, &BusinessSort::default(), 1, 50, None).expect("q");
        assert_eq!(page.total, 1);
        assert_eq!(page.rows[0].place_id, "p3");

        let by_job = BusinessFilter {
            job_id: "job-a".to_string(),
            ..Default::default()
        };
        let page = query_businesses(&conn, &by_job, &BusinessSort::default(), 1, 50, None).expect("q");
        assert_eq!(page.total, 5);

        let mut types = page.types;
        types.sort_by(|a, b| a.label.cmp(&b.label));
        assert!(types.iter().any(|entry| entry.label == "dentist" && entry.count == 3));
        assert!(types.iter().any(|entry| entry.label == "shoe store" && entry.count == 1));
    }

    #[test]
    fn sorts_are_whitelisted_and_direction_aware() {
        let conn = setup();
        seed_browse(&conn);

        let sort = BusinessSort {
            field: "rating".to_string(),
            direction: "desc".to_string(),
        };
        let page = query_businesses(&conn, &BusinessFilter::default(), &sort, 1, 50, None).expect("q");
        let ratings: Vec<f64> = page.rows.iter().map(|row| row.rating).collect();
        assert_eq!(ratings, vec![4.9, 4.5, 4.1, 3.5, 0.0]);

        let by_name = BusinessSort {
            field: "name".to_string(),
            direction: "asc".to_string(),
        };
        let page = query_businesses(&conn, &BusinessFilter::default(), &by_name, 1, 50, None).expect("q");
        assert_eq!(page.rows[0].name, "Dental One");

        // An unknown field must fall back to insertion order, not to SQL text.
        let bogus = BusinessSort {
            field: "rating; DROP TABLE businesses".to_string(),
            direction: "desc".to_string(),
        };
        let page = query_businesses(&conn, &BusinessFilter::default(), &bogus, 1, 50, None).expect("q");
        assert_eq!(page.rows[0].place_id, "p1");
    }

    /// M8 / J-08c: the columns the index probe confirmed in the search
    /// payload must survive the round trip through the database — including
    /// the two JSON ones.
    #[test]
    fn the_new_field_columns_round_trip() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 1);
        let mut row = sample("p1", "Dental One", "+1 555 0100", 4.5, &["dentist"]);
        row.street = "281 Columbia Ave".into();
        row.city = "Los Angeles".into();
        row.state = "California".into();
        row.postal_code = "90026".into();
        row.country = "US".into();
        row.borough = "Westlake".into();
        row.timezone = "America/Los_Angeles".into();
        row.data_id = "0x80c2c7a88213f6fd:0x49fd108590e85a1f".into();
        row.reviews_link = "https://search.google.com/local/reviews?placeid=x".into();
        row.thumbnail = "https://streetviewpixels-pa.googleapis.com/v1/thumb".into();
        row.owner_name = "Lilia Martinez".into();
        row.about = vec![AboutEntry {
            key: "accessibility".into(),
            label: "Accessibility".into(),
        }];
        row.open_hours = vec![OpenHoursDay {
            day: "Saturday".into(),
            periods: vec!["9 AM - 5 PM".into()],
        }];
        insert_businesses(&conn, &[row], "dentist", "job-a", false).expect("insert");

        let page = query_businesses(
            &conn,
            &BusinessFilter::default(),
            &BusinessSort::default(),
            1,
            50,
            None,
        )
        .expect("query");
        let got = &page.rows[0];
        assert_eq!(got.street, "281 Columbia Ave");
        assert_eq!(got.city, "Los Angeles");
        assert_eq!(got.state, "California");
        assert_eq!(got.postal_code, "90026");
        assert_eq!(got.country, "US");
        assert_eq!(got.borough, "Westlake");
        assert_eq!(got.timezone, "America/Los_Angeles");
        assert_eq!(got.data_id, "0x80c2c7a88213f6fd:0x49fd108590e85a1f");
        assert_eq!(got.reviews_link, "https://search.google.com/local/reviews?placeid=x");
        assert_eq!(got.thumbnail, "https://streetviewpixels-pa.googleapis.com/v1/thumb");
        assert_eq!(got.owner_name, "Lilia Martinez");
        assert_eq!(got.about.len(), 1);
        assert_eq!(got.about[0].key, "accessibility");
        assert_eq!(got.about[0].label, "Accessibility");
        assert_eq!(got.open_hours.len(), 1);
        assert_eq!(got.open_hours[0].day, "Saturday");
        assert_eq!(got.open_hours[0].periods, vec!["9 AM - 5 PM".to_string()]);
    }

    #[test]
    fn inserting_only_counts_new_place_ids() {
        let conn = setup();
        let rows = vec![sample("p1", "Dental One", "", 4.5, &["dentist"])];
        assert_eq!(
            insert_businesses(&conn, &rows, "dentist", "", false).expect("first"),
            1
        );
        assert_eq!(
            insert_businesses(&conn, &rows, "dentist", "", false).expect("second"),
            0,
            "insert-or-ignore must not report a duplicate as new"
        );

        let updated = vec![sample("p1", "Dental One Renamed", "", 4.8, &["dentist"])];
        assert_eq!(
            insert_businesses(&conn, &updated, "dentist", "", true).expect("upsert"),
            0,
            "an upsert of a known place id is not a new row"
        );
        let page = query_businesses(
            &conn,
            &BusinessFilter::default(),
            &BusinessSort::default(),
            1,
            50,
            None,
        )
        .expect("q");
        assert_eq!(page.rows[0].name, "Dental One Renamed");
        assert_eq!(page.total, 1);
    }

    /// Perf gate for roadmap M6: 100k rows, filter + sort + paginate.
    ///
    /// Ignored by default because a debug build (unoptimized SQLite + rusqlite)
    /// is roughly an order of magnitude slower than the shipped binary. Run it
    /// with:
    ///   cargo test --release --lib queries_stay_under_300ms -- --ignored
    #[test]
    #[ignore = "perf: 100k rows, run with --ignored in release"]
    fn queries_stay_under_300ms_at_100k_rows() {
        let conn = setup();
        {
            let tx = write_tx(&conn).expect("tx");
            let mut stmt = tx
                .prepare(
                    "INSERT INTO businesses
                     (place_id, name, address, phone, rating, reviews_total, lat, lng,
                      website, types, source_query, job_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1.0, 2.0, ?7, ?8, 'dentist', 'job-a')",
                )
                .expect("prepare");
            for index in 0..100_000 {
                let types = if index % 10 == 0 {
                    r#"["dentist","orthodontist"]"#
                } else {
                    r#"["dentist"]"#
                };
                stmt.execute(rusqlite::params![
                    format!("seed-{:06}", index),
                    format!("Dental Practice {:06}", index),
                    format!("{} Market Street", index),
                    if index % 3 == 0 { "" } else { "+1 555 0100" },
                    f64::from(index % 50) / 10.0,
                    index,
                    "https://example.com",
                    types,
                ])
                .expect("insert");
            }
            drop(stmt);
            tx.commit().expect("commit");
        }

        let filter = BusinessFilter {
            query: "Dental".to_string(),
            rating: "40".to_string(),
            contact: "phone".to_string(),
            ..Default::default()
        };
        let sort = BusinessSort {
            field: "rating".to_string(),
            direction: "desc".to_string(),
        };

        let mut timings = Vec::new();
        // R-14: the real panel reuses one dashboard cache for the whole
        // browsing session (AppState), so the gate measures the warm steady
        // state a user actually experiences, not a cold cache per page.
        let cache = std::sync::Mutex::new(DashboardCache::new());
        for _ in 0..20 {
            let started = std::time::Instant::now();
            let page = query_businesses(&conn, &filter, &sort, 3, 50, Some(&cache)).expect("query");
            timings.push(started.elapsed().as_millis() as u64);
            assert_eq!(page.rows.len(), 50);
        }
        timings.sort_unstable();
        let p95 = timings[(timings.len() as f64 * 0.95).ceil() as usize - 1];
        println!("100k rows: p95={}ms samples={:?}", p95, timings);
        assert!(p95 < 300, "p95 was {} ms", p95);
    }

    #[test]
    fn a_pre_m6_business_table_is_migrated_in_place() {
        let conn = Connection::open_in_memory().expect("open");
        // Shape of the database shipped before M6: no source columns yet.
        conn.execute_batch(
            "CREATE TABLE businesses (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                place_id      TEXT UNIQUE NOT NULL,
                name          TEXT,
                address       TEXT,
                phone         TEXT,
                rating        REAL DEFAULT 0,
                reviews_total INTEGER DEFAULT 0,
                lat           REAL DEFAULT 0,
                lng           REAL DEFAULT 0,
                website       TEXT,
                types         TEXT,
                created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO businesses (place_id, name, types)
            VALUES ('old', 'Old Row', '[\"dentist\"]');",
        )
        .expect("legacy schema");

        // This is what used to crash: the index on `source_query` was created
        // before the column existed.
        init_schema(&conn).expect("migrate");

        // R-06: the upgrade also stamps the schema version, so the next start
        // short-circuits instead of re-running the whole schema.
        let version: i32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, LATEST_SCHEMA_VERSION);

        let page = query_businesses(
            &conn,
            &BusinessFilter::default(),
            &BusinessSort::default(),
            1,
            10,
            None,
        )
        .expect("query");
        assert_eq!(page.total, 1);
        assert_eq!(page.rows[0].name, "Old Row");

        let job_id: String = conn
            .query_row("SELECT job_id FROM businesses WHERE place_id = 'old'", [], |row| {
                row.get(0)
            })
            .expect("job_id column");
        assert_eq!(job_id, "");
        // UI-03: the backfill converts the legacy UTC `created_at` string, so
        // the old row keeps a real collection time instead of sorting unknown.
        let collected_at: i64 = conn
            .query_row(
                "SELECT collected_at FROM businesses WHERE place_id = 'old'",
                [],
                |row| row.get(0),
            )
            .expect("collected_at column");
        assert!(collected_at > 0, "created_at should be backfilled to ms");
        let indexes: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name IN ('idx_source_query', 'idx_job_id', 'idx_business_collected_at')",
                [],
                |row| row.get(0),
            )
            .expect("indexes");
        assert_eq!(indexes, 3);
    }

    /// R-06: the version is stamped once migrations ran, and a database
    /// already at the latest version short-circuits instead of re-running the
    /// whole schema (backfills included).
    #[test]
    fn init_schema_stamps_the_version_and_short_circuits_at_latest() {
        let conn = setup();
        let version: i32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, LATEST_SCHEMA_VERSION);

        init_schema(&conn).expect("second run must be a no-op");
        let version: i32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, LATEST_SCHEMA_VERSION);
    }

    /// R-06 / M8 / J-08c: an *installed* database — one that already ran the
    /// older migrations — must gain the new columns.
    ///
    /// The migration list is walked from the version stored in the database,
    /// so columns added to an already applied migration would never reach an
    /// installed database: the write would fail with "no such column" and
    /// every batch would be lost. A fresh database would not show it (it
    /// walks the whole list), which is exactly why this test starts from the
    /// previous version instead of from scratch.
    #[test]
    fn an_installed_database_gains_the_new_columns() {
        let conn = Connection::open_in_memory().expect("open");
        migrate_v0_to_v1(&conn).expect("v1");
        migrate_v1_to_v2(&conn).expect("v2");
        conn.execute_batch("PRAGMA user_version = 2;").expect("stamp");

        init_schema(&conn).expect("migrate");

        for column in [
            "street",
            "city",
            "state",
            "postal_code",
            "country",
            "borough",
            "timezone",
            "data_id",
            "reviews_link",
            "thumbnail",
            "owner_name",
            "about",
            "open_hours",
        ] {
            assert!(
                has_column(&conn, "businesses", column).expect("info"),
                "an installed database must gain the {} column",
                column
            );
        }
    }

    /// Tier-2: an installed v4 database gains the four detail columns, and the
    /// enrich write / read roundtrip keeps every field.
    #[test]
    fn an_installed_v4_database_gains_the_detail_columns() {
        let conn = Connection::open_in_memory().expect("open");
        migrate_v0_to_v1(&conn).expect("v1");
        migrate_v1_to_v2(&conn).expect("v2");
        migrate_v2_to_v3(&conn).expect("v3");
        migrate_v3_to_v4(&conn).expect("v4");
        conn.execute_batch("PRAGMA user_version = 4;").expect("stamp");

        init_schema(&conn).expect("migrate");
        assert!(has_column(&conn, "businesses", "plus_code").expect("info"));
        assert!(has_column(&conn, "businesses", "description").expect("info"));
        assert!(has_column(&conn, "businesses", "reviews_per_rating").expect("info"));
        assert!(has_column(&conn, "businesses", "photos").expect("info"));

        let row = sample("ChIJdetail", "Detail Cafe", "+1 415-555-0123", 4.5, &["cafe"]);
        insert_businesses(&conn, &[row.clone()], "", "", false).expect("insert");

        update_business_details(
            &conn,
            "ChIJdetail",
            "74GC+2V San Jose",
            "Welcoming coffeehouse.",
            &[125, 28, 59, 110, 307],
            &["https://lh3.example/a.jpg".into()],
        )
        .expect("update");

        let mut stmt = conn
            .prepare(&format!(
                "SELECT {} FROM businesses WHERE place_id = 'ChIJdetail'",
                BUSINESS_COLUMNS
            ))
            .expect("prepare");
        let read = stmt
            .query_row([], row_to_business)
            .expect("read");
        assert_eq!(read.plus_code, "74GC+2V San Jose");
        assert_eq!(read.description, "Welcoming coffeehouse.");
        assert_eq!(read.reviews_per_rating, vec![125, 28, 59, 110, 307]);
        assert_eq!(read.photos, vec!["https://lh3.example/a.jpg".to_string()]);
    }

    /// M9 / J-09a: an installed v3 database gains the `business_reviews` table,
    /// and the store/read roundtrip keeps every field the drawer shows.
    #[test]
    fn an_installed_v3_database_gains_the_reviews_table() {
        let conn = Connection::open_in_memory().expect("open");
        migrate_v0_to_v1(&conn).expect("v1");
        migrate_v1_to_v2(&conn).expect("v2");
        migrate_v2_to_v3(&conn).expect("v3");
        conn.execute_batch("PRAGMA user_version = 3;").expect("stamp");

        init_schema(&conn).expect("migrate");
        assert!(has_column(&conn, "businesses", "reviews_link").expect("info"));

        let row = ReviewRow {
            review_id: "ChZDSUhNMG9nS0VJQ0FnSURVMVp6bmZREAE".into(),
            place_id: "ChIJI7IvT70zjoARVt733pqF6Uc".into(),
            payload_place_id: "0x0:0x47e9859adef7de56".into(),
            author: "Dawei Wang".into(),
            stars: 1,
            text: "This customer service guy very no friendly.".into(),
            created_at_us: 1_567_179_139_665_570,
            updated_at_us: 1_567_213_735_513_749,
            relative_time: "7 年前".into(),
            owner_reply: "Dawei，感谢您的反馈。".into(),
            channel: "state_cache".into(),
            fetched_at: 1_772_033_845_093,
            ..Default::default()
        };
        let inserted = insert_reviews(&conn, &[row.clone()]).expect("insert");
        assert_eq!(inserted, 1);

        let rows = list_reviews(&conn, "ChIJI7IvT70zjoARVt733pqF6Uc").expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].author, "Dawei Wang");
        assert_eq!(rows[0].stars, 1);
        assert_eq!(rows[0].created_at_us, 1_567_179_139_665_570);
        assert_eq!(rows[0].owner_reply, "Dawei，感谢您的反馈。");
        assert!(
            list_reviews(&conn, "some-other-place")
                .expect("list")
                .is_empty(),
            "another place must not see these reviews"
        );

        // A refetch replaces the row wholesale (same review id).
        let mut updated = row.clone();
        updated.text = "edited by google".into();
        insert_reviews(&conn, &[updated]).expect("replace");
        let rows = list_reviews(&conn, "ChIJI7IvT70zjoARVt733pqF6Uc").expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].text, "edited by google");

        // The export view: one place, then everything.
        conn.execute(
            "INSERT INTO businesses (place_id, name) VALUES (?1, ?2)",
            ["ChIJI7IvT70zjoARVt733pqF6Uc", "Capitol Nissan"],
        )
        .expect("business row");
        let all = reviews_for_export(&conn, None).expect("all");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].business_name, "Capitol Nissan");
        assert!(!all[0].posted.is_empty(), "created_at_us must format");
        let scoped = reviews_for_export(&conn, Some("ChIJI7IvT70zjoARVt733pqF6Uc")).expect("scoped");
        assert_eq!(scoped.len(), 1);
        let scoped = reviews_for_export(&conn, Some("another-place")).expect("scoped");
        assert!(scoped.is_empty());
    }

    /// M9: the wire contract between the injected script and `ReviewRow`. The
    /// script emits snake_case keys verbatim (same convention as the
    /// `business-data` payload); a camelCase rename on the struct would
    /// deserialize every field to empty and the store path would drop the
    /// rows — the exact failure the first live fetch hit.
    #[test]
    fn the_script_payload_shape_deserializes_with_ids_intact() {
        // The exact shape `__placemillFetchReviews` emits for one review, as
        // captured in the spike.
        let payload = serde_json::json!({
            "review_id": "ChZDSUhNMG9nS0VJQ0FnSURVMVp6bmZREAE",
            "place_id": "0x0:0x47e9859adef7de56",
            "created_at_us": 1_567_179_139_665_570i64,
            "updated_at_us": 1_567_213_735_513_749i64,
            "relative_time": "7 年前",
            "author": "Dawei Wang",
            "author_avatar": "https://lh3.googleusercontent.com/a/ACg8ocK=c",
            "author_id": "117047243740762592239",
            "author_link": "https://www.google.com/maps/contrib/117047243740762592239",
            "stars": 1,
            "text": "This customer service guy very no friendly.",
            "owner_reply": "Dawei，感谢您的反馈。",
            "owner_reply_at_us": 1_589_366_133_927_000i64,
            "owner_reply_relative": "1 年前",
            "helpful_votes": 2,
            "photo_url": "",
            "report_url": "https://www.google.com/local/review/report?reviewid=ChZD",
        });
        let row: ReviewRow = serde_json::from_value(payload).expect("deserialize");
        assert_eq!(row.review_id, "ChZDSUhNMG9nS0VJQ0FnSURVMVp6bmZREAE");
        assert_eq!(row.author, "Dawei Wang");
        assert_eq!(row.stars, 1);
        assert_eq!(row.created_at_us, 1_567_179_139_665_570);
        assert_eq!(row.text, "This customer service guy very no friendly.");
    }

    /// R-06: the real file-backed upgrade path — a database in the shape an
    /// older build left on disk opens, migrates in place, and keeps its rows.
    #[test]
    fn file_database_upgrades_from_a_legacy_schema() {
        let dir = std::env::temp_dir().join(format!("placemill-r06-upgrade-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let db_path = dir.join("placemill.db");

        {
            let conn = Connection::open(&db_path).expect("open legacy file");
            // Same shape as the in-memory legacy fixture above: the pre-M6
            // database (base columns, no source/mining columns yet). Every
            // database this app ever shipped is at least this new.
            conn.execute_batch(
                "CREATE TABLE businesses (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    place_id      TEXT UNIQUE NOT NULL,
                    name          TEXT,
                    address       TEXT,
                    phone         TEXT,
                    rating        REAL DEFAULT 0,
                    reviews_total INTEGER DEFAULT 0,
                    lat           REAL DEFAULT 0,
                    lng           REAL DEFAULT 0,
                    website       TEXT,
                    types         TEXT,
                    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                INSERT INTO businesses (place_id, name)
                VALUES ('old', 'Old Row');",
            )
            .expect("legacy schema");
        }

        let conn = init_database(&db_path).expect("migrate file");
        let version: i32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, LATEST_SCHEMA_VERSION);
        let name: String = conn
            .query_row(
                "SELECT name FROM businesses WHERE place_id = 'old'",
                [],
                |row| row.get(0),
            )
            .expect("row survived the migration");
        assert_eq!(name, "Old Row");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// R-06 acceptance: a database file that cannot be opened is preserved
    /// under a timestamped backup — never deleted — and the app starts on a
    /// fresh database instead of panicking.
    #[test]
    fn a_broken_database_file_is_backed_up_and_replaced() {
        let dir = std::env::temp_dir().join(format!("placemill-r06-corrupt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let db_path = dir.join("placemill.db");
        std::fs::write(&db_path, b"definitely not a sqlite database").expect("garbage file");

        let (conn, backup) =
            open_with_recovery(&db_path).expect("recovery must keep the app alive");
        // The app works on the rebuilt database.
        conn.execute(
            "INSERT INTO businesses (place_id, name) VALUES ('fresh', 'Fresh Row')",
            [],
        )
        .expect("fresh database is usable");

        // The original bytes survived in the backup.
        let backup = backup.expect("backup path");
        assert_eq!(
            std::fs::read(&backup).expect("backup bytes"),
            b"definitely not a sqlite database"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// R-16: schema v2 prunes the redundant place_id index and adds the
    /// access paths the panel filters and the miner were full-scanning.
    #[test]
    fn schema_v2_prunes_and_adds_indexes() {
        let conn = setup();

        let redundant: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'index' AND name = 'idx_place_id'",
            [],
            |row| row.get(0),
        )
        .expect("redundant index count");
        assert_eq!(redundant, 0, "UNIQUE(place_id) maintains its own index");

        let added: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'index' AND name IN
             ('idx_tiles_job_status', 'idx_tiles_running',
              'idx_business_phone', 'idx_business_website', 'idx_business_unmined')",
            [],
            |row| row.get(0),
        )
        .expect("new index count");
        assert_eq!(added, 5, "all five v2 indexes must exist");
    }

    /// R-16 acceptance: the queries that used to full-scan now hit the v2
    /// indexes.
    #[test]
    fn query_plans_use_the_v2_indexes() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 2);

        let plan = |sql: &str| -> String {
            let mut stmt = conn
                .prepare(&format!("EXPLAIN QUERY PLAN {}", sql))
                .expect("prepare");
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(3))
                .expect("map plan rows");
            rows.collect::<Result<Vec<_>>>()
                .expect("plan")
                .join(" | ")
        };

        // refresh_job_counts: three COUNT(*) subqueries per tile decision,
        // no ORDER BY — the (job_id, status) composite is the access path.
        // (next_pending_tile keeps idx_tiles_job on purpose: its ORDER BY seq
        // makes (job_id, seq) the better plan, sort-free.)
        let p = plan(
            "SELECT COUNT(*) FROM search_tiles WHERE job_id = 'job-a' AND status <> 'split'",
        );
        assert!(p.contains("idx_tiles_job_status"), "{}", p);

        // Startup recovery: reset running tiles across all jobs.
        let p = plan("UPDATE search_tiles SET status = 'pending' WHERE status = 'running'");
        assert!(p.contains("idx_tiles_running"), "{}", p);

        // Contact filter.
        let p = plan("SELECT place_id FROM businesses WHERE phone <> ''");
        assert!(p.contains("idx_business_phone"), "{}", p);

        // mining_targets (non-force): either partial index is a valid choice
        // for the planner; both beat the old full scan.
        let p = plan(
            "SELECT place_id, website FROM businesses
             WHERE (email_status IS NULL OR email_status = '') AND website <> ''
             ORDER BY id ASC",
        );
        assert!(
            p.contains("idx_business_unmined") || p.contains("idx_business_website"),
            "{}",
            p
        );
    }

    /// R-13: the clear snapshot lives in SQL, restores exactly (mined columns
    /// and task links included), and is consumed by the restore.
    #[test]
    fn clear_snapshot_round_trips_through_sql() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 1);
        let rows = vec![sample("p1", "Kept Dental", "+1 555 0100", 4.5, &["dentist"])];
        insert_businesses(&conn, &rows, "dentist", "job-a", false).expect("insert");
        update_email_mining(
            &conn,
            &["p1".to_string()],
            &["hi@dental.com".to_string()],
            &[],
            "https://dental.com",
            "found",
        )
        .expect("mine");

        let captured = snapshot_for_clear(&conn).expect("snapshot");
        assert_eq!(captured, 1);
        let empty: i64 = conn
            .query_row("SELECT COUNT(*) FROM businesses", [], |row| row.get(0))
            .expect("count");
        assert_eq!(empty, 0, "the live table is empty after the clear");

        let restored = restore_clear_snapshot(&conn).expect("restore");
        assert_eq!(restored, 1);
        let (emails, status): (String, String) = conn
            .query_row(
                "SELECT emails, email_status FROM businesses WHERE place_id = 'p1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("row came back");
        assert_eq!(
            emails, "[\"hi@dental.com\"]",
            "mined data survives the round trip"
        );
        assert_eq!(status, "found");
        let links: i64 = conn
            .query_row("SELECT COUNT(*) FROM job_businesses", [], |row| row.get(0))
            .expect("links");
        assert_eq!(links, 1, "task links are restored too");

        // The snapshot is consumed: a second restore has nothing to write.
        let again = restore_clear_snapshot(&conn).expect("second restore");
        assert_eq!(again, 0);
    }

    /// R-13: a clear with nothing to capture reports zero and leaves no
    /// backup tables behind.
    #[test]
    fn clearing_an_empty_table_captures_nothing() {
        let conn = setup();
        assert_eq!(snapshot_for_clear(&conn).expect("snapshot"), 0);
        let backups: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table'
                   AND name IN ('businesses_backup', 'job_businesses_backup')",
                [],
                |row| row.get(0),
            )
            .expect("backup tables");
        assert_eq!(backups, 0);
    }

    /// R-14: the dashboard cache serves the filter-independent pair until a
    /// write invalidates it; a `None` cache always recomputes, which is what
    /// keeps every in-memory fixture independent.
    #[test]
    fn the_dashboard_cache_invalidates_on_write() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 1);
        let cache = std::sync::Mutex::new(DashboardCache::new());
        let cached_page = || {
            query_businesses(
                &conn,
                &BusinessFilter::default(),
                &BusinessSort::default(),
                1,
                50,
                Some(&cache),
            )
            .expect("cached query")
        };

        insert_businesses(
            &conn,
            &[sample("p1", "Dental", "+1 555 0100", 4.0, &["dentist"])],
            "dentist",
            "job-a",
            false,
        )
        .expect("insert");

        let first = cached_page();
        assert_eq!(first.all, 1);
        assert_eq!(first.types.len(), 1);
        assert_eq!(first.types[0].label, "dentist");

        // Same write counter: the cached pair is served with identical values.
        let second = cached_page();
        assert_eq!(second.all, first.all);
        assert_eq!(second.types.len(), first.types.len());

        // A write bumps total_changes, so the next query recomputes.
        insert_businesses(
            &conn,
            &[sample(
                "p2",
                "Ortho",
                "+1 555 0200",
                4.0,
                &["dentist", "orthodontist"],
            )],
            "dentist",
            "job-a",
            false,
        )
        .expect("insert");
        let third = cached_page();
        assert_eq!(third.all, 2, "the cache invalidated on the write");
        assert_eq!(third.types.len(), 2);

        // The None path always recomputes.
        let uncached = query_businesses(
            &conn,
            &BusinessFilter::default(),
            &BusinessSort::default(),
            1,
            50,
            None,
        )
        .expect("uncached query");
        assert_eq!(uncached.all, 2);
        assert_eq!(uncached.types.len(), 2);
    }

    #[test]
    fn refreshing_a_row_keeps_its_first_collected_at() {
        let conn = setup();
        let base = Business {
            name: "Old Row".into(),
            address: "1 A St".into(),
            phone: String::new(),
            rating: 4.0,
            reviews_total: 3,
            lat: 1.0,
            lng: 2.0,
            place_id: "p1".into(),
            website: String::new(),
            types: vec!["dentist".into()],
            collected_at: 1_000,
            source_query: "dentist".into(),
            emails: Vec::new(),
            socials: Vec::new(),
            email_source_url: String::new(),
            email_status: String::new(),
            mined_at: 0,
            ..Default::default()
        };
        assert_eq!(insert_businesses(&conn, &[base.clone()], "", "", false).unwrap(), 1);

        // Same place, later search: the name refreshes, the first-collection
        // time survives, and `source_query` follows the latest search.
        let refreshed = Business {
            name: "Old Row Renamed".into(),
            collected_at: 9_000,
            source_query: "dentist near me".into(),
            ..base.clone()
        };
        // Refreshing a known row is an update, not a new insert: the counter
        // stays at zero while the stored values change.
        assert_eq!(
            insert_businesses(&conn, &[refreshed], "", "", true).unwrap(),
            0
        );
        let (collected_at, source_query): (i64, String) = conn
            .query_row(
                "SELECT collected_at, source_query FROM businesses WHERE place_id = 'p1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("row");
        assert_eq!(collected_at, 1_000, "first-collection time must survive");
        assert_eq!(source_query, "dentist near me");

        // A row without a per-row source falls back to the batch metadata.
        let anonymous = Business { place_id: "p2".into(), collected_at: 0, source_query: String::new(), ..base };
        assert_eq!(insert_businesses(&conn, &[anonymous], "batch keyword", "job-x", false).unwrap(), 1);
        let source: String = conn
            .query_row(
                "SELECT source_query FROM businesses WHERE place_id = 'p2'",
                [],
                |row| row.get(0),
            )
            .expect("row");
        assert_eq!(source, "batch keyword");
    }

    #[test]
    fn splitting_twice_is_a_no_op() {
        let conn = setup();
        add_job(&conn, "job-a", "dentist", 1);
        conn.execute("UPDATE search_tiles SET status = 'running' WHERE id = 'job-a-t0'", [])
            .expect("running");

        assert_eq!(
            split_tile(&conn, "job-a", "job-a-t0", 0, 120, &quadrants(0)).expect("first"),
            1
        );
        assert_eq!(
            split_tile(&conn, "job-a", "job-a-t0", 0, 120, &quadrants(0)).expect("second"),
            0,
            "a retried split must not duplicate children"
        );

        let tiles = job_tiles(&conn, "job-a").expect("tiles");
        assert_eq!(tiles.len(), 5);
    }

    #[test]
    fn businesses_by_ids_returns_the_stored_copy_and_skips_unknown_ids() {
        let conn = setup();
        seed_browse(&conn);

        // The duplicate-strategy=update path: a later batch rewrites the row.
        // This is exactly the change a selection snapshot would miss (R-23).
        let updated = vec![sample("p1", "Dental One", "+1 999", 4.5, &["dentist"])];
        insert_businesses(&conn, &updated, "dentist", "job-a", true).expect("update");

        let rows = businesses_by_ids(&conn, &["p1".to_string(), "missing".to_string()])
            .expect("by ids");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].place_id, "p1");
        assert_eq!(rows[0].phone, "+1 999");
    }

    #[test]
    fn businesses_by_ids_chunks_past_the_parameter_limit() {
        let conn = setup();
        let seeded: Vec<Business> = (0..450)
            .map(|index| {
                let id = format!("chunk{index}");
                sample(&id, &id, "", 4.0, &["store"])
            })
            .collect();
        insert_businesses(&conn, &seeded, "", "", false).expect("seed");

        let ids: Vec<String> = seeded.iter().map(|row| row.place_id.clone()).collect();
        let loaded = businesses_by_ids(&conn, &ids).expect("chunked");
        assert_eq!(loaded.len(), 450);
    }
}
