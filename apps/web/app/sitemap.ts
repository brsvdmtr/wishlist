import type { MetadataRoute } from 'next';

const API_BASE = process.env.INTERNAL_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';
const SITE_URL = 'https://wishlistik.ru';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = [
    { url: SITE_URL, lastModified: new Date(), changeFrequency: 'weekly', priority: 1.0 },
  ];

  // Only index wishlists with visibility = PUBLIC_PROFILE
  // These are explicitly public by owner choice
  try {
    const res = await fetch(`${API_BASE}/internal/sitemap-wishlists`, {
      headers: { 'X-INTERNAL-KEY': process.env.BOT_TOKEN ?? '' },
      next: { revalidate: 3600 }, // refresh every hour
    });
    if (res.ok) {
      const data = (await res.json()) as Array<{ slug: string; updatedAt: string }>;
      for (const wl of data) {
        entries.push({
          url: `${SITE_URL}/w/${wl.slug}`,
          lastModified: new Date(wl.updatedAt),
          changeFrequency: 'weekly',
          priority: 0.7,
        });
      }
    }
  } catch {
    // Sitemap generation should never crash the build
  }

  return entries;
}
