import { theme as antdTheme } from 'antd';
import type { ThemeConfig } from 'antd';
import { useEffect, useState } from 'react';

import { CONTROL, FONT_SANS, RADIUS, cssVars, palette } from './design/tokens';
import type { ThemeMode } from './settings/types';

/**
 * Resolve a stored mode against the OS preference, outside React.
 *
 * `main.tsx` calls this before the first render so the injected custom
 * properties (and therefore `App.css`) never paint the wrong palette.
 */
export function resolveDark(mode: ThemeMode): boolean {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/**
 * Single place that writes the theme onto `<html>`.
 *
 * The palette is not in the stylesheet: `cssVars` is the only definition, and
 * it is written here as inline custom properties. That is what keeps
 * `App.css` and antd from drifting apart — both read `src/design/tokens.ts`.
 * Idempotent, so the module-scope call and the effect can both run.
 */
export function applyThemeAttribute(dark: boolean): void {
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
  for (const [name, value] of Object.entries(cssVars(dark))) {
    root.style.setProperty(name, value);
  }
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

/**
 * antd mirrors the same tokens. Anything antd derives on its own (hover,
 * active, disabled) comes from the algorithm seeded with `colorPrimary`;
 * the explicit values below exist so a control's surface matches the panel it
 * sits on instead of antd's default grey.
 */
export function buildTheme(dark: boolean): ThemeConfig {
  const p = palette(dark);

  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: p.accentSolid,
      colorInfo: p.accent,
      colorSuccess: p.success,
      colorWarning: p.warning,
      colorError: p.danger,
      colorText: p.text1,
      colorTextSecondary: p.text2,
      colorTextTertiary: p.text3,
      colorBgLayout: p.appBg,
      colorBgContainer: p.panelBg,
      colorBgElevated: p.raised,
      colorBorder: p.borderStrong,
      colorBorderSecondary: p.border,
      colorFillSecondary: p.hover,
      colorFillQuaternary: p.panelBgSoft,
      colorLink: p.accent,
      boxShadow: p.shadowOverlay,
      boxShadowSecondary: p.shadowOverlay,
      borderRadius: RADIUS.md,
      borderRadiusSM: RADIUS.sm,
      borderRadiusLG: RADIUS.lg,
      fontSize: 13,
      fontFamily: FONT_SANS,
      controlHeight: CONTROL.height,
      controlHeightSM: CONTROL.heightSm,
      wireframe: false,
    },
    components: {
      Table: {
        // A transparent header lets the panel surface show through; the
        // separator is one hairline under the header row, not per column.
        headerBg: 'transparent',
        headerColor: p.text3,
        headerSplitColor: 'transparent',
        rowHoverBg: p.hover,
        rowSelectedBg: p.accentSoft,
        rowSelectedHoverBg: p.accentSoft,
        borderColor: p.border,
        cellPaddingBlockSM: 8,
        cellPaddingInlineSM: 10,
        headerBorderRadius: 0,
      },
      Button: {
        fontWeight: 500,
        primaryShadow: 'none',
        defaultShadow: 'none',
        dangerShadow: 'none',
      },
      Card: { paddingLG: 16 },
      Tag: {
        defaultBg: p.panelBgSoft,
        defaultColor: p.text2,
        borderRadiusSM: RADIUS.sm,
      },
      Drawer: { paddingLG: 20, colorBgElevated: p.panelBg },
      Modal: {
        contentBg: p.panelBg,
        headerBg: p.panelBg,
        titleFontSize: 15,
      },
      Segmented: {
        trackBg: p.panelBgSoft,
        itemSelectedBg: p.raised,
        itemColor: p.text2,
        itemSelectedColor: p.text1,
        trackPadding: 2,
      },
      Input: {
        activeBorderColor: p.accent,
        hoverBorderColor: p.borderStrong,
        activeShadow: `0 0 0 2px ${p.accentSoft}`,
      },
      Select: {
        optionSelectedBg: p.accentSoft,
        optionSelectedColor: p.text1,
      },
      Tabs: {
        itemColor: p.text2,
        itemSelectedColor: p.text1,
        inkBarColor: p.accent,
      },
      Progress: { defaultColor: p.accent, remainingColor: p.border },
      Tooltip: {
        // The spotlight surface is the raised panel colour, which is white in
        // light mode, so antd's default foreground — `colorTextLightSolid`,
        // literally "text to sit on a dark spotlight" — painted white on white
        // and the tip was unreadable there. The pair must move together.
        colorBgSpotlight: p.raised,
        colorTextLightSolid: p.text1,
        fontSize: 12,
      },
    },
  };
}
