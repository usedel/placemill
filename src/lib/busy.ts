import type { MessageKey } from '../i18n/en';

/**
 * The pane refusals the backend can return (C-01 / C-10).
 *
 * Five commands replace the Maps document, so they refuse while another owner
 * holds it: `map_busy:<jobId>` (grid task), `enrich_busy` (detail enrichment),
 * `reviews_busy` (reviews fetch) and `session_active` (collecting session).
 * The panel used to let three of them fall through as raw error text.
 */
export type PaneBusy = 'job' | 'enrich' | 'reviews' | 'session';

/** Classify a command error, or `null` when it is not a pane conflict. */
export function paneBusy(error: unknown): PaneBusy | null {
  const text = String(error);
  if (text.startsWith('map_busy')) return 'job';
  if (text === 'enrich_busy') return 'enrich';
  if (text === 'reviews_busy') return 'reviews';
  if (text === 'session_active') return 'session';
  return null;
}

/**
 * i18n key for a refusal, or `null` when the error is something else and the
 * caller should keep its own generic message.
 */
export function paneBusyMessageKey(error: unknown): MessageKey | null {
  switch (paneBusy(error)) {
    case 'job':
      return 'toast.jobBusy';
    case 'enrich':
      return 'toast.enrichBusy';
    case 'reviews':
      return 'toast.reviewsBusy';
    case 'session':
      return 'toast.sessionBusy';
    default:
      return null;
  }
}
