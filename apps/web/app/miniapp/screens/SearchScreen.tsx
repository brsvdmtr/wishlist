// Global search screen — opened from the 🔍 button on the home header.
//
// Self-contained: state lives inside the component, navigation flows out
// through callback props supplied by MiniApp.tsx. The design follows
// `docs/design-system/mockups/proposed/global-search.html` (approved
// 2026-05-16) — v2.1 tokens via CSS variables, glass surfaces, accent
// violet, RU-first copy.
//
// Privacy invariants:
//   - The raw query never leaves this component for analytics; only the
//     query length + types of returned groups go to trackEvent.
//   - Restricted / expired / pro_required results render with safe copy
//     (no titles or owners leak through accessState branches).

'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { t, type Locale } from '@wishlist/shared';
import {
  fetchSearch,
  SEARCH_MAX_QUERY,
  SEARCH_MIN_QUERY,
  type SearchResponse,
  type SearchResult,
  type SearchResultType,
  type SearchResultTarget,
} from '../lib/searchApi';
import {
  clearRecentSearches,
  getRecentSearches,
  pushRecentSearch,
  removeRecentSearch,
} from '../lib/searchRecent';

const DEBOUNCE_MS = 280;
const MIN_QUERY = SEARCH_MIN_QUERY;

type TgFetch = (
  path: string,
  init?: RequestInit & {
    timeoutMs?: number;
    _retried?: boolean;
    idempotency?: string | { action: string };
  },
) => Promise<Response>;

export interface SearchScreenProps {
  locale: Locale;
  isPro: boolean;
  tgFetch: TgFetch;
  onBack: () => void;
  onResultClick: (result: SearchResult) => void;
  onOpenPaywall: () => void;
  pushToast: (msg: string, kind: 'warning' | 'info' | 'error' | 'success') => void;
  haptic?: (kind: 'light' | 'medium') => void;
  trackEvent?: (event: string, props?: Record<string, unknown>) => void;
}

type FilterType = 'all' | SearchResultType;

const FILTER_OPTIONS: { type: FilterType; emoji: string; key: string }[] = [
  { type: 'all', emoji: '', key: 'search_filters_all' },
  { type: 'item', emoji: '🎁', key: 'search_filters_items' },
  { type: 'wishlist', emoji: '📋', key: 'search_filters_wishlists' },
  { type: 'reservation', emoji: '🤝', key: 'search_filters_reservations' },
  { type: 'user', emoji: '👥', key: 'search_filters_people' },
  { type: 'category', emoji: '🏷', key: 'search_filters_categories' },
  { type: 'event', emoji: '📅', key: 'search_filters_events' },
  { type: 'setting', emoji: '⚙', key: 'search_filters_settings' },
];

// Per-filter smart chips. Empty arrays = no smart chips for that filter.
const SMART_CHIPS: Partial<Record<FilterType, { id: string; labelRu: string; labelEn: string; requiresPro?: boolean }[]>> = {
  item: [
    { id: 'available', labelRu: 'Доступные', labelEn: 'Available' },
    { id: 'with-price', labelRu: 'С ценой', labelEn: 'With price' },
    { id: 'no-price', labelRu: 'Без цены', labelEn: 'No price' },
    { id: 'high-prio', labelRu: 'Важные', labelEn: 'High priority' },
    { id: 'with-link', labelRu: 'С ссылкой', labelEn: 'With link' },
    { id: 'archive', labelRu: 'Архив', labelEn: 'Archive' },
  ],
  reservation: [
    { id: 'mine', labelRu: 'Мои', labelEn: 'Mine' },
    { id: 'soon', labelRu: 'Истекают скоро', labelEn: 'Expiring soon', requiresPro: true },
    { id: 'secret', labelRu: 'Тайные', labelEn: 'Secret', requiresPro: true },
    { id: 'regular', labelRu: 'Обычные', labelEn: 'Regular' },
  ],
  wishlist: [
    { id: 'mine', labelRu: 'Мои', labelEn: 'Mine' },
    { id: 'subscribed', labelRu: 'Подписки', labelEn: 'Subscriptions' },
  ],
};

const PAYWALL_TRIGGERED_TYPES: SearchResultType[] = ['reservation', 'event', 'anti_gift'];

