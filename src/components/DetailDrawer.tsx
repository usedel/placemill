import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  App as AntdApp,
  Button,
  Descriptions,
  Dropdown,
  Drawer,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  AimOutlined,
  DownloadOutlined,
  DownOutlined,
  ExportOutlined,
  GlobalOutlined,
  PlusOutlined,
  StarFilled,
  SyncOutlined,
  UpOutlined,
} from '@ant-design/icons';
import type { Business } from '../types/business';
import type { Review } from '../types/review';
import { useI18n } from '../i18n';
import { linkLabel, safeHttpUrl } from '../lib/url';
import { typeLabel } from '../lib/text';
import { paneBusyMessageKey } from '../lib/busy';

const { Text, Link } = Typography;

/** Covers the Rust sequence (4.5 s + 3 s + 4 s) plus a slow cold load. */
const REVIEW_FETCH_TIMEOUT_MS = 15_000;

interface Props {
  business: Business | null;
  onClose: () => void;
  onLocate: (business: Business) => void;
  /** 1-based position of `business` inside the current result set. */
  position: number;
  /** Size of the current result set; 0 before the first page lands. */
  total: number;
  onPrev: () => void;
  onNext: () => void;
  /** Close the drawer and filter the table down to a single type. */
  onSelectType: (type: string) => void;
  /** A task owns the map, so locating would fight the runner. */
  locateBlocked?: boolean;
  /** Display name of the task owning the map, when one runs (A2: the reviews
   * button says so before the click instead of after). */
  mapBusyName?: string | null;
  /** Reports the reviews fetch to the panel (C-01): while it runs the maps pane
   * is owned by the fetch thread, so the toolbar's pane actions must disable. */
  onReviewsBusyChange?: (busy: boolean) => void;
}

/** True when the event target is a text field, where arrows must edit, not navigate. */
function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return (
    element.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ||
    !!element.closest('.ant-select')
  );
}

