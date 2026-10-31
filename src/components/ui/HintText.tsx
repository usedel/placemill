import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  tone?: 'muted' | 'warn' | 'danger';
  className?: string;
}

/**
 * One muted hint.
 *
 * Six classes carried this role at three sizes: `.settings-hint`, `.grid-note`,
 * `.task-detail-note`, `.task-detail-more`, `.task-single-flight` and
 * `.queue-delete-note`.
 */
export default function HintText({ children, tone = 'muted', className }: Props) {
  const toneClass = tone === 'warn' ? ' is-warn' : tone === 'danger' ? ' is-danger' : '';
  const classes = `ui-hint${toneClass}${className ? ` ${className}` : ''}`;
  return <div className={classes}>{children}</div>;
}
