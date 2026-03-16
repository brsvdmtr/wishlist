# ACCESS_MATRIX.md — Матрица доступа по ролям

> All data `VERIFIED_FROM_CODE` unless marked otherwise.

---

## Роли в системе

| Роль | Определение | Как определяется |
|------|------------|------------------|
| **Автор (owner)** | Создатель вишлиста | `wishlist.ownerId === user.id` |
| **Бронирующий (reserver)** | Гость, забронировавший конкретный предмет | `item.reserverUserId === user.id` (через actorHash) |
| **Третье лицо (third_party)** | Гость, открывший вишлист, но не бронировавший данный предмет | Авторизован через Telegram, но не owner и не reserver |
| **Аноним (anonymous)** | Посетитель публичной страницы `/w/:slug` без Telegram | Нет `X-TG-INIT-DATA`, есть `actorHash` из localStorage |
| **Админ (admin)** | Доступ к `/admin` панели | HTTP Basic Auth (`ADMIN_BASIC_USER`/`ADMIN_BASIC_PASS`) + `ADMIN_KEY` |

### Как определяется роль на бэкенде

```
getItemRole(itemId, tgUser) -> { role, actorHash, item }

1. Найти item + wishlist.ownerId + reservationEvents
2. Вычислить actorHash = SHA-256(telegramId) -> UUID format
3. Если wishlist.ownerId === tgUser.dbUserId -> role = "owner"
4. Если item.reserverUserId === tgUser.dbUserId -> role = "reserver"
5. Иначе -> role = "third_party"
```

---

## Матрица действий — Вишлисты

| Действие | Автор | Бронирующий | Третье лицо | Аноним | Админ |
|----------|:-----:|:-----------:|:-----------:|:------:|:-----:|
| Создать вишлист | ✅ | — | — | — | ✅ |
| Просмотреть свои вишлисты | ✅ | — | — | — | ✅ (все) |
| Просмотреть чужой вишлист (по share-ссылке) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Переименовать вишлист | ✅ | ❌ | ❌ | ❌ | ✅ |
| Удалить вишлист | ✅ | ❌ | ❌ | ❌ | ✅ |
| Сгенерировать share-ссылку | ✅ | ❌ | ❌ | ❌ | ❌ |
| Поделиться через Telegram | ✅ | ❌ | ❌ | ❌ | ❌ |

---

## Матрица действий — Предметы (Items)

| Действие | Автор | Бронирующий | Третье лицо | Аноним | Админ |
|----------|:-----:|:-----------:|:-----------:|:------:|:-----:|
| Создать предмет | ✅ | ❌ | ❌ | ❌ | ✅ |
| Редактировать предмет | ✅ | ❌ | ❌ | ❌ | ✅ |
| Удалить предмет | ✅ | ❌ | ❌ | ❌ | ✅ |
| Просмотреть предмет (owner view) | ✅ | ❌ | ❌ | ❌ | ✅ |
| Просмотреть предмет (guest view) | ❌ | ✅ | ✅ | ✅ | — |
| Загрузить фото | ✅ | ❌ | ❌ | ❌ | ❌ |
| Удалить фото | ✅ | ❌ | ❌ | ❌ | ❌ |
| Изменить описание | ✅ | ❌ | ❌ | ❌ | ✅ |
| Отметить «Получено» | ✅ | ❌ | ❌ | ❌ | ❌ |
| Восстановить из архива | ✅ | ❌ | ❌ | ❌ | ❌ |
| Просмотреть архив | ✅ | ❌ | ❌ | ❌ | ❌ |

---

## Матрица действий — Бронирование

| Действие | Автор | Бронирующий | Третье лицо | Аноним | Админ |
|----------|:-----:|:-----------:|:-----------:|:------:|:-----:|
| Забронировать предмет | ❌ | — | ✅ | ✅ | ❌ |
| Отменить бронь | ❌ | ✅ | ❌ | ✅* | ❌ |
| Видеть КТО забронировал | ❌ | — | ❌ | ❌ | ✅ |
| Видеть ЧТО забронировано (статус) | ❌** | ✅ | ✅ | ✅ | ✅ |
| Отметить «Куплено» (public page) | ❌ | — | — | ✅ | ❌ |

\* Аноним может отменить бронь только если его `actorHash` совпадает (тот же браузер)
\** Автор видит только что предмет забронирован, но НЕ видит кем

### Ключевой принцип: анонимность бронирования

Автор **никогда** не видит:
- Кто забронировал предмет
- Telegram ID бронирующего
- Display name бронирующего (кроме уведомлений)

Автор видит только:
- Статус предмета: `AVAILABLE` / `RESERVED` / `PURCHASED`
- Что предмет забронирован (бейдж «Забронировано»)

---

## Матрица действий — Комментарии

| Действие | Автор | Бронирующий | Третье лицо | Аноним |
|----------|:-----:|:-----------:|:-----------:|:------:|
| Видеть комментарии | ✅* | ✅* | ❌ | ❌ |
| Написать комментарий | ✅* | ✅* | ❌ | ❌ |
| Удалить свой комментарий | ✅ | ✅ | — | — |
| Удалить чужой комментарий | ✅ | ❌ | — | — |

