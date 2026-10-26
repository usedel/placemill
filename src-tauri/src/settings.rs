use serde::{Deserialize, Serialize};

/// Bumped together with a branch in [`migrate`].
pub const SETTINGS_VERSION: u32 = 1;

/// Default export file name. `{date}` becomes `YYYYMMDD`, `{count}` the number
/// of exported rows. Rendered on the panel side (it owns the local clock);
/// Rust only sanitizes whatever it receives.
pub const DEFAULT_FILE_NAME_TEMPLATE: &str = "placemill-{date}-{count}";

/// Every key `update_settings` accepts, in the camelCase form used by the
/// JSON/IPC contract. Anything outside this list is rejected instead of being
/// silently dropped by serde, which would look like "saved" to the frontend.
pub const KNOWN_FIELDS: &[&str] = &[
    "version",
    "language",
    "mapLanguage",
    "mapRegion",
    "scrollMinMs",
    "scrollMaxMs",
    "maxScrolls",
    "stopAfterIdle",
    "jitter",
    "onlyWithPhone",
    "pageSize",
    "theme",
    "rememberSplit",
    "splitRatio",
    "mapCollapsed",
    "logLevel",
    "defaultExportFormat",
    "exportPreset",
    "csvBom",
    "fileNameTemplate",
    "exportDir",
    "exportSaveMode",
    "openExportFolder",
    "duplicateStrategy",
    "hiddenColumns",
    "lastExportDir",
    "lastExportPath",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Schema version, used for migrations.
    pub version: u32,
    /// "en" | "zh" | "es"
    pub language: String,
    /// Maps `hl` parameter: "en" | "zh-CN" | "es".
    /// There is deliberately no "auto"/"follow the UI language" value: deriving
    /// it in the frontend would duplicate the defaults in two places.
    pub map_language: String,
    /// Maps `gl` parameter; empty means "let Google decide".
    pub map_region: String,
    /// Auto-scroll delay in milliseconds. This pair is the source of truth; the
    /// speed presets in the UI are derived by matching these two values.
    pub scroll_min_ms: u64,
    pub scroll_max_ms: u64,
    pub max_scrolls: u32,
    pub stop_after_idle: u32,
    /// When off the delay is constant — debug only, it raises the rate-limit risk.
    pub jitter: bool,
    pub only_with_phone: bool,
    pub page_size: u32,
    /// "system" | "light" | "dark"
    pub theme: String,
    pub remember_split: bool,
    pub split_ratio: f64,
    /// Maps pane hidden at 1px so the table gets the full width (UI-11).
    /// Independent of `split_ratio`: collapsing must not destroy the ratio the
    /// user dragged to, and restoring brings it back untouched.
    pub map_collapsed: bool,
    /// "silent" | "normal" | "verbose"
    pub log_level: String,

    /// "xlsx" | "csv" | "json" | "jsonl" — which format the export dropdown puts first.
    pub default_export_format: String,
    /// "default" | "hubspot" | "pipedrive" — how export column headers are
    /// named. "default" keeps the display headers; a CRM preset renames the
    /// columns the CRM's import wizard knows (HubSpot: `domain`/`zip`/…,
    /// Pipedrive: `addr_locality`/…) so the file imports without manual
    /// mapping. Columns a preset does not know keep their default names, so
    /// no data is ever dropped by choosing a preset.
    pub export_preset: String,
    /// Prepend a UTF-8 BOM so Excel stops mangling non-ASCII CSV cells.
    pub csv_bom: bool,
    /// File name template. `{date}` and `{count}` are replaced by the panel
    /// (which has the local clock); Rust only sanitizes the result.
    pub file_name_template: String,
    /// Folder pinned by the user for exports. Empty means "no fixed folder":
    /// the save dialog then opens at `last_export_dir` instead.
    pub export_dir: String,
    /// "ask" | "auto" — whether an export opens the save dialog or writes
    /// straight into `export_dir`. `auto` is only kept when a folder is set.
    pub export_save_mode: String,
    /// Reveal the written file in the OS file manager after an export. Meant for
    /// `auto` mode, where the dialog no longer confirms where the file went.
    pub open_export_folder: bool,
    /// "ignore" | "update" — what a duplicate `place_id` does to the stored row.
    pub duplicate_strategy: String,
    /// UI-04: table columns the user hid. Empty means "nothing hidden": the
    /// panel's width-based defaults stay the source of truth for which columns
    /// *can* appear, and this list only subtracts from that set — so a window
    /// resize never resurrects a column the user closed, and a stored key from
    /// a future build is simply ignored instead of breaking the table.
    pub hidden_columns: Vec<String>,
    /// Directory of the last successful export. Internal: no UI control, the
    /// export dialog simply reopens where the user left off.
    pub last_export_dir: String,
    /// Full path of the last successful export. Internal like `last_export_dir`:
    /// written by the export commands, read by `reveal_export`. Empty means the
    /// app has never exported, or the user cleared the settings.
    pub last_export_path: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            language: "en".into(),
            map_language: "en".into(),
            map_region: String::new(),
            scroll_min_ms: 1000,
            scroll_max_ms: 3000,
            max_scrolls: 80,
            stop_after_idle: 4,
            jitter: true,
            only_with_phone: false,
            page_size: 50,
            theme: "system".into(),
            remember_split: true,
            split_ratio: crate::DEFAULT_SPLIT_RATIO,
            map_collapsed: false,
            log_level: "normal".into(),
            default_export_format: "xlsx".into(),
            export_preset: "default".into(),
            csv_bom: true,
            file_name_template: DEFAULT_FILE_NAME_TEMPLATE.into(),
            export_dir: String::new(),
            export_save_mode: "ask".into(),
            open_export_folder: false,
            duplicate_strategy: "ignore".into(),
            hidden_columns: Vec::new(),
            last_export_dir: String::new(),
            last_export_path: String::new(),
        }
    }
}

