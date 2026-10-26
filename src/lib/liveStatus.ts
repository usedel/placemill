import { useEffect, useState } from 'react';

/**
 * Silence longer than this while a task is running means neither the map panel
 * nor the runner produced any sign of life (consent page, captcha, or a search
 * that never ran). The card switches from "last record Ns ago" to an
 * actionable warning.
 *
 * Measured from the last of *both* signals — a batch arrival and a tile
 * transition. A batch clock alone cried wolf on empty cells, which legitimately
 * produce nothing for 20-40 s while the runner moves on to the next one.
 */
export const STALE_ACTIVITY_SECONDS = 90;

/** `mm:ss`, or `h:mm:ss` past the hour, for the collecting clock. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * A 1 s clock owned by the leaf that displays time (R-18).
 *
 * The panel used to tick a `now` state at the App root while collecting, which
 * re-rendered the whole page — table included — every second. Only the status
 * texts actually depend on wall-clock time, so the tick lives in those
 * components instead; nothing else re-renders with it.
 *
 * Inactive periods return the mount/last-activation time without a timer, and
 * flipping `active` back on refreshes immediately instead of showing the time
 * from when the clock stopped.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  return now;
}
