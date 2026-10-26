import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Collapse, Input, InputNumber, Modal, Space, Tooltip } from 'antd';
import { AimOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { useT } from '../i18n';
import type { Job } from '../types/job';

interface MapView {
  lat: number;
  lng: number;
  zoom: number;
  at: number;
}

interface GridPlan {
  tiles: number;
  zoom: number;
  cellKm: number;
  estimatedSeconds: number;
  limited: boolean;
}

interface Props {
  open: boolean;
  /**
   * Keyword to seed the box with. The collect view's preset chips pass one;
   * every other entry point passes '' and keeps whatever the box already had.
   */
  initialKeyword?: string;
  onClose: () => void;
  /** Jobs created in this submit; the parent shows them in the collect view. */
  onCreated: (jobs: Job[]) => void;
  /** Name of the task holding the map; new jobs queue behind it. */
  busyJobName?: string | null;
}

const DEFAULT_RADIUS_KM = 5;
const DEFAULT_CELL_KM = 2;
/// Google caps a viewport at ~120 places; 100 leaves headroom so a cell that is
/// only one row short of the cap is not quietly treated as complete.
const DEFAULT_SPLIT_THRESHOLD = 100;
const PLAN_DEBOUNCE_MS = 300;
const SECONDS_PER_TILE = 20;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Area task dialog (P1 / T-09).
 *
 * One page, not two tabs: creating a task used to switch to a queue tab that no
 * longer exists. Advanced grid knobs are collapsed because the defaults cover
 * the common case, and every error is shown inline — a toast for "keyword is
 * required" hides the field that needs attention.
 */
export default function GridDialog({
  open,
  initialKeyword = '',
  onClose,
  onCreated,
  busyJobName = null,
}: Props) {
  const t = useT();
  // Same reason as the list: the static `message` cannot see the theme context.
  const { message } = App.useApp();

  const [keywords, setKeywords] = useState('');
  const [city, setCity] = useState('');
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [radius, setRadius] = useState<number | null>(DEFAULT_RADIUS_KM);
  const [cell, setCell] = useState<number | null>(DEFAULT_CELL_KM);
  const [splitThreshold, setSplitThreshold] = useState<number | null>(
    DEFAULT_SPLIT_THRESHOLD,
  );
  const [plan, setPlan] = useState<GridPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [readingView, setReadingView] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keywordError, setKeywordError] = useState(false);
  /** `grid_too_large` comes back as an error, not a `limited` plan, so the
   * suggestion needs its own flag. */
  const [tooLarge, setTooLarge] = useState(false);

  // Guards the debounced plan response: a reply that lands after the dialog was
  // closed must not update a component the user is no longer looking at.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const keywordList = useMemo(
    () =>
      keywords
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    [keywords],
  );

  const errorText = useCallback(
    (raw: string): string => {
      if (raw.includes('grid_too_large')) return t('grid.errorTooLarge');
      if (raw.includes('radius_out_of_range')) return t('grid.errorRadius');
      if (raw.includes('cell_out_of_range')) return t('grid.errorCell');
      if (raw.includes('keyword_required')) return t('grid.errorKeyword');
      if (raw.includes('too_many_jobs')) return t('grid.errorTooMany');
      if (raw.includes('job_running')) return t('grid.errorRunning');
      return raw;
    },
    [t],
  );

  const readView = useCallback(async () => {
    setReadingView(true);
    try {
      await invoke('request_map_view');
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await sleep(200);
        // R-34: this loop polls for up to two seconds. The dialog can close in
        // that window, and every write below used to land on a closed dialog
        // (or an unmounted component).
        if (!openRef.current) return false;
        const view = await invoke<MapView | null>('get_map_view');
        if (!openRef.current) return false;
        if (view) {
          setLat(Number(view.lat.toFixed(6)));
          setLng(Number(view.lng.toFixed(6)));
          setError(null);
          return true;
        }
      }
      if (openRef.current) setError(t('grid.noView'));
      return false;
    } catch (cause) {
      if (openRef.current) setError(String(cause));
      return false;
    } finally {
      if (openRef.current) setReadingView(false);
    }
  }, [t]);

  // A preset chip's keyword replaces whatever the box held: the click *is* the
  // choice, and leaving a stale keyword in place would make the chip look dead.
  // A plain "New task" sends '' and keeps the last text, as before.
  useEffect(() => {
    if (!open) return;
    const seed = initialKeyword.trim();
    if (!seed) return;
    setKeywords(seed);
    setKeywordError(false);
  }, [open, initialKeyword]);

  // Opening the dialog seeds the centre from the map once. Re-seeding on every
  // open would overwrite coordinates the user typed by hand.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      if (lat !== null && lng !== null) return;
      try {
        const view = await invoke<MapView | null>('get_map_view');
        if (cancelled) return;
        if (view) {
          setLat(Number(view.lat.toFixed(6)));
          setLng(Number(view.lng.toFixed(6)));
        } else {
          await readView();
        }
      } catch (cause) {
        if (!cancelled) setError(String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
    // `lat`/`lng` are read, not tracked: this effect is about the open
    // transition, and depending on them would re-run it on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Live preview, debounced so typing a coordinate does not spam the backend.
  useEffect(() => {
    if (!open || lat === null || lng === null || !radius || !cell) {
      setPlan(null);
      return;
    }
    const timer = window.setTimeout(() => {
      invoke<GridPlan>('plan_grid', {
        centerLat: lat,
        centerLng: lng,
        radiusKm: radius,
        cellKm: cell,
      })
        .then((next) => {
          if (openRef.current) {
            setPlan(next);
            setTooLarge(false);
          }
        })
        .catch((cause) => {
          setPlan(null);
          setTooLarge(String(cause).includes('grid_too_large'));
          // R-34: store the raw error. Applying `errorText` here *and* again at
          // render translated it twice — a translated message that happened to
          // contain an error code was re-mapped to an unrelated hint.
          setError(String(cause));
        });
    }, PLAN_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, lat, lng, radius, cell, errorText]);

  /** The one-click fix for an oversized grid: the next size up, nothing else. */
  const suggestCell = useCallback(async () => {
    if (!cell || !lat || !lng || !radius) return;
    for (const factor of [2, 3, 4]) {
      const candidate = Math.min(10, Number((cell * factor).toFixed(1)));
      if (candidate <= cell) break;
      try {
        const next = await invoke<GridPlan>('plan_grid', {
          centerLat: lat,
          centerLng: lng,
          radiusKm: radius,
          cellKm: candidate,
        });
        if (!next.limited) {
          setCell(candidate);
          setError(null);
          setTooLarge(false);
          return;
        }
      } catch {
        break;
      }
    }
  }, [cell, lat, lng, radius]);

  const create = useCallback(
    async (start: boolean, probe = false) => {
      if (keywordList.length === 0) {
        setKeywordError(true);
        return;
      }
      if (lat === null || lng === null || !radius || !cell) return;
      setBusy(true);
      setError(null);
      try {
        const created = await invoke<Job[]>('create_jobs', {
          request: {
            entries: keywordList.map((keyword) => ({
              keyword,
              city: city.trim(),
              centerLat: lat,
              centerLng: lng,
            })),
            radiusKm: radius,
            cellKm: cell,
            splitThreshold: splitThreshold ?? DEFAULT_SPLIT_THRESHOLD,
          },
        });
        message.success(t('queue.created', { count: created.length }));
        onCreated(created);
        onClose();

        if (start && created.length > 0) {
          // Starting the first job is what makes the queue move: the worker
          // chains the rest. When another task already owns the map, starting is
          // guaranteed to be rejected — queue it and say so instead.
          if (busyJobName) {
            message.info(t('queue.queuedAfterCreate'));
            return;
          }
          try {
            await invoke('start_job', { id: created[0].id, probe });
            if (probe) {
              message.info(t('grid.probeQueued'));
            }
          } catch (cause) {
            if (String(cause).includes('job_running')) {
              message.info(t('queue.queuedAfterCreate'));
            } else {
              message.warning(t('queue.actionFailed', { error: String(cause) }));
            }
          }
        }
      } catch (cause) {
        // R-34: raw text only; the render path translates it once.
        setError(String(cause));
      } finally {
        setBusy(false);
      }
    },
    [keywordList, lat, lng, radius, cell, splitThreshold, city, message, t, onCreated, onClose, busyJobName],
  );

  // The preview assumes one keyword before the textarea is filled: showing
  // "× 1 keyword · 0 min" was worse than useless, it looked like a bug.
  const keywordCount = Math.max(1, keywordList.length);
  const minutes = plan
    ? Math.max(1, Math.round((plan.tiles * keywordCount * SECONDS_PER_TILE) / 60))
    : 0;

  const canCreate =
    keywordList.length > 0 && lat !== null && lng !== null && Boolean(plan) && !busy;

  return (
    <Modal
      open={open}
      title={t('grid.title')}
      onCancel={onClose}
      width={Math.min(560, window.innerWidth - 32)}
      footer={
        <Space>
          <Button onClick={onClose}>{t('grid.close')}</Button>
          <Tooltip title={t('grid.probeHint')}>
            <Button
              icon={<AimOutlined />}
              loading={busy}
              disabled={!canCreate}
              onClick={() => void create(true, true)}
            >
              {t('grid.probe')}
            </Button>
          </Tooltip>
          <Button loading={busy} disabled={!canCreate} onClick={() => void create(false)}>
            {t('grid.createOnly')}
          </Button>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={busy}
            disabled={!canCreate}
            onClick={() => void create(true)}
          >
            {busyJobName
              ? t('grid.createAndQueue')
              : keywordCount > 1
                ? t('grid.createAndStartMany', { count: keywordCount })
                : t('grid.createAndStart')}
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <div className="grid-note">{t('grid.subtitle')}</div>

        <label className="grid-field">
          <span>{t('grid.keywords')}</span>
          <Input.TextArea
            value={keywords}
            status={keywordError ? 'error' : undefined}
            onChange={(event) => {
              setKeywords(event.target.value);
              if (event.target.value.trim()) setKeywordError(false);
            }}
            placeholder={t('grid.keywordsPlaceholder')}
            autoSize={{ minRows: 2, maxRows: 5 }}
          />
          {keywordError && <span className="grid-field-error">{t('grid.errorKeyword')}</span>}
        </label>

        <label className="grid-field">
          <span>{t('grid.city')}</span>
          <Input
            value={city}
            onChange={(event) => setCity(event.target.value)}
            placeholder={t('grid.cityPlaceholder')}
            allowClear
          />
        </label>

        <div className="grid-field">
          <span>
            {t('grid.center')}
            <Button
              type="link"
              size="small"
              icon={<AimOutlined />}
              loading={readingView}
              onClick={() => void readView()}
            >
              {t('grid.readFromMap')}
            </Button>
          </span>
          <Space.Compact style={{ width: '100%' }}>
            <InputNumber
              className="grid-coord"
              value={lat}
              onChange={(value) => setLat(value)}
              precision={6}
              step={0.001}
              placeholder={t('grid.latitude')}
              aria-label={t('grid.latitude')}
            />
            <InputNumber
              className="grid-coord"
              value={lng}
              onChange={(value) => setLng(value)}
              precision={6}
              step={0.001}
              placeholder={t('grid.longitude')}
              aria-label={t('grid.longitude')}
            />
          </Space.Compact>
        </div>

        <Space size={12} style={{ width: '100%' }}>
          <label className="grid-field grid-field-inline">
            <span>{t('grid.radius')}</span>
            <InputNumber
              min={0.5}
              max={20}
              step={0.5}
              value={radius}
              onChange={(value) => setRadius(value)}
              style={{ width: 96 }}
            />
          </label>
          <label className="grid-field grid-field-inline">
            <span>{t('grid.cell')}</span>
            <InputNumber
              min={0.5}
              max={10}
              step={0.5}
              value={cell}
              onChange={(value) => setCell(value)}
              style={{ width: 96 }}
            />
          </label>
        </Space>

        <div className="grid-note">{t('grid.cellHint')}</div>

        <Collapse
          size="small"
          ghost
          items={[
            {
              key: 'advanced',
              label: t('grid.advanced'),
              children: (
                <>
                  <label className="grid-field grid-field-inline">
                    <span>{t('grid.splitThreshold')}</span>
                    <InputNumber
                      min={20}
                      max={120}
                      step={10}
                      value={splitThreshold}
                      onChange={(value) => setSplitThreshold(value)}
                      style={{ width: 120 }}
                    />
                  </label>
                  <div className="grid-note">{t('grid.splitHint')}</div>
                </>
              ),
            },
          ]}
        />

        {plan && (
          <div className={`grid-plan${plan.limited ? ' is-warning' : ''}`}>
            {plan.limited ? (
              <>
                {t('grid.planLimited')}
                <Button type="link" size="small" onClick={() => void suggestCell()}>
                  {t('grid.useSuggestion', { cell: Math.min(10, (cell ?? 2) * 2) })}
                </Button>
              </>
            ) : (
              t('grid.plan', {
                tiles: plan.tiles * keywordCount,
                keywords: keywordCount,
                minutes,
              })
            )}
          </div>
        )}

        {error && (
          <Alert
            type="error"
            showIcon
            message={errorText(error)}
            action={
              tooLarge ? (
                <Button size="small" onClick={() => void suggestCell()}>
                  {t('grid.useSuggestion', {
                    cell: Math.min(10, Number((((cell ?? 2) as number) * 2).toFixed(1))),
                  })}
                </Button>
              ) : undefined
            }
          />
        )}
      </Space>
    </Modal>
  );
}
