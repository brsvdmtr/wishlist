# Аналитика WishBoard — аудит

**Дата:** 2026-05-19
**Автор:** product analytics lead audit (Claude)
**Статус:** только аудит, без изменений кода
**Связанные доки:** [ANALYTICS_AND_GODMODE.md](../ANALYTICS_AND_GODMODE.md), [MONETIZATION.md](../MONETIZATION.md), [ONBOARDING_AND_ACTIVATION.md](../ONBOARDING_AND_ACTIVATION.md), [USER_FLOWS.md](../USER_FLOWS.md)

---

## 0. TL;DR

- **Событий очень много** (~220 в allowlist + ~120 дополнительно записываются через prefix-allowlist + ~173 c фронта). Покрытие большинства пользовательских флоу есть.
- **Но есть три системные проблемы:**
  1. **Три параллельных «allowlist»-механизма** живут отдельно и расходятся → данные пишутся непоследовательно. Часть событий из `ANALYTICS_EVENTS` не реализована; часть событий из кода вообще не в allowlist.
  2. **Главного события `payment.completed` нет.** PRO-funnel заканчивается на `checkout_started` / `checkout_succeeded` (клиентский) — серверного «успешный платёж получен» события **нет**, как нет и `pro.activated`/`subscription.created`. Воронку платежей **достроить нельзя** без перехода к `Subscription`/`PaymentEvent` таблицам.
  3. **Нет `user.signup` / `guest.converted_to_user`**. Воронка «гость → новый юзер с attribution» в виде событий не строится; косвенно — через `UserProfile.firstBotStartAt` + `firstAcquisitionAt`.
- **Retention D1/D7/D30: считается**, но через JOIN'ы по таблицам сущностей (User + Wishlist + Item + AnalyticsEvent), не через единый `user.session_started`. **90-дневный TTL на AnalyticsEvent** ограничивает long-term когорты — нужно либо удлинять retention, либо делать nightly aggregation.
- **Связка feature usage ↔ retention/payment работает** через `userId` в AnalyticsEvent + `Subscription`. Главный риск — JSON props без GIN-индекса (запросы по `props->>'plan'` будут сканировать всё).
- **Срочно добавить 12 событий** (см. § 7). Главные: `payment.completed`, `pro.activated`, `user.signup`, `guest.converted_to_user`, `wishlist.shared`, `paywall.viewed` (унифицированный).

---

## 1. Инфраструктура

### 1.1 Таблица `AnalyticsEvent`

```prisma
// packages/db/prisma/schema.prisma
model AnalyticsEvent {
  id        String   @id @default(cuid())
  event     String
  userId    String?
  props     Json?
  createdAt DateTime @default(now())

  @@index([event, createdAt])
  @@index([userId, event])
}
```

- **Retention:** 90 дней, удаляется ночным скриптом [ops/cleanup-analytics.mjs](../../ops/cleanup-analytics.mjs).
- **Индексы:** двух хватает для большинства запросов; **нет GIN на `props`** → запросы вида `WHERE props->>'plan' = 'lifetime'` идут sequential scan.
- **Foreign key на User отсутствует** (userId — просто `String?`), но в коде это всегда наш `User.id`.

### 1.2 Бэкенд-функции записи

[apps/api/src/services/analytics.ts](../../apps/api/src/services/analytics.ts):

| Функция | Поведение | Поведение при отсутствии в allowlist |
|---|---|---|
| `trackEvent(event, userId?, props?)` | Всегда логирует. Пишет в DB **только если** имя события матчит prefix-allowlist: `feature_gate_hit_`, `onboarding_`, `demo_item_`, `gift_`, `first_share_prompt_`, `ready_share_prompt_`, `group_gift_`, `secret_res.`, `showcase.`, `public_profile.`, `error:`. **Требует `userId`.** | Не персистится молча. |
| `trackAnalyticsEvent({event, userId?, props?})` | Проверяет `ANALYTICS_EVENTS` set из `@wishlist/shared`. Truncate props (300 char/string, 1024 байт всего). | Молча дропается. |

**Обе функции — fire-and-forget.** Ошибки Prisma глотаются на `.catch()` и логируются на debug.

### 1.3 Фронтенд → бэкенд

[apps/web/app/miniapp/MiniApp.tsx:5644-5991](../../apps/web/app/miniapp/MiniApp.tsx):

- Буфер `telemetryBufferRef[]`
- Flush: каждые 10 сек + `visibilitychange` + `pagehide` + после bootstrap + unmount
- Endpoint: **`POST /tg/telemetry`** (батч до 20 событий)
- Авто-обогащение: `bootSessionId`, `clientEventId` (UUID для dedup), `ts`
- **Если флаш не успел до закрытия — событие теряется** (нет localStorage-фоллбэка)

[apps/api/src/routes/telemetry.routes.ts](../../apps/api/src/routes/telemetry.routes.ts):

- Свой **третий** allowlist (prefix-based, ~40 префиксов + 3 точных)
- Дропает unknown-события **per-event** (не возвращает 400 на весь батч — урок от 2026-04-13)
- Rate limit: 5 запросов/минуту/userId
- `createMany` пишет в `AnalyticsEvent`

### 1.4 Attribution

[apps/api/src/routes/analytics.routes.ts](../../apps/api/src/routes/analytics.routes.ts):

- `POST /tg/analytics/attribution` — атомарно пишет first-touch в `UserProfile.firstAcquisition*` если поля пусты. Не overwrite.
- Поля: `source`, `medium`, `campaign`, `ref`, `firstAcquisitionAt`.

### 1.5 Ошибки

GlitchTip (Sentry-compatible) — [apps/web/app/miniapp/sentry.ts](../../apps/web/app/miniapp/sentry.ts).
**Хранится отдельно от AnalyticsEvent** — JOIN с retention/payment **невозможен напрямую**.

### 1.6 Параллельные системы наблюдаемости

| Слой | Таблица/поток | Покрытие |
|---|---|---|
| AnalyticsEvent | DB, 90 дней | Все продуктовые события |
| ServiceHeartbeat | DB, 1 строка/сервис | Состояние шедулеров |
| LifecycleTouch | DB, бессрочно | Маркетинг-кампании, retention nudges |
| PaymentEvent | DB, бессрочно | Каждый charge от Telegram |
| ReferralAttribution | DB, бессрочно | Referral funnel + fraud |
| GlitchTip | внешний | Frontend JS errors |
| pino → файл | хост `/opt/wishlist/logs/` | Серверные структурные логи (14 дней) |

### 1.7 Главная архитектурная боль

**Три allowlist'а живут отдельно** и расходятся:

1. `packages/shared/src/analyticsEvents.ts` — `ANALYTICS_EVENTS` (~220 имён)
2. `apps/api/src/services/analytics.ts` — hardcoded prefix list в `trackEvent`
3. `apps/api/src/routes/telemetry.routes.ts` — `ANALYTICS_EVENT_PREFIXES` + `ANALYTICS_EVENT_EXACT`

