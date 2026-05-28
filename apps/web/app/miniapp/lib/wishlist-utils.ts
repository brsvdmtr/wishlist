// Pure wishlist / item / user utilities extracted from MiniApp.tsx — F5.
// All helpers in this file are byte-stable copies of the originals; no
// closures, no React. Tested in wishlist-utils.test.ts.
//
// Each helper takes minimal structural types so this module does NOT
// import from MiniApp.tsx (would create a circular dep — MiniApp imports
// from lib/). Callers pass the full Wishlist / PlanInfo / Item value;
// TypeScript structural typing accepts it as long as the required fields
// are present.

/**
 * `Wishlist` shape — minimum needed for `getWritableTargets`. Mirrors the
 * field set in `MiniApp.tsx`'s exported `Wishlist` type. Structural typing
 * means callers can pass the full Wishlist value without a cast.
 */
export interface WishlistFilterShape {
  id: string;
  readOnly?: boolean;
}

/**
 * Filter wishlists to only valid writable targets for copy/move operations.
 * Excludes: current wishlist, drafts, readOnly wishlists.
 */
export function getWritableTargets<T extends WishlistFilterShape>(
  wishlists: T[],
  opts: { currentWlId?: string | null; draftsWlId?: string | null },
): T[] {
  return wishlists.filter(
    (wl) =>
      wl.id !== opts.draftsWlId &&
      wl.id !== opts.currentWlId &&
      !wl.readOnly,
  );
}

/**
 * Per-plan category quota (mirrors `categoriesPerWishlist` in
 * `apps/api/src/services/entitlement.ts` `PLANS`). Keep these in sync —
 * the API is the source of truth, but the FE needs the number to render
 * the counter and decide whether to open the create sheet or the upsell.
 * If a future plan (e.g. MAX) raises the limit, update both sides; the
 * server returns 402 if the FE-side check is stale.
 */
export const FREE_CATEGORY_LIMIT = 1;
// PRO is "unlimited categories" per Conservative pricing (2026-05-28). The
// sentinel matches the backend `PLANS.PRO.categoriesPerWishlist`; FE renders
// no counter for PRO (only FREE renders `used/limit`), so the large number
// is never user-visible.
export const PRO_CATEGORY_LIMIT = Number.MAX_SAFE_INTEGER;

/** Return the category quota for a plan code. */
export function categoryLimitFor(planCode: 'FREE' | 'PRO'): number {
  return planCode === 'PRO' ? PRO_CATEGORY_LIMIT : FREE_CATEGORY_LIMIT;
}

/**
 * Score an item for the recommended sort. Higher = better match.
 *
 * Used by the PRO `sort_recommended` filter on guest wishlist view.
 * Scoring breakdown:
 *   - Priority weight: 0/100/200 (low/medium/high)
 *   - Available (not reserved/purchased): +50
 *   - Has imageUrl: +10
 *   - Has url: +5
 *   - Has description: +5
 *   - Inside budget cap: bonus proportional to price / budgetMax
 */
export interface GuestRecommendedItemShape {
  priority: number;
  status: string;
  imageUrl?: string | null;
  url?: string | null;
  description?: string | null;
  price: number | null;
}
export function guestRecommendedScore(
  item: GuestRecommendedItemShape,
  budgetMax: number | null,
): number {
  let score = 0;
  score += (item.priority - 1) * 100;
  if (item.status === 'available') score += 50;
  if (item.imageUrl) score += 10;
  if (item.url) score += 5;
  if (item.description) score += 5;
  if (
    budgetMax !== null &&
    item.price !== null &&
    item.price > 0 &&
    item.price <= budgetMax
  ) {
    score += Math.round((item.price / budgetMax) * 15);
  }
  return score;
}

/** Reservation-state classification for a Santa receiver wishlist tile. */
export type SantaItemReservationState =
  | 'available'
  | 'reserved-by-me'
  | 'reserved-by-other';

/**
 * Resolve Santa-specific reservation state given the item status and the
 * caller's actor hash. Centralises the "is this reserved by me" comparison
 * so the receiver wishlist view and the secret-reservation polling stay
 * in sync.
 */
export function getSantaItemReservationState(
  status: string,
  reservedByActorHash: string | null,
  myActorHash: string | null,
): SantaItemReservationState {
  if (status !== 'reserved') return 'available';
  return myActorHash && reservedByActorHash === myActorHash
    ? 'reserved-by-me'
    : 'reserved-by-other';
}

/**
 * Decide whether to render a wish card in compact or showcase mode.
 *
 * - PRO users with an explicit `cardDisplayMode` override win.
 * - Otherwise we auto-select based on the number of items in the
 *   wishlist (>5 → compact, ≤5 → showcase).
 */
export function resolveCardMode(
  itemCount: number,
  cardDisplayMode: string | undefined,
  isPro: boolean,
): 'compact' | 'showcase' {
  if (isPro && cardDisplayMode === 'showcase') return 'showcase';
  if (isPro && cardDisplayMode === 'compact') return 'compact';
  return itemCount <= 5 ? 'showcase' : 'compact';
}

/**
 * Decode HTML entities (e.g. &quot; → ") and strip stray whitespace.
 * Runs client-side only (uses DOM textarea trick); returns the
 * server-safe cleanup on SSR.
 */
export function normalizeTitle(raw: string | null | undefined): string {
  if (!raw) return '';
  if (typeof window === 'undefined') return raw.replace(/\s+/g, ' ').trim();
  const el = document.createElement('textarea');
  el.innerHTML = raw;
  return el.value.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Canonical fallback chain for the wishlist owner's display name.
 * Priority: profile displayName → profile username → Telegram first_name →
 * `fallback` (default "Пользователь").
 *
 * Single source of truth used on the Share screen, Guest view, and any
 * context that shows the owner's name — never read tgUser.first_name
 * directly.
 */
export function resolveOwnerName(
  profile: { displayName?: string | null; username?: string | null } | null | undefined,
  tgUser: { first_name?: string | null; username?: string | null } | null | undefined,
  fallback = 'Пользователь',
): string {
  return (
    profile?.displayName?.trim() ||
    profile?.username?.trim() ||
    tgUser?.first_name?.trim() ||
    fallback
  );
}

/**
 * Derive a stable per-user "actor hash" from the Telegram user id.
 *
 * Used as an anonymous identifier for guest reservations on a wishlist:
 * the server compares this hash against the one stored when a guest
 * reserved an item, so a returning guest can see "you reserved this".
 *
 * Pure async helper — depends only on the platform `TextEncoder` and
 * `crypto.subtle.digest` globals (available in Telegram WebView).
 */
export async function computeActorHash(telegramId: number): Promise<string> {
  const data = new TextEncoder().encode(`tg_actor:${telegramId}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const h = [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
