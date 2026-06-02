// Home feed (P0.2 — «Главная → лента близких») Mini App screen cluster.
//
// Self-contained lazy chunk (mirrors CirclesRoot): receives `tgFetch`, `locale`
// and host navigation callbacks. Renders the ranked feed of circle events, wish
// activity and the viewer's own reservation reminders. All visuals are composed
// from @wishlist/ui primitives + @wishlist/ui-tokens (no raw hex / magic
// numbers). The surprise invariant is enforced server-side — this screen only
// ever receives the viewer's OWN reservations and never reservation state on
// other people's preview items.
//
// Card patterns here are a feature-level COMPOSITION of canonical primitives
// (Card/Chip/Button/UserAvatar), not a new primitive. If the FeedCard shape
// proves reusable it gets extracted to packages/ui (see DESIGN_DECISIONS).

import React, { useCallback, useEffect, useState } from 'react';

import { t, type Locale } from '@wishlist/shared';
import { Button, Chip } from '@wishlist/ui';
import { colors as c, radius as r, spacing as sp, fontSize as fs, fontWeight as fw, shadows as sh, gradients as g } from '@wishlist/ui-tokens';

import { UserAvatar } from '../../components/UserAvatar';
import { hashKeyForLog } from '../../idempotency';
import { getEmoji } from '../../lib/emoji';

// ── Host contract ─────────────────────────────────────────────────────────────

type TgFetchInit = { method?: string; body?: string; headers?: Record<string, string>; idempotency?: string | { action: string } };
export type TgFetchFn = (url: string, init?: TgFetchInit) => Promise<Response>;

export interface FeedRootProps {
  tgFetch: TgFetchFn;
  locale: Locale;
  /** Open a circle member's shared wishlists (the event/activity/reservation CTA target). */
  onOpenMember: (circleId: string, memberId: string) => void;
  /** Open the full reservations manager (the «Мои брони» block). */
  onOpenReservations: () => void;
  /** Bridge to P0.1 — start creating a circle (empty-state CTA). */
  onCreateCircle: () => void;
  onOpenSearch?: () => void;
  onOpenSettings?: () => void;
  pushToast: (message: string, kind: 'success' | 'error' | 'info') => void;
  /** Analytics sink — wired to MiniApp's `trackEvent`. Optional so a stale host
   *  that predates the P0.2 analytics wiring can't crash the feed chunk. */
  onTrack?: (event: string, props?: Record<string, unknown>) => void;
}

// ── Wire shapes (mirror services/feed.service.ts) ─────────────────────────────

type CircleType = 'FAMILY' | 'FRIENDS' | 'COLLEAGUES' | 'COUPLE';
type Urgency = 'today' | 'soon' | 'upcoming';
interface Person { name: string; avatarUrl: string | null }
interface PreviewItem { id: string; title: string; imageUrl: string | null }
interface CircleChip { id: string; name: string; emoji: string | null; type: CircleType }
interface EventItem {
  kind: 'event'; id: string; circleId: string; circleName: string; memberUserId: string; person: Person;
  eventKind: 'birthday'; eventDate: string; daysUntil: number; urgency: Urgency; itemCount: number; previewItems: PreviewItem[];
}
interface ActivityItem {
  kind: 'activity'; id: string; circleId: string; circleName: string; memberUserId: string; person: Person;
  addedCount: number; updatedCount: number; at: string; itemCount: number; previewItems: PreviewItem[];
}
interface ReservationItem {
  kind: 'reservation'; id: string; circleId: string; circleName: string; itemId: string; itemTitle: string;
  itemImageUrl: string | null; forUserId: string; forName: string; daysUntilEvent: number | null;
}
type FeedItem = EventItem | ActivityItem | ReservationItem;
interface FeedResponse {
  hasCircles: boolean; circles: CircleChip[]; items: FeedItem[];
  reservations: { count: number; names: string[] }; generatedAt: string; nextCursor: string | null;
}

const TYPE_EMOJI: Record<CircleType, string> = { FAMILY: '🏡', FRIENDS: '🎉', COLLEAGUES: '💼', COUPLE: '💞' };
// Hex accents only (UserAvatar derives a gradient by appending an alpha suffix).
const AVATAR_ACCENTS = [c.accent, c.accentStrong, c.warning, c.success, c.danger];
function accentFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_ACCENTS[h % AVATAR_ACCENTS.length]!;
}