Из-за этого:
- Допустим, событие `wish.created` лежит в `ANALYTICS_EVENTS` (строка 14), но **нигде в бэкенде не emit'ится** (бэкенд пишет `item_created` / `first_item_created`).
- Большинство `*_hit_*` / `*_created` событий пишутся через `trackEvent` prefix-match → **не валидируются по `ANALYTICS_EVENTS`** → при ошибке в имени никто не заметит.
- На фронте `telemetry.routes.ts` пропускает всё с известными префиксами → даже опечатанные имена попадают в DB.

**Рекомендация (отдельная PR):** свести к одному источнику — генерировать prefix-allowlist в обоих местах из `analyticsEvents.ts` (либо переделать на enum + типизированную хелпер-функцию).

---

## 2. Каталог событий (по продуктовым зонам)

> **Жирным** — те, что попадают в DB. *Курсивом* — заявлены в allowlist, но не имплементированы.

### 2.1 Bot / `/start`

| Событие | Где emit | Persist | Props |
|---|---|---|---|
| **`bot.start_received`** | [apps/bot/src/index.ts:654](../../apps/bot/src/index.ts) | ✅ | `telegramId`, `hasStartParam`, `startParam` |
| **`referral.start_command_received`** | bot/index.ts:781 | ✅ | `refCode`, `hasInviter` |
| **`referral.code_invalid`** | bot/index.ts:781 | ✅ | `refCode` |
| **`referral.attributed`** | bot/index.ts:821 | ✅ | `refCode`, `inviterUserId`, `kind` |

### 2.2 Mini App bootstrap

| Событие | Где emit | Persist | Props |
|---|---|---|---|
| **`miniapp.open_attempt`** | MiniApp.tsx:8559 | ✅ | `platform`, `userAgent`, `release` |
| **`miniapp.bootstrap_started`** | 8696 | ✅ | `startParamType` |
| **`miniapp.bootstrap_succeeded`** | 19 мест | ✅ | `durationMs` |
| **`miniapp.bootstrap_failed`** | 3 места | ✅ | `platform`, `sdkAvailable`, `initData`, `error` |
| **`miniapp.first_rendered`** | 9297 + 9305 | ✅ | `screen`, `durationMs` |
| **`miniapp.boot_timeout`** | 9305 | ✅ | `lastScreen` |
| **`miniapp.fatal_render_error`** | (отсутствует в коде, в allowlist) | ❌ | — |

### 2.3 Onboarding

| Событие | Где emit | Persist | Props |
|---|---|---|---|
| **`onboarding_variant_assigned`** | onboarding.routes.ts:296,377 | ✅ | `variant`, `platform` |
| **`onboarding_started`** | onboarding.routes.ts:309,391 | ✅ | `platform`, `onboardingVariant`, `locale` |
| **`onboarding.step_viewed`** | MiniApp.tsx:8457 | ✅ (через telemetry) | `step`, `variant`, `stepIndex` |
| **`demo_item_created`** | onboarding.routes.ts:403 | ✅ | `itemId`, `catalogId`, `title` |
| **`onboarding_manual_item_added`** | onboarding.routes.ts:636 | ✅ | `platform` |
| **`onboarding_catalog_submitted`** | 708 / клиент 6392 | ✅ | `catalogId`, `count`, `keys` |
| **`onboarding_create_wishlist_success`** | 832 / клиент 6434 | ✅ | `wishlistId`, `platform` / `items_moved` |
| **`onboarding_dismissed`** | onboarding.routes.ts:483 | ✅ | `platform` |
| **`onboarding_completed`** | через trackEvent prefix | ✅ | `onboardingVariant`, `platform`, `finishedVia` |
| **`onboarding_try_paste`** | MiniApp.tsx:6329 | ✅ | `url_domain`, `parse_status` |
| **`onboarding_try_import_*`** | 6309-6333 | ✅ | `error_type` |
| **`onboarding_recovery_*`** | 12003-12013 | ✅ | — |

### 2.4 Wishlists

| Событие | Где emit | Persist | Props |
|---|---|---|---|
| **`wishlist_created`** | wishlists.routes.ts:721 + клиент 9678 | ✅ | `wishlistId`, `type`, `source`, `platform` |
| **`wishlist.created`** | wishlists.routes.ts:729 | ✅ | `source: 'miniapp'` |
| **`first_regular_wishlist_created`** | 727 | ✅ | `wishlistId`, `source`, `platform` |
| **`wishlist_deleted`** / **`wishlist.deleted`** | 910 + MiniApp.tsx:11006 | ✅ | `wishlistId` |
| *`wish.created`* | — | ❌ **в allowlist, нет emit** | — |
| **`share_token_generated`** | 486 | ✅ | `wishlistId` |
| **`share_token_revoked`** | 510 | ✅ | `wishlistId` |
| **`first_share_prompt_shown/share_telegram/copy_link/dismissed/skip`** | MiniApp.tsx:30440-33037 | ✅ | `wishlistId`, `entry` |
| **`ready_share_prompt_shown/share/later`** | MiniApp.tsx:32864-32907 | ✅ | `wishlistId`, `itemsCount`, `entry` |

### 2.5 Items / wishes

| Событие | Где emit | Persist | Props |
|---|---|---|---|
| **`item_created`** | wishlists.routes.ts:1788 + клиент 10638 | ✅ | `itemId`, `wishlistId`, `source`, `platform`, `title`, `description` |
| **`first_item_created`** | 1792 | ✅ | `itemId`, `wishlistType`, `source` |
| **`real_item_created_after_onboarding`** | 1884 | ✅ | `itemId`, `onboardingVariant` |
| **`item_opened`** | MiniApp.tsx:5724 | ✅ | `itemId`, `source` |
| **`item_reserved` / `item_unreserved` / `item_completed`** | 11116-10811 | ✅ | `itemId` |
| **`reservation.succeeded`** | reservations.routes.ts | ✅ | `itemId`, `hasReserverUser?` |
| **`reservation.cancelled`** | reservations.routes.ts | ✅ | `itemId` |
| **`wish.edited` / `wish.deleted` / `wish.completed`** | wishlists.routes | ✅ | `itemId` |
| **`demo_item_converted_to_real`** | trackEvent prefix | ✅ | `itemId` |

### 2.6 Guest / public profile

| Событие | Где emit | Persist | Props |
|---|---|---|---|
| **`guest.view_opened`** | public.routes.ts:266 | ✅ | `slug`, `itemCount` |
| **`public_profile.viewed`** | MiniApp.tsx:6861 | ✅ | `hasShowcase` |
| **`public_profile.wishlist_opened`** | MiniApp.tsx:32554,32711 | ✅ | `source` (pinned/list) |
| **`profile_subscribe` / `profile_unsubscribe`** | MiniApp.tsx:6507,6533 | ✅ | `username` |
| **`profile_open_from_*`** | 13081-17515 | ✅ | `username` |

### 2.7 Paywall / монетизация

