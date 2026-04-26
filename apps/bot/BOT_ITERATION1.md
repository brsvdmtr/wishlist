# Бот — Итерация 1 (сквозной флоу)

## Структура файлов

```
apps/bot/src/
├── index.ts          # Точка входа: запуск бота, регистрация handlers/hears
├── session.ts        # In-memory сессия (listId, listSlug, wizard)
├── api.ts            # API-клиент (X-ADMIN-KEY + X-Telegram-User-Id)
├── menu.ts           # Клавиатуры: главное меню, отмена, share-кнопки
└── handlers/
    ├── start.ts      # /start, deep-link, приветствие и «есть ли список»
    ├── list.ts       # Мой список, Поделиться, Настройки, создание списка (wizard), В меню
    └── addItem.ts    # Добавить желание (wizard: одна/две строки — название и ссылка)
```

## Команды и кнопки

| Действие | Тип | Описание |
|----------|-----|----------|
| `/start` | команда | Главное меню; при `?start=w_<slug>` — выдача ссылки на вишлист |
| `/demo` | команда | Ссылка на демо-вишлист |
| `/w <slug>` | команда | Ссылка на вишлист по slug |
| `/health` | команда | Проверка API |
| `/help` | команда | Подсказка по кнопкам |
| ➕ Добавить желание | reply-кнопка | Запуск сценария добавления пункта (или создание списка, если нет) |
| 📋 Мой список | reply-кнопка | Показать список и кнопку «Поделиться» или предложить создать список |
| 🔗 Поделиться | reply-кнопка | Выдать ссылку на текущий список |
| ⚙️ Настройки | reply-кнопка | Заглушка |
| ◀️ В меню | reply-кнопка | Сброс wizard, главное меню |
| ❌ Отмена | reply-кнопка | Сброс wizard |
| 🎁 Открыть вишлист / Копировать ссылку | inline | В сообщении «Мой список» / «Поделиться» |

Кнопка меню (слева внизу): **Вишлист** — открывает WebApp (SITE_URL).

## Схема состояний (wizard)

- **Нет wizard**  
  Обработка по кнопкам и командам.

- **`create_list`**  
  Выставлен после «📋 Мой список», когда списков ещё нет.  
  Ожидание: одна строка текста = название списка → `POST /wishlists` с `slug: tg_<telegram_id>`, затем сообщение «Список создан».

- **`add_item`**  
  Выставлен после «➕ Добавить желание».  
  Ожидание: одна строка (название) или две (название + ссылка) → `POST /wishlists/:id/items`, затем «Добавлено».

«❌ Отмена» и «◀️ В меню» сбрасывают wizard в любом состоянии.

## Deep-link payload

- `t.me/<bot>?start=w_<slug>`  
  Пример: `?start=w_demo` или `?start=w_tg_12345`.  
  В обработчике `/start` из payload берётся `w_<slug>`, пользователю отправляется ссылка на `SITE_URL/w/<slug>`.

## API (используемое ботом)

- Заголовки: `X-ADMIN-KEY` (как в api), `X-Telegram-User-Id` (telegram user id).
- Владелец списка: по `X-Telegram-User-Id` (User по `telegramId`), при отсутствии — системный пользователь.
- Эндпоинты: `GET /wishlists`, `POST /wishlists` (тело: `title`, опционально `slug`, `description`), `POST /wishlists/:id/items` (тело: `title`, `url`, опционально `priceText`, `priority`), публичный `GET /public/wishlists/:slug`.

## Что дальше (Итерация 2)

- Резерв с TTL и авто-снятие.
- Комментарий к резерву (для гостя).
- Категории и фильтры.
- Цена/валюта и «сумма списка».

---

## Tech debt — Telegram Local Bot API (deferred 2026-04-26)

**Why on the radar.** The bot relies on `api.telegram.org` reachability, which is
fragile for our Russian VPS:
- IPv4 to `api.telegram.org` is intermittently RKN-blocked.
- IPv6 path works most of the time but flaps for a few minutes after every
  `docker-compose up -d` (host route table needs to resettle).
- Side-effect today (2026-04-26 incident): bot ETIMEDOUT'd 4 launches in a row
  during the Calendar v2.1 deploy. Our in-process watchdog now self-heals
  (after the `isTransientError` fix + 1s/2s/4s exponential retry), but the
  underlying flap is still there.

**Fix on the roadmap: run our own Telegram Bot API server (TBA) on `127.0.0.1`,
have the bot talk to it instead of `api.telegram.org` directly.** TBA mirrors
the public Telegram API and handles all upstream connectivity itself,
including its own retry / route logic.

**Sketch of the work:**
1. Add a service to `docker-compose.prod.yml`:
   - `aiogram/telegram-bot-api:latest` (or build from source — Telegram supplies a
     Dockerfile in `tdlib/telegram-bot-api`)
   - Env: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` (from `https://my.telegram.org`)
   - Volume: persistent dir for downloaded files + per-bot state
   - Port: 8081 bound to `127.0.0.1` only (don't expose to internet)
2. Configure Telegraf in `apps/bot/src/index.ts`:
   ```ts
   new Telegraf(token, {
     telegram: {
       apiRoot: 'http://127.0.0.1:8081',
       agent: new http.Agent({ keepAlive: true }),
     },
   });
   ```
3. The `/api/tg/billing/*` and other API → Telegram calls in `apps/api/src/index.ts`
   (createInvoiceLink, sendTgBotMessage, sendTgNotification) need the same
   `apiRoot` switch — currently they POST directly to `https://api.telegram.org`.
   Centralise this behind a `TG_API_ROOT` env var.
4. After cutover: monitor for any breaking semantic differences (file upload size
   limits, webhook flow). Long-poll mode should be transparent.

**When to actually do it:** when the deploy-time flaps cause more pain than
the watchdog absorbs (e.g. a single minute of downtime mattering for users),
OR when RKN escalates the IPv4 block to IPv6 too. Until then the watchdog
+ pre-warm + fixed transient classification is enough.

**Estimated effort:** 0.5–1 day (mostly compose wiring + smoke testing,
plus migrating direct-fetch calls in apps/api). No schema changes.
