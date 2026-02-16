import Link from 'next/link';

export default function WishlistNotFound() {
  return (
    <main className="grid gap-6">
      <div className="rounded-3xl border border-slate-200/80 bg-white/70 p-10 shadow-soft backdrop-blur">
        <h1 className="font-display text-3xl tracking-tight text-slate-900">Вишлист не найден</h1>
        <p className="mt-3 text-slate-600">
          Проверьте ссылку. Возможно, список был удален или slug указан неверно.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-xl bg-cyan-700 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-cyan-800 focus:outline-none focus:ring-2 focus:ring-cyan-600/50"
          >
            На главную
          </Link>
        </div>
      </div>
    </main>
  );
}

