import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import WishlistClient from './WishlistClient';

type PageProps = {
  params: { slug: string };
};

function apiBaseUrl() {
  const raw = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';
  return raw.replace(/\/+$/, '');
}

// Memoised per request — generateMetadata and WishlistPage share the same fetch result.
const fetchWishlist = cache(async (slug: string) => {
  const res = await fetch(`${apiBaseUrl()}/public/wishlists/${encodeURIComponent(slug)}`, {
    cache: 'no-store',
  });

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load wishlist: ${res.status}`);

  return (await res.json()) as unknown;
});

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const slug = params.slug;

  try {
    const data = (await fetchWishlist(slug)) as
      | { wishlist: { title: string; description: string | null } }
      | null;
    if (!data) return { title: 'Вишлист не найден' };

    return {
      title: data.wishlist.title,
      description: data.wishlist.description ?? undefined,
    };
  } catch {
    return { title: 'WishList' };
  }
}

export default async function WishlistPage({ params }: PageProps) {
  const slug = params.slug;
  const data = await fetchWishlist(slug);
  if (!data) notFound();

  return <WishlistClient slug={slug} initialData={data} />;
}
