/**
 * Panel width breakpoints.
 *
 * The panel webview is exactly as wide as the split pane, so its viewport *is*
 * the panel width. These numbers are the only copy: `usePanelLayout` turns them
 * into the `is-tight` / `is-compact` classes `App.css` keys off, and the
 * drawer widths come from `drawerWidth`.
 *
 * `medium` and `wide` are not layout switches — they decide which table columns
 * are offered (`App.tsx`), which is why they keep their original values.
 */
export const BREAKPOINTS = {
  /**
   * Below this a seven-column table cannot be read: rows become cards.
   *
   * 560, not 480: the split handle's floor is `MIN_SPLIT_RATIO` (0.26), so on a
   * 1920px display the narrowest panel is ~499px — a 480 threshold would never
   * be reachable there and the compact layout would only exist on small
   * screens. 560 is above that floor and still well below the 662px a 1440px
   * window gives at the default ratio.
   *
   * `scripts/e2e/compact.mjs` parses this literal (it cannot import TS), so
   * keep the `compact: <number>,` shape intact.
   */
  compact: 560,
  /** Below this the header loses its subtitle and toolbars lose their labels. */
  tight: 620,
  /** Column sets in the data table. */
  medium: 700,
  /** The widest column set. */
  wide: 920,
} as const;

export type PanelTier = 'compact' | 'tight' | 'medium' | 'wide';

export function panelTier(width: number): PanelTier {
  if (width < BREAKPOINTS.compact) return 'compact';
  if (width < BREAKPOINTS.tight) return 'tight';
  if (width < BREAKPOINTS.medium) return 'medium';
  return 'wide';
}

/**
 * A drawer may never be wider than the panel it opens inside. Full width in
 * compact mode (16px of chrome would eat a third of a 260px panel), otherwise
 * capped so the map behind it stays visible.
 */
export function drawerWidth(panelWidth: number, max = 400): number {
  if (panelWidth <= BREAKPOINTS.compact) return panelWidth;
  return Math.max(240, Math.min(max, panelWidth - 16));
}
