import Link from 'next/link';
import { getWishlists } from '@/lib/admin-api-client';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  let wishlists: Awaited<ReturnType<typeof getWishlists>>['wishlists'] = [];
  let error: string | null = null;

  try {
    const data = await getWishlists();
    wishlists = data.wishlists;
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load wishlists';
    wishlists = [];
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-6">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl font-bold tracking-tight text-slate-900">
              Admin Panel
            </h1>
            <p className="mt-2 text-slate-600">Manage your wishlists, items and tags</p>
          </div>

          <Link
            href="/admin/new"
            className="inline-flex items-center justify-center rounded-xl bg-cyan-700 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-cyan-800 focus:outline-none focus:ring-2 focus:ring-cyan-600/50"
          >
            + Create Wishlist
          </Link>
        </header>

        {error && (
          <div className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            <strong>Error:</strong> {error}
          </div>
        )}

        {wishlists.length === 0 && !error && (
          <div className="rounded-3xl border border-slate-200 bg-white p-10 text-center shadow-sm">
            <p className="text-slate-600">No wishlists yet.</p>
            <Link
              href="/admin/new"
              className="mt-4 inline-flex items-center text-cyan-700 hover:underline"
            >
              Create your first wishlist →
            </Link>
          </div>
        )}

        {wishlists.length > 0 && (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {wishlists.map((wl) => (
              <article
                key={wl.id}
                className="flex flex-col rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition hover:shadow-md"
              >
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-slate-900">{wl.title}</h2>

                  {wl.description && (
                    <p className="mt-2 line-clamp-2 text-sm text-slate-600">{wl.description}</p>
                  )}

                  <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <dt className="text-slate-500">Items</dt>
                      <dd className="font-semibold text-slate-900">{wl._count?.items ?? 0}</dd>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <dt className="text-slate-500">Tags</dt>
                      <dd className="font-semibold text-slate-900">{wl._count?.tags ?? 0}</dd>
                    </div>
                  </dl>

                  <p className="mt-3 text-xs text-slate-500">
                    <span className="font-mono">/w/{wl.slug}</span>
                  </p>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Link
                    href={`/w/${wl.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex flex-1 items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-50"
                  >
                    View Public
                  </Link>
                  <Link
                    href={`/admin/${wl.id}`}
                    className="inline-flex flex-1 items-center justify-center rounded-xl bg-cyan-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-cyan-800"
                  >
                    Edit
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}

        <footer className="mt-8 text-center text-sm text-slate-500">
          <Link href="/" className="hover:text-cyan-700 hover:underline">
            ← Back to home
          </Link>
        </footer>
      </div>
    </main>
  );
}
