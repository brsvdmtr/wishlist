# Research — Segmentation Queries

**Цель:** дать аналитику / маркетингу / продактам набор готовых SQL + Prisma
запросов для 14 пользовательских сегментов, на которых дальше выстраиваются
эксперименты, CRM-волны, in-app коммуникации и юзер-интервью.

**Скоуп:** только данные, которые уже лежат в продовом Postgres. Третьи
системы (Mixpanel, GA и т.п.) не подключены — все нижеперечисленные источники
живут в той же БД, к которой ходит `apps/api`.

**Дата составления:** 2026-05-19. Сверено со схемой
[`packages/db/prisma/schema.prisma`](../../packages/db/prisma/schema.prisma) и
с фактическим списком эмиттированных событий в коде
([analytics.ts](../../apps/api/src/services/analytics.ts),
[telemetry.routes.ts](../../apps/api/src/routes/telemetry.routes.ts),
[analyticsEvents.ts](../../packages/shared/src/analyticsEvents.ts)).

---

## 0. Сводка источников

### 0.1 Таблицы продовой БД, на которых стоят сегменты

| Таблица | Что хранит | Где живёт write-path |
|---|---|---|
| `User` | id, telegramId, createdAt, **updatedAt = last-seen proxy** (touched на каждый Mini-App запрос через `getOrCreateTgUser`), godMode | [services/telegram-auth.ts:140](../../apps/api/src/services/telegram-auth.ts) |
| `UserProfile` | birthday, locale, marketBucket, **firstAcquisitionSource/Medium/Campaign**, referredByUserId, **firstWishlistAt / firstItemAt / firstBotStartAt** | profile-маршруты |
| `Wishlist` | ownerId, **shareToken** (NOT NULL ⇔ юзер выпустил ссылку), **shareOpenCount** (инкрементится на каждом `/public/share/:token`), archivedAt, type (`REGULAR` / `SYSTEM_DRAFTS`) | [routes/wishlists.routes.ts:486](../../apps/api/src/routes/wishlists.routes.ts) |
| `Item` | wishlistId, **isDemo**, **originType** (`MANUAL` / `IMPORTED` / `DEMO`), **becameRealAt**, importMethod, status | items / onboarding роуты |
| `ReservationEvent` | itemId, type (`RESERVED`/`UNRESERVED`/`PURCHASED`), **actorHash** (anonymous!), createdAt | reservations / public роуты |
| `ReservationMeta` | reserverUserId (когда гость = известный TG-юзер), purchased, active | reservations роут |
| `Subscription` | userId, planCode=`PRO`, status, **billingPeriod** (`monthly`/`yearly`/`lifetime`), currentPeriodEnd | bot `successful_payment` handler |
| `PaymentEvent` | userId, telegramPaymentChargeId, **eventType**, totalAmount, createdAt | bot + billing.routes.ts |
| `Purchase` | userId, **skuCode** (add-on / credit pack), telegramChargeId | bot addon flow |
| `AnalyticsEvent` | `event`, userId, props (JSONB), createdAt — **серверная и фронтовая телеметрия** | [services/analytics.ts](../../apps/api/src/services/analytics.ts) + [telemetry.routes.ts](../../apps/api/src/routes/telemetry.routes.ts) |
| `LifecycleTouch` | userId, **segment** (`S1`/`S2`/`S3`/`S4`), sentAt, returnedAt, targetCompletedAt | [schedulers/lifecycle.ts](../../apps/api/src/schedulers/lifecycle.ts) |
| `ForeignWishlistAccess` | userId, wishlistId, **source** (`share_link` / `curated_selection` / …), firstOpenedAt | services/foreign-wishlist-access.ts |
| `SantaCampaign` / `SantaParticipant` | Secret Santa | santa роут |
| `GroupGift` / `GroupGiftParticipant` | Group Gift | group-gifts роут |

### 0.2 Что персистится в `AnalyticsEvent` (важно знать перед запросом)

`AnalyticsEvent` — единственный «event log». Туда пишут **два разных**
функционала, у каждого свой allow-list:

**Server-side** `trackEvent(...)` ([services/analytics.ts:44](../../apps/api/src/services/analytics.ts)) — пишет
только если name начинается на один из этих префиксов **И** есть `userId`:

```
feature_gate_hit_, onboarding_, demo_item_, gift_,
first_share_prompt_, ready_share_prompt_, group_gift_,
secret_res., showcase., public_profile., error:
```

**Server-side** `trackAnalyticsEvent({...})` ([services/analytics.ts:68](../../apps/api/src/services/analytics.ts)) — пишет
только если `event ∈ ANALYTICS_EVENTS` ([packages/shared/src/analyticsEvents.ts](../../packages/shared/src/analyticsEvents.ts)).
`userId` может быть **NULL** (e.g. `guest.view_opened`).

