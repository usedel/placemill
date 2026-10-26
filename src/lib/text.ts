import type { TFunc } from '../i18n';

/**
 * Display form of a Google Maps type slug.
 *
 * R-33: the table's type column, the filter-suggestion click and the detail
 * drawer each carried their own `replace(/_/g, ' ')`. They have to agree — the
 * SQL filter matches on the *display* form, so a fourth copy with a different
 * rule would silently produce a type filter that matches nothing.
 */
export function typeLabel(value: string): string {
  return value.replace(/_/g, ' ');
}

/**
 * Label for a job/run status (R-33).
 *
 * `status` is a plain `String` in Rust, so a new state ships without a compile
 * error on this side. `translate()` falls back to the key itself, which would
 * render `queue.status.some-new-state`; showing the raw value is honest and
 * readable until the dictionaries catch up.
 */
export function jobStatusLabel(t: TFunc, status: string): string {
  const key = `queue.status.${status}` as Parameters<TFunc>[0];
  const label = t(key);
  return label === key ? status : label;
}