impl Settings {
    /// Google Maps `hl`/`gl` query string, without the leading `?`.
    ///
    /// `gl` is omitted when empty (let Google decide) and always lower-cased:
    /// Google expects `gl=us`, while the stored value is `"US"` so the
    /// `matches!` validation stays readable.
    pub fn maps_locale_query(&self) -> String {
        let mut query = format!("hl={}", self.map_language);
        if !self.map_region.is_empty() {
            query.push_str("&gl=");
            query.push_str(&self.map_region.to_lowercase());
        }
        query
    }

    /// Landing URL for the maps webview.
    pub fn maps_home_url(&self) -> String {
        format!("https://www.google.com/maps?{}", self.maps_locale_query())
    }

    /// The subset `intercept.js` consumes.
    ///
    /// Kept separate from the full struct so the maps webview's localStorage never
    /// holds UI-only preferences, and so "did the collector configuration change?"
    /// can be answered with a plain value comparison.
    pub fn collector_payload(&self) -> serde_json::Value {
        serde_json::json!({
            "scrollMinMs": self.scroll_min_ms,
            "scrollMaxMs": self.scroll_max_ms,
            "maxScrolls": self.max_scrolls,
            "stopAfterIdle": self.stop_after_idle,
            "jitter": self.jitter,
            "onlyWithPhone": self.only_with_phone,
            "logLevel": self.log_level,
        })
    }

    /// Single entry point for validation. The frontend only constrains its
    /// inputs; every clamp and fallback happens here.
    pub fn normalized(self) -> Self {
        self.normalize_with_report().0
    }

