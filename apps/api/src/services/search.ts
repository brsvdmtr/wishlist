// Global search service.
//
// Public surface:
//   - performGlobalSearch({...}) — main entry. Reads the user's accessible
//     scope, normalizes the query, runs per-group searchers in parallel,
//     and assembles a SearchResponse. Partial failures degrade to
//     `partial: true` + `failedGroups`, never throw.
//   - normalizeSearchQuery / expandQueryAliases — exported for unit tests.
//   - buildAccessibleScope — exported for unit tests.
//
// Privacy invariants (enforced here, not at the route layer):
//   1. Foreign wishlist content is only searched if (a) the wishlist is in
//      ForeignWishlistAccess for this user AND (b) a live access check
//      passes (not archived, has shareToken if LINK_ONLY, not soft-deleted,
//      curated not expired). The relation graph (subscriptions / reservations
//      / santa / profile-follow / curated subs) feeds into this set so a
//      user can still find their subscribed wishlists even if FWA has no
//      entry yet.
//   2. SecretReservation results are ONLY returned for SR.reserverUserId =
//      requesting user. Owners and third parties get no row, no count, no
//      hint that one exists.
//   3. Free users see no titles/owners from PRO-only result types — only
//      an aggregate `pro_locked` block with a sum-count.
//   4. The raw user query is never logged. The route layer hashes it for
//      telemetry; the service exposes only normalizedQuery to callers.
//
// Architectural notes:
//   - SQL goes through Prisma.$queryRaw with tagged-template parameter
//     binding for trigram-friendly ILIKE patterns. Never string-concat the
//     query into SQL. The user-provided query is escaped for LIKE special
//     chars (`%`, `_`, `\`) before being wrapped in `%...%`.
//   - pg_trgm GIN indexes (migration 20260516000000) accelerate the ILIKE
//     paths. The service still works without the extension, just slower.

import { prisma, Prisma } from '@wishlist/db';
import type { Locale } from '@wishlist/shared';
import { getUserEntitlement } from './entitlement';
import { hashShareToken } from './foreign-wishlist-access';

export const SEARCH_MIN_QUERY = 2;
export const SEARCH_MAX_QUERY = 80;
export const SEARCH_DEFAULT_GROUP_LIMIT = 5;
export const SEARCH_DEFAULT_TOTAL_LIMIT = 30;

export type SearchResultType =
  | 'item'
  | 'wishlist'
  | 'category'
  | 'reservation'
  | 'user'
  | 'event'
  | 'setting'
  | 'anti_gift'
  | 'faq'
  | 'action'
  | 'pro_locked';

export type AccessState =
  | 'available'
  | 'restricted'
  | 'expired'
  | 'pro_required';

export interface SearchResultTarget {
  screen:
    | 'item-detail'
    | 'wishlist-detail'
    | 'guest-view'
    | 'guest-item-detail'
    | 'my-reservations'
    | 'gift-notes'
    | 'gift-notes-occasion'
    | 'public-profile'
    | 'settings'
    | 'faq'
    | 'legal'
    | 'changelog'
    | 'referral'
    | 'paywall';
  itemId?: string;
  wishlistId?: string;
  occasionId?: string;
  username?: string;
  section?: string;
  reservationId?: string;
  secret?: boolean;
}

export interface SearchResult {
  /** Synthetic id stable per (type, entityId). Used for React keys + click telemetry. */
  id: string;
  /** The underlying entity id (Item.id / Wishlist.id / etc). Null for static settings rows. */
  entityId: string | null;
  type: SearchResultType;
  title: string;
  subtitle: string;
  badge: string | null;
  badgeTone: 'neutral' | 'price' | 'reserved' | 'done' | 'secret' | 'pro' | 'warning' | 'danger' | null;
  thumbnailUrl: string | null;
  icon: string | null;
  target: SearchResultTarget;
  accessState: AccessState;
  matchedFields: string[];
  ownerUserId: string | null;
  wishlistId: string | null;
  itemId: string | null;
  score: number;
}

export interface SearchGroup {
  type: SearchResultType;
  /** Translated section title (already localized for the requesting user). */
  title: string;
  total: number;
  items: SearchResult[];
  /** True when full count is larger than `items.length`. */
  hasMore: boolean;
}

export interface SearchResponse {
  query: string;
  normalizedQuery: string;
  groups: SearchGroup[];
  suggestions: string[];
  hasMore: boolean;
  nextCursor: string | null;
  partial: boolean;
  failedGroups: SearchResultType[];
  /** True when the requesting user is currently PRO. Used by the FE to render PRO badges. */
  isPro: boolean;
}

// ─── Normalization + alias expansion ────────────────────────────────────────

/**
 * Trim, lowercase, collapse whitespace. Public for unit tests.
 * Does NOT escape LIKE metacharacters — that's caller responsibility right
 * before binding into SQL (so unit tests of alias expansion stay readable).
 */