**Frontend** `trackEvent(...)` → POST `/tg/telemetry` ([telemetry.routes.ts:29](../../apps/api/src/routes/telemetry.routes.ts)) — пишет
любое событие, чьё имя матчит один из 30+ префиксов или входит в EXACT-set
(`api_server_error`, `pro_cta_clicked`, `error_boundary_triggered`). Важные
для сегментации префиксы: `checkout_`, `addon_`, `share.`, `guest.`,
`wishlist.`, `wish.`, `import.`, `reservation.`, `subscription_`, `payment.`,
`banner_`, `lifecycle_`.

⚠️ **Двойная запись `wishlist.created` / `wish.created`:** эмиттится и из
бекенда (`trackAnalyticsEvent`), и с фронта (`trackEvent`). Для подсчёта
distinct-юзеров на эти события — `COUNT(DISTINCT userId)`, не `COUNT(*)`.

⚠️ **`checkout_started` пишется только с фронта.** Серверный
`trackEvent('checkout_started', ...)` в [billing.routes.ts:236](../../apps/api/src/routes/billing.routes.ts) — это
только лог, в `AnalyticsEvent` НЕ попадает (префикс `checkout_` не в
персист-листе `trackEvent`). Для checkout-сегментов опираемся на
`PaymentEvent` (надёжный) + frontend `checkout_*` (best-effort).

### 0.3 Прокси «last seen»

`User.updatedAt` обновляется на **каждом** аутентифицированном Mini-App
запросе через `getOrCreateTgUser` (даже если ничего не менялось — telegramId,
firstName и т.д. перезаписываются upsert-ом). Это самый плотный сигнал «юзер
открыл приложение». В роли last-active работает корректно.

---

## 1. Создали real item

**Определение:** есть хотя бы один `Item`, который НЕ помечен как demo. Real
item = `isDemo = false` **И** (`originType ≠ 'DEMO'` ИЛИ `becameRealAt IS NOT NULL`).
`becameRealAt` стамп ставится в [services/onboarding.ts:287](../../apps/api/src/services/onboarding.ts), когда
demo-айтем конвертится в реальный.

```sql
SELECT DISTINCT w."ownerId" AS user_id
FROM "Item" i
JOIN "Wishlist" w ON w.id = i."wishlistId"
WHERE i."isDemo" = false
  AND i."status" <> 'DELETED'
  AND w."type" = 'REGULAR'
  AND w."archivedAt" IS NULL;
```

Prisma:

```ts
const users = await prisma.user.findMany({
  where: {
    wishlists: {
      some: {
        type: 'REGULAR',
        archivedAt: null,
        items: {
          some: { isDemo: false, status: { not: 'DELETED' } },
        },
      },
    },
  },
  select: { id: true, telegramId: true },
});
```

**Корнер-кейсы:**
- Айтемы из URL-import имеют `originType='IMPORTED'`, `isDemo=false` — попадают сюда.
- Demo, который потом стал реальным: `originType='DEMO'`, `isDemo=true`, `becameRealAt IS NOT NULL`. Если хочешь включить — добавь `OR i."becameRealAt" IS NOT NULL` к WHERE.

---

## 2. Создали wishlist, но не поделились

**Определение:** есть хотя бы один `Wishlist` (type=REGULAR, не archived), у
которого `shareToken IS NULL`. Юзер также не имеет ни одного wishlist с
`shareOpenCount > 0` (иначе это сегмент 3).

```sql
SELECT u.id AS user_id, u."telegramId"
FROM "User" u
WHERE EXISTS (
  SELECT 1 FROM "Wishlist" w
  WHERE w."ownerId" = u.id
    AND w."type" = 'REGULAR'
    AND w."archivedAt" IS NULL
)
AND NOT EXISTS (
  SELECT 1 FROM "Wishlist" w
  WHERE w."ownerId" = u.id
    AND w."type" = 'REGULAR'
    AND w."shareToken" IS NOT NULL
);
```

Prisma:

```ts
await prisma.user.findMany({
  where: {
    wishlists: { some: { type: 'REGULAR', archivedAt: null } },
    NOT: {
      wishlists: { some: { type: 'REGULAR', shareToken: { not: null } } },
    },
  },
  select: { id: true, telegramId: true },
});
```

**Корнер-кейсы:**
- Юзер мог получить `shareToken`, но потом отозвать (DELETE share-token →
  `shareToken=NULL`). Тогда он попадёт в этот сегмент. Чтобы отделить
  «никогда не делился» от «отозвал», скрести с `AnalyticsEvent.event='share.token_generated'`.

---

## 3. Поделились wishlist

**Определение:** есть хотя бы один wishlist с `shareToken IS NOT NULL`. Более
строго — есть **хотя бы один открытый снаружи** wishlist (`shareOpenCount > 0`),
т.е. ссылку реально прислали кому-то.

