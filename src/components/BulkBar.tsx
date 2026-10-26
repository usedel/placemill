import { Button, Dropdown, Tooltip } from 'antd';
import {
  CopyOutlined,
  DownOutlined,
  ExportOutlined,
  CloseOutlined,
} from '@ant-design/icons';
import { useT } from '../i18n';

/** M10: the export formats the bulk bar offers, mirroring the toolbar menu. */
type BulkExportFormat = 'excel' | 'csv' | 'json' | 'jsonl';

interface Props {
  count: number;
  /** Rows matching the current filters — the "select all" target. */
  total: number;
  /** Selected rows hidden by the current filters, so the count cannot surprise. */
  beyondView: number;
  exporting: boolean;
  onExport: (format: BulkExportFormat) => void;
  onCopyPhones: () => void;
  onSelectAll: () => void;
  onClear: () => void;
}

export default function BulkBar({
  count,
  total,
  beyondView,
  exporting,
  onExport,
  onCopyPhones,
  onSelectAll,
  onClear,
}: Props) {
  const t = useT();

  return (
    <div className="bulk-bar">
      <span className="bulk-count">{t('bulk.selectedCount', { count })}</span>

      {count < total && (
        <Button type="link" size="small" className="bulk-link" onClick={onSelectAll}>
          {t('bulk.selectAll', { count: total })}
        </Button>
      )}

      {beyondView > 0 && (
        <span className="bulk-note">{t('bulk.beyondView', { count: beyondView })}</span>
      )}

      <Dropdown.Button
        size="small"
        type="primary"
        loading={exporting}
        onClick={() => onExport('excel')}
        icon={<DownOutlined />}
        menu={{
          items: [
            { key: 'excel', label: t('bulk.exportExcel') },
            { key: 'csv', label: t('bulk.exportCsv') },
            { key: 'json', label: t('bulk.exportJson') },
            { key: 'jsonl', label: t('bulk.exportJsonl') },
          ],
          onClick: ({ key }) => onExport(key as BulkExportFormat),
        }}
      >
        <ExportOutlined /> {t('bulk.export')}
      </Dropdown.Button>

      <Tooltip title={t('bulk.copyPhonesHint')}>
        <Button size="small" icon={<CopyOutlined />} onClick={onCopyPhones}>
          {t('bulk.copyPhones')}
        </Button>
      </Tooltip>

      <div style={{ flex: 1 }} />

      <Tooltip title={t('bulk.clearSelection')}>
        <Button
          size="small"
          type="text"
          icon={<CloseOutlined />}
          aria-label={t('bulk.clearSelection')}
          onClick={onClear}
        />
      </Tooltip>
    </div>
  );
}