| Событие | Где emit | Persist | Props |
|---|---|---|---|
| **`pro_entrypoint_viewed_${context}`** (динамический) | MiniApp.tsx:5742 | ✅ | `context` |
| **`pro_sheet_dismissed_${context}`** | 8309,26089 | ✅ | — |
| **`pro_cta_clicked`** / **`pro_cta_clicked_${context}`** | 7559,26093 | ✅ | `plan` |
| **`checkout_started`** | billing.routes.ts:236 + клиент 7602 | ✅ | `plan` |
| **`checkout_succeeded`** | клиент, 3 места | ✅ (через telemetry) | `plan` |
| **`checkout_failed`** | billing.routes.ts:270,274 + клиент | ✅ | `reason`, `plan` |
| **`pro_lifetime_purchased`** | клиент 7638 | ✅ | — |
| **`subscription_cancel_requested`** | billing.routes.ts:339 | ✅ | — |
| **`subscription.cancelled`** | billing.routes.ts:361 | ✅ | — |
| **`subscription_reactivated`** | billing.routes.ts:395 + клиент 7747 | ✅ | — |
| **`payment.pre_checkout_rejected`** | в allowlist | (нет grep matches) | — |
| ❌ **`payment.completed`** | **НЕТ** | — | — |
| ❌ **`pro.activated`** | **НЕТ** | — | — |
| ❌ **`paywall.viewed`** (унифицированный) | **НЕТ**, заменён динамическими `pro_entrypoint_viewed_*` | — | — |
| **Feature-specific paywall** | напр. `secret_res.paywall_open`, `birthday.paywall_shown`, `search.paywall_shown`, `showcase.paywall_viewed`, `event_reminder_deeplink_paywall` | ✅ | — |

### 2.8 Feature gates

| Событие | Где emit | Persist | Props |
|---|---|---|---|
| **`feature_gate_hit_*`** (~13 видов) | 13 мест в backend routes | ✅ | `plan`, `count?`, `limit?`, `context?` |
| Список ключей: `item_limit`, `wishlist_limit`, `secret_reservations`, `showcase`, `categories`, `curated_selection`, `dont_gift`, `comments`, `hints`, `group_gift`, `pro`, `gift_notes`, `url_import` |

### 2.9 Showcase

| Событие | Где emit | Persist | Props |
|---|---|---|---|
| **`showcase.saved`** / **`showcase.published`** | me.routes.ts:827,829 | ✅ | — |
| **`showcase.cover_uploaded/removed`** | 883,906 | ✅ | — |
| **`showcase.editor_opened`** | MiniApp.tsx:18611 | ✅ | — |
| **`showcase.preview_opened`** | 32014 | ✅ | — |
| **`showcase.share_clicked`** | 32097 | ✅ | — |
| **`showcase.paywall_viewed`** | 18607 | ✅ | — |
| *`showcase.upgrade_clicked`* | в allowlist | ❌ нет emit | — |

### 2.10 Birthday reminders

~20 событий в коде (server + bot + client), ~40 в allowlist. Покрыто детально — самая инструментированная зона. См. [ANALYTICS_AND_GODMODE.md § Birthday Reminders](../ANALYTICS_AND_GODMODE.md).

Gaps:
- `birthday.banner_cta_clicked` — в allowlist, на фронте есть `banner_seen/dismissed` но нет CTA click
- `birthday.owner_*` (3 события) — нет emit
- `birthday.paywall_converted` — нет emit

### 2.11 Referral

~10 событий emit'ятся, в allowlist **68**. Gaps включают:
- Большинство `referral.fraud_*` событий (12 шт) — в коде только итоговый `qualification_timeout`
- `referral.invitee_converted_to_paid` — **критично для оценки ROI рефералки, не emit'ится**
- `referral.invitee_retained_d7` / `d30` — **критично для D7/D30 LTV от рефералов, не emit'ится**

### 2.12 Lifecycle / winback

| Событие | Где emit | Persist | Props |
|---|---|---|---|
| **`lifecycle_${SEGMENT}_touch${N}`** (динамический) | schedulers/lifecycle.ts:385 | ✅ | `segment`, `touchNumber`, `candidate.id` |
| **`promo_winback_eligible`** | через trackEvent prefix | ✅ | `segment`, `touchNumber` |
| **`promo_activated`** | через trackEvent prefix | ✅ | `campaignCode`, `expiresAt` |
| **`promo_winback_deeplink_landed`** | MiniApp.tsx:8948 | ✅ | `segment`, `deeplink` |
| **`promo_winback_redeemed`** | 31416 | ✅ | `segment`, `promoCode`, `status` |
| **`promo_winback_target_completed`** | 10666 | ✅ | `segment`, `promoCode` |

### 2.13 Search

| Событие | Где emit | Persist | Props |
|---|---|---|---|
| **`search.*`** (~11 событий) | SearchScreen.tsx | ✅ (через telemetry) | `queryLength`, `selectedType`, `resultType`, `resultId` |
| **RAW query не логируется** (privacy by design — см. комментарий в `analyticsEvents.ts:202`) |

---

## 3. Можно ли посчитать заданную воронку?

Целевые шаги:

| # | Шаг | Событие(я) | Можно ли посчитать сейчас? |
|---|---|---|---|
| 1 | start bot | `bot.start_received` | ✅ Да (точно) |
| 2 | open mini app | `miniapp.open_attempt` или `miniapp.bootstrap_succeeded` | ✅ Да |
| 3 | onboarding started | `onboarding_started` (server) или `onboarding.step_viewed` (1-й step) | ✅ Да, **но 2 источника** → нужна нормализация в запросе |
| 4 | onboarding completed | `onboarding_completed` | ✅ Да |
| 5 | real item created | `item_created` (filter `props->>'source' != 'demo'`) или `first_item_created` (если интересует именно первый) | ✅ Да |
| 6 | wishlist created | `wishlist_created` / `wishlist.created` / `first_regular_wishlist_created` | ✅ Да, **3 события для одной идеи** — выбрать одно (рекомендую `wishlist_created` как unified) |
| 7 | wishlist shared | `share_token_generated` (генерация токена) + `first_share_prompt_share_telegram` (нажатие "поделиться") | ⚠️ **Частично.** Реальный шар (URL вставлен в Telegram чат / переход по ссылке) **не трекается** напрямую. `Wishlist.shareOpenCount` инкрементируется на каждый GET `/public/share/:token` — это **косвенный proxy**. |
| 8 | guest opened wishlist | `guest.view_opened` (server) + клик inkrement `Wishlist.shareOpenCount` | ✅ Да |
| 9 | item reserved | `reservation.succeeded` или `item_reserved` | ✅ Да |
| 10 | guest converted to user | **❌ НЕТ событиÿ** | ❌ Нет. **Косвенно:** новый `User` чей `UserProfile.firstAcquisitionRef` указывает на shareToken/slug гостевой вьюхи. Реализовано только для shareToken-based attribution через `/tg/analytics/attribution` — но **только если фронт послал attribution, что бывает не всегда**. |
| 11 | paywall viewed | `pro_entrypoint_viewed_*` (динамический по context) + 5 feature-specific `*.paywall_*` | ⚠️ **Фрагментировано.** UNION нескольких событий. Нужен унифицированный `paywall.viewed` с `context` в props. |
| 12 | checkout started | `checkout_started` | ✅ Да |
| 13 | payment completed | **❌ НЕТ серверного события** | ❌ Нет. **Косвенно:** `PaymentEvent` table или `Subscription` создание. Клиентский `checkout_succeeded` есть но не надёжен (может потеряться при flush). |
| 14 | PRO activated | **❌ НЕТ серверного события** | ❌ Нет. **Косвенно:** `Subscription.status = 'ACTIVE'` AND `createdAt = ...` |

