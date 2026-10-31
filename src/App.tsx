import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Key as ReactKey,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import {
  Alert,
  App as AntdApp,
  Button,
  Checkbox,
  Dropdown,
  Empty,
  Modal,
  Popconfirm,
  Popover,
  Progress,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { InputRef, MenuProps } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { getVersion } from '@tauri-apps/api/app';
import {
  AimOutlined,
  ColumnHeightOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  DownOutlined,
  EnvironmentFilled,
  FacebookOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  InstagramOutlined,
  LinkedinOutlined,
  MailOutlined,
  FileDoneOutlined,
  SyncOutlined,
  MoreOutlined,
  PlusOutlined,
  StarFilled,
  XOutlined,
} from '@ant-design/icons';

import PanelHeader from './components/PanelHeader';
import type { PanelView } from './components/PanelHeader';
import JobQueue from './components/JobQueue';
import TaskDetail from './components/TaskDetail';
import MetricStrip from './components/MetricStrip';
import MapHealthNotice from './components/MapHealthNotice';
import type { MapHealth, SessionSummary } from './types/collector';
import FilterBar from './components/FilterBar';
import type { ContactFilter, RatingFilter, TaskFilter, TimeRange } from './components/FilterBar';
import BulkBar from './components/BulkBar';
import DetailDrawer from './components/DetailDrawer';
import DiagnosticsDrawer from './components/DiagnosticsDrawer';
import SettingsDrawer from './components/SettingsDrawer';
import ShortcutsDialog from './components/ShortcutsDialog';
import GridDialog from './components/GridDialog';
import SplitHandle, { DEFAULT_SPLIT } from './components/SplitHandle';
import type { Business, BusinessJobRef, BusinessPage, BusinessStats } from './types/business';
import type { Diagnostics } from './types/collector';
import type { Job } from './types/job';
import type { ExportCompleted } from './types/export';
import { useSettings } from './settings/SettingsContext';
import { renderFileName } from './settings/fileName';
import { linkLabel, safeHttpUrl } from './lib/url';
import { typeLabel } from './lib/text';
import { paneBusyMessageKey } from './lib/busy';
import { useI18n } from './i18n';
import { checkForUpdate, downloadAndInstall, type UpdateOffer } from './updater';

const { Text } = Typography;

/** How long a row keeps the "just arrived" highlight. */
const REVEAL_FLASH_MS = 1400;
/** Coalesce bursts of batches into one page refresh. */
const REFRESH_DEBOUNCE_MS = 300;
/** Typing in the search box should not fire a query per keystroke. */
const QUERY_DEBOUNCE_MS = 250;
/** "Select all filtered" materialises rows; keep that bounded. */
const MAX_SELECT_ALL = 2000;

/**
 * UI-04: the acceptance floor. Without the name the row is unidentifiable,
 * without the phone the most-copied field is gone, and without the action
 * column there is no way back — none of the three can be hidden.
 */
const MANDATORY_COLUMN_KEYS = new Set<string>(['name', 'phone', 'actions']);

/**
 * M10 / G-11: the export formats and the Rust command behind each one.
 */
type ExportKind = 'excel' | 'csv' | 'json' | 'jsonl';
const EXPORT_COMMANDS: Record<ExportKind, string> = {
  excel: 'export_excel',
  csv: 'export_csv',
  json: 'export_json',
  jsonl: 'export_jsonl',
};

/**
 * M10 / G-11: the hiddenColumns↔export linkage. Every table key that can gate
 * an export column. The width-gated picker only *offers* a subset at narrow
 * widths, but a hidden column is a deliberate user choice — so the export
 * reads the full key universe, not the current width's subset.
 */
const EXPORTABLE_TABLE_KEYS = [
  'name',
  'rating',
  'reviews',
  'phone',
  'task',
  'address',
  'collectedAt',
  'website',
  'types',
  'emails',
  'socials',
  'city',
  'open_hours',
  'owner_name',
] as const;

/**
 * M8 / J-08e: today's opening hours, in the business's own time zone.
 *
 * The day names come from Google in English, so the entry is looked up by
 * name rather than by position — the payload's day order is not guaranteed.
 * The weekday is resolved in the row's own zone: a business across the date
 * line is not open "today" when the collector is.
 *
 * Returns `null` when the payload carries no hours for today (or none at
 * all) and `''` when today is listed but closed.
 */
function todaysPeriods(row: Business): string | null {
  const hours = row.open_hours;
  if (!hours || hours.length === 0) return null;
  let name: string;
  try {
    name = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      timeZone: row.timezone || undefined,
    }).format(new Date());
  } catch {
    // An unknown or malformed zone must not break the table.
    name = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date());
  }
  const today = hours.find((day) => day.day.toLowerCase() === name.toLowerCase());
  if (!today) return null;
  return today.periods.join(', ');
}

/** The whole week as one line, for the cell's tooltip. */
function weekHours(row: Business): string {
  if (!row.open_hours || row.open_hours.length === 0) return '';
  return row.open_hours
    .map((day) => `${day.day}: ${day.periods.length ? day.periods.join(', ') : '—'}`)
    .join('; ');
}

const EMPTY_STATS: BusinessStats = {
  total: 0,
  all: 0,
  avgRating: 0,
  rated: 0,
  withPhone: 0,
  types: [],
};

type SortState = { field: string; direction: 'asc' | 'desc' };

