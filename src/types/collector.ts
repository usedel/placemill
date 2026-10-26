export interface Diagnostics {
  db_path: string;
  total_in_db: number;
  /** p95 of the last page queries; null until the panel has loaded one. */
  query_p95_ms: number | null;
  query_samples: number;
  listening: boolean;
  split_ratio: number;
  events: number;
  records: number;
  new_records: number;
  /** Rows discarded before storage this session (UI-09 + R-26). */
  dropped: number;
  last_event_at: number | null;
  last_error: string | null;
  maps_ready: boolean;
}

/**
 * Health state reported by the Maps page probe (UI-01b). `parse-degraded`
 * (R-10) comes from the parse path, not the 10 s probe: three real search
 * bodies in a row produced zero rows, so the field map no longer matches.
 */
export type MapHealth =
  | 'ok'
  | 'consent'
  | 'captcha'
  | 'no-results'
  | 'parse-degraded'
  | 'unknown';

/** Running totals of one collecting session (UI-09). */
export interface SessionSummary {
  /** Rows in the batches as they arrived, before filtering. */
  received: number;
  /** Rows that were new to the database. */
  inserted: number;
  /** Rows discarded before storage (the "only with phone" switch, R-26). */
  dropped: number;
}
