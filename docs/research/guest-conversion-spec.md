# Спека: guest.converted_to_user — first-touch attribution для всех share-link путей

**Дата:** 2026-05-25, **review-обновление 2026-05-27**
**Статус:** spec, готов к pickup (line numbers и план переписаны после code-audit'а)
**Контекст:** последний gate из [`referral-decision.md § 10`](./referral-decision.md#10-status-update-2026-05-25-после-исполнения) — foundation prerequisite перед следующим Referral launch event
**Связано:** [`02-analytics-audit.md § 6.1 row 9`](./02-analytics-audit.md) (P0 critical gap), [`BUGFIX_LESSONS.md 2026-05-25 entry`](../BUGFIX_LESSONS.md)

> **Changelog (2026-05-27 review):** see [§ 10](#10-spec-review-log) — фактические findings разошлись со спекой по двум критическим пунктам, секции §§ 1-3 переписаны.

---

## 1. TL;DR

**Audit-doc неправ.** Событие `guest.converted_to_user` **уже wired** в коде —
`apps/api/src/routes/wishlists.routes.ts:855` (внутри POST /tg/wishlists, после
первого regular wishlist). Эмиссия правильная, props PII-safe, `trackProductEvent`
используется корректно.

**Реальный gap:** условие эмиссии (`evaluateGuestConversion` в
`apps/api/src/services/wishlists.ts:78-91`) требует один из двух сигналов
заполненным:
- `UserProfile.referredByUserId` — устанавливается только через
  `tryCreateAttribution` в **боте** при `?start=ref_<CODE>`, gated `config.enabled`
- `UserProfile.firstAcquisitionSource` — устанавливается через
  POST `/tg/analytics/attribution`, **который вызывается только для
  start-payload `src_*`** (Mini App `MiniApp.tsx:8431-8454`)

**В проде (на 2026-05-25):**
- 315/315 `UserProfile.firstAcquisitionSource` = **NULL** (100%)
- 0/315 `UserProfile.referredByUserId` set
- `guest.converted_to_user`: **1 emit** ever (vs 162 `guest.view_opened`,
  18 `wishlist.created`)

Итого attribution beacon реально не достигает ни одного пользователя,
открывающего настоящий share-link.

---

## 2. Что покрыто, что не покрыто

Mini App bootstrap (`MiniApp.tsx`) обрабатывает 7+ типов start-payload (порядок
веток сверху вниз = `if/else if` в [`MiniApp.tsx:~8270-8500`](../../apps/web/app/miniapp/MiniApp.tsx)):

| # | Start payload | Семантика | Branch line | Attribution call | `firstAcquisitionSource` |
|---|---|---|---|---|---|
| 1 | `birthday_<deliveryId>` | birthday reminder deep link (own / friend wishlist / friend profile) | [:8270 area](../../apps/web/app/miniapp/MiniApp.tsx) | ❌ нет (см. § 6.2 — решение не атрибутировать) | NULL |
| 2 | `<slug>__item_<id>` | item-level deep link (hint / share / птицы) | [:8273](../../apps/web/app/miniapp/MiniApp.tsx) | ❌ нет | NULL |
| 3 | `profile_<username>` | public profile open | [:8371](../../apps/web/app/miniapp/MiniApp.tsx) | ❌ нет | NULL |
| 4 | `SERVICE_START_PARAMS` (`create_wishlist`, `add_first_wish`, `upgrade_pro`, …) | service / own-flow deep link | [:8389](../../apps/web/app/miniapp/MiniApp.tsx) | ❌ нет (правильно — не share) | NULL |
| 5 | `src_<source>__med_<m>__camp_<c>__ref_<r>` | UTM-style external campaign | [:8431](../../apps/web/app/miniapp/MiniApp.tsx) | ✅ POST `/tg/analytics/attribution` | заполнено (но 0 таких юзеров в проде) |
| 6 | `cs_<token>` | curated selection | [:8455](../../apps/web/app/miniapp/MiniApp.tsx) | ❌ нет | NULL |
| 7 | `<shareToken>` (catch-all) | wishlist-level share token (нет префикса) | [:8481](../../apps/web/app/miniapp/MiniApp.tsx) | ❌ нет | NULL |
| 8 | empty / unrecognized | organic | — | ❌ нет (правильно — direct) | NULL |

**Дополнительно (бот, не Mini App):**

| Bot deep link | Файл:строка | Текущее поведение | Gap |
|---|---|---|---|
| `?start=ref_<CODE>` | [`bot/src/index.ts:777-870`](../../apps/bot/src/index.ts) | Бот вызывает `tryCreateAttribution` (gated `config.enabled`), пишет `referredByUserId`. Затем посылает Mini App-кнопку **без payload** — Mini App `ref_*` никогда не видит. | `firstAcquisitionSource` не пишется ни в одной ветке; при program OFF (текущее состояние) и `referredByUserId` тоже не пишется → 100% silent direct. |

**Чистый gap:** 4 Mini App branch'а (`__item_`, `profile_`, `cs_`, catch-all
share-token) + 1 bot branch (`ref_`) должны писать `firstAcquisitionSource`,
но не пишут.

> **Важно — корректировка vs. версии 2026-05-25:** старая спека ошибочно
> предполагала `share_<TOKEN>` prefix (его нет) и Mini-App-овский `ref_<CODE>`
> branch (его тоже нет). Также упускались `profile_` branch и `birthday_` branch
> (см. § 6.2 для решения по birthday).

---

## 3. Что сделать

### 3.1 Бэкенд (без изменений)

`apps/api/src/routes/analytics.routes.ts:31-62` — `/tg/analytics/attribution`
**уже** делает атомарный first-touch (`updateMany WHERE firstAcquisitionSource IS NULL`).
Эндпоинт менять не надо. Sanitize regex `[^a-z0-9_\-]/gi` → `_` ([line 43](../../apps/api/src/routes/analytics.routes.ts:43))
покрывает все ожидаемые source-коды из § 2.

### 3.2 Mini App bootstrap (4 entry path)

Helper — вынести в `apps/web/app/miniapp/lib/attribution.ts` (по архитектурной
параллели с `lib/paywall.ts`, хотя сама `paywall.ts` чисто-логический модуль
без сетевых вызовов — см. § 9 для уточнения паттерна). **Ключевое отличие:**
`tgFetch` определён как closure внутри MiniApp.tsx ([`:4898`](../../apps/web/app/miniapp/MiniApp.tsx:4898)) и
не экспортируется, поэтому helper принимает его параметром (как и
`CalendarRoot`, `SurveyScreen` и другие extracted clusters):

```ts
// apps/web/app/miniapp/lib/attribution.ts (новый файл)

export type SharedAcquisitionSource =
  | 'share_link'
  | 'curated_selection'
  | 'public_profile';

type TgFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Fire-and-forget. POST /tg/analytics/attribution is first-touch-only:
 * server атомарно записывает firstAcquisitionSource ТОЛЬКО при IS NULL —
 * повторные вызовы для того же юзера = безопасный no-op.
 */
export function fireAttributionBeacon(
  tgFetch: TgFetch,
  source: SharedAcquisitionSource,
  ref?: string | null,
): void {
  tgFetch('/tg/analytics/attribution', {
    method: 'POST',
    body: JSON.stringify({
      source,
      medium: 'miniapp',
      ref: ref ?? undefined,
    }),
  }).catch(() => {});
}
```

Затем в **4 точках** bootstrap'а (в каждой вызывать `fireAttributionBeacon(tgFetch, ...)`):

1. **Item deep link** ([`MiniApp.tsx:8273`](../../apps/web/app/miniapp/MiniApp.tsx:8273)) — внутри `else if (startParam && startParam.includes('__item_'))`:
   ```ts
   fireAttributionBeacon(tgFetch, 'share_link', slug);
   ```

2. **Public profile** ([`MiniApp.tsx:8371`](../../apps/web/app/miniapp/MiniApp.tsx:8371)) — внутри `else if (startParam && startParam.startsWith('profile_'))`, после извлечения `username`:
   ```ts
   fireAttributionBeacon(tgFetch, 'public_profile', username);
   ```

3. **Curated selection** ([`MiniApp.tsx:8455`](../../apps/web/app/miniapp/MiniApp.tsx:8455)) — внутри `else if (startParam && startParam.startsWith('cs_'))`, после извлечения `csToken`:
   ```ts
   fireAttributionBeacon(tgFetch, 'curated_selection', csToken);
   ```

4. **Public share catch-all** ([`MiniApp.tsx:8481`](../../apps/web/app/miniapp/MiniApp.tsx:8481)) — внутри финального `else if (startParam)` (это wishlist-level share token без префикса):
   ```ts
   fireAttributionBeacon(tgFetch, 'share_link', startParam);
   ```

**Все 3 source-кода уже в `SHARED_CONTENT_ACQUISITION_SOURCES` allowlist**
([`apps/api/src/services/wishlists.ts:44-50`](../../apps/api/src/services/wishlists.ts:44):
`share_link`, `referral`, `curated_selection`, `public_profile`, `shared`).
Менять allowlist не надо.

### 3.3 Bot referral attribution (1 entry path)

В Mini App `ref_*` branch'а **нет** — бот ловит `?start=ref_<CODE>`
([`bot/src/index.ts:777`](../../apps/bot/src/index.ts:777)) и сам делает Mini App-кнопку
без payload. Поэтому attribution для referral пишем **server-side в боте**, а
не через `/tg/analytics/attribution` (бот не имеет telegram-auth context для
этого endpoint).

**Где писать:** добавить `firstAcquisitionSource='referral'` запись параллельно
с `tryCreateAttribution`. Два возможных place:

- **Вариант A (предпочтительный):** сразу после успешного `tryCreateAttribution`
  ([`bot/src/index.ts:855-862`](../../apps/bot/src/index.ts:855)), внутри блока
  `if (attrResult.kind === 'attributed')`. Это гарантирует, что firstAcquisitionSource
  и referredByUserId всегда консистентны (оба пишутся, или ни одного).

- **Вариант B (более агрессивный):** писать firstAcquisitionSource **независимо** от
  program-enabled gate, т.е. даже в early-return блоке `if (!earlyConfig.enabled)`
  ([:799-813](../../apps/bot/src/index.ts:799)). Это даст аналитику cohort'у "пришли
  по referral", даже когда program OFF и `referredByUserId` не пишется.

  **Решение: Вариант B.** Атрибуция first-touch — это **аналитика**, не
  reward-gating. Знать "юзер пришёл по `?start=ref_X`" ценно для когортного
  анализа независимо от того, активна ли программа. Когда программа вернётся
  ON, оба сигнала (`referredByUserId` + `firstAcquisitionSource='referral'`)
  будут писаться параллельно; пока OFF — пишем хотя бы `firstAcquisitionSource`.

**Код для вставки** в обе ветки бота (early-return disabled + успешная attribution):

```ts
// Helper в bot/src/index.ts (или в @wishlist/db) — первый-туч only, идемпотентно
async function writeReferralAcquisitionSource(
  prisma: PrismaClient,
  inviteeUserId: string,
  refCode: string,
): Promise<void> {
  try {
    await prisma.userProfile.updateMany({
      where: { userId: inviteeUserId, firstAcquisitionSource: null },
      data: {
        firstAcquisitionSource: 'referral',
        firstAcquisitionMedium: 'bot',
        firstAcquisitionRef: refCode,
        firstAcquisitionAt: new Date(),
      },
    });
  } catch (err) {
    logger.warn({ err, inviteeUserId }, '[referral] firstAcquisitionSource write failed');
  }
}
```

И вызывать:
- В early-return disabled-блоке ([:799-813](../../apps/bot/src/index.ts:799)) — после `user` resolve, перед `return ctx.reply(...)`.
- В успешном attribution-блоке (после строки 862, [:862](../../apps/bot/src/index.ts:862)) — рядом с `markFirstBotStart`.

### 3.4 Не нужно делать

- ❌ Backfill 315 существующих профилей. Мы не знаем их first-touch source —
  fabricating это исказит когортную аналитику. Считаем все NULL = "direct/organic"
  retroactively.
- ❌ Менять `evaluateGuestConversion`. Условие правильное (один из двух сигналов).
- ❌ Менять PRODUCT_EVENTS `guest.converted_to_user` declaration. PII-tier
  и source классификация корректны.
- ❌ Атрибутировать `birthday_*` deep link (см. § 6.2 для обоснования).
- ❌ Добавлять `'shared'` или новые коды в `SHARED_CONTENT_ACQUISITION_SOURCES` —
  существующие 5 покрывают всё.

---

## 4. Тесты

### 4.1 Unit — `evaluateGuestConversion`

Уже покрыт в `apps/api/src/services/wishlists.test.ts`. Проверить, что
существующие 4–6 кейсов проходят без правок. Если требует exhaustive
coverage для каждого source в `SHARED_CONTENT_ACQUISITION_SOURCES`,
добавить.

### 4.2 Integration — POST /tg/wishlists эмиссия guest.converted_to_user

Существующий тест `apps/api/src/routes/wishlists.routes.test.ts` (если есть)
+ новые кейсы (один на каждый source из новой ветки § 3.2 + 1 для referral):

- **Sequence happy `share_link`:** атрибутировать пользователя через
  `/tg/analytics/attribution` body `{source:'share_link', ref:'abc123'}`,
  затем POST `/tg/wishlists` → ожидаем `guest.converted_to_user` event
  с `source='share_link'` в `AnalyticsEvent`.
- **Sequence happy `curated_selection`:** аналогично с `{source:'curated_selection'}`.
- **Sequence happy `public_profile`:** аналогично с `{source:'public_profile'}`.
- **Sequence happy `referral`:** записать `firstAcquisitionSource='referral'`
  напрямую через `prisma.userProfile.updateMany` (эмулирует bot-side write
  из § 3.3), затем POST `/tg/wishlists` → ожидаем emit с `source='referral'`.
- **Negative:** атрибутировать `{source:'direct'}` → нет `guest.converted_to_user`
  (direct не в SHARED_CONTENT_ACQUISITION_SOURCES).
- **Negative:** без атрибуции, POST /tg/wishlists → нет emit.
- **Edge:** второй wishlist того же пользователя — emit'а **нет**
  (existingRegular > 1).

### 4.3 Unit — `fireAttributionBeacon` helper

Если выносится в `apps/web/app/miniapp/lib/attribution.ts` (рекомендуется
по примеру [`paywall.ts`](../../apps/web/app/miniapp/lib/paywall.ts) +
[`paywall.test.ts`](../../apps/web/app/miniapp/lib/paywall.test.ts)):

- Mock `tgFetch`, вызвать `fireAttributionBeacon('share_link', 'abc')` →
  проверить, что был один POST `/tg/analytics/attribution` с правильным body.
- Mock `tgFetch.rejects(new Error('network'))`, вызвать helper → проверить,
  что Promise resolved (catch проглатывает), нет unhandled rejection.
- Type-check: вызов с `source: 'random_string'` должен fail typecheck
  (union типизация `SharedAcquisitionSource`).

### 4.4 Unit — bot `writeReferralAcquisitionSource` helper

В [`apps/bot/src/analytics.test.ts`](../../apps/bot/src/analytics.test.ts) добавить:

- **First-touch:** invitee с `firstAcquisitionSource: null` → helper пишет
  `'referral'` + medium=`'bot'` + ref=refCode.
- **Idempotency:** invitee уже с `firstAcquisitionSource: 'share_link'` →
  helper НЕ перезаписывает (updateMany WHERE NULL).
- **Error swallow:** prisma rejects → helper resolves, log.warn вызван.

### 4.5 Frontend smoke — каждый share-link путь дергает beacon

`MiniApp.tsx` bootstrap не unit-тестируется (23k LOC, deep state coupling).

Минимум: вручную в Telegram открыть каждый из **4 Mini App + 1 bot** путей
и проверить через DB:

```sql
SELECT "firstAcquisitionSource", "firstAcquisitionMedium", "firstAcquisitionRef", "firstAcquisitionAt"
FROM "UserProfile" WHERE "userId" = '<test_user>';
```

| Тестовый scenario | Open via | Expected source |
|---|---|---|
| 1. Share wishlist via `?startapp=<token>` | Mini App catch-all | `'share_link'` |
| 2. Share item via `?startapp=<slug>__item_<id>` | Mini App `__item_` branch | `'share_link'` |
| 3. Share curated via `?startapp=cs_<token>` | Mini App `cs_` branch | `'curated_selection'` |
| 4. Open profile via `?startapp=profile_<username>` | Mini App `profile_` branch | `'public_profile'` |
| 5. `/start ref_<CODE>` to bot | Bot referral | `'referral'`, medium=`'bot'` |

---

## 5. Self-check (после мерджа)

> **Changelog 2026-05-28:** Q1 переписан после первого dry-run'а
> [`.github/workflows/referral-self-check.yml`](../../.github/workflows/referral-self-check.yml).
> Старая формулировка считала только NEW users
> (`createdAt >= deploy_date`), но beacon работает first-touch на EXISTING
> users тоже — за 1 день post-deploy в проде было 3 атрибуции (все
> существующих юзеров) и 0 new-user-атрибуций. Старый Q1 = 0%, при
> работающей фиче — потому что 9 новых юзеров за день пришли органикой,
> а не через share. См. § 5.1 нижe для текущей версии.

Автоматизировано через GitHub Actions cron `referral-self-check.yml`,
fires 2026-06-03 07:00 UTC. Можно прогнать вручную через `workflow_dispatch`.

### 5.1 SQL (текущая версия)

```sql
-- Q1: attribution write rate per active Mini App session in window.
-- Numerator: first-touch beacon writes that landed in the window
--   (irrespective of when UserProfile was created — first-touch fires
--    on existing users too).
-- Denominator: distinct userIds with at least one AnalyticsEvent in
--   the window (proxy for "active Mini App users").
SELECT
  (SELECT COUNT(*)
     FROM "UserProfile"
     WHERE "firstAcquisitionAt" >= '<deploy-date>') AS attributed,
  (SELECT COUNT(DISTINCT "userId")
     FROM "AnalyticsEvent"
     WHERE "createdAt" >= '<deploy-date>' AND "userId" IS NOT NULL) AS active_users;
-- expectation: attributed / active_users ≥ 5%
-- (lower than the original 20% — most users come via /start, not share-link;
--  the absolute number matters more than the ratio under steady traffic)

-- Q2: source distribution
SELECT "firstAcquisitionSource", COUNT(*)
FROM "UserProfile"
WHERE "firstAcquisitionAt" >= '<deploy-date>'
  AND "firstAcquisitionSource" IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC;
-- expectation: share_link >> curated_selection > public_profile > referral (~0 если program OFF)

-- Q3: guest.converted_to_user emission rate
SELECT
  (SELECT COUNT(*) FROM "AnalyticsEvent" WHERE event='guest.converted_to_user' AND "createdAt" >= '<deploy-date>') AS converted,
  (SELECT COUNT(*) FROM "AnalyticsEvent" WHERE event='guest.view_opened' AND "createdAt" >= '<deploy-date>') AS views,
  (SELECT COUNT(*) FROM "Wishlist" WHERE "createdAt" >= '<deploy-date>') AS new_wishlists;
-- expectation: converted / new_wishlists > 0.1 (10%+ first-wishlists are guest conversions)
```

**Что считаем pass:**
- ≥ 5% активных Mini App юзеров за период имеют `firstAcquisitionAt` в окне
- `guest.converted_to_user` стреляет ≥ 5 раз за период
- Распределение sources не моноклон (≥ 2 distinct sources)

**Что считаем fail (нужно копать дальше):**
- 0–1% attribution rate → beacon не подключён где-то, или эндпоинт зеркалит ошибку
- 100% одного source → один path работает, остальные забыли подключить
  (для текущего проде состояния `share_link` дominate'ит — нормально, но
   stable-state с 1 источником на 100% означает, что `cs_`/`profile_`/`ref_`
   path'ы либо не используются, либо не подключены)
- emit rate близок к 0 → `evaluateGuestConversion` всё ещё over-gates, копать второй раз

---

## 6. Связанные риски / observations

### 6.1 Risks

1. **`referredByUserId` через `tryCreateAttribution` остаётся gated `config.enabled`.**
   После того как мы флипнули program в OFF (2026-05-25), `referredByUserId`
   **никогда не заполняется**, даже если пользователь приходит по `?start=ref_X`.
   Это OK — bot-side `writeReferralAcquisitionSource` (§ 3.3 Вариант B) пишет
   `firstAcquisitionSource='referral'` независимо. Когда program вернётся
   к ON, оба сигнала будут работать параллельно.
2. **Re-attribution edge.** Если пользователь сначала пришёл по `share_link`,
   потом по `ref_X` — `firstAcquisitionSource` останется `share_link`
   (first-touch wins, `updateMany WHERE IS NULL`). Это сознательное
   поведение — first-touch attribution.
3. **`SHARED_CONTENT_ACQUISITION_SOURCES` не пересекается с `direct`** —
   если человек открыл бот напрямую (organic), `firstAcquisitionSource`
   останется NULL и `guest.converted_to_user` не emit'нется. Это
   правильно — organic это не guest conversion.
4. **Bot-side prisma write timing.** `writeReferralAcquisitionSource` пишет
   ДО того как Mini App может быть открыт. Если invitee не доходит до
   Mini App (заброшен после `/start ref_X`), profile уже атрибутирован.
   Это правильно — first-touch фиксируется в момент первого касания, не
   при первой сессии.

### 6.2 Decision: birthday deep link НЕ атрибутируется

`birthday_<deliveryId>` ([`MiniApp.tsx:8270 area`](../../apps/web/app/miniapp/MiniApp.tsx))
ведёт пользователя на public wishlist/profile именинника. Технически это
"shared content view". Но семантически — это **личное уведомление о
существующем социальном контакте**, не discovery шеренного контента.

**Не атрибутируем, потому что:**
- Юзер уже знает именинника (явный социальный контракт через birthday-feature).
- Атрибуция `'shared'` или `'public_profile'` для birthday-deeplink
  размоет когорту "пришли по shared content" — birthday traffic = retention,
  не acquisition.
- Если пользователь после birthday-link создаёт **свой** первый wishlist —
  это retention-конверсия, не guest-conversion. `guest.converted_to_user`
  для этой когорты будет false-positive.

**Если в будущем понадобится** трекинг birthday→conversion, делать отдельным
событием (`birthday.led_to_first_wishlist` или подобное), не через
`guest.converted_to_user`.

---

## 7. Acceptance / готовность к мерджу

### Mini App
- [ ] Helper `fireAttributionBeacon` вынесен в `apps/web/app/miniapp/lib/attribution.ts` (по примеру `paywall.ts`)
- [ ] Тип `SharedAcquisitionSource` (union) задан в том же файле
- [ ] 4 Mini App entry path вызывают `fireAttributionBeacon` с правильным source:
  - [ ] `__item_` branch (`MiniApp.tsx:8273`) → `'share_link'`
  - [ ] `profile_` branch (`MiniApp.tsx:8371`) → `'public_profile'`
  - [ ] `cs_` branch (`MiniApp.tsx:8455`) → `'curated_selection'`
  - [ ] catch-all share branch (`MiniApp.tsx:8481`) → `'share_link'`

### Bot
- [ ] Helper `writeReferralAcquisitionSource` добавлен в `bot/src/index.ts` (или extracted в `bot/src/lib/attribution.ts`)
- [ ] Вызывается в **обеих** ветках `?start=ref_<CODE>`:
  - [ ] Early-return при `!config.enabled` (`bot/src/index.ts:799-813`)
  - [ ] После успешного `tryCreateAttribution` (`bot/src/index.ts:862`)

### Тесты
- [ ] Unit на `fireAttributionBeacon` (mock tgFetch, happy + reject)
- [ ] Unit на `writeReferralAcquisitionSource` (first-touch + idempotency + error swallow)
- [ ] Integration POST /tg/wishlists для всех 4 sources в § 4.2
- [ ] Manual smoke в Telegram для всех 5 scenarios в § 4.5

### Build + deploy
- [ ] `pnpm test` (api + web + bot) clean
- [ ] `npx tsc --project apps/web/tsconfig.json --noEmit` clean
- [ ] `npx tsc --project apps/api/tsconfig.json --noEmit` clean
- [ ] `npx tsc --project apps/bot/tsconfig.json --noEmit` clean
- [ ] Deploy, run post-deploy health checks (CLAUDE.md § 1)

### Docs
- [ ] Update [`02-analytics-audit.md § 2.10`](./02-analytics-audit.md) — пометить
      `guest.converted_to_user` как fully wired (не P0 gap)
- [ ] Update [`referral-decision.md § 10` row 6](./referral-decision.md#10-status-update-2026-05-25-после-исполнения)
      — пометить `guest.converted_to_user` foundation как Done
- [ ] BUGFIX_LESSONS.md entry с уроком "spec-vs-code drift через 2 дня" — line numbers устаревают, аудит спеки обязателен перед pickup

---

## 8. Эстимат

~2 часа (увеличено vs. оригинальные 1.5ч после review):
- 30 мин — `lib/attribution.ts` helper + 4 Mini App bootstrap entry edits + локальный typecheck
- 20 мин — bot `writeReferralAcquisitionSource` helper + 2 call sites + bot typecheck
- 30 мин — integration tests (4 sources) + bot unit test
- 20 мин — manual prod-mode smoke в Telegram через свой аккаунт (5 scenarios)
- 20 мин — docs update + commit + deploy + post-deploy attribution check

---

## 9. Notes для меня-будущего

- НЕ забыть, что `evaluateGuestConversion` использует `firstAcquisitionSource`,
  не `firstAcquisitionMedium` — medium идёт в props события, не в gating.
- Helper выносить в `apps/web/app/miniapp/lib/attribution.ts` —
  смотреть на [`apps/web/app/miniapp/lib/paywall.ts`](../../apps/web/app/miniapp/lib/paywall.ts) +
  [`paywall.test.ts`](../../apps/web/app/miniapp/lib/paywall.test.ts) как готовый
  референс по структуре файла + тестов.
- `tgFetch` не требует `idempotency` для `/tg/analytics/attribution` — это
  не state-changing с точки зрения пользователя (fire-and-forget telemetry),
  middleware его пропускает без header.
- Все 5 source-кодов уже в `SHARED_CONTENT_ACQUISITION_SOURCES` allowlist
  ([`services/wishlists.ts:44-50`](../../apps/api/src/services/wishlists.ts:44)) —
  ни DB-миграция, ни backend изменения не нужны.
- **Бот не может звать `/tg/analytics/attribution`** — endpoint защищён
  `protectTgRoute` middleware, который требует Telegram WebApp initData
  (есть у Mini App, нет у бота). Поэтому bot-side attribution пишется
  прямым `prisma.userProfile.updateMany`, не через HTTP-эндпоинт.
- **`paywall.ts` — НЕ template для решения tgFetch coupling.** Он
  чисто-логический (parse error envelope, classify upsell context),
  не делает HTTP-вызовов. Поэтому в § 3.2 helper принимает `tgFetch`
  параметром — это паттерн extracted screen modules (`CalendarRoot`,
  `SurveyScreen`), которые также получают `tgFetch` через props.

---

## 10. Spec review log

### 2026-05-27 — review-обновление перед pickup

Сравнил спеку (написана 2026-05-25) с актуальным состоянием кода
(после commits ef19418..d0f9116 включая F4 wave extractions). Найдены
следующие расхождения, секции §§ 1-3 переписаны:

**Критические правки:**

| # | Спека 2026-05-25 | Реальность 2026-05-27 |
|---|---|---|
| 1 | `share_<TOKEN>` start-payload prefix | **Нет такого префикса.** Share token = весь `startParam`, catch-all branch на `:8481` |
| 2 | Mini App `ref_<CODE>` branch с beacon-call | **Branch'а нет.** `ref_*` ловит только бот; Mini App никогда не видит payload. Перенесено в § 3.3 как bot-side `prisma.userProfile.updateMany` |
| 3 | Line refs `:9580-9710`, `:9663-9676`, `:9687` | Дрейф ~−1200 после F4 кластер-extractions (Profile/Showcase/GroupGift/Santa/GiftNotes/Guest/Referral) |
| 4 | `wishlists.routes.ts:854` | `:855` (минус +1) |

**Пропуски в спеке:**

| # | Что пропущено | Решение |
|---|---|---|
| 5 | `profile_<username>` branch (`MiniApp.tsx:8371`) | Добавлен в § 3.2 как 4-й Mini App entry path с source `'public_profile'` |
| 6 | `__item_` branch (`:8273`) — спека упоминала "guest item view" как "find by grep" | Уточнён как явный branch, source `'share_link'` |
| 7 | `birthday_*` deep link semantic | Добавлен § 6.2 — **не атрибутируем** (личное уведомление, не shared-content discovery) |
| 8 | Bot не может звать `/tg/analytics/attribution` (middleware) | Добавлен в § 9 notes |

**Правильные части спеки (без изменений):**
- `evaluateGuestConversion` логика, allowlist состав, `analytics/attribution` endpoint, prod-данные (315/315 NULL, 1 emit ever), self-check SQL queries, decision о no-backfill.

**Урок для BUGFIX_LESSONS.md:**

> Spec, лежащий untracked >48ч в активной кодовой базе, теряет валидность
> line numbers и может содержать архитектурно ошибочные рекомендации
> (например, advise to add code в branch, который не существует). Перед
> pickup любой untracked спеки старше 2 дней — обязательный
> code-audit-pass: grep всех упомянутых файлов/функций/строк, sanity-check
> что bootstrap branching совпадает с описанием.

→ Записано в [`docs/BUGFIX_LESSONS.md` 2026-05-27 entry](../BUGFIX_LESSONS.md).

### 2026-05-27 — implementation скиппнул heavy route-level integration test

Спека § 4.2 предлагала integration test через реальную POST /tg/analytics/attribution
→ POST /tg/wishlists цепочку. При implementation решено **скипнуть** этот test:

- `evaluateGuestConversion` уже **полностью покрыт unit-тестами** для всех 5
  sources + edge cases ([`services/wishlists.test.ts:347-435`](../../apps/api/src/services/wishlists.test.ts)).
- POST `/tg/analytics/attribution` имеет handler-level test
  ([`analytics.routes.test.ts:1-117`](../../apps/api/src/routes/analytics.routes.test.ts)) —
  first-touch atomic update контракт pinned.
- Orchestration в [`wishlists.routes.ts:838-867`](../../apps/api/src/routes/wishlists.routes.ts:838) —
  8 строк (read 3 fields, conditional emit). Marginal value vs. cost
  ~150 LOC route-mock plumbing.
- Manual smoke (§ 4.5) + post-deploy SQL checks (§ 5) closing the loop.

Если через 7 дней self-check (§ 5) покажет emit rate близкий к 0 при
нормальном attribution rate — добавить heavy integration test, копать
дальше в orchestration.
