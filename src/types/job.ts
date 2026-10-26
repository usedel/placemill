/**
 * A queued area-collection job. Mirrors `db::JobRow` in Rust — the backend is
 * the source of truth for every field except the display formatting.
 */
export type JobStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface Job {
  id: string;
  /** User-facing name, editable; defaults to keyword · city · time. */
  name: string;
  /** Shared by the jobs of one multi-keyword submit; empty otherwise. */
  batchId: string;
  keyword: string;
  city: string;
  centerLat: number;
  centerLng: number;
  radiusKm: number;
  cellKm: number;
  /** Result count per cell that triggers a quadtree split (M4). */
  splitThreshold: number;
  locale: string;
  status: JobStatus;
  totalTiles: number;
  doneTiles: number;
  failedTiles: number;
  inserted: number;
  /** Places attributed to this job, including ones another job stored first. */
  foundCount: number;
  /** Epoch ms of the last export; 0 = never exported (P2). */
  lastExportedAt: number;
  currentTile: string | null;
  createdAt: string;
}

/** One execution of a task (P2). Mirrors `db::RunRow`. */
export interface JobRun {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: JobStatus;
  tilesDone: number;
  tilesFailed: number;
  newCount: number;
}

/** One grid cell (P2: the failed-tile list reads these). */
export interface JobTile {
  id: string;
  seq: number;
  lat: number;
  lng: number;
  zoom: number;
  depth: number;
  status: string;
  attempts: number;
  resultCount: number;
  /** Why the cell produced nothing: nav-failed / timeout / parse-empty / drift. */
  errorReason: string | null;
}