```sql
-- Вариант A: «нажал на share» (получил токен, но возможно никто не открыл)
SELECT DISTINCT w."ownerId" AS user_id
FROM "Wishlist" w
WHERE w."shareToken" IS NOT NULL
  AND w."type" = 'REGULAR';

-- Вариант B: «реально получил входящий клик» (более жёсткий)
SELECT DISTINCT w."ownerId" AS user_id
FROM "Wishlist" w
WHERE w."shareOpenCount" > 0
  AND w."type" = 'REGULAR';

-- Вариант C: «нажимал «Поделиться» в Mini App» (вариант с event-log)
SELECT DISTINCT "userId" AS user_id
FROM "AnalyticsEvent"
WHERE event = 'share.token_generated' AND "userId" IS NOT NULL;
```

Prisma (вариант B):

```ts
await prisma.user.findMany({
  where: {
    wishlists: { some: { type: 'REGULAR', shareOpenCount: { gt: 0 } } },
  },
  select: { id: true },
});
```

---

## 4. Guest открыл чужой wishlist

**Определение:** «guest» = TG-юзер, открывший wishlist, который ему не
принадлежит. Два источника:

| Источник | Сила сигнала | Когда писать |
|---|---|---|
| `AnalyticsEvent` event=`guest.view_opened` | Любое открытие slug-страницы | userId **может быть NULL** (`guest.view_opened` пишется без userId — см. [public.routes.ts:266](../../apps/api/src/routes/public.routes.ts)). Подходит только для агрегаций по slug, не для сегментации юзера. |
| `ForeignWishlistAccess` | Гость прошёл auth и открыл «чужой» wishlist | Надёжный — пишется через [services/foreign-wishlist-access.ts](../../apps/api/src/services/foreign-wishlist-access.ts). Source = `share_link` / `curated_selection` / `subscription` / `profile` / `reservation` / `santa` / `direct_open`. |

```sql
-- Юзеры, открывшие хоть один чужой wishlist
SELECT DISTINCT "userId" AS user_id
FROM "ForeignWishlistAccess";

-- Только через расшаренную ссылку
SELECT DISTINCT "userId" AS user_id
FROM "ForeignWishlistAccess"
WHERE source = 'share_link';
```

Prisma:

```ts
await prisma.user.findMany({
  where: { foreignWishlistAccesses: { some: { source: 'share_link' } } },
  select: { id: true },
});
```

**Workaround:** если хочется учесть анонимных гостей (не залогиненных в
Mini App), для слаженной аналитики slug-открытий — `guest.view_opened` с
`userId IS NULL` остаётся единственным источником, но это «view-count», а
не «user-count».

---

## 5. Guest сделал reservation

**Определение:** юзер забронировал чужой айтем. Два источника:

| Источник | Что даёт |
|---|---|
| `ReservationMeta.reserverUserId` | Известный TG-юзер, сделавший резерв. Самый чистый сигнал — это уже «person», а не «actor». |
| `AnalyticsEvent` event=`reservation.succeeded` | Все резервы, включая анонимные через `actorHash`. |
| `ReservationEvent.type='RESERVED'` | То же, но через cold log; `actorHash` анонимный, прямой матч на User не сделать. |

```sql
-- A: known TG-users
SELECT DISTINCT rm."reserverUserId" AS user_id
FROM "ReservationMeta" rm
JOIN "Item" i ON i.id = rm."itemId"
JOIN "Wishlist" w ON w.id = i."wishlistId"
WHERE w."ownerId" <> rm."reserverUserId"   -- именно ЧУЖОЙ айтем
  AND rm."active" = true;

-- B: include anon via AnalyticsEvent (when userId is set)
SELECT DISTINCT "userId" AS user_id
FROM "AnalyticsEvent"
WHERE event = 'reservation.succeeded'
  AND "userId" IS NOT NULL;
```

Prisma:

```ts
const reservers = await prisma.reservationMeta.findMany({
  where: { active: true, item: { wishlist: { NOT: { ownerId: { equals: prisma.reservationMeta.fields.reserverUserId } } } } },
  select: { reserverUserId: true },
  distinct: ['reserverUserId'],
});
```

(Prisma не умеет «self-join» в where — на практике проще `$queryRaw`.)

---

## 6. Пользователь видел paywall

**Определение:** юзер хотя бы раз увидел экран «нужно PRO». В коде это
расщеплено на несколько подтипов:

| Тип paywall | Событие |
|---|---|
| Server-side 402 на фиче (хиты лимита, см. сегмент 9) | `feature_gate_hit_*` |
| Showcase paywall sheet | `showcase.paywall_viewed` |
| Search PRO paywall | `search.paywall_shown` |
| Secret Reservation paywall | `secret_res.paywall_open` |
| Birthday Reminders paywall | `birthday.paywall_shown` |
| Generic «купить PRO» CTA tap | `pro_cta_clicked` (exact event) |
| Event Reminder deeplink paywall | `event_reminder_deeplink_paywall` |