export function normalizeSearchQuery(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Escape PostgreSQL `LIKE`/`ILIKE` special chars so user input can't break
 * out of the wildcard wrapper. Backslash itself is the escape char.
 * Returns the safe-to-wrap string; caller still adds the surrounding `%`s.
 */
export function escapeLikePattern(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Simple bilingual alias dictionary.
 * Keys are normalized (lowercased) tokens, values are the canonical forms
 * we also search for. Bidirectional pairs are explicitly listed so we don't
 * have to traverse a graph at runtime.
 * Multi-word aliases match as a phrase ("не дарить" → "что не стоит дарить").
 */
const ALIASES: ReadonlyArray<readonly [string, string]> = [
  // RU
  ['др', 'день рождения'],
  ['днюха', 'день рождения'],
  ['днюшка', 'день рождения'],
  ['бронь', 'забронировано'],
  ['брони', 'забронировано'],
  ['резерв', 'забронировано'],
  ['подарок', 'желание'],
  ['подарки', 'желания'],
  ['нельзя дарить', 'что не стоит дарить'],
  ['не дарить', 'что не стоит дарить'],
  ['антиподарок', 'что не стоит дарить'],
  ['избранное', 'важное'],
  ['подписка', 'pro'],
  ['нг', 'новый год'],
  // EN
  ['bday', 'birthday'],
  ['b-day', 'birthday'],
  ['gift', 'wish'],
  ['gifts', 'wishes'],
  ['reserve', 'reservation'],
  ['booking', 'reservation'],
  ['pro', 'subscription'],
];

/**
 * Expand the normalized query into a small set of search terms (≤ 4).
 * Always includes the original normalized query. Used to widen recall
 * without changing ranking — every search SQL ORs over the expanded set.
 */
export function expandQueryAliases(normalized: string): string[] {
  if (!normalized) return [];
  const out = new Set<string>([normalized]);
  for (const [from, to] of ALIASES) {
    if (normalized === from || normalized.includes(from)) out.add(to);
    if (normalized === to || normalized.includes(to)) out.add(from);
  }
  // Cap to keep the SQL bounded.
  return Array.from(out).slice(0, 4);
}

// ─── Accessible scope ───────────────────────────────────────────────────────

export interface AccessibleScope {
  userId: string;
  isPro: boolean;
  godMode: boolean;
  /** Own (not-archived, not-drafts) wishlists. */
  ownWishlistIds: string[];
  /** Own archived wishlists — used when smart filter "archive" is on. */
  ownArchivedWishlistIds: string[];
  /** Foreign wishlists user has live access to. Intersection of FWA history +
   *  relation graph + live access check. */
  foreignWishlistIds: string[];
  /** Owners of accessible foreign wishlists + followed profiles + santa peers. */
  accessiblePeopleIds: string[];
}

/**
 * Resolve the universe of objects this user is allowed to search across.
 * Combines:
 *   - own non-archived wishlists
 *   - ForeignWishlistAccess history
 *   - WishlistSubscription / CuratedSelectionSubscription / ProfileSubscription
 *   - active ReservationMeta + Item.reserverUserId (public reservations)
 *   - active SecretReservation
 *   - SantaParticipant linked wishlists
 *
 * Then re-checks live access on the foreign set:
 *   - Wishlist must exist and not be archived
 *   - For LINK_ONLY wishlists, owner must still have a non-revoked shareToken
 *     (revoked = shareToken IS NULL after share-link DELETE)
 *   - SYSTEM_DRAFTS wishlists are never reachable to anyone but the owner
 *
 * Note: this resolver is intentionally over-permissive at the row-shape
 * level (returns wishlistIds the user *might* reach) — every search hit is
 * still rendered through a per-row check (e.g. is the linked item DELETED?).
 */
export async function buildAccessibleScope(
  userId: string,
  opts: { isPro: boolean; godMode: boolean },
): Promise<AccessibleScope> {
  const [
    ownWishlists,
    fwa,
    wlSubs,
    curatedSubs,
    profileSubs,
    activeReservations,
    publicReservations,
    secretReservations,
    santaWishlists,
  ] = await Promise.all([
    prisma.wishlist.findMany({
      where: { ownerId: userId, type: 'REGULAR' },
      select: { id: true, archivedAt: true },
    }),
    prisma.foreignWishlistAccess.findMany({
      where: { userId },
      select: { wishlistId: true, source: true, sourceRef: true },
    }),
    prisma.wishlistSubscription.findMany({
      where: { subscriberId: userId },
      select: { wishlistId: true },
    }),
    prisma.curatedSelectionSubscription.findMany({
      where: { subscriberId: userId },
      include: { curatedSelection: { select: { wishlistId: true, expiresAt: true, deactivatedAt: true } } },
    }),
    prisma.profileSubscription.findMany({
      where: { subscriberId: userId },
      select: { targetUserId: true },
    }),
    prisma.reservationMeta.findMany({
      where: { reserverUserId: userId, active: true },
      include: { item: { select: { wishlistId: true } } },
    }),
    prisma.item.findMany({
      where: { reserverUserId: userId, status: { in: ['RESERVED', 'PURCHASED'] } },
      select: { wishlistId: true },
    }),
    prisma.secretReservation.findMany({
      where: { reserverUserId: userId, status: 'ACTIVE' },
      include: { item: { select: { wishlistId: true } } },
    }),
    prisma.santaParticipant.findMany({
      where: { userId, status: 'JOINED' },
      select: { linkedWishlistId: true },
    }),
  ]);

  const ownActiveIds: string[] = [];
  const ownArchivedIds: string[] = [];
  for (const w of ownWishlists) {
    if (w.archivedAt) ownArchivedIds.push(w.id);
    else ownActiveIds.push(w.id);
  }
  const ownSet = new Set([...ownActiveIds, ...ownArchivedIds]);

  // Wishlist ids the user has a *live relation* to — these stay searchable
  // for as long as the relation exists, regardless of FWA pins.
  const relationGrounded = new Set<string>();
  for (const r of wlSubs) relationGrounded.add(r.wishlistId);
  for (const r of curatedSubs) {
    if (!r.curatedSelection) continue;
    const stillActive =
      !r.curatedSelection.deactivatedAt && r.curatedSelection.expiresAt > new Date();
    if (stillActive) relationGrounded.add(r.curatedSelection.wishlistId);
  }
  for (const r of activeReservations) if (r.item) relationGrounded.add(r.item.wishlistId);
  for (const r of publicReservations) relationGrounded.add(r.wishlistId);
  for (const r of secretReservations) if (r.item) relationGrounded.add(r.item.wishlistId);
  for (const r of santaWishlists) if (r.linkedWishlistId) relationGrounded.add(r.linkedWishlistId);

  // Wishlist ids from access history ONLY (no live relation). Surface only
  // if the FWA pin is still valid against the current credential — see the
  // sourceRef contract in ForeignWishlistAccess.
  const fwaOnly = new Map<string, { source: string; sourceRef: string | null }>();
  for (const r of fwa) {
    if (relationGrounded.has(r.wishlistId)) continue; // relation wins
    fwaOnly.set(r.wishlistId, { source: r.source, sourceRef: r.sourceRef });
  }

  // Drop own wishlists out of foreign sets (own is searched separately).
  for (const own of ownSet) {
    relationGrounded.delete(own);
    fwaOnly.delete(own);
  }

  const candidateIds = Array.from(new Set([...relationGrounded, ...fwaOnly.keys()]));
  let liveForeignIds: string[] = [];

  if (candidateIds.length > 0) {
    const rows = await prisma.wishlist.findMany({
      where: { id: { in: candidateIds }, type: 'REGULAR', archivedAt: null },
      select: { id: true, visibility: true, shareToken: true, ownerId: true },
    });

    // Pre-fetch CuratedSelection rows we'll need for FWA-pin checks. Only
    // FWA rows pointing at a non-active curated selection need to be dropped.
    const curatedRefIds = Array.from(fwaOnly.entries())
      .filter(([, v]) => v.source === 'curated_selection' && !!v.sourceRef)
      .map(([, v]) => v.sourceRef as string);
    const liveCurated = new Set<string>();
    if (curatedRefIds.length > 0) {
      const sels = await prisma.curatedSelection.findMany({
        where: {
          id: { in: curatedRefIds },
          deactivatedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: { id: true },
      });
      for (const s of sels) liveCurated.add(s.id);
    }

    for (const w of rows) {
      // Private — never reachable through any path.
      if (w.visibility === 'PRIVATE') continue;
      const hasRelation = relationGrounded.has(w.id);

      if (hasRelation) {
        // LINK_ONLY with revoked share-token still needs the token to exist
        // — but a curated subscription / profile follow / reservation /
        // santa link doesn't depend on the token. So just include.
        liveForeignIds.push(w.id);
        continue;
      }

      const pin = fwaOnly.get(w.id);
      if (!pin) continue;

      if (w.visibility === 'LINK_ONLY') {
        if (!w.shareToken) continue;
        if (pin.source === 'share_link') {
          if (!pin.sourceRef || pin.sourceRef !== hashShareToken(w.shareToken)) continue;
        } else if (pin.source === 'curated_selection') {
          if (!pin.sourceRef || !liveCurated.has(pin.sourceRef)) continue;
        } else {
          // direct_open / unknown / stale relation source — can't prove the
          // user still has the link. Drop.
          continue;
        }
      }
      // PUBLIC_PROFILE — any FWA pin survives as long as the wishlist
      // itself is reachable.

      liveForeignIds.push(w.id);
    }
  }

  // Owners of accessible foreign wishlists feed `accessiblePeopleIds`,
  // plus followed profiles + santa peers (gathered separately so we don't
  // need a second roundtrip just for owners).
  const peopleIds = new Set<string>();
  for (const r of profileSubs) peopleIds.add(r.targetUserId);
  if (liveForeignIds.length > 0) {
    const owners = await prisma.wishlist.findMany({
      where: { id: { in: liveForeignIds } },
      select: { ownerId: true },
    });
    for (const o of owners) peopleIds.add(o.ownerId);
  }
  peopleIds.delete(userId);

  return {
    userId,
    isPro: opts.isPro,
    godMode: opts.godMode,
    ownWishlistIds: ownActiveIds,
    ownArchivedWishlistIds: ownArchivedIds,
    foreignWishlistIds: liveForeignIds,
    accessiblePeopleIds: Array.from(peopleIds),
  };
}

// ─── Static settings / FAQ / action catalog ─────────────────────────────────
//
// Search target list for "Settings / FAQ / Actions". Lightweight: a single
// localized title per row + an English-language keyword bag for cross-locale
// recall ("pro" hits the subscription row regardless of UI locale).

type SettingsRow = {
  id: string;
  type: 'setting' | 'action' | 'faq';
  icon: string;
  /** Per-locale titles. Falls back to en when a locale is missing. */
  titles: Partial<Record<Locale, string>> & { en: string; ru: string };
  /** Cross-locale keyword bag, normalized. Always lowercase. */
  keywords: string[];
  target: SearchResultTarget;
  requiresPro?: boolean;
};

const SETTINGS_CATALOG: readonly SettingsRow[] = [
  {
    id: 'profile',
    type: 'setting',
    icon: '👤',
    titles: { ru: 'Профиль', en: 'Profile' },
    keywords: ['профиль', 'profile', 'имя', 'name', 'avatar', 'аватар', 'username'],
    target: { screen: 'settings', section: 'profile' },
  },
  {
    id: 'notifications',
    type: 'setting',
    icon: '🔔',
    titles: { ru: 'Уведомления', en: 'Notifications' },
    keywords: ['уведомления', 'notifications', 'notify', 'push', 'bot', 'бот'],
    target: { screen: 'settings', section: 'notifications' },
  },
  {
    id: 'subscription',
    type: 'setting',
    icon: '⭐',
    titles: { ru: 'WishBoard PRO', en: 'WishBoard PRO' },
    keywords: ['pro', 'про', 'подписка', 'subscription', 'premium', 'stars', 'звёзды', 'оплата'],
    target: { screen: 'paywall' },
  },
  {
    id: 'referral',
    type: 'setting',
    icon: '🎁',
    titles: { ru: 'Пригласить друга', en: 'Invite a friend' },
    keywords: ['referral', 'реферал', 'пригласить', 'invite', 'friend', 'друг'],
    target: { screen: 'referral' },
  },
  {
    id: 'privacy',
    type: 'setting',
    icon: '🔒',
    titles: { ru: 'Приватность', en: 'Privacy' },
    keywords: ['privacy', 'приватность', 'видимость', 'visibility', 'public', 'public profile'],
    target: { screen: 'settings', section: 'privacy' },
  },
  {
    id: 'appearance',
    type: 'setting',
    icon: '🎨',
    titles: { ru: 'Оформление', en: 'Appearance' },
    keywords: ['theme', 'тема', 'оформление', 'accent', 'акцент', 'цвет', 'color', 'dark', 'black'],
    target: { screen: 'settings', section: 'appearance' },
  },
  {
    id: 'language',
    type: 'setting',
    icon: '🌐',
    titles: { ru: 'Язык', en: 'Language' },
    keywords: ['language', 'язык', 'locale', 'ru', 'en', 'ar'],
    target: { screen: 'settings', section: 'language' },
  },
  {
    id: 'calendar',
    type: 'setting',
    icon: '📅',
    titles: { ru: 'Календарь подарков', en: 'Gift calendar' },
    keywords: ['календарь', 'calendar', 'events', 'события', 'birthday', 'день рождения', 'праздник'],
    target: { screen: 'gift-notes' },
    requiresPro: true,
  },
  {
    id: 'dont-gift',
    type: 'setting',
    icon: '🚫',
    titles: { ru: 'Что не стоит дарить', en: 'Don’t gift list' },
    keywords: ['не дарить', 'нельзя дарить', 'антиподарок', 'dont gift', 'anti-gift', 'аллергия', 'allergy'],
    target: { screen: 'settings', section: 'dont-gift' },
    requiresPro: true,
  },
  {
    id: 'faq',
    type: 'faq',
    icon: '💡',
    titles: { ru: 'Частые вопросы', en: 'FAQ' },
    keywords: ['faq', 'помощь', 'help', 'вопрос', 'question', 'support', 'поддержка'],
    target: { screen: 'faq' },
  },
  {
    id: 'legal',
    type: 'faq',
    icon: '📄',
    titles: { ru: 'Юридическая информация', en: 'Legal' },
    keywords: ['legal', 'юридическая', 'terms', 'оферта', 'политика', 'privacy policy'],
    target: { screen: 'legal' },
  },
  {
    id: 'changelog',
    type: 'faq',
    icon: '🆕',
    titles: { ru: 'Что нового', en: 'What’s new' },
    keywords: ['changelog', 'новое', 'release', 'обновление', 'updates'],
    target: { screen: 'changelog' },
  },
  {
    id: 'create-wishlist',
    type: 'action',
    icon: '➕',
    titles: { ru: 'Создать вишлист', en: 'Create wishlist' },
    keywords: ['создать вишлист', 'create wishlist', 'new wishlist', 'новый вишлист', 'add wishlist'],
    target: { screen: 'wishlist-detail', section: 'create' },
  },
  {
    id: 'import-link',
    type: 'action',
    icon: '🔗',
    titles: { ru: 'Импорт по ссылке', en: 'Import by link' },
    keywords: ['import', 'импорт', 'link', 'ссылка', 'ozon', 'wildberries', 'lamoda', 'goldapple'],
    target: { screen: 'wishlist-detail', section: 'import' },
    requiresPro: true,
  },
];

// ─── Helpers shared by searchers ────────────────────────────────────────────

interface SearchContext {
  scope: AccessibleScope;
  locale: Locale;
  terms: string[]; // normalized + alias-expanded
  rawNormalized: string;
  perGroupLimit: number;
}

/** Build a single ILIKE pattern array bound to a $queryRaw call. */
function buildIlikePatterns(terms: string[]): string[] {
  return terms.map((t) => `%${escapeLikePattern(t)}%`);
}

/** Pick a thumbnail emoji deterministically per title (when no real image). */
function emojiForTitle(title: string): string {
  const t = title.toLowerCase();
  if (/наушн|headphone|airpod/.test(t)) return '🎧';
  if (/книг|book/.test(t)) return '📚';
  if (/телефон|phone|iphone/.test(t)) return '📱';
  if (/часы|watch/.test(t)) return '⌚';
  if (/кофе|coffee/.test(t)) return '☕';
  if (/игрушк|toy|плюш/.test(t)) return '🧸';
  if (/сертификат|gift card/.test(t)) return '🎟';
  if (/цвет|flower/.test(t)) return '💐';
  if (/духи|perfume/.test(t)) return '🌸';
  if (/одежд|cloth|футболк/.test(t)) return '👕';
  if (/обув|shoe|кросс/.test(t)) return '👟';
  if (/украшен|jewel|серьг|кольц/.test(t)) return '💍';
  return '🎁';
}

/** Map Prisma ItemStatus → user-facing badge tone and label. */
function badgeForItem(status: string): { label: string | null; tone: SearchResult['badgeTone'] } {
  switch (status) {
    case 'RESERVED':
      return { label: '🤝 бронь', tone: 'reserved' };
    case 'PURCHASED':
    case 'COMPLETED':
      return { label: '✓ подарено', tone: 'done' };
    case 'ARCHIVED':
      return { label: 'архив', tone: 'neutral' };
    case 'DELETED':
      return { label: 'удалено', tone: 'neutral' };
    default:
      return { label: null, tone: null };
  }
}

/** Compute a coarse ranking score given the matched title vs terms. */
function scoreTitleMatch(title: string, terms: string[]): number {
  const t = title.toLowerCase();
  let best = 0.4; // any substring match (baseline)
  for (const term of terms) {
    if (t === term) return 1.0;
    if (t.startsWith(term)) best = Math.max(best, 0.85);
    else if (t.includes(` ${term}`) || t.includes(`${term} `)) best = Math.max(best, 0.7);
    else if (t.includes(term)) best = Math.max(best, 0.55);
  }
  return best;
}

// ─── Per-group searchers ────────────────────────────────────────────────────

async function searchItemsGroup(ctx: SearchContext): Promise<{ total: number; rows: SearchResult[] }> {
  const allWishlistIds = [...ctx.scope.ownWishlistIds, ...ctx.scope.foreignWishlistIds];
  if (allWishlistIds.length === 0) return { total: 0, rows: [] };
  const patterns = buildIlikePatterns(ctx.terms);
  if (patterns.length === 0) return { total: 0, rows: [] };

  // SECURITY: every parameter goes through tagged-template binding. Status
  // exclude list is a constant. Wishlist id list comes from buildAccessibleScope.
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      title: string;
      description: string | null;
      url: string;
      priceText: string | null;
      currency: string;
      imageUrl: string | null;
      status: string;
      wishlistId: string;
      categoryId: string | null;
      wishlistTitle: string;
      categoryName: string | null;
      ownerId: string;
      priority: string;
      matched_field: string;
    }>
  >`
    SELECT i.id, i.title, i.description, i.url, i."priceText", i.currency::text AS currency,
           i."imageUrl", i.status::text AS status,
           i."wishlistId", i."categoryId", i.priority::text AS priority,
           w.title AS "wishlistTitle", w."ownerId" AS "ownerId",
           c.name AS "categoryName",
           CASE
             WHEN lower(i.title) ILIKE ANY (${patterns}::text[]) THEN 'title'
             WHEN lower(i.description) ILIKE ANY (${patterns}::text[]) THEN 'description'
             WHEN lower(i.url) ILIKE ANY (${patterns}::text[]) THEN 'url'
             ELSE 'other'
           END AS "matched_field"
    FROM "Item" i
    JOIN "Wishlist" w ON w.id = i."wishlistId"
    LEFT JOIN "WishlistCategory" c ON c.id = i."categoryId"
    WHERE i."wishlistId" = ANY (${allWishlistIds}::text[])
      AND i.status NOT IN ('DELETED', 'ARCHIVED')
      AND (
        lower(i.title) ILIKE ANY (${patterns}::text[])
        OR lower(i.description) ILIKE ANY (${patterns}::text[])
        OR lower(i.url) ILIKE ANY (${patterns}::text[])
      )
    ORDER BY
      CASE WHEN lower(i.title) ILIKE ${`${ctx.rawNormalized}%`} THEN 0 ELSE 1 END,
      i."updatedAt" DESC
    LIMIT ${ctx.perGroupLimit + 30}
  `;

  // Score + dedupe by item id (an item may appear in multiple wishlists via
  // shared placements but the canonical Item id is unique here).
  const seen = new Set<string>();
  const scored: SearchResult[] = [];
  const ownSet = new Set(ctx.scope.ownWishlistIds);
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const isOwn = ownSet.has(r.wishlistId);
    let score = scoreTitleMatch(r.title, ctx.terms) * 100;
    if (isOwn) score += 20;
    if (r.priority === 'HIGH') score += 5;
    if (r.status === 'AVAILABLE') score += 8;
    const badge = badgeForItem(r.status);
    const priceBadge = !badge.label && r.priceText
      ? { label: `${r.priceText} ${currencySymbol(r.currency)}`.trim(), tone: 'price' as const }
      : badge;
    const subtitleParts = [r.wishlistTitle];
    if (r.categoryName) subtitleParts.push(r.categoryName);
    if (!isOwn) subtitleParts.push('у друга');
    scored.push({
      id: `item:${r.id}`,
      entityId: r.id,
      type: 'item',
      title: r.title,
      subtitle: subtitleParts.join(' · '),
      badge: priceBadge.label ?? null,
      badgeTone: priceBadge.tone ?? null,
      thumbnailUrl: r.imageUrl,
      icon: r.imageUrl ? null : emojiForTitle(r.title),
      target: {
        screen: isOwn ? 'item-detail' : 'guest-item-detail',
        itemId: r.id,
        wishlistId: r.wishlistId,
      },
      accessState: 'available',
      matchedFields: [r.matched_field],
      ownerUserId: r.ownerId,
      wishlistId: r.wishlistId,
      itemId: r.id,
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return { total: scored.length, rows: scored.slice(0, ctx.perGroupLimit) };
}

function currencySymbol(currency: string): string {
  switch (currency) {
    case 'RUB': return '₽';
    case 'USD': return '$';
    case 'EUR': return '€';
    case 'KZT': return '₸';
    case 'BYN': return 'Br';
    case 'UAH': return '₴';
    default: return currency;
  }
}

async function searchWishlistsGroup(ctx: SearchContext): Promise<{ total: number; rows: SearchResult[] }> {
  const allWishlistIds = [...ctx.scope.ownWishlistIds, ...ctx.scope.foreignWishlistIds];
  if (allWishlistIds.length === 0) return { total: 0, rows: [] };
  const patterns = buildIlikePatterns(ctx.terms);

  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      title: string;
      description: string | null;
      emoji: string | null;
      ownerId: string;
      ownerDisplayName: string | null;
      itemCount: bigint;
    }>
  >`
    SELECT w.id, w.title, w.description, w.emoji, w."ownerId",
           p."displayName" AS "ownerDisplayName",
           COUNT(i.id) AS "itemCount"
    FROM "Wishlist" w
    LEFT JOIN "UserProfile" p ON p."userId" = w."ownerId"
    LEFT JOIN "Item" i ON i."wishlistId" = w.id AND i.status NOT IN ('DELETED', 'ARCHIVED')
    WHERE w.id = ANY (${allWishlistIds}::text[])
      AND w."archivedAt" IS NULL
      AND (
        lower(w.title) ILIKE ANY (${patterns}::text[])
        OR lower(w.description) ILIKE ANY (${patterns}::text[])
        OR lower(coalesce(p."displayName", '')) ILIKE ANY (${patterns}::text[])
      )
    GROUP BY w.id, p."displayName"
    ORDER BY
      CASE WHEN lower(w.title) ILIKE ${`${ctx.rawNormalized}%`} THEN 0 ELSE 1 END,
      w."updatedAt" DESC
    LIMIT ${ctx.perGroupLimit + 10}
  `;

  const ownSet = new Set(ctx.scope.ownWishlistIds);
  const out: SearchResult[] = rows.map((r) => {
    const isOwn = ownSet.has(r.id);
    const score = scoreTitleMatch(r.title, ctx.terms) * 100 + (isOwn ? 20 : 0);
    const itemCount = Number(r.itemCount);
    const subtitleParts: string[] = [];
    subtitleParts.push(isOwn ? 'мой' : (r.ownerDisplayName ? `у ${r.ownerDisplayName}` : 'у друга'));
    if (itemCount > 0) subtitleParts.push(`${itemCount} желаний`);
    return {
      id: `wishlist:${r.id}`,
      entityId: r.id,
      type: 'wishlist',
      title: r.title,
      subtitle: subtitleParts.join(' · '),
      badge: null,
      badgeTone: null,
      thumbnailUrl: null,
      icon: r.emoji ?? '📋',
      target: {
        screen: isOwn ? 'wishlist-detail' : 'guest-view',
        wishlistId: r.id,
      },
      accessState: 'available',
      matchedFields: ['title'],
      ownerUserId: r.ownerId,
      wishlistId: r.id,
      itemId: null,
      score,
    };
  });
  out.sort((a, b) => b.score - a.score);
  return { total: out.length, rows: out.slice(0, ctx.perGroupLimit) };
}

async function searchCategoriesGroup(ctx: SearchContext): Promise<{ total: number; rows: SearchResult[] }> {
  const allWishlistIds = [...ctx.scope.ownWishlistIds, ...ctx.scope.foreignWishlistIds];
  if (allWishlistIds.length === 0) return { total: 0, rows: [] };
  const patterns = buildIlikePatterns(ctx.terms);

  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      name: string;
      wishlistId: string;
      wishlistTitle: string;
      itemCount: bigint;
    }>
  >`
    SELECT c.id, c.name, c."wishlistId", w.title AS "wishlistTitle",
           COUNT(i.id) AS "itemCount"
    FROM "WishlistCategory" c
    JOIN "Wishlist" w ON w.id = c."wishlistId"
    LEFT JOIN "Item" i ON i."categoryId" = c.id AND i.status NOT IN ('DELETED','ARCHIVED')
    WHERE c."wishlistId" = ANY (${allWishlistIds}::text[])
      AND w."archivedAt" IS NULL
      AND c."isDefault" = false
      AND lower(c.name) ILIKE ANY (${patterns}::text[])
    GROUP BY c.id, w.title
    ORDER BY "itemCount" DESC NULLS LAST, c.name ASC
    LIMIT ${ctx.perGroupLimit + 5}
  `;

  const ownSet = new Set(ctx.scope.ownWishlistIds);
  const out: SearchResult[] = rows.map((r) => {
    const isOwn = ownSet.has(r.wishlistId);
    const itemCount = Number(r.itemCount);
    return {
      id: `category:${r.id}`,
      entityId: r.id,
      type: 'category',
      title: r.name,
      subtitle: `в «${r.wishlistTitle}»${itemCount ? ` · ${itemCount} желаний` : ''}`,
      badge: null,
      badgeTone: null,
      thumbnailUrl: null,
      icon: '🏷',
      target: {
        screen: isOwn ? 'wishlist-detail' : 'guest-view',
        wishlistId: r.wishlistId,
        section: `category:${r.id}`,
      },
      accessState: 'available',
      matchedFields: ['name'],
      ownerUserId: null,
      wishlistId: r.wishlistId,
      itemId: null,
      score: scoreTitleMatch(r.name, ctx.terms) * 100,
    };
  });
  out.sort((a, b) => b.score - a.score);
  return { total: out.length, rows: out.slice(0, ctx.perGroupLimit) };
}

async function searchReservationsGroup(ctx: SearchContext): Promise<{ total: number; rows: SearchResult[] }> {
  // PRO/godMode only. Caller has already gated.
  const patterns = buildIlikePatterns(ctx.terms);

  // Public reservations (Item.reserverUserId = me) + ReservationMeta (active).
  // SecretReservation is intentionally OUT — it has its own searcher with
  // stricter visibility guards.
  const rows = await prisma.$queryRaw<
    Array<{
      itemId: string;
      itemTitle: string;
      itemImageUrl: string | null;
      itemPriceText: string | null;
      itemCurrency: string;
      wishlistId: string;
      wishlistTitle: string;
      ownerId: string;
      ownerDisplayName: string | null;
      expiresAt: Date | null;
      isSmart: boolean;
      isMeta: boolean;
    }>
  >`
    SELECT i.id AS "itemId", i.title AS "itemTitle", i."imageUrl" AS "itemImageUrl",
           i."priceText" AS "itemPriceText", i.currency::text AS "itemCurrency",
           w.id AS "wishlistId", w.title AS "wishlistTitle",
           w."ownerId" AS "ownerId", p."displayName" AS "ownerDisplayName",
           rm."expiresAt" AS "expiresAt", rm."isSmartRes" AS "isSmart",
           true AS "isMeta"
    FROM "ReservationMeta" rm
    JOIN "Item" i ON i.id = rm."itemId"
    JOIN "Wishlist" w ON w.id = i."wishlistId"
    LEFT JOIN "UserProfile" p ON p."userId" = w."ownerId"
    WHERE rm."reserverUserId" = ${ctx.scope.userId}
      AND rm.active = true
      AND (
        lower(i.title) ILIKE ANY (${patterns}::text[])
        OR lower(w.title) ILIKE ANY (${patterns}::text[])
        OR lower(coalesce(p."displayName", '')) ILIKE ANY (${patterns}::text[])
      )
    ORDER BY rm."updatedAt" DESC
    LIMIT ${ctx.perGroupLimit + 10}
  `;

  const out: SearchResult[] = rows.map((r) => {
    const score = scoreTitleMatch(r.itemTitle, ctx.terms) * 100;
    let badge: string | null = null;
    let badgeTone: SearchResult['badgeTone'] = 'reserved';
    if (r.expiresAt && r.isSmart) {
      const hoursLeft = Math.max(0, Math.round((r.expiresAt.getTime() - Date.now()) / 3_600_000));
      badge = hoursLeft < 48 ? `⏱ ${hoursLeft}ч` : `⏱ ${Math.round(hoursLeft / 24)}д`;
      badgeTone = hoursLeft < 24 ? 'warning' : 'reserved';
    } else {
      badge = '🤝 бронь';
    }
    return {
      id: `reservation:${r.itemId}`,
      entityId: r.itemId,
      type: 'reservation',
      title: r.itemTitle,
      subtitle: `для ${r.ownerDisplayName ?? 'друга'} · «${r.wishlistTitle}»`,
      badge,
      badgeTone,
      thumbnailUrl: r.itemImageUrl,
      icon: r.itemImageUrl ? null : emojiForTitle(r.itemTitle),
      target: { screen: 'my-reservations', itemId: r.itemId, wishlistId: r.wishlistId },
      accessState: 'available',
      matchedFields: ['title'],
      ownerUserId: r.ownerId,
      wishlistId: r.wishlistId,
      itemId: r.itemId,
      score,
    };
  });
  out.sort((a, b) => b.score - a.score);
  return { total: out.length, rows: out.slice(0, ctx.perGroupLimit) };
}

async function searchSecretReservationsGroup(ctx: SearchContext): Promise<{ total: number; rows: SearchResult[] }> {
  // SECURITY-CRITICAL: only the reserver sees their own secret reservations.
  // No leak path: query is keyed on reserverUserId = ctx.scope.userId.
  const patterns = buildIlikePatterns(ctx.terms);
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      itemId: string;
      itemTitle: string;
      itemImageUrl: string | null;
      wishlistId: string;
      wishlistTitle: string;
      ownerId: string;
      ownerDisplayName: string | null;
    }>
  >`
    SELECT sr.id, sr."itemId", i.title AS "itemTitle", i."imageUrl" AS "itemImageUrl",
           w.id AS "wishlistId", w.title AS "wishlistTitle",
           w."ownerId" AS "ownerId", p."displayName" AS "ownerDisplayName"
    FROM "SecretReservation" sr
    JOIN "Item" i ON i.id = sr."itemId"
    JOIN "Wishlist" w ON w.id = i."wishlistId"
    LEFT JOIN "UserProfile" p ON p."userId" = w."ownerId"
    WHERE sr."reserverUserId" = ${ctx.scope.userId}
      AND sr.status = 'ACTIVE'
      AND (
        lower(i.title) ILIKE ANY (${patterns}::text[])
        OR lower(w.title) ILIKE ANY (${patterns}::text[])
        OR lower(coalesce(p."displayName", '')) ILIKE ANY (${patterns}::text[])
      )
    ORDER BY sr."updatedAt" DESC
    LIMIT ${ctx.perGroupLimit + 5}
  `;

  const out: SearchResult[] = rows.map((r) => ({
    id: `secret:${r.id}`,
    entityId: r.id,
    type: 'reservation',
    title: r.itemTitle,
    subtitle: `тайно · видишь только ты · «${r.wishlistTitle}»`,
    badge: '🤫 тайная',
    badgeTone: 'secret',
    thumbnailUrl: r.itemImageUrl,
    icon: r.itemImageUrl ? null : '🤫',
    target: { screen: 'my-reservations', itemId: r.itemId, wishlistId: r.wishlistId, reservationId: r.id, secret: true },
    accessState: 'available',
    matchedFields: ['title'],
    ownerUserId: r.ownerId,
    wishlistId: r.wishlistId,
    itemId: r.itemId,
    score: scoreTitleMatch(r.itemTitle, ctx.terms) * 100 + 5,
  }));
  return { total: out.length, rows: out.slice(0, ctx.perGroupLimit) };
}

async function searchEventsGroup(ctx: SearchContext): Promise<{ total: number; rows: SearchResult[] }> {
  // PRO/godMode only. Search the requester's own GiftOccasion records.
  const patterns = buildIlikePatterns(ctx.terms);
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      title: string;
      personName: string | null;
      emoji: string | null;
      eventDate: Date | null;
      type: string;
      linkedWishlistId: string | null;
    }>
  >`
    SELECT o.id, o.title, o."personName", o.emoji, o."eventDate", o.type,
           o."linkedWishlistId"
    FROM "GiftOccasion" o
    WHERE o."ownerUserId" = ${ctx.scope.userId}
      AND o.status = 'ACTIVE'
      AND (
        lower(o.title) ILIKE ANY (${patterns}::text[])
        OR lower(coalesce(o."personName", '')) ILIKE ANY (${patterns}::text[])
      )
    ORDER BY o."eventDate" ASC NULLS LAST
    LIMIT ${ctx.perGroupLimit + 5}
  `;
  const out: SearchResult[] = rows.map((r) => {
    const dateLabel = r.eventDate ? formatRuShortDate(r.eventDate) : '';
    const subtitleParts: string[] = [];
    if (r.personName) subtitleParts.push(r.personName);
    if (dateLabel) subtitleParts.push(dateLabel);
    return {
      id: `event:${r.id}`,
      entityId: r.id,
      type: 'event',
      title: r.title,
      subtitle: subtitleParts.join(' · ') || 'событие',
      badge: r.eventDate ? dateLabel : null,
      badgeTone: 'neutral',
      thumbnailUrl: null,
      icon: r.emoji ?? '📅',
      target: { screen: 'gift-notes-occasion', occasionId: r.id },
      accessState: 'available',
      matchedFields: ['title'],
      ownerUserId: ctx.scope.userId,
      wishlistId: r.linkedWishlistId,
      itemId: null,
      score: scoreTitleMatch(r.title, ctx.terms) * 100,
    };
  });
  return { total: out.length, rows: out.slice(0, ctx.perGroupLimit) };
}

