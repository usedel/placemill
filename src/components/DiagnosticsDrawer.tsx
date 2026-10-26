import { Alert, Button, Drawer, Empty, Space, Spin, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { Diagnostics } from '../types/collector';
import { useI18n } from '../i18n';

const { Text } = Typography;

interface Props {
  open: boolean;
  loading: boolean;
  data: Diagnostics | null;
  onClose: () => void;
  onRefresh: () => void;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="diag-row">
      <span className="diag-key">{label}</span>
      <span className="diag-value">{value}</span>
    </div>
  );
}

/** `tag` comes from the active locale so the clock format follows the UI, not the OS. */
function formatTime(ms: number, tag: string): string {
  return new Date(ms).toLocaleTimeString(tag, { hour12: false });
}

export default function DiagnosticsDrawer({
  open,
  loading,
  data,
  onClose,
  onRefresh,
}: Props) {
  const { t, tag } = useI18n();
  const ratio = data?.split_ratio ?? 0.46;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={400}
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
          <Empty description={t('diag.empty')} />
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
              <div className="diag-section-title">{t('diag.sectionStatus')}</div>
              <Row
                label={t('diag.collector')}
                value={
                  data.listening ? (
                    <Text type="success">{t('diag.collecting')}</Text>
                  ) : (
                    <Text type="secondary">{t('diag.off')}</Text>
                  )
                }
              />
              <Row
                label={t('diag.mapView')}
                value={
                  data.maps_ready ? (
                    <Text type="success">{t('diag.ready')}</Text>
                  ) : (
                    <Text type="danger">{t('diag.notCreated')}</Text>
                  )
                }
              />
              <Row
                label={t('diag.panelMap')}
                value={`${Math.round(ratio * 100)}% : ${100 - Math.round(ratio * 100)}%`}
              />
            </div>

            <div className="diag-section">
              <div className="diag-section-title">{t('diag.sectionData')}</div>
              <Row
                label={t('diag.rowsInDb')}
                value={data.total_in_db.toLocaleString(tag)}
              />
              <Row
                label={t('diag.queryP95')}
                value={
                  data.query_p95_ms === null
                    ? t('common.dash')
                    : `${data.query_p95_ms.toLocaleString(tag)} ms`
                }
              />
              <Row
                label={t('diag.querySamples')}
                value={data.query_samples.toLocaleString(tag)}
              />
              <Row
                label={t('diag.lastInsert')}
                value={
                  data.last_event_at
                    ? formatTime(data.last_event_at, tag)
                    : t('common.dash')
                }
              />
            </div>

            <div className="diag-section">
              <div className="diag-section-title">{t('diag.sectionStats')}</div>
              <Row label={t('diag.batches')} value={data.events.toLocaleString(tag)} />
              <Row label={t('diag.records')} value={data.records.toLocaleString(tag)} />
              <Row
                label={t('diag.newRecords')}
                value={data.new_records.toLocaleString(tag)}
              />
              {/* Same counter the listen card's session summary sums from
                  (UI-09): one source, two consumers. */}
              <Row label={t('diag.dropped')} value={data.dropped.toLocaleString(tag)} />
            </div>

            <div className="diag-section">
              <div className="diag-section-title">{t('diag.dbLocation')}</div>
              <Text type="secondary" style={{ fontSize: 12 }} copyable>
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
