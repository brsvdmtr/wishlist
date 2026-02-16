'use client';

import Link from 'next/link';
import { useEffect } from 'react';

export default function WishlistError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[web] wishlist page error', error);
  }, [error]);

  return (
    <main className="grid gap-6">
      <div className="rounded-3xl border border-slate-200/80 bg-white/70 p-10 shadow-soft backdrop-blur">
        <h1 className="font-display text-3xl tracking-tight text-slate-900">
          Не удалось загрузить вишлист
        </h1>
        <p className="mt-3 text-slate-600">
          Проверьте, что API запущено и доступно по{' '}
          <span className="font-mono">
            {process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001'}
          </span>
          .
        </p>
        <p className="mt-3 text-sm text-slate-600">
          Если вы в Safari: открывайте локально через{' '}
          <span className="font-mono">http://localhost:3000</span> (с префиксом <span className="font-mono">http://</span>),
          иначе браузер может подставить <span className="font-mono">www.localhost.com</span>.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-xl bg-cyan-700 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-cyan-800 focus:outline-none focus:ring-2 focus:ring-cyan-600/50"
            onClick={() => reset()}
          >
            Попробовать еще раз
          </button>
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-cyan-600/30"
          >
            На главную
          </Link>
        </div>
      </div>
    </main>
  );
}