    /// `normalized()` plus the fields it had to change (R-25).
    ///
    /// `update_settings` reports this list to the panel. Clamping a value and
    /// answering `Ok` without a word makes the UI show "saved" while the stored
    /// value is not what the user asked for — the third silent failure of R-25.
    /// Loading from SQLite ignores the list: repairing a hand-edited row is
    /// exactly what `normalized()` is for.
    pub fn normalize_with_report(mut self) -> (Self, Vec<&'static str>) {
        let mut corrected: Vec<&'static str> = Vec::new();

        // Bookkeeping, not a correction: the version is stamped on every load.
        self.version = SETTINGS_VERSION;

        if !matches!(self.language.as_str(), "en" | "zh" | "es") {
            self.language = "en".into();
            corrected.push("language");
        }
        if !matches!(self.map_language.as_str(), "en" | "zh-CN" | "es") {
            self.map_language = "en".into();
            corrected.push("mapLanguage");
        }
        if !matches!(self.map_region.as_str(), "" | "US" | "CN" | "ES") {
            self.map_region.clear();
            corrected.push("mapRegion");
        }

        let scroll_min = self.scroll_min_ms.clamp(200, 10_000);
        if scroll_min != self.scroll_min_ms {
            self.scroll_min_ms = scroll_min;
            corrected.push("scrollMinMs");
        }
        let scroll_max = self.scroll_max_ms.clamp(500, 30_000).max(self.scroll_min_ms);
        if scroll_max != self.scroll_max_ms {
            self.scroll_max_ms = scroll_max;
            corrected.push("scrollMaxMs");
        }
        let max_scrolls = self.max_scrolls.clamp(1, 1_000);
        if max_scrolls != self.max_scrolls {
            self.max_scrolls = max_scrolls;
            corrected.push("maxScrolls");
        }
        let idle = self.stop_after_idle.clamp(1, 50);
        if idle != self.stop_after_idle {
            self.stop_after_idle = idle;
            corrected.push("stopAfterIdle");
        }

        if !matches!(self.page_size, 20 | 50 | 100 | 200) {
            self.page_size = 50;
            corrected.push("pageSize");
        }
        if !matches!(self.theme.as_str(), "system" | "light" | "dark") {
            self.theme = "system".into();
            corrected.push("theme");
        }
        if !matches!(self.log_level.as_str(), "silent" | "normal" | "verbose") {
            self.log_level = "normal".into();
            corrected.push("logLevel");
        }

        if !matches!(self.default_export_format.as_str(), "xlsx" | "csv" | "json" | "jsonl") {
            self.default_export_format = "xlsx".into();
            corrected.push("defaultExportFormat");
        }
        if !matches!(self.export_preset.as_str(), "default" | "hubspot" | "pipedrive") {
            self.export_preset = "default".into();
            corrected.push("exportPreset");
        }
        if !matches!(self.duplicate_strategy.as_str(), "ignore" | "update") {
            self.duplicate_strategy = "ignore".into();
            corrected.push("duplicateStrategy");
        }

        // An empty template would produce a nameless file; the length cap keeps
        // a pasted wall of text from breaking the save dialog.
        let trimmed_template = self.file_name_template.trim().to_string();
        if trimmed_template != self.file_name_template {
            self.file_name_template = trimmed_template;
            corrected.push("fileNameTemplate");
        }
        if self.file_name_template.is_empty() {
            self.file_name_template = DEFAULT_FILE_NAME_TEMPLATE.into();
            if !corrected.contains(&"fileNameTemplate") {
                corrected.push("fileNameTemplate");
            }
        }
        if self.file_name_template.chars().count() > 120 {
            self.file_name_template = self.file_name_template.chars().take(120).collect();
            if !corrected.contains(&"fileNameTemplate") {
                corrected.push("fileNameTemplate");
            }
        }

        // A pinned export folder has to be absolute: a relative one would be
        // resolved against the process CWD, so "auto" exports would land
        // somewhere unrelated to what the settings drawer shows. Existence is
        // *not* checked here — the folder can live on a drive that happens to be
        // unplugged right now, and `normalized()` must stay free of file I/O.
        let trimmed_dir = self.export_dir.trim().to_string();
        if trimmed_dir != self.export_dir {
            self.export_dir = trimmed_dir;
            corrected.push("exportDir");
        }
        if self.export_dir.chars().count() > 512
            || (!self.export_dir.is_empty() && !std::path::Path::new(&self.export_dir).is_absolute())
        {
            self.export_dir.clear();
            if !corrected.contains(&"exportDir") {
                corrected.push("exportDir");
            }
        }

        if !matches!(self.export_save_mode.as_str(), "ask" | "auto") {
            self.export_save_mode = "ask".into();
            corrected.push("exportSaveMode");
        }
        // "auto" without a folder has no target: ask instead of silently falling
        // back to some other directory the user never chose.
        if self.export_dir.is_empty() && self.export_save_mode != "ask" {
            self.export_save_mode = "ask".into();
            if !corrected.contains(&"exportSaveMode") {
                corrected.push("exportSaveMode");
            }
        }

        // UI-04: the column keys are the panel's vocabulary, so Rust does not
        // mirror an allow-list here (a second list would drift); unknown keys
        // are dropped by the frontend when it intersects with its own columns.
        // The caps keep a hand-edited or corrupted row from bloating the JSON.
        let original_columns = self.hidden_columns.clone();
        let mut columns: Vec<String> = self
            .hidden_columns
            .into_iter()
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty() && key.chars().count() <= 40)
            .collect();
        columns.sort_unstable();
        columns.dedup();
        columns.truncate(32);
        if columns != original_columns {
            corrected.push("hiddenColumns");
        }
        self.hidden_columns = columns;

        // f64::clamp panics on NaN, and JSON numbers can arrive as +/-inf.
        let previous_ratio = self.split_ratio;
        self.split_ratio = if self.split_ratio.is_finite() {
            self.split_ratio
                .clamp(crate::MIN_SPLIT_RATIO, crate::MAX_SPLIT_RATIO)
        } else {
            crate::DEFAULT_SPLIT_RATIO
        };
        if self.split_ratio != previous_ratio {
            corrected.push("splitRatio");
        }

        (self, corrected)
    }
}