```sql
-- Юзеры, у которых был хоть один paywall-event
SELECT DISTINCT "userId" AS user_id
FROM "AnalyticsEvent"
WHERE (
  event LIKE 'feature_gate_hit_%'
  OR event = 'showcase.paywall_viewed'
  OR event = 'search.paywall_shown'
  OR event = 'secret_res.paywall_open'
  OR event = 'birthday.paywall_shown'
  OR event = 'pro_cta_clicked'
  OR event = 'event_reminder_deeplink_paywall'
)
AND "userId" IS NOT NULL;

-- Разрез по типу paywall (для funnel)
SELECT
  CASE
    WHEN event LIKE 'feature_gate_hit_%' THEN 'feature_gate'
    WHEN event = 'showcase.paywall_viewed' THEN 'showcase'
    WHEN event = 'search.paywall_shown' THEN 'search'
    WHEN event = 'secret_res.paywall_open' THEN 'secret_res'
    WHEN event = 'birthday.paywall_shown' THEN 'birthday'
    WHEN event = 'pro_cta_clicked' THEN 'pro_cta'
    ELSE event
  END AS paywall_kind,
  COUNT(DISTINCT "userId") AS user_count
FROM "AnalyticsEvent"
WHERE "userId" IS NOT NULL
  AND (event LIKE 'feature_gate_hit_%'
       OR event IN ('showcase.paywall_viewed','search.paywall_shown',
                    'secret_res.paywall_open','birthday.paywall_shown',
                    'pro_cta_clicked','event_reminder_deeplink_paywall'))
GROUP BY 1
ORDER BY user_count DESC;
```

**Пробелы:**
- ⚠️ Нет единого `paywall.viewed` — каждое место эмиттит своё имя. Если
  заведём общий `paywall.viewed { kind, context }`, нынешний union превратится
  в `WHERE event = 'paywall.viewed'`.
- ⚠️ Нет события «paywall закрыли без покупки» (paywall.dismissed). Для
  funnel «viewed → checkout_started» считаем через `LEFT JOIN` (см. сегмент 7).

---

## 7. Пользователь начал checkout

**Определение:** юзер нажал «купить» и Telegram-инвойс был создан. Два
надёжных источника:

| Источник | Когда |
|---|---|
| `PaymentEvent.eventType IN ('invoice_created','addon_invoice_created','gift_notes_invoice_created')` | Сервер реально создал инвойс через `createInvoiceLink` ([billing.routes.ts:286](../../apps/api/src/routes/billing.routes.ts)). **Канонический сигнал.** |
| `AnalyticsEvent.event IN ('checkout_started','addon_checkout_started','gift_notes_checkout_started')` | Фронт залогировал клик через `/tg/telemetry`. Best-effort — теряется при rate-limit на телеметрии. |

```sql
-- A: канонически — реально созданы инвойсы
SELECT DISTINCT "userId" AS user_id
FROM "PaymentEvent"
WHERE "eventType" IN (
  'invoice_created', 'addon_invoice_created', 'gift_notes_invoice_created'
);

-- B: с фронта (для funnel anchor «нажали кнопку»)
SELECT DISTINCT "userId" AS user_id
FROM "AnalyticsEvent"
WHERE event IN ('checkout_started', 'addon_checkout_started', 'gift_notes_checkout_started')
  AND "userId" IS NOT NULL;
```

Prisma:

```ts
const startedCheckout = await prisma.paymentEvent.findMany({
  where: { eventType: { in: ['invoice_created', 'addon_invoice_created', 'gift_notes_invoice_created'] } },
  distinct: ['userId'],
  select: { userId: true },
});
```

---

## 8. Пользователь оплатил PRO / add-on

**Определение:** успешный платёж = есть запись в `PaymentEvent` с
`eventType` из списка успехов, и/или активная `Subscription` / запись в
`Purchase`. Самый прямой и надёжный источник — `PaymentEvent`:

| eventType | Что значит |
|---|---|
| `payment_success` | PRO monthly успешно прошёл |
| `payment_success_yearly` | PRO yearly успешно прошёл |
| `payment_success_lifetime` | PRO lifetime успешно прошёл |
| `addon_payment_success` | Add-on (extra_wishlist_slot, hints_pack_*, import_pack_*, *_unlock и т.д.) успешно прошёл |
| `payment_success_post_lifetime` | Audit-only, лайфтайм-юзер получил monthly-charge — не считать «новой оплатой» |

```sql
-- Все, кто хоть раз заплатил (PRO или add-on)
SELECT DISTINCT "userId" AS user_id
FROM "PaymentEvent"
WHERE "eventType" IN (
  'payment_success', 'payment_success_yearly', 'payment_success_lifetime',
  'addon_payment_success'
);

-- Только PRO
SELECT DISTINCT "userId" AS user_id
FROM "PaymentEvent"
WHERE "eventType" IN ('payment_success', 'payment_success_yearly', 'payment_success_lifetime');

-- Только add-on (с разрезом по SKU)
SELECT u.id AS user_id, p."skuCode", p."createdAt"
FROM "Purchase" p
JOIN "User" u ON u.id = p."userId"
WHERE p."status" = 'completed'
ORDER BY p."createdAt" DESC;

-- Активные PRO прямо сейчас (для CRM «уже Pro — не показываем upsell»)
SELECT s."userId"
FROM "Subscription" s
WHERE s."planCode" = 'PRO'
  AND s."status" = 'ACTIVE'
  AND (s."currentPeriodEnd" > NOW() OR s."billingPeriod" = 'lifetime');
```

