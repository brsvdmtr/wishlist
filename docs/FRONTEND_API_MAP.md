# FRONTEND_API_MAP.md — Карта взаимодействия фронтенда с API

> All data `VERIFIED_FROM_CODE` (source: MiniApp.tsx, WishlistClient.tsx, admin-api-client.ts, api-proxy.ts).
> Audited March 2026 on branch `claude/wizardly-satoshi`.

---

## Обзор

| Источник | Файл | Кол-во API-вызовов |
|----------|------|-------------------|
| Mini App (Telegram) | `apps/web/app/miniapp/MiniApp.tsx` | 24 |
| Public Wishlist | `apps/web/app/w/[slug]/` | 3 |
| Admin Panel | `apps/web/app/admin/` + `lib/admin-api-client.ts` | 11 |
| Middleware | `apps/web/middleware.ts` | 0 (только auth) |

**Итого: ~38 уникальных API-взаимодействий**

---

## 1. Mini App — Экран «Мои вишлисты» (`my-wishlists`)

### При загрузке

| # | Эндпоинт | Метод | Триггер | Тело запроса | Обновляет state |
|---|----------|-------|---------|-------------|-----------------|
| 1 | `/tg/wishlists` | GET | Монтирование компонента | — | `wishlists`, `planLimits`, `reservationsCount` |
| 1b | `/tg/reservations` | GET | Lazy-load после загрузки вишлистов | — | `reservations`, `reservationsLoading` |

### Действия пользователя

| # | Эндпоинт | Метод | Триггер | Тело запроса | Обновляет state |
|---|----------|-------|---------|-------------|-----------------|
| 2 | `/tg/wishlists` | POST | Нажатие «Создать вишлист» | `{ title, deadline? }` | `wishlists`, `currentWl`, `items`, `screen` |

**Ошибки:**
- `402` — Превышен лимит вишлистов (FREE: 2). Toast: «Лимит вишлистов достигнут»

---

## 2. Mini App — Экран «Детали вишлиста» (`wishlist-detail`)

### При загрузке

| # | Эндпоинт | Метод | Триггер | Тело запроса | Обновляет state |
|---|----------|-------|---------|-------------|-----------------|
| 3 | `/tg/wishlists/{id}/items` | GET | Переход на экран | — | `items` |

### Действия пользователя

| # | Эндпоинт | Метод | Триггер | Тело запроса | Обновляет state |
|---|----------|-------|---------|-------------|-----------------|
| 4 | `/tg/wishlists/{id}` | PATCH | Сохранение нового названия | `{ title }` | `currentWl`, `wishlists` |
| 5 | `/tg/wishlists/{id}/items` | POST | Создание предмета | `{ title, description?, url?, price?, priority?, imageUrl? }` | `items`, `wishlists` |
| 6 | `/tg/items/{id}` | PATCH | Редактирование предмета | `{ title?, description?, url?, price?, priority? }` | `items` (+ reload) |
| 7 | `/tg/items/{id}` | DELETE | Удаление предмета | — | `items`, `wishlists` |
| 8 | `/tg/items/{id}/photo` | POST | Загрузка фото | FormData: `photo` (file) | `itemImageUrl` |
| 9 | `/tg/items/{id}/photo` | DELETE | Удаление фото | — | `items` |
| 10 | `/tg/wishlists/{id}/share-token` | POST | Нажатие «Поделиться» | — | `shareToken` |
| 11 | `/tg/wishlists/{id}/archive` | GET | Нажатие «Архив» | — | `archiveItems`, `screen` |

**Ошибки:**
- `402` на POST items — Превышен лимит предметов (FREE: 10)
- Фото > 30MB — nginx отклоняет (413)

---

## 3. Mini App — Экран «Детали предмета» (`item-detail`, owner)

### При загрузке

| # | Эндпоинт | Метод | Триггер | Тело запроса | Обновляет state |
|---|----------|-------|---------|-------------|-----------------|
| 12 | `/tg/items/{id}/comments` | GET | Переход на экран | — | `comments`, `commentRole` |

### Действия пользователя

| # | Эндпоинт | Метод | Триггер | Тело запроса | Обновляет state |
|---|----------|-------|---------|-------------|-----------------|
| 13 | `/tg/items/{id}` | PATCH | Сохранение описания | `{ description }` | `viewingItem`, `items` |
| 14 | `/tg/items/{id}/comments` | POST | Отправка комментария | `{ text }` | `comments`, `commentText` |
| 15 | `/tg/items/{id}/comments/{cid}` | DELETE | Удаление комментария | — | `comments` |
| 16 | `/tg/items/{id}/complete` | POST | Нажатие «Получено» | — | `items`, `wishlists`, `archiveItems` |