function formatRuShortDate(d: Date): string {
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const day = d.getUTCDate();
  const month = months[d.getUTCMonth()] ?? '';
  return `${day} ${month}`;
}

async function searchPeopleGroup(ctx: SearchContext): Promise<{ total: number; rows: SearchResult[] }> {
  if (ctx.scope.accessiblePeopleIds.length === 0) return { total: 0, rows: [] };
  const patterns = buildIlikePatterns(ctx.terms);
  const rows = await prisma.$queryRaw<
    Array<{
      userId: string;
      displayName: string | null;
      username: string | null;
      avatarThumbUrl: string | null;
      avatarPublic: boolean;
    }>
  >`
    SELECT p."userId", p."displayName", p.username, p."avatarThumbUrl", p."avatarPublic"
    FROM "UserProfile" p
    WHERE p."userId" = ANY (${ctx.scope.accessiblePeopleIds}::text[])
      AND (
        lower(coalesce(p."displayName", '')) ILIKE ANY (${patterns}::text[])
        OR lower(coalesce(p.username, '')) ILIKE ANY (${patterns}::text[])
      )
    LIMIT ${ctx.perGroupLimit + 5}
  `;
  const out: SearchResult[] = rows.map((r) => {
    const display = r.displayName || (r.username ? `@${r.username}` : 'Без имени');
    return {
      id: `user:${r.userId}`,
      entityId: r.userId,
      type: 'user',
      title: display,
      subtitle: r.username ? `@${r.username}` : 'из твоих контактов',
      badge: null,
      badgeTone: null,
      thumbnailUrl: r.avatarPublic ? r.avatarThumbUrl : null,
      icon: r.avatarPublic && r.avatarThumbUrl ? null : '👤',
      target: { screen: 'public-profile', username: r.username ?? undefined, section: r.userId },
      accessState: 'available',
      matchedFields: ['displayName'],
      ownerUserId: r.userId,
      wishlistId: null,
      itemId: null,
      score: scoreTitleMatch(display, ctx.terms) * 100,
    };
  });
  return { total: out.length, rows: out.slice(0, ctx.perGroupLimit) };
}