### Вывод по воронке

**Полная funnel-таблица в одном SQL-запросе по AnalyticsEvent — нельзя.** Шаги 7, 10, 11, 13, 14 нужно собирать **из других таблиц** (Wishlist, UserProfile, Subscription, PaymentEvent).

Пример practical workaround (Postgres):

```sql
WITH funnel AS (
  SELECT u.id AS user_id,
    -- step 1
    EXISTS (SELECT 1 FROM "AnalyticsEvent" e
            WHERE e."userId" = u.id AND e.event = 'bot.start_received'
            AND e."createdAt" >= u."createdAt") AS s1_bot,
    -- step 2
    EXISTS (SELECT 1 FROM "AnalyticsEvent" e
            WHERE e."userId" = u.id AND e.event IN ('miniapp.open_attempt','miniapp.bootstrap_succeeded')) AS s2_miniapp,
    -- step 4
    EXISTS (SELECT 1 FROM "AnalyticsEvent" e
            WHERE e."userId" = u.id AND e.event = 'onboarding_completed') AS s4_onb_done,
    -- step 5: real item
    EXISTS (SELECT 1 FROM "Item" i
            JOIN "Wishlist" w ON w.id = i."wishlistId"
            WHERE w."ownerId" = u.id AND COALESCE(i."isDemo", FALSE) = FALSE) AS s5_item,
    -- step 6: wishlist
    EXISTS (SELECT 1 FROM "Wishlist" w WHERE w."ownerId" = u.id) AS s6_wl,
    -- step 7: shared (proxy via shareToken existence)
    EXISTS (SELECT 1 FROM "Wishlist" w WHERE w."ownerId" = u.id AND w."shareToken" IS NOT NULL) AS s7_shared,
    -- step 9: reservation in own wishlist
    EXISTS (SELECT 1 FROM "Item" i
            JOIN "Wishlist" w ON w.id = i."wishlistId"
            WHERE w."ownerId" = u.id AND i.status = 'RESERVED') AS s9_reserved,
    -- step 12: checkout
    EXISTS (SELECT 1 FROM "AnalyticsEvent" e
            WHERE e."userId" = u.id AND e.event = 'checkout_started') AS s12_chk,
    -- step 13/14: payment + PRO (single source: Subscription)
    EXISTS (SELECT 1 FROM "Subscription" s
            WHERE s."userId" = u.id AND s.status = 'ACTIVE') AS s14_pro
  FROM "User" u
  WHERE u."createdAt" >= NOW() - INTERVAL '30 days'
)
SELECT
  COUNT(*) FILTER (WHERE s1_bot) AS step1_bot,
  COUNT(*) FILTER (WHERE s2_miniapp) AS step2_miniapp,
  COUNT(*) FILTER (WHERE s4_onb_done) AS step4_onb_done,
  COUNT(*) FILTER (WHERE s5_item) AS step5_item,
  COUNT(*) FILTER (WHERE s6_wl) AS step6_wl,
  COUNT(*) FILTER (WHERE s7_shared) AS step7_shared,
  COUNT(*) FILTER (WHERE s9_reserved) AS step9_reserved,
  COUNT(*) FILTER (WHERE s12_chk) AS step12_chk,
  COUNT(*) FILTER (WHERE s14_pro) AS step14_pro
FROM funnel;
```

**Известные неточности этого запроса:**
- "wishlist shared" = `shareToken IS NOT NULL` — но токен генерится автоматически в onboarding, не означает реальный share. **Лучше**: `shareOpenCount > 0` (хоть один внешний открыл).
- "item reserved" = у владельца есть item со статусом `RESERVED`. Но `Item.status` меняется при отмене → потеряем когорту. **Лучше**: COUNT по `ReservationEvent.type = 'RESERVED'`.
- "guest converted" — невозможно посчитать без события.

---

## 4. D1 / D7 / D30 retention

### 4.1 Что есть

- `User.createdAt` — отправная точка (день signup)
- `UserProfile.firstBotStartAt`, `firstWishlistAt`, `firstItemAt` — точные milestones
- `AnalyticsEvent.createdAt` per `userId` — можно реконструировать "был активен на день N"
- **Нет** `User.lastActiveAt` / `lastSeenAt` ⚠️

### 4.2 Подход к подсчёту

Есть **3 возможных определения активности**:

| Определение | Источник | Плюсы | Минусы |
|---|---|---|---|
| **A. Open Mini App** | `AnalyticsEvent.event = 'miniapp.bootstrap_succeeded'` | Точно отражает "юзер открыл приложение" | 90-дневный TTL → D30 на грани, D60+ невозможно |
| **B. Любое событие** | `AnalyticsEvent WHERE userId = X` | Шире, ловит фоновые действия (резервация, чтение) | Тот же TTL; смешиваются «открытие» и «системные» события (lifecycle touches) |
| **C. Изменение сущности** | `Wishlist.updatedAt` / `Item.updatedAt` / `ReservationEvent.createdAt` | Без TTL, бессрочно | Не ловит "просто открыл и закрыл" — занижение |

**Рекомендация:** определить активность как **A или B**, добавить **`user.session_started`** для надёжности (см. § 7).

### 4.3 SQL: D1/D7/D30 на базе текущей схемы (определение B)

```sql
-- D1/D7/D30 retention для когорты последних 30 дней
WITH cohort AS (
  SELECT id AS user_id, "createdAt"::date AS signup_date
  FROM "User"
  WHERE "createdAt" >= NOW() - INTERVAL '60 days'
    AND "createdAt" <  NOW() - INTERVAL '30 days'  -- даём 30 дней на наблюдение
),
activity AS (
  SELECT DISTINCT "userId", DATE("createdAt") AS active_date
  FROM "AnalyticsEvent"
  WHERE "userId" IS NOT NULL
)
SELECT
  c.signup_date,
  COUNT(*) AS cohort_size,
  COUNT(*) FILTER (
    WHERE EXISTS (SELECT 1 FROM activity a
                  WHERE a."userId" = c.user_id
                  AND a.active_date = c.signup_date + 1)
  )::float / NULLIF(COUNT(*), 0) AS d1,
  COUNT(*) FILTER (
    WHERE EXISTS (SELECT 1 FROM activity a
                  WHERE a."userId" = c.user_id
                  AND a.active_date BETWEEN c.signup_date + 1 AND c.signup_date + 7)
  )::float / NULLIF(COUNT(*), 0) AS d7,
  COUNT(*) FILTER (
    WHERE EXISTS (SELECT 1 FROM activity a
                  WHERE a."userId" = c.user_id
                  AND a.active_date BETWEEN c.signup_date + 1 AND c.signup_date + 30)
  )::float / NULLIF(COUNT(*), 0) AS d30
FROM cohort c
GROUP BY c.signup_date
ORDER BY c.signup_date;
```