export default function DetailDrawer({
  business,
  onClose,
  onLocate,
  position,
  total,
  onPrev,
  onNext,
  onSelectType,
  locateBlocked = false,
  mapBusyName = null,
  onReviewsBusyChange,
}: Props) {
  const { t, tag } = useI18n();

  // R-24: a scraped website is untrusted. Only an http(s) URL may become a
  // link; anything else is shown as inert text so `javascript:` can never run.
  const websiteUrl = safeHttpUrl(business?.website);
  const websiteLabel = linkLabel(business?.website, websiteUrl);

  // A fixed 400px drawer covers the panel at its narrow widths (26% of 1440px
  // is ~374px), so it shrinks with the panel instead of spilling onto the map.
  const width = Math.max(260, Math.min(400, window.innerWidth - 24));

  // UI-05: the arrows walk the result set while the drawer is open. The bounds
  // disable the buttons (no wrap-around), and a text field keeps its arrows.
  // `position` is 0 only when the row aged off the page mid-session, in which
  // case both directions are off rather than pointing at a guessed neighbour.
  const canPrev = position > 1;
  const canNext = position > 0 && position < total;

  // The panel element, so the key handler can tell "the drawer has focus"
  // from "an overlay stacked on top of it does".
  const panelRef = useRef<HTMLDivElement>(null);

  // M9: the business's reviews. Loaded on open, refreshed when the fetch
  // command reports back through the `reviews:updated` event.
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [reviewsFetching, setReviewsFetching] = useState(false);
  const [reviewsExporting, setReviewsExporting] = useState(false);
  const { message } = AntdApp.useApp();
  const placeId = business?.place_id || '';

  // C-01: while the fetch runs, the Rust side owns the maps pane for the whole
  // timed sequence, so every other pane action must disable — the panel has to
  // know. The ref mirrors the state for the timeout below: `setState` alone is
  // read a render later, and a stale `true` there would warn after success.
  const reviewsFetchingRef = useRef(false);
  const setFetching = useCallback((busy: boolean) => {
    reviewsFetchingRef.current = busy;
    setReviewsFetching(busy);
  }, []);

  useEffect(() => {
    onReviewsBusyChange?.(reviewsFetching);
  }, [reviewsFetching, onReviewsBusyChange]);

  // P2-5: only the answer to the *current* request may reach the table. A fast
  // walk through the list (or a slow read for the previous business) used to let
  // the older response win and show another place's reviews under this one.
  const reviewsRequestRef = useRef(0);

  const loadReviews = useCallback(async (pid: string) => {
    const request = ++reviewsRequestRef.current;
    if (!pid) {
      setReviews([]);
      return;
    }
    setReviewsLoading(true);
    try {
      const rows = await invoke<Review[]>('get_business_reviews', { placeId: pid });
      if (request === reviewsRequestRef.current) setReviews(rows);
    } catch {
      // A failed read leaves the drawer empty rather than crashing it; the
      // diagnostics drawer carries the error.
      if (request === reviewsRequestRef.current) setReviews([]);
    } finally {
      if (request === reviewsRequestRef.current) setReviewsLoading(false);
    }
  }, []);

  useEffect(() => {
    setReviews([]);
    void loadReviews(placeId);
  }, [placeId, loadReviews]);

  // The subscription is registered once and reads the current place through a
  // ref: depending on `placeId` rebuilt it on every selection and the async
  // cleanup could leave the old closure listening, so one event fired twice
  // (P2-5). It is registered even with no place selected — the drawer can be
  // closed while a fetch is in flight, and this event is what releases the busy
  // state the whole panel waits on (C-01).
  const placeIdRef = useRef(placeId);
  useEffect(() => {
    placeIdRef.current = placeId;
  }, [placeId]);

  useEffect(() => {
    const unlisten = listen<{ placeId: string }>('reviews:updated', (event) => {
      // The slot is released once the sequence ends, whichever place it ended
      // on: an event for another business still means this fetch is over, so
      // the spinner must stop even though that table is not reloaded.
      setFetching(false);
      const current = placeIdRef.current;
      if (current && event.payload.placeId === current) void loadReviews(current);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [loadReviews, setFetching]);

  const fetchReviews = async () => {
    if (!placeId || reviewsFetchingRef.current) return;
    setFetching(true);
    try {
      await invoke('fetch_business_reviews', { placeId });
    } catch (error) {
      // A failed request used to die silently — the user clicked and nothing
      // happened. The toast is the only visible surface the drawer owns. Every
      // pane refusal is translated (C-10); anything unknown stays raw.
      const busyKey = paneBusyMessageKey(error);
      message.error(
        busyKey ? t(busyKey) : t('toast.reviewsFetchFailed', { error: String(error) }),
      );
      setFetching(false);
      return;
    }
    // The command only *requests* the fetch: the sequence needs ~11.5 s
    // (4.5 s load + 3 s reviews tab + 4 s retry), and the retry is the last
    // thing that can still land. If no event arrives, stop the spinner and say
    // so instead of spinning — and staying disabled — for 20 s.
    window.setTimeout(() => {
      if (!reviewsFetchingRef.current) return;
      setFetching(false);
      message.warning(t('toast.reviewsFetchTimeout'));
    }, REVIEW_FETCH_TIMEOUT_MS);
  };

  const exportReviews = async (format: 'csv' | 'excel') => {
    if (!placeId || reviewsExporting) return;
    setReviewsExporting(true);
    try {
      await invoke<string | null>(
        format === 'excel' ? 'export_reviews_excel' : 'export_reviews_csv',
        { placeId, fileName: null, saveAs: false },
      );
    } catch (error) {
      message.error(
        error === 'nothing_to_export'
          ? t('detail.noReviews')
          : t('toast.exportFailed', { error: String(error) }),
      );
    } finally {
      setReviewsExporting(false);
    }
  };

  // Bounds and handlers change identity as the user navigates; the window
  // listener must not re-subscribe on each of those, so it reads them from a
  // ref refreshed after every render.
  const navRef = useRef({ canPrev, canNext, onPrev, onNext });
  useEffect(() => {
    navRef.current = { canPrev, canNext, onPrev, onNext };
  });

  useEffect(() => {
    if (!business) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      // Only when the drawer itself holds focus: with the settings drawer,
      // the shortcuts dialog or the grid dialog open on top, the arrows
      // belong to that overlay, not to the drawer behind it.
      const target = event.target as Node | null;
      if (!target || !panelRef.current?.contains(target)) return;
      if (isTypingTarget(target)) return;
      const nav = navRef.current;
      if (event.key === 'ArrowUp') {
        // At the bound the key is left alone (the drawer body may scroll).
        if (!nav.canPrev) return;
        event.preventDefault();
        nav.onPrev();
      }
      if (!nav.canNext) return;
      event.preventDefault();
      nav.onNext();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [business]);

  return (
    <Drawer
      open={!!business}
      onClose={onClose}
      panelRef={panelRef}
      width={width}
      title={
        business ? (
          <div className="detail-title">
            <span>{business.name}</span>
            {business.rating > 0 && (
              <span className="rating-cell" style={{ fontSize: 12 }}>
                <StarFilled />
                {business.rating.toFixed(1)}
              </span>
            )}
          </div>
        ) : null
      }
      extra={
        business && position > 0 ? (
          <div className="detail-nav">
            <span className="detail-nav-count">
              {t('detail.position', { current: position, total })}
            </span>
            <Tooltip title={t('detail.prev')}>
              <Button
                size="small"
                type="text"
                icon={<UpOutlined />}
                disabled={!canPrev}
                aria-label={t('detail.prev')}
                onClick={onPrev}
              />
            </Tooltip>
            <Tooltip title={t('detail.next')}>
              <Button
                size="small"
                type="text"
                icon={<DownOutlined />}
                disabled={!canNext}
                aria-label={t('detail.next')}
                onClick={onNext}
              />
            </Tooltip>
          </div>
        ) : null
      }
    >
      {business && (
        <Space direction="vertical" size={18} style={{ width: '100%' }}>
          <div className="detail-actions">
            <Button
              type="primary"
              icon={<AimOutlined />}
              disabled={locateBlocked}
              title={locateBlocked ? t('toast.locateBlocked') : undefined}
              onClick={() => onLocate(business)}
            >
              {t('detail.locate')}
            </Button>
            {websiteUrl && (
              <Button
                icon={<GlobalOutlined />}
                href={websiteUrl}
                target="_blank"
                rel="noreferrer"
              >
                {t('detail.openWebsite')}
              </Button>
            )}
            {business.place_id && (
              <Button
                icon={<ExportOutlined />}
                href={`https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(
                  business.place_id,
                )}`}
                target="_blank"
              >
                {t('detail.openInMaps')}
              </Button>
            )}
          </div>

          <Descriptions column={1} size="small" colon={false} bordered>
            <Descriptions.Item label={t('detail.reviews')}>
              {business.reviews_total > 0
                ? business.reviews_total.toLocaleString(tag)
                : t('common.dash')}
            </Descriptions.Item>
            <Descriptions.Item label={t('detail.phone')}>
              {business.phone ? (
                <Text copyable>{business.phone}</Text>
              ) : (
                <Text type="secondary">{t('common.dash')}</Text>
              )}
            </Descriptions.Item>
            <Descriptions.Item label={t('detail.address')}>
              {business.address || <Text type="secondary">{t('common.dash')}</Text>}
            </Descriptions.Item>
            <Descriptions.Item label={t('detail.website')}>
              {websiteUrl ? (
                <Link href={websiteUrl} target="_blank">
                  {websiteLabel}
                </Link>
              ) : business.website ? (
                // R-24: a non-http value is still shown, just not clickable.
                <Text>{business.website}</Text>
              ) : (
                <Text type="secondary">{t('common.dash')}</Text>
              )}
            </Descriptions.Item>
            <Descriptions.Item label={t('detail.coordinates')}>
              {business.lat || business.lng ? (
                <Text copyable>
                  {business.lat.toFixed(6)}, {business.lng.toFixed(6)}
                </Text>
              ) : (
                <Text type="secondary">{t('common.dash')}</Text>
              )}
            </Descriptions.Item>
            <Descriptions.Item label={t('detail.types')}>
              {business.types.length > 0 ? (
                <div className="detail-types">
                  {business.types.map((type) => (
                    <Tag
                      key={type}
                      color="blue"
                      className="detail-type-tag"
                      role="button"
                      tabIndex={0}
                      title={t('detail.filterByType')}
                      onClick={() => onSelectType(type)}
                      onKeyDown={(event) => {
                        // A tag is not a button; Enter/Space must activate it
                        // like one (the ↑/↓ handler above owns the arrows).
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onSelectType(type);
                        }
                      }}
                    >
                      {typeLabel(type)}
                      <PlusOutlined className="detail-type-add" />
                    </Tag>
                  ))}
                </div>
              ) : (
                <Text type="secondary">{t('common.dash')}</Text>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="place_id">
              <Text type="secondary" style={{ fontSize: 11 }} copyable>
                {business.place_id}
              </Text>
            </Descriptions.Item>
          </Descriptions>

          {/* Tier-2 detail enrichment: only rendered when the runner has
              filled something — never-enriched rows keep the drawer unchanged. */}
          {(business.plus_code ||
            business.description ||
            business.reviews_per_rating.length > 0 ||
            business.photos.length > 0) && (
            <>
              <div style={{ margin: '12px 0 4px' }}>
                <Text strong>{t('detail.enrichedTitle')}</Text>
              </div>
              <Descriptions column={1} size="small" colon={false} bordered>
                {business.plus_code && (
                  <Descriptions.Item label={t('detail.plusCode')}>
                    <Text copyable>{business.plus_code}</Text>
                  </Descriptions.Item>
                )}
                {business.description && (
                  <Descriptions.Item label={t('detail.description')}>
                    {business.description}
                  </Descriptions.Item>
                )}
                {business.reviews_per_rating.length > 0 && (
                  <Descriptions.Item label={t('detail.ratingDistribution')}>
                    <span>
                      {business.reviews_per_rating
                        .map((count, index) => `${5 - index}★: ${count.toLocaleString(tag)}`)
                        .join(' · ')}
                    </span>
                  </Descriptions.Item>
                )}
                {business.photos.length > 0 && (
                  <Descriptions.Item label={t('detail.photos')}>
                    <span>
                      {t('detail.photoCount', { count: business.photos.length })}{' '}
                      {safeHttpUrl(business.photos[0]) && (
                        <Link href={safeHttpUrl(business.photos[0])!} target="_blank">
                          {t('detail.photoFirst')}
                        </Link>
                      )}
                    </span>
                  </Descriptions.Item>
                )}
              </Descriptions>
            </>
          )}

          {business.place_id && (
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 8,
                }}
              >
                <Text strong>{t('detail.reviewsTitle', { count: reviews.length })}</Text>
                <Space size={4}>
                  <Tooltip
                    title={
                      mapBusyName
                        ? t('detail.reviewsBlockedByJob', { name: mapBusyName })
                        : reviewsFetching
                          ? t('detail.reviewsFetching')
                          : undefined
                    }
                  >
                    <Button
                      size="small"
                      icon={<SyncOutlined spin={reviewsFetching} />}
                      // A2: the button knows the map is busy — say so before the
                      // click instead of translating an error after it.
                      disabled={reviewsFetching || Boolean(mapBusyName)}
                      onClick={fetchReviews}
                    >
                      {t('detail.fetchReviews')}
                    </Button>
                  </Tooltip>
                  <Dropdown
                    menu={{
                      items: [
                        { key: 'csv', label: t('detail.exportReviewsCsv') },
                        { key: 'excel', label: t('detail.exportReviewsExcel') },
                      ],
                      onClick: ({ key }) => void exportReviews(key as 'csv' | 'excel'),
                    }}
                    disabled={reviews.length === 0 || reviewsExporting}
                  >
                    <Button size="small" icon={<DownloadOutlined />}>
                      {t('detail.exportReviews')}
                    </Button>
                  </Dropdown>
                </Space>
              </div>
              {reviewsLoading ? (
                <Text type="secondary">{t('common.dash')}</Text>
              ) : reviews.length === 0 ? (
                <Text type="secondary">{t('detail.noReviews')}</Text>
              ) : (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  {reviews.map((review) => (
                    <div key={review.review_id} className="detail-review">
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <Text strong style={{ fontSize: 13 }}>
                          {review.author || t('common.dash')}
                        </Text>
                        {review.stars > 0 && (
                          <span className="rating-cell" style={{ fontSize: 12 }}>
                            <StarFilled />
                            {review.stars}
                          </span>
                        )}
                      </div>
                      {review.relative_time && (
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {review.relative_time}
                        </Text>
                      )}
                      {review.text && <div style={{ fontSize: 13 }}>{review.text}</div>}
                      {review.owner_reply && (
                        <div
                          style={{
                            marginTop: 6,
                            padding: '6px 8px',
                            background: 'rgba(128, 128, 128, 0.08)',
                            borderRadius: 6,
                          }}
                        >
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {t('detail.ownerReply')}
                          </Text>
                          <div style={{ fontSize: 12 }}>{review.owner_reply}</div>
                        </div>
                      )}
                    </div>
                  ))}
                </Space>
              )}
            </div>
          )}
        </Space>
      )}
    </Drawer>
  );
}
