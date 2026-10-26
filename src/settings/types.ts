import type { Locale } from '../i18n/locales';

/**
 * Mirrors `src-tauri/src/settings.rs` field for field.
 *
 * The Rust struct uses `#[serde(rename_all = "camelCase")]`, so the names here
 * are the JSON contract — renaming one side without the other breaks updates
 * silently (the backend rejects unknown keys, which turns a typo into an error
 * instead of a no-op).
 */
export interface Settings {
  version: number;
  language: Locale;
  mapLanguage: 'en' | 'zh-CN' | 'es';
  mapRegion: '' | 'US' | 'CN' | 'ES';
  scrollMinMs: number;
  scrollMaxMs: number;
  maxScrolls: number;
  stopAfterIdle: number;
  jitter: boolean;
  onlyWithPhone: boolean;
  pageSize: number;
  theme: ThemeMode;
  rememberSplit: boolean;
  splitRatio: number;
  /**
   * Maps pane hidden at 1px so the table gets the full width (UI-11).
   * Independent of `splitRatio`: restoring brings the dragged ratio back.
   */
  mapCollapsed: boolean;
  logLevel: 'silent' | 'normal' | 'verbose';
  defaultExportFormat: ExportFormat;
  /**
   * "default" | "hubspot" | "pipedrive" — how export column headers (and JSON
   * keys) are named. A CRM preset renames the columns that CRM knows so its
   * import wizard auto-maps them; unknown columns keep their default names.
   */
  exportPreset: ExportPreset;
  csvBom: boolean;
  fileNameTemplate: string;
  /** Folder pinned for exports; empty means "no fixed folder". */
  exportDir: string;
  /** "ask" = save dialog each time, "auto" = write straight into `exportDir`. */
  exportSaveMode: ExportSaveMode;
  /** Reveal the file in the OS file manager after a successful export. */
  openExportFolder: boolean;
  duplicateStrategy: DuplicateStrategy;
  /**
   * UI-04: table columns the user hid (empty = width-based defaults). The
   * panel's width stays the source of truth for which columns *can* appear;
   * this list only subtracts, so a resize never resurrects a hidden column.
   */
  hiddenColumns: string[];
  /** Directory of the last export; written by Rust, no UI control. */
  lastExportDir: string;
  /** Full path of the last export; written by Rust, no UI control. */
  lastExportPath: string;
}

export type ThemeMode = 'system' | 'light' | 'dark';
export type ExportFormat = 'xlsx' | 'csv' | 'json' | 'jsonl';
export type ExportPreset = 'default' | 'hubspot' | 'pipedrive';
export type DuplicateStrategy = 'ignore' | 'update';
export type ExportSaveMode = 'ask' | 'auto';

/** Must match the `page_size` allow-list in `Settings::normalized()`. */
export const PAGE_SIZE_OPTIONS = [20, 50, 100, 200] as const;

/**
 * Google Maps `hl` values. Labels are written in the target language on purpose
 * (same idea as `LOCALE_LABEL`): a user looking for Spanish should recognise
 * "Español" even when the panel is in Chinese.
 */
export const MAP_LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'es', label: 'Español' },
] as const;

/** Must match the `map_region` allow-list in `Settings::normalized()`. */
export const MAP_REGIONS = ['', 'US', 'CN', 'ES'] as const;
