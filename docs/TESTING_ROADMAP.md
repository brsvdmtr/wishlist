# Testing Roadmap

> Статус: **IN PROGRESS 2026-05-15**. Phases 0, 1 (partial), 2 (partial), 6
> shipped; Phase 3 / 4 / 5a pending; Phase 5b deferred until MiniApp.tsx
> extraction. Полное состояние прогресса — в § 10.

## 0. Прогресс на 2026-05-15 (одна сводка)

| Phase | Status | Закоммичено | Тесты |
|---|---|---|---|
| 0 — Foundation (CI + vitest infra) | ✅ DONE | `ceeb92a` | +0 (infra) |
| 1 — Regression tests for BUGFIX_LESSONS | ✅ DONE (4/8 closed in code, 4 deferred) | `6b76b1e` | +22 |
| 2 — Service layer | ✅ DONE (14/14 services) | `59c0068`, `3802b22`, `75697b7` | +335 |
| 3 — Schedulers | 🚧 PARTIAL (2/9 — referral, cleanup) | `4066c1f` | +16 |
| 4 — Routes | ⏳ PENDING | — | — |
| 5a — Bot | ⏳ PENDING | — | — |
| 5b — Frontend pilot (L2/L3/L6/L8 UI regressions) | ⏳ DEFERRED until MiniApp.tsx extraction | — | — |
| 6 — CI discipline gates | ✅ DONE | `586d056` | (rule-level) |

