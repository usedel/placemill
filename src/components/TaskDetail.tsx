import { useCallback, useEffect, useState } from 'react';
import { App, Button, Progress, Space, Table, Tabs, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ArrowLeftOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  StopOutlined,
  TableOutlined,
} from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { useI18n, type MessageKey } from '../i18n';
import { jobStatusLabel } from '../lib/text';
import { paneBusyMessageKey } from '../lib/busy';
import type { Business, BusinessPage } from '../types/business';
import type { Job, JobRun, JobTile } from '../types/job';
import EmptyState from './ui/EmptyState';
import HintText from './ui/HintText';
import SectionLabel from './ui/SectionLabel';
import StatusPill from './ui/StatusPill';

const PROCESSED = (job: Job) => job.doneTiles + job.failedTiles;

/** A5: tile failure codes → translated labels; an unknown code shows as-is. */
const REASON_KEYS: Record<string, MessageKey> = {
  'nav-failed': 'tile.reason.navFailed',
  timeout: 'tile.reason.timeout',
  'parse-empty': 'tile.reason.parseEmpty',
  drift: 'tile.reason.drift',
  'no-feed': 'tile.reason.noFeed',
};

/** SQLite `CURRENT_TIMESTAMP` is UTC without a zone marker. */
function parseCreated(value: string): Date {
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

interface Props {
  job: Job;
  onBack: () => void;
  /** T-08: the full table (filters, columns, export) lives in the data view. */
  onViewAll: (id: string) => void;
  /** A status change landed; the parent reloads the job list. */
  onChanged: () => void;
  /** Name of the task holding the runner, when it is not this one. */
  blockedBy?: string | null;
}

/**
 * Full-screen task view (P1 / T-08).
 *
 * Results are a read-only preview of the first 50 rows: the interactive table
 * (selection, row menu, column picker, export) would have to be lifted out of
 * `App` wholesale, and duplicating it here would guarantee the two drift. The
 * "open in data" action is the hand-off to that table.
 */
export default function TaskDetail({
  job,
  onBack,
  onViewAll,
  onChanged,
  blockedBy = null,
}: Props) {
  const { t, tag } = useI18n();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<Business[]>([]);
  const [total, setTotal] = useState(0);
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [failedTiles, setFailedTiles] = useState<JobTile[]>([]);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Three reads in one round trip: results, execution history, failed cells.
    void Promise.all([
      invoke<BusinessPage>('query_businesses', {
        request: {
          jobId: job.id,
          page: 1,
          pageSize: 50,
          sort: 'collectedAt',
          direction: 'desc',
        },
      }),
      invoke<JobRun[]>('list_job_runs', { id: job.id }),
      invoke<JobTile[]>('get_job_tiles', { id: job.id }),
    ])
      .then(([page, runList, tiles]) => {
        if (cancelled) return;
        setRows(page.rows);
        setTotal(page.total);
        setRuns(runList);
        setFailedTiles(tiles.filter((tile) => tile.status === 'skipped'));
      })
      .catch((error) => {
        if (!cancelled) {
          message.error(t('task.loadFailed', { error: String(error) }));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `foundCount` changes once per finished cell: cheap to re-read, and it is
    // the only signal that new rows exist while the task is running.
  }, [job.id, job.foundCount, revision, message, t]);

  const act = useCallback(
    async (command: string) => {
      setBusy(true);
      try {
        await invoke(command, { id: job.id });
        setRevision((value) => value + 1);
        onChanged();
      } catch (error) {
        // A5: the known refusals get real sentences; the rest stays raw.
        const text = String(error);
        if (text.includes('job_running')) {
          message.warning(t('grid.errorRunning'));
        } else {
          // Covers enrich_busy, map_busy, reviews_busy and session_active with
          // readable text (C-10).
          const busyKey = paneBusyMessageKey(error);
          if (busyKey) message.warning(t(busyKey));
          else message.error(t('queue.actionFailed', { error: text }));
        }
      } finally {
        setBusy(false);
      }
    },
    [job.id, message, t, onChanged],
  );

  /** P2: put one skipped cell back in the queue. */
  const retryTile = useCallback(
    async (tileId: string) => {
      setBusy(true);
      try {
        await invoke('retry_tile', { jobId: job.id, tileId });
        setRevision((value) => value + 1);
        onChanged();
        message.success(t('task.retryDone'));
      } catch (error) {
        message.error(t('queue.actionFailed', { error: String(error) }));
      } finally {
        setBusy(false);
      }
    },
    [job.id, message, t, onChanged],
  );

  const columns: ColumnsType<Business> = [
    {
      title: t('table.business'),
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      render: (value: string) => value || t('table.unnamed'),
    },
    {
      title: t('table.rating'),
      dataIndex: 'rating',
      key: 'rating',
      width: 64,
      render: (value: number) => (value > 0 ? value.toFixed(1) : t('common.dash')),
    },
    {
      title: t('table.phone'),
      dataIndex: 'phone',
      key: 'phone',
      width: 132,
      ellipsis: true,
      render: (value: string) => value || <span className="cell-muted">{t('common.dash')}</span>,
    },
    {
      title: t('table.address'),
      dataIndex: 'address',
      key: 'address',
      ellipsis: true,
      render: (value: string) => value || <span className="cell-muted">{t('common.dash')}</span>,
    },
  ];

  const processed = PROCESSED(job);
  const percent = job.totalTiles > 0 ? Math.round((processed / job.totalTiles) * 100) : 0;
  const created = parseCreated(job.createdAt);

  const overview = (
    <div className="task-detail-overview">
      <div className="task-detail-progress">
        <div className="task-detail-progress-head">
          <span>{t('queue.progress', { done: processed, total: job.totalTiles })}</span>
          <span className="task-detail-muted">
            {t('queue.found', { count: job.foundCount })}
            {job.failedTiles > 0
              ? ` · ${t('queue.failed', { count: job.failedTiles })}`
              : ''}
          </span>
        </div>
        <Progress
          percent={percent}
          size="small"
          status={job.status === 'failed' ? 'exception' : job.status === 'running' ? 'active' : 'normal'}
        />
      </div>

      <dl className="task-detail-facts">
        <div>
          <dt>{t('task.keyword')}</dt>
          <dd>{job.keyword || t('common.dash')}</dd>
        </div>
        <div>
          <dt>{t('task.center')}</dt>
          <dd>
            {job.centerLat.toFixed(4)}, {job.centerLng.toFixed(4)}
          </dd>
        </div>
        <div>
          <dt>{t('task.radius')}</dt>
          <dd>{t('task.km', { value: job.radiusKm })}</dd>
        </div>
        <div>
          <dt>{t('task.cell')}</dt>
          <dd>{t('task.km', { value: job.cellKm })}</dd>
        </div>
        <div>
          <dt>{t('task.splitThreshold')}</dt>
          <dd>{job.splitThreshold}</dd>
        </div>
        <div>
          <dt>{t('task.created')}</dt>
          <dd>
            {created.toLocaleString(tag, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </dd>
        </div>
      </dl>

      {failedTiles.length > 0 && (
        <div className="task-failed">
          <SectionLabel>{t('task.failedTiles', { count: failedTiles.length })}</SectionLabel>
          {failedTiles.slice(0, 8).map((tile) => (
            <div className="task-failed-row" key={tile.id}>
              <span className="task-failed-coord">
                {tile.lat.toFixed(4)}, {tile.lng.toFixed(4)}
                {/* A5: the failure carries its own short code, so the row says
                    why without a trip to the diagnostics drawer. */}
                {tile.errorReason && (
                  <span className="task-failed-reason">
                    {REASON_KEYS[tile.errorReason]
                      ? t(REASON_KEYS[tile.errorReason])
                      : tile.errorReason}
                  </span>
                )}
              </span>
              <Button
                size="small"
                type="link"
                loading={busy}
                onClick={() => void retryTile(tile.id)}
              >
                {t('task.retryTile')}
              </Button>
            </div>
          ))}
        </div>
      )}

      <HintText>{t('task.paramsLocked')}</HintText>
      <Button icon={<TableOutlined />} onClick={() => onViewAll(job.id)}>
        {t('task.openInData')}
      </Button>
    </div>
  );

  // No `scroll.y` here: the tab pane is already the scroll container (the
  // overview and runs tabs scroll the same way), so the preview simply flows.
  // A hard-coded body height — 320 px was here — showed ~8 of the 50 previewed
  // rows and left the rest of the pane blank, and no fixed number can be right
  // at every window height. The cap note moved above the table for the same
  // reason: below 50 rows it was only visible after scrolling to the end.
  const results = (
    <div className="task-detail-results">
      {total > rows.length && (
        <HintText className="task-detail-more">
          {t('task.previewLimit', { shown: rows.length, total })}
        </HintText>
      )}
      <Table<Business>
        dataSource={rows}
        columns={columns}
        rowKey="place_id"
        size="small"
        loading={loading}
        pagination={false}
        locale={{
          emptyText: <EmptyState card={false} title={t('task.noResults')} />,
        }}
      />
    </div>
  );

  const formatTime = (ms: number) =>
    new Date(ms).toLocaleString(tag, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  const formatClock = (ms: number) =>
    new Date(ms).toLocaleTimeString(tag, { hour: '2-digit', minute: '2-digit' });

  const runsTab = (
    <div className="task-runs">
      {runs.length === 0 ? (
        <EmptyState card={false} title={t('task.noRuns')} />
      ) : (
        runs.map((run, index) => (
          <div className="task-run" key={run.id}>
            <span className="task-run-index">#{runs.length - index}</span>
            <div className="task-run-body">
              <div className="task-run-line">
                <span>
                  {formatTime(run.startedAt)}
                  {run.finishedAt ? ` – ${formatClock(run.finishedAt)}` : ''}
                </span>
                <StatusPill
                  status={run.status}
                  label={jobStatusLabel(t, run.status)}
                  className="task-run-status"
                />
              </div>
              <div className="task-run-meta">
                {t('task.runLine', {
                  done: run.tilesDone,
                  failed: run.tilesFailed,
                  added: run.newCount,
                })}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );

  return (
    <div className="task-detail">
      <div className="task-detail-head">
        <Tooltip title={t('task.back')}>
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            aria-label={t('task.back')}
            onClick={onBack}
          />
        </Tooltip>
        <div className="task-detail-title">
          <span className="task-detail-name" title={job.name || job.keyword}>
            {job.name || job.keyword}
          </span>
          <StatusPill
            status={job.status}
            label={jobStatusLabel(t, job.status)}
            className="task-detail-status"
          />
        </div>
        <Space size={2}>
          {(job.status === 'queued' || job.status === 'paused') && (
            <Tooltip
              title={
                blockedBy
                  ? t('queue.startBlocked', { name: blockedBy })
                  : job.status === 'paused'
                    ? t('queue.resume')
                    : t('queue.start')
              }
            >
              <span className="task-action-wrap">
                <Button
                  size="small"
                  type="text"
                  loading={busy}
                  // Single-flight is enforced by the backend; the disabled state
                  // and the tooltip are what make the rule visible.
                  disabled={Boolean(blockedBy)}
                  icon={<PlayCircleOutlined />}
                  aria-label={
                    blockedBy
                      ? t('queue.startBlocked', { name: blockedBy })
                      : job.status === 'paused'
                        ? t('queue.resume')
                        : t('queue.start')
                  }
                  onClick={() => void act(job.status === 'paused' ? 'resume_job' : 'start_job')}
                />
              </span>
            </Tooltip>
          )}
          {job.status === 'running' && (
            <Tooltip title={t('queue.pause')}>
              <Button
                size="small"
                type="text"
                loading={busy}
                icon={<PauseCircleOutlined />}
                aria-label={t('queue.pause')}
                onClick={() => void act('pause_job')}
              />
            </Tooltip>
          )}
          {(job.status === 'running' || job.status === 'paused' || job.status === 'queued') && (
            <Tooltip title={t('queue.cancel')}>
              <Button
                size="small"
                type="text"
                danger
                loading={busy}
                icon={<StopOutlined />}
                aria-label={t('queue.cancel')}
                onClick={() => void act('cancel_job')}
              />
            </Tooltip>
          )}
        </Space>
      </div>

      <Tabs
        className="task-detail-tabs"
        items={[
          { key: 'overview', label: t('task.tabOverview'), children: overview },
          {
            key: 'results',
            label: t('task.tabResults', { count: job.foundCount }),
            children: results,
          },
          {
            key: 'runs',
            label: t('task.tabRuns', { count: runs.length }),
            children: runsTab,
          },
        ]}
      />
    </div>
  );
}
