/**
 * API client for bot: all requests send X-ADMIN-KEY and X-Telegram-User-Id
 * so the API resolves owner by Telegram user (getRequestOwner).
 */
const API_BASE_URL = (process.env.API_BASE_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY ?? '';
const DEFAULT_ITEM_URL = (process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

export type Wishlist = { id: string; slug: string; title: string; description: string | null };
export type Item = {
  id: string;
  title: string;
  url: string;
  priceText: string | null;
  priority: string;
  status: string;
  createdAt: string;
};

async function request<T>(
  method: string,
  path: string,
  telegramId: string,
  body?: unknown,
): Promise<{ data?: T; error?: string; status: number }> {
  const url = `${API_BASE_URL}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-ADMIN-KEY': ADMIN_KEY,
    'X-Telegram-User-Id': telegramId,
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error', status: 0 };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { error: 'Invalid response', status: res.status };
  }
  if (!res.ok) {
    const err = data && typeof data === 'object' && 'error' in data ? String((data as { error: string }).error) : res.statusText;
    return { error: err, status: res.status };
  }
  return { data: data as T, status: res.status };
}

export async function getMyWishlists(telegramId: string): Promise<{ wishlists: Wishlist[] } | { error: string }> {
  const out = await request<{ wishlists: Wishlist[] }>('GET', '/wishlists', telegramId);
  if (out.error) return { error: out.error };
  return { wishlists: out.data!.wishlists };
}

export async function createWishlist(
  telegramId: string,
  title: string,
  slug?: string,
  description?: string,
): Promise<{ wishlist: Wishlist } | { error: string }> {
  const body: { title: string; slug?: string; description?: string } = { title };
  if (slug) body.slug = slug;
  if (description) body.description = description;
  const out = await request<{ wishlist: Wishlist }>('POST', '/wishlists', telegramId, body);
  if (out.error) return { error: out.error };
  return { wishlist: out.data!.wishlist };
}

export async function getPublicWishlist(slug: string): Promise<
  | { wishlist: { id: string; slug: string; title: string; description: string | null }; items: Item[] }
  | { error: string }
> {
  const url = `${API_BASE_URL}/public/wishlists/${encodeURIComponent(slug)}`;
  try {
    const res = await fetch(url);
    const data = (await res.json()) as { wishlist?: unknown; items?: Item[] };
    if (!res.ok) return { error: (data as { error?: string }).error ?? res.statusText };
    return { wishlist: data.wishlist as Wishlist, items: data.items ?? [] };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error' };
  }
}

export async function addItem(
  telegramId: string,
  wishlistId: string,
  title: string,
  url: string = DEFAULT_ITEM_URL,
  priceText?: string,
  priority?: 'LOW' | 'MEDIUM' | 'HIGH',
): Promise<{ item: Item } | { error: string }> {
  const body: { title: string; url: string; priceText?: string; priority?: string } = { title, url };
  if (priceText) body.priceText = priceText;
  if (priority) body.priority = priority;
  const out = await request<{ item: Item }>('POST', `/wishlists/${wishlistId}/items`, telegramId, body);
  if (out.error) return { error: out.error };
  return { item: out.data!.item };
}

export function getDefaultItemUrl(): string {
  return DEFAULT_ITEM_URL;
}