Prisma:

```ts
const proUsers = await prisma.subscription.findMany({
  where: {
    planCode: 'PRO',
    status: 'ACTIVE',
    OR: [
      { currentPeriodEnd: { gt: new Date() } },
      { billingPeriod: 'lifetime' },
    ],
  },
  select: { userId: true, billingPeriod: true, currentPeriodEnd: true },
});
```

---

## 9. Пользователь уперся в лимит

**Определение:** хотя бы один `feature_gate_hit_*` event. Это и есть
канонический сигнал «упёрся в лимит / Pro-gate» — пишется server-side при
любом 402-ответе.

Известные суффиксы (gen-ed via grep по `apps/api/src/routes/`):

```
feature_gate_hit_wishlist_limit      — попытка создать N+1 wishlist
feature_gate_hit_item_limit          — попытка добавить N+1 wish
feature_gate_hit_hints               — попытка послать хинт без кредитов
feature_gate_hit_url_import          — URL-import без PRO/кредитов
feature_gate_hit_categories          — попытка создать категории (Pro-only)
feature_gate_hit_dont_gift           — «не дарите» (Pro-only)
feature_gate_hit_comments            — комментарии PRO-only
feature_gate_hit_showcase            — showcase PRO-only
feature_gate_hit_curated_selection   — curated PRO-only
feature_gate_hit_secret_reservations — secret reservation add-on
feature_gate_hit_group_gift          — group gift add-on
feature_gate_hit_gift_notes          — gift notes (Pro / add-on)
feature_gate_hit_pro                 — generic (tests-only?)
```

```sql
-- Все, кто хоть раз упёрся
SELECT DISTINCT "userId" AS user_id
FROM "AnalyticsEvent"
WHERE event LIKE 'feature_gate_hit_%'
  AND "userId" IS NOT NULL;

-- Топ-причин (за последние 30 дней)
SELECT event, COUNT(DISTINCT "userId") AS users, COUNT(*) AS hits
FROM "AnalyticsEvent"
WHERE event LIKE 'feature_gate_hit_%'
  AND "createdAt" >= NOW() - INTERVAL '30 days'
GROUP BY event
ORDER BY users DESC;

-- Сегмент «упёрся, но НЕ купил» (= кандидат на ремаркетинг)
WITH limit_hits AS (
  SELECT DISTINCT "userId" AS user_id
  FROM "AnalyticsEvent"
  WHERE event LIKE 'feature_gate_hit_%' AND "userId" IS NOT NULL
),
paid AS (
  SELECT DISTINCT "userId" AS user_id
  FROM "PaymentEvent"
  WHERE "eventType" LIKE 'payment_success%' OR "eventType" = 'addon_payment_success'
)
SELECT lh.user_id
FROM limit_hits lh
LEFT JOIN paid p ON p.user_id = lh.user_id
WHERE p.user_id IS NULL;
```

---

## 10. Пользователь использовал URL import

**Определение:** хотя бы одна попытка / успех URL-импорта. Несколько
взаимодополняющих сигналов:

| Источник | Что значит |
|---|---|
| `AnalyticsEvent` event=`import.started` / `import.succeeded` / `import.failed` | Mini-App URL-import (через `/tg/import`). Пишется через `trackAnalyticsEvent` в [import.routes.ts:115](../../apps/api/src/routes/import.routes.ts). |
| `AnalyticsEvent` event=`import.bot_started` / `import.bot_succeeded` / `import.bot_failed` | Импорт через бот-форвард (юзер кинул URL прямо в бота). |
| `Item.originType='IMPORTED'` | Любой айтем, рождённый из URL-импорта (онбординг-импорт тоже сюда попадает). Структурный сигнал. |
| `Item.importMethod` | Текстовое значение `'onboarding_manual'` / `'onboarding_catalog'` / scraper-name. Не None ⇒ был импорт. |

```sql
-- Любая попытка использовать URL-import (started — самый широкий funnel-top)
SELECT DISTINCT "userId" AS user_id
FROM "AnalyticsEvent"
WHERE event IN ('import.started', 'import.bot_started')
  AND "userId" IS NOT NULL;

-- Только успешные импорты (event-based)
SELECT DISTINCT "userId" AS user_id
FROM "AnalyticsEvent"
WHERE event IN ('import.succeeded', 'import.bot_succeeded')
  AND "userId" IS NOT NULL;

-- Структурно — есть импортированные айтемы
SELECT DISTINCT w."ownerId" AS user_id
FROM "Item" i
JOIN "Wishlist" w ON w.id = i."wishlistId"
WHERE i."originType" = 'IMPORTED'
  AND i."status" <> 'DELETED';
```

