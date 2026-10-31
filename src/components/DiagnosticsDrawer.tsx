import { Alert, Button, Drawer, Space, Spin, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { Diagnostics } from '../types/collector';
import { useI18n } from '../i18n';
import { drawerWidth } from '../design/breakpoints';
import EmptyState from './ui/EmptyState';
import FieldRow from './ui/FieldRow';
import SectionLabel from './ui/SectionLabel';

const { Text } = Typography;

interface Props {
  open: boolean;
  loading: boolean;
  data: Diagnostics | null;
  /**
   * The panel's width. This drawer used to hard-code 400px, which overflowed
   * every panel narrower than that — i.e. most of the split range.
   */
  panelWidth: number;
  onClose: () => void;
  onRefresh: () => void;
}

/** `tag` comes from the active locale so the clock format follows the UI, not the OS. */
function formatTime(ms: number, tag: string): string {
  return new Date(ms).toLocaleTimeString(tag, { hour12: false });
}

export default function DiagnosticsDrawer({
  open,
  loading,
  data,
  panelWidth,
  onClose,
  onRefresh,
}: Props) {
  const { t, tag } = useI18n();
  const ratio = data?.split_ratio ?? 0.46;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={drawerWidth(panelWidth)}
      title={t('diag.title')}
      extra={
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={onRefresh}
        >
          {t('diag.refresh')}
        </Button>
      }
    >
      <Spin spinning={loading}>
        {!data ? (
          <EmptyState card={false} title={t('diag.empty')} />
        ) : (
          <Space direction="vertical" size={18} style={{ width: '100%' }}>
            {data.last_error && (
              <Alert
                type="error"
                showIcon
                message={t('diag.lastError')}
                description={data.last_error}
              />
            )}

            <div className="diag-section">
              <SectionLabel>{t('diag.sectionStatus')}</SectionLabel>
              <FieldRow label={t('diag.collector')}>
                {data.listening ? (
                  <Text type="success">{t('diag.collecting')}</Text>
                ) : (
                  <Text type="secondary">{t('diag.off')}</Text>
                )}
              </FieldRow>
              <FieldRow label={t('diag.mapView')}>
                {data.maps_ready ? (
                  <Text type="success">{t('diag.ready')}</Text>
                ) : (
                  <Text type="danger">{t('diag.notCreated')}</Text>
                )}
              </FieldRow>
              <FieldRow label={t('diag.panelMap')}>
                {`${Math.round(ratio * 100)}% : ${100 - Math.round(ratio * 100)}%`}
              </FieldRow>
            </div>

            <div className="diag-section">
              <SectionLabel>{t('diag.sectionData')}</SectionLabel>
              <FieldRow label={t('diag.rowsInDb')}>
                {data.total_in_db.toLocaleString(tag)}
              </FieldRow>
              <FieldRow label={t('diag.queryP95')}>
                {data.query_p95_ms === null
                  ? t('common.dash')
                  : `${data.query_p95_ms.toLocaleString(tag)} ms`}
              </FieldRow>
              <FieldRow label={t('diag.querySamples')}>
                {data.query_samples.toLocaleString(tag)}
              </FieldRow>
              <FieldRow label={t('diag.lastInsert')}>
                {data.last_event_at ? formatTime(data.last_event_at, tag) : t('common.dash')}
              </FieldRow>
            </div>

            <div className="diag-section">
              <SectionLabel>{t('diag.sectionStats')}</SectionLabel>
              <FieldRow label={t('diag.batches')}>{data.events.toLocaleString(tag)}</FieldRow>
              <FieldRow label={t('diag.records')}>{data.records.toLocaleString(tag)}</FieldRow>
              <FieldRow label={t('diag.newRecords')}>
                {data.new_records.toLocaleString(tag)}
              </FieldRow>
              {/* Same counter the listen card's session summary sums from
                  (UI-09): one source, two consumers. */}
              <FieldRow label={t('diag.dropped')}>{data.dropped.toLocaleString(tag)}</FieldRow>
            </div>

            <div className="diag-section">
              <SectionLabel>{t('diag.dbLocation')}</SectionLabel>
              <Text type="secondary" className="cell-mono" copyable>
                {data.db_path}
              </Text>
            </div>

            <Alert
              type="info"
              showIcon
              message={t('diag.helpTitle')}
              description={t('diag.helpDesc')}
            />
          </Space>
        )}
      </Spin>
    </Drawer>
  );
}
