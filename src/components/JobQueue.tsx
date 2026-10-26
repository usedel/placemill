import { useCallback, useMemo, useState } from 'react';
import { App, Button, Checkbox, Dropdown, Input, Modal, Progress, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import {
  AimOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  MoreOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
  TableOutlined,
} from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '../i18n';
import { jobStatusLabel } from '../lib/text';
import type { Job } from '../types/job';

const PROCESSED = (job: Job) => job.doneTiles + job.failedTiles;

/**
 * Same constant the create dialog uses for its estimate. Kept here so the card
 * can say "~6 min left" without the job row having to store a start time.
 */
const SECONDS_PER_TILE = 20;

/**
 * First-run shortcuts. Kept as message keys, not literals: these are Google
 * search terms, so they have to be in the user's language to return local
 * businesses.
 */
const PRESET_KEYWORDS = [
  'queue.presetDentist',
  'queue.presetPlumber',
  'queue.presetRoofing',
] as const;

/** SQLite `CURRENT_TIMESTAMP` is UTC without a zone marker. */
function parseCreated(value: string): Date {
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

const stampLabel = (ms: number) => {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

type Row =
  | { kind: 'single'; job: Job }
  | { kind: 'batch'; batchId: string; jobs: Job[] };

interface DayGroup {
  key: string;
  label: string;
  rows: Row[];
}

/**
 * Collapse jobs created in one submit into a single row. The order of the list
 * is preserved: a batch appears where its first job is.
 */
function collapseBatches(list: Job[]): Row[] {
  const rows: Row[] = [];
  const index = new Map<string, number>();
  list.forEach((job) => {
    if (!job.batchId) {
      rows.push({ kind: 'single', job });
      return;
    }
    const at = index.get(job.batchId);
    if (at === undefined) {
      index.set(job.batchId, rows.length);
      rows.push({ kind: 'batch', batchId: job.batchId, jobs: [job] });
      return;
    }
    const row = rows[at];
    if (row.kind === 'batch') row.jobs.push(job);
  });
  return rows;
}

interface Props {
  jobs: Job[];
  /**
   * Rows already in the database. Only the empty state uses it: with data but
   * no tasks (tasks deleted, rows kept) "create one" is the wrong suggestion.
   */
  totalRows?: number;
  /**
   * True while the first page query is in flight. `totalRows` is 0 until that
   * answer lands, so the empty state has to know the difference between "no
   * rows" and "not asked yet" or the preset row flashes for one frame.
   */
  rowsLoading?: boolean;
  /** Opens the create dialog; a preset chip passes its keyword along. */
  onNew: (keyword?: string) => void;
  /** Leave the collect view (the empty state's "you already have data" link). */
  onViewData?: () => void;
  /** Open the full-screen task view. */
  onOpenTask: (job: Job) => void;
  /** Jump to the data view filtered to this job. */
  onViewResults: (id: string) => void;
  /** A mutation landed; the parent reloads the list and the current page. */
  onChanged: () => void;
}

/**
 * The collect view's task list (P1 / T-07).
 *
 * Controlled on purpose: `App` owns the jobs (it needs them for the picker and
 * the detail view), so this component never fetches on its own. Actions call
 * `onChanged` and let the single owner re-read, which keeps the two lists from
 * drifting apart.
 */
export default function JobQueue({
  jobs,
  totalRows = 0,
  rowsLoading = false,
  onNew,
  onViewData,
  onOpenTask,
  onViewResults,
  onChanged,
}: Props) {
  const { t, tag } = useI18n();
  // Context-aware `message`: the static one ignores the app theme.
  const { message, modal } = App.useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  /** Job being renamed; null when the dialog is closed. */
  const [renaming, setRenaming] = useState<Job | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const groups = useMemo<DayGroup[]>(() => {
    const byDay = new Map<string, Job[]>();
    jobs.forEach((job) => {
      const date = parseCreated(job.createdAt);
      const key = dayKey(date);
      const list = byDay.get(key);
      if (list) list.push(job);
      else byDay.set(key, [job]);
    });

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    return [...byDay.values()].map((list) => {
      const date = parseCreated(list[0].createdAt);
      const key = dayKey(date);
      const label =
        key === dayKey(today)
          ? t('queue.today')
          : key === dayKey(yesterday)
            ? t('queue.yesterday')
            : date.toLocaleDateString(tag, { month: 'short', day: 'numeric' });
      return { key, label, rows: collapseBatches(list) };
    });
    // `t` changes identity with the locale, which is exactly when the labels
    // must be recomputed.
  }, [jobs, t, tag]);

  const act = useCallback(
    async (command: string, id: string) => {
      setBusy(id);
      try {
        await invoke(command, { id });
        onChanged();
        // Pausing or cancelling halts the runner instead of letting it chain to
        // the next queued job; say so before the user waits for it.
        if (command === 'pause_job' || command === 'cancel_job') {
          const waiting = jobs.filter((job) => job.status === 'queued' && job.id !== id).length;
          if (waiting > 0) message.info(t('queue.pausedQueueNote', { count: waiting }));
        }
      } catch (error) {
        const text = String(error);
        // The backend is the final arbiter of single-flight; a click that races
        // the list must still explain itself rather than show `job_running`.
        if (text.includes('job_running')) {
          const owner = jobs.find((job) => job.status === 'running');
          message.warning(
            t('queue.startBlocked', { name: owner?.name || owner?.keyword || '' }),
          );
        } else {
          message.error(t('queue.actionFailed', { error: text }));
        }
      } finally {
        setBusy(null);
      }
    },
    [message, t, onChanged, jobs],
  );

  /** T-10: the confirmation must say what happens to the collected rows. */
  const confirmDelete = useCallback(
    async (job: Job) => {
      let exclusive = 0;
      let shared = 0;
      // R-34: a failed preview used to render "0 exclusive / 0 shared" — a
      // confident answer the backend never gave, with the checkbox disabled by
      // the same fake zero. Say the number is unknown and block the delete.
      let previewFailed = false;
      try {
        const preview = await invoke<{ exclusive: number; shared: number }>('job_delete_preview', {
          id: job.id,
        });
        exclusive = preview.exclusive;
        shared = preview.shared;
      } catch (error) {
        previewFailed = true;
        console.log('[Placemill] delete preview failed:', error);
      }

      let deleteExclusive = false;
      modal.confirm({
        title: t('queue.deleteTitle', { name: job.name || job.keyword }),
        content: (
          <div className="queue-delete-confirm">
            {previewFailed ? (
              <div>{t('queue.deletePreviewFailed')}</div>
            ) : (
              <>
                <div>{t('queue.deleteSummary', { exclusive, shared })}</div>
                <Checkbox
                  disabled={exclusive === 0}
                  onChange={(event) => {
                    deleteExclusive = event.target.checked;
                  }}
                >
                  {t('queue.deleteExclusive', { count: exclusive })}
                </Checkbox>
                <div className="queue-delete-note">
                  {t('queue.deleteSharedNote', { count: shared })}
                </div>
              </>
            )}
          </div>
        ),
        okText: t('queue.delete'),
        cancelText: t('common.cancel'),
        okButtonProps: { danger: true, disabled: previewFailed },
        onOk: async () => {
          try {
            await invoke('delete_job', { id: job.id, deleteExclusive });
            onChanged();
          } catch (error) {
            message.error(t('queue.actionFailed', { error: String(error) }));
            throw error;
          }
        },
      });
    },
    [modal, message, t, onChanged],
  );

  /** P2: reset every leaf tile and let the user start it again. */
  const rerun = useCallback(
    async (job: Job) => {
      setBusy(job.id);
      try {
        await invoke('rerun_job', { id: job.id });
        message.success(t('queue.rerunDone'));
        onChanged();
      } catch (error) {
        message.error(t('queue.actionFailed', { error: String(error) }));
      } finally {
        setBusy(null);
      }
    },
    [message, t, onChanged],
  );

  /** P2: same parameters, new queued task (tiles are rebuilt). */
  const duplicate = useCallback(
    async (job: Job) => {
      setBusy(job.id);
      try {
        const created = await invoke<Job>('duplicate_job', { id: job.id });
        message.success(t('queue.duplicated', { name: created.name }));
        onChanged();
      } catch (error) {
        message.error(t('queue.actionFailed', { error: String(error) }));
      } finally {
        setBusy(null);
      }
    },
    [message, t, onChanged],
  );

  /** T-03: the name is the only editable field; everything else is a snapshot. */
  const submitRename = useCallback(async () => {
    if (!renaming) return;
    const name = renameValue.trim();
    if (!name) {
      message.error(t('queue.nameRequired'));
      return;
    }
    setBusy(renaming.id);
    try {
      await invoke('rename_job', { id: renaming.id, name });
      setRenaming(null);
      onChanged();
    } catch (error) {
      message.error(t('queue.actionFailed', { error: String(error) }));
    } finally {
      setBusy(null);
    }
  }, [renaming, renameValue, message, t, onChanged]);

  const toggleBatch = (batchId: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  };

  const renderCard = (job: Job) => {
    // Single-flight is a product rule, not just a backend guard: the map cannot
    // scroll two searches at once, and parallel runs raise the ban risk.
    const runningJob = jobs.find((candidate) => candidate.status === 'running') ?? null;
    const blocked = runningJob !== null && runningJob.id !== job.id;
    const blockedHint =
      runningJob && runningJob.id !== job.id
        ? t('queue.startBlocked', { name: runningJob.name || runningJob.keyword })
        : undefined;
    const processed = PROCESSED(job);
    const percent = job.totalTiles > 0 ? Math.round((processed / job.totalTiles) * 100) : 0;
    const pending = busy === job.id;
    const remaining = Math.max(0, job.totalTiles - processed);
    const etaMinutes =
      job.status === 'running' ? Math.max(1, Math.round((remaining * SECONDS_PER_TILE) / 60)) : 0;

    // A re-run only makes sense once the task stopped: resetting tiles under a
    // running worker would make the progress numbers meaningless.
    const finished = ['completed', 'cancelled', 'failed'].includes(job.status);
    const menu: MenuProps['items'] = [
      { key: 'rename', icon: <EditOutlined />, label: t('queue.rename') },
      {
        key: 'duplicate',
        icon: <CopyOutlined />,
        label: t('queue.duplicate'),
        disabled: job.status === 'running',
      },
      ...(finished
        ? [{ key: 'rerun', icon: <ReloadOutlined />, label: t('queue.rerun') }]
        : []),
      { type: 'divider' as const },
      {
        key: 'delete',
        icon: <DeleteOutlined />,
        label: t('queue.delete'),
        danger: true,
        disabled: job.status === 'running',
      },
    ];

    return (
      <div
        key={job.id}
        className={`task-card is-${job.status}`}
        role="button"
        tabIndex={0}
        onClick={() => onOpenTask(job)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpenTask(job);
          }
        }}
      >
        <div className="task-card-line">
          <span className={`task-dot is-${job.status}`} aria-hidden />
          <span className="task-card-name" title={job.name || job.keyword}>
            {job.name || job.keyword}
          </span>
          <span className={`task-card-status is-${job.status}`}>
            {jobStatusLabel(t, job.status)}
          </span>
          <Dropdown
            trigger={['click']}
            menu={{
              items: menu,
              onClick: ({ key, domEvent }) => {
                domEvent.stopPropagation();
                if (key === 'rename') {
                  setRenaming(job);
                  setRenameValue(job.name || job.keyword);
                } else if (key === 'duplicate') {
                  void duplicate(job);
                } else if (key === 'rerun') {
                  void rerun(job);
                } else if (key === 'delete') {
                  void confirmDelete(job);
                }
              },
            }}
          >
            <Button
              size="small"
              type="text"
              className="task-card-more"
              icon={<MoreOutlined />}
              aria-label={t('queue.actions')}
              onClick={(event) => event.stopPropagation()}
            />
          </Dropdown>
        </div>

        <div className="task-card-meta">
          <span>{t('queue.progress', { done: processed, total: job.totalTiles })}</span>
          <span>{t('queue.found', { count: job.foundCount })}</span>
          {etaMinutes > 0 && <span>{t('queue.eta', { minutes: etaMinutes })}</span>}
          {job.failedTiles > 0 && (
            <span className="task-card-failed">
              {t('queue.failed', { count: job.failedTiles })}
            </span>
          )}
          <span>
            {job.lastExportedAt > 0
              ? t('queue.exported', { time: stampLabel(job.lastExportedAt) })
              : t('queue.notExported')}
          </span>
          {job.status === 'queued' && runningJob && runningJob.id !== job.id && (
            <span className="task-waiting">
              {t('queue.waitingFor', { name: runningJob.name || runningJob.keyword })}
            </span>
          )}
        </div>

        {job.status !== 'completed' && job.totalTiles > 0 && (
          <Progress
            percent={percent}
            size="small"
            showInfo={false}
            status={job.status === 'failed' ? 'exception' : job.status === 'running' ? 'active' : 'normal'}
          />
        )}

        <div className="task-card-actions" onClick={(event) => event.stopPropagation()}>
          {(job.status === 'queued' || job.status === 'paused') && (
            <Tooltip title={blockedHint}>
              {/* A disabled antd button swallows pointer events, so the tooltip
                  needs a wrapper that still hovers. */}
              <span className="task-action-wrap">
                <Button
                  size="small"
                  type="text"
                  loading={pending}
                  disabled={blocked}
                  icon={<PlayCircleOutlined />}
                  aria-label={
                    blockedHint ?? (job.status === 'paused' ? t('queue.resume') : t('queue.start'))
                  }
                  onClick={() =>
                    void act(job.status === 'paused' ? 'resume_job' : 'start_job', job.id)
                  }
                >
                  {job.status === 'paused' ? t('queue.resume') : t('queue.start')}
                </Button>
              </span>
            </Tooltip>
          )}
          {job.status === 'running' && (
            <Button
              size="small"
              type="text"
              loading={pending}
              icon={<PauseCircleOutlined />}
              onClick={() => void act('pause_job', job.id)}
            >
              {t('queue.pause')}
            </Button>
          )}
          {(job.status === 'running' || job.status === 'paused' || job.status === 'queued') && (
            <Button
              size="small"
              type="text"
              danger
              loading={pending}
              icon={<StopOutlined />}
              onClick={() => void act('cancel_job', job.id)}
            >
              {t('queue.cancel')}
            </Button>
          )}
          <Button
            size="small"
            type="text"
            icon={<TableOutlined />}
            onClick={() => onViewResults(job.id)}
          >
            {t('queue.viewResults')}
          </Button>
        </div>
      </div>
    );
  };

  if (jobs.length === 0) {
    // The panel used to show a 1px outlined antd `Empty` at the top of a
    // full-height scroller — four words, a duplicate of the toolbar's button,
    // and a screen of blank. A first-run card centre it and say how the
    // product is used, which is the only thing a new user is missing here.
    return (
      <div className="queue-empty">
        <div className="queue-empty-card">
          <span className="queue-empty-icon" aria-hidden>
            <AimOutlined />
          </span>
          <div className="queue-empty-title">{t('queue.emptyTitle')}</div>
          <p className="queue-empty-desc">{t('queue.emptyDesc')}</p>
          <ol className="queue-empty-steps">
            <li>{t('queue.emptyStep1')}</li>
            <li>{t('queue.emptyStep2')}</li>
            <li>{t('queue.emptyStep3')}</li>
          </ol>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => onNew()}>
            {t('queue.emptyCta')}
          </Button>
          {/* Only on a true first run: with rows in the database the user has
              already built a task and the steps above are all they need. */}
          {totalRows === 0 && !rowsLoading && (
            <div className="queue-empty-presets">
              <span className="queue-empty-presets-label">{t('queue.presetsLabel')}</span>
              <div className="queue-empty-chips">
                {PRESET_KEYWORDS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className="queue-empty-chip"
                    onClick={() => onNew(t(key))}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {totalRows > 0 && onViewData && (
            <Button type="link" size="small" onClick={onViewData}>
              {t('queue.viewExisting', { count: totalRows.toLocaleString(tag) })}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="task-list">
      {groups.map((group) => (
        <section key={group.key} className="task-group">
          <div className="task-group-label">{group.label}</div>
          {group.rows.map((row) => {
            if (row.kind === 'single') return renderCard(row.job);
            const open = expanded.has(row.batchId);
            const done = row.jobs.filter((job) => job.status === 'completed').length;
            const running = row.jobs.some((job) => job.status === 'running');
            const keywords = row.jobs.map((job) => job.keyword).join(' · ');
            // The default name ends in " · MM-DD HH:mm"; a batch heading is
            // about the keywords, so the timestamp is dropped (a renamed job
            // keeps whatever the user typed).
            const batchName = (row.jobs[0].name || row.jobs[0].keyword)
              .replace(/ · \d{2}-\d{2} \d{2}:\d{2}$/, '')
              .replace(/ ·$/, '');
            return (
              <div key={row.batchId} className="task-batch">
                <button
                  type="button"
                  className="task-batch-head"
                  aria-expanded={open}
                  onClick={() => toggleBatch(row.batchId)}
                >
                  <span className={`task-batch-caret${open ? ' is-open' : ''}`}>▸</span>
                  <span className="task-batch-name" title={keywords}>
                    {batchName}
                  </span>
                  <span className="task-batch-count">
                    {running
                      ? t('queue.status.running')
                      : t('queue.batchDone', { done, total: row.jobs.length })}
                  </span>
                </button>
                {open && <div className="task-batch-body">{row.jobs.map(renderCard)}</div>}
              </div>
            );
          })}
        </section>
      ))}

      {jobs.length > 1 &&
        jobs.some(
          (job) =>
            job.status === 'running' || job.status === 'queued' || job.status === 'paused',
        ) && <div className="task-single-flight">{t('queue.singleFlight')}</div>}

      <Modal
        open={renaming !== null}
        title={t('queue.renameTitle')}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={renaming !== null && busy === renaming.id}
        onCancel={() => setRenaming(null)}
        onOk={() => void submitRename()}
      >
        <Input
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          maxLength={120}
          autoFocus
          onPressEnter={() => void submitRename()}
          aria-label={t('queue.rename')}
        />
      </Modal>
    </div>
  );
}

/** Shared with the task detail view, which shows the same progress figures. */
export { PROCESSED };