Prisma:

```ts
await prisma.user.findMany({
  where: {
    wishlists: { some: { items: { some: { originType: 'IMPORTED', status: { not: 'DELETED' } } } } },
  },
  select: { id: true },
});
```

---

## 11. Пользователь использовал Secret Santa

**Определение:** юзер либо организовал кампанию, либо джойнился к чужой.
Структурный сигнал — `SantaCampaign` + `SantaParticipant`.

```sql
-- Любой контакт с Santa (организатор ИЛИ участник)
SELECT DISTINCT user_id FROM (
  SELECT "ownerId" AS user_id FROM "SantaCampaign"
  WHERE status <> 'CANCELLED'
  UNION
  SELECT "userId" AS user_id FROM "SantaParticipant"
  WHERE status = 'JOINED'
) t;

-- Только организаторы
SELECT DISTINCT "ownerId" AS user_id
FROM "SantaCampaign"
WHERE status IN ('OPEN','LOCKED','ACTIVE','COMPLETED');

-- Только участники (без своих кампаний)
SELECT DISTINCT sp."userId" AS user_id
FROM "SantaParticipant" sp
JOIN "SantaCampaign" sc ON sc.id = sp."campaignId"
WHERE sp.status = 'JOINED'
  AND sc."ownerId" <> sp."userId";

-- Прошли до конца раунда (получили подарок)
SELECT DISTINCT sp."userId" AS user_id
FROM "SantaAssignment" sa
JOIN "SantaParticipant" sp ON sp.id = sa."receiverParticipantId"
WHERE sa."giftStatus" = 'RECEIVED';
```

Prisma:

```ts
await prisma.user.findMany({
  where: {
    OR: [
      { ownedSantaCampaigns: { some: { status: { not: 'CANCELLED' } } } },
      { santaParticipations: { some: { status: 'JOINED' } } },
    ],
  },
  select: { id: true },
});
```

**Пробел:** нет аналитических событий `santa.*` (см. [analyticsEvents.ts](../../packages/shared/src/analyticsEvents.ts)).
Funnel-метрики «открыл скрин Santa → создал → провёл draw» строятся только
по timestamp-полям доменных таблиц (createdAt / drawnAt / drawAt).
**Рекомендуется добавить:** `santa.campaign_created`, `santa.invite_clicked`,
`santa.joined`, `santa.draw_completed`, `santa.gift_status_changed`,
`santa.reveal_opened` — параллельно birthday-набору.

---

## 12. Пользователь использовал Group Gift

**Определение:** юзер организовал group-gift или сделал pledge.

| Источник | Что значит |
|---|---|
| `GroupGift.organizerUserId` | Стартовал сбор |
| `GroupGiftParticipant.userId` | Внёс деньги (`amount > 0`) |
| `AnalyticsEvent` event=`group_gift_created` / `group_gift_joined` / `group_gift_completed` / `group_gift_cancelled` / `group_gift_left` | Эмиттится из [group-gifts.routes.ts](../../apps/api/src/routes/group-gifts.routes.ts) и персистится (префикс `group_gift_`). |

```sql
-- Любое участие
SELECT DISTINCT user_id FROM (
  SELECT "organizerUserId" AS user_id FROM "GroupGift"
  WHERE status <> 'CANCELLED'
  UNION
  SELECT "userId" AS user_id FROM "GroupGiftParticipant"
) t;

-- Только организаторы
SELECT DISTINCT "organizerUserId" AS user_id
FROM "GroupGift"
WHERE status <> 'CANCELLED';

-- Только успешно завершившиеся (= COMPLETED, цель собрана)
SELECT DISTINCT user_id FROM (
  SELECT "organizerUserId" AS user_id FROM "GroupGift" WHERE status = 'COMPLETED'
  UNION
  SELECT gp."userId" AS user_id FROM "GroupGiftParticipant" gp
  JOIN "GroupGift" gg ON gg.id = gp."groupGiftId"
  WHERE gg.status = 'COMPLETED'
) t;

-- Через event-log (включая историю отменённых)
SELECT DISTINCT "userId" AS user_id
FROM "AnalyticsEvent"
WHERE event IN ('group_gift_created','group_gift_joined','group_gift_completed')
  AND "userId" IS NOT NULL;
```

Prisma:

```ts
await prisma.user.findMany({
  where: {
    OR: [
      { groupGiftsOrganized: { some: { status: { not: 'CANCELLED' } } } },
      { groupGiftParticipations: { some: {} } },
    ],
  },
  select: { id: true },
});
```

---

## 13. Был активен в первые 7 дней, потом пропал

