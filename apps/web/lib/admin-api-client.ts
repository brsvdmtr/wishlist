/**
 * Client-side API helper for admin operations
 * 
 * SECURITY: This code runs in the browser, but NEVER sends ADMIN_KEY.
 * All requests go through Next.js route handlers (/api/admin/*),
 * which add ADMIN_KEY on the server side.
 */

export type Wishlist = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: { items: number; tags: number };
};

export type Item = {
  id: string;
  wishlistId: string;
  title: string;
  url: string;
  priceText: string | null;
  commentOwner: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  deadline: string | null;
  imageUrl: string | null;
  status: 'AVAILABLE' | 'RESERVED' | 'PURCHASED';
  createdAt: string;
  updatedAt: string;
  tags?: { id: string; name: string }[];
};

export type Tag = {
  id: string;
  wishlistId: string;
  name: string;
  createdAt: string;
};

const handleResponse = async <T>(res: Response): Promise<T> => {
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || `HTTP ${res.status}`);
  }
  return res.json();
};

// === Wishlists ===

export async function getWishlists(): Promise<{ wishlists: Wishlist[] }> {
  const res = await fetch('/api/admin/wishlists', { cache: 'no-store' });
  return handleResponse(res);
}

export async function getWishlist(id: string): Promise<{
  wishlist: Wishlist;
  items: Item[];
  tags: Tag[];
}> {
  const res = await fetch(`/api/admin/wishlists/${id}`, { cache: 'no-store' });
  return handleResponse(res);
}

export async function createWishlist(data: {
  title: string;
  description?: string;
}): Promise<{ wishlist: Wishlist }> {
  const res = await fetch('/api/admin/wishlists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res);
}

export async function updateWishlist(
  id: string,
  data: { title?: string; description?: string | null },
): Promise<{ wishlist: Wishlist }> {
  const res = await fetch(`/api/admin/wishlists/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res);
}

export async function deleteWishlist(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`/api/admin/wishlists/${id}`, { method: 'DELETE' });
  return handleResponse(res);
}

// === Items ===

export async function getItems(
  wishlistId: string,
  filters?: { status?: string; tag?: string },
): Promise<{ items: Item[] }> {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.tag) params.set('tag', filters.tag);

  const query = params.toString();
  const url = `/api/admin/wishlists/${wishlistId}/items${query ? `?${query}` : ''}`;

  const res = await fetch(url, { cache: 'no-store' });
  return handleResponse(res);
}

export async function createItem(
  wishlistId: string,
  data: {
    title: string;
    url: string;
    priceText?: string;
    commentOwner?: string;
    priority?: 'LOW' | 'MEDIUM' | 'HIGH';
    deadline?: string;
    imageUrl?: string;
  },
): Promise<{ item: Item }> {
  const res = await fetch(`/api/admin/wishlists/${wishlistId}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res);
}

export async function updateItem(
  itemId: string,
  data: {
    title?: string;
    url?: string;
    priceText?: string | null;
    commentOwner?: string | null;
    priority?: 'LOW' | 'MEDIUM' | 'HIGH';
    deadline?: string | null;
    imageUrl?: string | null;
    status?: 'AVAILABLE' | 'RESERVED' | 'PURCHASED';
  },
): Promise<{ item: Item }> {
  const res = await fetch(`/api/admin/items/${itemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res);
}

export async function deleteItem(itemId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`/api/admin/items/${itemId}`, { method: 'DELETE' });
  return handleResponse(res);
}

// === Tags ===

export async function createTag(
  wishlistId: string,
  data: { name: string },
): Promise<{ tag: Tag }> {
  const res = await fetch(`/api/admin/wishlists/${wishlistId}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res);
}

export async function deleteTag(tagId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`/api/admin/tags/${tagId}`, { method: 'DELETE' });
  return handleResponse(res);
}
