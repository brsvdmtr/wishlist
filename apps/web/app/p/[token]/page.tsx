import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import CuratedSelectionClient from './CuratedSelectionClient';

type PageProps = {
  params: { token: string };
};

function apiBaseUrl() {
  const raw = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';
  return raw.replace(/\/+$/, '');
}

async function fetchSelection(token: string) {
  const res = await fetch(`${apiBaseUrl()}/public/selections/${encodeURIComponent(token)}`, {
    cache: 'no-store',
  });

  if (res.status === 404) return null;
  if (res.status === 410) return { expired: true, data: await res.json() };
  if (!res.ok) throw new Error(`Failed to load selection: ${res.status}`);

  return { expired: false, data: await res.json() };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  try {
    const result = await fetchSelection(params.token);
    if (!result || result.expired) return { title: 'WishBoard — Curated Selection' };
    const sel = result.data.selection;
    return {
      title: `${sel.title} — WishBoard`,
      description: `Curated selection: ${sel.itemCount} wishes`,
    };
  } catch {
    return { title: 'WishBoard' };
  }
}

export default async function CuratedSelectionPage({ params }: PageProps) {
  const result = await fetchSelection(params.token);
  if (!result) notFound();
  return <CuratedSelectionClient expired={result.expired} data={result.data} />;
}
