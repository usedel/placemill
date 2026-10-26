import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  App as AntdApp,
  Button,
  Drawer,
  Input,
  InputNumber,
  Popconfirm,
  Radio,
  Segmented,
  Select,
  Switch,
  Tabs,
  Tooltip,
} from 'antd';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { ReloadOutlined, SyncOutlined } from '@ant-design/icons';

import { useI18n } from '../i18n';
import { LOCALES, LOCALE_LABEL } from '../i18n/locales';
import { useSettings } from '../settings/SettingsContext';
import { PRESET_RANGE, SPEED_ORDER, matchPreset, type SpeedPresetKey } from '../settings/presets';
import { useResolvedDark } from '../theme';
import {
  MAP_LANGUAGES,
  MAP_REGIONS,
  PAGE_SIZE_OPTIONS,
  type ExportFormat,
  type ExportPreset,
  type ExportSaveMode,
  type Settings,
  type ThemeMode,
} from '../settings/types';
import { DEFAULT_SPLIT } from './SplitHandle';

interface Props {
  open: boolean;
  /** Panel width in px, so the drawer never spills onto the map pane. */
  panelWidth: number;
  /**
   * A task is running. Changing the map language/region reloads the pane, which
   * would yank the map out from under the tile being collected — the backend
   * refuses it, so the controls say so before the user tries.
   */
  busy: boolean;
  onClose: () => void;
  /** Manual update check (G-06); the outcome is toasted by the caller. */
  onCheckUpdates: () => Promise<void>;
}

/** How long the map-level selects stay locked after a switch (page reload). */
const MAP_SWITCH_LOCK_MS = 1500;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <span className="settings-label">{label}</span>
      <div className="settings-control">{children}</div>
    </div>
  );
}

/** i18n key of a speed preset's label. */
function speedLabelKey(
  key: SpeedPresetKey,
): 'settings.speedSlow' | 'settings.speedNormal' | 'settings.speedFast' {
  return key === 'slow'
    ? 'settings.speedSlow'
    : key === 'normal'
      ? 'settings.speedNormal'
      : 'settings.speedFast';
}

