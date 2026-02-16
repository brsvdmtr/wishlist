'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type Tag = { id: string; name: string };
type ItemStatus = 'AVAILABLE' | 'RESERVED' | 'PURCHASED';
type Priority = 'LOW' | 'MEDIUM' | 'HIGH';

type PublicItem = {
  id: string;
  title: string;
  url: string;
  priceText: string | null;
  commentOwner: string | null;
  priority: Priority;
  deadline: string | null;
  imageUrl: string | null;
  status: ItemStatus;
  tags: Tag[];
};

type PublicWishlistResponse = {
  wishlist: { id: string; slug: string; title: string; description: string | null };
  items: PublicItem[];
  tags: Tag[];
};

type Toast = { id: string; message: string; kind: 'error' | 'success' };

const ACTOR_KEY = 'wishlist_actor_hash';

function apiBaseUrl() {
  return (process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
}

function formatDeadline(value: string | null) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('ru-RU', { year: 'numeric', month: 'short', day: '2-digit' }).format(d);
}

function statusLabel(status: ItemStatus) {
  if (status === 'AVAILABLE') return 'Доступно';
  if (status === 'RESERVED') return 'Забронировано';
  return 'Куплено';
}

function priorityLabel(p: Priority) {
  if (p === 'LOW') return 'Низкий';
  if (p === 'HIGH') return 'Высокий';
  return 'Средний';
}

function statusClasses(status: ItemStatus) {
  if (status === 'AVAILABLE') return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
  if (status === 'RESERVED') return 'bg-amber-50 text-amber-800 ring-amber-200';
  return 'bg-slate-100 text-slate-700 ring-slate-200';
}

function createToast(message: string, kind: Toast['kind']): Toast {
  const id =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).substring(2, 15);
  return { id, message, kind };
}