**Логика комментариев:**
- `403` на GET comments — Нет бронирующего (комментарии недоступны)
- `commentRole` определяет UI: owner видит имя бронирующего, reserver видит «Автор»

---

## 4. Mini App — Экран «Архив» (`archive`)

### Действия пользователя

| # | Эндпоинт | Метод | Триггер | Тело запроса | Обновляет state |
|---|----------|-------|---------|-------------|-----------------|
| 17 | `/tg/items/{id}/restore` | POST | Нажатие «Восстановить» | — | `archiveItems`, `items`, `wishlists` |

---

## 5. Mini App — Экран «Забронировано мной» (`my-reservations`)

### При загрузке

| # | Эндпоинт | Метод | Триггер | Тело запроса | Обновляет state |
|---|----------|-------|---------|-------------|-----------------|
| 22 | `/tg/reservations` | GET | Переход на экран (если не загружены) | — | `reservations`, `reservationsLoading` |

### Действия пользователя

| # | Эндпоинт | Метод | Триггер | Тело запроса | Обновляет state |
|---|----------|-------|---------|-------------|-----------------|
| 23 | `/tg/items/{id}/unreserve` | POST | Нажатие «Снять бронь» на ReservationCard | `{}` | `reservations`, `reservationsCount` |
| 24 | `/tg/items/{id}/comments/mark-read` | POST | Переход к детали предмета из резерваций | — | CommentReadCursor (server-side) |

**Логика:**
- Предметы группируются по `ownerId` / `ownerName`
- `unreadComments` показывается как бейдж на ReservationCard
- При просмотре предмета ставится флаг `fromReservations` и вызывается mark-read
- НЕ Pro-функция — доступна всем пользователям

---

## 6. Mini App — Экран «Гостевой вишлист» (`guest-view`)

### При загрузке

| # | Эндпоинт | Метод | Триггер | Тело запроса | Обновляет state |
|---|----------|-------|---------|-------------|-----------------|
| 18 | `/public/share/{token}` | GET | Открытие по deep link `share_XXX` | — | `guestWl`, `guestItems` |
| 18b | `/public/wishlists/{slug}` | GET | Fallback если share не найден | — | `guestWl`, `guestItems` |

**Логика:**
1. Парсит `startapp` параметр из Telegram WebApp
2. Если начинается с `share_` → вызывает `/public/share/{token}`
3. При ошибке → fallback на `/public/wishlists/{param}`
4. Если `guestWl.ownerId === currentUser.id` → переключает на owner view

---

## 7. Mini App — Экран «Гостевой предмет» (`guest-item-detail`)

### При загрузке

| # | Эндпоинт | Метод | Триггер | Тело запроса | Обновляет state |
|---|----------|-------|---------|-------------|-----------------|
| 19 | `/tg/items/{id}/comments` | GET | Переход на экран | — | `comments`, `commentRole` |

### Действия пользователя

| # | Эндпоинт | Метод | Триггер | Тело запроса | Обновляет state |
|---|----------|-------|---------|-------------|-----------------|
| 20 | `/tg/items/{id}/reserve` | POST | Нажатие «Забронировать» | `{ displayName }` | `guestItems`, `viewingItem` |
| 21 | `/tg/items/{id}/unreserve` | POST | Нажатие «Отменить бронь» | `{}` | `guestItems`, `viewingItem` |
| 14 | `/tg/items/{id}/comments` | POST | Отправка комментария | `{ text }` | `comments` |
| 15 | `/tg/items/{id}/comments/{cid}` | DELETE | Удаление комментария | — | `comments` |

**Статусы бронирования (определяют UI):**
- `AVAILABLE` → кнопка «Забронировать»
- `RESERVED` + мой `actorHash` → бейдж + «Отменить бронь»
- `RESERVED` + чужой → бейдж «Забронировано кем-то»
- `PURCHASED` → бейдж «Куплено»

**Ошибки:**
- `409` на reserve — Уже забронировано (race condition)

---

## 8. Публичная страница `/w/:slug`

### При загрузке (SSR)

| # | Эндпоинт | Метод | Триггер | Тело запроса | Обновляет state |
|---|----------|-------|---------|-------------|-----------------|
| 25 | `/public/wishlists/{slug}` | GET | SSR page load | — | Server-side props |

