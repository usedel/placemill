import { Button, Tooltip } from 'antd';
import { GlobalOutlined, ReloadOutlined } from '@ant-design/icons';
import type { MutableRefObject } from 'react';
import { useT } from '../i18n';
import type { MapHealth } from '../types/collector';
import { STALE_ACTIVITY_SECONDS, useNow } from '../lib/liveStatus';

interface Props {
  mapHealth: MapHealth;
  /**
   * A collection is in progress right now — the collector switch is on.
   *
   * The switch is the authoritative signal: the runner owns it and turns it
   * off on every exit path (task end, pause, cancel, clear), so a page that
   * outlived its session cannot light a card. The jobs table is a second
   * source for the same fact and it can disagree (a task killed with the app
   * stays `running` there), so it is not consulted.
   *
   * Everything this card can say needs it: the notice is about a collection
   * that is not working, and its remedies (reload the map, restart the
   * scroll) are the ones the running collection uses.
   */
  active: boolean;
  /**
   * Latest sign of life — a batch arrival *or* a tile transition — read on the
   * 1 s tick (R-18). A ref instead of state: batches arrive in bursts, and
   * re-rendering the panel for each of them just to move a seconds counter was
   * most of the old per-batch cost.
   */
  lastActivityAtRef: MutableRefObject<number | null>;
  busy: boolean;
  /** Restart the injected scroll loop (pause + resume when a task owns it). */
  onRestart: () => void;
  onReloadMap: () => void;
}

/**
 * Map trouble, and only map trouble.
 *
 * The old listen card carried the collection switch as well, which let the panel
 * drive the map beside a running task. Collection is now task-driven; what is
 * left is the part users cannot get from a task card: a consent page or captcha
 * that stops every task until the map is reloaded.
 */
export default function MapHealthNotice({
  mapHealth,
  active,
  lastActivityAtRef,
  busy,
  onRestart,
  onReloadMap,
}: Props) {
  const t = useT();
  // R-18: the seconds counter and the stale switch own their clock; the app
  // root no longer ticks once per second.
  const now = useNow(active);
  const lastActivityAt = active ? lastActivityAtRef.current : null;
  // Rounded down on purpose: "0s ago" right after a batch is honest, while
  // rounding up would show "1s" for data that arrived 200ms ago.
  const secondsSinceActivity =
    lastActivityAt !== null ? Math.max(0, Math.floor((now - lastActivityAt) / 1000)) : null;
  const stale =
    active &&
    secondsSinceActivity !== null &&
    secondsSinceActivity >= STALE_ACTIVITY_SECONDS;

  // Every branch is gated on `active`: a consent page discovered while idle is
  // not something the user can act on, and a late probe event must not light a
  // card for a session that already ended.
  const blocked = active && (mapHealth === 'consent' || mapHealth === 'captcha');
  // R-10: the parser no longer matches Google's responses. The same alert
  // surface as consent/captcha — a red card with reload/restart — because the
  // cure is the same: restart re-checks and re-applies the field map.
  const degraded = active && mapHealth === 'parse-degraded';
  const noResults = active && !blocked && !degraded && mapHealth === 'no-results';
  const warn = blocked || degraded || stale;
  if (!warn && !noResults) return null;

  const title = degraded
    ? t('listen.parseDegradedTitle')
    : blocked
      ? t('listen.mapBlockedTitle')
      : stale
        ? t('listen.staleTitle', { seconds: secondsSinceActivity ?? 0 })
        : t('listen.noResultsHint');
  const hint = degraded
    ? t('listen.parseDegradedHint')
    : blocked
      ? t('listen.mapBlockedHint')
      : stale
        ? t('listen.staleHint')
        : '';

  return (
    <section className={`listen-card${warn ? ' is-stale' : ''}`} role="status">
      <div className="listen-text">
        <div className="listen-title">{title}</div>
        {hint && <div className="listen-hint">{hint}</div>}
      </div>

      {warn && (
        <Tooltip title={t('listen.reloadHint')}>
          <Button
            icon={<GlobalOutlined />}
            onClick={onReloadMap}
            aria-label={t('listen.reload')}
          />
        </Tooltip>
      )}
      {warn && (
        <Tooltip title={t('listen.restartHint')}>
          <Button
            icon={<ReloadOutlined />}
            loading={busy}
            onClick={onRestart}
            aria-label={t('listen.restart')}
          />
        </Tooltip>
      )}
    </section>
  );
}