export function SearchScreen(props: SearchScreenProps): React.JSX.Element {
  const { locale, isPro, tgFetch, onBack, onResultClick, onOpenPaywall, pushToast, haptic, trackEvent } = props;

  const [query, setQuery] = useState<string>('');
  const [filter, setFilter] = useState<FilterType>('all');
  const [smartFilters, setSmartFilters] = useState<Set<string>>(new Set());
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<'fetch' | 'rate_limit' | null>(null);
  const [recents, setRecents] = useState<string[]>(() => getRecentSearches(isPro));

  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQueryRef = useRef<string>('');

  // Track opened analytics event once per screen mount.
  useEffect(() => {
    try { trackEvent?.('search.opened', { isProUser: isPro, locale }); } catch { /* noop */ }
    // Refresh recents in case the PRO status changed since first mount.
    setRecents(getRecentSearches(isPro));
    // Focus input next tick so the keyboard pops up.
    const timer = setTimeout(() => inputRef.current?.focus(), 30);
    return () => {
      clearTimeout(timer);
      try { trackEvent?.('search.closed'); } catch { /* noop */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-cap recents when PRO status flips mid-session.
  useEffect(() => {
    setRecents(getRecentSearches(isPro));
  }, [isPro]);

  const runSearch = useCallback(async (q: string, currentFilter: FilterType) => {
    const trimmed = q.trim();
    if (trimmed.length < MIN_QUERY) {
      setResponse(null);
      setLoading(false);
      setError(null);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    lastQueryRef.current = trimmed;
    try { trackEvent?.('search.query_started', { queryLength: trimmed.length, selectedType: currentFilter }); } catch { /* noop */ }
    try {
      const types: SearchResultType[] | undefined =
        currentFilter === 'all' ? undefined : [currentFilter];
      const res = await fetchSearch(tgFetch, {
        q: trimmed,
        types,
        signal: controller.signal,
      });
      // Discard if a newer query already started — guarantees no out-of-order render.
      if (controller.signal.aborted || lastQueryRef.current !== trimmed) return;
      setResponse(res);
      setLoading(false);
      const wasEmpty = res.groups.every((g) => g.items.length === 0);
      if (wasEmpty) {
        try { trackEvent?.('search.empty_shown', { queryLength: trimmed.length, locale }); } catch { /* noop */ }
      }
      if (res.groups.some((g) => g.type === 'pro_locked')) {
        try { trackEvent?.('search.paywall_shown'); } catch { /* noop */ }
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      const msg = e instanceof Error ? e.message : '';
      const isRate = msg.includes('429');
      setError(isRate ? 'rate_limit' : 'fetch');
      setLoading(false);
      try { trackEvent?.('search.query_failed', { reason: msg.slice(0, 64) }); } catch { /* noop */ }
    }
  }, [tgFetch, trackEvent]);

  // Debounced effect on query/filter change.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY) {
      abortRef.current?.abort();
      setResponse(null);
      setLoading(false);
      setError(null);
      return;
    }
    debounceRef.current = setTimeout(() => {
      void runSearch(trimmed, filter);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, filter, runSearch]);

  const handleClear = useCallback(() => {
    setQuery('');
    setResponse(null);
    setError(null);
    inputRef.current?.focus();
    try { trackEvent?.('search.clear_clicked'); } catch { /* noop */ }
  }, [trackEvent]);

  const handleFilterChange = useCallback((next: FilterType) => {
    if (next === filter) return;
    setFilter(next);
    setSmartFilters(new Set()); // smart chips are filter-scoped
    haptic?.('light');
    try { trackEvent?.('search.filter_changed', { selectedType: next }); } catch { /* noop */ }
  }, [filter, haptic, trackEvent]);

  const handleSmartToggle = useCallback((id: string) => {
    setSmartFilters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    haptic?.('light');
  }, [haptic]);

  const handleResultClick = useCallback((r: SearchResult) => {
    if (r.accessState === 'restricted' || r.accessState === 'expired') {
      pushToast(t('search_no_access_to_result', locale), 'info');
      return;
    }
    if (r.type === 'pro_locked' || r.accessState === 'pro_required') {
      try { trackEvent?.('search.paywall_cta_clicked'); } catch { /* noop */ }
      onOpenPaywall();
      return;
    }
    // Push to recents only on user-initiated result click. Use the live query.
    pushRecentSearch(query);
    setRecents(getRecentSearches(isPro));
    try {
      trackEvent?.('search.result_clicked', {
        selectedResultType: r.type,
        accessState: r.accessState,
        ownRow: r.ownerUserId === null,
      });
    } catch { /* noop */ }
    haptic?.('light');
    onResultClick(r);
  }, [haptic, isPro, locale, onOpenPaywall, onResultClick, pushToast, query, trackEvent]);

  const handleRecentClick = useCallback((q: string) => {
    setQuery(q);
    inputRef.current?.focus();
    try { trackEvent?.('search.recent_clicked', { queryLength: q.length }); } catch { /* noop */ }
  }, [trackEvent]);

  const handleClearRecents = useCallback(() => {
    clearRecentSearches();
    setRecents([]);
  }, []);

  // Apply client-side smart filters on top of the server response. We keep
  // the server response untouched (so per-group totals stay honest) and only
  // filter the rendered rows. This is intentional — adding 6+ server-side
  // parameters for the first ship would balloon the API surface.
  const visibleGroups = useMemo(() => {
    if (!response) return [];
    return response.groups.map((g) => {
      if (smartFilters.size === 0) return g;
      const filtered = g.items.filter((r) => applySmartFilters(r, smartFilters));
      return { ...g, items: filtered, total: filtered.length };
    }).filter((g) => g.items.length > 0 || g.type === 'pro_locked');
  }, [response, smartFilters]);

  const trimmed = query.trim();
  const showFirstOpen = trimmed.length === 0;
  const showShortQuery = trimmed.length > 0 && trimmed.length < MIN_QUERY;
  const showSkeleton = loading && !response;
  const showError = !!error && !loading;
  const showEmpty = !loading && !error && !!response && visibleGroups.length === 0;
  const showResults = !loading && !error && !!response && visibleGroups.length > 0;
  const smartChips = SMART_CHIPS[filter] ?? [];

  return (
    <div style={styles.root}>
      {/* Header: back button + input */}
      <div style={styles.headRow}>
        <button
          type="button"
          onClick={onBack}
          aria-label={t('back', locale)}
          style={styles.backBtn}
        >
          ‹
        </button>
        <div style={{ ...styles.inputWrap, ...(query ? styles.inputWrapFocused : null) }}>
          <span aria-hidden="true" style={styles.glassIcon}>🔍</span>
          <input
            ref={inputRef}
            type="search"
            inputMode="search"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value.slice(0, SEARCH_MAX_QUERY))}
            placeholder={t('search_placeholder', locale)}
            aria-label={t('search_title', locale)}
            style={styles.input}
          />
          {query.length > 0 && (
            <button
              type="button"
              onClick={handleClear}
              aria-label={t('search_clear', locale)}
              style={styles.clearBtn}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Filter chips */}
      <div style={styles.chipsRow}>
        {FILTER_OPTIONS.map((opt) => {
          const active = filter === opt.type;
          // Show counts when results are available.
          let count: number | null = null;
          if (response && opt.type !== 'all') {
            const group = response.groups.find((g) => g.type === opt.type);
            count = group ? group.total : null;
          } else if (response && opt.type === 'all') {
            count = response.groups.reduce((acc, g) => acc + g.items.length, 0);
          }
          return (
            <button
              type="button"
              key={opt.type}
              onClick={() => handleFilterChange(opt.type)}
              style={{ ...styles.chip, ...(active ? styles.chipActive : null) }}
            >
              {opt.emoji && <span style={{ marginRight: 4 }}>{opt.emoji}</span>}
              {t(opt.key, locale)}
              {count != null && count > 0 && <span style={styles.chipCount}>{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Smart chips (per-filter sub-row) */}
      {smartChips.length > 0 && (
        <div style={styles.smartChipsRow}>
          {smartChips.map((sc) => {
            const isActive = smartFilters.has(sc.id);
            const proLocked = sc.requiresPro && !isPro;
            return (
              <button
                type="button"
                key={sc.id}
                onClick={() => {
                  if (proLocked) {
                    onOpenPaywall();
                    return;
                  }
                  handleSmartToggle(sc.id);
                }}
                style={{ ...styles.smartChip, ...(isActive ? styles.smartChipActive : null) }}
              >
                {locale === 'ru' ? sc.labelRu : sc.labelEn}
                {sc.requiresPro && !isPro && <span style={{ marginLeft: 4, opacity: 0.7 }}>⭐</span>}
                {isActive && <span style={styles.smartChipX}>×</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* Scroll area */}
      <div style={styles.scroll}>
        {showFirstOpen && (
          <FirstOpenState
            locale={locale}
            recents={recents}
            onRecentClick={handleRecentClick}
            onRecentRemove={(q) => {
              removeRecentSearch(q);
              setRecents(getRecentSearches(isPro));
            }}
            onClearRecents={handleClearRecents}
            onOpenPaywall={onOpenPaywall}
            isPro={isPro}
          />
        )}

        {showShortQuery && <ShortQueryState locale={locale} />}

        {showSkeleton && <SkeletonResults />}

        {showError && (
          <ErrorState
            locale={locale}
            rateLimited={error === 'rate_limit'}
            onRetry={() => void runSearch(trimmed, filter)}
            onBack={onBack}
          />
        )}

        {showEmpty && <EmptyState locale={locale} onClear={handleClear} />}

        {showResults && (
          <>
            {response?.partial && (
              <div style={styles.partialBanner}>
                ⚠️ {t('search_partial_warning', locale)}
              </div>
            )}
            {visibleGroups.map((g) => (
              <ResultsGroup
                key={g.type}
                locale={locale}
                group={g}
                onResultClick={handleResultClick}
                onShowAll={() => handleFilterChange(g.type as FilterType)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

function FirstOpenState(props: {
  locale: Locale;
  recents: string[];
  onRecentClick: (q: string) => void;
  onRecentRemove: (q: string) => void;
  onClearRecents: () => void;
  onOpenPaywall: () => void;
  isPro: boolean;
}): React.JSX.Element {
  const { locale, recents, onRecentClick, onRecentRemove, onClearRecents, onOpenPaywall, isPro } = props;
  return (
    <>
      {recents.length === 0 && (
        <div style={styles.bigState}>
          <div style={{ ...styles.bigStateEmoji, background: 'var(--wb-accent-soft)' }}>🔍</div>
          <h3 style={styles.bigStateTitle}>{t('search_first_open_title', locale)}</h3>
          <p style={styles.bigStateDesc}>{t('search_first_open_desc', locale)}</p>
        </div>
      )}

      {recents.length > 0 && (
        <>
          <div style={styles.sectionHead}>
            <span style={styles.sectionLabel}>
              {t('search_recent_title', locale)} <span style={styles.sectionN}>{recents.length}</span>
            </span>
            <button type="button" onClick={onClearRecents} style={styles.sectionAction}>
              {t('search_recent_clear', locale)}
            </button>
          </div>
          <div>
            {recents.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => onRecentClick(q)}
                style={styles.recentRow}
              >
                <span style={styles.recentIcon}>🕘</span>
                <span style={styles.recentQuery}>{q}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRecentRemove(q);
                  }}
                  aria-label="Remove"
                  style={styles.recentRemove}
                >
                  ×
                </button>
              </button>
            ))}
          </div>
        </>
      )}

      <div style={styles.sectionHead}>
        <span style={styles.sectionLabel}>{t('search_quick_filters_title', locale)}</span>
      </div>
      <div style={styles.tilesGrid}>
        <button type="button" style={styles.tile} onClick={() => onRecentClick(locale === 'ru' ? 'важное' : 'important')}>
          <span style={styles.tileEm}>⭐</span>
          <span style={styles.tileLbl}>{locale === 'ru' ? 'Важные желания' : 'Important wishes'}</span>
          <span style={styles.tileHint}>priority high</span>
        </button>
        <button type="button" style={styles.tile} onClick={() => onRecentClick(locale === 'ru' ? 'http' : 'http')}>
          <span style={styles.tileEm}>🔗</span>
          <span style={styles.tileLbl}>{locale === 'ru' ? 'С ссылкой' : 'With link'}</span>
          <span style={styles.tileHint}>url</span>
        </button>
        <button type="button" style={{ ...styles.tile, ...(isPro ? null : styles.tileProMuted) }} onClick={() => isPro ? onRecentClick(locale === 'ru' ? 'бронь' : 'reservation') : onOpenPaywall()}>
          <span style={styles.tileEm}>⏱</span>
          <span style={styles.tileLbl}>{locale === 'ru' ? 'Истекают скоро' : 'Expiring soon'}</span>
          <span style={{ ...styles.tileHint, color: 'var(--wb-accent-strong)' }}>
            {isPro ? (locale === 'ru' ? 'брони' : 'reservations') : 'PRO'}
          </span>
        </button>
        <button type="button" style={{ ...styles.tile, ...(isPro ? null : styles.tileProMuted) }} onClick={() => isPro ? onRecentClick(locale === 'ru' ? 'тайные' : 'secret') : onOpenPaywall()}>
          <span style={styles.tileEm}>🤫</span>
          <span style={styles.tileLbl}>{locale === 'ru' ? 'Мои тайные' : 'My secret'}</span>
          <span style={{ ...styles.tileHint, color: 'var(--wb-accent-strong)' }}>
            {isPro ? (locale === 'ru' ? 'тайные брони' : 'secret reservations') : 'PRO'}
          </span>
        </button>
      </div>
    </>
  );
}

function ShortQueryState(props: { locale: Locale }): React.JSX.Element {
  return (
    <div style={{ ...styles.bigState, marginTop: 48 }}>
      <div style={{ ...styles.bigStateEmoji, background: 'var(--wb-surface)' }}>✏️</div>
      <h3 style={styles.bigStateTitle}>{t('search_min_query_title', props.locale)}</h3>
      <p style={styles.bigStateDesc}>{t('search_min_query_desc', props.locale)}</p>
    </div>
  );
}

function EmptyState(props: { locale: Locale; onClear: () => void }): React.JSX.Element {
  return (
    <div style={{ ...styles.bigState, marginTop: 64 }}>
      <div style={{ ...styles.bigStateEmoji, background: 'var(--wb-accent-soft)' }}>🔎</div>
      <h3 style={styles.bigStateTitle}>{t('search_empty_title', props.locale)}</h3>
      <p style={styles.bigStateDesc}>{t('search_empty_desc', props.locale)}</p>
      <div style={styles.ctaRow}>
        <button type="button" onClick={props.onClear} style={styles.btnGhost}>
          {t('search_clear', props.locale)}
        </button>
      </div>
    </div>
  );
}

function ErrorState(props: {
  locale: Locale;
  rateLimited: boolean;
  onRetry: () => void;
  onBack: () => void;
}): React.JSX.Element {
  return (
    <div style={{ ...styles.bigState, marginTop: 64 }}>
      <div style={{ ...styles.bigStateEmoji, background: 'var(--wb-danger-soft)' }}>⚠️</div>
      <h3 style={styles.bigStateTitle}>{t('search_error_title', props.locale)}</h3>
      <p style={styles.bigStateDesc}>
        {props.rateLimited
          ? t('error_rate_limited', props.locale, { sec: 30 })
          : t('search_error_desc', props.locale)}
      </p>
      <div style={styles.ctaRow}>
        <button type="button" onClick={props.onRetry} style={styles.btnPrimary}>
          {t('search_retry', props.locale)}
        </button>
        <button type="button" onClick={props.onBack} style={styles.btnGhost}>
          {t('back', props.locale)}
        </button>
      </div>
    </div>
  );
}

function SkeletonResults(): React.JSX.Element {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div key={i} style={styles.skCard}>
          <div style={{ ...styles.skThumb, ...styles.skeleton }} />
          <div style={styles.skLines}>
            <div style={{ ...styles.skLine, width: '70%', ...styles.skeleton }} />
            <div style={{ ...styles.skLine, width: '40%', ...styles.skeleton }} />
          </div>
        </div>
      ))}
    </>
  );
}

function ResultsGroup(props: {
  locale: Locale;
  group: { type: SearchResultType; title: string; total: number; items: SearchResult[]; hasMore: boolean };
  onResultClick: (r: SearchResult) => void;
  onShowAll: () => void;
}): React.JSX.Element {
  const { locale, group, onResultClick, onShowAll } = props;

  // pro_locked group renders as the paywall card.
  if (group.type === 'pro_locked' && group.items.length > 0) {
    const first = group.items[0]!;
    return (
      <ProLockedBlock
        locale={locale}
        title={first.title}
        subtitle={first.subtitle}
        onCta={() => onResultClick(first)}
      />
    );
  }

  return (
    <>
      <div style={styles.sectionHead}>
        <span style={styles.sectionLabel}>
          {group.title} <span style={styles.sectionN}>{group.total}</span>
        </span>
        {group.hasMore && (
          <button type="button" onClick={onShowAll} style={styles.sectionAction}>
            {t('search_show_all', locale)} ›
          </button>
        )}
      </div>
      {group.items.map((r) => (
        <ResultCard key={r.id} result={r} onClick={() => onResultClick(r)} />
      ))}
    </>
  );
}

function ResultCard(props: { result: SearchResult; onClick: () => void }): React.JSX.Element {
  const { result, onClick } = props;
  const restricted = result.accessState === 'restricted' || result.accessState === 'expired';

  const badgeStyle: CSSProperties = {
    ...styles.badge,
    ...(result.badgeTone === 'price' ? styles.badgePrice : null),
    ...(result.badgeTone === 'reserved' ? styles.badgeReserved : null),
    ...(result.badgeTone === 'done' ? styles.badgeDone : null),
    ...(result.badgeTone === 'secret' ? styles.badgeSecret : null),
    ...(result.badgeTone === 'pro' ? styles.badgePro : null),
    ...(result.badgeTone === 'warning' ? styles.badgeWarning : null),
    ...(result.badgeTone === 'danger' ? styles.badgeDanger : null),
  };

  return (
    <button
      type="button"
      onClick={onClick}
      style={{ ...styles.resultCard, ...(restricted ? styles.resultCardRestricted : null) }}
    >
      <div style={styles.thumb}>
        {result.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={result.thumbnailUrl} alt="" style={styles.thumbImg} />
        ) : (
          <span aria-hidden="true">{result.icon ?? '🎁'}</span>
        )}
      </div>
      <div style={styles.cardBody}>
        <div style={styles.cardTitle}>{result.title}</div>
        <div style={styles.cardSubtitle}>{result.subtitle}</div>
      </div>
      {result.badge && <span style={badgeStyle}>{result.badge}</span>}
    </button>
  );
}

function ProLockedBlock(props: { locale: Locale; title: string; subtitle: string; onCta: () => void }): React.JSX.Element {
  return (
    <div style={styles.proBlock}>
      <span style={styles.proStar}>⭐ PRO</span>
      <div style={styles.proTitle}>{t('search_paywall_title', props.locale)}</div>
      <div style={styles.proDesc}>{t('search_paywall_desc', props.locale)}</div>
      <div style={styles.proBlur}>
        <div style={{ ...styles.proBlurRow, width: '78%' }} />
        <div style={{ ...styles.proBlurRow, width: '58%' }} />
        <div style={{ ...styles.proBlurRow, width: '70%' }} />
      </div>
      <div style={styles.proActions}>
        <button type="button" onClick={props.onCta} style={styles.proPrimary}>
          {t('search_paywall_cta', props.locale)}
        </button>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function applySmartFilters(r: SearchResult, smartFilters: Set<string>): boolean {
  for (const f of smartFilters) {
    if (!matchSmartFilter(r, f)) return false;
  }
  return true;
}

/**
 * Smart-filter matchers operate on the server-emitted `meta` flags so the
 * client doesn't need to parse localised badge / subtitle text. Each
 * matcher returns true to KEEP the row.
 */
function matchSmartFilter(r: SearchResult, id: string): boolean {
  switch (id) {
    case 'available':
      if (r.type !== 'item') return true;
      return r.badgeTone !== 'reserved' && r.badgeTone !== 'done' && !r.meta.archived;
    case 'with-price':
      return r.meta.hasPrice;
    case 'no-price':
      return r.type === 'item' && !r.meta.hasPrice;
    case 'high-prio':
      return r.type !== 'item' || r.meta.priority === 'HIGH';
    case 'with-link':
      return r.type !== 'item' || r.meta.hasUrl;
    case 'archive':
      return r.meta.archived;
    case 'mine':
      return r.meta.isOwn;
    case 'soon':
      return typeof r.meta.hoursUntilExpiry === 'number' && r.meta.hoursUntilExpiry < 48;
    case 'secret':
      return r.meta.isSecretReservation;
    case 'regular':
      return r.type === 'reservation' && !r.meta.isSecretReservation;
    case 'subscribed':
      return r.type === 'wishlist' && !r.meta.isOwn;
    default:
      return true;
  }
}

// ─── Styles (inline, CSS-vars sourced from v2.1 colors_and_type.css) ───────

const styles: Record<string, CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    padding: '8px 16px 0',
    boxSizing: 'border-box',
  },
  headRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 0 12px',
  },
  backBtn: {
    width: 40,
    height: 40,
    flexShrink: 0,
    borderRadius: 14,
    background: 'var(--wb-surface)',
    border: '1px solid var(--wb-border)',
    color: 'var(--wb-text)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 24,
    fontWeight: 500,
    backdropFilter: 'blur(20px) saturate(140%)',
    WebkitBackdropFilter: 'blur(20px) saturate(140%)' as never,
    cursor: 'pointer',
  },
  inputWrap: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    height: 40,
    padding: '0 14px',
    background: 'var(--wb-card)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--wb-border)',
    borderRadius: 16,
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)' as never,
  },
  inputWrapFocused: {
    background: 'var(--wb-card-strong)',
    borderColor: 'var(--wb-accent)',
    boxShadow: '0 0 0 4px var(--wb-accent-soft)',
  },
  glassIcon: { color: 'var(--wb-text-muted)', fontSize: 15, lineHeight: 1 },
  input: {
    flex: 1,
    minWidth: 0,
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: 'var(--wb-text)',
    fontSize: 15,
    fontWeight: 500,
    letterSpacing: '-0.012em',
    fontFamily: 'inherit',
    padding: 0,
  },
  clearBtn: {
    width: 22,
    height: 22,
    borderRadius: '50%',
    background: 'var(--wb-surface-hover)',
    color: 'var(--wb-text-secondary)',
    border: 'none',
    fontSize: 14,
    lineHeight: 1,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  chipsRow: {
    display: 'flex',
    gap: 8,
    overflowX: 'auto',
    padding: '0 16px 12px',
    margin: '0 -16px',
    scrollbarWidth: 'none',
    msOverflowStyle: 'none' as never,
  },
  chip: {
    flexShrink: 0,
    height: 32,
    padding: '0 12px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    background: 'var(--wb-card)',
    border: '1px solid var(--wb-border)',
    borderRadius: 9999,
    color: 'var(--wb-text-secondary)',
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: '-0.005em',
    fontFamily: 'inherit',
    cursor: 'pointer',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)' as never,
    whiteSpace: 'nowrap',
  },
  chipActive: {
    background: 'var(--wb-accent-soft-strong)',
    borderColor: 'var(--wb-accent)',
    color: '#fff',
  },
  chipCount: {
    fontSize: 11,
    fontWeight: 700,
    opacity: 0.85,
    marginLeft: 4,
  },
  smartChipsRow: {
    display: 'flex',
    gap: 6,
    overflowX: 'auto',
    padding: '0 16px 14px',
    margin: '0 -16px',
    scrollbarWidth: 'none',
    msOverflowStyle: 'none' as never,
  },
  smartChip: {
    flexShrink: 0,
    height: 28,
    padding: '0 10px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    background: 'var(--wb-surface)',
    border: '1px solid var(--wb-border)',
    borderRadius: 9999,
    color: 'var(--wb-text-muted)',
    fontSize: 12,
    fontWeight: 550,
    fontFamily: 'inherit',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  smartChipActive: {
    background: 'var(--wb-accent-soft)',
    borderColor: 'var(--wb-accent-soft-strong)',
    color: 'var(--wb-accent-strong)',
  },
  smartChipX: { opacity: 0.7, fontSize: 11, marginLeft: 2 },
  scroll: {
    flex: 1,
    overflowY: 'auto',
    paddingBottom: 80,
    scrollbarWidth: 'none',
    msOverflowStyle: 'none' as never,
  },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    margin: '14px 4px 8px',
  },
  sectionLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.5px',
    textTransform: 'uppercase',
    color: 'var(--wb-text-muted)',
  },
  sectionN: {
    background: 'var(--wb-surface)',
    borderRadius: 7,
    padding: '1px 6px',
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--wb-text-secondary)',
    letterSpacing: 0,
  },
  sectionAction: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--wb-accent-strong)',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  resultCard: {
    width: '100%',
    display: 'flex',
    gap: 12,
    alignItems: 'center',
    padding: 12,
    background: 'var(--wb-card)',
    border: '1px solid var(--wb-border)',
    borderRadius: 22,
    marginBottom: 8,
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)' as never,
    color: 'var(--wb-text)',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  resultCardRestricted: {
    background: 'rgba(255,255,255,0.02)',
    borderStyle: 'dashed',
  },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: 14,
    background: 'var(--wb-surface-hover)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 22,
    flexShrink: 0,
    overflow: 'hidden',
  },
  thumbImg: { width: '100%', height: '100%', objectFit: 'cover' },
  cardBody: { flex: 1, minWidth: 0 },
  cardTitle: {
    fontSize: 15,
    fontWeight: 650,
    color: 'var(--wb-text)',
    letterSpacing: '-0.012em',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  cardSubtitle: {
    fontSize: 12,
    fontWeight: 550,
    color: 'var(--wb-text-muted)',
    marginTop: 2,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    letterSpacing: '-0.005em',
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    background: 'var(--wb-surface)',
    color: 'var(--wb-text-secondary)',
    border: '1px solid var(--wb-border)',
    fontSize: 11,
    fontWeight: 650,
    padding: '3px 8px',
    borderRadius: 11,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  badgePrice: {
    background: 'var(--wb-accent-soft)',
    color: 'var(--wb-accent-strong)',
    borderColor: 'var(--wb-accent-soft-strong)',
  },
  badgeReserved: {
    background: 'var(--wb-warning-soft)',
    color: 'var(--wb-warning)',
    borderColor: 'rgba(251,191,36,0.30)',
  },
  badgeDone: {
    background: 'var(--wb-success-soft)',
    color: 'var(--wb-success)',
    borderColor: 'rgba(74,222,128,0.30)',
  },
  badgeSecret: {
    background: 'rgba(255,255,255,0.04)',
    color: 'var(--wb-text-muted)',
    border: '1px dashed var(--wb-border-strong)',
  },
  badgePro: {
    background: 'var(--wb-grad-accent)',
    color: '#fff',
    border: 'none',
    letterSpacing: '0.2px',
  },
  badgeWarning: {
    background: 'var(--wb-warning-soft)',
    color: 'var(--wb-warning)',
    borderColor: 'rgba(251,191,36,0.30)',
  },
  badgeDanger: {
    background: 'var(--wb-danger-soft)',
    color: 'var(--wb-danger)',
    borderColor: 'rgba(251,113,133,0.30)',
  },
  bigState: {
    margin: '64px auto 0',
    padding: '12px 8px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    gap: 8,
    maxWidth: 300,
  },
  bigStateEmoji: {
    width: 80,
    height: 80,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 38,
    marginBottom: 6,
  },
  bigStateTitle: {
    margin: 0,
    fontSize: 19,
    fontWeight: 650,
    letterSpacing: '-0.02em',
    color: 'var(--wb-text)',
  },
  bigStateDesc: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.5,
    color: 'var(--wb-text-secondary)',
    fontWeight: 500,
  },
  ctaRow: { marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  btnPrimary: {
    height: 40,
    padding: '0 16px',
    borderRadius: 18,
    background: 'var(--wb-grad-accent)',
    color: '#fff',
    border: 'none',
    fontSize: 14,
    fontWeight: 650,
    letterSpacing: '-0.012em',
    boxShadow: 'var(--wb-sh-glow-cta)',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnGhost: {
    height: 40,
    padding: '0 16px',
    borderRadius: 18,
    background: 'var(--wb-surface)',
    color: 'var(--wb-text-secondary)',
    border: '1px solid var(--wb-border-light)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  recentRow: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '11px 4px',
    border: 'none',
    background: 'transparent',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    color: 'var(--wb-text-secondary)',
  },
  recentIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    background: 'var(--wb-surface)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--wb-text-muted)',
    fontSize: 14,
    flexShrink: 0,
  },
  recentQuery: { flex: 1, fontSize: 15, fontWeight: 550, color: 'var(--wb-text-secondary)', textAlign: 'left' },
  recentRemove: {
    color: 'var(--wb-text-muted)',
    fontSize: 18,
    width: 28,
    height: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  tilesGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 4 },
  tile: {
    background: 'var(--wb-card)',
    border: '1px solid var(--wb-border)',
    borderRadius: 18,
    padding: '14px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)' as never,
    color: 'var(--wb-text)',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  tileProMuted: { opacity: 0.85 },
  tileEm: { fontSize: 22, lineHeight: 1 },
  tileLbl: { fontSize: 13, fontWeight: 650, letterSpacing: '-0.005em' },
  tileHint: { fontSize: 11, fontWeight: 550, color: 'var(--wb-text-muted)' },
  proBlock: {
    margin: '8px 0 0',
    background: 'linear-gradient(135deg, rgba(139,123,255,0.18), rgba(139,123,255,0.06))',
    border: '1px solid var(--wb-accent-soft-strong)',
    borderRadius: 22,
    padding: '16px 14px 14px',
    position: 'relative',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)' as never,
  },
  proStar: {
    position: 'absolute',
    top: -10,
    left: 14,
    background: 'var(--wb-grad-accent)',
    color: '#fff',
    borderRadius: 11,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.4px',
    padding: '4px 8px',
    boxShadow: 'var(--wb-sh-glow-soft)',
  },
  proTitle: { fontSize: 15, fontWeight: 650, color: 'var(--wb-text)', letterSpacing: '-0.012em', margin: '4px 0 4px' },
  proDesc: { fontSize: 13, lineHeight: 1.45, color: 'var(--wb-text-secondary)', fontWeight: 500 },
  proBlur: { margin: '12px 0', display: 'flex', flexDirection: 'column', gap: 6 },
  proBlurRow: { height: 14, borderRadius: 7, background: 'rgba(255,255,255,0.06)', filter: 'blur(2px)' },
  proActions: { display: 'flex', gap: 8, marginTop: 10 },
  proPrimary: {
    flex: 1,
    height: 40,
    borderRadius: 18,
    background: 'var(--wb-grad-accent)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 650,
    letterSpacing: '-0.012em',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    boxShadow: 'var(--wb-sh-glow-cta)',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  partialBanner: {
    margin: '12px 0',
    padding: '10px 14px',
    background: 'var(--wb-warning-soft)',
    border: '1px solid rgba(251,191,36,0.30)',
    borderRadius: 14,
    color: 'var(--wb-warning)',
    fontSize: 13,
    fontWeight: 600,
  },
  skCard: {
    display: 'flex',
    gap: 12,
    alignItems: 'center',
    padding: 12,
    background: 'var(--wb-card)',
    border: '1px solid var(--wb-border)',
    borderRadius: 22,
    marginBottom: 8,
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)' as never,
  },
  skThumb: { width: 48, height: 48, borderRadius: 14 },
  skLines: { flex: 1, display: 'flex', flexDirection: 'column', gap: 6 },
  skLine: { height: 12, borderRadius: 6 },
  skeleton: {
    background:
      'linear-gradient(90deg, rgba(255,255,255,0.04), rgba(255,255,255,0.08), rgba(255,255,255,0.04))',
    backgroundSize: '200% 100%',
    animation: 'wbShimmer 1.4s linear infinite',
  },
};

// Inject the shimmer keyframe once. Idempotent — safe to re-mount.
if (typeof document !== 'undefined' && !document.getElementById('wb-search-shimmer-kf')) {
  const styleEl = document.createElement('style');
  styleEl.id = 'wb-search-shimmer-kf';
  styleEl.textContent = '@keyframes wbShimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }';
  document.head.appendChild(styleEl);
}

// Re-export types for the wiring layer.
export type { SearchResultTarget };
