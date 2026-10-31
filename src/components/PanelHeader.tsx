import { Button, Dropdown, Segmented, Tooltip } from 'antd';
import {
  BugOutlined,
  EnvironmentFilled,
  MoreOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { useI18n } from '../i18n';
import { formatDuration, useNow } from '../lib/liveStatus';

export type PanelView = 'collect' | 'data';

interface Props {
  /** P1 / T-06: tasks and the table are two views, not one long page. */
  view: PanelView;
  onView: (value: PanelView) => void;
  listening: boolean;
  /** A task owns the map: the pill must say "collecting" even if the switch
   * event has not landed yet, otherwise a running task reads as paused. */
  busy: boolean;
  /**
   * When the collecting session started (R-18). The elapsed text is rendered
   * here, on its own 1 s clock, so the panel is not re-rendered every second.
   */
  sessionStartedAt: number | null;
  /**
   * Whether this session has actually collected anything (UI-16). Old rows in
   * the database do not count: after a restart the honest pill is "idle", not
   * "paused".
   */
  collectedThisSession: boolean;
  /**
   * UI-14: under `BREAKPOINTS.compact` there is no room for four icon buttons
   * beside the view switch, so the three secondary ones collapse into one menu.
   * "New task" stays out of it — it is the primary action and `grid.mjs`
   * reaches for `.brand-bar .anticon-plus`.
   */
  compact: boolean;
  onOpenGrid: () => void;
  onOpenDiagnostics: () => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
}

/**
 * The live part of the collecting pill: only this span re-renders every second
 * (R-18). It is mounted only while collecting, so the timer costs nothing when
 * the panel is idle.
 */
function ElapsedText({ startedAt }: { startedAt: number }) {
  const now = useNow(true);
  return <> · {formatDuration(now - startedAt)}</>;
}

/**
 * Status only — starting and pausing lives in `ListenCard`.
 *
 * The header used to carry a second play/pause button, which made the first
 * launch ambiguous: that icon was disabled until data existed, so the only
 * working entry point was the card below.
 */
export default function PanelHeader({
  view,
  onView,
  listening,
  busy,
  sessionStartedAt,
  collectedThisSession,
  compact,
  onOpenGrid,
  onOpenDiagnostics,
  onOpenSettings,
  onOpenHelp,
}: Props) {
  const { t } = useI18n();

  const collecting = listening || busy;
  const statusBase = collecting
    ? t('header.statusCollecting')
    : collectedThisSession
      ? t('header.statusPaused')
      : t('header.statusIdle');

  return (
    <header className="brand-bar">
      <div className="brand-logo">
        <EnvironmentFilled />
      </div>
      <div className="brand-text">
        <span className="brand-title">PlaceMill</span>
        <span className="brand-sub">{t('header.subtitle')}</span>
      </div>

      <div className="brand-spacer" />

      <Segmented<PanelView>
        className="view-switch"
        size="small"
        value={view}
        onChange={onView}
        options={[
          { value: 'collect', label: t('nav.collect') },
          { value: 'data', label: t('nav.data') },
        ]}
      />

      <div className={`status-pill${collecting ? ' is-live' : ''}`} title={statusBase}>
        <span className="status-dot" />
        {/* Wrapped so compact mode can hide the words and keep the dot; the
            text stays in the DOM, so `textContent` is unchanged. */}
        <span className="status-text">
          {statusBase}
          {listening && sessionStartedAt !== null && (
            <ElapsedText startedAt={sessionStartedAt} />
          )}
        </span>
      </div>

      <Tooltip title={t('header.grid')}>
        <Button
          className="icon-btn"
          type="text"
          shape="circle"
          size="small"
          icon={<PlusOutlined />}
          aria-label={t('header.grid')}
          onClick={onOpenGrid}
        />
      </Tooltip>

      {compact ? (
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          menu={{
            items: [
              { key: 'help', icon: <QuestionCircleOutlined />, label: t('header.help') },
              { key: 'diagnostics', icon: <BugOutlined />, label: t('header.diagnostics') },
              { key: 'settings', icon: <SettingOutlined />, label: t('header.settings') },
            ],
            onClick: ({ key }) => {
              if (key === 'help') onOpenHelp();
              else if (key === 'diagnostics') onOpenDiagnostics();
              else if (key === 'settings') onOpenSettings();
            },
          }}
        >
          <Button
            className="icon-btn"
            type="text"
            shape="circle"
            size="small"
            icon={<MoreOutlined />}
            aria-label={t('header.more')}
          />
        </Dropdown>
      ) : (
        <>
          <Tooltip title={t('header.help')}>
            <Button
              className="icon-btn"
              type="text"
              shape="circle"
              size="small"
              icon={<QuestionCircleOutlined />}
              aria-label={t('header.help')}
              onClick={onOpenHelp}
            />
          </Tooltip>

          <Tooltip title={t('header.settings')}>
            <Button
              className="icon-btn"
              type="text"
              shape="circle"
              size="small"
              icon={<SettingOutlined />}
              aria-label={t('header.settings')}
              onClick={onOpenSettings}
            />
          </Tooltip>

          <Tooltip title={t('header.diagnostics')}>
            <Button
              className="icon-btn"
              type="text"
              shape="circle"
              size="small"
              icon={<BugOutlined />}
              aria-label={t('header.diagnostics')}
              onClick={onOpenDiagnostics}
            />
          </Tooltip>
        </>
      )}
    </header>
  );
}