**Определение:** **активен в первые 7 дней** = за неделю после регистрации
было ≥ 1 значимого действия (созданный wishlist / wish / share / reservation).
**Потом пропал** = `User.updatedAt < now - 14 days` И зарегистрирован ≥ 14
дней назад.

Опираемся на:
- `User.createdAt` — старт.
- `User.updatedAt` — last-seen прокси (см. § 0.3).
- `AnalyticsEvent` за первую неделю — для подтверждения активности.

```sql
WITH cohort AS (
  SELECT id AS user_id, "createdAt", "updatedAt"
  FROM "User"
  WHERE "createdAt" < NOW() - INTERVAL '14 days'   -- успели «прожить» наблюдательное окно
),
active_first_week AS (
  SELECT DISTINCT u.user_id
  FROM cohort u
  JOIN "AnalyticsEvent" e ON e."userId" = u.user_id
  WHERE e."createdAt" >= u."createdAt"
    AND e."createdAt" <  u."createdAt" + INTERVAL '7 days'
    AND (
      e.event IN ('wishlist.created','wish.created','share.token_generated','reservation.succeeded')
      OR e.event LIKE 'checkout_%'
      OR e.event LIKE 'import.%'
    )
)
SELECT u.user_id
FROM cohort u
JOIN active_first_week a ON a.user_id = u.user_id
WHERE u."updatedAt" < NOW() - INTERVAL '14 days';
```

**Workaround:** если хочется без event-log — можно опираться только на
структурные сигналы (есть wishlist/item, созданный в первые 7 дней) +
`updatedAt` сейчас старый:

```sql
SELECT u.id AS user_id
FROM "User" u
WHERE u."createdAt" < NOW() - INTERVAL '14 days'
  AND u."updatedAt" < NOW() - INTERVAL '14 days'
  AND EXISTS (
    SELECT 1
    FROM "Wishlist" w
    WHERE w."ownerId" = u.id
      AND w."createdAt" <  u."createdAt" + INTERVAL '7 days'
      AND w."createdAt" >= u."createdAt"
  );
```

**Пробел:** `updatedAt` обновляется не только заходом в Mini App, но и
любой записью в `User` (например, `welcomeSent`-флипом или promo-redemption).
Для большинства юзеров это OK — Mini-App-открытие плотнее любых внутренних
апдейтов. Если нужна точность — лучший прокси — `MAX(AnalyticsEvent.createdAt)`
по юзеру.

---

## 14. Вернулся через 7 / 30 дней

**Определение:** регистрировался N дней назад, имел gap молчания (≥ 7 / 30
дней без захода), потом снова открыл Mini App. Канонический источник —
`LifecycleTouch.returnedAt` (стампится в [schedulers/lifecycle.ts](../../apps/api/src/schedulers/lifecycle.ts) когда
юзер открыл Mini App после lifecycle-DM). Альтернатива — собственная
ретроспектива по `AnalyticsEvent`.

```sql
-- A: канонически через lifecycle-attribution
--   (юзер пришёл по DM-туху после S3/S4 чурна, gap ~ scheduledFor delay)
SELECT DISTINCT "userId" AS user_id, segment, "sentAt", "returnedAt",
       EXTRACT(EPOCH FROM ("returnedAt" - "sentAt"))/86400 AS days_since_touch
FROM "LifecycleTouch"
WHERE "returnedAt" IS NOT NULL
  AND segment IN ('S3','S4')   -- S3 — 5+ дней пропал, S4 — 7+ дней пропал
ORDER BY "returnedAt" DESC;

-- B: 7-day winback (gap ≥ 7d между активностями)
WITH activity AS (
  SELECT "userId", "createdAt"
  FROM "AnalyticsEvent"
  WHERE "userId" IS NOT NULL
),
gaps AS (
  SELECT "userId",
         "createdAt" AS current_event,
         LAG("createdAt") OVER (PARTITION BY "userId" ORDER BY "createdAt") AS prev_event
  FROM activity
)
SELECT DISTINCT "userId" AS user_id, current_event AS returned_at, prev_event AS last_seen_before
FROM gaps
WHERE prev_event IS NOT NULL
  AND current_event - prev_event >= INTERVAL '7 days';

-- C: 30-day winback (то же, но >= 30 дней)
WITH activity AS (
  SELECT "userId", "createdAt"
  FROM "AnalyticsEvent"
  WHERE "userId" IS NOT NULL
),
gaps AS (
  SELECT "userId", "createdAt",
         LAG("createdAt") OVER (PARTITION BY "userId" ORDER BY "createdAt") AS prev
  FROM activity
)
SELECT DISTINCT "userId" AS user_id
FROM gaps
WHERE prev IS NOT NULL
  AND "createdAt" - prev >= INTERVAL '30 days';
```

Prisma (вариант A):

```ts
const winbacks = await prisma.lifecycleTouch.findMany({
  where: {
    returnedAt: { not: null },
    segment: { in: ['S3', 'S4'] },
  },
  select: { userId: true, segment: true, sentAt: true, returnedAt: true },
});
```