### 4.4 Проблемы

1. **90-дневный TTL.** Когорты старше 90 дней теряют активность из `AnalyticsEvent` → D30 retention посчитать ещё можно (если когорта signup ≤60 дней назад), но D60/D90 — нет.
   - **Фикс:** либо удлинить TTL до 180 дней (увеличит DB на ~50 ГБ при текущем темпе, надо проверить), либо ежедневный rollup в отдельную таблицу `UserDailyActivity`.

2. **Любое событие** включает шедулерные emit'ы — например `lifecycle_S3_touch1` пишется на `userId` candidate, и формально это «активность» (но юзер мог даже не открыть пуш).
   - **Фикс:** в WHERE добавить `AND event NOT LIKE 'lifecycle\\_%' AND event NOT LIKE 'birthday.scheduler%' AND event NOT LIKE 'birthday.delivery%'`.

3. **Нет понятия «session».** Юзер открыл app 5 раз за день — посчитается как «1 активный день». Это правильно для retention, но для frequency-метрик нужно вводить session-id.
   - **На фронте** `bootSessionId` уже есть в props, но **в AnalyticsEvent.props.bootSessionId — не индексирован** и не везде доходит.

---

## 5. Связка feature usage ↔ retention ↔ payment

### 5.1 Что доступно

- `AnalyticsEvent.userId` ⇄ `User.id` ⇄ `Subscription.userId` ⇄ `PaymentEvent.userId`
- ⇒ **JOIN возможен** на `userId` без отдельной mapping table.

### 5.2 Пример: «фича X увеличивает вероятность conversion в PRO»

```sql
-- Доля юзеров, использовавших фичу X, ставших PRO в течение 30 дней
WITH feature_users AS (
  SELECT DISTINCT "userId" AS user_id
  FROM "AnalyticsEvent"
  WHERE event = 'secret_res.created'    -- любая фича
    AND "createdAt" >= NOW() - INTERVAL '60 days'
    AND "userId" IS NOT NULL
),
all_users AS (
  SELECT id AS user_id
  FROM "User"
  WHERE "createdAt" >= NOW() - INTERVAL '60 days'
)
SELECT
  'used_feature' AS bucket,
  COUNT(*) AS n,
  COUNT(*) FILTER (
    WHERE EXISTS (
      SELECT 1 FROM "Subscription" s
      WHERE s."userId" = f.user_id
        AND s.status = 'ACTIVE'
        AND s."createdAt" <= NOW()
    )
  )::float / COUNT(*) AS pro_rate
FROM feature_users f
UNION ALL
SELECT
  'all_users',
  COUNT(*),
  COUNT(*) FILTER (
    WHERE EXISTS (
      SELECT 1 FROM "Subscription" s
      WHERE s."userId" = a.user_id
        AND s.status = 'ACTIVE'
    )
  )::float / COUNT(*)
FROM all_users a;
```

### 5.3 Ограничения

1. **JSON props без GIN-индекса** → запросы вроде `props->>'plan' = 'lifetime'` — sequential scan. На 90-дневном объёме (предположительно >1M строк) это медленно. **Рекомендация:** добавить миграцию `CREATE INDEX CONCURRENTLY ... USING gin (props jsonb_path_ops)`.

2. **Нет materialized views** для feature×retention. Каждый аналитический запрос — full scan по AnalyticsEvent. Для нечастых вопросов это OK; для дашборда — нужно делать nightly aggregation.

3. **Привязка `payment` к `feature usage`** делается только через `Subscription.createdAt` (приблизительно равен моменту payment_completed). Не различает renewal vs first activation. **Фикс:** добавить `Subscription.firstActivatedAt` отдельно от `createdAt`, либо ввести `pro.activated` event.

---

## 6. Что отсутствует / неточно

### 6.1 Критично отсутствующие события (P0)

| # | Событие | Зачем | Откуда брать |
|---|---|---|---|
| 1 | **`payment.completed`** | Серверное событие после успешного `successful_payment` от Telegram. Сейчас фронтовый `checkout_succeeded` теряется при потере соединения. | apps/api: handler `successful_payment` в Telegram payment flow |
| 2 | **`pro.activated`** | Точный момент перехода в PRO (созданная или продлённая подписка с `currentPeriodStart > now()`). | apps/api: всё, что создаёт `Subscription` с `status=ACTIVE` |
| 3 | **`subscription.renewed`** | Отличить новую активацию от продления. | apps/api: handler subscription renewal |
| 4 | **`subscription.expired`** | Серверное событие, когда `currentPeriodEnd < NOW()` и юзер не продлил. | scheduler |
| 5 | **`paywall.viewed`** (унифицированный) | Сейчас 13 разных событий — нельзя посчитать единый «paywall view rate». | заменить все `pro_entrypoint_viewed_*` и `*.paywall_*` на 1 событие с `context` в props |
| 6 | **`paywall.cta_clicked`** | Унифицированный аналог `pro_cta_clicked_*` + `*.paywall_cta_*` | то же |
| 7 | **`user.signup`** | Точная привязка к моменту создания `User` row + первый attribution. Сейчас приходится JOIN'ить `User.createdAt`. | apps/api: handler в `getOrCreateProfile` / `/tg/auth` |
| 8 | **`guest.converted_to_user`** | Воронка «гость → юзер» сейчас невозможна. | apps/api: emit при первом создании `User` если есть `referredBy*` или `firstAcquisitionRef` указывающий на shareToken |
| 9 | **`wishlist.shared`** | Реальный шар, не просто токен. Триггер: фронтовый success native share API или `copy_link` confirm. | client + server-side инкремент `Wishlist.shareOpenCount` уже есть, но нет event |
| 10 | **`user.session_started`** | Один marker на каждое cold-start открытие mini app для retention. Уже почти есть в виде `miniapp.bootstrap_succeeded`, но имя не семантическое. | можно alias'нуть |
| 11 | **`referral.invitee_converted_to_paid`** | В allowlist, не emit'ится. Критично для ROI рефералки. | apps/api: post-payment + проверка `ReferralAttribution.invitedUserId = userId` |
| 12 | **`referral.invitee_retained_d7` / `d30`** | В allowlist, не emit'ится. | scheduler ежедневно |

### 6.2 Менее критичные пробелы (P1)