export default function SettingsDrawer({
  open,
  panelWidth,
  busy,
  onClose,
  onCheckUpdates,
}: Props) {
  const { t } = useI18n();
  const { message, modal } = AntdApp.useApp();
  const { settings, update, reset } = useSettings();
  // UI-08: "System" is a preference, not a value — the effective theme is what
  // the OS currently says, so the summary line can state it outright.
  const systemDark = useResolvedDark(settings.theme);

  // Changing the map language/region reloads the whole maps page. Locking the
  // controls briefly keeps a user from queueing several reloads.
  const [switchingMap, setSwitchingMap] = useState(false);
  const lockTimerRef = useRef<number | null>(null);

  // UI-08: the drawer stays mounted between opens, so an uncontrolled tab
  // choice would outlive the visit that made it — reopening on 高级 is never
  // what someone wants. Every open starts at 常规.
  const [activeTab, setActiveTab] = useState('general');
  useEffect(() => {
    if (open) setActiveTab('general');
  }, [open]);

  // "Custom" is a UI-only state: no enum is stored (see presets.ts).
  const preset = matchPreset(settings.scrollMinMs, settings.scrollMaxMs);
  const [customMode, setCustomMode] = useState(false);

  useEffect(() => {
    // Any exact preset match means the value came from a preset (or a reset).
    if (preset !== null) setCustomMode(false);
  }, [preset]);

  // The file-name template is free text: keep a draft so typing does not write
  // to SQLite on every keystroke, and commit on blur / Enter.
  const [templateDraft, setTemplateDraft] = useState(settings.fileNameTemplate);

  useEffect(() => {
    setTemplateDraft(settings.fileNameTemplate);
  }, [settings.fileNameTemplate]);

  useEffect(
    () => () => {
      if (lockTimerRef.current !== null) window.clearTimeout(lockTimerRef.current);
    },
    [],
  );

  // Auto-update (G-06): the running build's version, shown next to the manual
  // check. `core:default` already grants `app:allow-version`.
  const [appVersion, setAppVersion] = useState('');
  const [checkingUpdates, setCheckingUpdates] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getVersion()
      .then((version) => {
        if (!cancelled) setAppVersion(version);
      })
      .catch(() => {
        /* version display is informational; the update check still works */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runUpdateCheck = async () => {
    setCheckingUpdates(true);
    try {
      await onCheckUpdates();
    } finally {
      setCheckingUpdates(false);
    }
  };

  const apply = (patch: Partial<Settings>) => {
    void update(patch).catch((error: unknown) => {
      message.error(t('settings.saveFailed', { error: String(error) }));
    });
  };

  // UI-08: the map reload warning used to sit in the drawer permanently,
  // shouting at every open. It now appears exactly when it is relevant — at
  // the moment of the change — and cancelling leaves the value untouched.
  const applyMapLocale = (patch: Partial<Settings>) => {
    modal.confirm({
      title: t('settings.mapReloadConfirmTitle'),
      content: t('settings.mapReloadConfirmBody'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      onOk: () => {
        apply(patch);
        setSwitchingMap(true);
        if (lockTimerRef.current !== null) window.clearTimeout(lockTimerRef.current);
        lockTimerRef.current = window.setTimeout(() => {
          lockTimerRef.current = null;
          setSwitchingMap(false);
        }, MAP_SWITCH_LOCK_MS);
      },
    });
  };

  const applyRange = (min: number | null, max: number | null) => {
    // A cleared input reports null: wait until both bounds are real numbers
    // instead of writing a half-edited pair.
    if (min === null || max === null) return;
    apply({ scrollMinMs: min, scrollMaxMs: max });
  };

  const speedMode: SpeedPresetKey | 'custom' =
    customMode || preset === null ? 'custom' : preset;

  const selectSpeed = (value: SpeedPresetKey | 'custom') => {
    if (value === 'custom') {
      setCustomMode(true);
      return;
    }
    setCustomMode(false);
    const range = PRESET_RANGE[value];
    apply({ scrollMinMs: range.min, scrollMaxMs: range.max });
  };

  const restoreDefaults = () => {
    // Rust resets the values and re-applies the default split; the panel picks
    // the new values up from `settings:changed`.
    void reset().catch((error: unknown) => {
      message.error(t('settings.restoreFailed', { error: String(error) }));
    });
  };

  const regionLabel = (code: (typeof MAP_REGIONS)[number]) => {
    if (code === '') return t('settings.regionAuto');
    if (code === 'US') return t('settings.regionUs');
    if (code === 'CN') return t('settings.regionCn');
    return t('settings.regionEs');
  };

  const commitTemplate = () => {
    const next = templateDraft.trim();
    if (next === settings.fileNameTemplate) return;
    // An empty value is normalized back to the default by Rust, which then
    // flows back through `settings` and resets the draft.
    apply({ fileNameTemplate: next });
  };

  // The folder picker lives in Rust (same dialog plugin as the export itself),
  // so this only hands back the chosen absolute path.
  const chooseExportDir = async () => {
    try {
      const picked = await invoke<string | null>('pick_export_dir', {
        initial: settings.exportDir || settings.lastExportDir || null,
      });
      if (picked && picked !== settings.exportDir) apply({ exportDir: picked });
    } catch (error) {
      message.error(t('settings.exportDirPickFailed', { error: String(error) }));
    }
  };

  // ===== Tab contents (UI-08) =====
  // The group titles double as tab labels, so the everyday controls and the
  // risky ones no longer share one endless scroll.

  const generalTab = (
    <>
      <Row label={t('settings.language')}>
        <Select
          size="small"
          style={{ width: 140 }}
          value={settings.language}
          onChange={(value) => apply({ language: value })}
          options={LOCALES.map((code) => ({ value: code, label: LOCALE_LABEL[code] }))}
        />
      </Row>

      <Row label={t('settings.theme')}>
        <Segmented
          size="small"
          value={settings.theme}
          onChange={(value) => apply({ theme: value as ThemeMode })}
          options={[
            { value: 'system', label: t('settings.themeSystem') },
            { value: 'light', label: t('settings.themeLight') },
            { value: 'dark', label: t('settings.themeDark') },
          ]}
        />
      </Row>
      {settings.theme === 'system' && (
        <div className="settings-hint">
          {t('settings.themeEffective', {
            theme: t(systemDark ? 'settings.themeDark' : 'settings.themeLight'),
          })}
        </div>
      )}

      <Row label={t('settings.pageSize')}>
        <Select
          size="small"
          style={{ width: 90 }}
          value={settings.pageSize}
          onChange={(value) => apply({ pageSize: value })}
          options={PAGE_SIZE_OPTIONS.map((size) => ({ value: size, label: size }))}
        />
      </Row>

      <Row label={t('settings.rememberSplit')}>
        <Switch
          size="small"
          checked={settings.rememberSplit}
          onChange={(checked) => apply({ rememberSplit: checked })}
        />
        <Button
          size="small"
          type="text"
          disabled={!settings.rememberSplit}
          onClick={() => apply({ splitRatio: DEFAULT_SPLIT })}
        >
          {t('settings.resetSplit')}
        </Button>
      </Row>

      <div className="settings-section-title settings-section-title--spaced">
        {t('settings.groupUpdates')}
      </div>

      <Row label={t('update.currentVersion')}>
        <span className="settings-version">v{appVersion || t('common.dash')}</span>
      </Row>

      <Row label={t('update.checkButton')}>
        <Button
          size="small"
          icon={<SyncOutlined />}
          loading={checkingUpdates}
          onClick={() => void runUpdateCheck()}
        >
          {checkingUpdates ? t('update.checking') : t('update.checkButton')}
        </Button>
      </Row>
    </>
  );

  const mapTab = (
    <>
      {busy && <div className="settings-hint">{t('settings.mapLocaleBusy')}</div>}
      <Row label={t('settings.mapLanguage')}>
        <Select
          size="small"
          style={{ width: 140 }}
          disabled={switchingMap || busy}
          loading={switchingMap}
          value={settings.mapLanguage}
          onChange={(value) => applyMapLocale({ mapLanguage: value })}
          options={MAP_LANGUAGES.map((item) => ({ value: item.value, label: item.label }))}
        />
      </Row>

      <Row label={t('settings.mapRegion')}>
        <Select
          size="small"
          style={{ width: 140 }}
          disabled={switchingMap || busy}
          loading={switchingMap}
          value={settings.mapRegion}
          onChange={(value) => applyMapLocale({ mapRegion: value })}
          options={MAP_REGIONS.map((code) => ({ value: code, label: regionLabel(code) }))}
        />
      </Row>
    </>
  );

  const collectTab = (
    <>
      <Row label={t('settings.scrollSpeed')}>
        <Radio.Group
          className="settings-radio-col"
          value={speedMode}
          onChange={(event) => selectSpeed(event.target.value)}
          options={[
            ...SPEED_ORDER.map((key) => ({
              value: key,
              label: t(speedLabelKey(key)),
            })),
            { value: 'custom', label: t('settings.speedCustom') },
          ]}
        />
      </Row>
      {/* UI-08: the radio shows the mode; the summary states the effective
          interval — the numbers that actually govern the scroll loop. */}
      <div className="settings-hint">
        {t('settings.speedSummary', {
          preset: t(speedMode === 'custom' ? 'settings.speedCustom' : speedLabelKey(speedMode)),
          min: settings.scrollMinMs,
          max: settings.scrollMaxMs,
        })}
      </div>

      {speedMode === 'custom' && (
        <Row label={t('settings.scrollCustom')}>
          <InputNumber
            size="small"
            style={{ width: 78 }}
            min={200}
            max={10000}
            step={100}
            precision={0}
            value={settings.scrollMinMs}
            onChange={(value) => applyRange(value, settings.scrollMaxMs)}
          />
          <span className="settings-dash">–</span>
          <InputNumber
            size="small"
            style={{ width: 78 }}
            min={500}
            max={30000}
            step={100}
            precision={0}
            value={settings.scrollMaxMs}
            onChange={(value) => applyRange(settings.scrollMinMs, value)}
          />
        </Row>
      )}

      {speedMode === 'fast' && (
        <div className="settings-hint settings-hint--warn">{t('settings.speedFastHint')}</div>
      )}

      <Row label={t('settings.jitter')}>
        <Switch
          size="small"
          checked={settings.jitter}
          onChange={(checked) => apply({ jitter: checked })}
        />
      </Row>

      {!settings.jitter && (
        <div className="settings-hint settings-hint--warn">{t('settings.jitterHint')}</div>
      )}

      <Row label={t('settings.onlyWithPhone')}>
        <Switch
          size="small"
          checked={settings.onlyWithPhone}
          onChange={(checked) => apply({ onlyWithPhone: checked })}
        />
      </Row>

      {settings.onlyWithPhone && (
        <div className="settings-hint">{t('settings.onlyWithPhoneHint')}</div>
      )}
    </>
  );

  const exportTab = (
    <>
      <Row label={t('settings.exportFormat')}>
        <Select
          size="small"
          style={{ width: 110 }}
          value={settings.defaultExportFormat}
          onChange={(value) => apply({ defaultExportFormat: value as ExportFormat })}
          options={[
            { value: 'xlsx', label: 'Excel' },
            { value: 'csv', label: 'CSV' },
            { value: 'json', label: 'JSON' },
            { value: 'jsonl', label: 'JSONL' },
          ]}
        />
      </Row>

      {/* M10 / G-11: column-name presets. Renaming only helps import wizards;
          unknown columns keep their default names, so no data is ever lost. */}
      <Row label={t('settings.exportPreset')}>
        <Select
          size="small"
          style={{ width: 110 }}
          value={settings.exportPreset}
          onChange={(value) => apply({ exportPreset: value as ExportPreset })}
          options={[
            { value: 'default', label: t('settings.exportPresetDefault') },
            { value: 'hubspot', label: 'HubSpot' },
            { value: 'pipedrive', label: 'Pipedrive' },
          ]}
        />
      </Row>
      <div className="settings-hint">{t('settings.exportPresetHint')}</div>

      <Row label={t('settings.fileNameTemplate')}>
        <Input
          size="small"
          style={{ width: 160 }}
          value={templateDraft}
          placeholder="placemill-{date}-{count}"
          onChange={(event) => setTemplateDraft(event.target.value)}
          onBlur={commitTemplate}
          onPressEnter={commitTemplate}
        />
      </Row>
      <div className="settings-hint">{t('settings.fileNameHint')}</div>

      <Row label={t('settings.exportDir')}>
        <Tooltip title={settings.exportDir || undefined} placement="topRight">
          <span className="settings-path">
            {settings.exportDir || t('settings.exportDirUnset')}
          </span>
        </Tooltip>
        <Button size="small" onClick={() => void chooseExportDir()}>
          {t('settings.exportDirChoose')}
        </Button>
        {settings.exportDir && (
          <Button size="small" type="text" onClick={() => apply({ exportDir: '' })}>
            {t('settings.exportDirClear')}
          </Button>
        )}
      </Row>

      <Row label={t('settings.exportSaveMode')}>
        <Segmented
          size="small"
          disabled={!settings.exportDir}
          value={settings.exportSaveMode}
          onChange={(value) => apply({ exportSaveMode: value as ExportSaveMode })}
          options={[
            { value: 'ask', label: t('settings.exportSaveAsk') },
            { value: 'auto', label: t('settings.exportSaveAuto') },
          ]}
        />
      </Row>
      <div className="settings-hint">
        {settings.exportSaveMode === 'auto'
          ? t('settings.exportSaveAutoHint')
          : t('settings.exportSaveAskHint')}
      </div>

      <Row label={t('settings.openExportFolder')}>
        <Switch
          size="small"
          checked={settings.openExportFolder}
          onChange={(checked) => apply({ openExportFolder: checked })}
        />
      </Row>

      <Row label={t('settings.csvBom')}>
        <Switch
          size="small"
          checked={settings.csvBom}
          onChange={(checked) => apply({ csvBom: checked })}
        />
      </Row>
      <div className="settings-hint">{t('settings.csvBomHint')}</div>
    </>
  );

  const advancedTab = (
    <>
      <Row label={t('settings.maxScrolls')}>
        <InputNumber
          size="small"
          style={{ width: 90 }}
          min={1}
          max={1000}
          precision={0}
          value={settings.maxScrolls}
          onChange={(value) => {
            if (value !== null) apply({ maxScrolls: value });
          }}
        />
      </Row>
      <Row label={t('settings.stopAfterIdle')}>
        <InputNumber
          size="small"
          style={{ width: 90 }}
          min={1}
          max={50}
          precision={0}
          value={settings.stopAfterIdle}
          onChange={(value) => {
            if (value !== null) apply({ stopAfterIdle: value });
          }}
        />
      </Row>
      <Row label={t('settings.logLevel')}>
        <Select
          size="small"
          style={{ width: 110 }}
          value={settings.logLevel}
          onChange={(value) => apply({ logLevel: value })}
          options={[
            { value: 'silent', label: t('settings.logSilent') },
            { value: 'normal', label: t('settings.logNormal') },
            { value: 'verbose', label: t('settings.logVerbose') },
          ]}
        />
      </Row>
      <Row label={t('settings.duplicateStrategy')}>
        <Select
          size="small"
          style={{ width: 130 }}
          value={settings.duplicateStrategy}
          onChange={(value) => apply({ duplicateStrategy: value })}
          options={[
            { value: 'ignore', label: t('settings.duplicateIgnore') },
            { value: 'update', label: t('settings.duplicateUpdate') },
          ]}
        />
      </Row>
      <div className="settings-hint">{t('settings.duplicateHint')}</div>

      <div className="settings-footer">
        <Popconfirm
          title={t('settings.restoreConfirm')}
          okText={t('common.confirm')}
          cancelText={t('common.cancel')}
          onConfirm={restoreDefaults}
        >
          <Button size="small" icon={<ReloadOutlined />}>
            {t('settings.restore')}
          </Button>
        </Popconfirm>
      </div>
    </>
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={Math.max(240, Math.min(420, panelWidth - 16))}
      title={t('settings.title')}
    >
      <Tabs
        className="settings-tabs"
        size="small"
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          { key: 'general', label: t('settings.groupGeneral'), children: generalTab },
          { key: 'map', label: t('settings.groupMap'), children: mapTab },
          { key: 'collect', label: t('settings.groupCollect'), children: collectTab },
          { key: 'export', label: t('settings.groupExport'), children: exportTab },
          { key: 'advanced', label: t('settings.groupAdvanced'), children: advancedTab },
        ]}
      />
    </Drawer>
  );
}
