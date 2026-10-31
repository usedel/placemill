import { Checkbox, Spin } from 'antd';
import { StarFilled } from '@ant-design/icons';
import type { Key as ReactKey, ReactNode } from 'react';
import { useT } from '../i18n';
import type { Business } from '../types/business';

interface Props {
  rows: Business[];
  loading: boolean;
  selectedKeys: ReactKey[];
  /** Replaces the whole selection, exactly like the table's `onChange`. */
  onSelectionChange: (keys: ReactKey[]) => void;
  onOpen: (business: Business) => void;
  /**
   * The table's own locate + row-menu cluster, passed in rather than rebuilt:
   * both views must offer the same actions, and a second copy would drift.
   */
  renderActions: (business: Business) => ReactNode;
  /** Task chip, collected time — formatted by the caller, which owns the i18n. */
  renderMeta: (business: Business) => ReactNode;
  emptyText: ReactNode;
}

/**
 * The table, as cards (UI-14).
 *
 * Under `BREAKPOINTS.compact` a seven-column grid is unreadable and the
 * horizontal scrollbar hides the actions column, so each row becomes a
 * two-line card with the same selection model and the same row menu. The
 * `<Table>` is not mounted at all in this mode — keeping it hidden would still
 * cost the virtual scroller and its measured `scroll.y`.
 */
export default function BusinessCardList({
  rows,
  loading,
  selectedKeys,
  onSelectionChange,
  onOpen,
  renderActions,
  renderMeta,
  emptyText,
}: Props) {
  const t = useT();
  const selected = new Set(selectedKeys.map(String));

  const toggle = (placeId: string, checked: boolean) => {
    const next = selectedKeys.filter((key) => String(key) !== placeId);
    if (checked) next.push(placeId);
    onSelectionChange(next);
  };

  return (
    <Spin spinning={loading}>
      {rows.length === 0 ? (
        <div className="business-card-empty">{emptyText}</div>
      ) : (
        <div className="business-cards">
          {rows.map((business) => {
            const isSelected = selected.has(business.place_id);
            const name = business.name || t('table.unnamed');
            return (
              <div
                key={business.place_id}
                className={isSelected ? 'business-card is-selected' : 'business-card'}
                data-place-id={business.place_id}
              >
                <span className="business-card-check">
                  <Checkbox
                    checked={isSelected}
                    onChange={(event) => toggle(business.place_id, event.target.checked)}
                    aria-label={name}
                  />
                </span>

                <button
                  type="button"
                  className="business-card-body"
                  onClick={() => onOpen(business)}
                >
                  <span className="business-card-head">
                    <span className="business-card-name">{name}</span>
                    {business.rating > 0 && (
                      <span className="rating-cell business-card-rating">
                        <StarFilled />
                        {business.rating.toFixed(1)}
                      </span>
                    )}
                  </span>
                  {business.address && (
                    <span className="business-card-address">{business.address}</span>
                  )}
                  <span className="business-card-meta">
                    {business.phone && <span className="cell-mono">{business.phone}</span>}
                    {renderMeta(business)}
                  </span>
                </button>

                <span className="business-card-actions">{renderActions(business)}</span>
              </div>
            );
          })}
        </div>
      )}
    </Spin>
  );
}
