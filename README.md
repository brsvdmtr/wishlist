# WishBoard

> Last updated: 2026-03-26 · Verified from code · Branch: main

Telegram Mini App для управления вишлистами. Пользователи создают вишлисты и делятся ими; друзья бронируют подарки без спойлеров (режим сюрприза). Монетизация — Telegram Stars (PRO, 100 Stars/месяц).

**Продакшн:** https://wishlistik.ru/miniapp
**Бот:** @WishHub_bot
**Документация:** [docs/INDEX.md](./docs/INDEX.md)

---

## Stack

| Сервис | Технологии |
|--------|-----------|
| `apps/api` | Node.js 20 · Express 4 · TypeScript · Zod · Prisma 5 · Puppeteer |
| `apps/web` | Next.js 14 (App Router) · TypeScript · React 18 |
| `apps/bot` | Node.js 20 · Telegraf 4 |
| `packages/db` | Prisma 5 · PostgreSQL 16 |
| `packages/shared` | i18n (6 локалей: ru, en, zh-CN, hi, es, ar) · shared types |

---

## Локальная разработка

### 1. Установка зависимостей

```bash
pnpm install
```

### 2. Переменные окружения

```bash
cp .env.example .env
# Заполнить DATABASE_URL, BOT_TOKEN, ADMIN_KEY
```

### 3. База данных

```bash
# Запустить PostgreSQL
docker compose -f docker-compose.dev.yml up -d

# Применить миграции
pnpm db:migrate

# (опционально) Сид-данные
pnpm seed
```

### 4. Запуск

```bash
pnpm dev          # api + web + bot параллельно
pnpm dev:api      # только API  → localhost:3001
pnpm dev:web      # только Web  → localhost:3000
```

### 5. Dev-аутентификация для Mini App

В продакшне Mini App использует `Telegram WebApp initData` (HMAC). В dev вместо этого:

```bash
# Добавить заголовок в запросы к API (без валидации подписи):
X-TG-DEV: <telegramId>
```

---

## Полезные команды

```bash
pnpm build          # собрать всё
pnpm lint           # ESLint
pnpm db:migrate     # prisma migrate dev
pnpm db:studio      # Prisma Studio (UI для БД)
pnpm db:generate    # сгенерировать Prisma Client
```

---

## Деплой в продакшн

> **Ветка продакшна: `main`**
> Разработка ведётся в worktree-ветках, затем коммиты cherry-pick'аются в `main`.

```bash
# На сервере:
cd /opt/wishlist
git pull origin main
docker compose -f docker-compose.prod.yml up -d --build
```

Миграции применяются автоматически при старте контейнера `api` (`prisma migrate deploy`).

Подробнее: [docs/INFRA_AND_ENV.md](./docs/INFRA_AND_ENV.md)

---

## Структура монорепо

```
apps/
  api/        Express API — весь бэкенд (src/index.ts)
  web/        Next.js — Mini App (app/miniapp/MiniApp.tsx) + публичные страницы + admin
  bot/        Telegraf bot — команды, уведомления, биллинг-хуки
packages/
  db/         Prisma schema + миграции
  shared/     i18n строки (6 локалей), shared типы
ops/
  watchdog/   Health-check скрипт (Node.js)
  nginx/      Конфиги nginx
  maintenance/ Страница технического обслуживания
docs/         Документация (INDEX.md — точка входа)
```

---

## Основные возможности

- 🎁 Вишлисты с элементами (фото, цена, ссылка, приоритет, адаптивные карточки)
- 🔗 Импорт по ссылке (Ozon, Wildberries, Яндекс Маркет, Lamoda, Goldapple и др.) — PRO
- 🤝 Бронирование подарков в режиме сюрприза (гость не видит, кто уже забронировал)
- 💬 Комментарии к желаниям — PRO (достаточно PRO у одной из сторон)
- 💡 Намёки на подарки — PRO
- 👁 Подписки на вишлисты друзей — PRO (до 5)
- 🔐 Расширенная приватность (видимость, политики подписок и комментариев) — PRO
- 💳 Оплата через Telegram Stars (подписка PRO, 100 Stars/мес)
- 🎟 Промокоды (WISHPRO — 30 дней PRO)
- 🎄 Secret Santa — анонимный обмен подарками
- 🌐 Публичные профили (`profile_` deep link) и публичные веб-страницы вишлистов
- 🛡 Панель администратора (`/admin`, Basic Auth)
- 📊 God Mode аналитика (воронка, A/B тест онбординга, retention метрики)
- 🌍 6 языков: русский, английский, китайский, хинди, испанский, арабский (RTL)
- 📱 Onboarding v2 с A/B тестом (try-import, каталог, создание вишлиста)

---

## Планы

| | FREE | PRO |
|--|------|-----|
| Вишлисты | 2 | 10 |
| Желаний в каждом | 20 | 70 |
| Участников | 5 | 20 |
| Подписок | 2 | 5 |
| Комментарии | — | ✓ |
| Импорт по ссылке | — | ✓ |
| Намёки | — | ✓ |
| Кастомизация карточек | — | ✓ |
| Цена | — | 100 Stars/мес |

---

## Документация

Полная документация в папке `docs/`. Точка входа: **[docs/INDEX.md](./docs/INDEX.md)**

| Документ | Содержание |
|----------|-----------|
| [ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Архитектура системы, модули, потоки данных |
| [BACKEND_MAP.md](./docs/BACKEND_MAP.md) | Все API-маршруты, middleware, хелперы |
| [API_REFERENCE.md](./docs/API_REFERENCE.md) | Справочник по API эндпоинтам |
| [DATA_MODEL.md](./docs/DATA_MODEL.md) | Схема БД: все модели и enum'ы |
| [FRONTEND_MAP.md](./docs/FRONTEND_MAP.md) | Экраны Mini App, состояние, дизайн-система |
| [MONETIZATION.md](./docs/MONETIZATION.md) | Планы, лимиты, пейволл, биллинг |
| [USER_FLOWS.md](./docs/USER_FLOWS.md) | Пользовательские сценарии |
| [TELEGRAM_FLOW.md](./docs/TELEGRAM_FLOW.md) | Бот, WebApp SDK, auth, уведомления |
| [SETTINGS_AND_PRIVACY.md](./docs/SETTINGS_AND_PRIVACY.md) | Настройки, приватность, PRO-гейты |
| [LINK_IMPORT.md](./docs/LINK_IMPORT.md) | Импорт по ссылке: пайплайн, адаптеры |
| [ACCESS_MATRIX.md](./docs/ACCESS_MATRIX.md) | Матрица доступа: роли, видимость данных |
| [INFRA_AND_ENV.md](./docs/INFRA_AND_ENV.md) | Сервер, Docker, nginx, деплой, мониторинг |
| [KNOWN_GAPS_AND_RISKS.md](./docs/KNOWN_GAPS_AND_RISKS.md) | Риски, пробелы в архитектуре |
