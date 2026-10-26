import { theme as antdTheme } from 'antd';
import type { ThemeConfig } from 'antd';
import { useEffect, useState } from 'react';

import type { ThemeMode } from './settings/types';

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', Roboto, sans-serif";

/**
 * Resolve a stored mode against the OS preference, outside React.
 *
 * `main.tsx` calls this before the first render so `App.css` (which switches its
 * tokens on `[data-theme]`) never paints the wrong palette.
 */
export function resolveDark(mode: ThemeMode): boolean {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/** Single place that writes the theme attributes on `<html>`. */
export function applyThemeAttribute(dark: boolean): void {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

/**
 * Resolve the user's theme preference against the OS setting.
 *
 * The OS listener stays mounted even in light/dark mode: switching back to
 * "system" then picks up the current value without a remount.
 */
export function useResolvedDark(mode: ThemeMode): boolean {
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return mode === 'system' ? systemDark : mode === 'dark';
}

export function buildTheme(dark: boolean): ThemeConfig {
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: dark ? '#3b82f6' : '#2563eb',
      colorInfo: dark ? '#3b82f6' : '#2563eb',
      colorSuccess: dark ? '#34d399' : '#16a34a',
      colorWarning: dark ? '#fbbf24' : '#d97706',
      colorBgLayout: dark ? '#0f1115' : '#f4f6fb',
      colorBgContainer: dark ? '#171a21' : '#ffffff',
      colorBorderSecondary: dark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.07)',
      borderRadius: 10,
      borderRadiusSM: 8,
      fontSize: 13,
      fontFamily: FONT_STACK,
      controlHeight: 32,
      controlHeightSM: 26,
      wireframe: false,
    },
    components: {
      Table: {
        headerBg: dark ? '#1b1f27' : '#f8fafc',
        headerColor: dark ? '#cbd5e1' : '#475569',
        headerSplitColor: 'transparent',
        rowHoverBg: dark ? '#20242d' : '#f5f8ff',
        borderColor: dark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)',
        cellPaddingBlockSM: 9,
        cellPaddingInlineSM: 10,
      },
      Button: {
        fontWeight: 500,
        primaryShadow: 'none',
        defaultShadow: 'none',
        dangerShadow: 'none',
      },
      Card: { paddingLG: 14 },
      Tag: { defaultBg: dark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.05)' },
      Drawer: { paddingLG: 20 },
    },
  };
}