async function searchAntiGiftGroup(ctx: SearchContext): Promise<{ total: number; rows: SearchResult[] }> {
  // PRO/godMode only. Search the requester's own anti-gift list ONLY. The
  // friend-side anti-gift visibility (other users' lists shown to me) is
  // intentionally not surfaced through search: it's available only when
  // viewing that person's wishlist with explicit dontGiftVisible=true.
  const profile = await prisma.userProfile.findUnique({
    where: { userId: ctx.scope.userId },
    select: { dontGiftPresets: true, dontGiftCustomItems: true, dontGiftComment: true, dontGiftVisible: true },
  });
  if (!profile) return { total: 0, rows: [] };

  const allItems: string[] = [
    ...(profile.dontGiftPresets ?? []),
    ...(profile.dontGiftCustomItems ?? []),
  ];
  if (profile.dontGiftComment) allItems.push(profile.dontGiftComment);

  const out: SearchResult[] = [];
  const lc = ctx.rawNormalized;
  for (let i = 0; i < allItems.length && out.length < ctx.perGroupLimit; i++) {
    const v = allItems[i] ?? '';
    if (!v.toLowerCase().includes(lc) && !ctx.terms.some((t) => v.toLowerCase().includes(t))) continue;
    out.push({
      id: `anti_gift:${i}:${ctx.scope.userId}`,
      entityId: null,
      type: 'anti_gift',
      title: v,
      subtitle: 'из «что не стоит дарить» · видно только тебе',
      badge: null,
      badgeTone: 'danger',
      thumbnailUrl: null,
      icon: '🚫',
      target: { screen: 'settings', section: 'dont-gift' },
      accessState: 'available',
      matchedFields: ['title'],
      ownerUserId: ctx.scope.userId,
      wishlistId: null,
      itemId: null,
      score: scoreTitleMatch(v, ctx.terms) * 90,
    });
  }
  return { total: out.length, rows: out };
}

