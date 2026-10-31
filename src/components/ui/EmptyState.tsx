import type { ReactNode } from 'react';

interface Props {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  /** Numbered steps; rendered as an `<ol>` so the order is semantic. */
  steps?: ReactNode[];
  action?: ReactNode;
  /** Anything below the action: preset chips, a hint, a link. */
  footnote?: ReactNode;
  /** `true` for a first-run card, `false` for "this table has no rows". */
  card?: boolean;
  className?: string;
}

/**
 * One empty state, two densities.
 *
 * The app had a carefully built card for the task queue and antd's
 * `PRESENTED_IMAGE_SIMPLE` everywhere else, which is why the same "nothing here
 * yet" moment looked like two different products.
 */
export default function EmptyState({
  title,
  description,
  icon,
  steps,
  action,
  footnote,
  card = true,
  className,
}: Props) {
  const classes = ['ui-empty', card ? 'is-card' : '', className ?? ''].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      {icon && <span className="ui-empty-icon">{icon}</span>}
      <div className="ui-empty-title">{title}</div>
      {description && <p className="ui-empty-desc">{description}</p>}
      {steps && steps.length > 0 && (
        <ol className="ui-empty-steps">
          {steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
      )}
      {action}
      {footnote}
    </div>
  );
}