- **Profile edit events** — нет: редактирование name/username/bio/avatar
- **Settings screen opened** — есть только в birthday-контексте (`birthday.settings_opened`); нет универсального `settings.opened`
- **Notification list opened** — нет (не путать с deep-link from notification)
- **Calendar feature** — нулевая телеметрия (упомянуто во фронт-аудите как «zero telemetry»)
- **Screen navigation** — не трекается явно (можно инфер'ить из контекстов, но это хрупко)
- **Wishlist viewed (own)** — нет события открытия своего wishlist (только `wishlist_detail_open_*` который трекает успех/ошибку open, но не "просто посмотрел")
- **Comment viewed** — нет (только `comment_reply_*` события)
- **Import events** (`import.started/succeeded/failed`) — в allowlist, нет emit
- **`birthday.banner_cta_clicked`** — есть seen/dismissed, нет click

### 6.3 Качественные проблемы

1. **Дублирующиеся события для одной идеи:**
   - `wishlist_created` (snake) + `wishlist.created` (dot) — оба emit'ятся при одном действии (см. wishlists.routes.ts:721,729).
   - `item_created` + `wish.created` (последний в allowlist, не emit'ится).
   - Нужно унифицировать (см. § 8 taxonomy).

2. **Несоответствие client → server событий:**
   - Фронт: `wishlist_created` с props `{wishlistId}`.
   - Бэк: `wishlist_created` с props `{wishlistId, type, source, platform}`.
   - В DB лежат **обе строки** с разным набором props на один user-action.

3. **PII / sensitivity:**
   - В props пишутся `title`, `description` item'ов (`item_created`) — это **пользовательский контент** в analytics. Стоит решить: оставлять? шифровать? хешировать?
   - Search query НЕ логируется — это правильно. Но запись `title` в `item_created.props.title` — таже сенситивная зона.

4. **Нет `_truncated: true` обработки на read-side.** Если props переехали в `{ _truncated: true }`, при анализе мы теряем context — но не понимаем причину. Стоит добавить отдельную колонку `truncated BOOLEAN`.

5. **`createdAt` AnalyticsEvent на бэке = server-side now()**, а на фронте `/tg/telemetry` ставит `ts` из клиента (clamped to last hour). Это значит, что серверные и клиентские события **не сравнимы по time** в пределах ~ часа. Для cross-source funnel'ов это шум.

---

## 7. Срочные к добавлению события

Приоритет 0 (нужно для базовой product analytics):

```
1. user.signup
2. payment.completed
3. pro.activated
4. subscription.renewed
5. subscription.expired
6. paywall.viewed              (унифицированный)
7. paywall.cta_clicked         (унифицированный)
8. wishlist.shared             (реальный шар, не токен)
9. guest.converted_to_user
10. referral.invitee_converted_to_paid
```

Приоритет 1 (для feature-attribution и retention quality):

```
11. user.session_started       (alias miniapp.bootstrap_succeeded, более семантично)
12. import.started / succeeded / failed   (в allowlist уже, добавить emit)
13. referral.invitee_retained_d7 / d30    (scheduler-emit)
14. settings.opened            (унифицированный)
15. notification.opened / .read
```

См. § 9 ниже — структура properties для каждого.

---

## 8. Предлагаемая taxonomy

### 8.1 Конвенция именования

Текущий код смешивает 4 стиля: `snake_case`, `domain.action`, `domain_subdomain_action`, динамические `${context}`. Это путает.

**Предлагаю один стиль для всех новых:**

```
<domain>.<action>[_<modifier>]
```

- Только **lowercase** + **dot** для domain/action разделения.
- Только **underscore** внутри одного слова (если многословное).
- Динамические части → **в props**, не в имени события.

Примеры:
- ✅ `wishlist.created`, `wishlist.shared`, `wishlist.archived`
- ✅ `payment.completed`, `payment.failed`, `pro.activated`
- ✅ `paywall.viewed` + `props.context = 'item_limit'`
- ❌ `pro_entrypoint_viewed_item_detail` → `paywall.viewed { context: 'item_detail' }`
- ❌ `feature_gate_hit_secret_reservations` → `feature_gate.hit { feature: 'secret_reservations' }`
- ❌ `lifecycle_S3_touch1` → `lifecycle.touch_sent { segment: 'S3', touch: 1 }`

### 8.2 Стандартные domains

| Domain | Описание | Примеры |
|---|---|---|
| `user.*` | Identity / session | `user.signup`, `user.session_started`, `user.deleted` |
| `bot.*` | Telegram bot events | `bot.start_received`, `bot.command_executed` |
| `miniapp.*` | Bootstrap / lifecycle | `miniapp.bootstrap_succeeded` |
| `wishlist.*` | Wishlist CRUD/share | `wishlist.created`, `wishlist.shared` |
| `item.*` (был `wish.*`) | Item CRUD/state | `item.created`, `item.reserved`, `item.completed` |
| `reservation.*` | Резервации | `reservation.succeeded` |
| `secret_res.*` | Secret reservations | оставить как есть, переименовать в `secret_reservation.*` |
| `share.*` | Share-flow specific | `share.token_generated`, `share.link_copied` |
| `guest.*` | Гостевая воронка | `guest.viewed_wishlist`, `guest.converted_to_user` |
| `paywall.*` | Paywall views/CTAs | `paywall.viewed`, `paywall.cta_clicked` |
| `payment.*` | Платежи | `payment.completed`, `payment.failed` |
| `subscription.*` | Подписки | `subscription.created`, `subscription.cancelled`, `subscription.renewed`, `subscription.expired` |
| `pro.*` | PRO state | `pro.activated`, `pro.expired` |
| `feature_gate.*` | Лимиты | `feature_gate.hit { feature, plan, count, limit }` |
| `onboarding.*` | Онбординг | оставить, унифицировать `_` → `.` (`onboarding.started`, `onboarding.completed`) |
| `referral.*` | Реферальная программа | оставить |
| `birthday.*` | Birthday reminders | оставить |
| `lifecycle.*` | Маркетинг-touches | `lifecycle.touch_sent`, `lifecycle.touch_clicked` |
| `promo.*` | Промокоды | `promo.activated`, `promo.redeemed` |
| `search.*` | Поиск | оставить |
| `showcase.*` | Профиль/showcase | оставить |
| `import.*` | URL-импорт | `import.started`, `import.succeeded`, `import.failed` |
| `notification.*` | Push/in-app | `notification.opened`, `notification.read` |
| `settings.*` | Настройки | `settings.opened`, `settings.changed` |
| `error.*` | Технические ошибки | `error.client_js`, `error.api_500` |

### 8.3 Стандартные properties (любое событие)

Эти 5 свойств должны быть на **каждом** событии (server- или client-side):

```ts
{
  ts: number,                  // ms epoch
  sessionId: string,           // uuid, persistent within Mini App boot
  source: 'server' | 'miniapp' | 'bot' | 'web',
  release: string,             // SHA или semver
  platform: 'ios' | 'android' | 'web' | 'desktop' | 'server' | 'bot',
}
```

(Сейчас `bootSessionId`/`clientEventId` идут только из MiniApp.tsx через telemetry; серверные события их не имеют.)

---

## 9. Предлагаемые properties по событиям

> Только для событий из срочного списка (§ 7). Существующие события можно мигрировать постепенно.

### user.signup
```ts
{
  // standard 5
  acquisitionSource: string | null,    // 'organic'|'referral'|'paid_ads'|'invite_link'
  acquisitionMedium: string | null,
  acquisitionCampaign: string | null,
  acquisitionRef: string | null,       // shareToken/refCode если был
  referredByUserId: string | null,
  telegramPremium: boolean,
  locale: string,                       // 'ru'|'en'|'es'|'zh-CN'|'ar'|'hi'
  platform: 'ios'|'android'|'desktop'|'web',
  firstStartParam: string | null,      // raw startParam if any
}
```

### user.session_started
```ts
{
  isFirstSession: boolean,
  daysSinceSignup: number,
  daysSinceLastSession: number | null,  // null если первая
  entryPoint: 'cold_start'|'deeplink'|'notification'|'bot_button',
  startParam: string | null,
}
```

### payment.completed
```ts
{
  paymentEventId: string,                 // PaymentEvent.id
  subscriptionId: string | null,          // Subscription.id если связан
  telegramPaymentChargeId: string,
  plan: 'monthly'|'annual'|'lifetime',
  billingPeriod: 'monthly'|'annual'|null,
  amountStars: number,                    // totalAmount
  currency: 'XTR',
  isFirstPayment: boolean,                // true если первый платеж user'а
  isUpgrade: boolean,                     // monthly→annual или any→lifetime
  invoicePayload: string,
}
```

### pro.activated
```ts
{
  subscriptionId: string,
  source: 'first_purchase'|'renewal'|'referral_bonus'|'admin_grant'|'promo_grant',
  plan: 'monthly'|'annual'|'lifetime',
  billingPeriod: 'monthly'|'annual'|null,
  currentPeriodStart: string,            // ISO
  currentPeriodEnd: string,
  isFirstActivation: boolean,
}
```

### subscription.renewed
```ts
{
  subscriptionId: string,
  renewalNumber: number,                  // 1, 2, 3...
  previousPeriodEnd: string,
  newPeriodEnd: string,
  isCharged: boolean,                     // false если renewal без charge (extension)
  amountStars: number | null,
}
```

### subscription.expired
```ts
{
  subscriptionId: string,
  reason: 'period_ended_no_renewal'|'cancelled_at_period_end',
  expiredAt: string,
  totalRevenueStars: number,              // суммарно за время этой Subscription
}
```

### paywall.viewed
```ts
{
  context: 'item_limit'|'wishlist_limit'|'secret_reservations'|'showcase'|'categories'|
           'curated_selection'|'dont_gift'|'comments'|'hints'|'group_gift'|'gift_notes'|
           'url_import'|'search'|'birthday'|'pro_section'|'home_banner'|'profile',
  trigger: 'feature_gate'|'cta_tap'|'auto_402'|'tab_switch'|'deeplink',
  currentPlan: 'FREE'|'PRO_MONTHLY'|'PRO_ANNUAL'|'PRO_LIFETIME',
  presentedPlans: ('monthly'|'annual'|'lifetime')[],
}
```

### paywall.cta_clicked
```ts
{
  context: <same as paywall.viewed>,
  plan: 'monthly'|'annual'|'lifetime',
  cta: 'primary'|'secondary',             // если две кнопки
  timeFromViewMs: number,                  // время от paywall.viewed до клика
}
```

### wishlist.shared
```ts
{
  wishlistId: string,
  channel: 'telegram_native'|'copy_link'|'system_share'|'qr_code',
  entry: 'first_share_prompt'|'ready_share_prompt'|'header_button'|'item_detail'|'group_gift'|...,
  shareToken: string,                      // первые 8 символов для tracking без полного токена
  itemCount: number,
}
```

### guest.converted_to_user
```ts
{
  newUserId: string,
  viaShareToken: string | null,           // shareToken по которому пришёл
  viaWishlistId: string | null,           // wishlist который смотрел гость
  viaRefCode: string | null,              // если это реферал
  viewedWishlistsCount: number,           // сколько гостевых вьюх было до signup
  daysFromFirstViewToSignup: number,
}
```

### referral.invitee_converted_to_paid
```ts
{
  invitedUserId: string,
  inviterUserId: string,
  referralAttributionId: string,
  paymentEventId: string,
  plan: 'monthly'|'annual'|'lifetime',
  amountStars: number,
  daysFromAttributionToPayment: number,
}
```

---

## 10. SQL / Prisma queries для ключевых метрик

### 10.1 Daily new users (DAU/MAU не считаем сейчас — нет session events)

```sql
SELECT DATE("createdAt") AS d, COUNT(*) AS new_users
FROM "User"
WHERE "createdAt" >= NOW() - INTERVAL '30 days'
GROUP BY 1 ORDER BY 1 DESC;
```

### 10.2 D1/D7/D30 retention (определение B, см. § 4.3)

См. § 4.3.

### 10.3 Активация (signup → first wishlist)

```sql
-- % юзеров, создавших первый wishlist в первые 24h / 7d / 30d
SELECT
  COUNT(*) AS signups,
  COUNT("firstWishlistAt") AS ever_created_wishlist,
  COUNT(*) FILTER (WHERE "firstWishlistAt" - u."createdAt" <= INTERVAL '1 day')::float / COUNT(*) AS activation_24h,
  COUNT(*) FILTER (WHERE "firstWishlistAt" - u."createdAt" <= INTERVAL '7 days')::float / COUNT(*) AS activation_7d,
  COUNT(*) FILTER (WHERE "firstWishlistAt" - u."createdAt" <= INTERVAL '30 days')::float / COUNT(*) AS activation_30d
FROM "User" u
LEFT JOIN "UserProfile" p ON p."userId" = u.id
WHERE u."createdAt" >= NOW() - INTERVAL '60 days'
  AND u."createdAt" <  NOW() - INTERVAL '30 days';
```

### 10.4 Воронка onboarding'а (server-side)

```sql
WITH events AS (
  SELECT "userId",
    MAX(event = 'onboarding_started')::int AS s_started,
    MAX(event = 'demo_item_created')::int AS s_demo,
    MAX(event = 'onboarding_create_wishlist_success')::int AS s_wl,
    MAX(event = 'onboarding_completed')::int AS s_done,
    MAX(event = 'onboarding_dismissed')::int AS s_dismissed
  FROM "AnalyticsEvent"
  WHERE event LIKE 'onboarding%' OR event LIKE 'demo\\_item%'
    AND "createdAt" >= NOW() - INTERVAL '30 days'
  GROUP BY "userId"
)
SELECT
  SUM(s_started) AS started,
  SUM(s_demo) AS demo_item,
  SUM(s_wl) AS wishlist_created,
  SUM(s_done) AS completed,
  SUM(s_dismissed) AS dismissed,
  SUM(s_done)::float / NULLIF(SUM(s_started), 0) AS completion_rate
FROM events;
```

### 10.5 Воронка payment (через сущности, не AnalyticsEvent)

```sql
-- За последние 30 дней
WITH cohort AS (
  SELECT id FROM "User" WHERE "createdAt" >= NOW() - INTERVAL '30 days'
),
checkout AS (
  SELECT DISTINCT "userId" FROM "AnalyticsEvent"
  WHERE event = 'checkout_started' AND "createdAt" >= NOW() - INTERVAL '30 days'
),
paid AS (
  SELECT DISTINCT "userId" FROM "PaymentEvent"
  WHERE "createdAt" >= NOW() - INTERVAL '30 days'
),
pro AS (
  SELECT DISTINCT "userId" FROM "Subscription"
  WHERE status = 'ACTIVE'
)
SELECT
  (SELECT COUNT(*) FROM cohort) AS signups,
  (SELECT COUNT(*) FROM checkout) AS checkout_started,
  (SELECT COUNT(*) FROM paid) AS paid,
  (SELECT COUNT(*) FROM pro) AS currently_pro;
```

### 10.6 ARPPU / ARPU

```sql
WITH cohort AS (
  SELECT id FROM "User" WHERE "createdAt" >= NOW() - INTERVAL '30 days'
),
revenue AS (
  SELECT pe."userId", SUM(pe."totalAmount") AS stars
  FROM "PaymentEvent" pe
  JOIN cohort c ON c.id = pe."userId"
  GROUP BY pe."userId"
)
SELECT
  COUNT(*) AS payers,
  SUM(stars) AS total_stars,
  AVG(stars) AS arppu_stars,
  SUM(stars)::float / (SELECT COUNT(*) FROM cohort) AS arpu_stars
FROM revenue;
```

### 10.7 Cohort retention matrix (signup week × week N retention)

```sql
WITH cohort AS (
  SELECT id AS user_id, DATE_TRUNC('week', "createdAt")::date AS cohort_week
  FROM "User"
  WHERE "createdAt" >= NOW() - INTERVAL '90 days'
),
activity AS (
  SELECT DISTINCT "userId" AS user_id, DATE_TRUNC('week', "createdAt")::date AS active_week
  FROM "AnalyticsEvent"
  WHERE event = 'miniapp.bootstrap_succeeded'
    AND "createdAt" >= NOW() - INTERVAL '90 days'
)
SELECT
  c.cohort_week,
  EXTRACT(WEEK FROM AGE(a.active_week, c.cohort_week))::int AS week_n,
  COUNT(DISTINCT c.user_id) AS active_users
FROM cohort c
JOIN activity a ON a.user_id = c.user_id AND a.active_week >= c.cohort_week
GROUP BY 1, 2
ORDER BY 1, 2;
```

### 10.8 Feature × Conversion (пример: secret_res → PRO)

См. § 5.2.

### 10.9 Referral funnel (по `ReferralAttribution.status`)

```sql
SELECT
  COUNT(*) FILTER (WHERE status = 'PENDING_ACTIVATION') AS pending,
  COUNT(*) FILTER (WHERE status = 'QUALIFIED') AS qualified,
  COUNT(*) FILTER (WHERE status = 'REWARDED') AS rewarded,
  COUNT(*) FILTER (WHERE status = 'REJECTED') AS rejected,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status IN ('QUALIFIED','REWARDED')) / NULLIF(COUNT(*), 0), 1) AS qualification_rate_pct,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'REJECTED') / NULLIF(COUNT(*), 0), 1) AS reject_rate_pct
FROM "ReferralAttribution"
WHERE "createdAt" >= NOW() - INTERVAL '30 days';
```

### 10.10 Topline: текущее состояние PRO

```sql
-- Snapshot: active PRO, MRR (приблизительно)
SELECT
  COUNT(*) AS active_pro,
  COUNT(*) FILTER (WHERE "billingPeriod" = 'monthly') AS monthly,
  COUNT(*) FILTER (WHERE "billingPeriod" = 'annual') AS annual,
  COUNT(*) FILTER (WHERE "planCode" LIKE '%LIFETIME%') AS lifetime,
  SUM("starsPrice") FILTER (WHERE "billingPeriod" = 'monthly') AS monthly_mrr_stars,
  SUM("starsPrice") FILTER (WHERE "billingPeriod" = 'annual') / 12 AS annual_mrr_equiv_stars
FROM "Subscription"
WHERE status = 'ACTIVE'
  AND "currentPeriodEnd" > NOW();
```

### 10.11 Lifecycle / winback effectiveness

```sql
-- За последние 30 дней: сколько touch'ей сконвертили в return / target_completed / promo_redeemed
SELECT
  segment,
  "touchNumber",
  COUNT(*) AS sent,
  COUNT(*) FILTER (WHERE delivered) AS delivered,
  COUNT(*) FILTER (WHERE "returnedAt" IS NOT NULL) AS returned,
  COUNT(*) FILTER (WHERE "targetCompletedAt" IS NOT NULL) AS target_completed,
  COUNT(*) FILTER (WHERE "promoRedeemedAt" IS NOT NULL) AS promo_redeemed,
  ROUND(100.0 * COUNT(*) FILTER (WHERE "returnedAt" IS NOT NULL) / NULLIF(COUNT(*) FILTER (WHERE delivered), 0), 1) AS return_rate_pct
FROM "LifecycleTouch"
WHERE "sentAt" >= NOW() - INTERVAL '30 days'
GROUP BY 1, 2
ORDER BY 1, 2;
```

### 10.12 Quick error overview

```sql
SELECT event, COUNT(*)
FROM "AnalyticsEvent"
WHERE event LIKE 'error%' OR event LIKE 'miniapp.bootstrap_failed' OR event LIKE 'checkout_failed'
  AND "createdAt" >= NOW() - INTERVAL '1 day'
GROUP BY event
ORDER BY COUNT(*) DESC;
```

---

## 11. Action items (без кода — это только аудит)

В порядке приоритета:

1. **Решить вопрос с тремя allowlist'ами** — свести к одному источнику в `packages/shared/src/analyticsEvents.ts`. Префикс-allowlist'ы в `trackEvent` и `telemetry.routes.ts` сгенерировать программно.
2. **Добавить 10 критичных событий** (§ 7 P0): `user.signup`, `payment.completed`, `pro.activated`, `subscription.renewed`, `subscription.expired`, `paywall.viewed`, `paywall.cta_clicked`, `wishlist.shared`, `guest.converted_to_user`, `referral.invitee_converted_to_paid`.
3. **Добавить GIN-индекс на `AnalyticsEvent.props`** — миграция `CREATE INDEX CONCURRENTLY ... USING gin (props jsonb_path_ops)`. Сразу ускорит все запросы с фильтром по props.
4. **Решить retention TTL** — 90 дней блокирует D60/D90. Либо удлинить до 180 (+ оценить размер БД), либо ежедневный rollup в `UserDailyActivity` (дешёво и навсегда).
5. **Унифицировать дублирующие имена**: `wishlist_created` vs `wishlist.created`, `item_created` vs `wish.created`. Выбрать одно (предлагаю dot-стиль), мигрировать запросы, дропнуть второе.
6. **Решить вопрос с PII в props**: `item_created.props.title` — пользовательский контент в analytics. Принять решение: оставить, хешировать, или удалить.
7. **Добавить (или унифицировать) `user.session_started`** для надёжного retention. Сейчас `miniapp.bootstrap_succeeded` работает как proxy, но имя не семантическое и может потеряться при rebrand.
8. **Имплементировать заявленные но не существующие events**: `import.*` (6 шт), большинство `referral.fraud_*` (12 шт), `birthday.banner_cta_clicked`, `birthday.paywall_converted`, `birthday.owner_*` (3 шт), `showcase.upgrade_clicked`.

**Этот аудит — только наблюдение.** Изменения в коде, миграции БД, новые события — отдельным PR, после ревью этого документа.