### Действия пользователя (CSR)

| # | Эндпоинт | Метод | Триггер | Тело запроса | Обновляет state |
|---|----------|-------|---------|-------------|-----------------|
| 26 | `/public/items/{id}/reserve` | POST | Нажатие «Забронировать» | `{ actorHash, comment? }` | `data` (reload) |
| 27 | `/public/items/{id}/purchase` | POST | Нажатие «Куплено» | `{ actorHash, comment? }` | `data` (reload) |

**Авторизация:**
- `actorHash` генерируется из localStorage (не Telegram)
- Нет Telegram initData — другая система идентификации

---

## 9. Admin Panel

Все вызовы идут через Next.js API routes (`/api/admin/*`) → proxy → backend (`/admin/*`).
Авторизация: HTTP Basic Auth (web) + `X-ADMIN-KEY` header (api).

| # | Эндпоинт (proxy) | Метод | Триггер | Тело запроса |
|---|----------|-------|---------|-------------|
| 28 | `/api/admin/wishlists` | GET | Загрузка dashboard | — |
| 29 | `/api/admin/wishlists` | POST | Создание вишлиста | `{ title, description? }` |
| 30 | `/api/admin/wishlists/{id}` | GET | Открытие вишлиста | — |
| 31 | `/api/admin/wishlists/{id}` | PATCH | Редактирование | `{ title?, description? }` |
| 32 | `/api/admin/wishlists/{id}` | DELETE | Удаление | — |
| 33 | `/api/admin/wishlists/{id}/items` | GET | Загрузка предметов | Query: `status?`, `tag?` |
| 34 | `/api/admin/wishlists/{id}/items` | POST | Создание предмета | `{ title, url, priceText?, ... }` |
| 35 | `/api/admin/items/{id}` | PATCH | Редактирование предмета | `{ title?, url?, status?, ... }` |
| 36 | `/api/admin/items/{id}` | DELETE | Удаление предмета | — |
| 37 | `/api/admin/wishlists/{id}/tags` | POST | Создание тега | `{ name }` |
| 38 | `/api/admin/tags/{id}` | DELETE | Удаление тега | — |

---

## Общие заголовки запросов

### Mini App (Telegram)
```
X-TG-INIT-DATA: <Telegram WebApp initData string>
Content-Type: application/json
```

### Public endpoints
```
Content-Type: application/json
```
Нет авторизации. `actorHash` передаётся в теле запроса.

### Admin (two-layer auth) `VERIFIED_FROM_CODE`
```
Layer 1 (browser → Next.js): HTTP Basic Auth (ADMIN_BASIC_USER + ADMIN_BASIC_PASS)
Layer 2 (Next.js → Express): X-ADMIN-KEY header (injected server-side by api-proxy.ts)

Browser calls: /api/admin/* (Next.js API routes)
Next.js proxies to: Express backend paths (without /api/admin prefix)
ADMIN_KEY NEVER reaches the browser.
```

### Photo upload
```
X-TG-INIT-DATA: <initData>
Content-Type: multipart/form-data
```

---

## Обработка ошибок (общий паттерн)

```
Все API-вызовы в MiniApp обёрнуты в try/catch:

try {
  const res = await api('/endpoint', { method, body });
  if (!res.ok) {
    if (res.status === 402) → toast("Лимит достигнут")
    if (res.status === 409) → toast("Уже забронировано")
    throw new Error(...)
  }
  const data = await res.json();
  // update state
} catch (err) {
  toast("Ошибка: " + err.message)
}
```

---

## Диаграмма потока данных

```
┌─────────────────┐     X-TG-INIT-DATA      ┌──────────────┐
│   MiniApp.tsx    │ ────────────────────────→│  Express API │
│  (Telegram)      │     /tg/* endpoints      │  (port 3001) │
└─────────────────┘                          └──────┬───────┘
                                                     │
┌─────────────────┐     No auth               │      │
│  /w/:slug page  │ ────────────────────────→│      │
│  (Public SSR)    │     /public/* endpoints   │      ▼
└─────────────────┘                          ┌──────────────┐
                                              │  PostgreSQL   │
┌─────────────────┐     X-ADMIN-KEY          │  (port 5432) │
│  Admin Panel    │ ──→ Next.js API ──→      └──────────────┘
│  (Basic Auth)    │     /admin/* endpoints
└─────────────────┘
```