\* Комментарии — приватный чат между автором и бронирующим конкретного предмета.
Третьи лица не видят комментарии и получают `403` при попытке загрузить.

### Логика видимости комментариев

```
commentRole определяется на бэкенде:
- owner: видит комментарии от текущего бронирующего
- reserver: видит комментарии от автора
- third_party: 403 Forbidden
- нет бронирующего: комментарии недоступны никому
```

---

## Матрица действий — Уведомления (Telegram Push)

| Событие | Получатель | Условие |
|---------|-----------|---------|
| Предмет забронирован | Автор | Автор имеет `telegramChatId` |
| Комментарий (бронирующий → автору) | Автор | Автор имеет `telegramChatId` |
| Комментарий (автор → бронирующему) | Бронирующий | Бронирующий имеет `telegramChatId` |
| Описание обновлено | Бронирующий | Предмет забронирован + reserver имеет `telegramChatId` |

---

## Матрица API-эндпоинтов по ролям

### Telegram Mini App эндпоинты (`/tg/*`)

| Эндпоинт | Метод | Авторизация | Кто может |
|----------|-------|-------------|-----------|
| `/tg/wishlists` | GET | TG initData | Только свои вишлисты |
| `/tg/wishlists` | POST | TG initData | Любой авторизованный |
| `/tg/wishlists/:id` | PATCH | TG initData | Только owner |
| `/tg/wishlists/:id` | DELETE | TG initData | Только owner |
| `/tg/wishlists/:id/items` | GET | TG initData | Только owner |
| `/tg/wishlists/:id/items` | POST | TG initData | Только owner |
| `/tg/wishlists/:id/share-token` | POST | TG initData | Только owner |
| `/tg/wishlists/:id/archive` | GET | TG initData | Только owner |
| `/tg/items/:id` | PATCH | TG initData | Только owner |
| `/tg/items/:id` | DELETE | TG initData | Только owner |
| `/tg/items/:id/photo` | POST | TG initData | Только owner |
| `/tg/items/:id/photo` | DELETE | TG initData | Только owner |
| `/tg/items/:id/complete` | POST | TG initData | Только owner |
| `/tg/items/:id/restore` | POST | TG initData | Только owner |
| `/tg/items/:id/reserve` | POST | TG initData | Гость (не owner) |
| `/tg/items/:id/unreserve` | POST | TG initData | Только reserver |
| `/tg/items/:id/comments` | GET | TG initData | Owner или reserver |
| `/tg/items/:id/comments` | POST | TG initData | Owner или reserver |
| `/tg/items/:id/comments/:cid` | DELETE | TG initData | Автор комментария или owner |

### Публичные эндпоинты (`/public/*`)

| Эндпоинт | Метод | Авторизация | Кто может |
|----------|-------|-------------|-----------|
| `/public/share/:token` | GET | Нет | Любой с токеном |
| `/public/wishlists/:slug` | GET | Нет | Любой |
| `/public/items/:id/reserve` | POST | actorHash | Любой с actorHash |
| `/public/items/:id/purchase` | POST | actorHash | Любой с actorHash |

### Админ эндпоинты (`/admin/*`)

| Эндпоинт | Метод | Авторизация | Кто может |
|----------|-------|-------------|-----------|
| `/admin/wishlists` | GET | ADMIN_KEY | Только админ |
| `/admin/wishlists` | POST | ADMIN_KEY | Только админ |
| `/admin/wishlists/:id` | GET | ADMIN_KEY | Только админ |
| `/admin/wishlists/:id` | PATCH | ADMIN_KEY | Только админ |
| `/admin/wishlists/:id` | DELETE | ADMIN_KEY | Только админ |
| `/admin/wishlists/:id/items` | GET | ADMIN_KEY | Только админ |
| `/admin/wishlists/:id/items` | POST | ADMIN_KEY | Только админ |
| `/admin/items/:id` | PATCH | ADMIN_KEY | Только админ |
| `/admin/items/:id` | DELETE | ADMIN_KEY | Только админ |
| `/admin/wishlists/:id/tags` | POST | ADMIN_KEY | Только админ |
| `/admin/tags/:id` | DELETE | ADMIN_KEY | Только админ |

### Служебные эндпоинты

| Эндпоинт | Метод | Авторизация | Кто может |
|----------|-------|-------------|-----------|
| `/health` | GET | Нет | Любой |
| `/uploads/*` | GET | Нет | Любой (статические файлы) |

---

## Лимиты по плану (FREE)

| Ресурс | Лимит | Где проверяется |
|--------|-------|-----------------|
| Вишлисты на пользователя | 2 | `POST /tg/wishlists` -> 402 |
| Предметы на вишлист | 10 | `POST /tg/wishlists/:id/items` -> 402 |
| Размер фото | 30 MB (nginx) | nginx `client_max_body_size` |
| Длина комментария | 300 символов | Frontend + backend validation |
| Длина названия вишлиста | 80 символов | Frontend validation |
| Debounce уведомлений | 30 секунд | Backend in-memory queue |
