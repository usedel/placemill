import { Badge, Button, Checkbox, Drawer, Input, Select, Tooltip } from 'antd';
import type { InputRef } from 'antd';
import { ClearOutlined, FilterOutlined, SearchOutlined } from '@ant-design/icons';
import { useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { useT } from '../i18n';
import type { Job } from '../types/job';

/** `all`, a job id, or `__none__` for rows no job has observed (T-02). */
export type TaskFilter = string;

export type RatingFilter = 'all' | '45' | '40' | '30' | 'none';
export type ContactFilter = 'all' | 'phone' | 'website' | 'both';
/** Deliverability dimension (G-04). */
export type VerifyFilter = 'all' | 'valid' | 'usable' | 'invalid' | 'unverified';
/** Time dimension over `collected_at` (UI-03). */
export type TimeRange = 'all' | 'session' | 'today' | '7d';

interface Props {
  query: string;
  rating: RatingFilter;
  contact: ContactFilter;
  verify: VerifyFilter;
  timeRange: TimeRange;
  typeOptions: string[];
  types: string[];
  tasks: Job[];
  taskFilter: TaskFilter;
  /** P2: a pinned task that has been exported can be narrowed to new rows. */
  showOnlyNew: boolean;
  onlyNew: boolean;
  hasFilters: boolean;
  searchRef?: RefObject<InputRef>;
  /**
   * UI-14. `inline` is the six-control row; `sheet` keeps the search field and
   * moves everything else into a bottom sheet, which is the only way five
   * selects fit a 374px panel without clipping.
   */
  variant?: 'inline' | 'sheet';
  onQuery: (value: string) => void;
  onRating: (value: RatingFilter) => void;
  onContact: (value: ContactFilter) => void;
  onVerify: (value: VerifyFilter) => void;
  onTimeRange: (value: TimeRange) => void;
  onTypes: (value: string[]) => void;
  onTaskFilter: (value: TaskFilter) => void;
  onOnlyNew: (value: boolean) => void;
  onReset: () => void;
}

export default function FilterBar({
  query,
  rating,
  contact,
  verify,
  timeRange,
  typeOptions,
  types,
  tasks,
  taskFilter,
  showOnlyNew,
  onlyNew,
  hasFilters,
  searchRef,
  variant = 'inline',
  onQuery,
  onRating,
  onContact,
  onVerify,
  onTimeRange,
  onTypes,
  onTaskFilter,
  onOnlyNew,
  onReset,
}: Props) {
  const t = useT();
  const [sheetOpen, setSheetOpen] = useState(false);

  // The task dimension comes first: with several jobs in the database it is the
  // filter that removes the most rows, and "unassigned" is the only way to
  // reach rows collected before tasks were the entry point.
  const taskOptions = [
    { value: 'all', label: t('filters.taskAll') },
    ...tasks.map((job) => ({ value: job.id, label: job.name || job.keyword })),
    { value: '__none__', label: t('filters.taskUnassigned') },
  ];

  // What the sheet is hiding. The search box is always visible, so it does not
  // count — the badge is for the controls behind the trigger.
  const hiddenActive = [
    taskFilter !== 'all',
    timeRange !== 'all',
    rating !== 'all',
    contact !== 'all',
    verify !== 'all',
    types.length > 0,
    showOnlyNew && onlyNew,
  ].filter(Boolean).length;

  const searchInput = (
    <Input
      ref={searchRef}
      // Stable hook for the e2e suite: the task picker is also an `<input>`.
      className="filter-search"
      allowClear
      size="middle"
      prefix={<SearchOutlined style={{ opacity: 0.45 }} />}
      placeholder={t('filters.searchPlaceholder')}
      value={query}
      onChange={(event) => onQuery(event.target.value)}
    />
  );

  const taskSelect = (
    <Select<TaskFilter>
      className="filter-task"
      size="middle"
      showSearch
      optionFilterProp="label"
      popupMatchSelectWidth={280}
      value={taskFilter}
      onChange={onTaskFilter}
      options={taskOptions}
      aria-label={t('filters.taskLabel')}
    />
  );

  const timeSelect = (
    <Select<TimeRange>
      className="filter-time"
      size="middle"
      value={timeRange}
      onChange={onTimeRange}
      options={[
        { value: 'all', label: t('filters.timeAll') },
        { value: 'session', label: t('filters.timeSession') },
        { value: 'today', label: t('filters.timeToday') },
        { value: '7d', label: t('filters.time7d') },
      ]}
    />
  );

  const ratingSelect = (
    <Select<RatingFilter>
      className="filter-rating"
      size="middle"
      value={rating}
      onChange={onRating}
      options={[
        { value: 'all', label: t('filters.ratingAll') },
        { value: '45', label: t('filters.rating45') },
        { value: '40', label: t('filters.rating40') },
        { value: '30', label: t('filters.rating30') },
        { value: 'none', label: t('filters.ratingNone') },
      ]}
    />
  );

  const contactSelect = (
    <Select<ContactFilter>
      className="filter-contact"
      size="middle"
      value={contact}
      onChange={onContact}
      options={[
        { value: 'all', label: t('filters.contactAll') },
        { value: 'phone', label: t('filters.contactPhone') },
        { value: 'website', label: t('filters.contactWebsite') },
        { value: 'both', label: t('filters.contactBoth') },
      ]}
    />
  );

  const verifySelect = (
    <Select<VerifyFilter>
      className="filter-verify"
      size="middle"
      value={verify}
      onChange={onVerify}
      aria-label={t('filters.verifyAll')}
      options={[
        { value: 'all', label: t('filters.verifyAll') },
        { value: 'valid', label: t('filters.verifyValid') },
        { value: 'usable', label: t('filters.verifyUsable') },
        { value: 'invalid', label: t('filters.verifyInvalid') },
        { value: 'unverified', label: t('filters.verifyUnverified') },
      ]}
    />
  );

  const typesSelect = (
    <Select
      className="filter-types"
      mode="multiple"
      size="middle"
      allowClear
      maxTagCount={1}
      placeholder={t('filters.typesPlaceholder')}
      value={types}
      onChange={onTypes}
      options={typeOptions.map((type) => ({ value: type, label: type }))}
    />
  );

  const onlyNewBox = showOnlyNew ? (
    <Checkbox checked={onlyNew} onChange={(event) => onOnlyNew(event.target.checked)}>
      {t('filters.onlyNew')}
    </Checkbox>
  ) : null;

  const clearButton = hasFilters ? (
    <Tooltip title={t('filters.clear')}>
      <Button size="middle" icon={<ClearOutlined />} onClick={onReset} />
    </Tooltip>
  ) : null;

  const controls: ReactNode[] = [
    taskSelect,
    timeSelect,
    ratingSelect,
    contactSelect,
    verifySelect,
    typesSelect,
  ];

  if (variant === 'sheet') {
    return (
      <div className="filter-bar">
        {searchInput}
        <Button
          className="filter-trigger"
          size="middle"
          icon={<FilterOutlined />}
          onClick={() => setSheetOpen(true)}
          aria-label={t('filters.open')}
        >
          <span className="toolbar-label">{t('filters.open')}</span>
          <Badge count={hiddenActive} size="small" />
        </Button>

        <Drawer
          placement="bottom"
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          title={t('filters.sheetTitle')}
          footer={null}
        >
          <div className="filter-sheet">
            {controls}
            {onlyNewBox}
            <div className="filter-sheet-footer">
              <Button onClick={onReset} disabled={!hasFilters}>
                {t('filters.clear')}
              </Button>
              <Button type="primary" onClick={() => setSheetOpen(false)}>
                {t('filters.apply')}
              </Button>
            </div>
          </div>
        </Drawer>
      </div>
    );
  }

  return (
    <div className="filter-bar">
      {taskSelect}
      {onlyNewBox}
      {/* The placeholder used to double as a result counter: as soon as the user
          typed, the counter became invisible. The count lives in the toolbar
          above the table, where it stays readable. */}
      {searchInput}
      {timeSelect}
      {ratingSelect}
      {contactSelect}
      {verifySelect}
      {typesSelect}
      {clearButton}
    </div>
  );
}
