// Global search API client.
//
// Thin layer over the tgFetch helper passed in from MiniApp.tsx. Mirrors
// the response shape from apps/api/src/services/search.ts (SearchResponse).
// Keeps types in this package so the FE doesn't import server-side modules.
//
// Privacy: the raw query stays in memory only. It is sent to the server in
// the GET query string (necessary for execution) but never logged client-side
// to telemetry. The server is responsible for never logging it either.

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

export type SearchAccessState = 'available' | 'restricted' | 'expired' | 'pro_required';

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
  id: string;
  entityId: string | null;
  type: SearchResultType;
  title: string;
  subtitle: string;
  badge: string | null;
  badgeTone:
    | 'neutral'
    | 'price'
    | 'reserved'
    | 'done'
    | 'secret'
    | 'pro'
    | 'warning'
    | 'danger'
    | null;
  thumbnailUrl: string | null;
  icon: string | null;
  target: SearchResultTarget;
  accessState: SearchAccessState;
  matchedFields: string[];
  ownerUserId: string | null;
  wishlistId: string | null;
  itemId: string | null;
  score: number;
}

export interface SearchGroup {
  type: SearchResultType;
  title: string;
  total: number;
  items: SearchResult[];
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
  isPro: boolean;
}

type TgFetch = (
  path: string,
  init?: RequestInit & {
    timeoutMs?: number;
    _retried?: boolean;
    idempotency?: string | { action: string };
  },
) => Promise<Response>;

export interface FetchSearchArgs {
  q: string;
  types?: SearchResultType[];
  limit?: number;
  signal?: AbortSignal;
}

/** GET /tg/search. Throws on network errors / non-2xx so callers can branch. */
export async function fetchSearch(tgFetch: TgFetch, args: FetchSearchArgs): Promise<SearchResponse> {
  const params = new URLSearchParams();
  params.set('q', args.q);
  if (args.types && args.types.length > 0) params.set('types', args.types.join(','));
  if (typeof args.limit === 'number') params.set('limit', String(args.limit));

  const res = await tgFetch(`/tg/search?${params.toString()}`, {
    method: 'GET',
    signal: args.signal,
    timeoutMs: 5000,
  });
  if (!res.ok) {
    throw new Error(`search_http_${res.status}`);
  }
  return (await res.json()) as SearchResponse;
}

/**
 * Fire-and-forget POST /tg/access/wishlist-opened. Records that this user
 * just opened a foreign wishlist; feeds into the global search scope.
 *
 * Auth: the endpoint REQUIRES valid Telegram initData via parent tgRouter
 * middleware. The server takes userId from the resolved tg user; the body
 * carries only wishlistId / source / sourceRef. Callers do not need to
 * pass a userId — the server ignores any client-supplied identity.
 *
 * `sourceRef` (optional) is a credential pin used by the server to detect
 * revocation later. Only used for credential-based sources:
 *   - source='share_link'        → pass the raw shareToken (server hashes it).
 *   - source='curated_selection' → pass the CuratedSelection id.
 *   - all other sources          → omit (relation-grounded).
 *
 * The promise never rejects — failures are swallowed so a non-critical
 * write can't break a screen mount.
 */
export async function recordWishlistOpen(
  tgFetch: TgFetch,
  args: { wishlistId: string; source: string; sourceRef?: string | null },
): Promise<void> {
  try {
    await tgFetch('/tg/access/wishlist-opened', {
      method: 'POST',
      body: JSON.stringify({
        wishlistId: args.wishlistId,
        source: args.source,
        ...(args.sourceRef ? { sourceRef: args.sourceRef } : {}),
      }),
    });
  } catch {
    // Non-critical — search feature degrades gracefully without this row.
  }
}

export interface AccessViewItem {
  id: string;
  title: string;
  description: string | null;
  url: string;
  priceText: string | null;
  imageUrl: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  status: 'AVAILABLE' | 'RESERVED' | 'PURCHASED';
  categoryId: string | null;
  position: number;
  reservedByDisplayName: string | null;
  reservedByActorHash: string | null;
}

export interface AccessViewResponse {
  wishlist: {
    id: string; slug: string; title: string; description: string | null;
    deadline: string | null;
    ownerName: string | null;
    ownerUsername: string | null;
    ownerAvatarUrl: string | null;
  };
  items: AccessViewItem[];
  categories: Array<{ id: string; name: string; sortOrder: number; isDefault: boolean }>;
  tags: Array<{ id: string; name: string }>;
  dontGift: { presets: string[]; customItems: string[]; comment: string | null } | null;
}

/**
 * GET /tg/wishlists/:id/access-view. Authenticated read of a foreign wishlist
 * the user has earned access to (via subscription / reservation / curated /
 * santa / profile / live share_link pin). Returns null on any non-2xx (the
 * call-site treats null as "not accessible" and shows a generic toast).
 */
export async function fetchAccessView(tgFetch: TgFetch, wishlistId: string): Promise<AccessViewResponse | null> {
  try {
    const res = await tgFetch(`/tg/wishlists/${encodeURIComponent(wishlistId)}/access-view`, {
      method: 'GET',
    });
    if (!res.ok) return null;
    return (await res.json()) as AccessViewResponse;
  } catch {
    return null;
  }
}
