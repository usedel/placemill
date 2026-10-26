import { useCallback, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { App as AntdApp } from 'antd';
import { DoubleLeftOutlined, DoubleRightOutlined } from '@ant-design/icons';
import { useT } from '../i18n';
import { useSettings } from '../settings/SettingsContext';

export const DEFAULT_SPLIT = 0.46;
const MIN_SPLIT = 0.26;
const MAX_SPLIT = 0.8;

interface Props {
  ratio: number;
  onChange: (ratio: number) => void;
  /** Maps pane collapsed to 1px (UI-11): the handle becomes a restore strip. */
  collapsed: boolean;
  onToggleCollapse: () => void;
}

/**
 * A thin drag handle on the right edge of the panel.
 * The pointer is tracked through screenX so dragging keeps working while the
 * Tauri webview is being resized underneath it.
 *
 * Dragging calls `set_split_ratio` on every animation frame (geometry only);
 * the value is persisted once, when the gesture ends.
 *
 * UI-11: the handle also carries a collapse button, and when the map is
 * collapsed the component renders a 12px restore strip instead. The collapse
 * flag lives in settings (independent of the ratio), and Rust owns the
 * geometry in both states.
 */
export default function SplitHandle({
  ratio,
  onChange,
  collapsed,
  onToggleCollapse,
}: Props) {
  const t = useT();
  const { message } = AntdApp.useApp();
  const { settings, update } = useSettings();
  const [dragging, setDragging] = useState(false);
  const startRef = useRef({ x: 0, ratio, totalWidth: 1, panelWidth: 1 });
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef(ratio);
  /** Last value written to SQLite, so a click without a drag writes nothing. */
  const persistedRef = useRef(ratio);
  /** One warning per gesture: a failing per-frame call would flood the console. */
  const warnedRef = useRef(false);

  const reportFailure = (error: unknown) => {
    if (warnedRef.current) return;
    warnedRef.current = true;
    console.warn('[Placemill] set_split_ratio failed:', error);
  };

  const persist = useCallback(
    (value: number) => {
      // "Remember panel width" off: the drag still applies, it just is not stored.
      if (!settings.rememberSplit) return;
      if (Math.abs(value - persistedRef.current) < 1e-4) return;
      persistedRef.current = value;
      void update({ splitRatio: Number(value.toFixed(4)) }).catch((error: unknown) => {
        // R-34: "remember panel width" is on, so a rejected write means the next
        // launch comes back to the old width. Say so instead of only logging it.
        console.error('[Placemill] failed to persist the split ratio:', error);
        message.warning(t('settings.saveFailed', { error: String(error) }));
      });
    },
    [settings.rememberSplit, update, message, t],
  );

  // Collapsed: a 12px strip at the panel's right edge is the only way back.
  // Double-click restores as well, mirroring the handle's reset gesture.
  // Placed after every hook so the hook order stays stable across states.
  if (collapsed) {
    return (
      <div
        className="map-restore-strip"
        onDoubleClick={onToggleCollapse}
        title={t('split.expandHint')}
      >
        <button
          type="button"
          className="map-restore-btn"
          onClick={onToggleCollapse}
          aria-label={t('split.expand')}
        >
          <DoubleLeftOutlined />
        </button>
      </div>
    );
  }

  const applyRatio = (next: number) => {
    pendingRef.current = next;
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const value = pendingRef.current;
      onChange(value);
      invoke('set_split_ratio', { ratio: value }).catch(reportFailure);
    });
  };

  const onPointerDown = (event: React.PointerEvent) => {
    event.preventDefault();
    const panelWidth = window.innerWidth;
    startRef.current = {
      x: event.screenX,
      ratio,
      panelWidth,
      totalWidth: panelWidth / Math.max(ratio, 0.01),
    };
    setDragging(true);
    document.body.classList.add('is-resizing');

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.buttons === 0) {
        cleanup();
        return;
      }
      const { x, panelWidth: startWidth, totalWidth } = startRef.current;
      if (totalWidth <= 0) return;
      const next = Math.min(
        MAX_SPLIT,
        Math.max(MIN_SPLIT, (startWidth + (moveEvent.screenX - x)) / totalWidth),
      );
      applyRatio(Number(next.toFixed(4)));
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      window.removeEventListener('blur', cleanup);
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
        // The cancelled frame never reached Rust. Flush it so the applied
        // geometry and the value we are about to persist agree.
        onChange(pendingRef.current);
        invoke('set_split_ratio', { ratio: pendingRef.current }).catch(reportFailure);
      }
      document.body.classList.remove('is-resizing');
      setDragging(false);
      persist(pendingRef.current);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
    window.addEventListener('blur', cleanup);
  };

  const reset = () => {
    pendingRef.current = DEFAULT_SPLIT;
    onChange(DEFAULT_SPLIT);
    void invoke('set_split_ratio', { ratio: DEFAULT_SPLIT })
      .then(() => persist(DEFAULT_SPLIT))
      .catch(reportFailure);
  };

  // The handle used to be pointer-only. Arrow keys move it by 2% (10% with
  // Shift), Home/End jump to the limits, and double-click still resets.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    let next: number | null = null;

    if (event.key === 'ArrowLeft') next = ratio - step;
    else if (event.key === 'ArrowRight') next = ratio + step;
    else if (event.key === 'Home') next = MIN_SPLIT;
    else if (event.key === 'End') next = MAX_SPLIT;

    if (next === null) return;
    event.preventDefault();

    const clamped = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, Number(next.toFixed(4))));
    applyRatio(clamped);
    persist(clamped);
  };

  const percent = Math.round(ratio * 100);

  return (
    <div
      className={`split-handle${dragging ? ' is-dragging' : ''}`}
      onPointerDown={onPointerDown}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('split.label')}
      aria-valuemin={Math.round(MIN_SPLIT * 100)}
      aria-valuemax={Math.round(MAX_SPLIT * 100)}
      aria-valuenow={percent}
      aria-valuetext={`${percent}%`}
      title={t('split.title')}
    >
      {/* UI-11: collapse the map so the table gets the full width. Pointer,
          click and double-click are all contained: none of them may reach the
          handle, or a double-click would also reset the ratio. */}
      <button
        type="button"
        className="split-collapse-btn"
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onToggleCollapse();
        }}
        aria-label={t('split.collapse')}
        title={t('split.collapseHint')}
      >
        <DoubleRightOutlined />
      </button>
    </div>
  );
}