**Пробел / workaround:**
- Вариант A покрывает только тех, кому отстрелил lifecycle scheduler. Если
  юзер вернулся «органически» — `returnedAt` пустой, и его нужно ловить
  через варианты B/C.
- Чтобы вариант B/C был дешёвый — добавь индекс
  `("userId","createdAt")` на AnalyticsEvent (он уже есть как
  `@@index([userId, event])` — для time-ordered window-функции лучше
  `(userId, createdAt)`). На текущем объёме (десятки тысяч событий в день)
  CTE-сканер ок, но при росте → материализованная вьюха «last_seen_history»
  будет дешевле.

---

## 15. Отсутствующие данные и рекомендации

Сегментация работает на 14 запросах выше, но эти пробелы стоит закрыть до
следующего research-цикла:

### 15.1 События, которых не хватает

| Что нужно | Зачем | Где добавить |
|---|---|---|
| `paywall.viewed { kind, context }` | Унифицировать сегмент 6 (сейчас union 7 разных имён) | Один helper в Mini App, callsite на каждом paywall-sheet |
| `paywall.dismissed { kind }` | Funnel «viewed → checkout_started → paid» сейчас зияет на dismiss | Same helper |
| `santa.campaign_created`, `santa.invite_clicked`, `santa.joined`, `santa.draw_completed`, `santa.reveal_opened` | Сейчас Santa-funnel есть только через структурные timestamp-ы — нет аналитики «дошёл до draw, но не открыл reveal» | santa.routes.ts + Mini App santa-screens |
| `reservation.opened_item_sheet` | Funnel «открыл айтем → забронировал» | Mini App item-sheet |
| `addon_paywall_viewed { sku }` | Сегмент 6 не покрывает add-on sheets, сейчас они в `pro_cta_clicked` | Mini App addon-sheet |

### 15.2 Поля, которых не хватает в БД

| Поле | Куда | Зачем |
|---|---|---|
| `User.lastActiveAt` (отдельно от `updatedAt`) | User | `updatedAt` пишется любой transactional-update'ой. Чистый `lastActiveAt` (обновляется только на Mini-App auth) уберёт неоднозначность в сегментах 13/14 |
| `Wishlist.firstSharedAt` | Wishlist | Сейчас «когда впервые расшарили» = `updatedAt`, но он переписывается любой правкой. Нужна неизменяемая отметка для сегмента 3 |
| `Item.firstViewedFromGuestAt` | Item | Понять, какие айтемы реально засветились гостям |

### 15.3 Временные workarounds (пока 15.1 / 15.2 не сделано)

- **Сегмент 6 (paywall views):** используем `UNION` 7 событий — см. SQL выше.
  Принимаем, что «paywall.dismissed» = «paywall.viewed AND NOT checkout_started в течение N минут».
- **Сегмент 11 (Santa funnel):** опираемся только на `SantaCampaign.createdAt`
  и `SantaRound.drawnAt`. Промежуточные шаги (открытие screen-а, нажатие
  «invite») — закрыты, до event-добавки видим лишь конечную конверсию.
- **Сегмент 13/14:** считаем `MAX(AnalyticsEvent.createdAt)` по юзеру вместо
  `User.updatedAt`, если нужен «чистый» last-active. Это дороже, но точнее.

### 15.4 Стандартизация persistence

Серверный `trackEvent` имеет узкий persist-allowlist (см. § 0.2): любое
событие вне 11 префиксов **пишется только в логи pino, не в `AnalyticsEvent`**.
Это значит, что серверный `trackEvent('checkout_started', ...)` в
billing.routes.ts — слепое пятно (в БД его нет, в логах есть). Если решим
делать sql-сегменты по checkout — либо расширить persist-allowlist на
`checkout_`, либо переключить call-sites на `trackAnalyticsEvent` (для этого
надо добавить `checkout_*` в `ANALYTICS_EVENTS` allowlist).

---

## 16. Чек-лист использования

Перед тем как гонять запросы в проде:

1. **Объём `AnalyticsEvent`.** Таблица растёт линейно по DAU × событий-на-сессию.
   Хотя `@@index([event, createdAt])` есть, тяжёлые скан-вариации (window
   функции по всему юзер-набору) лучше прогонять на read-replica.
2. **NULL-userId на `guest.view_opened`.** Не считать `COUNT(*)` за пользователей.
3. **Двойная запись wishlist.created / wish.created** (бек + фронт) — везде
   `COUNT(DISTINCT userId)`.
4. **timezone.** Все `createdAt` хранятся в UTC. Для дашбордов на МСК —
   `AT TIME ZONE 'Europe/Moscow'`.
5. **PII-санитизация.** `actorHash`, `ipHash`, `hashIp` уже хэшированы;
   `telegramId` — нет, не светить в outbound CSV без обезличивания.
