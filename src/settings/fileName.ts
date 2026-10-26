/**
 * Render the export file name template.
 *
 * `{date}` is the **local** date as `YYYYMMDD`: the panel has the user's clock,
 * and rendering it here avoids pulling a timezone-aware date crate into Rust for
 * something purely cosmetic. `{count}` is the number of exported rows, and
 * `{task}` the task the rows were filtered to (P1 / T-11).
 *
 * The result is not trusted by the backend: Rust keeps only the file stem,
 * replaces characters Windows rejects and appends the extension.
 */
export function renderFileName(template: string, count: number, taskName?: string): string {
  const now = new Date();
  const date =
    `${now.getFullYear()}` +
    `${String(now.getMonth() + 1).padStart(2, '0')}` +
    `${String(now.getDate()).padStart(2, '0')}`;

  const task = (taskName ?? '').trim();
  const rendered = template
    .replace(/\{date\}/g, date)
    .replace(/\{count\}/g, String(count))
    .replace(/\{task\}/g, task || 'all')
    .trim();

  // A task export must be identifiable even when the stored template predates
  // `{task}`: the name is prefixed instead of silently dropped. "All data" keeps
  // the user's template untouched.
  if (task && !template.includes('{task}')) {
    return `${task}-${rendered}`;
  }
  return rendered;
}