function Modal({
  open,
  title,
  confirmText,
  loading,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  confirmText: string;
  loading: boolean;
  onClose: () => void;
  onConfirm: (comment: string) => void;
}) {
  const [comment, setComment] = useState('');

  useEffect(() => {
    if (open) setComment('');
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-6 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
        <h3 className="font-display text-xl tracking-tight text-slate-900">{title}</h3>
        <p className="mt-2 text-sm text-slate-600">Комментарий необязателен.</p>

        <textarea
          className="mt-4 h-28 w-full resize-none rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none ring-0 transition focus:border-cyan-300 focus:ring-2 focus:ring-cyan-200"
          placeholder="Например: беру на себя, куплю до пятницы"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-50"
            onClick={onClose}
            disabled={loading}
          >
            Отмена
          </button>
          <button
            type="button"
            className="rounded-xl bg-cyan-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-cyan-800 disabled:opacity-60"
            onClick={() => onConfirm(comment.trim())}
            disabled={loading}
          >
            {loading ? '...' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function WishlistClient({
  slug,
  initialData,
}: {
  slug: string;
  initialData: unknown;
}) {
  const [data, setData] = useState<PublicWishlistResponse>(() => initialData as PublicWishlistResponse);
  const [actorHash, setActorHash] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | ItemStatus>('all');
  const [tagFilter, setTagFilter] = useState<string | null>(null); // Tag.id
  const [toasts, setToasts] = useState<Toast[]>([]);

  const [modal, setModal] = useState<
    | null
    | {
        kind: 'reserve' | 'purchase';
        itemId: string;
        itemTitle: string;
      }
  >(null);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    const existing = localStorage.getItem(ACTOR_KEY);
    if (existing) {
      setActorHash(existing);
      return;
    }

    // Fallback for non-secure contexts (HTTP without SSL)
    let created: string;
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      created = crypto.randomUUID();
    } else {
      // Simple UUID v4 fallback for non-HTTPS contexts
      created = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    }
    
    localStorage.setItem(ACTOR_KEY, created);
    setActorHash(created);
  }, []);

  const pushToast = useCallback((message: string, kind: Toast['kind']) => {
    const toast = createToast(message, kind);
    setToasts((prev) => [toast, ...prev].slice(0, 4));
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== toast.id));
    }, 3200);
  }, []);

  const load = useCallback(async () => {
    const res = await fetch(`${apiBaseUrl()}/public/wishlists/${encodeURIComponent(slug)}`, {
      cache: 'no-store',
    });
    if (res.status === 404) {
      // Let Next handle 404 via route-level not-found.
      window.location.reload();
      return;
    }
    if (!res.ok) throw new Error(`Failed to reload wishlist: ${res.status}`);
    const json = (await res.json()) as PublicWishlistResponse;
    setData(json);
  }, [slug]);

  const filteredItems = useMemo(() => {
    let items = data.items;

    if (statusFilter !== 'all') items = items.filter((i) => i.status === statusFilter);
    if (tagFilter) items = items.filter((i) => i.tags.some((t) => t.id === tagFilter));

    return items;
  }, [data.items, statusFilter, tagFilter]);

  const reserveOrPurchase = useCallback(
    async (kind: 'reserve' | 'purchase', itemId: string, comment: string) => {
      if (!actorHash) return;

      setActionLoading(true);
      try {
        const endpoint =
          kind === 'reserve' ? 'reserve' : kind === 'purchase' ? 'purchase' : 'reserve';
        const body: { actorHash: string; comment?: string } = { actorHash };
        if (comment) body.comment = comment;

        const res = await fetch(`${apiBaseUrl()}/public/items/${itemId}/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (res.ok) {
          pushToast(kind === 'reserve' ? 'Забронировано' : 'Отмечено как купленное', 'success');
          await load();
          return;
        }

        if (res.status === 409) {
          pushToast('Уже занято', 'error');
          await load();
          return;
        }

        pushToast('Что-то пошло не так. Попробуйте еще раз.', 'error');
      } catch {
        pushToast('Не удалось связаться с API.', 'error');
      } finally {
        setActionLoading(false);
        setModal(null);
      }
    },
    [actorHash, load, pushToast],
  );

  return (
    <main className="grid gap-8">
      <header className="rounded-3xl border border-slate-200/80 bg-white/70 p-10 shadow-soft backdrop-blur">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <p className="text-sm font-medium text-slate-600">Вишлист</p>
            <h1 className="mt-3 font-display text-4xl leading-tight tracking-tight text-slate-900 sm:text-5xl">
              {data.wishlist.title}
            </h1>
            {data.wishlist.description ? (
              <p className="mt-4 max-w-2xl text-slate-600">{data.wishlist.description}</p>
            ) : null}
          </div>

          <div className="grid gap-2 rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Фильтры</p>

            <label className="grid gap-1">
              <span className="text-xs text-slate-500">Статус</span>
              <select
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value === 'all' ? 'all' : (e.target.value as ItemStatus))
                }
                className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-cyan-300 focus:ring-2 focus:ring-cyan-200"
              >
                <option value="all">Все</option>
                <option value="AVAILABLE">Доступно</option>
                <option value="RESERVED">Забронировано</option>
                <option value="PURCHASED">Куплено</option>
              </select>
            </label>

            <label className="grid gap-1">
              <span className="text-xs text-slate-500">Тег</span>
              <select
                value={tagFilter ?? 'all'}
                onChange={(e) => setTagFilter(e.target.value === 'all' ? null : e.target.value)}
                className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-cyan-300 focus:ring-2 focus:ring-cyan-200"
              >
                <option value="all">Все</option>
                {data.tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </header>

      <section className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-2xl tracking-tight text-slate-900">
            Подарки <span className="text-slate-500">({filteredItems.length})</span>
          </h2>
          <p className="text-sm text-slate-600">
            Ваш идентификатор гостя: <span className="font-mono">{actorHash ?? '...'}</span>
          </p>
        </div>

        {filteredItems.length === 0 ? (
          <div className="rounded-3xl border border-slate-200/80 bg-white/70 p-10 text-slate-700 shadow-soft backdrop-blur">
            Ничего не найдено по выбранным фильтрам.
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {filteredItems.map((item) => {
              const deadline = formatDeadline(item.deadline);
              const canReserve = item.status === 'AVAILABLE';
              const canPurchase = item.status !== 'PURCHASED';

              return (
                <article
                  key={item.id}
                  className="rounded-3xl border border-slate-200/80 bg-white/70 p-6 shadow-soft backdrop-blur"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate text-lg font-semibold text-slate-900 underline-offset-4 hover:underline"
                      >
                        {item.title}
                      </a>
                      {item.priceText ? (
                        <p className="mt-1 text-sm text-slate-600">{item.priceText}</p>
                      ) : null}
                    </div>

                    <span
                      className={`inline-flex shrink-0 items-center rounded-full px-3 py-1 text-xs font-semibold ring-1 ${statusClasses(
                        item.status,
                      )}`}
                    >
                      {statusLabel(item.status)}
                    </span>
                  </div>

                  <dl className="mt-4 grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
                    <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
                      <dt className="text-slate-500">Приоритет</dt>
                      <dd className="font-semibold">{priorityLabel(item.priority)}</dd>
                    </div>
                    <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
                      <dt className="text-slate-500">Дедлайн</dt>
                      <dd className="font-semibold">{deadline ?? '—'}</dd>
                    </div>
                  </dl>

                  {item.tags.length ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {item.tags.map((t) => (
                        <span
                          key={t.id}
                          className="inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700"
                        >
                          {t.name}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  <div className="mt-6 flex flex-wrap gap-2">
                    {canReserve ? (
                      <button
                        type="button"
                        className="rounded-xl bg-cyan-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-cyan-800 disabled:opacity-60"
                        onClick={() => setModal({ kind: 'reserve', itemId: item.id, itemTitle: item.title })}
                        disabled={!actorHash || actionLoading}
                      >
                        Забронировать
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-500"
                        disabled
                      >
                        {item.status === 'RESERVED' ? 'Забронировано' : 'Недоступно'}
                      </button>
                    )}

                    {canPurchase ? (
                      <button
                        type="button"
                        className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-50 disabled:opacity-60"
                        onClick={() => setModal({ kind: 'purchase', itemId: item.id, itemTitle: item.title })}
                        disabled={!actorHash || actionLoading}
                      >
                        Отметить купленным
                      </button>
                    ) : (
                      <span className="inline-flex items-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700">
                        Куплено
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <Modal
        open={modal !== null}
        title={
          modal?.kind === 'reserve'
            ? `Забронировать: ${modal.itemTitle}`
            : modal?.kind === 'purchase'
              ? `Отметить купленным: ${modal.itemTitle}`
              : ''
        }
        confirmText={modal?.kind === 'reserve' ? 'Забронировать' : 'Отметить'}
        loading={actionLoading}
        onClose={() => setModal(null)}
        onConfirm={(comment) => {
          if (!modal) return;
          void reserveOrPurchase(modal.kind, modal.itemId, comment);
        }}
      />

      <div className="fixed right-4 top-4 z-50 grid w-[min(420px,calc(100vw-2rem))] gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded-2xl border px-4 py-3 text-sm shadow-soft backdrop-blur ${
              t.kind === 'success'
                ? 'border-emerald-200 bg-emerald-50/90 text-emerald-800'
                : 'border-rose-200 bg-rose-50/90 text-rose-800'
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </main>
  );
}