function localeTag(locale: Locale): string {
  return locale === 'ru' ? 'ru-RU' : locale === 'zh-CN' ? 'zh-CN' : locale;
}
function fmtDate(iso: string, locale: Locale): string {
  try { return new Date(iso).toLocaleDateString(localeTag(locale), { day: 'numeric', month: 'long' }); } catch { return ''; }
}
function countdownText(days: number, locale: Locale): string {
  return days <= 0 ? t('circle_event_today', locale) : t('circle_event_in_days', locale, { n: days });
}
function urgencyTone(u: Urgency): 'danger' | 'warning' | 'accent' {
  return u === 'today' ? 'danger' : u === 'soon' ? 'warning' : 'accent';
}

// ── Small presentational helpers ──────────────────────────────────────────────

function Thumb({ item, size = 42 }: { item: PreviewItem; size?: number }) {
  if (item.imageUrl) {
    return (
      <div style={{ width: size, height: size, borderRadius: r.lg, flexShrink: 0, backgroundImage: `url(${item.imageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center', border: `1px solid ${c.border}` }} />
    );
  }
  return (
    <div style={{ width: size, height: size, borderRadius: r.lg, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: Math.round(size * 0.5), background: c.surface, border: `1px solid ${c.border}` }}>
      {getEmoji(item.title)}
    </div>
  );
}

function PreviewRow({ items, extra }: { items: PreviewItem[]; extra: number }) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: sp[2], marginTop: sp[3] }}>
      {items.map((it) => <Thumb key={it.id} item={it} />)}
      {extra > 0 && (
        <span style={{ fontSize: fs.sm, color: c.textMuted, fontWeight: fw.semibold }}>+{extra}</span>
      )}
    </div>
  );
}

function Kicker({ emoji, text }: { emoji: string; text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: sp[1], fontSize: fs.xs, fontWeight: fw.bold, letterSpacing: '0.3px', textTransform: 'uppercase', color: c.textMuted, marginBottom: 2 }}>
      <span>{emoji}</span><span>{text}</span>
    </div>
  );
}

function CardShell({ children, tint, rail }: { children: React.ReactNode; tint?: 'danger' | 'success'; rail: string }) {
  const background = tint === 'danger' ? `linear-gradient(135deg, ${c.card}, ${c.dangerSoft})`
    : tint === 'success' ? `linear-gradient(135deg, ${c.card}, ${c.successSoft})`
    : c.card;
  const borderColor = tint === 'danger' ? c.danger : tint === 'success' ? c.success : c.border;
  return (
    <div style={{ position: 'relative', borderRadius: r.xxl, background, border: `1px solid ${borderColor}`, padding: `${sp[4] - 1}px ${sp[4] - 1}px ${sp[3]}px`, marginBottom: sp[3], overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 0, top: sp[3], bottom: sp[3], width: 3, borderRadius: r.xs, background: rail }} />
      {children}
    </div>
  );
}

// ── Cards ─────────────────────────────────────────────────────────────────────

function EventCard({ item, locale, onOpen }: { item: EventItem; locale: Locale; onOpen: () => void }) {
  const tone = urgencyTone(item.urgency);
  return (
    <CardShell rail={tone === 'danger' ? c.danger : tone === 'warning' ? c.warning : c.accent} tint={item.urgency === 'today' ? 'danger' : undefined}>
      <div style={{ display: 'flex', gap: sp[3], alignItems: 'flex-start' }}>
        <UserAvatar name={item.person.name} avatarUrl={item.person.avatarUrl} size={46} accent={accentFor(item.memberUserId)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Kicker emoji="🎂" text={t('feed_kick_birthday', locale)} />
          <div style={{ fontSize: fs.xl, fontWeight: fw.strong, letterSpacing: '-0.02em', color: c.text }}>{item.person.name}</div>
          <div style={{ fontSize: fs.base, color: c.textSecondary, marginTop: 2 }}>
            {fmtDate(item.eventDate, locale)}{item.itemCount > 0 ? ` · 🎁 ${item.itemCount}` : ''}
          </div>
        </div>
        <Chip tone={tone} size="md">{countdownText(item.daysUntil, locale)}</Chip>
      </div>
      <PreviewRow items={item.previewItems} extra={Math.max(0, item.itemCount - item.previewItems.length)} />
      <div style={{ marginTop: sp[3] }}>
        <Button variant="primary-gradient" size="md" fullWidth onClick={onOpen}>🎁 {t('feed_cta_choose_gift', locale)}</Button>
      </div>
    </CardShell>
  );
}

function ActivityCard({ item, locale, onOpen }: { item: ActivityItem; locale: Locale; onOpen: () => void }) {
  const isNew = item.addedCount > 0;
  return (
    <CardShell rail={c.success}>
      <div style={{ display: 'flex', gap: sp[3], alignItems: 'flex-start' }}>
        <UserAvatar name={item.person.name} avatarUrl={item.person.avatarUrl} size={46} accent={accentFor(item.memberUserId)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Kicker emoji="✨" text={isNew ? t('feed_kick_new_wishes', locale) : t('feed_kick_updated_wishes', locale)} />
          <div style={{ display: 'flex', alignItems: 'center', gap: sp[2] }}>
            <span style={{ fontSize: fs.xl, fontWeight: fw.strong, letterSpacing: '-0.02em', color: c.text }}>{item.person.name}</span>
            {isNew && <Chip tone="success" size="sm">+{item.addedCount}</Chip>}
          </div>
        </div>
      </div>
      <PreviewRow items={item.previewItems} extra={Math.max(0, item.itemCount - item.previewItems.length)} />
      <div style={{ marginTop: sp[3] }}>
        <Button variant="surface" size="md" fullWidth onClick={onOpen}>{t('feed_cta_view', locale)}</Button>
      </div>
    </CardShell>
  );
}

function ReservationCard({ item, locale, onOpen }: { item: ReservationItem; locale: Locale; onOpen: () => void }) {
  return (
    <CardShell rail={c.success} tint="success">
      <div style={{ display: 'flex', gap: sp[3], alignItems: 'flex-start' }}>
        <Thumb item={{ id: item.itemId, title: item.itemTitle, imageUrl: item.itemImageUrl }} size={46} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Kicker emoji="🤫" text={t('feed_kick_your_reservation', locale)} />
          <div style={{ fontSize: fs.lg, fontWeight: fw.strong, letterSpacing: '-0.015em', color: c.text, lineHeight: 1.25 }}>{item.itemTitle}</div>
          <div style={{ fontSize: fs.base, color: c.textSecondary, marginTop: 2 }}>
            {t('feed_reservation_recipient', locale, { name: item.forName })}
            {item.daysUntilEvent != null ? ` · ${countdownText(item.daysUntilEvent, locale)}` : ''}
          </div>
        </div>
      </div>
      <div style={{ marginTop: sp[3] }}>
        <Button variant="surface" size="md" fullWidth onClick={onOpen}>{t('feed_cta_details', locale)}</Button>
      </div>
    </CardShell>
  );
}

// ── States ────────────────────────────────────────────────────────────────────

function EmptyState({ locale, onCreate }: { locale: Locale; onCreate: () => void }) {
  const feats: Array<[string, string]> = [
    ['🎂', t('feed_empty_feat_birthdays', locale)],
    ['✨', t('feed_empty_feat_wishes', locale)],
    ['🤫', t('feed_empty_feat_reservations', locale)],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: `${sp[8]}px ${sp[5]}px` }}>
      <div style={{ width: 104, height: 104, borderRadius: r.hero + 6, background: g.accentDiagonal, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 52, boxShadow: sh.glowCtaLayered, marginBottom: sp[6] }}>✨</div>
      <div style={{ fontSize: fs.displaySm, fontWeight: fw.bold, letterSpacing: '-0.025em', color: c.text, marginBottom: sp[2] }}>{t('feed_empty_title', locale)}</div>
      <div style={{ fontSize: fs.md, lineHeight: 1.55, color: c.textSecondary, maxWidth: 300 }}>{t('feed_empty_text', locale)}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: sp[2], width: '100%', margin: `${sp[5]}px 0 ${sp[6]}px` }}>
        {feats.map(([e, txt]) => (
          <div key={txt} style={{ display: 'flex', alignItems: 'center', gap: sp[3], padding: `${sp[3]}px ${sp[4]}px`, borderRadius: r.lg, background: c.card, border: `1px solid ${c.border}`, textAlign: 'left' }}>
            <span style={{ fontSize: 20 }}>{e}</span>
            <span style={{ fontSize: fs.base, fontWeight: fw.semibold, color: c.textSecondary, lineHeight: 1.3 }}>{txt}</span>
          </div>
        ))}
      </div>
      <Button variant="primary-gradient" size="lg" fullWidth onClick={onCreate}>{t('feed_empty_cta', locale)}</Button>
    </div>
  );
}

function QuietState({ locale }: { locale: Locale }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: `${sp[8]}px ${sp[6]}px` }}>
      <div style={{ fontSize: 44, marginBottom: sp[3] }}>🌙</div>
      <div style={{ fontSize: fs.xl, fontWeight: fw.strong, letterSpacing: '-0.02em', color: c.text, marginBottom: sp[2] }}>{t('feed_quiet_title', locale)}</div>
      <div style={{ fontSize: fs.md, lineHeight: 1.55, color: c.textSecondary, maxWidth: 280 }}>{t('feed_quiet_text', locale)}</div>
    </div>
  );
}

function FeedSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: sp[3] }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ height: 130, borderRadius: r.xxl, background: c.card, border: `1px solid ${c.border}`, opacity: 1 - i * 0.22 }} />
      ))}
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export function FeedRoot({ tgFetch, locale, onOpenMember, onOpenReservations, onCreateCircle, onOpenSearch, onOpenSettings, onTrack }: FeedRootProps) {
  const [data, setData] = useState<FeedResponse | null>(null);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);

  const load = useCallback(async (circleId: string | null) => {
    setError(false);
    try {
      const res = await tgFetch(`/tg/feed${circleId ? `?circleId=${encodeURIComponent(circleId)}` : ''}`);
      if (!res.ok) throw new Error('feed_failed');
      const json = await res.json() as FeedResponse;
      setData(json);
      // feed.viewed — fire once per successful load (here, NOT in render), so
      // re-renders don't re-emit. Per-kind ranked-card counts are the CTR
      // denominators consumed by feed.card_clicked analysis.
      let eventCount = 0, activityCount = 0, reservationCount = 0;
      for (const it of json.items) {
        if (it.kind === 'event') eventCount++;
        else if (it.kind === 'activity') activityCount++;
        else reservationCount++;
      }
      onTrack?.('feed.viewed', {
        hasCircles: json.hasCircles,
        itemCount: json.items.length,
        eventCount,
        activityCount,
        reservationCount,
        circleCount: json.circles.length,
        filtered: circleId !== null,
      });
    } catch {
      setError(true);
    }
  }, [tgFetch, onTrack]);

  useEffect(() => { void load(filter); }, [filter, load]);

  // Circle chip selection. Guard against re-tapping the active chip (mirrors
  // SearchScreen.handleFilterChange) so filter_changed reflects real changes.
  // scope = 'all' | djb2 fingerprint of the circleId — never the raw id.
  const selectFilter = useCallback((next: string | null) => {
    if (next === filter) return;
    setFilter(next);
    onTrack?.('feed.filter_changed', { scope: next === null ? 'all' : hashKeyForLog(next) });
  }, [filter, onTrack]);

  const headerBtn = (icon: string, onClick: () => void) => (
    <button type="button" onClick={onClick} aria-label={icon} style={{ width: 38, height: 38, borderRadius: r.lg, background: c.surface, border: `1px solid ${c.border}`, color: c.text, fontSize: 17, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>{icon}</button>
  );

  return (
    <div style={{ padding: `${sp[3]}px ${sp[4]}px 130px`, minHeight: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `${sp[2]}px 0 ${sp[3]}px` }}>
        <div>
          <div style={{ fontSize: fs.displaySm, fontWeight: fw.bold, letterSpacing: '-0.03em', color: c.text }}>{t('feed_title', locale)}</div>
          <div style={{ fontSize: fs.base, color: c.textSecondary, marginTop: 1 }}>{t('feed_subtitle', locale)}</div>
        </div>
        <div style={{ display: 'flex', gap: sp[2] }}>
          {onOpenSearch && headerBtn('🔍', onOpenSearch)}
          {onOpenSettings && headerBtn('⚙️', onOpenSettings)}
        </div>
      </div>

      {/* Initial load */}
      {!data && !error && <FeedSkeleton />}

      {/* Error (no cached data) */}
      {!data && error && (
        <div style={{ textAlign: 'center', padding: `${sp[8]}px ${sp[5]}px` }}>
          <div style={{ fontSize: 40, marginBottom: sp[3] }}>😕</div>
          <div style={{ fontSize: fs.lg, color: c.textSecondary, marginBottom: sp[4] }}>{t('feed_error', locale)}</div>
          <Button variant="surface" size="md" onClick={() => void load(filter)}>{t('feed_retry', locale)}</Button>
        </div>
      )}

      {/* No circles → bridge to P0.1 */}
      {data && !data.hasCircles && <EmptyState locale={locale} onCreate={() => { onTrack?.('feed.empty_cta_clicked'); onCreateCircle(); }} />}

      {/* Ready */}
      {data && data.hasCircles && (
        <>
          {/* Circle filter chips */}
          {data.circles.length > 0 && (
            <div style={{ display: 'flex', gap: sp[2], overflowX: 'auto', paddingBottom: sp[3], margin: `0 -${sp[4]}px ${sp[1]}px`, paddingLeft: sp[4], paddingRight: sp[4], scrollbarWidth: 'none' }}>
              <FilterChip label={t('feed_filter_all', locale)} active={filter === null} onClick={() => selectFilter(null)} />
              {data.circles.map((cc) => (
                <FilterChip key={cc.id} label={`${cc.emoji || TYPE_EMOJI[cc.type]} ${cc.name}`} active={filter === cc.id} onClick={() => selectFilter(cc.id)} />
              ))}
            </div>
          )}

          {data.items.length === 0 && data.reservations.count === 0 ? (
            <QuietState locale={locale} />
          ) : (
            <>
              {data.items.map((it, idx) => {
                if (it.kind === 'event') return <EventCard key={it.id} item={it} locale={locale} onOpen={() => { onTrack?.('feed.card_clicked', { kind: 'event', position: idx, daysUntil: it.daysUntil, urgency: it.urgency }); onOpenMember(it.circleId, it.memberUserId); }} />;
                if (it.kind === 'activity') return <ActivityCard key={it.id} item={it} locale={locale} onOpen={() => { onTrack?.('feed.card_clicked', { kind: 'activity', position: idx }); onOpenMember(it.circleId, it.memberUserId); }} />;
                return <ReservationCard key={it.id} item={it} locale={locale} onOpen={() => { onTrack?.('feed.card_clicked', { kind: 'reservation', position: idx }); onOpenMember(it.circleId, it.forUserId); }} />;
              })}

              {/* «Мои брони» summary block */}
              {data.reservations.count > 0 && (
                <>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: `${sp[2]}px ${sp[1]}px ${sp[2]}px` }}>
                    <span style={{ fontSize: fs.sm, fontWeight: fw.bold, color: c.textMuted, textTransform: 'uppercase', letterSpacing: '0.7px' }}>{t('feed_reservations_header', locale)}</span>
                    <button type="button" onClick={onOpenReservations} style={{ background: 'none', border: 'none', color: c.accentStrong, fontSize: fs.base, fontWeight: fw.semibold, cursor: 'pointer' }}>{t('feed_see_all', locale)} →</button>
                  </div>
                  <button type="button" onClick={onOpenReservations} style={{ display: 'flex', alignItems: 'center', gap: sp[3], width: '100%', textAlign: 'left', padding: `${sp[3]}px ${sp[4] - 1}px`, borderRadius: r.xl, background: c.card, border: `1px solid ${c.border}`, cursor: 'pointer' }}>
                    <span style={{ width: 42, height: 42, borderRadius: r.lg, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 21, background: `linear-gradient(135deg, ${c.successSoft}, ${c.surface})` }}>🎁</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: fs.md, fontWeight: fw.strong, color: c.text }}>{t('feed_reservations_count', locale, { n: data.reservations.count })}</span>
                      {data.reservations.names.length > 0 && (
                        <span style={{ display: 'block', fontSize: fs.base, color: c.textSecondary, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {data.reservations.names.join(', ')}{data.reservations.count > data.reservations.names.length ? ` ${t('feed_and_more', locale, { n: data.reservations.count - data.reservations.names.length })}` : ''}
                        </span>
                      )}
                    </span>
                    <span style={{ fontSize: 19, color: c.textMuted }}>›</span>
                  </button>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: '0 0 auto', height: 34, padding: `0 ${sp[3] + 2}px`, borderRadius: r.full, cursor: 'pointer',
        fontSize: fs.base, fontWeight: fw.semibold, letterSpacing: '-0.01em', whiteSpace: 'nowrap',
        background: active ? g.accentDeep : c.surface,
        border: `1px solid ${active ? 'transparent' : c.border}`,
        color: active ? c.white : c.textSecondary,
        boxShadow: active ? sh.glowSoft : 'none',
      }}
    >
      {label}
    </button>
  );
}
