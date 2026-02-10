import Link from 'next/link';

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

export default function Home() {
  return (
    <main className="grid gap-10">
      <section className="rounded-3xl border border-slate-200/80 bg-white/70 p-10 shadow-soft backdrop-blur">
        <p className="text-sm font-medium text-slate-600">WishList</p>
        <h1 className="mt-3 font-display text-4xl leading-tight tracking-tight text-slate-900 sm:text-5xl">
          Публичные вишлисты без лишнего
        </h1>
        <p className="mt-4 max-w-2xl text-slate-600">
          Откройте список подарков по ссылке и отметьте, что вы берете на себя. Без регистрации, с
          простым резервом.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/w/demo"
            className="inline-flex items-center justify-center rounded-xl bg-cyan-700 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-cyan-800 focus:outline-none focus:ring-2 focus:ring-cyan-600/50"
          >
            Открыть демо
          </Link>
          <a
            href={`${apiBaseUrl}/health`}
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-cyan-600/30"
          >
            Проверить API health
          </a>
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200/80 bg-white/70 p-8 shadow-soft backdrop-blur">
        <h2 className="font-display text-2xl tracking-tight text-slate-900">Как это работает</h2>
        <ol className="mt-4 grid gap-4 text-slate-700 sm:grid-cols-3">
          <li className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="text-sm font-semibold text-slate-900">1. Откройте вишлист</p>
            <p className="mt-2 text-sm text-slate-600">Список доступен по короткому slug в URL.</p>
          </li>
          <li className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="text-sm font-semibold text-slate-900">2. Забронируйте</p>
            <p className="mt-2 text-sm text-slate-600">
              Нажмите “Забронировать”, чтобы другие видели, что подарок занят.
            </p>
          </li>
          <li className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="text-sm font-semibold text-slate-900">3. Отметьте покупку</p>
            <p className="mt-2 text-sm text-slate-600">
              Когда купили, отметьте “Куплено” и оставьте комментарий.
            </p>
          </li>
        </ol>
      </section>
    </main>
  );
}
