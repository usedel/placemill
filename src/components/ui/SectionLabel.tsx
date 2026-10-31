import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  className?: string;
}

/**
 * The one section label.
 *
 * Settings, diagnostics, the task failure block and the detail drawer each had
 * their own — three sizes, two of them uppercase, none of them aligned with the
 * type scale. `className` survives for the callers that need extra spacing.
 */
export default function SectionLabel({ children, className }: Props) {
  return (
    <div className={className ? `ui-section ${className}` : 'ui-section'}>{children}</div>
  );
}
