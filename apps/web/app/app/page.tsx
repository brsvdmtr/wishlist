'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { AUTH_TOKEN_KEY } from '@/lib/auth';

function getApiBaseUrl() {
  return (process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
}

function getTelegramInitData(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const tw = (window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp;
  return tw?.initData;
}

export default function AppPage() {
  const [status, setStatus] = useState<'loading' | 'telegram' | 'no-telegram' | 'error'>('loading');
  const [user, setUser] = useState<{ id: string; telegramId: string | null } | null>(null);

  useEffect(() => {
    const initData = getTelegramInitData();

    if (!initData || !initData.trim()) {
      setStatus('no-telegram');
      return;
    }

    (window as unknown as { Telegram?: { WebApp?: { ready?: () => void; expand?: () => void } } }).Telegram?.WebApp?.ready?.();
    (window as unknown as { Telegram?: { WebApp?: { expand?: () => void } } }).Telegram?.WebApp?.expand?.();

    const apiBase = getApiBaseUrl();
    fetch(`${apiBase}/auth/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }),
    })
      .then((res) => {
        if (!res.ok) {
          setStatus('error');
          return;
        }
        return res.json() as Promise<{ token: string; user: { id: string; telegramId: string | null } }>;
      })
      .then((data) => {
        if (!data?.token) {
          setStatus('error');
          return;
        }
        try {
          localStorage.setItem(AUTH_TOKEN_KEY, data.token);
          setUser(data.user);
          setStatus('telegram');
        } catch {
          setStatus('error');
        }
      })
      .catch(() => setStatus('error'));
  }, []);

  if (status === 'loading') {
    return (
      <main className="flex min-h-[40vh] items-center justify-center">
        <p className="text-slate-600">Загрузка…</p>
      </main>
    );
  }

  if (status === 'no-telegram') {
    return (
      <main className="grid gap-8 py-10">
        <section className="rounded-3xl border border-slate-200/80 bg-white/70 p-8 shadow-soft backdrop-blur">
          <h1 className="font-display text-2xl tracking-tight text-slate-900">WishList</h1>
          <p className="mt-4 text-slate-600">
            Откройте это приложение через Telegram (кнопка меню бота или ссылка из бота).
          </p>
          <div className="mt-6">
            <Link
              href="/w/demo"
              className="inline-flex items-center justify-center rounded-xl bg-cyan-700 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-cyan-800"
            >
              Открыть демо-вишлист
            </Link>
          </div>
        </section>
      </main>
    );
  }

  if (status === 'error') {
    return (
      <main className="grid gap-8 py-10">
        <section className="rounded-3xl border border-red-200 bg-red-50/70 p-8">
          <p className="text-red-800">Не удалось войти. Откройте приложение через Telegram.</p>
          <Link href="/w/demo" className="mt-4 inline-block text-cyan-700 underline">
            Демо-вишлист
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="grid gap-8 py-10">
      <section className="rounded-3xl border border-slate-200/80 bg-white/70 p-8 shadow-soft backdrop-blur">
        <h1 className="font-display text-2xl tracking-tight text-slate-900">WishList</h1>
        <p className="mt-2 text-slate-600">Вы открыли приложение через Telegram.</p>
        {user && (
          <p className="mt-2 text-sm text-slate-500">
            ID: {user.id}
            {user.telegramId != null ? ` · Telegram: ${user.telegramId}` : ''}
          </p>
        )}
        <p className="mt-4 text-sm text-slate-500">
          Токен сохранён в localStorage. Для запросов к API передавайте заголовок:{' '}
          <code className="rounded bg-slate-100 px-1">Authorization: Bearer &lt;token&gt;</code>
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-xl bg-cyan-700 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-cyan-800"
          >
            На главную
          </Link>
          <Link
            href="/w/demo"
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-900 transition hover:bg-slate-50"
          >
            Демо-вишлист
          </Link>
        </div>
      </section>
    </main>
  );
}