/// Migrations run on the raw JSON, *before* deserialization: `normalized()`
/// overwrites `version`, so a migration that reads the struct would never see
/// the old version number.
pub fn migrate(value: &mut serde_json::Value) {
    let from = value.get("version").and_then(|v| v.as_u64()).unwrap_or(0);
    if from < 1 {
        // v0 is the data written before the field existed; names and semantics
        // are unchanged, so stamping the version is enough.
        if let Some(obj) = value.as_object_mut() {
            obj.insert("version".into(), serde_json::json!(1));
        }
    }
    // if from < 2 { ... }
}

/// Reject unknown patch keys so a typo cannot produce a silent no-op that still
/// returns `Ok`. Deliberately not `#[serde(deny_unknown_fields)]`: that would
/// also break forward compatibility when the panel is newer than the backend.
pub fn validate_patch(patch: &serde_json::Value) -> Result<(), String> {
    let Some(obj) = patch.as_object() else {
        return Err("invalid_setting_patch".to_string());
    };
    for key in obj.keys() {
        if !KNOWN_FIELDS.contains(&key.as_str()) {
            return Err(format!("unknown_setting: {}", key));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_survive_normalization() {
        let settings = Settings::default().normalized();
        assert_eq!(settings.version, SETTINGS_VERSION);
        assert_eq!(settings.page_size, 50);
        assert_eq!(settings.theme, "system");
        assert_eq!(settings.file_name_template, DEFAULT_FILE_NAME_TEMPLATE);
        assert_eq!(settings.duplicate_strategy, "ignore");
        assert!(settings.csv_bom);
        assert!(settings.export_dir.is_empty());
        assert_eq!(settings.export_save_mode, "ask");
        assert!(!settings.open_export_folder);
    }

    #[test]
    fn defaults_are_not_reported_as_corrections() {
        let (settings, corrected) = Settings::default().normalize_with_report();
        assert_eq!(settings.version, SETTINGS_VERSION);
        assert!(corrected.is_empty(), "{:?}", corrected);
    }

    #[test]
    fn normalization_reports_every_field_it_changed() {
        let (settings, corrected) = Settings {
            page_size: 7,
            scroll_min_ms: 99_999,
            theme: "neon".into(),
            ..Settings::default()
        }
        .normalize_with_report();

        assert_eq!(settings.page_size, 50);
        assert_eq!(settings.scroll_min_ms, 10_000);
        // Raising the floor also raises the ceiling: the pair must stay ordered.
        assert_eq!(settings.scroll_max_ms, 10_000);
        assert_eq!(settings.theme, "system");
        // Report order follows the validation order in `normalize_with_report`.
        assert_eq!(
            corrected,
            vec!["scrollMinMs", "scrollMaxMs", "pageSize", "theme"]
        );
    }

    #[test]
    fn auto_mode_without_a_folder_is_reported() {
        let (settings, corrected) = Settings {
            export_save_mode: "auto".into(),
            ..Settings::default()
        }
        .normalize_with_report();

        assert_eq!(settings.export_save_mode, "ask");
        assert!(corrected.contains(&"exportSaveMode"), "{:?}", corrected);
    }

    #[test]
    fn unknown_enum_values_fall_back() {
        let settings = Settings {
            language: "fr".into(),
            theme: "neon".into(),
            log_level: "loud".into(),
            default_export_format: "pdf".into(),
            export_preset: "salesforce".into(),
            duplicate_strategy: "merge".into(),
            map_language: "de".into(),
            map_region: "JP".into(),
            page_size: 7,
            ..Settings::default()
        }
        .normalized();

        assert_eq!(settings.language, "en");
        assert_eq!(settings.theme, "system");
        assert_eq!(settings.log_level, "normal");
        assert_eq!(settings.default_export_format, "xlsx");
        assert_eq!(settings.export_preset, "default");
        assert_eq!(settings.duplicate_strategy, "ignore");
        assert_eq!(settings.map_language, "en");
        assert_eq!(settings.map_region, "");
        assert_eq!(settings.page_size, 50);
    }

    #[test]
    fn json_export_formats_and_presets_are_accepted() {
        for format in ["xlsx", "csv", "json", "jsonl"] {
            let settings = Settings {
                default_export_format: format.into(),
                ..Settings::default()
            }
            .normalized();
            assert_eq!(settings.default_export_format, format);
        }
        for preset in ["default", "hubspot", "pipedrive"] {
            let settings = Settings {
                export_preset: preset.into(),
                ..Settings::default()
            }
            .normalized();
            assert_eq!(settings.export_preset, preset);
        }
    }

    #[test]
    fn scroll_range_is_clamped_and_ordered() {
        let settings = Settings {
            scroll_min_ms: 99_999,
            scroll_max_ms: 10,
            ..Settings::default()
        }
        .normalized();
        assert_eq!(settings.scroll_min_ms, 10_000);
        assert_eq!(settings.scroll_max_ms, 10_000);

        let nan = Settings {
            split_ratio: f64::NAN,
            ..Settings::default()
        }
        .normalized();
        assert_eq!(nan.split_ratio, crate::DEFAULT_SPLIT_RATIO);
    }

    #[test]
    fn empty_or_huge_file_name_templates_are_repaired() {
        let blank = Settings {
            file_name_template: "   ".into(),
            ..Settings::default()
        }
        .normalized();
        assert_eq!(blank.file_name_template, DEFAULT_FILE_NAME_TEMPLATE);

        let huge = Settings {
            file_name_template: "x".repeat(400),
            ..Settings::default()
        }
        .normalized();
        assert_eq!(huge.file_name_template.chars().count(), 120);
    }

    #[test]
    fn export_dir_is_trimmed_and_must_be_absolute() {
        let absolute = std::env::temp_dir().to_string_lossy().to_string();

        let kept = Settings {
            export_dir: format!("  {}  ", absolute),
            export_save_mode: "auto".into(),
            ..Settings::default()
        }
        .normalized();
        assert_eq!(kept.export_dir, absolute);
        assert_eq!(kept.export_save_mode, "auto");

        let relative = Settings {
            export_dir: "exports".into(),
            export_save_mode: "auto".into(),
            ..Settings::default()
        }
        .normalized();
        assert!(relative.export_dir.is_empty());
        // No folder, no silent target: the mode falls back to asking.
        assert_eq!(relative.export_save_mode, "ask");

        let unknown_mode = Settings {
            export_dir: absolute,
            export_save_mode: "sometimes".into(),
            ..Settings::default()
        }
        .normalized();
        assert_eq!(unknown_mode.export_save_mode, "ask");
    }

    #[test]
    fn hidden_columns_are_cleaned_not_validated() {
        let settings = Settings {
            hidden_columns: vec![
                "  types  ".into(),
                "types".into(),
                String::new(),
                "   ".into(),
                "x".repeat(80),
                "emails".into(),
            ],
            ..Settings::default()
        }
        .normalized();

        // Trimmed, de-duplicated, empties and over-long keys dropped, sorted.
        assert_eq!(settings.hidden_columns, vec!["emails", "types"]);

        // An unknown key survives here on purpose: the panel owns the column
        // vocabulary and simply ignores what it does not recognise.
        let future = Settings {
            hidden_columns: vec!["someFutureColumn".into()],
            ..Settings::default()
        }
        .normalized();
        assert_eq!(future.hidden_columns, vec!["someFutureColumn"]);

        assert!(Settings::default().normalized().hidden_columns.is_empty());
    }

    #[test]
    fn hidden_columns_patch_is_accepted() {
        assert!(validate_patch(&serde_json::json!({ "hiddenColumns": ["types"] })).is_ok());
    }

    #[test]
    fn collector_payload_holds_only_collector_fields() {
        let payload = Settings::default().collector_payload();
        let mut keys: Vec<&str> = payload.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "jitter",
                "logLevel",
                "maxScrolls",
                "onlyWithPhone",
                "scrollMaxMs",
                "scrollMinMs",
                "stopAfterIdle",
            ]
        );
    }

    #[test]
    fn patch_validation_rejects_unknown_keys() {
        let ok = serde_json::json!({ "theme": "dark", "pageSize": 100 });
        assert!(validate_patch(&ok).is_ok());

        let typo = serde_json::json!({ "scrollminMs": 500 });
        let error = validate_patch(&typo).unwrap_err();
        assert!(error.contains("unknown_setting"), "{}", error);
        assert!(error.contains("scrollminMs"), "{}", error);

        assert!(validate_patch(&serde_json::json!("nope")).is_err());
    }

    #[test]
    fn maps_query_omits_empty_region_and_lowercases_it() {
        let auto = Settings::default();
        assert_eq!(auto.maps_locale_query(), "hl=en");

        let china = Settings {
            map_language: "zh-CN".into(),
            map_region: "CN".into(),
            ..Settings::default()
        };
        assert_eq!(china.maps_locale_query(), "hl=zh-CN&gl=cn");
        assert_eq!(
            china.maps_home_url(),
            "https://www.google.com/maps?hl=zh-CN&gl=cn"
        );
    }
}
