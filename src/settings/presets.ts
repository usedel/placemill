/**
 * Speed presets. Deliberately **not** stored: only `scrollMinMs`/`scrollMaxMs`
 * are persisted, and the radio is derived by exact reverse-matching. Storing an
 * enum as well would need two mappings (enum → range, range → enum) that are
 * guaranteed to disagree the first time a value is edited by hand.
 */
export type SpeedPresetKey = 'slow' | 'normal' | 'fast';

export const PRESET_RANGE: Record<SpeedPresetKey, { min: number; max: number }> = {
  slow: { min: 3000, max: 6000 },
  normal: { min: 1000, max: 3000 },
  fast: { min: 500, max: 1500 },
};

/** Order used by the radio group. */
export const SPEED_ORDER: SpeedPresetKey[] = ['slow', 'normal', 'fast'];

/** The preset whose range matches exactly, or null (= "custom"). */
export function matchPreset(min: number, max: number): SpeedPresetKey | null {
  for (const key of SPEED_ORDER) {
    const range = PRESET_RANGE[key];
    if (range.min === min && range.max === max) return key;
  }
  return null;
}
