import { StarFilled } from '@ant-design/icons';
import { useI18n } from '../i18n';

interface Props {
  total: number;
  /** Every figure below the total is computed over the filtered rows. */
  avgRating: number;
  ratedCount: number;
  withPhone: number;
  withPhoneShare: number;
  bump: number;
  bumpKey: number;
}

export default function MetricStrip({
  total,
  avgRating,
  ratedCount,
  withPhone,
  withPhoneShare,
  bump,
  bumpKey,
}: Props) {
  const { t, tag } = useI18n();

  return (
    <div className="metrics">
      <div className="metric">
        <div className="metric-value">
          {total.toLocaleString(tag)}
          {bump > 0 && (
            <span className="metric-bump" key={bumpKey}>
              +{bump}
            </span>
          )}
        </div>
        <div className="metric-label">{t('metrics.collected')}</div>
      </div>

      <div className="metric">
        <div className="metric-value">
          <StarFilled className="star" />
          {ratedCount > 0 ? avgRating.toFixed(1) : t('common.dash')}
          {ratedCount > 0 && (
            <span className="metric-unit">{t('metrics.outOfFive')}</span>
          )}
        </div>
        <div className="metric-label">
          {ratedCount > 0
            ? t('metrics.avgRatingRated', { count: ratedCount })
            : t('metrics.avgRating')}
        </div>
      </div>

      {/* Replaces the "selected" counter, which duplicated the bulk bar and said
          nothing about the data itself. */}
      <div className="metric">
        <div className="metric-value">{withPhone.toLocaleString(tag)}</div>
        <div className="metric-label">
          {t('metrics.withPhoneShare', { pct: withPhoneShare })}
        </div>
      </div>
    </div>
  );
}
