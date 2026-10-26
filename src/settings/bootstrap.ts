import type { Settings } from './types';

declare global {
  interface Window {
    __PLACE_MILL_SETTINGS__?: Settings;
    /** Set by `main.tsx` right before the first render; proves the ordering. */
    __PLACE_MILL_THEME_APPLIED__?: 'module';
  }
}

/**
 * Settings injected by Rust through `initialization_script`, so they are
 * available synchronously on the very first render.
 *
 * There is deliberately no JS-side fallback: duplicating the defaults here is
 * exactly how "the panel shows one value while the backend uses another" starts.
 * If the script is missing, failing loudly is better than running with guesses —
 * wrap the caller in an error boundary if a white screen is a concern.
 */
export function readBootstrap(): Settings {
  const injected = window.__PLACE_MILL_SETTINGS__;
  if (!injected) {
    throw new Error('Settings bootstrap missing: initialization_script was not applied');
  }
  return injected;
}
