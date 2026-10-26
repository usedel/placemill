import { Button, Checkbox, Input, Select, Tooltip } from 'antd';
import type { InputRef } from 'antd';
import { ClearOutlined, SearchOutlined } from '@ant-design/icons';
import type { RefObject } from 'react';
import { useT } from '../i18n';
import type { Job } from '../types/job';

/** `all`, a job id, or `__none__` for rows no job has observed (T-02). */
export type TaskFilter = string;

export type RatingFilter = 'all' | '45' | '40' | '30' | 'none';
export type ContactFilter = 'all' | 'phone' | 'website' | 'both';
/** Time dimension over `collected_at` (UI-03). */
export type TimeRange = 'all' | 'session' | 'today' | '7d';

interface Props {
  query: string;
  rating: RatingFilter;
  contact: ContactFilter;
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
  onQuery: (value: string) => void;
  onRating: (value: RatingFilter) => void;
  onContact: (value: ContactFilter) => void;
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
  timeRange,
  typeOptions,
  types,
  tasks,
  taskFilter,
  showOnlyNew,
  onlyNew,
  hasFilters,
  searchRef,
  onQuery,
  onRating,
  onContact,
  onTimeRange,
  onTypes,
  onTaskFilter,
  onOnlyNew,
  onReset,
}: Props) {
  const t = useT();

  // The task dimension comes first: with several jobs in the database it is the
  // filter that removes the most rows, and "unassigned" is the only way to
  // reach rows collected before tasks were the entry point.
  const taskOptions = [
    { value: 'all', label: t('filters.taskAll') },
    ...tasks.map((job) => ({ value: job.id, label: job.name || job.keyword })),
    { value: '__none__', label: t('filters.taskUnassigned') },
  ];

  return (
    <div className="filter-bar">
      <Select<TaskFilter>
        size="middle"
        showSearch
        optionFilterProp="label"
        popupMatchSelectWidth={280}
        style={{ width: 168 }}
        value={taskFilter}
        onChange={onTaskFilter}
        options={taskOptions}
        aria-label={t('filters.taskLabel')}
      />

      {showOnlyNew && (
        <Checkbox checked={onlyNew} onChange={(event) => onOnlyNew(event.target.checked)}>
          {t('filters.onlyNew')}
        </Checkbox>
      )}

      {/* The placeholder used to double as a result counter: as soon as the user
          typed, the counter became invisible. The count lives in the toolbar
          above the table, where it stays readable. */}
      <Input
        ref={searchRef}
        // Stable hook for the e2e suite: the task picker is also an <input>.
        className="filter-search"
        allowClear
        size="middle"
        prefix={<SearchOutlined style={{ opacity: 0.45 }} />}
        placeholder={t('filters.searchPlaceholder')}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        style={{ flex: '1 1 140px', minWidth: 120 }}
      />

      <Select<TimeRange>
        size="middle"
        style={{ width: 112 }}
        value={timeRange}
        onChange={onTimeRange}
        options={[
          { value: 'all', label: t('filters.timeAll') },
          { value: 'session', label: t('filters.timeSession') },
          { value: 'today', label: t('filters.timeToday') },
          { value: '7d', label: t('filters.time7d') },
        ]}
      />

      <Select<RatingFilter>
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

      <Select<ContactFilter>
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

      <Select
        mode="multiple"
        size="middle"
        allowClear
        maxTagCount={1}
        placeholder={t('filters.typesPlaceholder')}
        value={types}
        onChange={onTypes}
        options={typeOptions.map((type) => ({ value: type, label: type }))}
        style={{ minWidth: 96, maxWidth: 160 }}
      />

      {hasFilters && (
        <Tooltip title={t('filters.clear')}>
          <Button size="middle" icon={<ClearOutlined />} onClick={onReset} />
        </Tooltip>
      )}
    </div>
  );
}
