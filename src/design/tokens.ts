/**
 * The single source of truth for colour, type, spacing, radius, elevation and
 * motion.
 *
 * Two consumers read this module and nothing else:
 * - `applyThemeAttribute` (src/theme.ts) writes `cssVars()` onto `<html>`, so
 *   `App.css` can carry `var(--…)` instead of a hex literal.
 * - `buildTheme` (src/theme.ts) feeds the same values to antd.
 *
 * That is deliberate: before this module the palette existed twice, once in
 * `App.css` (`:root` / `[data-theme='dark']`) and once in `buildTheme`, and
 * changing one copy silently left the other behind.
 */

/** System stack only — no webfont, so `font-src` in the CSP stays untouched. */
export const FONT_SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', Roboto, sans-serif";

/** Identifiers, coordinates and phone numbers: digits that must not shift. */
export const FONT_MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

/** 2 4 6 8 12 16 20 24 32 — the only gaps the layout is allowed to use. */
const SPACE_STEPS = [2, 4, 6, 8, 12, 16, 20, 24, 32] as const;

/** Pixel values antd needs as numbers; the CSS mirrors are derived from them. */
export const RADIUS = { sm: 4, md: 6, lg: 8 } as const;

export const CONTROL = { height: 32, heightSm: 26 } as const;

/**
 * Seven steps, each with a line height that belongs to it. A size without its
 * line height is what produced the 9/10/11/11.5/12/12.5/13/13.5/14/14.5/15
 * soup this scale replaces.
 */
const TYPE_SCALE = {
  micro: [10, 14],
  xs: [11, 15],
  sm: [12, 17],
  base: [13, 19],
  md: [15, 21],
  lg: [19, 24],
  xl: [26, 30],
} as const;

const DURATION = { fast: '120ms', base: '180ms', slow: '240ms' } as const;

/** One easing for everything: fast out, soft landing. */
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

export interface Palette {
  appBg: string;
  panelBg: string;
  panelBgSoft: string;
  raised: string;
  border: string;
  borderStrong: string;
  text1: string;
  text2: string;
  text3: string;
  accent: string;
  accentSoft: string;
  accentSolid: string;
  accentFg: string;
  accentBorder: string;
  rowReveal: string;
  hover: string;
  success: string;
  warning: string;
  danger: string;
  liveSoft: string;
  star: string;
  shadowPanel: string;
  shadowOverlay: string;
}

export const LIGHT: Palette = {
  appBg: '#f6f7f9',
  panelBg: '#ffffff',
  panelBgSoft: '#f7f8fa',
  raised: '#ffffff',
  border: 'rgba(15, 23, 42, 0.08)',
  borderStrong: 'rgba(15, 23, 42, 0.14)',
  text1: '#171b22',
  text2: '#4b5565',
  // 5.0:1 on the panel, 4.7:1 on the soft surface — the muted 11px copy this
  // carries still clears the 4.5:1 bar UI-16 asked for.
  text3: '#66707f',
  accent: '#4c5fd5',
  accentSoft: 'rgba(76, 95, 213, 0.08)',
  accentSolid: '#4c5fd5',
  accentFg: '#ffffff',
  accentBorder: 'rgba(76, 95, 213, 0.24)',
  rowReveal: 'rgba(76, 95, 213, 0.14)',
  hover: 'rgba(15, 23, 42, 0.035)',
  success: '#0f7a4d',
  warning: '#b45309',
  danger: '#c62828',
  liveSoft: 'rgba(198, 40, 40, 0.09)',
  star: '#d97706',
  shadowPanel: '8px 0 24px rgba(9, 12, 20, 0.05)',
  shadowOverlay: '0 12px 32px -8px rgba(9, 12, 20, 0.18), 0 2px 6px rgba(9, 12, 20, 0.06)',
};