// Collected-time formatting (UI-03). The cell shows the short form; the tooltip
// carries the full local timestamp plus the source search.
const pad2 = (value: number) => String(value).padStart(2, '0');
const formatCollectedShort = (ms: number) => {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const formatCollectedFull = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

/** Pick the matching social icon for a mined profile link (M7). */
const socialIcon = (url: string) => {
  const lowered = url.toLowerCase();
  if (lowered.includes('linkedin.com')) return <LinkedinOutlined />;
  if (lowered.includes('facebook.com') || lowered.includes('fb.com'))
    return <FacebookOutlined />;
  if (lowered.includes('instagram.com')) return <InstagramOutlined />;
  return <XOutlined />;
};

/** Last path segment, for "which file is this" labels in the panel. */
function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * Epoch-ms lower bound of the selected time dimension; `0` = no filter (R-33).
 *
 * A plain function on purpose: `today` and `7d` are moving targets, so the
 * window is computed when a query is built rather than when the picker changes.
 */
function timeWindowStart(
  range: TimeRange,
  sessionStartedAt: number | null,
  appStart: number,
): number {
  switch (range) {
    case 'session':
      return sessionStartedAt ?? appStart;
    case 'today': {
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      return day.getTime();
    }
    case '7d':
      return Date.now() - 7 * 24 * 60 * 60 * 1000;
    default:
      return 0;
  }
}

/**
 * Upper bound for `seenRef` (R-33). Rust dedupes for real; this set only feeds
 * the "N new" pill and the arrival highlight, both of which concern recent
 * rows. Without a cap every place id of the session stayed resident.
 */
const SEEN_LIMIT = 5000;

/**
 * Remember an id, dropping the oldest ones past `SEEN_LIMIT`. `Set` iterates in
 * insertion order, so deleting from the front is the cheapest trim available
 * without keeping a second structure.
 */
function rememberSeen(seen: Set<string>, id: string): void {
  seen.add(id);
  if (seen.size <= SEEN_LIMIT) return;
  const excess = seen.size - SEEN_LIMIT;
  let dropped = 0;
  for (const key of seen) {
    seen.delete(key);
    dropped += 1;
    if (dropped >= excess) break;
  }
}

export default function App() {
  const { message, modal } = AntdApp.useApp();
  const { t } = useI18n();
  const { settings, update } = useSettings();

  // Only the current page lives in the webview (M6): the table is a SQL query,
  // not a copy of the database. `stats` carries the totals the strip needs.
  const [rows, setRows] = useState<Business[]>([]);
  const [stats, setStats] = useState<BusinessStats>(EMPTY_STATS);
  // Starts true: the first page query kicks off in an effect, i.e. after the
  // first paint, and an initial `false` made the table look empty and (in the
  // collect view) flashed the "first run" presets before the row count arrived.
  const [loadingRows, setLoadingRows] = useState(true);
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** Live progress of the site miner (M7); null while idle. */
  const [emailMining, setEmailMining] = useState<{
    done: number;
    total: number;
    found: number;
  } | null>(null);
  /** Live progress of the detail-enrichment runner (Tier-2); null while idle. */
  const [enriching, setEnriching] = useState<{
    done: number;
    total: number;
    ok: number;
    failed: number;
  } | null>(null);
  /**
   * True while a reviews fetch owns the maps pane (C-01). The drawer owns the
   * fetch, so it reports the state up: while it runs the Rust side holds the
   * pane for ~12 s and every other pane action would be refused.
   */
  const [reviewsBusy, setReviewsBusy] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  /**
   * Bumped whenever `selectedRowsRef` is re-pointed at fresh row objects
   * (R-23). The ref itself cannot drive a render, so `selectedBusinesses`
   * reads this counter as its dependency: without it, a selection made before
   * an email-mining run kept exporting the pre-mining rows.
   */
  const [selectionVersion, setSelectionVersion] = useState(0);

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [rating, setRating] = useState<RatingFilter>('all');
  const [contact, setContact] = useState<ContactFilter>('all');
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  // Newest first by default (UI-03): the header shows an active "collected"
  // sort instead of an unlabeled insertion order.
  const [sort, setSort] = useState<SortState>({ field: 'collectedAt', direction: 'desc' });

  const [detail, setDetail] = useState<Business | null>(null);
  // UI-04: which row's action menu is open (null = none). The ⋯ button, the
  // right-click and Shift+F10 all set the same key, so the three entry points
  // share one menu definition.
  const [rowMenuKey, setRowMenuKey] = useState<string | null>(null);
  // UI-04: roving row focus. Only one row per page is a tab stop, so the
  // keyboard reaches the table without adding hundreds of tab stops; the
  // others stay programmatically focusable for the arrow-key walk.
  const [activeRowKey, setActiveRowKey] = useState<string | null>(null);
  // UI-05: the row key the drawer was last closed from. Focus returns to that
  // row and it carries a short outline, so closing the drawer never leaves the
  // user guessing where they were in the table.
  const [returnFocusKey, setReturnFocusKey] = useState<string | null>(null);
  const returnFocusTimerRef = useRef<number | null>(null);
  /** Last truthful drawer position, kept across an in-flight page load. */
  const lastDetailPositionRef = useRef(0);
  /**
   * UI-05: which end of the page the drawer should open on after a cross-page
   * step. The load is async, so the target is parked here until its rows land.
   */
  const pendingDetailEndRef = useRef<'first' | 'last' | null>(null);
  const [diagOpen, setDiagOpen] = useState(false);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Shortcut reference panel (UI-10): opened by `?` or the header button.
  const [helpOpen, setHelpOpen] = useState(false);
  // Area collection lives in its own dialog: it is a job with a lifecycle, not
  // another filter, and it must stay reachable while the table is empty.
  const [gridOpen, setGridOpen] = useState(false);
  /** Keyword a preset chip asked for; '' for every other entry point. */
  const [newKeyword, setNewKeyword] = useState('');
  // P1 / T-06: two views. The table keeps all its filters and state while the
  // user is on the collect view, because both branches read the same hooks.
  const [view, setView] = useState<PanelView>('collect');
  // T-08: a task opened from the list replaces the view's body. Holding the row
  // (not just the id) keeps the header correct while the list refreshes.
  const [openedTask, setOpenedTask] = useState<Job | null>(null);
  // A job that was interrupted by a crash or a kill is downgraded to `paused` on
  // startup. Offering to continue is the whole point of M3's resume support, so
  // the banner is the first thing the panel checks.
  const [resumeJob, setResumeJob] = useState<Job | null>(null);
  // T-02/T-04: tasks feed the picker above the table. The queue dialog keeps its
  // own copy for its list; this one exists so the picker does not need a modal.
  const [jobs, setJobs] = useState<Job[]>([]);
  /** `all`, a job id, or `__none__` for rows collected before tasks existed. */
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('all');
  /** P2: with a task pinned, show only what it found since the last export. */
  const [onlyNew, setOnlyNew] = useState(false);
  /** Job attribution for the rows currently on screen. */
  const [jobRefs, setJobRefs] = useState<BusinessJobRef[]>([]);

  /**
   * Clear every filter dimension.
   *
   * Defined above the long-lived event listeners so `data:cleared` can call it
   * too (P2-16): that listener used to reset the text/rating/contact/type
   * filters by hand and forgot `timeRange`, `taskFilter` and `onlyNew`,
   * leaving the emptied table filtered.
   */
  const resetFilters = useCallback(() => {
    setQuery('');
    // Apply the cleared text immediately: the 250 ms debounce would otherwise
    // keep querying the old term after the filters were visually reset.
    setDebouncedQuery('');
    setRating('all');
    setContact('all');
    setTimeRange('all');
    setTypeFilter([]);
    setTaskFilter('all');
    setOnlyNew(false);
  }, []);

  // Seeded from the settings Rust injected before the first paint, so the panel
  // starts at the persisted width and page size without a visible correction.
  const [split, setSplit] = useState(() =>
    settings.rememberSplit ? settings.splitRatio : DEFAULT_SPLIT,
  );
  // UI-11: the collapsed flag is persisted in settings; React mirrors it and
  // Rust owns the geometry. The effect below keeps both in step with whatever
  // `settings.mapCollapsed` currently is — including a settings reset.
  const [mapCollapsed, setMapCollapsed] = useState(settings.mapCollapsed);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(settings.pageSize);
  const [revealIds, setRevealIds] = useState<Set<string>>(() => new Set());
  // Rows that arrived while the user was reading an older page / scrolled up.
  // They are announced by a pill instead of moving the viewport underneath.
  const [unseen, setUnseen] = useState(0);
  const [bump, setBump] = useState({ count: 0, key: 0 });
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  // Last sign of life that reached the panel: a batch arrival *or* a tile
  // transition. Drives the liveness line on the listen card — an empty grid
  // cell legitimately produces no batches for 20-40 s while the runner is
  // working, so batches alone cannot tell "empty area" from "stuck map".
  // R-18: a ref, not state — bursts arrive per batch, and only the notice's
  // 1 s clock reads it, so writing it must not re-render the panel.
  const lastActivityRef = useRef<number | null>(null);
  // Health probe state from the Maps page (UI-01b): consent page / captcha /
  // no-results. `unknown` until the first report arrives.
  const [mapHealth, setMapHealth] = useState<MapHealth>('unknown');
  // Running totals of the current collecting session (UI-09), summed from the
  // Rust-emitted batch figures — the same numbers the diagnostics drawer shows.
  const [summary, setSummary] = useState<SessionSummary>({
    received: 0,
    inserted: 0,
    dropped: 0,
  });
  const [panelWidth, setPanelWidth] = useState(window.innerWidth);
  const [scrollY, setScrollY] = useState(400);
  // Path of the last export. Seeded from the persisted settings so the toolbar
  // entry survives a restart, then kept in sync by the `export:completed` event.
  const [lastExport, setLastExport] = useState<string | null>(settings.lastExportPath || null);
  // Auto-update (G-06): non-null while a newer version is on offer. The silent
  // startup check fills it; the settings drawer can trigger the same check by
  // hand. `updatePercent` is the download progress (null = unknown size).
  const [updateOffer, setUpdateOffer] = useState<UpdateOffer | null>(null);
  const [updatePercent, setUpdatePercent] = useState<number | null>(null);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  // The window's X while work is running. Rust prevents the close and emits
  // `app:close-requested` instead of killing the process mid-tile; this state
  // is the prompt that answers it. `null` = no prompt on screen.
  const [closePrompt, setClosePrompt] = useState<{
    jobRunning: boolean;
    emailMining: boolean;
  } | null>(null);
  /** Which button of the close prompt is in flight, so only it shows a spinner. */
  const [closingMode, setClosingMode] = useState<'pause' | 'force' | null>(null);

  const searchRef = useRef<InputRef>(null);
  // Mutable: the callback ref below assigns it, and `RefObject.current` is
  // readonly in the React 18 typings.
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  /** Size observer for the table card; rebuilt whenever the node is swapped. */
  const tableResizeRef = useRef<ResizeObserver | null>(null);
  /** Catches the guide card <-> table swap, which leaves the card's size alone. */
  const tableMutationRef = useRef<MutationObserver | null>(null);
  /** Current update offer, mirrored for the async check paths (no stale closure). */
  const updateOfferRef = useRef<UpdateOffer | null>(null);
  /** Version the user sent away with "Later"; a late silent check must not re-raise it. */
  const dismissedUpdateRef = useRef<string | null>(null);
  /** Set after the job list changes, so callbacks defined earlier can reload it. */
  const reloadJobsRef = useRef<() => void>(() => undefined);
  /** Last status seen per job, for the "task finished" toast (P2). */
  const jobStatusRef = useRef<Map<string, string>>(new Map());
  const seenRef = useRef<Set<string>>(new Set());
  /** Fallback lower bound for the "session" time filter before collecting starts. */
  const appStartRef = useRef(Date.now());
  /** Ids that arrived since the last page load and still need their highlight. */
  const pendingRevealRef = useRef<Set<string>>(new Set());
  // Selected rows survive page changes: the keys alone cannot be exported, and
  // re-reading them from SQL on every tick would defeat the point of paging.
  const selectedRowsRef = useRef<Map<string, Business>>(new Map());
  const bumpKeyRef = useRef(0);
  /** "N new" pill timer; held so unmount can clear it (R-33). */
  const bumpTimerRef = useRef<number | null>(null);
  /** Generation counter for "select all filtered"; a new run supersedes (R-33). */
  const selectAllRunRef = useRef(0);
  const scrollYRef = useRef(400);
  const unlistenRef = useRef<UnlistenFn[]>([]);
  const revealTimersRef = useRef<Map<string, number>>(new Map());
  const scrollRafRef = useRef<number | null>(null);
  /** The user is watching the newest rows, so a new page keeps following them. */
  const followTailRef = useRef(true);
  const refreshTimerRef = useRef<number | null>(null);
  /** Latest loader, so the event listener never calls a stale closure. */
  const loadPageRef = useRef<() => void>(() => {});
  /** Ignore responses that belong to an older filter/page. */
  const requestIdRef = useRef(0);
  /** Mirror of `listening` for the long-lived event listeners (no stale closure). */
  const listeningRef = useRef(false);
  // P3-4: a `listening:changed` event is newer than the `get_collector_state`
  // snapshot that was already in flight; without this flag the older snapshot
  // could overwrite the event's state on startup.
  const listeningEventSeenRef = useRef(false);
  /** Whether the current listening session already showed the hands-off hint. */
  const firstBatchHintRef = useRef(false);
  // Long-lived event listeners and mount-only effects read the latest translator
  // through this ref: `t` changes identity per locale, and re-subscribing on a
  // language switch would replay side effects (re-fetch, re-register events).
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  // Single point where the panel's listening state changes: it keeps the ref
  // read by the event listeners in sync and re-arms the first-batch hint on
  // every start (toggle, restart, grid job — each session reminds once).
  const applyListening = useCallback((next: boolean) => {
    listeningRef.current = next;
    if (next) firstBatchHintRef.current = false;
    setListening(next);
  }, []);

  // The switch also has to be read once: `listening:changed` only fires on a
  // transition, so a panel reload (dev HMR, a rebuilt webview) used to sit on
  // `false` while the runner was collecting. Rust is the owner; this is the
  // panel catching up with it.
  useEffect(() => {
    let cancelled = false;
    void invoke<{ listening: boolean; sessionStartedAt: number | null }>(
      'get_collector_state',
    )
      .then((state) => {
        if (cancelled) return;
        // A `listening:changed` event already delivered newer state; applying
        // this older snapshot would undo it (P3-4).
        if (listeningEventSeenRef.current) return;
        applyListening(state.listening);
        if (state.listening) {
          setSessionStartedAt((prev) => prev ?? state.sessionStartedAt ?? Date.now());
          // The last batch is unknown; start the liveness clock now rather than
          // immediately warning about a silence that predates the reload.
          lastActivityRef.current = Date.now();
        }
      })
      .catch((error) => {
        console.log('[Placemill] collector state unavailable:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [applyListening]);

  // Shared by the export toast and the toolbar entry. `t` is read through the
  // ref so this callback keeps a stable identity across language switches (the
  // event listener effect depends on it).
  const revealExport = useCallback(async () => {
    try {
      await invoke('reveal_export');
    } catch (error) {
      message.error(tRef.current('toast.revealFailed', { error: String(error) }));
    }
  }, [message]);

  // The settings drawer can change both of these, and `useState` initial values
  // never recompute — follow the settings explicitly instead.
  useEffect(() => {
    setPageSize(settings.pageSize);
  }, [settings.pageSize]);

  useEffect(() => {
    if (settings.rememberSplit) setSplit(settings.splitRatio);
  }, [settings.splitRatio, settings.rememberSplit]);

  // Restoring the settings (reset) clears the remembered path on the Rust side;
  // follow it so a stale toolbar entry cannot point at a dropped preference.
  useEffect(() => {
    setLastExport(settings.lastExportPath || null);
  }, [settings.lastExportPath]);

  // UI-11: the persisted flag is the single source of truth. Every change —
  // the toggle, a settings reset, a startup restore — lands here and is pushed
  // to Rust as geometry. Idempotent, so the mount call is harmless.
  useEffect(() => {
    setMapCollapsed(settings.mapCollapsed);
    void invoke('set_map_collapsed', { collapsed: settings.mapCollapsed }).catch(
      (error) => {
        console.warn('[Placemill] set_map_collapsed failed:', error);
      },
    );
  }, [settings.mapCollapsed]);

  // One write path: persist through settings; the effect above applies it.
  const toggleMapCollapsed = useCallback(() => {
    const next = !settings.mapCollapsed;
    setMapCollapsed(next);
    void update({ mapCollapsed: next }).catch((error) => {
      console.error('[Placemill] failed to persist mapCollapsed:', error);
      setMapCollapsed(settings.mapCollapsed);
    });
  }, [settings.mapCollapsed, update]);

  const medium = panelWidth >= 700;
  const wide = panelWidth >= 920;

  // ========== Page loading ==========
  // The request body is shared by browsing and "export everything that matches":
  // one definition means the file always contains what the table shows.

  /**
   * R-18: the "only new" lower bound as a scalar. `filterRequest` used to depend
   * on the whole `jobs` array just to read one task's export watermark, so every
   * tile of a running job changed its identity — reloading the page from SQL and
   * re-rendering the table once per tile. The memo returns a primitive that only
   * changes when the pinned task's watermark does.
   */
  const jobSeenSince = useMemo(
    () =>
      onlyNew && taskFilter !== 'all' && taskFilter !== '__none__'
        ? (jobs.find((job) => job.id === taskFilter)?.lastExportedAt ?? 0)
        : 0,
    [jobs, onlyNew, taskFilter],
  );

  const filterRequest = useCallback(
    () => ({
      query: debouncedQuery,
      rating,
      contact,
      types: typeFilter,
      // T-02: the task dimension is a real filter now; `__none__` asks for rows
      // no job has observed (free-listening leftovers).
      jobId: taskFilter === 'all' || taskFilter === '__none__' ? '' : taskFilter,
      unassigned: taskFilter === '__none__',
      // A task filter with "only new" narrows to places this task first saw
      // after its last export (P2).
      jobSeenSince,
      // R-33: computed per call — `today`/`7d` move, and a memo froze them.
      collectedSince: timeWindowStart(timeRange, sessionStartedAt, appStartRef.current),
      sort: sort.field,
      direction: sort.direction,
    }),
    [
      debouncedQuery,
      rating,
      contact,
      typeFilter,
      taskFilter,
      jobSeenSince,
      sort,
      timeRange,
      sessionStartedAt,
    ],
  );

  /**
   * The task holding the runner. Single-flight is a product rule (one map, one
   * scroll, lower ban risk), so the collect view disables every other "start".
   */
  const runningJob = useMemo(
    () => jobs.find((job) => job.status === 'running') ?? null,
    [jobs],
  );

  /**
   * Another operation owns the Maps pane, so anything that navigates it must
   * refuse (C-01/C-10). Covers the three states the panel can observe — a
   * running task, an enrichment run and a reviews fetch — plus an active
   * collecting session, which the backend also refuses.
   */
  const paneBusyElsewhere = Boolean(runningJob) || Boolean(enriching) || reviewsBusy || listening;



  /** Task the table is pinned to; `null` for "all" and "unassigned" (T-11). */
  const currentTask = useMemo(
    () =>
      taskFilter === 'all' || taskFilter === '__none__'
        ? null
        : (jobs.find((job) => job.id === taskFilter) ?? null),
    [jobs, taskFilter],
  );

  /** Rows that arrived since the last load get the arrival highlight. */
  const highlightNewRows = useCallback((next: Business[]) => {
    const fresh = next.filter((row) => pendingRevealRef.current.has(row.place_id));
    fresh.forEach((row) => pendingRevealRef.current.delete(row.place_id));
    if (fresh.length === 0) return;

    setRevealIds((prev) => {
      const updated = new Set(prev);
      fresh.forEach((row) => updated.add(row.place_id));
      return updated;
    });
    fresh.forEach((row) => {
      const existing = revealTimersRef.current.get(row.place_id);
      if (existing !== undefined) window.clearTimeout(existing);
      revealTimersRef.current.set(
        row.place_id,
        window.setTimeout(() => {
          revealTimersRef.current.delete(row.place_id);
          setRevealIds((prev) => {
            if (!prev.has(row.place_id)) return prev;
            const updated = new Set(prev);
            updated.delete(row.place_id);
            return updated;
          });
        }, REVEAL_FLASH_MS),
      );
    });
  }, []);

  const loadPage = useCallback(async () => {
    const request = ++requestIdRef.current;
    setLoadingRows(true);
    try {
      const result = await invoke<BusinessPage>('query_businesses', {
        request: { ...filterRequest(), page, pageSize },
      });
      // A slower response from an older filter must not overwrite the new one.
      if (request !== requestIdRef.current) return;
      setRows(result.rows);
      setJobRefs(result.jobRefs);
      setStats({
        total: result.total,
        all: result.all,
        avgRating: result.avgRating,
        rated: result.rated,
        withPhone: result.withPhone,
        types: result.types,
      });
      highlightNewRows(result.rows);
    } catch (error) {
      if (request === requestIdRef.current) {
        // R-33: this is a table query, not an undo — the old key told the user
        // the wrong thing entirely.
        message.error(tRef.current('toast.queryFailed', { error: String(error) }));
      }
    } finally {
      if (request === requestIdRef.current) setLoadingRows(false);
    }
  }, [filterRequest, page, pageSize, highlightNewRows, message]);

  useEffect(() => {
    loadPageRef.current = () => void loadPage();
  }, [loadPage]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  // A new filter or sort always starts at the first page. The time range, the
  // "only new" toggle and the session start (R-33) are part of that: all of
  // them change which rows match.
  useEffect(() => {
    setPage(1);
  }, [debouncedQuery, rating, contact, typeFilter, taskFilter, timeRange, onlyNew, sessionStartedAt, sort]);

  // Typing should not query per keystroke; the other filters fire immediately.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  /** Coalesce a burst of batches into one refresh. */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      loadPageRef.current();
    }, REFRESH_DEBOUNCE_MS);
  }, []);

  useEffect(
    () => () => {
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
      if (bumpTimerRef.current !== null) window.clearTimeout(bumpTimerRef.current);
      revealTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      revealTimersRef.current.clear();
      if (returnFocusTimerRef.current !== null) {
        window.clearTimeout(returnFocusTimerRef.current);
      }
    },
    [],
  );

  // ========== Backend events ==========

  /**
   UI-02b: put back the rows of the last clear. Rust refuses once its 10 s
   window lapses, and the error is surfaced as-is — "nothing to undo" is the
   honest outcome, and the page refresh rides the `businesses:updated` event
   Rust emits alongside the restore. */
  const handleUndoClear = useCallback(
    async (toastKey: string) => {
      try {
        const restored = await invoke<number>('undo_clear');
        message.destroy(toastKey);
        message.success(tRef.current('toast.undoCleared', { count: restored }));
      } catch (error) {
        message.destroy(toastKey);
        message.error(tRef.current('toast.undoFailed', { error: String(error) }));
      }
    },
    // R-33: `t` used to be a dependency, so switching language changed this
    // callback and re-subscribed every backend listener (the effect below
    // depends on it). The ref keeps the callback stable; the listener effect
    // now survives a locale change.
    [message],
  );

  /**
   Answer the close prompt. `pause` lets Rust put the job back to `paused` and
   the tile it was scrolling back to `pending` before the process exits, so the
   next start can resume; `force` leaves that to startup recovery.
   */
  const exitApp = useCallback(
    async (mode: 'pause' | 'force') => {
      setClosingMode(mode);
      try {
        await invoke('close_app', { mode });
      } catch (error) {
        setClosingMode(null);
        message.error(tRef.current('close.failed', { error: String(error) }));
      }
    },
    [message],
  );

  useEffect(() => {
    let cancelled = false;

    Promise.allSettled([
      listen<Business[]>('businesses:updated', (event) => {
        const incoming = event.payload ?? [];
        // Recorded before the dedupe below: a batch made entirely of known rows
        // still proves the map is feeding us, which is what the liveness line
        // reports. Duplicates are a filter concern, not a "nothing is happening"
        // signal.
        if (incoming.length > 0) {
          lastActivityRef.current = Date.now();
          // First batch of a listening session: data is flowing, and anything
          // the user does on the map now (pan, zoom, another search) restarts
          // the auto-scroll and widens what gets collected. One reminder per
          // session, re-armed by applyListening on the next start.
          if (listeningRef.current && !firstBatchHintRef.current) {
            firstBatchHintRef.current = true;
            message.info(tRef.current('toast.collectingHint'));
          }
        }

        const fresh = incoming.filter(
          (item) => item.place_id && !seenRef.current.has(item.place_id),
        );
        if (fresh.length === 0) {
          // Totals do not change, but the page may still be stale after a
          // settings change; a cheap refresh keeps the counts honest.
          scheduleRefresh();
          return;
        }

        // Mark them now so the same batch counted twice cannot inflate the
        // "N new" pill; the highlight is applied when the page reloads.
        fresh.forEach((item) => {
          rememberSeen(seenRef.current, item.place_id);
          // Same bound as `seenRef`: the reveal set only shrinks when the user
          // actually reaches the page holding the id (P3-3).
          rememberSeen(pendingRevealRef.current, item.place_id);
        });

        bumpKeyRef.current += 1;
        const key = bumpKeyRef.current;
        setBump({ count: fresh.length, key });
        // R-33: held in a ref so the unmount cleanup can cancel it.
        if (bumpTimerRef.current !== null) window.clearTimeout(bumpTimerRef.current);
        bumpTimerRef.current = window.setTimeout(() => {
          bumpTimerRef.current = null;
          setBump((current) => (current.key === key ? { ...current, count: 0 } : current));
        }, 2200);

        // Only announce when the user is not watching the tail; otherwise the
        // refreshed page keeps the viewport where it is.
        if (!followTailRef.current) setUnseen((prev) => prev + fresh.length);
        scheduleRefresh();
      }),
      listen<{ done: number; total: number; found: number }>('email:progress', (event) => {
        setEmailMining(event.payload);
      }),
      listen<{ done: number; total: number; ok: number; failed: number }>(
        'enrich:progress',
        (event) => {
          setEnriching(event.payload);
        },
      ),
      listen<{ ok: number; failed: number; cancelled: boolean }>('enrich:completed', (event) => {
        const { ok, failed, cancelled } = event.payload;
        setEnriching(null);
        if (cancelled) {
          message.warning(tRef.current('toast.enrichCancelled', { ok, failed }));
        } else {
          message.success(tRef.current('toast.enrichDone', { ok, failed }));
        }
        // The runner writes straight to SQLite; repaint the current page and
        // pull the selection back so the drawer shows the fresh details (same
        // pattern the email miner's completion uses).
        void loadPageRef.current();
        const selection = [...selectedRowsRef.current.keys()];
        if (selection.length > 0) {
          void invoke<Business[]>('selected_businesses', { placeIds: selection })
            .then((fresh) => {
              if (fresh.length === 0) return;
              fresh.forEach((row) => selectedRowsRef.current.set(row.place_id, row));
              setSelectionVersion((value) => value + 1);
            })
            .catch(() => {
              /* not fatal: the next page turn repaints anyway */
            });
        }
      }),
      listen<{
        total: number;
        done: number;
        found: number;
        blocked: number;
        failed: number;
        cancelled: boolean;
      }>('email:done', (event) => {
        const { done, total, found, cancelled } = event.payload;
        setEmailMining(null);
        if (cancelled) {
          message.info(tRef.current('toast.emailMineCancelled', { done, total }));
        } else {
          message.success(tRef.current('toast.emailMineDone', { found, done, total }));
        }
        // Mined rows changed in SQLite; repaint the current page.
        void loadPageRef.current();
        // R-23: the page reload refreshes only what is visible, while the
        // selection can span several pages. Fetch those rows back so a later
        // export carries the emails this run just found.
        const selection = [...selectedRowsRef.current.keys()];
        if (selection.length > 0) {
          void invoke<Business[]>('selected_businesses', { placeIds: selection })
            .then((fresh) => {
              if (fresh.length === 0) return;
              fresh.forEach((row) => selectedRowsRef.current.set(row.place_id, row));
              setSelectionVersion((value) => value + 1);
            })
            .catch((error) => {
              // Not fatal: the selection keeps its previous rows and the export
              // still runs; the diagnostics drawer records nothing here.
              console.log('[Placemill] selection refresh failed:', error);
            });
        }
      }),
      listen<{ received: number; inserted: number; dropped: number }>(
        'collector:batch',
        (event) => {
          // UI-09: the figures come from the same `store_businesses` call that
          // feeds the diagnostics drawer, so the two can never disagree.
          const { received, inserted, dropped } = event.payload;
          setSummary((prev) => ({
            received: prev.received + received,
            inserted: prev.inserted + inserted,
            dropped: prev.dropped + dropped,
          }));
        },
      ),
      // UI-01b: the Maps page's own health probe (consent / captcha /
      // no-results). Only known states are accepted — anything else keeps the
      // previous honest value instead of inventing one.
      listen<{ state: string }>('maps:health', (event) => {
        // A probe that was already in flight when the session ended must not
        // light the red card while nothing is collecting: the page stops
        // probing when the switch goes off, but the last event can still land.
        if (!listeningRef.current) return;
        const state = event.payload?.state;
        if (
          state === 'ok' ||
          state === 'consent' ||
          state === 'captcha' ||
          state === 'no-results' ||
          // R-10: the parse path reports a broken field map through the same
          // channel — three real search bodies with zero parsed rows.
          state === 'parse-degraded'
        ) {
          setMapHealth(state);
        }
      }),
      // Probe run (§5.8 A1): the runner paused the job right after its first
      // tile — that tile count IS the verdict on the keyword.
      listen<{ jobId: string; count: number }>('probe:completed', (event) => {
        const { count } = event.payload;
        if (count > 0) {
          message.success(tRef.current('grid.probeDoneOk', { count }));
        } else {
          message.warning(tRef.current('grid.probeDoneEmpty'));
        }
      }),
      listen<boolean>('listening:changed', (event) => {
        listeningEventSeenRef.current = true;
        applyListening(event.payload);
        if (event.payload) {
          setSessionStartedAt((prev) => prev ?? Date.now());
          // A new session starts its own summary (UI-09).
          setSummary({ received: 0, inserted: 0, dropped: 0 });
        } else {
          // The probe goes silent when the switch is off; a stale warning must
          // not outlive the session it belonged to.
          setMapHealth('unknown');
        }
        // Restart the clock from the switch, not from the previous session: a
        // stale timestamp would warn immediately after pressing start.
        lastActivityRef.current = event.payload ? Date.now() : null;
      }),
      listen<string[]>('settings:corrected', (event) => {
        // R-25: the backend clamped or dropped a value rather than failing the
        // save. Without this the panel would show "saved" for a value the user
        // never actually got.
        if (!Array.isArray(event.payload) || event.payload.length === 0) return;
        message.warning(
          tRef.current('toast.settingsCorrected', { fields: event.payload.join(', ') }),
        );
      }),
      listen<ExportCompleted>('export:completed', (event) => {
        const { count, format, path, failedRows = 0 } = event.payload;
        setLastExport(path);
        const key = `export-${Date.now()}`;
        // R-25: rows the writer rejected mean the file is incomplete — that is a
        // warning, not the green "exported N records" toast.
        const content = (
          <Space size={4}>
            <span>
              {failedRows > 0
                ? tRef.current('toast.exportedPartial', {
                    count,
                    format: format === 'xlsx' ? 'Excel' : 'CSV',
                    failed: failedRows,
                  })
                : tRef.current('toast.exported', {
                    count,
                    format: format === 'xlsx' ? 'Excel' : 'CSV',
                  })}
            </span>
            <Button
              type="link"
              size="small"
              style={{ padding: 0 }}
              onClick={() => {
                message.destroy(key);
                void revealExport();
              }}
            >
              {tRef.current('toast.openExportFolder')}
            </Button>
          </Space>
        );
        // The toast doubles as the entry point for the export folder, so it has
        // to outlive the default 3 s — otherwise the button vanishes before the
        // user can reach it. A partial export stays longer: it carries a
        // problem the user has to read.
        if (failedRows > 0) {
          message.warning({ key, duration: 12, content });
        } else {
          message.success({ key, duration: 8, content });
        }
      }),
      // Emitted by the export commands when the configured folder is unusable:
      // they fall back to the save dialog, and the user deserves to know why a
      // window they thought they had disabled just appeared.
      listen<string>('export:dirUnavailable', (event) => {
        message.warning(
          tRef.current('toast.exportDirFallback', { dir: event.payload ?? '' }),
        );
      }),
      listen('data:cleared', () => {
        seenRef.current = new Set();
        // R-33: the per-job status map is keyed by ids that no longer exist.
        jobStatusRef.current.clear();
        // Anything still collecting ids is now selecting from a wiped table.
        selectAllRunRef.current += 1;
        pendingRevealRef.current.clear();
        selectedRowsRef.current.clear();
        revealTimersRef.current.forEach((timer) => window.clearTimeout(timer));
        revealTimersRef.current.clear();
        setRevealIds(new Set());
        setRows([]);
        setStats(EMPTY_STATS);
        setPage(1);
        setUnseen(0);
        setSelectedKeys([]);
        applyListening(false);
        setSessionStartedAt(null);
        lastActivityRef.current = null;
        setDetail(null);
        // The session totals describe rows that no longer exist (UI-09).
        setSummary({ received: 0, inserted: 0, dropped: 0 });
        setMapHealth('unknown');
        // Reset filters too, otherwise a stale filter would hide the (now empty)
        // filter bar and leave the table stuck on "no matching records". One
        // helper, not eight setters: the hand-written list used to forget
        // `timeRange`, `taskFilter` and `onlyNew` (P2-16).
        resetFilters();
        // Sort is reset separately: `resetFilters` only touches filters, and a
        // cleared table should come back in the default newest-first order.
        setSort({ field: 'collectedAt', direction: 'desc' });
        // UI-02b: the toast doubles as the undo entry, so it outlives the
        // default 3 s — the window matches Rust's `UNDO_CLEAR_WINDOW`.
        const undoKey = `cleared-${Date.now()}`;
        message.success({
          key: undoKey,
          duration: 10,
          content: (
            <Space size={4}>
              <span>{tRef.current('toast.dataCleared')}</span>
              <Button
                type="link"
                size="small"
                style={{ padding: 0 }}
                onClick={() => void handleUndoClear(undoKey)}
              >
                {tRef.current('common.undo')}
              </Button>
            </Space>
          ),
        });
      }),
      // Rust refused the window close because work was running and is asking
      // what to do. Anything else (idle close) never reaches the panel.
      listen<{ jobId: string | null; emailMining: boolean }>(
        'app:close-requested',
        (event) => {
          setClosePrompt({
            jobRunning: Boolean(event.payload?.jobId),
            emailMining: Boolean(event.payload?.emailMining),
          });
        },
      ),
    ])
      .then((results) => {
        // P3-4: `Promise.all` rejects on the first failed `listen`, and the
        // handles that did succeed were lost until the next reload. Collect
        // every fulfilled handle, release them if the effect already cleaned
        // up, and report the failure once.
        const fns = results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        );
        if (cancelled) {
          fns.forEach((fn) => fn());
          return;
        }
        unlistenRef.current = fns;
        const failed = results.find((result) => result.status === 'rejected');
        if (failed && failed.status === 'rejected') {
          message.error(
            tRef.current('toast.subscribeFailed', { error: String(failed.reason) }),
          );
        }
      });

    return () => {
      cancelled = true;
      unlistenRef.current.forEach((fn) => fn());
      unlistenRef.current = [];
    };
  }, [message, scheduleRefresh, revealExport, applyListening, handleUndoClear, resetFilters]);

  // ========== Layout measurements ==========
  useEffect(() => {
    const onResize = () => setPanelWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // `scroll.y` 只约束表体，所以要从卡片高度里减掉表头和分页条真实占掉的部分。
  // 分页条在 App.css 里是 `margin: 8px 12px !important`，上下各 8px。
  const measureTableHeight = useCallback(() => {
    const node = tableWrapRef.current;
    if (!node) return;
    const header = node.querySelector<HTMLElement>('.ant-table-thead');
    const footer = node.querySelector<HTMLElement>('.ant-table-pagination');
    const furniture =
      (header?.offsetHeight ?? 39) + (footer ? footer.offsetHeight + 16 : 72);
    const next = Math.max(160, Math.round(node.clientHeight - furniture));
    if (Math.abs(next - scrollYRef.current) > 2) {
      scrollYRef.current = next;
      setScrollY(next);
    }
  }, []);

  // Track whether the table body is scrolled to the bottom, so streaming rows
  // only steal the scroll position while the user is already following them.
  // Capture phase: the scroll happens on `.ant-table-body`, not on the card.
  const onTableScroll = useCallback((event: Event) => {
    const target = event.target as HTMLElement | null;
    if (!target || !target.classList.contains('ant-table-body')) return;
    const distance = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (distance < 24) {
      // Reaching the bottom by hand means the backlog has been seen, and it
      // re-arms follow-the-tail: before this, scrolling back down cleared the
      // counter but new batches never followed again (P3-2).
      setUnseen(0);
      followTailRef.current = true;
    } else {
      // Scrolling up is an explicit "stop following me".
      followTailRef.current = false;
    }
  }, []);

  // The table only exists on the data view, and the app mounts on the collect
  // view — an effect with `[]` reads a null ref, returns, and never runs again.
  // That is how `scrollY` stayed at its 400 initial value (a 50-row page showed
  // ~8 rows with a screen of blank under them) and why the scroll listener above
  // never fired either. A callback ref attaches both when the node appears.
  const attachTableWrap = useCallback(
    (node: HTMLDivElement | null) => {
      const previous = tableWrapRef.current;
      if (previous) previous.removeEventListener('scroll', onTableScroll, true);
      tableWrapRef.current = node;
      tableResizeRef.current?.disconnect();
      tableResizeRef.current = null;
      tableMutationRef.current?.disconnect();
      tableMutationRef.current = null;
      if (!node) return;
      const observer = new ResizeObserver(() => measureTableHeight());
      observer.observe(node);
      tableResizeRef.current = observer;
      // The empty-state guide and the table swap inside this card without
      // changing its size, so the size observer stays silent and the body would
      // keep a height measured against the guide.
      const mutations = new MutationObserver(() => measureTableHeight());
      mutations.observe(node, { childList: true });
      tableMutationRef.current = mutations;
      node.addEventListener('scroll', onTableScroll, true);
      // The pagination is not in the DOM on the very first measurement frame.
      window.requestAnimationFrame(() => measureTableHeight());
    },
    [measureTableHeight, onTableScroll],
  );

  // ========== Actions ==========
  // There is no standalone collection switch any more: the map is driven by a
  // task, and Enter pauses/resumes whichever task owns it.
  const toggleCurrentTask = useCallback(async () => {
    if (starting) return;
    const target = runningJob ?? jobs.find((job) => job.status === 'paused') ?? null;
    if (!target) {
      message.info(t('shortcuts.noTask'));
      return;
    }
    setStarting(true);
    try {
      await invoke(target.status === 'running' ? 'pause_job' : 'resume_job', {
        id: target.id,
      });
      reloadJobsRef.current();
    } catch (error) {
      message.error(t('queue.actionFailed', { error: String(error) }));
    } finally {
      setStarting(false);
    }
  }, [starting, runningJob, jobs, message, t]);

  // Offer to continue an interrupted job. One-shot on mount: a paused job the
  // user chose to ignore must not reappear on every re-render.
  useEffect(() => {
    let cancelled = false;
    void invoke<Job[]>('list_jobs')
      .then((list) => {
        if (cancelled) return;
        setJobs(list);
        setResumeJob(list.find((job) => job.status === 'paused') ?? null);
      })
      .catch((error) => {
        if (cancelled) return;
        // R-34: without the list the "unfinished task" banner never appears, so
        // a paused job silently stayed paused. Say it once, at startup.
        console.error('[Placemill] list_jobs failed on startup:', error);
        message.error(tRef.current('toast.jobsLoadFailed', { error: String(error) }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The picker follows the runner. A job inserted by the dialog is added by
  // `onJobsCreated` (a "create without start" never emits progress), everything
  // else arrives here.
  useEffect(() => {
    // R-07: `listen()` resolves asynchronously, so cleanup can run before the
    // promise does (StrictMode mount→unmount→mount always hits this). A bare
    // `let dispose` leaves the first subscription alive forever and the next
    // mount adds a second one; the `cancelled` flag unlistens the late
    // resolution instead. Same pattern as the backend-event effect below.
    let un: UnlistenFn | undefined;
    let cancelled = false;
    void listen<Job>('job:progress', (event) => {
      setJobs((previous) => {
        const index = previous.findIndex((job) => job.id === event.payload.id);
        if (index === -1) return [event.payload, ...previous];
        const next = previous.slice();
        next[index] = event.payload;
        return next;
      });
      setOpenedTask((current) =>
        current && current.id === event.payload.id ? event.payload : current,
      );

      // A tile transition is a sign of life too: an empty cell produces no
      // batches for 20-40 s while the runner moves on to the next one, and the
      // liveness card must not call that a stalled map.
      if (event.payload.status === 'running') {
        lastActivityRef.current = Date.now();
      }

      // P2: a task that just finished is worth a toast — the runner may have
      // been working for half an hour while the user was in another view.
      const before = jobStatusRef.current.get(event.payload.id);
      jobStatusRef.current.set(event.payload.id, event.payload.status);
      if (before && before !== 'completed' && event.payload.status === 'completed') {
        message.success(
          tRef.current('toast.taskCompleted', {
            name: event.payload.name || event.payload.keyword,
            count: event.payload.foundCount,
          }),
        );
      }
    }).then((fn) => {
      if (cancelled) fn();
      else un = fn;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  // ========== Auto-update (G-06) ==========
  // The only path an offer enters or leaves the state through: the previous
  // handle's Rust resource is released here, so neither a replace (late check
  // overtaking a manual one) nor a dismiss can leak a rid. A *successful*
  // install closes the resource on the Rust side by itself.
  const offerUpdate = useCallback((offer: UpdateOffer | null) => {
    const previous = updateOfferRef.current;
    updateOfferRef.current = offer;
    setUpdateOffer(offer);
    if (previous && previous !== offer) {
      void previous.update.close().catch(() => {});
    }
  }, []);

  // Shared by the startup effect and the settings drawer. `manual` decides
  // whether the outcome is worth a toast; the translator is read through the
  // ref so the callback identity stays stable across language switches. A
  // silent check also stays quiet about a version the user already dismissed.
  const checkUpdates = useCallback(
    async (manual: boolean) => {
      try {
        const offer = await checkForUpdate();
        if (offer) {
          if (!manual && dismissedUpdateRef.current === offer.version) return;
          offerUpdate(offer);
          return;
        }
        if (manual) {
          const version = await getVersion();
          message.success(tRef.current('update.upToDate', { version }));
        }
      } catch (error) {
        if (manual) {
          message.error(tRef.current('update.checkFailed', { error: String(error) }));
        } else {
          console.log('[Placemill] update check failed:', error);
        }
      }
    },
    [message, offerUpdate],
  );

  // One silent check per start: a failed check (offline, no release published
  // yet) is not the user's problem, so it only lands in the console. A newer
  // version raises the offer modal instead of interrupting anything.
  useEffect(() => {
    void checkUpdates(false);
  }, [checkUpdates]);

  const installUpdate = useCallback(async () => {
    if (!updateOffer || updateInstalling) return;
    setUpdateInstalling(true);
    setUpdatePercent(null);
    try {
      await downloadAndInstall(updateOffer, setUpdatePercent);
      // Windows/NSIS exits and relaunches from inside `install()`; if that
      // ever changes, the modal stays open with the progress bar at 100%.
    } catch (error) {
      message.error(tRef.current('update.installFailed', { error: String(error) }));
      setUpdateInstalling(false);
      setUpdatePercent(null);
    }
  }, [updateOffer, updateInstalling, message]);

  const handleResumeJob = useCallback(async () => {
    if (!resumeJob) return;
    try {
      await invoke('resume_job', { id: resumeJob.id });
      setResumeJob(null);
      message.info(t('queue.resumed'));
    } catch (error) {
      message.error(t('queue.actionFailed', { error: String(error) }));
      // A rejected resume means the job is no longer paused (cancelled,
      // deleted under us): the failed state change emits no progress event,
      // so the banner would survive on a dead entry. Re-sync with the list.
      reloadJobsRef.current();
    }
  }, [resumeJob, message, t]);

  // Resuming from the queue tab must not leave a stale "unfinished job" banner
  // behind: the banner only makes sense while the job is paused.
  useEffect(() => {
    if (!resumeJob) return;
    // R-07: same async-resolution race as the effect above — every change of
    // `resumeJob` re-runs this effect, so the promise of one run can resolve
    // after the cleanup of that run. Late resolutions must unlisten.
    let un: UnlistenFn | undefined;
    let cancelled = false;
    void listen<Job>('job:progress', (event) => {
      if (event.payload.id === resumeJob.id && event.payload.status !== 'paused') {
        setResumeJob(null);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else un = fn;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [resumeJob]);

  // Reload the Maps webview (UI-01a): the way out of a consent page, a
  // captcha, or a wedged results view. The collector switch survives the
  // reload (localStorage mirror in intercept.js), so only the liveness clock
  // is re-armed here.
  const handleReloadMap = useCallback(async () => {
    // Reload stays allowed on purpose: it is the way out of a consent page or
    // a wedged view, i.e. the state that is already costing the user time. It
    // does replace the document a reviews fetch or the enrichment runner is
    // reading, so say that out loud instead of failing silently (C-11). The
    // review rows are guarded against a wrong-place write in Rust (C-02).
    if (reviewsBusy || enriching) {
      message.warning(t('toast.reloadInterruptsPane'));
    }
    try {
      await invoke('reload_maps');
      lastActivityRef.current = Date.now();
      setMapHealth('unknown');
      message.info(t('toast.mapReloading'));
    } catch (error) {
      message.error(t('toast.mapReloadFailed', { error: String(error) }));
    }
  }, [reviewsBusy, enriching, message, t]);

  // Recovery action for a wedged scroll loop. It must not toggle the raw switch:
  // turning listening off is now a task pause, so a pause + resume is the
  // supported way to restart the runner that owns the map.
  const handleRestartCollector = useCallback(async () => {
    if (starting) return;
    if (!runningJob) {
      message.info(t('shortcuts.noRunningTask'));
      return;
    }
    setStarting(true);
    try {
      await invoke('pause_job', { id: runningJob.id });
      await invoke('resume_job', { id: runningJob.id });
      message.info(t('toast.collectorRestarted'));
      reloadJobsRef.current();
    } catch (error) {
      message.error(t('toast.collectorFailed', { error: String(error) }));
    } finally {
      setStarting(false);
    }
  }, [starting, runningJob, message, t]);

  // Declared after the derived block below: it needs the current filter and the
  // selection, both of which are computed from the page state.

  const handleClear = useCallback(async () => {
    try {
      await invoke('clear_data');
    } catch (error) {
      message.error(t('toast.clearFailed', { error: String(error) }));
    }
  }, [message, t]);

  const handleLocate = useCallback(
    async (business: Business) => {
      // Locating navigates the Maps webview, which is exactly what the runner,
      // the enrichment runner and a reviews fetch are doing. Refuse while any
      // of them owns the map; the backend enforces it too.
      if (paneBusyElsewhere) {
        message.warning(t('toast.locateBlocked'));
        return;
      }
      try {
        await invoke('navigate_maps', {
          keyword: business.name,
          lat: business.lat,
          lng: business.lng,
          zoom: 17,
        });
        message.success(t('toast.located', { name: business.name }));
      } catch (error) {
        // A5: known refusals name their reason; the rest stays raw. All four
        // pane codes are translated here (C-10).
        const busyKey = paneBusyMessageKey(error);
        if (busyKey) {
          message.warning(t(busyKey));
        } else {
          message.error(t('toast.locateFailed', { error: String(error) }));
        }
      }
    },
    [paneBusyElsewhere, message, t],
  );

  const loadDiagnostics = useCallback(async () => {
    setDiagLoading(true);
    try {
      const snapshot = await invoke<Diagnostics>('get_diagnostics');
      setDiag(snapshot);
    } catch (error) {
      message.error(t('toast.diagFailed', { error: String(error) }));
    } finally {
      setDiagLoading(false);
    }
  }, [message, t]);

  useEffect(() => {
    if (diagOpen) void loadDiagnostics();
  }, [diagOpen, loadDiagnostics]);

  /**
   * Every entry point opens the same dialog. A preset chip passes its keyword;
   * everything else passes nothing, which also clears a previous chip so the
   * box does not keep seeding a keyword the user never chose again. Defined
   * above the shortcut effect because that effect depends on it.
   */
  const openNewTask = useCallback((keyword = '') => {
    setNewKeyword(keyword);
    setGridOpen(true);
  }, []);

  // ========== Keyboard shortcuts ==========
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const cmd = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      // Ctrl+Enter used to toggle the collector even from inside a text field,
      // which made "confirm this input" start or pause a run by accident.
      const target = event.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
          // Optional: a synthetic event dispatched on `window` has no `closest`.
          !!target.closest?.('.ant-select'));

      // `?` carries no modifier, so it must be handled before the `!cmd` bail
      // out — but never while typing, where it is a literal character (UI-10).
      if (!cmd && key === '?' && !typing) {
        event.preventDefault();
        setHelpOpen(true);
        return;
      }

      if (!cmd) return;

      if (key === 'f') {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (key === 'n') {
        // Same dialog as the header button and the collect-view button. Skipped
        // while typing so Ctrl+N in the keyword box does not pop a modal.
        if (typing) return;
        event.preventDefault();
        openNewTask();
      } else if (key === 'enter') {
        if (typing) return;
        event.preventDefault();
        void toggleCurrentTask();
      } else if (key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleCurrentTask, openNewTask]);

  // ========== Derived data ==========
  // SQLite is the source of truth now: `stats` arrives with every page, so the
  // filters are not re-applied in JS and the counts do not depend on what has
  // been scrolled past.
  const totalPages = Math.max(1, Math.ceil(stats.total / pageSize));

  // UI-05: where the open row sits inside the current result set — the drawer
  // shows `position / total` and disables its arrows at the bounds. While a
  // cross-page step is in flight, `page` already points at the new page while
  // `rows` (and the open row) still belong to the old one, so the last
  // truthful position is kept until the new rows land; if the row is gone
  // with nothing in flight (aged off or filtered away), the position drops to
  // 0, which hides the nav cluster.
  const detailIndex = detail
    ? rows.findIndex((row) => row.place_id === detail.place_id)
    : -1;
  const detailPosition = useMemo(() => {
    if (!detail) return 0;
    if (pendingDetailEndRef.current) return lastDetailPositionRef.current;
    if (detailIndex >= 0) return (page - 1) * pageSize + detailIndex + 1;
    return loadingRows ? lastDetailPositionRef.current : 0;
  }, [detail, detailIndex, page, pageSize, loadingRows]);

  // R-33: the memo above only reads `lastDetailPositionRef`; the write moved
  // here, after render. A memo that both read and wrote the ref returned
  // different values for the same inputs once StrictMode or a concurrent
  // re-render replayed it.
  useEffect(() => {
    if (detail && !pendingDetailEndRef.current && detailIndex >= 0) {
      lastDetailPositionRef.current = (page - 1) * pageSize + detailIndex + 1;
    }
  }, [detail, detailIndex, page, pageSize]);

  // ========== Detail drawer navigation (UI-05) ==========
  const goToDetail = useCallback(
    (delta: number) => {
      if (!detail) return;
      // Any step replaces a parked target — including the in-page case, where
      // a stale park would freeze the position at the pre-step value.
      pendingDetailEndRef.current = null;
      const current = rows.findIndex((row) => row.place_id === detail.place_id);
      if (current < 0) return;
      const next = current + delta;
      if (next >= 0 && next < rows.length) {
        setDetail(rows[next]);
        return;
      }
      const targetPage = page + (delta > 0 ? 1 : -1);
      if (targetPage < 1 || targetPage > totalPages) return;
      pendingDetailEndRef.current = delta > 0 ? 'first' : 'last';
      // Stepping through the drawer is deliberate row-by-row browsing, never
      // "follow the tail": re-arming it here would let the next batch yank
      // the view (and the open row) onto a page the user never asked for.
      followTailRef.current = false;
      if (targetPage >= totalPages) setUnseen(0);
      setPage(targetPage);
    },
    [detail, rows, page, totalPages],
  );

  // Open the parked end once its page arrives. The ref is consumed even when
  // the page comes back empty or the drawer was closed mid-flight, so a later
  // batch cannot trigger a stale jump into the middle of a session.
  useEffect(() => {
    const end = pendingDetailEndRef.current;
    if (!end) return;
    pendingDetailEndRef.current = null;
    if (!detail) return;
    setDetail(end === 'first' ? rows[0] ?? null : rows[rows.length - 1] ?? null);
  }, [rows, detail]);

  // Closing hands focus back to the row the drawer was opened from. tabIndex
  // -1 makes the row script-focusable without becoming a tab stop, and a
  // short outline shows where the drawer left the user (programmatic focus
  // does not raise :focus-visible on its own).
  const closeDetail = useCallback(() => {
    if (!detail) return;
    const key = detail.place_id;
    // A cross-page step may still be in flight; its parked target must not
    // reopen the drawer the user just closed.
    pendingDetailEndRef.current = null;
    setDetail(null);
    // The row normally still sits under the drawer mask. When it does not
    // (the page moved on), the first row of the current page is the next
    // best landing spot — focus must not fall back to <body>.
    const row =
      document.querySelector<HTMLElement>(
        `.ant-table-row[data-row-key="${CSS.escape(key)}"]`,
      ) ?? document.querySelector<HTMLElement>('.table-wrap .ant-table-row');
    if (!row) return;
    row.setAttribute('tabindex', '-1');
    row.focus();
    // The outline marks *the* row the drawer belonged to; a fallback row is
    // only a focus target, not the highlighted one.
    if (row.dataset.rowKey !== key) return;
    setReturnFocusKey(key);
    if (returnFocusTimerRef.current !== null) {
      window.clearTimeout(returnFocusTimerRef.current);
    }
    returnFocusTimerRef.current = window.setTimeout(() => {
      returnFocusTimerRef.current = null;
      setReturnFocusKey(null);
    }, 1600);
  }, [detail]);

  // A type tag in the drawer is a "show me only these" shortcut: close, filter
  // down to that single type, and start over at page 1. No focus return here —
  // the row may not survive the filter, so the table itself is the destination.
  const filterByType = useCallback((type: string) => {
    pendingDetailEndRef.current = null;
    setDetail(null);
    // The SQL type filter compares the display label (underscores replaced),
    // not the raw Google value — pass what the filter actually matches.
    setTypeFilter([typeLabel(type)]);
    setPage(1);
    followTailRef.current = false;
    setUnseen(0);
  }, []);

  // Stable identities for the drawer's arrow-key effect: inline arrows would
  // re-subscribe the window listener on every render (the liveness clock
  // ticks once per second while collecting).
  const showPrevDetail = useCallback(() => goToDetail(-1), [goToDetail]);
  const showNextDetail = useCallback(() => goToDetail(1), [goToDetail]);

  // Two frames: the first flushes a new page into the DOM, the second scrolls
  // the freshly mounted body.
  const scrollTableToBottom = useCallback(() => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const body = tableWrapRef.current?.querySelector<HTMLElement>('.ant-table-body');
        if (body) body.scrollTop = body.scrollHeight;
      });
    });
  }, []);

  // Keep the current page valid; follow the tail while the user is watching it.
  // `followTailRef` is cleared when they turn to an older page or scroll up.
  useEffect(() => {
    if (loadingRows) return;
    if (page > totalPages) {
      setUnseen(0);
      setPage(totalPages);
      return;
    }
    if (followTailRef.current && page < totalPages) {
      setPage(totalPages);
      scrollTableToBottom();
    }
  }, [totalPages, page, loadingRows, scrollTableToBottom]);

  const jumpToLatest = useCallback(() => {
    setUnseen(0);
    followTailRef.current = true;
    if (page < totalPages) setPage(totalPages);
    scrollTableToBottom();
  }, [page, totalPages, scrollTableToBottom]);

  // Type options come from SQL (counted over the whole table), so an option does
  // not vanish the moment it is selected.
  const typeOptions = useMemo(() => stats.types.map((entry) => entry.label), [stats.types]);

  const withPhoneShare =
    stats.total === 0 ? 0 : Math.round((stats.withPhone / stats.total) * 100);

  // R-23: `selectionVersion` is part of the dependency list because the row
  // objects live in a ref. Without it, `handleExport` / `copyPhones` / the bulk
  // bar kept the objects captured at click time — an email-mining run wrote new
  // emails to SQLite and the export still shipped rows without them.
  const selectedBusinesses = useMemo(
    () =>
      selectedKeys
        .map((key) => selectedRowsRef.current.get(String(key)))
        .filter((row): row is Business => Boolean(row)),
    [selectedKeys, selectionVersion],
  );

  // R-23: adopt the fresh row objects for every selected row that is on the
  // page that just landed. Mining and duplicate-strategy upserts rewrite whole
  // rows, so the snapshot taken at click time would keep its old emails,
  // ratings and review counts until the user re-selected the row.
  useEffect(() => {
    if (selectedKeys.length === 0 || rows.length === 0) return;
    const wanted = new Set(selectedKeys.map(String));
    let refreshed = false;
    rows.forEach((row) => {
      if (!wanted.has(row.place_id)) return;
      if (selectedRowsRef.current.get(row.place_id) === row) return;
      selectedRowsRef.current.set(row.place_id, row);
      refreshed = true;
    });
    if (refreshed) setSelectionVersion((value) => value + 1);
  }, [rows, selectedKeys]);

  // Selecting rows survives filter changes on purpose (it is the export set),
  // so the bulk bar has to say how many of them are currently invisible.
  const selectedBeyondView = useMemo(() => {
    const visible = new Set(rows.map((item) => item.place_id));
    return selectedBusinesses.filter((item) => !visible.has(item.place_id)).length;
  }, [rows, selectedBusinesses]);

  const selectAllFiltered = useCallback(async () => {
    const target = Math.min(stats.total, MAX_SELECT_ALL);
    if (target === 0) return;
    // R-33: up to four sequential queries. A second click, a clear or a filter
    // change supersedes the run instead of letting it overwrite the selection
    // with rows from a table the user has already left.
    const run = selectAllRunRef.current + 1;
    selectAllRunRef.current = run;
    try {
      const collected: Business[] = [];
      for (let offset = 0; offset < target; offset += 500) {
        const result = await invoke<BusinessPage>('query_businesses', {
          request: {
            ...filterRequest(),
            page: Math.floor(offset / 500) + 1,
            pageSize: 500,
          },
        });
        if (run !== selectAllRunRef.current) return;
        collected.push(...result.rows);
        if (result.rows.length === 0) break;
      }
      const bounded = collected.slice(0, MAX_SELECT_ALL);
      bounded.forEach((row) => selectedRowsRef.current.set(row.place_id, row));
      setSelectedKeys(bounded.map((row) => row.place_id));
      // R-23: the ref now holds fresh objects even when the key list repeats.
      setSelectionVersion((value) => value + 1);
      if (stats.total > MAX_SELECT_ALL) {
        message.warning(tRef.current('bulk.selectAllCapped', { count: MAX_SELECT_ALL }));
      }
    } catch (error) {
      message.error(tRef.current('toast.selectAllFailed', { error: String(error) }));
    }
  }, [filterRequest, message, stats.total]);

  // P2-16: "select all filtered" runs up to four sequential queries. A filter
  // change supersedes the run — `data:cleared` is not the only way the result
  // set moves, and rows from the old filter must not land in the new selection.
  // `filterRequest` is the exact request builder the loop uses, so its identity
  // changing is the precise "the selection would differ now" signal.
  useEffect(() => {
    selectAllRunRef.current += 1;
  }, [filterRequest]);

  // M7: mine emails/socials for the current scope — the selection when rows
  // are selected, the whole filtered set otherwise (mirroring the export
  // button's two scopes). Large unselected runs get one confirmation, because
  // they hit up to 4 pages per real website.
  const mineEmails = useCallback(() => {
    if (emailMining) return;
    const scope = selectedKeys.length > 0 ? 'selection' : 'filter';
    const count = scope === 'selection' ? selectedKeys.length : stats.total;
    if (count === 0) return;
    const start = async (force: boolean) => {
      try {
        const sites = await invoke<number>('start_email_mining', {
          request:
            scope === 'selection'
              ? { placeIds: selectedKeys.map(String), force }
              : { filter: filterRequest(), force },
        });
        if (sites === 0) {
          message.warning(t('toast.emailNothingToMine'));
          return;
        }
        setEmailMining({ done: 0, total: sites, found: 0 });
      } catch (error) {
        const text = String(error);
        if (text.includes('already-running')) {
          message.warning(t('toast.emailMineRunning'));
          return;
        }
        // C-15: an empty scope has three causes. "Already mined" is the common
        // one — the rows do have websites — so it gets the re-run offer instead
        // of the misleading "no rows with a website".
        if (text.startsWith('nothing_to_mine:')) {
          const cause = text.slice('nothing_to_mine:'.length);
          if (cause === 'already_mined') {
            modal.confirm({
              title: t('toast.emailAllMinedTitle', { count }),
              content: t('toast.emailAllMinedBody'),
              okText: t('table.mineEmailsForce'),
              cancelText: t('common.cancel'),
              onOk: () => {
                void start(true);
              },
            });
            return;
          }
          message.warning(
            cause === 'no_website'
              ? t('toast.emailNothingToMine')
              : t('toast.emailSitesUnusable'),
          );
          return;
        }
        message.error(t('toast.emailMineFailed', { error: text }));
      }
    };
    if (scope === 'filter' && count > 500) {
      modal.confirm({
        title: t('bulk.mineConfirmTitle', { count }),
        content: t('bulk.mineConfirmContent'),
        okText: t('table.mineEmails'),
        cancelText: t('common.cancel'),
        onOk: () => {
          void start(false);
        },
      });
      return;
    }
    void start(false);
  }, [emailMining, selectedKeys, stats.total, filterRequest, message, modal, t]);

  // ========== Tier-2 detail enrichment ==========
  // Selection-only by design: each place costs one full page load (~10 s), so
  // a "whole filter" scope would quietly turn into hours of map occupation —
  // the email miner's filter scope has no such per-row cost. The confirm fires
  // past 20 places, where the minutes start to matter.
  const enrichSelected = useCallback(() => {
    if (enriching) return;
    const count = selectedKeys.length;
    if (count === 0) {
      message.warning(t('toast.enrichNothing'));
      return;
    }
    const start = async () => {
      try {
        await invoke('enrich_businesses', { placeIds: selectedKeys.map(String) });
        // The command's own initial `enrich:progress` frame sets the state —
        // setting it here too would race that first frame back to done: 0.
      } catch (error) {
        const text = String(error);
        if (text.includes('enrich_busy')) {
          message.warning(t('toast.enrichBusy'));
        } else if (text.includes('map_busy')) {
          message.warning(t('toast.enrichMapBusy'));
        } else if (text.includes('session_active')) {
          message.warning(t('toast.enrichSession'));
        } else if (text.includes('reviews_busy')) {
          message.warning(t('toast.reviewsBusy'));
        } else {
          message.error(t('toast.enrichFailed', { error: text }));
        }
      }
    };
    if (count > 20) {
      modal.confirm({
        title: t('toast.enrichConfirmTitle', { count }),
        content: t('toast.enrichConfirmContent'),
        okText: t('table.enrich'),
        cancelText: t('common.cancel'),
        onOk: () => {
          void start();
        },
      });
      return;
    }
    void start();
  }, [enriching, selectedKeys, message, modal, t]);

  const handleExport = useCallback(
    async (format: ExportKind, saveAs = false) => {
      // A double click on "export then clear" used to start a second export
      // while the first was still writing (P3-11).
      if (exporting) return;
      const selected = selectedBusinesses;
      const hasSelection = selected.length > 0;
      if (!hasSelection && stats.total === 0) {
        message.warning(t('toast.nothingToExport'));
        return;
      }
      setExporting(true);
      try {
        // M10: the columns the user still shows in the table. Rust drops the
        // matching export columns; identifiers and structured address parts
        // (no table toggle) always travel. The mandatory keys defend
        // themselves the same way the table picker does — a hand-edited
        // settings row must not hide them from the file either.
        const visibleKeys = EXPORTABLE_TABLE_KEYS.filter(
          (key) => !settings.hiddenColumns.includes(key) || MANDATORY_COLUMN_KEYS.has(key),
        );
        // A selection travels as rows; "everything that matches" travels as a
        // filter and is read from SQLite by the command, so the webview never
        // holds the full result set.
        const written = await invoke<string | null>(EXPORT_COMMANDS[format], {
          businesses: hasSelection ? selected : [],
          filter: hasSelection ? null : filterRequest(),
          fileName: renderFileName(
            settings.fileNameTemplate,
            hasSelection ? selected.length : stats.total,
            currentTask?.name,
          ),
          saveAs,
          visibleKeys,
        });
        // P2: exporting the whole task moves its watermark, so "only new" starts
        // from here. A cancelled dialog returns null and changes nothing.
        if (written && !hasSelection && currentTask) {
          try {
            await invoke('mark_job_exported', { id: currentTask.id, at: Date.now() });
            setOnlyNew(false);
            reloadJobsRef.current();
          } catch {
            /* the watermark is cosmetic; the file is already written */
          }
        }
      } catch (error) {
        const raw = String(error);
        if (raw.includes('export_busy')) {
          message.warning(t('toast.exportBusy'));
        } else if (raw.startsWith('excel_row_limit:')) {
          message.error(
            t('toast.excelRowLimit', {
              count: raw.slice('excel_row_limit:'.length),
            }),
          );
        } else {
          message.error(t('toast.exportFailed', { error: raw }));
        }
      } finally {
        setExporting(false);
      }
    },
    [
      exporting,
      filterRequest,
      message,
      selectedBusinesses,
      settings.fileNameTemplate,
      settings.hiddenColumns,
      stats.total,
      currentTask,
      t,
    ],
  );

  const copyPhones = useCallback(async () => {
    const phones = selectedBusinesses.map((item) => item.phone).filter(Boolean);
    if (phones.length === 0) {
      message.warning(t('toast.noPhones'));
      return;
    }
    try {
      await navigator.clipboard.writeText(phones.join('\n'));
      message.success(t('toast.phonesCopied', { count: phones.length }));
    } catch (error) {
      message.error(t('toast.copyFailed', { error: String(error) }));
    }
  }, [selectedBusinesses, message, t]);

  // ========== Row actions (UI-04) ==========

  /** Clipboard for the row menu; same API the bulk copy already relies on. */
  const copyText = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        message.success(t('toast.copied'));
      } catch (error) {
        message.error(t('toast.copyFailed', { error: String(error) }));
      }
    },
    [message, t],
  );

  /**
   * Export exactly one row. It travels as `businesses` — the same path a
   * selection takes — so the export command never needs a "single place_id"
   * mode, and the auto-save folder preference applies unchanged.
   */
  const exportRow = useCallback(
    async (record: Business, format: 'excel' | 'csv') => {
      // The toolbar export and this one share the `exporting` flag; a second
      // concurrent command would race for the same save dialog.
      if (exporting) return;
      setExporting(true);
      try {
        await invoke<string | null>(EXPORT_COMMANDS[format], {
          businesses: [record],
          filter: null,
          fileName: renderFileName(settings.fileNameTemplate, 1, currentTask?.name),
          saveAs: false,
          visibleKeys: EXPORTABLE_TABLE_KEYS.filter(
            (key) => !settings.hiddenColumns.includes(key) || MANDATORY_COLUMN_KEYS.has(key),
          ),
        });
      } catch (error) {
        const raw = String(error);
        message.error(
          raw.includes('export_busy')
            ? t('toast.exportBusy')
            : t('toast.exportFailed', { error: raw }),
        );
      } finally {
        setExporting(false);
      }
    },
    [exporting, message, settings.fileNameTemplate, settings.hiddenColumns, currentTask, t],
  );

  /** The row menu: identical for the ⋯ button, right-click and Shift+F10. */
  const rowMenuItems = useCallback(
    (record: Business): MenuProps['items'] => [
      {
        key: 'locate',
        icon: <AimOutlined />,
        label: t('table.locate'),
        // Locating navigates the map; a running task owns it.
        disabled: Boolean(runningJob),
      },
      {
        key: 'copy-phone',
        icon: <CopyOutlined />,
        label: t('table.copyPhone'),
        disabled: !record.phone,
      },
      {
        key: 'copy-address',
        icon: <CopyOutlined />,
        label: t('table.copyAddress'),
        disabled: !record.address,
      },
      {
        key: 'open-website',
        icon: <GlobalOutlined />,
        // Same action text the detail drawer uses; no second key for it.
        label: t('detail.openWebsite'),
        // R-24: disabled for anything that is not an http(s) URL, matching the
        // website cell that also refuses to render it as a link.
        disabled: !safeHttpUrl(record.website),
      },
      { type: 'divider' },
      { key: 'export-excel', icon: <DownloadOutlined />, label: t('table.exportRowExcel') },
      { key: 'export-csv', icon: <DownloadOutlined />, label: t('table.exportRowCsv') },
    ],
    [t, runningJob],
  );

  const handleRowAction = useCallback(
    async (key: string, record: Business) => {
      if (key === 'locate') {
        await handleLocate(record);
      } else if (key === 'copy-phone' && record.phone) {
        await copyText(record.phone);
      } else if (key === 'copy-address' && record.address) {
        await copyText(record.address);
      } else if (key === 'open-website') {
        // R-24: `website` is scraped; only an http(s) URL may reach window.open.
        const target = safeHttpUrl(record.website);
        if (target) window.open(target, '_blank', 'noopener,noreferrer');
      } else if (key === 'export-excel') {
        await exportRow(record, 'excel');
      } else if (key === 'export-csv') {
        await exportRow(record, 'csv');
      }
    },
    [copyText, exportRow, handleLocate],
  );

  const hasFilters =
    query.trim() !== '' ||
    rating !== 'all' ||
    contact !== 'all' ||
    timeRange !== 'all' ||
    typeFilter.length > 0 ||
    taskFilter !== 'all' ||
    onlyNew;

  /** Switching task resets "only new": the watermark belongs to one task. */
  const handleTaskFilter = useCallback((value: TaskFilter) => {
    setTaskFilter(value);
    setOnlyNew(false);
  }, []);

  /** Switching views closes anything modal-ish that belonged to the old one. */
  const changeView = useCallback((next: PanelView) => {
    setView(next);
    setDetail(null);
    setRowMenuKey(null);
    setOpenedTask(null);
  }, []);

  // T-05/T-06: "view results" leaves the collect view entirely and pins the
  // picker, so the table the user lands on needs no further explaining.
  const openTaskResults = useCallback((jobId: string) => {
    setTaskFilter(jobId);
    setOpenedTask(null);
    setView('data');
    setPage(1);
    setGridOpen(false);
  }, []);

  /** Single owner of the job list: every mutation funnels through here. */
  const reloadJobs = useCallback(async () => {
    try {
      const list = await invoke<Job[]>('list_jobs');
      setJobs(list);
      // A filter pointing at a deleted task would otherwise show an empty table
      // with no visible explanation.
      setTaskFilter((current) =>
        current === 'all' || current === '__none__' || list.some((job) => job.id === current)
          ? current
          : 'all',
      );
      setOpenedTask((current) =>
        current ? (list.find((job) => job.id === current.id) ?? null) : null,
      );
      // The banner's own cleanup (the job:progress listener) misses two
      // paths: a deleted task emits nothing, and cancel_job only emits when
      // it stopped a *running* job — a paused one is cancelled silently. So
      // the banner stays valid only while the job is still there and still
      // paused; do not re-set it here — the mount effect is the only writer
      // that may raise it, so a dismissed banner stays dismissed.
      setResumeJob((current) => {
        if (!current) return null;
        const job = list.find((item) => item.id === current.id);
        return job && job.status === 'paused' ? current : null;
      });
    } catch (error) {
      console.warn('[Placemill] failed to reload jobs:', error);
    }
  }, []);

  useEffect(() => {
    reloadJobsRef.current = () => void reloadJobs();
  }, [reloadJobs]);

  // T-04: a "create without start" never emits progress, so the list would miss
  // those jobs until the next reload.
  const addCreatedJobs = useCallback((created: Job[]) => {
    setJobs((previous) => {
      const known = new Set(previous.map((job) => job.id));
      return [...created.filter((job) => !known.has(job.id)), ...previous];
    });
    setView('collect');
    setOpenedTask(null);
  }, []);

  const showGuide = stats.all === 0 && !hasFilters && !listening;

  // ========== Columns ==========
  // UI-04: the row that carries the tab stop. A row that left the page (page
  // turn, filter change, new batch) must not leave the table without one, so
  // the walk falls back to the first row of whatever is on screen. Declared
  // before the memoized columns because the actions column reads it.
  const rovingRowKey =
    activeRowKey && rows.some((row) => row.place_id === activeRowKey)
      ? activeRowKey
      : rows[0]?.place_id;

  // Same guard for the row menu: a row that left the page while its menu was
  // open must not pop the menu back up when it reappears on a later page.
  const rowMenuKeyInPage =
    rowMenuKey && rows.some((row) => row.place_id === rowMenuKey) ? rowMenuKey : null;

  // T-02: attribution for the rows on screen, keyed by place id. A place seen by
  // several jobs keeps every name, which is the whole point of the join table.
  const jobRefsByPlace = useMemo(() => {
    const map = new Map<string, BusinessJobRef[]>();
    jobRefs.forEach((ref) => {
      const list = map.get(ref.placeId);
      if (list) list.push(ref);
      else map.set(ref.placeId, [ref]);
    });
    return map;
  }, [jobRefs]);

  // R-18: built once per relevant change instead of once per render — the table
  // diffs its columns shallowly, so a fresh array every second (old root clock)
  // and every batch forced a full 200 × 11 cell diff. Width gates are inputs
  // here; the visible subset is derived below from what the user hid (UI-04).
  const allColumns: ColumnsType<Business> = useMemo(
    () => [
    {
      title: t('table.business'),
      dataIndex: 'name',
      key: 'name',
      width: 190,
      fixed: wide ? 'left' : undefined,
      ellipsis: true,
      // SQL sorts by name COLLATE NOCASE (idx_name_nocase); `true` tells AntD
      // not to re-sort the page it received.
      sorter: true,
      sortOrder: sort.field === 'name' ? (sort.direction === 'asc' ? 'ascend' : 'descend') : null,
      render: (_, record) => (
        <div className="name-cell">
          <EnvironmentFilled className="name-icon" />
          <span className="name-main" title={record.name}>
            {record.name || t('table.unnamed')}
          </span>
        </div>
      ),
    },
    {
      title: t('table.rating'),
      dataIndex: 'rating',
      key: 'rating',
      width: 76,
      sorter: true,
      sortOrder: sort.field === 'rating' ? (sort.direction === 'asc' ? 'ascend' : 'descend') : null,
      render: (value: number) =>
        value > 0 ? (
          <span className="rating-cell">
            <StarFilled />
            {value.toFixed(1)}
          </span>
        ) : (
          <span className="rating-cell is-empty">{t('common.dash')}</span>
        ),
    },
    {
      // UI-04: review count is the usual way to pick between similar
      // businesses, and it used to live only in the detail drawer. `dataIndex`
      // is the SQL sort field Rust's whitelist understands (`reviews`), the
      // render reads the `reviews_total` column.
      title: t('table.reviews'),
      dataIndex: 'reviews',
      key: 'reviews',
      width: 72,
      sorter: true,
      sortOrder: sort.field === 'reviews' ? (sort.direction === 'asc' ? 'ascend' : 'descend') : null,
      render: (_, record) =>
        record.reviews_total > 0 ? (
          <span className="cell-numeric">{record.reviews_total.toLocaleString()}</span>
        ) : (
          <span className="cell-muted">{t('common.dash')}</span>
        ),
    },
    {
      title: t('table.phone'),
      dataIndex: 'phone',
      key: 'phone',
      width: 148,
      render: (value: string) =>
        value ? (
          <Text copyable={{ text: value }} style={{ fontSize: 12 }}>
            {value}
          </Text>
        ) : (
          <span className="cell-muted">{t('common.dash')}</span>
        ),
    },
    ...(medium
      ? ([
          {
            title: t('table.task'),
            dataIndex: 'place_id',
            key: 'task',
            width: 132,
            ellipsis: true,
            render: (_, record) => {
              const refs = jobRefsByPlace.get(record.place_id) ?? [];
              if (refs.length === 0) {
                return <span className="cell-muted">{t('common.dash')}</span>;
              }
              const first = refs[0];
              return (
                <button
                  type="button"
                  className="task-cell"
                  // Every job that saw the place, one per line.
                  title={refs.map((ref) => ref.name).join('\n')}
                  onClick={(event) => {
                    // The row opens the detail drawer; this cell filters instead.
                    event.stopPropagation();
                    setTaskFilter(first.jobId);
                  }}
                >
                  <span className="task-cell-name">{first.name}</span>
                  {refs.length > 1 && (
                    <span className="task-cell-more">+{refs.length - 1}</span>
                  )}
                </button>
              );
            },
          },
          {
            title: t('table.address'),
            dataIndex: 'address',
            key: 'address',
            width: 140,
            // UI-04: two clamped lines instead of one ellipsised line — at
            // 140px a single line showed half a street. The span carries a
            // min-height so every row keeps the same height.
            render: (value: string) => (
              <Tooltip title={value}>
                <span className="cell-address">{value || t('common.dash')}</span>
              </Tooltip>
            ),
          },
          {
            title: t('table.collectedAt'),
            // `collectedAt` (no underscore) is the SQL sort field the Rust
            // whitelist understands; the render is fully custom anyway.
            dataIndex: 'collectedAt',
            key: 'collectedAt',
            width: 96,
            sorter: true,
            sortOrder:
              sort.field === 'collectedAt'
                ? sort.direction === 'desc'
                  ? 'descend'
                  : 'ascend'
                : null,
            render: (_, record) =>
              record.collected_at > 0 ? (
                <Tooltip
                  title={
                    record.source_query
                      ? `${formatCollectedFull(record.collected_at)} · ${record.source_query}`
                      : formatCollectedFull(record.collected_at)
                  }
                >
                  <span className="cell-muted">
                    {formatCollectedShort(record.collected_at)}
                  </span>
                </Tooltip>
              ) : (
                <span className="cell-muted">{t('common.dash')}</span>
              ),
          },
        ] as ColumnsType<Business>)
      : []),
    ...(wide
      ? ([
          {
            title: t('table.website'),
            dataIndex: 'website',
            key: 'website',
            width: 84,
            render: (value: string) => {
              // R-24: scraped data decides this value; only http(s) links out.
              const href = safeHttpUrl(value);
              if (!href) {
                return value ? (
                  <Text ellipsis style={{ fontSize: 12 }}>
                    {value}
                  </Text>
                ) : (
                  <span className="cell-muted">{t('common.dash')}</span>
                );
              }
              return (
                <Text ellipsis style={{ fontSize: 12 }}>
                  <a href={href} target="_blank" rel="noreferrer">
                    {linkLabel(value, href)}
                  </a>
                </Text>
              );
            },
          },
          {
            title: t('table.types'),
            dataIndex: 'types',
            key: 'types',
            width: 150,
            render: (types: string[]) =>
              types.length > 0 ? (
                <Space size={4} wrap>
                  {types.slice(0, 2).map((type) => (
                    <Tag key={type} color="blue" style={{ fontSize: 11, margin: 0 }}>
                      {typeLabel(type)}
                    </Tag>
                  ))}
                  {types.length > 2 && (
                    <Tooltip
                      title={types
                        .slice(2)
                        .map(typeLabel)
                        .join(t('common.listSeparator'))}
                    >
                      <Tag style={{ fontSize: 11, margin: 0 }}>+{types.length - 2}</Tag>
                    </Tooltip>
                  )}
                </Space>
              ) : (
                <span className="cell-muted">{t('common.dash')}</span>
              ),
          },
          {
            title: t('table.email'),
            dataIndex: 'emails',
            key: 'emails',
            width: 148,
            ellipsis: true,
            render: (_, record) => {
              if (record.emails.length > 0) {
                const tooltip = [...record.emails, record.email_source_url]
                  .filter(Boolean)
                  .join('\n');
                return (
                  <Tooltip
                    title={<span style={{ whiteSpace: 'pre-line' }}>{tooltip}</span>}
                  >
                    <Text ellipsis style={{ fontSize: 12 }}>
                      {record.emails[0]}
                      {record.emails.length > 1 ? ` +${record.emails.length - 1}` : ''}
                    </Text>
                  </Tooltip>
                );
              }
              if (record.email_status === 'blocked') {
                return (
                  <Tooltip title={t('table.emailBlocked')}>
                    <Tag style={{ fontSize: 11, margin: 0 }}>{t('table.emailBlocked')}</Tag>
                  </Tooltip>
                );
              }
              return <span className="cell-muted">{t('common.dash')}</span>;
            },
          },
          {
            title: t('table.socials'),
            dataIndex: 'socials',
            key: 'socials',
            width: 96,
            render: (_, record) =>
              record.socials.length > 0 ? (
                <Space size={6}>
                  {record.socials.map((url) => {
                    // R-24: the icon stays, the link only when the scheme is safe.
                    const href = safeHttpUrl(url);
                    return href ? (
                      <a
                        key={url}
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 13 }}
                      >
                        {socialIcon(url)}
                      </a>
                    ) : (
                      <span key={url} style={{ fontSize: 13 }} title={url}>
                        {socialIcon(url)}
                      </span>
                    );
                  })}
                </Space>
              ) : (
                <span className="cell-muted">{t('common.dash')}</span>
              ),
          },
          // ===== M8 / J-08e: the columns the index probe confirmed =====
          {
            title: t('table.city'),
            dataIndex: 'city',
            key: 'city',
            width: 116,
            ellipsis: true,
            render: (value: string) =>
              value ? (
                <span title={value}>{value}</span>
              ) : (
                <span className="cell-muted">{t('common.dash')}</span>
              ),
          },
          {
            title: t('table.openHours'),
            dataIndex: 'open_hours',
            key: 'open_hours',
            width: 150,
            ellipsis: true,
            render: (_, record) => {
              const periods = todaysPeriods(record);
              // `null` = the payload carries no hours for today (or none at
              // all), `''` = today is listed but closed.
              if (periods === null) {
                return <span className="cell-muted">{t('common.dash')}</span>;
              }
              if (!periods) {
                return <span className="cell-muted">{t('table.closed')}</span>;
              }
              return <span title={weekHours(record)}>{periods}</span>;
            },
          },
          {
            title: t('table.ownerName'),
            dataIndex: 'owner_name',
            key: 'owner_name',
            width: 140,
            ellipsis: true,
            render: (value: string) =>
              value ? (
                <span title={value}>{value}</span>
              ) : (
                <span className="cell-muted">{t('common.dash')}</span>
              ),
          },
        ] as ColumnsType<Business>)
      : []),
    {
      title: '',
      key: 'actions',
      width: 86,
      fixed: wide ? 'right' : undefined,
      render: (_, record) => (
        <div className="row-actions">
          <Tooltip title={t('table.locate')}>
            <Button
              className="link-icon-btn"
              type="text"
              size="small"
              icon={<AimOutlined />}
              aria-label={t('table.locate')}
              onClick={(event) => {
                event.stopPropagation();
                void handleLocate(record);
              }}
            />
          </Tooltip>
          {/* UI-04: same menu the right-click and Shift+F10 open — the three
              entry points share `rowMenuKey`, so only one popup exists. */}
          <Dropdown
            trigger={['click']}
            open={rowMenuKeyInPage === record.place_id}
            onOpenChange={(open) => setRowMenuKey(open ? record.place_id : null)}
            menu={{
              items: rowMenuItems(record),
              onClick: ({ key }) => {
                setRowMenuKey(null);
                void handleRowAction(key, record);
              },
            }}
          >
            <Button
              className="link-icon-btn"
              type="text"
              size="small"
              icon={<MoreOutlined />}
              title={t('table.rowMenu')}
              aria-label={t('table.rowMenu')}
              onClick={(event) => event.stopPropagation()}
            />
          </Dropdown>
        </div>
      ),
    },
    ],
    // `t` changes identity with the locale on purpose, so a language switch
    // rebuilds the titles; the callbacks are useCallback-stable.
    [
      medium,
      wide,
      t,
      sort,
      jobRefsByPlace,
      rowMenuKeyInPage,
      handleLocate,
      rowMenuItems,
      handleRowAction,
    ],
  );

  // ========== Column visibility (UI-04) ==========
  // The stored list holds what the user hid; the width gates above stay the
  // source of truth for what *can* be shown. Unknown or stale keys are inert:
  // they simply never match a column in this build.
  const hiddenColumns = useMemo(
    // Mandatory keys are filtered out here rather than trusted: a hand-edited
    // settings row (or a future build renaming a column) must not be able to
    // make the picker disagree with the table, and the first write from the
    // picker drops the dirty key for good.
    () =>
      new Set(settings.hiddenColumns.filter((key) => !MANDATORY_COLUMN_KEYS.has(key))),
    [settings.hiddenColumns],
  );
  // R-18: derived views are memoized too — `columns` feeds the table's shallow
  // compare, and a new array identity re-diffs every cell.
  const availableColumnKeys = useMemo(
    () => allColumns.map((column) => String(column.key)),
    [allColumns],
  );
  const visibleColumnKeys = useMemo(
    () => availableColumnKeys.filter((key) => !hiddenColumns.has(key)),
    [availableColumnKeys, hiddenColumns],
  );
  const columns = useMemo(
    () =>
      allColumns.filter((column) => {
        const key = String(column.key);
        return MANDATORY_COLUMN_KEYS.has(key) || !hiddenColumns.has(key);
      }),
    [allColumns, hiddenColumns],
  );

  /**
   * The header picker reports the visible set among the columns the current
   * width offers. Keys it never showed carry no information, so they keep the
   * state they had — hiding "address" at a narrow width must not silently hide
   * the wide-only columns too.
   */
  const applyColumnVisibility = useCallback(
    (visibleKeys: string[]) => {
      const visible = new Set(visibleKeys);
      const next = new Set(hiddenColumns);
      availableColumnKeys.forEach((key) => {
        if (visible.has(key)) next.delete(key);
        else next.add(key);
      });
      // Sorted before sending: Rust stores this list sorted, and an unsorted
      // patch would look like a correction on every toggle (R-25).
      // R-34: a failed save used to vanish — the columns then looked persisted
      // and came back on the next launch.
      void update({ hiddenColumns: [...next].sort() }).catch((error) => {
        message.error(tRef.current('settings.saveFailed', { error: String(error) }));
      });
    },
    [update, hiddenColumns, availableColumnKeys],
  );

  // Only "auto" mode needs the extra entries: in "ask" mode every export already
  // opens the dialog, so "save as…" would be the same action twice.
  const autoExport = settings.exportSaveMode === 'auto';
  const exportMenuItems: MenuProps['items'] = useMemo(() => {
    // M10: all four formats, the user's default one first.
    const formats: { key: ExportKind; label: string; saveAsLabel: string }[] = [
      { key: 'excel', label: t('table.exportExcel'), saveAsLabel: t('table.exportSaveAsExcel') },
      { key: 'csv', label: t('table.exportCsv'), saveAsLabel: t('table.exportSaveAsCsv') },
      { key: 'json', label: t('table.exportJson'), saveAsLabel: t('table.exportSaveAsJson') },
      { key: 'jsonl', label: t('table.exportJsonl'), saveAsLabel: t('table.exportSaveAsJsonl') },
    ];
    const ordered = [
      ...formats.filter((f) => f.key === settings.defaultExportFormat),
      ...formats.filter((f) => f.key !== settings.defaultExportFormat),
    ];
    return [
      ...ordered.map((f) => ({ key: f.key, label: f.label })),
      ...(autoExport
        ? [
            { type: 'divider' as const },
            ...ordered.map((f) => ({ key: `${f.key}-save-as`, label: f.saveAsLabel })),
          ]
        : []),
    ];
  }, [settings.defaultExportFormat, autoExport, t]);

  // R-18: the table compares its props shallowly. Objects rebuilt on every
  // render (scroll/pagination/rowSelection/locale, the row factory and the
  // sort handler) missed that compare and re-diffed every cell.
  const tableScroll = useMemo(() => ({ x: wide ? 948 : 610, y: scrollY }), [wide, scrollY]);

  const tableOnChange = useCallback(
    (_: unknown, __: unknown, sorter: unknown) => {
      const active = (Array.isArray(sorter) ? sorter[0] : sorter) as
        | { order?: string; field?: string }
        | undefined;
      const field = active?.order && active?.field ? String(active.field) : '';
      const direction = active?.order === 'descend' ? 'desc' : 'asc';
      // Pagination also fires this handler; returning the same object keeps the
      // sort state stable so the page does not jump back to 1.
      setSort((current) =>
        current.field === field && current.direction === direction
          ? current
          : { field, direction },
      );
    },
    [],
  );

  const tablePagination = useMemo(
    () => ({
      current: page,
      pageSize,
      total: stats.total,
      onChange: (nextPage: number, nextSize?: number) => {
        const size = nextSize ?? pageSize;
        const pages = Math.max(1, Math.ceil(stats.total / size));
        // Landing on the newest page by hand clears the backlog marker and
        // resumes following; browsing back stops it.
        if (nextPage >= pages) setUnseen(0);
        followTailRef.current = nextPage >= pages;
        setPage(nextPage);
        // Also fires for a pure page turn, where `nextSize` is undefined.
        // Without this guard every page turn would write the settings row.
        if (size !== pageSize) {
          setPageSize(size);
          // R-34: report the failure; the table already shows the new size, so a
          // silent reject looked like a saved preference.
          void update({ pageSize: size }).catch((error) => {
            message.error(tRef.current('settings.saveFailed', { error: String(error) }));
          });
        }
      },
      showSizeChanger: true,
      pageSizeOptions: ['20', '50', '100', '200'],
      size: 'small' as const,
      showTotal: (total: number) =>
        hasFilters ? `${total} / ${stats.all}` : t('table.total', { count: total }),
    }),
    [page, pageSize, stats.total, stats.all, hasFilters, t, update, message],
  );

  const tableRowSelection = useMemo(
    () => ({
      selectedRowKeys: selectedKeys,
      onChange: (keys: ReactKey[]) => {
        // Remember the rows themselves: a page turn would otherwise lose
        // everything needed to export a selection.
        rows.forEach((row) => {
          if (keys.includes(row.place_id)) {
            selectedRowsRef.current.set(row.place_id, row);
          }
        });
        const next = new Set(keys.map(String));
        [...selectedRowsRef.current.keys()].forEach((id) => {
          if (!next.has(id)) selectedRowsRef.current.delete(id);
        });
        setSelectedKeys(keys);
        // R-23: the ref was just re-pointed at this page's objects.
        setSelectionVersion((value) => value + 1);
      },
      columnWidth: 38,
    }),
    [selectedKeys, rows],
  );

  const tableOnRow = useCallback(
    (record: Business) => ({
      // UI-04: roving focus. One row per page carries the tab stop;
      // -1 keeps the rest focusable by script only.
      tabIndex: rovingRowKey === record.place_id ? 0 : -1,
      onClick: (event: ReactMouseEvent<HTMLElement>) => {
        // Ignore clicks on interactive elements inside the row (checkbox,
        // copy icon, links, action buttons) so they do not open the drawer.
        const target = event.target as HTMLElement;
        if (
          target.closest(
            'a, button, .ant-checkbox-wrapper, .ant-table-selection-column, .ant-typography-copy',
          )
        ) {
          return;
        }
        // Clicking is also how the roving focus lands on a row.
        setActiveRowKey(record.place_id);
        setDetail(record);
      },
      onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
        // The row menu replaces the WebView's own context menu, which would
        // only offer "Reload" over a data row.
        event.preventDefault();
        setActiveRowKey(record.place_id);
        setRowMenuKey(record.place_id);
      },
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
        // Shift+F10 is the Windows context-menu key; the menu opens on the row
        // that holds the focus, exactly like a right-click.
        if (event.shiftKey && event.key === 'F10') {
          event.preventDefault();
          setActiveRowKey(record.place_id);
          setRowMenuKey(record.place_id);
          return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const index = rows.findIndex((row) => row.place_id === record.place_id);
        const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
        if (!next) return;
        setActiveRowKey(next.place_id);
        // The row is in the DOM already; wait for the re-render that moves the
        // roving tabindex onto it, then hand over the focus.
        window.requestAnimationFrame(() => {
          document
            .querySelector<HTMLElement>(
              `.ant-table-row[data-row-key="${CSS.escape(next.place_id)}"]`,
            )
            ?.focus();
        });
      },
    }),
    [rovingRowKey, rows],
  );

  const tableRowClassName = useCallback(
    (record: Business) =>
      [
        revealIds.has(record.place_id) ? 'row-reveal' : '',
        returnFocusKey === record.place_id ? 'row-return-focus' : '',
      ]
        .filter(Boolean)
        .join(' '),
    [revealIds, returnFocusKey],
  );

  const tableLocale = useMemo(
    () => ({
      emptyText: (
        <div className="empty-table">
          <Text type="secondary">
            {!hasFilters && listening
              ? t('table.emptyListening')
              : t('table.emptyNoMatch')}
          </Text>
          {/* A dead end otherwise: the only way out was hunting for the
              clear button in the filter bar. */}
          {hasFilters && (
            <Button type="link" size="small" onClick={resetFilters}>
              {t('table.clearFilters')}
            </Button>
          )}
        </div>
      ),
    }),
    [hasFilters, listening, t, resetFilters],
  );

  return (
    <div className="app-shell">
      <SplitHandle
        ratio={split}
        onChange={setSplit}
        collapsed={mapCollapsed}
        onToggleCollapse={toggleMapCollapsed}
      />

      <PanelHeader
        view={view}
        onView={changeView}
        listening={listening}
        busy={Boolean(runningJob)}
        sessionStartedAt={sessionStartedAt}
        // UI-16: the pill must not say "paused" after a restart that only
        // happens to have old rows in the database — "collected this session"
        // is what the word actually claims.
        collectedThisSession={summary.received > 0}
        onOpenGrid={() => openNewTask()}
        onOpenDiagnostics={() => setDiagOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
      />

      {openedTask && (
        <TaskDetail
          job={openedTask}
          onBack={() => setOpenedTask(null)}
          onViewAll={openTaskResults}
          onChanged={() => void reloadJobs()}
          blockedBy={
            runningJob && runningJob.id !== openedTask.id
              ? runningJob.name || runningJob.keyword
              : null
          }
        />
      )}

      {view === 'collect' && !openedTask && (
        <div className="collect-view">
          {/* "0 tasks" plus a New-task button above an empty-state card that
              said the same thing made the first run read as three empty
              labels. The card owns the call to action until a task exists. */}
          {jobs.length > 0 && (
            <div className="collect-toolbar">
              <span className="collect-count">{t('nav.taskCount', { count: jobs.length })}</span>
              <Button
                size="small"
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => openNewTask()}
              >
                {t('grid.tabNew')}
              </Button>
            </div>
          )}

          {resumeJob && (
            <Alert
              className="resume-banner"
              type="info"
              showIcon
              closable
              onClose={() => setResumeJob(null)}
              message={t('queue.resumeTitle', {
                keyword: resumeJob.name || resumeJob.keyword,
              })}
              description={t('queue.resumeBody', {
                done: resumeJob.doneTiles + resumeJob.failedTiles,
                total: resumeJob.totalTiles,
              })}
              action={
                <Button size="small" type="primary" onClick={() => void handleResumeJob()}>
                  {t('queue.resume')}
                </Button>
              }
            />
          )}

          <MapHealthNotice
            mapHealth={mapHealth}
            // The collector switch is the authoritative "a collection is in
            // progress" signal: the runner owns it and turns it off on every
            // exit path (task end, pause, cancel, clear). The jobs table is a
            // *second* source for the same fact, and it can disagree — a task
            // killed with the app stays `running` there while nothing is
            // collecting. The old gate (`listening && runningJob`) therefore
            // read the same fact twice, from the weaker source, and made the
            // notice unreachable in the deterministic e2e (no task there, but
            // a switch there is). `start_job` sets the status first and the
            // switch second, so "switch on" is never "no task running".
            active={listening}
            lastActivityAtRef={lastActivityRef}
            busy={starting}
            onRestart={() => void handleRestartCollector()}
            onReloadMap={() => void handleReloadMap()}
          />

          <div className="collect-body">
            <JobQueue
              jobs={jobs}
              totalRows={stats.all}
              rowsLoading={loadingRows}
              onNew={openNewTask}
              onViewData={() => changeView('data')}
              onOpenTask={setOpenedTask}
              onViewResults={openTaskResults}
              onChanged={() => void reloadJobs()}
            />
          </div>
        </div>
      )}

      {view === 'data' && !openedTask && (
        <>
          <MetricStrip
        total={stats.all}
        avgRating={stats.avgRating}
        ratedCount={stats.rated}
        withPhone={stats.withPhone}
        withPhoneShare={withPhoneShare}
        bump={bump.count}
        bumpKey={bump.key}
      />

      {(stats.all > 0 || taskFilter !== 'all') && (
        <FilterBar
          query={query}
          rating={rating}
          contact={contact}
          timeRange={timeRange}
          typeOptions={typeOptions}
          types={typeFilter}
          tasks={jobs}
          taskFilter={taskFilter}
          showOnlyNew={currentTask !== null && currentTask.lastExportedAt > 0}
          onlyNew={onlyNew}
          hasFilters={hasFilters}
          searchRef={searchRef}
          onQuery={setQuery}
          onRating={setRating}
          onContact={setContact}
          onTimeRange={setTimeRange}
          onTypes={setTypeFilter}
          onTaskFilter={handleTaskFilter}
          onOnlyNew={setOnlyNew}
          onReset={resetFilters}
        />
      )}

      {stats.all > 0 && (
        <div className="table-toolbar">
          <span className="table-toolbar-count">
            {hasFilters
              ? t('table.showingOf', {
                  shown: stats.total,
                  total: stats.all,
                })
              : t('table.count', { count: stats.all })}
          </span>
          <div style={{ flex: 1 }} />
          {/* UI-04: column picker. A popover rather than a dropdown menu so
              several boxes can be toggled without it closing each time; the
              labels come from the column definitions themselves. */}
          <Popover
            placement="bottomRight"
            trigger="click"
            content={
              <Checkbox.Group
                className="column-picker"
                value={visibleColumnKeys}
                onChange={applyColumnVisibility}
              >
                {allColumns.map((column) => {
                  const key = String(column.key);
                  return (
                    <Checkbox
                      key={key}
                      value={key}
                      disabled={MANDATORY_COLUMN_KEYS.has(key)}
                    >
                      {key === 'actions' ? t('table.rowMenu') : String(column.title)}
                    </Checkbox>
                  );
                })}
              </Checkbox.Group>
            }
          >
            <Button
              size="small"
              icon={<ColumnHeightOutlined />}
              title={t('table.columns')}
              aria-label={t('table.columns')}
            />
          </Popover>
          <Tooltip title={t('table.mineEmailsHint')}>
            <Button
              size="small"
              icon={<MailOutlined />}
              loading={!!emailMining}
              onClick={mineEmails}
            >
              {emailMining
                ? t('table.miningProgress', {
                    done: emailMining.done,
                    total: emailMining.total,
                    found: emailMining.found,
                  })
                : t('table.mineEmails')}
            </Button>
          </Tooltip>
          <Tooltip
            title={
              enriching
                ? t('table.enrichCancelHint')
                : paneBusyElsewhere
                  ? t('table.enrichBlockedHint')
                  : t('table.enrichHint')
            }
          >
            <Button
              size="small"
              icon={enriching ? <SyncOutlined spin /> : <FileDoneOutlined />}
              // Another pane owner would refuse the start anyway; say so before
              // the click. The cancel state must stay clickable (C-01).
              disabled={!enriching && paneBusyElsewhere}
              onClick={() => {
                // Click-to-cancel: the runner checks the flag between places
                // and at every poll, so a stop lands within seconds.
                if (enriching) {
                  void invoke('enrich_stop').catch(() => {});
                } else {
                  enrichSelected();
                }
              }}
            >
              {enriching
                ? t('table.enrichProgress', { done: enriching.done, total: enriching.total })
                : t('table.enrich')}
            </Button>
          </Tooltip>
          <Dropdown
            menu={{
              // The default format goes first; both entries stay reachable.
              items: exportMenuItems,
              onClick: ({ key }) => {
                const saveAs = key.endsWith('-save-as');
                const format = (saveAs ? key.replace('-save-as', '') : key) as ExportKind;
                void handleExport(format, saveAs);
              },
            }}
          >
            <Button
              size="small"
              icon={<DownloadOutlined />}
              loading={exporting}
            >
              {selectedKeys.length > 0
                ? t('table.exportSelected', { count: selectedKeys.length })
                : t('table.exportCount', { count: stats.total })}
              <DownOutlined style={{ fontSize: 9 }} />
            </Button>
          </Dropdown>
          {lastExport && (
            <Tooltip title={t('table.openLastExport', { file: fileNameOf(lastExport) })}>
              <Button
                size="small"
                icon={<FolderOpenOutlined />}
                onClick={() => void revealExport()}
              />
            </Tooltip>
          )}
          <Tooltip title={t('table.clearTooltip')}>
            <Popconfirm
              // UI-02a: the count is the whole point of the confirmation — a
              // bare "clear all data?" does not say what is about to go.
              title={t('table.clearTitle', { count: stats.all.toLocaleString() })}
              description={
                <div className="clear-confirm">
                  <div className="clear-confirm-desc">{t('table.clearDesc')}</div>
                  {/* The way out before committing: export now, clear only
                      after a second confirmation. */}
                  <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    onClick={() => void handleExport('excel')}
                  >
                    {t('table.exportFirst')}
                  </Button>
                </div>
              }
              okText={t('common.clear')}
              cancelText={t('common.cancel')}
              okButtonProps={{ danger: true }}
              onConfirm={() => void handleClear()}
            >
              <Button
                size="small"
                danger
                type="text"
                icon={<DeleteOutlined />}
                aria-label={t('table.clearTooltip')}
              />
            </Popconfirm>
          </Tooltip>
        </div>
      )}

      <div className="table-wrap" ref={attachTableWrap}>
        {showGuide ? (
          <div className="empty-data">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('empty.dataTitle')} />
            <div className="empty-data-note">{t('empty.dataNote')}</div>
            <Button type="primary" onClick={() => changeView('collect')}>
              {t('empty.goCollect')}
            </Button>
          </div>
        ) : (
          <Table<Business>
            dataSource={rows}
            columns={columns}
            rowKey="place_id"
            loading={loadingRows}
            size="small"
            // R-18: every object/callback below is memoized — rebuilding them
            // per render defeated the table's shallow compare (see the table*
            // definitions above the return).
            //
            // The fixed widths must cover every visible column or the last one
            // gets clipped. Base set (name/rating/reviews/phone + selection +
            // actions) sums to 610; the wide value is a deliberate minimum that
            // lets the many extra columns scroll a little.
            scroll={tableScroll}
            onChange={tableOnChange}
            // Virtualization only pays off where the node count explodes: a
            // 100/200-row page renders ~1100/2200 cells, while 20/50 rows stay
            // small enough that full rendering keeps row heights and sticky
            // columns simple.
            virtual={pageSize >= 100}
            rowClassName={tableRowClassName}
            pagination={tablePagination}
            rowSelection={tableRowSelection}
            onRow={tableOnRow}
            locale={tableLocale}
          />
        )}

        {unseen > 0 && (
          <button type="button" className="new-rows-pill" onClick={jumpToLatest}>
            <DownOutlined />
            {t('table.newRows', { count: unseen })}
          </button>
        )}
      </div>

      {selectedKeys.length > 0 && (
        <BulkBar
          count={selectedKeys.length}
          total={stats.total}
          beyondView={selectedBeyondView}
          exporting={exporting}
          onExport={(format) => void handleExport(format)}
          onCopyPhones={() => void copyPhones()}
          onSelectAll={() => void selectAllFiltered()}
          onClear={() => {
            selectedRowsRef.current.clear();
            setSelectedKeys([]);
          }}
        />
      )}
        </>
      )}

      <DetailDrawer
        business={detail}
        onClose={closeDetail}
        onLocate={(business) => void handleLocate(business)}
        position={detailPosition}
        total={stats.total}
        onPrev={showPrevDetail}
        onNext={showNextDetail}
        onSelectType={filterByType}
        locateBlocked={paneBusyElsewhere}
        mapBusyName={runningJob ? runningJob.name || runningJob.keyword : null}
        onReviewsBusyChange={setReviewsBusy}
      />

      <DiagnosticsDrawer
        open={diagOpen}
        loading={diagLoading}
        data={diag}
        onClose={() => setDiagOpen(false)}
        onRefresh={() => void loadDiagnostics()}
      />

      <SettingsDrawer
        open={settingsOpen}
        panelWidth={panelWidth}
        // Changing the map language/region reloads the pane, which the backend
        // refuses while *any* pane owner holds it — a task, the enrichment
        // runner, a reviews fetch or a collecting session (P2-6). Passing only
        // `runningJob` let the user pick a value the backend then rejected with
        // a raw `enrich_busy` / `reviews_busy` code.
        busy={paneBusyElsewhere}
        onClose={() => setSettingsOpen(false)}
        onCheckUpdates={() => checkUpdates(true)}
      />

      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />

      <GridDialog
        open={gridOpen}
        initialKeyword={newKeyword}
        onClose={() => setGridOpen(false)}
        onCreated={addCreatedJobs}
        busyJobName={runningJob ? runningJob.name || runningJob.keyword : null}
      />

      {/* Close prompt (window X while work is running). Rust prevented the
          close and asked instead of killing the process mid-tile: an accidental
          click used to cost the rest of the task. "Pause and exit" is the
          primary action because it keeps the grid resumable. */}
      <Modal
        open={closePrompt !== null}
        title={t('close.title')}
        closable={closingMode === null}
        maskClosable={false}
        footer={[
          <Button
            key="force"
            danger
            disabled={closingMode !== null}
            onClick={() => void exitApp('force')}
          >
            {t('close.forceExit')}
          </Button>,
          <Button
            key="stay"
            disabled={closingMode !== null}
            onClick={() => setClosePrompt(null)}
          >
            {t('close.stay')}
          </Button>,
          <Button
            key="pause"
            type="primary"
            loading={closingMode === 'pause'}
            disabled={closingMode === 'force'}
            onClick={() => void exitApp('pause')}
          >
            {t('close.pauseAndExit')}
          </Button>,
        ]}
        onCancel={() => {
          if (closingMode !== null) return;
          setClosePrompt(null);
        }}
      >
        {closePrompt?.jobRunning && <p>{t('close.jobRunning')}</p>}
        {closePrompt?.emailMining && <p>{t('close.emailMining')}</p>}
        <p>{t('close.hint')}</p>
      </Modal>

      {/* Update offer (G-06): shown by the silent startup check or the manual
          one in settings. Installing is irreversible from the UI's point of
          view — the plugin restarts the app — so the dialog locks itself. */}
      <Modal
        open={updateOffer !== null}
        title={t('update.availableTitle', { version: updateOffer?.version ?? '' })}
        okText={t('update.installRestart')}
        cancelText={t('update.later')}
        okButtonProps={{ loading: updateInstalling }}
        cancelButtonProps={{ disabled: updateInstalling }}
        closable={!updateInstalling}
        onOk={() => void installUpdate()}
        onCancel={() => {
          if (updateInstalling) return;
          // Remember the dismissal: the silent startup check may still be in
          // flight and must not re-raise the same version once it lands.
          dismissedUpdateRef.current = updateOffer?.version ?? null;
          offerUpdate(null);
        }}
      >
        {updateOffer?.body && (
          <div className="update-notes">
            <div className="update-notes-title">{t('update.releaseNotes')}</div>
            <span>{updateOffer.body}</span>
          </div>
        )}
        {updateInstalling && (
          <div className="update-installing">
            <div>{t('update.installing')}</div>
            <Progress
              percent={updatePercent ?? 0}
              status={updatePercent === null ? 'active' : 'normal'}
              size="small"
            />
          </div>
        )}
      </Modal>
    </div>
  );
}


