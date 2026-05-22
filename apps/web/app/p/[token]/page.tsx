import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import CuratedSelectionClient from './CuratedSelectionClient';

type PageProps = {
  params: Promise<{ token: string }>;
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

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const params = await props.params;
  try {
    const result = await fetchSelection(params.token);
    if (!result || result.expired) return { title: 'WishBoard' };
    const sel = result.data.selection;
    return {
      title: `${sel.title} — WishBoard`,
      description: `${sel.itemCount} wishes shared via WishBoard`,
    };
  } catch {
    return { title: 'WishBoard' };
  }
}

export default async function CuratedSelectionPage(props: PageProps) {
  const params = await props.params;
  const result = await fetchSelection(params.token);
  if (!result) notFound();
  return <CuratedSelectionClient expired={result.expired} data={result.data} token={params.token} />;
}
