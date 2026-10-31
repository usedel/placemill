import { useEffect, useState } from 'react';

import { BREAKPOINTS, panelTier } from './breakpoints';
import type { PanelTier } from './breakpoints';

export interface PanelLayout {
  width: number;
  tier: PanelTier;
  /** Rows become cards and filters move into a sheet. */
  compact: boolean;
  /** Labels drop, icons stay. */
  tight: boolean;
  /** Column set: the wide one. */
  medium: boolean;
  /** Column set: the widest one. */
  wide: boolean;
}

/**
 * The panel's own width, tracked once.
 *
 * Before this, `App.tsx` kept a private `panelWidth` state and its own resize
 * listener, and the drawers read `window.innerWidth` directly. One listener,
 * one source: every consumer now agrees on the same number.
 */
export function usePanelLayout(): PanelLayout {
  const [width, setWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const tier = panelTier(width);

  return {
    width,
    tier,
    compact: tier === 'compact',
    tight: width < BREAKPOINTS.tight,
    medium: width >= BREAKPOINTS.medium,
    wide: width >= BREAKPOINTS.wide,
  };
}