**Test baseline:** 913 tests / 35 files / all green via `pnpm test`.
**Dormant bug found and fixed during Phase 1:** `gift-notes.routes.ts:241`
detail-endpoint had the L5 calendar TODAY/TOMORROW bug for ~15 days after
the original fix shipped (`05df77f`) — see [BUGFIX_LESSONS 2026-05-15](BUGFIX_LESSONS.md#2026-05-15).

## 1. Текущее состояние

**Покрытие: ~19% (23 тестовых файла на ~120 src-файлов).** Перекос:

| Слой | Покрытие | Качество |
|---|---|---|
| `apps/api/src/marketplace/` парсеры | ~95% | ✅ fixtures + mocks, ~30 кейсов |
| `apps/api/src/security/` (idempotency, SSRF, auth, ratelimits, helpers) | ~80% | ✅ ~80 кейсов, моки логгера/Prisma |
| `packages/shared/` (i18n, share) | ~60% | ✅ ~60 кейсов |
| `packages/db/` (referral) | ~90% | ✅ in-memory mock Prisma, ~100 кейсов |
| `apps/web/app/miniapp/` (idempotency, startParam) | ~5% | ⚠️ только утилиты |
| **`apps/api/src/routes/` (24 файла)** | **0%** | ❌ |
| **`apps/api/src/services/` (14 файлов)** | **0%** | ❌ |
| **`apps/api/src/schedulers/` (9 файлов)** | **0%** | ❌ |
| **`apps/api/src/notifications/`** | **0%** | ❌ |
| **`apps/bot/src/`** | **0%** | ❌ |
| `packages/ui/`, `packages/ui-tokens/` | **0%** | ❌ |

**Критические дефекты инфраструктуры:**

1. **CI не запускает тесты вообще.** `.github/workflows/deploy.yml` сразу делает SSH + git pull + rebuild. Сломанный тест не блокирует merge или деплой.
2. **Test runner не auto-discover'ит файлы.** `apps/api/package.json` хардкодит 11 файлов в `test` скрипте — новые тесты не подхватываются, пока скрипт не отредактируют. `apps/web`, `apps/bot`, `packages/shared`, `packages/db` вообще не имеют `test` скриптов.
3. **Нет тестовой БД.** Все «интеграционные» тесты на самом деле — юниты с моком Prisma. Реальная схема, миграции, индексы, constraints, P2002-race никак не валидируются.
4. **Нет coverage метрик.** Vitest установлен, но `--coverage` не настроен, нет per-layer таргетов.

## 2. Что показывают инциденты

8 lessons в [BUGFIX_LESSONS.md](BUGFIX_LESSONS.md) + последние 50 fix-коммитов раскладываются так:

| Тип бага | Шт | Где живёт | Тесты есть? |
|---|---|---|---|
| Локаль/i18n в proactive/cron sends | 11 callsites одного бага (2026-05-10) | `services/*.ts`, `schedulers/*.ts`, `notifications/*.ts`, `bot/*.ts` | ❌ |
| Hints state-machine (claim/deliver/dedupe/retry) | 7+ за месяц | `routes/items.routes.ts`, `services/items.ts`, `bot/src/index.ts` | ❌ |
| Calendar (даты, off-by-one, paywall, формы) | 8+ | `routes/me.routes.ts` (календарь), Mini App `calendar/*` | ❌ |
| Birthday-reminders (skip reasons, conversions) | 3 раунда | `schedulers/birthday-reminders.ts`, `services/birthday-reminders.ts` | ❌ |
| Bot resilience (IPv6, network, startup) | 4+ | `apps/bot/src/index.ts` | ❌ |
| Profile P2002 race | повтор 2026-04-30 | `services/telegram-auth.ts` (`getOrCreateProfile`) | ❌ |
| Notifications recipient locale | embedded в lesson #1 | `notifications/commentNotificationQueue.ts`, items services | ❌ |
| Bulk-select UI / token misuse | 1 | Mini App | ❌ |

Покрытие ровно противоположное паттерну инцидентов: парсеры/security — 80–95% (там багов почти нет), а зоны где регулярно горит — 0%.

## 3. Стратегия — тестовая пирамида под наш стек

### 3.1 Tier 1: Unit (vitest, без БД, без сети)

**Что:** чистая логика, формулы, валидация, форматирование, derive-функции.

**Существующее покрытие:** marketplace parsers, security helpers, i18n resolvers, profile derive, sort, referral logic.

**Что добавить (по убыванию приоритета):**
- `services/locale.ts` per-recipient resolution с моками `UserProfile` (закрывает 2026-05-10).
- `services/calendar.ts` daysUntil + UTC normalization.
- `services/lifecycle.ts` wave/touch selection rules.
- `services/birthday-reminders.ts` skip-reason matrix.
- `services/entitlement.ts` plan + grace period.
- `lib/locale.ts`, `lib/http.ts`, `lib/crypto.ts`, `lib/asyncHandler.ts`.

**Инфра:** ноль, vitest уже стоит. Только autodiscover.

### 3.2 Tier 2: Integration с реальным Postgres (vitest + testcontainers)

**Что:** routes → service → Prisma → DB. Schedulers с seeded data. Транзакции, constraint'ы, race conditions.

**Почему testcontainers, а не mock Prisma:** `referral.test.ts` показал, что mock работает для чистой логики, но:
- P2002 race в `getOrCreateProfile` пришлось ловить в проде — мок «помог» написать наивный upsert.
- Hints atomic claim — корректность зависит от `SELECT ... FOR UPDATE` в реальной транзакции, мок не доказывает ничего.
- Locale persistence — middleware пишет `normalizedLocale`, scheduler читает; цепочка работает только если оба видят одну схему.
- BUGFIX_LESSONS правило феодала ([memory: feedback testing.md](https://github.com/anthropics/...)): integration tests должны бить в real DB, а не моки.

**Setup (предложение):**

```ts
// apps/api/test/setup-pg.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';

let container: StartedPostgreSqlContainer;

export async function startTestDb() {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('wishlist_test')
    .withUsername('test')
    .withPassword('test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  execSync('pnpm -C ../../packages/db db:migrate:deploy', { stdio: 'inherit', env: process.env });
  return container.getConnectionUri();
}

export async function stopTestDb() { await container?.stop(); }
```

```ts
// apps/api/vitest.config.ts
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['./test/setup-pg.ts'],
    testTimeout: 15_000,
  },
});
```

Каждый файл получает чистую транзакцию через `prisma.$transaction` + rollback, либо `TRUNCATE` через `setup-each.ts` хук. Для schedulers — отдельный seed-фикстур-файл.

**Альтернатива (если testcontainers тяжёл локально):** docker-compose-based — поднять `wishlist_test` сервис в `docker-compose.dev.yml`, использовать его в local + CI. Менее изолированно, но без зависимости от Docker SDK.

**Что покрываем (по приоритету):**

| # | Зона | Файлы | Сценарии |
|---|---|---|---|
| T2-1 | Locale в proactive path | `services/locale.ts`, `notifications/commentNotificationQueue.ts` | live ctx / persisted / default fallback, per-recipient в fanout |
| T2-2 | Profile race | `services/telegram-auth.ts` | parallel `getOrCreateProfile`, P2002 catch, idempotent result |
| T2-3 | Hints state | `routes/items.routes.ts`, `services/items.ts` | atomic claim, dedupe duplicate `users_shared`, transient retry, idempotency window |
| T2-4 | Birthday-reminders scheduler | `schedulers/birthday-reminders.ts` | skip reasons (no DOB, archived, opt-out), conversion accounting, commenters |
| T2-5 | Lifecycle scheduler | `schedulers/lifecycle.ts` | wave selection, touch dedup, S3 promo code |
| T2-6 | Pro-renewal scheduler | `schedulers/pro-renewal.ts` | grace period, charge attempt, expiry |
| T2-7 | Reservations scheduler | `schedulers/reservations.ts` | reminder cadence, cancellation backoff |
| T2-8 | Idempotency middleware | существует unit-тест, добавить DB-level | реальный `IdempotencyKey` UPSERT, replay window, expiry |
| T2-9 | Critical routes | wishlists.create, items.create, items.reserve, group-gifts.contribute, billing | happy path + 1-2 фейла на каждый |

### 3.3 Tier 3: Bot (vitest + mock Telegraf ctx)

**Что:** command handlers, proactive sends, network resilience, IPv6 DNS fallback, locale resolution для bot ctx.

**Setup:**

```ts
// apps/bot/test/mock-ctx.ts
export function mockCtx(overrides = {}) {
  return {
    from: { id: 12345, language_code: 'ru' },
    chat: { id: 12345, type: 'private' },
    reply: vi.fn(),
    replyWithMarkdown: vi.fn(),
    telegram: { sendMessage: vi.fn(), getChat: vi.fn() },
    ...overrides,
  } as unknown as Context;
}
```

Можно делать `sinon`-style замеры на сетевую обёртку — проверить, что 3 retry с 5s backoff корректно отрабатывают на симулированный `ETIMEDOUT`.

**Что покрываем:**
- `bot/src/index.ts` — `/start`, `/wish`, `/hint` handlers happy path.
- Locale resolution в proactive sends (после fix 2026-05-10) — что `resolveLocaleWithSource` зовётся с persisted profile, без `getChat`.
- Retry: hint delivery network failure → 3 попытки → success.
- IPv6-first DNS workaround — что connect идёт в IPv6 socket.

Реальный Telegraf не запускаем — мокаем `ctx.telegram.*` и `node:dns`.

### 3.4 Tier 4: Frontend компоненты (vitest + React Testing Library + jsdom)

**Что:** Mini App экраны, хуки, `tgFetch` wrapper, idempotency client.

**Setup:**

```ts
// apps/web/vitest.config.ts
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['app/miniapp/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup-dom.ts'],
  },
  resolve: {
    alias: { '@/': new URL('./app/', import.meta.url).pathname },
  },
});
```

Добавляем `@testing-library/react`, `@testing-library/user-event`, `jsdom`, `@testing-library/jest-dom`.

**Что покрываем (по приоритету, не сразу всё):**

| # | Зона | Почему |
|---|---|---|
| T4-1 | Calendar screens (`calendar/*`) | 8+ фиксов за апрель, активно эволюционирует |
| T4-2 | tgFetch + idempotency client | сетевая обёртка, дедуп — уже частично покрыта |
| T4-3 | Hints UI flow | duplicate `users_shared`, transient retry — UX-критично |
| T4-4 | Bulk-select bar (BugLesson 2026-05-08) | regression test для translucent bar |
| T4-5 | Paywall sheet | 402 PRO_REQUIRED — должно показывать, а не silent-save |

**Что НЕ тестим:** `MiniApp.tsx` (1.9 MB монолит). Тратим время на «новый код = новые тесты», старый монолит остаётся untested до момента, когда его рефакторят на компоненты.

### 3.5 Tier 5: E2E (отложено)

Telegram Mini App нельзя нормально e2e — нужен реальный Telegram client, BotFather token, и flaky network. Откладываем до момента, когда либо появится `apps/web` standalone доступ через web (не через TG WebView), либо команда вырастет до 2+ человек.

**Альтернатива — smoke на staging.** Деплой на Vultr → curl /health → проверить ключевые routes с тестовым TG initData. Простой bash, без Playwright.

## 4. CI Integration

### 4.1 Новый workflow

```yaml
# .github/workflows/test.yml
name: Tests
on:
  pull_request:
  push: { branches: [main] }

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: wishlist_test
        ports: [5432:5432]
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10.15.0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -C packages/db build
      - run: pnpm -C packages/db db:migrate:deploy
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/wishlist_test
      - run: pnpm test
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/wishlist_test
      - name: Coverage
        run: pnpm test:coverage
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: coverage, path: '**/coverage/' }
```

### 4.2 Deploy guard

В `deploy.yml` добавить `needs: test` (или required check на GitHub side). Сейчас можно мерджить и деплоить с красными тестами — это первое, что чиним.

### 4.3 Autodiscover

- Root: `"test": "vitest run"` + `vitest.config.ts` в каждом подпакете.
- `apps/api/package.json`: убрать хардкод 11 файлов → `"test": "vitest run"`.
- `apps/web`, `apps/bot`, `packages/shared`, `packages/db`: добавить `"test": "vitest run"` + config.

После этого `pnpm -r test` подхватывает всё.

## 5. Coverage targets

| Слой | Сейчас | 4 нед | 12 нед | Минимум, который держим |
|---|---|---|---|---|
| `marketplace/` | 95% | 95% | 95% | 80% |
| `security/` | 80% | 85% | 90% | 75% |
| `packages/shared/` | 60% | 80% | 85% | 70% |
| `packages/db/` | 90% | 90% | 90% | 80% |
| **`services/`** | 0% | 30% | 70% | 60% |
| **`schedulers/`** | 0% | 40% | 80% | 70% |
| **`routes/`** | 0% | 20% | 50% | 40% |
| **`notifications/`** | 0% | 60% | 80% | 70% |
| **`bot/`** | 0% | 25% | 50% | 40% |
| **`apps/web/app/miniapp/`** | 5% | 10% | 25% | 15% |
| `packages/ui/` | 0% | 0% | 30% (snapshot only) | — |

**Глобальный минимум для нового кода:** все новые `services/*.ts`, `schedulers/*.ts`, `routes/*.routes.ts` приезжают с тестом. PR без теста не мержится (CI gate проверяет, что diff содержит хотя бы один новый `.test.ts` файл рядом, либо изменения в существующих `.test.ts`).

## 6. Roadmap по фазам

### Phase 0 — Foundation (1-2 дня)
**Цель:** тесты запускаются в CI, ничего не ломаем.

- [ ] `.github/workflows/test.yml` с Postgres service + `pnpm test`.
- [ ] `vitest.config.ts` в `apps/api`, `apps/web`, `apps/bot`, `packages/shared`, `packages/db` с autodiscover.
- [ ] Убрать хардкод файлов из `apps/api/package.json` test скрипта.
- [ ] Добавить `test` скрипты в `apps/web`, `apps/bot`, `packages/shared`, `packages/db`.
- [ ] `pnpm test:coverage` команда с `@vitest/coverage-v8`.
- [ ] Required check на GitHub → блокировать merge при красных тестах.

**Acceptance:** PR с заведомо сломанным тестом не мержится.

### Phase 1 — Incident-driven regressions (1 неделя)
**Цель:** регрессионные тесты под каждый из 8 lessons в BUGFIX_LESSONS.

Для каждой записи в [BUGFIX_LESSONS.md](BUGFIX_LESSONS.md) — один тест, который **упал бы до фикса** и **проходит после**.

- [ ] **L-2026-05-10** locale resolver: per-recipient в cron path возвращает persisted `normalizedLocale`, а не EN fallback.
- [ ] **L-2026-05-08 bulk-bar:** snapshot test на `BulkActionBar` — opaque + 5/6/7 кнопок.
- [ ] **L-2026-05-08 images:** lazy-load + thumbnail size cap; тест что в `<img>` есть `loading="lazy"` и `srcset`.
- [ ] **L-2026-05-03 hints:** idempotency window match between frontend tgFetch и backend; atomic claim не отдаёт дубль.
- [ ] **L-2026-04-30 calendar TODAY/TOMORROW:** UTC normalization, daysUntil edge case.
- [ ] **L-2026-04-30 idea photo:** photo upload preserves caret position в price input.
- [ ] **L-2026-04-30 profile race:** parallel `getOrCreateProfile` → одна запись, P2002 caught.
- [ ] **L-2026-04-29 calendar keyboard:** card tappable when keyboard open.

**Acceptance:** 8 регрессий зелёные. Если когда-то снова сломаем — CI кричит.

### Phase 2 — Service layer (2-3 недели)
**Цель:** все 13 live services в [SERVICES.md](SERVICES.md) покрыты ≥60%.

Приоритет:
1. `services/locale.ts` (центр недавнего бага)
2. `services/items.ts` (hints, reservations, notifications)
3. `services/telegram-auth.ts` (profile race)
4. `services/birthday-reminders.ts` + `services/calendar.ts` (active features)
5. `services/lifecycle.ts` + `services/entitlement.ts` (billing-adjacent)
6. Остальные — `analytics`, `onboarding`, `referral-hooks`, `santa-season`, `url-import`, `wishlists`.

### Phase 3 — Schedulers (2 недели)
**Цель:** все 9 cron-модулей покрыты ≥70% (узкий, но критичный surface).

Каждый scheduler — это idempotent function over seeded DB state. Тест: засеять данные, запустить tick, проверить state change + side effects (mocked Telegram calls).

### Phase 4 — Routes (3-4 недели, поэтапно)
**Цель:** ≥50% по `routes/`, фокус на критичных POST/PATCH.

Не пытаемся покрыть все 24 файла равномерно — приоритет по объёму трафика и риску:
1. `items.routes.ts`, `reservations.routes.ts`, `comments.routes.ts` (горячие)
2. `me.routes.ts`, `wishlists.routes.ts`, `group-gifts.routes.ts`
3. `billing.routes.ts`, `referral.routes.ts`, `santa.routes.ts`
4. Остальное — admin, analytics, telemetry, support — best effort.

### Phase 5 — Bot + Frontend pilot (2 недели)
- Bot: locale resolution, retry, /start, /wish.
- Frontend: calendar screens, paywall sheet, hint UI flow.

### Phase 6 — Ongoing discipline
- **Каждый PR с багфиксом** обязан содержать regression test + BUGFIX_LESSONS entry (правило уже есть в `feedback_bugfix_lessons.md`, теперь подкрепляем CI).
- **Каждая новая фича** — минимум один happy path test + 1-2 граничных.
- **Coverage не падает** — CI fails если diff coverage < threshold для затронутых файлов.

## 7. Конкретные шаги Phase 0 (готовы к выполнению по команде)

### 7.1 Установить недостающие dev deps

```bash
# Root — coverage tooling
pnpm add -wD @vitest/coverage-v8

# apps/api — testcontainers + supertest
pnpm -C apps/api add -D @testcontainers/postgresql supertest @types/supertest

# apps/web — RTL stack
pnpm -C apps/web add -D vitest @vitest/coverage-v8 @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom

# apps/bot — vitest
pnpm -C apps/bot add -D vitest @vitest/coverage-v8

# packages/shared, packages/db — vitest
pnpm -C packages/shared add -D vitest @vitest/coverage-v8
pnpm -C packages/db add -D vitest @vitest/coverage-v8
```

### 7.2 vitest.config.ts шаблон

```ts
// apps/api/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/seed.ts', 'src/index.ts'],
      thresholds: {
        statements: 30,  // стартовый, поднимаем по фазам
        branches: 25,
        functions: 30,
        lines: 30,
      },
    },
    testTimeout: 15_000,
  },
});
```

### 7.3 package.json script изменения

```diff
# apps/api/package.json
- "test": "vitest run src/sort.test.ts src/profile.test.ts src/security-auth.test.ts ..."
+ "test": "vitest run",
+ "test:watch": "vitest",
+ "test:coverage": "vitest run --coverage",
```

Аналогично для остальных пакетов.

### 7.4 GitHub workflow

См. § 4.1 выше. Один файл — `.github/workflows/test.yml`. Никаких изменений в `deploy.yml` пока — потом добавим `needs: test`.

## 8. Открытые вопросы

1. **testcontainers vs docker-compose-test:** какой setup проще? testcontainers изолированнее, но требует Docker SDK; compose проще локально, но конкурирует за порты.
2. **Coverage thresholds:** ставим жёсткий gate с первого PR (рискуем долгое время не мержить ничего) или soft-warn первые 4 недели?
3. **Snapshot тесты для UI:** делаем pilot на `Button`/`Card` или откладываем до Phase 5?
4. **Frontend mocking:** мокаем `tgFetch` per-test или делаем msw-style stub для всего API? msw-стайл проще, но больше boilerplate.
5. **Test data:** делаем `factories/` (TypeScript-builder для `User`, `Wishlist`, `Item`) или каждый тест сам сидит?
6. **Кто пишет тесты при многослойном фиксе:** существующее правило в `feedback_bugfix_lessons.md` уже требует BUGFIX_LESSONS — расширяем до «test + lesson + fix в одном коммите»?

## 9. Что НЕ делаем

- **Не пишем тесты на `MiniApp.tsx` (1.9 MB монолит).** Тратим энергию на новый код. Старый покрываем по мере extraction в компоненты.
- **Не пишем e2e через Telegram client.** Слишком flaky, нет инфры.
- **Не пишем тесты ради покрытия.** Если тест дублирует TypeScript типы — не пишем. Если тест на geter/setter — не пишем.
- **Не покрываем `index.ts` (composition root).** По правилам [API_ARCHITECTURE_RULES](API_ARCHITECTURE_RULES.md) там только bootstrap — нечего тестировать.
- **Не делаем mutation testing, property-based testing, fuzz** на этом этапе. После Phase 6, если будет повторяющийся класс багов.

---

## 10. Детальный прогресс по фазам

### Phase 0 — Foundation ✅ DONE (`ceeb92a`)

- `.github/workflows/test.yml` создан, Postgres-service:16-alpine на 5432.
- `vitest.config.ts` в `apps/{api,web,bot}` + `packages/{shared,db}` с
  `passWithNoTests`, V8 coverage reporters, content-aware include globs.
- `pnpm test` / `pnpm test:coverage` / `pnpm test:watch` во всех 5
  пакетах + root команды.
- `apps/api/test/{setup-pg.ts,factories/,README.md}` для будущих DB-tests.
- `apps/web/test/setup-dom.ts` — jest-dom matchers для RTL.
- **Найденный bug при autodiscover:** `apps/api/src/sort.test.ts` имел 3
  failing теста (схема устарела от `updatedAt` к `position` после
  commit `1aa8849`, тест не обновился) — переписан, 10 кейсов, all green.

### Phase 1 — Regressions ✅ DONE (`6b76b1e`)

Из 8 lessons:

- **L1 locale resolver (2026-05-10)** — ✅ уже покрыт `i18n.resolver.test.ts`
  (121 тест включая cron-path).
- **L4 hint window mismatch (2026-05-03)** — ✅ extract `HINT_LOOKUP_WINDOW_MS`
  в `packages/shared`, оба consumer'а (api/routes/hints.routes.ts +
  bot/src/index.ts) импортируют. Pinning test в
  `packages/shared/src/hints-window.test.ts` (3 теста).
- **L5 calendar TODAY/TOMORROW (2026-04-30)** — ✅ extract
  `daysUntilFromUtcMidnight` в `services/calendar.ts`, **+ найден dormant
  bug в детальном endpoint** (line 241 пропущен оригинальным фиксом, жил в
  проде ~15 дней). Фикс + 19 unit-тестов + BUGFIX_LESSONS entry.
- **L7 P2002 race (2026-04-30)** — ✅ уже покрыт `profile.test.ts` (race-safe
  parallel test).
- **L2/L3/L6/L8 (UI lessons)** — ⏳ deferred to Phase 5b. См. § 11.

### Phase 2 — Services ✅ DONE (`59c0068`, `3802b22`, `75697b7`)

**All 14 services covered:**

| Service | LOC | Tests | Coverage |
|---|---|---|---|
| `locale.ts` | 50 | 8 | resolveUserFirstName все ветки |
| `analytics.ts` | 87 | 24 | trackEvent prefix allowlist + truncation |
| `birthday-reminders.ts` | 106 | 27 | MSK-tz arithmetic + Feb29 leap |
| `calendar.ts` | 82 | 19 | daysUntil + getNextOccurrence + reminders |
| `wishlists.ts` | 99 | 8 | primary reassign + drafts auto-create |
| `lifecycle.ts` | 110 | 16 | sendLifecycleDM outcome classifier |
| `locale-detection.ts` | 123 | 12 | header validation + signal aggregation |
| `telegram-auth.ts` | 154 | 19 | initData HMAC + tgActorHash + upsert |
| `items.ts` | 274 | 36 | pure mappers + per-recipient locale fanout |
| `entitlement.ts` | 329 | 54 | PLANS/SKU pin + getEffectiveEntitlements |
| `referral-hooks.ts` | 241 | 18 | qualify + reward pipeline branching |
| `url-import.ts` | 237 | 21 | capacity gate + parse states + image rollback |
| `onboarding.ts` | 311 | 47 | eligibility matrix + completion idempotency |
| `santa-season.ts` | 421 | 45 | cross-year math + deterministic alias gen |

**Total: 354 service tests covering 2 622 LOC of services.**

### Phase 3 — Schedulers 🚧 PARTIAL (`4066c1f`)

**Готово (2/9):**

| Scheduler | LOC | Tests | Coverage |
|---|---|---|---|
| `referral.ts` | 53 | 6 | 15-min sweep + analytics dispatch + error containment |
| `cleanup.ts` | 96 | 10 | 3 hourly TTL jobs (comments, curated subs, archive purge) |

**Pattern (reusable for remaining 7):**

```ts
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();  // drain BEFORE restoring real timers
  vi.useRealTimers();
});

// Inject mocks via deps factory, advance timer, assert dispatch.
startXxxSchedulers({ prisma: mockPrisma, logger: fakeLogger(), ...deps });
await vi.advanceTimersByTimeAsync(INTERVAL_MS);
expect(mockDep).toHaveBeenCalledWith(...);
```

**Pending (7/9):**

- `pro-renewal.ts` (125 LOC) — Pro subscription renewal reminders.
- `events.ts` (172 LOC) — calendar reminder scheduler.
- `billing.ts` (214 LOC) — billing state transitions.
- `santa.ts` (230 LOC) — Secret Santa lifecycle.
- `reservations.ts` (302 LOC) — reservation reminders + auto-release.
- `lifecycle.ts` (419 LOC) — DM win-back wave/touch.
- `birthday-reminders.ts` (1 157 LOC) — birthday wave dispatch.

Highest incident density: `lifecycle.ts` + `birthday-reminders.ts` (recent 2026-05-10 lesson + 3 rounds of birthday fixes).

### Phase 4 — Routes ⏳ PENDING

24 файла, приоритет по трафику (items / reservations / comments сначала,
admin / telemetry — best effort). Большая часть требует integration tests
с real Postgres → DATABASE_URL guard для local skip + auto-run в CI.

### Phase 5a — Bot ⏳ PENDING

Locale resolution в proactive contexts, retry с 3×5s backoff, IPv6-first
DNS, /start /wish /hint command handlers. Mocked Telegraf ctx.

### Phase 5b — Frontend ⏳ DEFERRED

L2 / L3 / L6 / L8 живут внутри `apps/web/app/miniapp/MiniApp.tsx`
(33 246 LOC монолит). Прямое тестирование требует:

- (a) Extraction of `BulkActionBar`, `ItemImage`, `IdeaForm`, `KeyboardAwareCard`
  в отдельные компоненты.
- (b) Setup RTL для mounted-slice testing.

Без extraction единственный доступный регрессионный сигнал — grep-based
lint-style assertion на `loading="lazy"` для image tags. Это даёт low
signal-to-noise — отложено до момента, когда монолит начнут разбивать
на компоненты.

### Phase 6 — CI Discipline ✅ DONE

- `.github/workflows/test.yml` теперь имеет `workflow_call` trigger.
- `.github/workflows/deploy.yml` зависит от `tests` job через
  `needs: tests` — красный test блокирует prod-deploy.
- `CLAUDE.md` секция "Testing — MANDATORY" с iron rules: regression
  test для каждого bug fix, happy + error path для каждого нового
  state-changing endpoint, extract-on-second-callsite правило, никакого
  silent `it.skip`, integration tests > mocks для DB-dependent поведения.

## 11. Phase 5b — что именно отложено и как закрыть

| Lesson | Surface | Что тестировать | Что нужно для extraction |
|---|---|---|---|
| L2 bulk-bar | `MiniApp.tsx` bulk selection mode | opaque background при активной мульти-селекции + grid layout под 4/5/6/7 кнопок | Extract `<BulkActionBar count={n} />` компонент в `packages/ui` или `apps/web/app/miniapp/screens/` |
| L3 image lazy-load | 10+ `<img>` тегов в MiniApp.tsx | каждый item-image имеет `loading="lazy"` + `decoding="async"` | Extract `<ItemThumbnail />` компонент, snapshot test атрибутов |
| L6 idea photo caret | calendar idea form | photo upload не сбрасывает caret position в price input | Extract `<IdeaFormFields />`, RTL focus assertion |
| L8 keyboard cards | calendar idea cards | tappable при visible keyboard | Extract `useKeyboardSafeAreaInset` hook + RTL test через `visualViewport` мок |

Каждый item — отдельный PR: (1) extract в primitive, (2) test, (3)
re-wire MiniApp.tsx callsite на новый компонент. Не делать единым waterfall.

## Открытые вопросы (resolution)

§ 8 из исходного draft — defaults применены:

1. **testcontainers vs docker-compose-test:** ✅ Hybrid — local через
   `docker-compose.dev.yml`, CI через GitHub Actions postgres service.
2. **Coverage thresholds:** ✅ Soft-warn первые 4 недели (no thresholds
   set in vitest.config), enforce per-Phase когда коверидж стабилизируется.
3. **Snapshot тесты для UI:** ✅ Deferred to Phase 5b.
4. **Frontend mocking:** ✅ Per-test `tgFetch` mock — простой подход.
   msw добавится если boilerplate становится noisy.
5. **Test data factories:** ✅ Создан `apps/api/test/factories/` с
   User / Wishlist / Item builders.
6. **Test + lesson + fix дисциплина:** ✅ Включено в CLAUDE.md как
   iron rule, поддержано CI gate `needs: tests`.