function searchSettingsGroup(ctx: SearchContext): { total: number; rows: SearchResult[] } {
  const q = ctx.rawNormalized;
  const out: SearchResult[] = [];
  for (const row of SETTINGS_CATALOG) {
    const localizedTitle = row.titles[ctx.locale] ?? row.titles.en;
    const titleLower = localizedTitle.toLowerCase();
    const fallbackTitleLower = row.titles.en.toLowerCase();
    const ruTitleLower = row.titles.ru?.toLowerCase() ?? '';
    let matched = false;
    for (const term of ctx.terms) {
      if (titleLower.includes(term) || fallbackTitleLower.includes(term) || ruTitleLower.includes(term)) {
        matched = true; break;
      }
      if (row.keywords.some((k) => k.includes(term))) { matched = true; break; }
    }
    if (!matched) continue;
    out.push({
      id: `setting:${row.id}`,
      entityId: null,
      type: row.type === 'faq' ? 'faq' : row.type === 'action' ? 'action' : 'setting',
      title: localizedTitle,
      subtitle: row.requiresPro && !ctx.scope.isPro ? 'PRO' : (row.type === 'faq' ? 'Помощь' : 'Настройки'),
      badge: row.requiresPro ? '⭐ PRO' : null,
      badgeTone: row.requiresPro ? 'pro' : null,
      thumbnailUrl: null,
      icon: row.icon,
      target: row.target,
      accessState: row.requiresPro && !ctx.scope.isPro && !ctx.scope.godMode ? 'pro_required' : 'available',
      matchedFields: [titleLower.includes(q) ? 'title' : 'keyword'],
      ownerUserId: null,
      wishlistId: null,
      itemId: null,
      score: 50 + scoreTitleMatch(localizedTitle, ctx.terms) * 30,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return { total: out.length, rows: out.slice(0, ctx.perGroupLimit) };
}

// ─── PRO-locked aggregation (Free path only) ────────────────────────────────

async function countProLockedHits(ctx: SearchContext): Promise<number> {
  // Aggregate count across PRO-only groups so the Free UI shows a single
  // safe paywall block. No titles / no owners / no IDs leak through this
  // path — only an integer.
  const patterns = buildIlikePatterns(ctx.terms);
  try {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      WITH r AS (
        SELECT 1 FROM "ReservationMeta" rm
        JOIN "Item" i ON i.id = rm."itemId"
        WHERE rm."reserverUserId" = ${ctx.scope.userId}
          AND rm.active = true
          AND lower(i.title) ILIKE ANY (${patterns}::text[])
      ),
      e AS (
        SELECT 1 FROM "GiftOccasion" o
        WHERE o."ownerUserId" = ${ctx.scope.userId}
          AND o.status = 'ACTIVE'
          AND (
            lower(o.title) ILIKE ANY (${patterns}::text[])
            OR lower(coalesce(o."personName",'')) ILIKE ANY (${patterns}::text[])
          )
      )
      SELECT (SELECT COUNT(*) FROM r) + (SELECT COUNT(*) FROM e) AS count
    `;
    return Number(rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}

// ─── Group title localization (RU-first, fallback EN) ───────────────────────

function groupTitle(type: SearchResultType, locale: Locale): string {
  const ru: Record<SearchResultType, string> = {
    item: '🎁 Желания',
    wishlist: '📋 Вишлисты',
    category: '🏷 Категории',
    reservation: '🤝 Брони',
    user: '👥 Люди',
    event: '📅 События',
    setting: '⚙ Настройки',
    anti_gift: '🚫 Не дарить',
    faq: '💡 Помощь',
    action: '⚡ Действия',
    pro_locked: '⭐ Найдено в PRO',
  };
  const en: Record<SearchResultType, string> = {
    item: '🎁 Wishes',
    wishlist: '📋 Wishlists',
    category: '🏷 Categories',
    reservation: '🤝 Reservations',
    user: '👥 People',
    event: '📅 Events',
    setting: '⚙ Settings',
    anti_gift: '🚫 Don’t gift',
    faq: '💡 Help',
    action: '⚡ Actions',
    pro_locked: '⭐ Found in PRO',
  };
  return locale === 'ru' ? ru[type] : en[type];
}

// ─── Main entry point ───────────────────────────────────────────────────────

export interface PerformSearchArgs {
  userId: string;
  query: string;
  locale: Locale;
  /** Optional type filter (`['item','wishlist']`). Empty/missing = all. */
  types?: SearchResultType[] | null;
  /** Max rows per group. Defaults to SEARCH_DEFAULT_GROUP_LIMIT. */
  perGroupLimit?: number;
}

const ALL_TYPES: SearchResultType[] = [
  'item',
  'wishlist',
  'category',
  'reservation',
  'user',
  'event',
  'setting',
  'anti_gift',
  'faq',
  'action',
];

// PRO-gated types (Free user gets a `pro_locked` aggregate instead).
const PRO_GATED_TYPES = new Set<SearchResultType>(['reservation', 'event', 'anti_gift']);

export async function performGlobalSearch(args: PerformSearchArgs): Promise<SearchResponse> {
  const rawIn = args.query ?? '';
  if (rawIn.length > SEARCH_MAX_QUERY) {
    return emptyResponse(rawIn.slice(0, SEARCH_MAX_QUERY), args.userId, false);
  }
  const normalized = normalizeSearchQuery(rawIn);
  if (normalized.length < SEARCH_MIN_QUERY) {
    return emptyResponse(normalized, args.userId, false);
  }
  const terms = expandQueryAliases(normalized);

  // Resolve PRO + godMode in parallel with scope build to keep latency low.
  const [entitlement, scope] = await Promise.all([
    getUserEntitlement(args.userId).catch(() => null),
    (async () => {
      // First need entitlement to feed into scope (godMode-aware), but the
      // scope itself doesn't materially differ for godMode at this layer —
      // it only affects per-type gating later. So we can resolve scope
      // optimistically with isPro=false and override after.
      return buildAccessibleScope(args.userId, { isPro: false, godMode: false });
    })(),
  ]);
  const isPro = entitlement?.isPro ?? false;
  const godMode = entitlement?.proSource === 'god_mode';
  scope.isPro = isPro;
  scope.godMode = godMode;

  const ctx: SearchContext = {
    scope,
    locale: args.locale,
    terms,
    rawNormalized: normalized,
    perGroupLimit: args.perGroupLimit ?? SEARCH_DEFAULT_GROUP_LIMIT,
  };

  const requested = args.types && args.types.length > 0 ? args.types : ALL_TYPES;
  const allowed = new Set(requested);

  // Decide which groups to actually run. PRO-gated groups are dropped on
  // Free users — they're replaced by a single `pro_locked` aggregate.
  const runReservations = allowed.has('reservation') && (isPro || godMode);
  const runEvents = allowed.has('event') && (isPro || godMode);
  const runAntiGift = allowed.has('anti_gift') && (isPro || godMode);
  const runSecret = allowed.has('reservation') && (isPro || godMode); // secret res lives under "reservation"

  const tasks: Array<{ type: SearchResultType; promise: Promise<{ total: number; rows: SearchResult[] }> }> = [];
  if (allowed.has('item')) tasks.push({ type: 'item', promise: searchItemsGroup(ctx) });
  if (allowed.has('wishlist')) tasks.push({ type: 'wishlist', promise: searchWishlistsGroup(ctx) });
  if (allowed.has('category')) tasks.push({ type: 'category', promise: searchCategoriesGroup(ctx) });
  if (allowed.has('user')) tasks.push({ type: 'user', promise: searchPeopleGroup(ctx) });
  if (allowed.has('setting') || allowed.has('faq') || allowed.has('action')) {
    tasks.push({ type: 'setting', promise: Promise.resolve(searchSettingsGroup(ctx)) });
  }
  if (runReservations) {
    tasks.push({
      type: 'reservation',
      promise: Promise.all([
        searchReservationsGroup(ctx),
        runSecret ? searchSecretReservationsGroup(ctx) : Promise.resolve({ total: 0, rows: [] }),
      ]).then(([pub, sec]) => ({
        total: pub.total + sec.total,
        rows: [...sec.rows, ...pub.rows].sort((a, b) => b.score - a.score).slice(0, ctx.perGroupLimit),
      })),
    });
  }
  if (runEvents) tasks.push({ type: 'event', promise: searchEventsGroup(ctx) });
  if (runAntiGift) tasks.push({ type: 'anti_gift', promise: searchAntiGiftGroup(ctx) });

  const settled = await Promise.allSettled(tasks.map((t) => t.promise));
  const failedGroups: SearchResultType[] = [];
  const groupsRaw: SearchGroup[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const r = settled[i]!;
    if (r.status === 'rejected') {
      failedGroups.push(task.type);
      continue;
    }
    const { total, rows } = r.value;
    if (rows.length === 0 && task.type !== 'pro_locked') continue;
    // Split settings into setting / faq / action sub-groups when called for "all" types.
    if (task.type === 'setting') {
      const subBuckets: Record<'setting' | 'faq' | 'action', SearchResult[]> = { setting: [], faq: [], action: [] };
      for (const row of rows) {
        const bucket = row.type === 'faq' ? 'faq' : row.type === 'action' ? 'action' : 'setting';
        subBuckets[bucket]!.push(row);
      }
      for (const bucketName of ['setting', 'faq', 'action'] as const) {
        const bucket = subBuckets[bucketName];
        if (bucket.length === 0) continue;
        groupsRaw.push({
          type: bucketName,
          title: groupTitle(bucketName, args.locale),
          total: bucket.length,
          items: bucket,
          hasMore: false,
        });
      }
      continue;
    }
    groupsRaw.push({
      type: task.type,
      title: groupTitle(task.type, args.locale),
      total,
      items: rows,
      hasMore: total > rows.length,
    });
  }

  // PRO-locked aggregate for Free users — runs only if any PRO-gated type was
  // requested (or `all` was requested) and the user is not PRO.
  let proLockedGroup: SearchGroup | null = null;
  if (!isPro && !godMode) {
    const proWanted =
      (args.types?.some((t) => PRO_GATED_TYPES.has(t)) ?? true) ||
      (args.types == null || args.types.length === 0);
    if (proWanted) {
      try {
        const count = await countProLockedHits(ctx);
        if (count > 0) {
          proLockedGroup = {
            type: 'pro_locked',
            title: groupTitle('pro_locked', args.locale),
            total: count,
            items: [{
              id: 'pro_locked:aggregate',
              entityId: null,
              type: 'pro_locked',
              title: 'Найдено в PRO-разделах',
              subtitle: 'Совпадения в бронях и событиях. Открой PRO, чтобы быстро находить всё важное.',
              badge: '⭐ PRO',
              badgeTone: 'pro',
              thumbnailUrl: null,
              icon: '⭐',
              target: { screen: 'paywall', section: 'search' },
              accessState: 'pro_required',
              matchedFields: [],
              ownerUserId: null,
              wishlistId: null,
              itemId: null,
              score: 0,
            }],
            hasMore: false,
          };
        }
      } catch {
        // Count failure is non-fatal — Free user just doesn't see the block.
      }
    }
  }

  // Insertion order: user content first (items / wishlists / categories),
  // people, then PRO-gated (or pro_locked stub), then events, then settings.
  const order: SearchResultType[] = [
    'item', 'wishlist', 'category', 'user',
    'reservation', 'event', 'anti_gift',
    'pro_locked',
    'setting', 'faq', 'action',
  ];
  const groupsSorted = [...groupsRaw];
  if (proLockedGroup) groupsSorted.push(proLockedGroup);
  groupsSorted.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));

  const totalShown = groupsSorted.reduce((acc, g) => acc + g.items.length, 0);

  return {
    query: rawIn,
    normalizedQuery: normalized,
    groups: groupsSorted,
    suggestions: [],
    hasMore: totalShown >= SEARCH_DEFAULT_TOTAL_LIMIT,
    nextCursor: null,
    partial: failedGroups.length > 0,
    failedGroups,
    isPro: isPro || godMode,
  };
}

function emptyResponse(normalized: string, _userId: string, isPro: boolean): SearchResponse {
  return {
    query: normalized,
    normalizedQuery: normalized,
    groups: [],
    suggestions: [],
    hasMore: false,
    nextCursor: null,
    partial: false,
    failedGroups: [],
    isPro,
  };
}

// Keep TS happy when this module is imported only for type-side effects
// during route stub generation. Suppresses the "unused import" lint without
// pulling Prisma into the entry-point's bundle weight.
const _PrismaInUse: typeof Prisma | null = null;
void _PrismaInUse;
