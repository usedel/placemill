import type { JobStatus } from '../../types/job';

interface Props {
  status: JobStatus;
  /** Already localised; the pill never formats text. */
  label: string;
  /**
   * Legacy hook, kept as a secondary class. `scripts/e2e/tasks.mjs` reads
   * `.task-card-status` text content, so the class name and the exact text node
   * are part of the contract.
   */
  className?: string;
}

/**
 * One status pill for six states.
 *
 * The three blocks this replaces (`.task-card-status`, `.task-detail-status`,
 * `.task-run-status`) were byte-identical apart from a colour, and `cancelled`
 * had no rule at all — it rendered exactly like `completed`.
 *
 * The dot is a `::before` pseudo-element so the element's text content stays
 * the bare status word.
 */
export default function StatusPill({ status, label, className }: Props) {
  const classes = `ui-status ui-status--${status} is-${status}${className ? ` ${className}` : ''}`;
  return <span className={classes}>{label}</span>;
}
