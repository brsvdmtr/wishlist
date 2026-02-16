'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createWishlist } from '@/lib/admin-api-client';

export default function NewWishlistPage() {
  const router = useRouter();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const { wishlist } = await createWishlist({
        title: title.trim(),
        description: description.trim() || undefined,
      });

      // Redirect to edit page
      router.push(`/admin/${wishlist.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create wishlist');
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-6">
      <div className="mx-auto max-w-2xl">
        <header className="mb-8">
          <Link
            href="/admin"
            className="inline-flex items-center text-sm text-slate-600 hover:text-cyan-700"
          >
            ← Back to dashboard
          </Link>

          <h1 className="mt-4 font-display text-3xl font-bold tracking-tight text-slate-900">
            Create New Wishlist
          </h1>
          <p className="mt-2 text-slate-600">
            Add a title and description. Slug will be generated automatically.
          </p>
        </header>

        {error && (
          <div className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            <strong>Error:</strong> {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="grid gap-6">
            <label className="grid gap-2">
              <span className="text-sm font-semibold text-slate-900">
                Title <span className="text-rose-600">*</span>
              </span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                minLength={1}
                maxLength={200}
                placeholder="My Birthday Wishlist"
                className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-900 outline-none ring-0 transition focus:border-cyan-300 focus:ring-2 focus:ring-cyan-200"
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-semibold text-slate-900">Description (optional)</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
                rows={4}
                placeholder="A list of things I'd love to receive for my birthday..."
                className="resize-none rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-900 outline-none ring-0 transition focus:border-cyan-300 focus:ring-2 focus:ring-cyan-200"
              />
              <span className="text-xs text-slate-500">{description.length} / 2000</span>
            </label>
          </div>

          <div className="mt-8 flex flex-wrap justify-end gap-3">
            <Link
              href="/admin"
              className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-900 transition hover:bg-slate-50"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={loading || !title.trim()}
              className="inline-flex items-center justify-center rounded-xl bg-cyan-700 px-5 py-3 text-sm font-semibold text-white transition hover:bg-cyan-800 disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Wishlist'}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
