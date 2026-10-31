import type { ReactNode } from 'react';

interface Props {
  label: ReactNode;
  children: ReactNode;
  /** Identifiers, coordinates and paths: fixed-width digits, no wrapping. */
  mono?: boolean;
  /** The value is a cluster of controls rather than text; align them right. */
  control?: boolean;
  className?: string;
  labelClassName?: string;
}

/**
 * One label + value row.
 *
 * This shape existed four times: a local `Row` in the settings drawer, another
 * in diagnostics, a `dl/dt/dd` grid in the task detail, and `Descriptions` in
 * the detail drawer. Three of them are now this component; `Descriptions` stays
 * because the e2e suite asserts on `.ant-drawer .ant-descriptions`.
 */
export default function FieldRow({
  label,
  children,
  mono,
  control,
  className,
  labelClassName,
}: Props) {
  const valueClass = ['ui-field-value', mono ? 'is-mono' : '', control ? 'is-control' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className ? `ui-field ${className}` : 'ui-field'}>
      <span className={labelClassName ? `ui-field-label ${labelClassName}` : 'ui-field-label'}>
        {label}
      </span>
      {/* A `<div>`: callers put antd controls in here, and a block inside a
          `<span>` is invalid nesting even though browsers render it. */}
      <div className={valueClass}>{children}</div>
    </div>
  );
}