export const DARK: Palette = {
  appBg: '#0e1014',
  panelBg: '#15181e',
  panelBgSoft: '#1a1e26',
  raised: '#20252e',
  border: 'rgba(255, 255, 255, 0.07)',
  borderStrong: 'rgba(255, 255, 255, 0.13)',
  text1: '#e7eaf0',
  text2: '#a8b1c0',
  // 5.4:1 on the panel, 5.1:1 on the soft surface.
  text3: '#858f9f',
  accent: '#8b9bff',
  accentSoft: 'rgba(139, 155, 255, 0.14)',
  // Filled surfaces that carry white text stay on the light-mode value: the
  // dark `--accent` is too light for white to sit on it.
  accentSolid: '#4c5fd5',
  accentFg: '#ffffff',
  accentBorder: 'rgba(139, 155, 255, 0.30)',
  rowReveal: 'rgba(139, 155, 255, 0.18)',
  hover: 'rgba(255, 255, 255, 0.045)',
  success: '#4ade80',
  warning: '#fbbf24',
  danger: '#ff8a8a',
  liveSoft: 'rgba(255, 138, 138, 0.14)',
  star: '#fbbf24',
  shadowPanel: '8px 0 24px rgba(0, 0, 0, 0.45)',
  shadowOverlay: '0 16px 40px -12px rgba(0, 0, 0, 0.60), 0 2px 8px rgba(0, 0, 0, 0.30)',
};

export function palette(dark: boolean): Palette {
  return dark ? DARK : LIGHT;
}

/**
 * Brand marks are not theme colours: LinkedIn blue is the same blue in dark
 * mode. They still live here rather than in `App.css`, so the "one place for
 * colour" rule survives — `--brand-*` is written onto `<html>` like the rest.
 *
 * X is deliberately absent: its mark is black on light and white on dark, so it
 * stays `currentColor` and the theme decides.
 */
const BRAND = {
  linkedin: '#0a66c2',
  facebook: '#1877f2',
  instagram: '#e1306c',
} as const;

/**
 * Everything `App.css` is allowed to read, as custom properties on `<html>`.
 * Colour and scale live together so there is no second place to edit.
 */
export function cssVars(dark: boolean): Record<string, string> {
  const p = palette(dark);
  const vars: Record<string, string> = {
    '--app-bg': p.appBg,
    '--panel-bg': p.panelBg,
    '--panel-bg-soft': p.panelBgSoft,
    '--raised': p.raised,
    '--panel-border': p.border,
    '--panel-border-strong': p.borderStrong,
    '--text-1': p.text1,
    '--text-2': p.text2,
    '--text-3': p.text3,
    '--accent': p.accent,
    '--accent-soft': p.accentSoft,
    '--accent-solid': p.accentSolid,
    '--accent-fg': p.accentFg,
    '--accent-border': p.accentBorder,
    '--row-reveal': p.rowReveal,
    '--hover': p.hover,
    '--success': p.success,
    '--warning': p.warning,
    '--danger': p.danger,
    // `--live` predates `--danger` and means "failed" everywhere it is used;
    // the collecting pill reads `--accent` instead, so red is failure only.
    '--live': p.danger,
    '--live-soft': p.liveSoft,
    '--star': p.star,
    '--brand-linkedin': BRAND.linkedin,
    '--brand-facebook': BRAND.facebook,
    '--brand-instagram': BRAND.instagram,
    '--shadow-panel': p.shadowPanel,
    '--shadow-overlay': p.shadowOverlay,
    '--font-sans': FONT_SANS,
    '--font-mono': FONT_MONO,
    '--radius-sm': `${RADIUS.sm}px`,
    '--radius-md': `${RADIUS.md}px`,
    '--radius-lg': `${RADIUS.lg}px`,
    '--radius-full': '999px',
    '--dur-fast': DURATION.fast,
    '--dur-base': DURATION.base,
    '--dur-slow': DURATION.slow,
    '--ease': EASE,
  };

  SPACE_STEPS.forEach((step, index) => {
    vars[`--space-${index + 1}`] = `${step}px`;
  });

  for (const [name, [size, line]] of Object.entries(TYPE_SCALE)) {
    vars[`--fs-${name}`] = `${size}px`;
    vars[`--lh-${name}`] = `${line}px`;
  }

  return vars;
}
