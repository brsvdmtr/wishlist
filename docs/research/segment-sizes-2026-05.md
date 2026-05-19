# Research — Segment Sizes (snapshot 2026-05-19)

**Цель.** Перед стартом research-волны (план: [04-user-research-plan.md](./04-user-research-plan.md))
нужно знать **реальные размеры** 12 базовых сегментов на проде, чтобы понять,
какие когорты вообще пригодны для рекрутинга, а какие микроскопические и
требуют либо более широкой выборки, либо переноса в очередь «после роста базы».

**Источник.** Прод Postgres `wishlist-prod-postgres-1` на Vultr Amsterdam
(`vultr` SSH alias). Запросы — расширения базовых из
[05-research-segmentation-queries.md](./05-research-segmentation-queries.md),
с поправками, обнаруженными при прогоне (см. § «Универсальные оговорки»).

**Snapshot date.** 2026-05-19 (UTC).

**Расчётная база.** `403` пользователей всего; `401` — recruitable pool
(`telegramId IS NOT NULL` И `godMode = false`).

---

## Универсальные оговорки

Эти три правила применены ко **всем** запросам ниже. Дублировать в каждом
сегменте не буду — храните их в голове.

1. **`AnalyticsEvent.userId` — гетерогенное поле (исторически).** На момент
   снятия снимка (2026-05-19) база из 10 517 событий распадалась на
   1 111 cuid-формат + 9 249 numeric (telegramId-as-string) + 157 NULL —
   следствие двух разных эмиттер-путей (server passes `user.id`, frontend
   `/tg/telemetry` + два bot-эмиттера передавали `String(tgUser.id)`).
   Запросы ниже сделаны через OR-join:

   ```sql
   JOIN "User" u ON (u.id = ae."userId" OR u."telegramId" = ae."userId")
   ```

   **Контракт нормализован в коммите того же дня** (см. [docs/analytics-events.md
   § «AnalyticsEvent.userId contract»](../analytics-events.md#analyticseventuserid-contract--internal-userid-only)
   и миграцию
   [`20260519180000_normalize_analyticsevent_userid`](../../packages/db/prisma/migrations/20260519180000_normalize_analyticsevent_userid/migration.sql)).
   После применения миграции на проде OR-join становится историческим артефактом —
   все новые запросы могут писать просто `JOIN "User" u ON u.id = ae."userId"`.
   До апплая миграции запросы из этого файла продолжают работать как есть.

2. **`godMode` исключён везде.** В `WHERE` каждой ветки стоит
   `u."godMode" = false`. На сегодняшний день godMode-юзеров **1** — то есть
   погрешность мала, но правило держим.

3. **PII не возвращаем.** Все запросы возвращают только агрегированные `COUNT`
   и/или анонимизированные `User.id`. Никаких `telegramId`, `firstName`,
   `username`, `email`, чатов и т.п. в выгрузках. Для рекрутинга, когда
   понадобится TG-handle, — отдельный auth-gated шаг в god-mode админке.

4. **N < 5 — предупреждение.** Любая когорта с count < 5 на этой базе
   статистически бессмысленна для качественного исследования (1 интервью
   = 20-50% выборки). Помечаем `⚠️ N<5 — не рекрутируем`.

---

## Сводная таблица

| # | Сегмент | N | Доля от 401 | Рекрутинг | Базовый сигнал |
|---|---|---:|---:|---|---|
| 1 | Activated owners | **49** | 12.2% | ✅ ready | `Item.isDemo=false` |
| 2 | Created wishlist, did not share | **44** | 11.0% | ✅ ready | `Wishlist`, no `shareToken` |
| 3 | Shared wishlist | **37** (token issued) / **15** (link opened) | 9.2% / 3.7% | ✅ ready / ⚠️ small | `Wishlist.shareToken` / `shareOpenCount>0` |
| 4 | Guests who opened | **1** (logged-in) / **152** (anon views) | 0.2% / — | 🚫 logged-in too thin; anon non-recruitable | `ForeignWishlistAccess` / `guest.view_opened` |
| 5 | Guests who reserved | **14** (known TG) | 3.5% | ✅ ready | `ReservationMeta.reserverUserId` |
| 6 | Paywall viewed | **5** | 1.2% | ⚠️ borderline (N=5) | `feature_gate_hit_*` ∪ 6 paywall events |
| 6b | Paywall viewed but did not pay | **4** | 1.0% | ⚠️ N<5 | (6) MINUS (7) |
| 7 | Paid users | **3** (any) / **2** (PRO ever) / **1** (active PRO now) | 0.7% / 0.5% / 0.2% | ⚠️ N<5 — interview all 3, do not «sample» | `PaymentEvent.eventType=payment_success*` |
| 8 | Churned / inactive | **359** (14 d) / **333** (30 d) | 89.6% / 83.0% | ✅ huge — нужна стратификация | `User.updatedAt < NOW()-14d` |
| 9 | Santa users | **2** (joined participants, 0 active organizers) | 0.5% | ⚠️ N<5 | `SantaCampaign` ∪ `SantaParticipant` |
| 10 | Group Gift users | **0** | 0% | 🚫 — фича не использовалась | `GroupGift` ∪ `GroupGiftParticipant` |
| 11 | URL Import users | **0** | 0% | 🚫 — нет ни одного `Item.originType=IMPORTED` | `Item.originType='IMPORTED'` |
| 12 | Limit-hit users | **2** (1 comments + 1 wishlist_limit) | 0.5% | ⚠️ N<5 | `feature_gate_hit_*` |

---

## 1. Activated owners — N = 49

**Определение.** У юзера есть ≥ 1 реальный (`isDemo=false`,
`status<>'DELETED'`) айтем в активном (`type='REGULAR'`, `archivedAt IS NULL`)
вишлисте.

```sql
SELECT COUNT(DISTINCT w."ownerId") AS s1_activated_owners
FROM "Item" i
JOIN "Wishlist" w ON w.id = i."wishlistId"
JOIN "User" u ON u.id = w."ownerId"
WHERE i."isDemo" = false
  AND i."status" <> 'DELETED'
  AND w."type" = 'REGULAR'
  AND w."archivedAt" IS NULL
  AND u."godMode" = false;
```

**Caveats.**
- Не учитывает «бывших активных» — кто создал айтем, а потом всё удалил
  (status=DELETED). Если нужен «когда-либо создал реальный айтем» — убрать
  фильтр по status.
- Demo-айтемы, конвертированные в реальный (`originType='DEMO'`,
  `becameRealAt IS NOT NULL`, `isDemo=true`) сюда **не** попадают.
  В текущей базе таких айтемов нет, проверено: добавление
  `OR i."becameRealAt" IS NOT NULL` даёт ту же цифру.

**Recruitable.** ✅ **Да.** 49 — достаточный пул для 5-8 интервью с
запасом на отказы и no-show.

---

## 2. Created wishlist, did not share — N = 44

**Определение.** Есть активный wishlist, но ни на одном wishlist нет
`shareToken`. Семантически — «дошёл до создания, но не нажал «Поделиться».

```sql
SELECT COUNT(*) AS s2_unshared
FROM "User" u
WHERE u."godMode" = false
  AND EXISTS (
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

**Caveats.**
- Если юзер выпустил токен и потом отозвал — попадёт сюда (DELETE share
  ⇒ `shareToken=NULL`). Чтобы отделить «никогда не делился» от «отозвал»,
  скрестить с `AnalyticsEvent` event `share.token_generated` /
  `share_token_generated`.
- Сегменты 1 и 2 пересекаются на (49 − x), где x = активированные владельцы,
  поделившиеся ссылкой. На текущей базе пересечение `S1 ∩ S2` = большая
  часть S2 (т.к. в S2 — те, у кого есть wishlist, а у активированных как
  правило по 1+ айтему). Для recruit это значит: при выборке S2 спросите
  про **причину не-шаринга**, а не «почему не создал».

**Recruitable.** ✅ **Да.** 44 — хороший пул.

---

## 3. Shared wishlist — N = 37 / 15 / 14

Сегмент расщеплён на три варианта (см. § 3 в [05-...queries.md](./05-research-segmentation-queries.md)):

| Вариант | N | Что значит |
|---|---:|---|
| A: got token | **37** | Хоть раз в Wishlist выписался `shareToken` |
| B: link opened | **15** | `shareOpenCount > 0` — ссылку реально открыли |
| C: event-logged | **14** | Залогирован `share.token_generated` или `share_token_generated` |

```sql
SELECT
  (SELECT COUNT(DISTINCT w."ownerId")
   FROM "Wishlist" w JOIN "User" u ON u.id = w."ownerId"
   WHERE w."shareToken" IS NOT NULL
     AND w."type" = 'REGULAR' AND u."godMode" = false) AS s3a_got_token,
  (SELECT COUNT(DISTINCT w."ownerId")
   FROM "Wishlist" w JOIN "User" u ON u.id = w."ownerId"
   WHERE w."shareOpenCount" > 0
     AND w."type" = 'REGULAR' AND u."godMode" = false) AS s3b_link_actually_opened,
  (SELECT COUNT(DISTINCT u.id)
   FROM "AnalyticsEvent" ae
   JOIN "User" u ON (u.id = ae."userId" OR u."telegramId" = ae."userId")
   WHERE ae.event IN ('share.token_generated', 'share_token_generated')
     AND ae."userId" IS NOT NULL
     AND u."godMode" = false) AS s3c_clicked_share;
```

**Caveats.**
- Вариант **A — канонический** для «поделился» как user-property: token
  выпускается один раз и переживает редактирование вишлиста.
- Вариант **B — лучше для funnel**: «выпустил → реально использовал».
  Разрыв 37 → 15 = 60% выпустивших ссылку так её и **никому не дали**.
  Это конкретная и важная цифра для research: spread на «почему не
  использовал ссылку».
- Двойная запись event: исторически писали `share.token_generated`
  (с точкой), позже добавили `share_token_generated` (с подчёркиванием),
  оба сохранились в базе. Поэтому в `IN (...)` — оба.

**Recruitable.**
- A (37): ✅ хороший пул для общих вопросов «как делятся».
- B (15): ⚠️ маленький, но как раз цель — «кто реально получил трафик».
  Идеально для 5-6 глубинных интервью.
- C (14): дублирует B по сути, в исследовательский recruit не выносить
  отдельно.

---

## 4. Guests who opened — N = 1 (logged-in) / 152 (anon views)

**Определение.** Юзер открыл wishlist, который ему не принадлежит. Два
источника, и сейчас они **сильно расходятся**:

| Сигнал | N |
|---|---:|
| `ForeignWishlistAccess` (TG-юзер прошёл auth и реально засветил access) | **1** |
| `AnalyticsEvent.event='guest.view_opened'` (любое открытие slug-страницы) | **152 events**, 0 авторизованных юзеров (все 152 — `userId IS NULL`) |

```sql
-- A: known TG-users
SELECT COUNT(DISTINCT fwa."userId") AS s4_logged_in_guests
FROM "ForeignWishlistAccess" fwa
JOIN "User" u ON u.id = fwa."userId"
WHERE u."godMode" = false;

-- B: anonymous view events (NOT a user-count — это view-count)
SELECT COUNT(*) AS view_events,
       COUNT(*) FILTER (WHERE "userId" IS NULL) AS anon_views
FROM "AnalyticsEvent"
WHERE event = 'guest.view_opened';
```

**Caveats.**
- `ForeignWishlistAccess` пишется **только** когда гость залогинен в Mini
  App. Это, очевидно, узкое горлышко: большинство просмотров shared-link —
  анонимные, потому что человек открывает ссылку в браузере (не в Mini App).
- `guest.view_opened` с `userId=NULL` — view-count, **не** user-count.
  Кросс-идентификация невозможна (нет IP-хэша или fingerprint в этом event).
  152 views — это плотность активности по shared-ссылкам, но из них
  невозможно собрать список конкретных людей.

**Recruitable.** 🚫 **Нет** на текущей базе.
- 1 логирующийся гость — не выборка.
- 152 анонимных view — нечего рекрутить, нет идентификаторов.
- Workaround: рекрутировать «гостей» через **обратную сторону** —
  взять S3-B (15 owners с открытой ссылкой) и попросить их связать с
  получателями ссылки. По сути, цепочка через owner.

---

## 5. Guests who reserved — N = 14

**Определение.** TG-юзер забронировал чужой айтем. Два совпадающих сигнала:

```sql
-- A: known TG-users via ReservationMeta
SELECT COUNT(DISTINCT rm."reserverUserId") AS s5_known_reservers
FROM "ReservationMeta" rm
JOIN "Item" i ON i.id = rm."itemId"
JOIN "Wishlist" w ON w.id = i."wishlistId"
JOIN "User" u ON u.id = rm."reserverUserId"
WHERE w."ownerId" <> rm."reserverUserId"  -- именно ЧУЖОЙ айтем
  AND u."godMode" = false;

-- B: same, но только активные сейчас (purchased=false, active=true)
SELECT COUNT(DISTINCT rm."reserverUserId") AS s5_known_active
FROM "ReservationMeta" rm
JOIN "Item" i ON i.id = rm."itemId"
JOIN "Wishlist" w ON w.id = i."wishlistId"
JOIN "User" u ON u.id = rm."reserverUserId"
WHERE w."ownerId" <> rm."reserverUserId"
  AND rm."active" = true
  AND u."godMode" = false;

-- C: cross-check через event log
SELECT COUNT(DISTINCT u.id) AS s5_via_event
FROM "AnalyticsEvent" ae
JOIN "User" u ON (u.id = ae."userId" OR u."telegramId" = ae."userId")
WHERE ae.event = 'reservation.succeeded'
  AND ae."userId" IS NOT NULL
  AND u."godMode" = false;
```

**Counts.**
- A (ever reserved a foreign item, known TG): **14**
- B (active reservation right now): **10**
- C (via event log): **14** — совпадает с A, sanity-check ✅.

**Caveats.**
- Анонимные резерверы (не залогинены в Mini App, бронируют через
  `/public/share/:token`) идентифицируются только `actorHash` в
  `ReservationEvent`. Их **20** unique hash'ей (по `ReservationEvent.actorHash`),
  из них **14** пересекаются с известными TG. То есть ≈6 анонимных
  актёров **отдельно** — но рекрутировать их невозможно (хэш без обратимости).
- Self-reservation (своя бронь на свой айтем) исключена явным `w."ownerId"
  <> rm."reserverUserId"`.

**Recruitable.** ✅ **Да.** 14 — нормальный пул для интервью «как дарят».
По активным резервам прямо сейчас (10) — узкий и горячий.

---

## 6. Paywall viewed — N = 5  /  6b: viewed but did not pay — N = 4

**Определение.** Хоть раз увидел любой из 7 типов paywall (см.
[05-...queries.md § 6](./05-research-segmentation-queries.md)).

```sql
SELECT COUNT(DISTINCT u.id) AS s6_paywall_viewed
FROM "AnalyticsEvent" ae
JOIN "User" u ON (u.id = ae."userId" OR u."telegramId" = ae."userId")
WHERE ae."userId" IS NOT NULL
  AND u."godMode" = false
  AND (
    ae.event LIKE 'feature_gate_hit_%'
    OR ae.event IN (
      'showcase.paywall_viewed','search.paywall_shown',
      'secret_res.paywall_open','birthday.paywall_shown',
      'pro_cta_clicked','event_reminder_deeplink_paywall'
    )
  );

-- 6b: viewed but did not pay
WITH paywall_users AS (
  SELECT DISTINCT u.id AS user_id
  FROM "AnalyticsEvent" ae
  JOIN "User" u ON (u.id = ae."userId" OR u."telegramId" = ae."userId")
  WHERE ae."userId" IS NOT NULL AND u."godMode" = false
    AND (ae.event LIKE 'feature_gate_hit_%'
         OR ae.event IN ('showcase.paywall_viewed','search.paywall_shown',
                         'secret_res.paywall_open','birthday.paywall_shown',
                         'pro_cta_clicked','event_reminder_deeplink_paywall'))
),
paid_users AS (
  SELECT DISTINCT "userId" AS user_id
  FROM "PaymentEvent"
  WHERE "eventType" IN ('payment_success','payment_success_yearly',
                        'payment_success_lifetime','addon_payment_success')
)
SELECT COUNT(*) AS s6_unpaid
FROM paywall_users pw
WHERE pw.user_id NOT IN (SELECT user_id FROM paid_users);
```

**Caveats.**
- `pro_cta_clicked` — не «увидел paywall», а «нажал PRO-кнопку». В union
  включён, потому что в коде это часть paywall-funnel. Если нужно строже —
  убрать из union, тогда `s6_paywall_viewed` уменьшится.
- Нет единого `paywall.viewed` события (рекомендация в § 15.1
  [05-...queries.md](./05-research-segmentation-queries.md)). Текущий
  union — best-effort.
- `PaymentEvent.userId` — формат `User.id` (cuid), а `AnalyticsEvent.userId`
  смешанный. Поэтому подзапрос `paid_users` сравнивается с **normalized**
  `paywall_users` (там уже сделан OR-join по `u.id`). Не наивный
  `ae."userId" = pe."userId"`.

**Recruitable.**
- S6 (5): ⚠️ **borderline N=5**, граница приличия для research. Можно
  взять всех 5.
- S6b (4): ⚠️ **N<5**, статистически бессмысленно как separate cohort.
  Использовать как сужение внутри S6, не отдельно.

---

## 7. Paid users — N = 3 / 2 / 1

**Определение.** Юзер платил через Telegram Stars. Разрезы:

| Подсегмент | N | Что значит |
|---|---:|---|
| Ever paid (PRO или add-on) | **3** | `PaymentEvent` с любым `payment_success*` |
| Paid PRO ever | **2** | Без add-on |
| Active PRO right now | **1** | Подписка ACTIVE и не истёкла, либо lifetime |

```sql
SELECT
  (SELECT COUNT(DISTINCT pe."userId")
   FROM "PaymentEvent" pe JOIN "User" u ON u.id = pe."userId"
   WHERE pe."eventType" IN (
     'payment_success','payment_success_yearly','payment_success_lifetime',
     'addon_payment_success'
   ) AND u."godMode" = false) AS s7_ever_paid,
  (SELECT COUNT(DISTINCT pe."userId")
   FROM "PaymentEvent" pe JOIN "User" u ON u.id = pe."userId"
   WHERE pe."eventType" IN (
     'payment_success','payment_success_yearly','payment_success_lifetime'
   ) AND u."godMode" = false) AS s7_paid_pro_ever,
  (SELECT COUNT(DISTINCT s."userId")
   FROM "Subscription" s JOIN "User" u ON u.id = s."userId"
   WHERE s."planCode" = 'PRO' AND s."status" = 'ACTIVE'
     AND (s."currentPeriodEnd" > NOW() OR s."billingPeriod" = 'lifetime')
     AND u."godMode" = false) AS s7_active_pro_now;
```

**Caveats.**
- `payment_success_post_lifetime` исключён — это audit-only event для
  lifetime-юзеров, получивших ошибочный monthly-charge. Не считаем «новой
  оплатой».
- `Purchase` таблица — 2 строки. Это add-on'ы. Активные PRO **не**
  считаются в Purchase, только `payment_success_*` → Subscription.
- 79 `PaymentEvent` строк всего → большинство — `invoice_created`,
  `cancelled` и т.п. Только успешные платежи **3 уникальных юзера**.

**Recruitable.** ⚠️ **N<5 во всех разрезах.** На таком объёме **interview
all 3**, не «sample». Каждый из 3 — отдельный case study, не
статистическая выборка. Полезный insight = понять барьер для остальных
398, а не обобщать опыт этих троих.

---

## 8. Churned / inactive — N = 359 (14d) / 333 (30d)

**Определение.** Зарегистрирован 14+ дней назад, последний `updatedAt` —
14+ или 30+ дней назад.

```sql
SELECT
  (SELECT COUNT(*) FROM "User" u
   WHERE u."godMode" = false
     AND u."telegramId" IS NOT NULL
     AND u."createdAt" < NOW() - INTERVAL '14 days'
     AND u."updatedAt" < NOW() - INTERVAL '14 days') AS s8_inactive_14d,
  (SELECT COUNT(*) FROM "User" u
   WHERE u."godMode" = false
     AND u."telegramId" IS NOT NULL
     AND u."createdAt" < NOW() - INTERVAL '14 days'
     AND u."updatedAt" < NOW() - INTERVAL '30 days') AS s8_inactive_30d;
```

**Counts.**
- Inactive 14+ дней: **359** (89.6% от recruitable pool 401)
- Inactive 30+ дней: **333** (83.0%)
- Дополнительно: юзеров, у которых `updatedAt >= createdAt + 7 days`
  (т.е. был активен ≥ 1 неделю после регистрации) — всего **23**.
  Это и есть «активные в первые 7 дней, потом пропал» приближённо.

**Caveats.**
- `User.updatedAt` — прокси «last seen» (см. § 0.3 [05-...queries.md](./05-research-segmentation-queries.md)).
  Обновляется на каждом Mini-App запросе через `getOrCreateTgUser` ⇒
  **достаточно плотный** сигнал, но не идеальный: переписывается также
  при любом transactional-update на User (`welcomeSent`, promo-redemption).
  Для критического discrimination — использовать
  `MAX(AnalyticsEvent.createdAt)` per-user.
- 89.6% inactive — **это не баг, это product reality**: база ≈ 400, и
  большинство юзеров пришли, потыкали, ушли. Эта когорта — главный
  drift в research-вопросах «почему не вернулся».
- В цифру 359 попадают и юзеры с `Item.isDemo=true` (demo-only), и
  никогда-не-создававшие-wishlist (тоже подмножество).
- Стратификация для recruit: 
  - **never-activated** (нет ни одного real Item): ~300+ (грубо `359 - 49 ∩ inactive`).
  - **activated then churned** (S1 ∩ S8): нужно отдельным запросом.

```sql
-- Дополнительно: S1 ∩ S8 — активированные, но пропавшие
SELECT COUNT(DISTINCT u.id)
FROM "User" u
WHERE u."godMode" = false AND u."telegramId" IS NOT NULL
  AND u."createdAt" < NOW() - INTERVAL '14 days'
  AND u."updatedAt" < NOW() - INTERVAL '14 days'
  AND EXISTS (
    SELECT 1 FROM "Item" i
    JOIN "Wishlist" w ON w.id = i."wishlistId"
    WHERE w."ownerId" = u.id
      AND i."isDemo" = false
      AND i."status" <> 'DELETED'
      AND w."type" = 'REGULAR'
      AND w."archivedAt" IS NULL
  );
```

**Recruitable.** ✅ **Огромный пул**, но **обязательно стратифицировать**:
- *Never-activated churned* (зашёл, не создал реальный айтем, ушёл) — ~310.
  Главная история «почему не «зашло» с порога».
- *Activated then churned* (создал, использовал ≥ 1 неделю, потом пропал) —
  узкая часть, по моей оценке десятки. Главная история «что сломалось».

Рекрутировать **не миксом**, а по двум отдельным стратам.

---

## 9. Santa users — N = 2

**Определение.** Юзер либо организовал кампанию, либо джойнился к чужой.

```sql
SELECT COUNT(DISTINCT t.user_id)
FROM (
  SELECT sc."ownerId" AS user_id
  FROM "SantaCampaign" sc JOIN "User" u ON u.id = sc."ownerId"
  WHERE sc.status <> 'CANCELLED' AND u."godMode" = false
  UNION
  SELECT sp."userId" AS user_id
  FROM "SantaParticipant" sp JOIN "User" u ON u.id = sp."userId"
  WHERE sp.status = 'JOINED' AND u."godMode" = false
) t;

-- Разрез по ролям
SELECT
  (SELECT COUNT(DISTINCT sc."ownerId")
   FROM "SantaCampaign" sc JOIN "User" u ON u.id = sc."ownerId"
   WHERE sc.status IN ('OPEN','LOCKED','ACTIVE','COMPLETED')
     AND u."godMode" = false) AS organizers_active,
  (SELECT COUNT(DISTINCT sp."userId")
   FROM "SantaParticipant" sp
   JOIN "SantaCampaign" sc ON sc.id = sp."campaignId"
   JOIN "User" u ON u.id = sp."userId"
   WHERE sp.status = 'JOINED'
     AND sc."ownerId" <> sp."userId"
     AND u."godMode" = false) AS pure_participants;
```

**Counts.**
- Any santa contact (non-cancelled): **2**
- Active organizers (non-DRAFT, non-CANCELLED): **0**
- Pure participants (joined someone else's): **2**

**Caveats.**
- Сейчас вне сезона (май, Santa-сезон — ноябрь-январь). Эти 2 — либо
  тестовые остатки, либо early-trial.
- Нет аналитических событий `santa.*` — funnel-метрики только по доменным
  timestamps (`createdAt`, `drawnAt`). См. рекомендации § 15.1.

**Recruitable.** ⚠️ **N<5.** Отложить Santa-research до следующего
сезона (Q4 2026), либо включить в общий PRO/feature-use research, не
выделяя как сегмент. Если очень нужно — interview обоих participants.

---

## 10. Group Gift users — N = 0

**Определение.** Юзер организовал group-gift или сделал pledge.

```sql
SELECT
  (SELECT COUNT(DISTINCT gg."organizerUserId")
   FROM "GroupGift" gg JOIN "User" u ON u.id = gg."organizerUserId"
   WHERE gg.status <> 'CANCELLED' AND u."godMode" = false) AS organizers,
  (SELECT COUNT(DISTINCT gp."userId")
   FROM "GroupGiftParticipant" gp JOIN "User" u ON u.id = gp."userId"
   WHERE u."godMode" = false) AS participants;
```

**Count.** **0** организаторов, **0** участников.

**Caveats.**
- Фича либо не использовалась, либо ещё не дошла до live (проверить
  feature-flag и UI entry-point).
- Cross-check: event-log `group_gift_created` etc. — тоже даст 0 (или
  только godMode), потому что domain-rows нет.

**Recruitable.** 🚫 **Невозможно** на этих данных. Если research про
group-gift нужен — recruit «through hypothesis»: брать S1 (activated
owners) и спрашивать про коллективные подарки в общем, без привязки к
конкретному usage.

---

## 11. URL Import users — N = 0

**Определение.** Юзер использовал URL-импорт (через Mini-App или
бот-форвард).

```sql
SELECT
  (SELECT COUNT(DISTINCT w."ownerId")
   FROM "Item" i JOIN "Wishlist" w ON w.id = i."wishlistId"
   JOIN "User" u ON u.id = w."ownerId"
   WHERE i."originType" = 'IMPORTED' AND i."status" <> 'DELETED'
     AND u."godMode" = false) AS has_imported_item,
  (SELECT COUNT(DISTINCT u.id)
   FROM "AnalyticsEvent" ae
   JOIN "User" u ON (u.id = ae."userId" OR u."telegramId" = ae."userId")
   WHERE ae.event IN ('import.started','import.bot_started')
     AND ae."userId" IS NOT NULL AND u."godMode" = false) AS tried_import,
  (SELECT COUNT(DISTINCT u.id)
   FROM "AnalyticsEvent" ae
   JOIN "User" u ON (u.id = ae."userId" OR u."telegramId" = ae."userId")
   WHERE ae.event IN ('import.succeeded','import.bot_succeeded')
     AND ae."userId" IS NOT NULL AND u."godMode" = false) AS succeeded_import;
```

**Count.** **0** во всех трёх разрезах.

**Caveats.**
- Это либо «фича не работает», либо «никто не пробовал». Скорее второе:
  URL-import — за PRO/credits gate, а S7 (paid) = 3, и из них может никто
  не имел повода импортировать. Сверить с `feature_gate_hit_url_import` —
  это покажет, **сколько уперлось** в gate URL-import'а, не дойдя до
  использования.

```sql
-- Сколько уперлось в gate URL-import
SELECT COUNT(DISTINCT u.id)
FROM "AnalyticsEvent" ae
JOIN "User" u ON (u.id = ae."userId" OR u."telegramId" = ae."userId")
WHERE ae.event = 'feature_gate_hit_url_import'
  AND ae."userId" IS NOT NULL AND u."godMode" = false;
```

На текущей базе — **0** даже в gate-hits (см. S12 breakdown ниже). Значит
URL-import просто **никто не пробовал**, не вопрос монетизации.

**Recruitable.** 🚫 **Невозможно** на этих данных. Если URL-import — фокус
research, recruit через прокси («у вас бывала ситуация, когда надо
скопировать товар по ссылке?») в общем интервью.

---

## 12. Limit-hit users — N = 2

**Определение.** Юзер хоть раз получил 402 «нужно PRO» из-за лимита
(`feature_gate_hit_*` event).

```sql
SELECT COUNT(DISTINCT u.id) AS s12_any_limit_hit
FROM "AnalyticsEvent" ae
JOIN "User" u ON (u.id = ae."userId" OR u."telegramId" = ae."userId")
WHERE ae.event LIKE 'feature_gate_hit_%'
  AND ae."userId" IS NOT NULL
  AND u."godMode" = false;

-- Разрез по типу лимита
SELECT ae.event, COUNT(DISTINCT u.id) AS distinct_users
FROM "AnalyticsEvent" ae
JOIN "User" u ON (u.id = ae."userId" OR u."telegramId" = ae."userId")
WHERE ae.event LIKE 'feature_gate_hit_%'
  AND ae."userId" IS NOT NULL AND u."godMode" = false
GROUP BY ae.event
ORDER BY distinct_users DESC;
```

**Count.** **2** уникальных юзера. Разрез:

| Тип gate | N |
|---|---:|
| `feature_gate_hit_comments` | 1 |
| `feature_gate_hit_wishlist_limit` | 1 |

**Caveats.**
- Все остальные gate-типы (`item_limit`, `hints`, `url_import`,
  `categories`, `secret_reservations`, `group_gift`, `gift_notes` и т.п.) —
  **0 hits**. Это означает, что **базовые лимиты ещё никем не достигнуты**
  на текущем масштабе. Не пришло время для paywall optimization research —
  сначала надо растить активацию (S1).

**Recruitable.** ⚠️ **N<5.** Interview both, не «sample». Полезный insight =
понять контекст 2-х hits, а не статистика.

---

## Self-checks для Claude (проверки качества выгрузки)

При следующем перезапуске этих запросов (если будет refresh snapshot,
e.g. через месяц) — пройти все 5 пунктов:

### 1. SQL runs locally / staging without error

```bash
# В прод:
scp /tmp/segment-sizes.sql vultr:/tmp/segment-sizes.sql
ssh vultr 'docker cp /tmp/segment-sizes.sql wishlist-prod-postgres-1:/tmp/segment-sizes.sql && docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -f /tmp/segment-sizes.sql'

# Локально (если есть seed):
psql -U wishlist -d wishlist_test -f /tmp/segment-sizes.sql
```

Если хоть один запрос вернул ERROR — fail.

### 2. No duplicate users in segment counts unless explicitly allowed

Все запросы используют `COUNT(DISTINCT ...)`. Допустимы только три
варианта дубликатов:

- В S3/S5 — три разреза одного сегмента (A/B/C), их **обязательно**
  показывать как разные числа, не складывать.
- В S6b — сужение S6, не отдельная когорта.
- В S7 — три разреза (ever paid, ever PRO, active PRO now). Не суммируем.

Тест: `s8_inactive_14d ≥ s8_inactive_30d` (логически шире). На текущей
базе 359 ≥ 333 ✅.

### 3. Staff / godmode excluded

В каждом запросе **обязательно** `u."godMode" = false`. На моменте
2026-05-19 godMode-юзеров = 1; их вычитание даёт расхождение в ≤ 1.
Если в будущем `godMode` count вырастет (рекрутируется команда поддержки
с правами) — расхождение будет заметнее, важно держать фильтр.

Cross-check команда:

```sql
SELECT COUNT(*) AS godmode_count FROM "User" WHERE "godMode" = true;
```

### 4. N < 5 warning

Сегменты с N < 5 на 2026-05-19: **S4 (logged-in guests = 1)**, **S6b (=4)**,
**S7 (=3 / =2 / =1)**, **S9 (=2)**, **S10 (=0)**, **S11 (=0)**, **S12 (=2)**.

**Правило при следующем refresh:** если для сегмента N < 5 — пометить как
`⚠️ N<5 — не рекрутируем как отдельную когорту` и **не выводить** список
конкретных user_id (избегаем quasi-identifier risk).

### 5. Queries не раскрывают PII

В **этой** выгрузке возвращаются только агрегированные `COUNT`. Никаких
`telegramId`, `firstName`, `username`, `email`, `chatId`, `actorHash` в
SELECT-листах нет — проверено grep'ом по SQL:

```bash
grep -iE 'telegramId|firstName|username|email|chatId|actorHash|ipHash' /tmp/segment-sizes.sql
# (только в JOIN-условиях, не в SELECT)
```

Когда придёт время **рекрутировать**, делать это **только** через
god-mode админку (`apps/web/app/(godmode)`), а не через сырой SQL-output.

---

## Импликации для research-плана

(см. [04-user-research-plan.md](./04-user-research-plan.md))

1. **Перенести в Backlog:** S10 (Group Gift), S11 (URL Import) — нет
   данных, не на чем строить. Вернуться после roll-out + growth.

2. **Не рекрутируем как отдельную когорту:** S4 (logged-in guests), S7
   (paid), S9 (Santa), S12 (limit-hit). Все < 5. По S7 — interview all 3
   как case studies, не как cohort. По S12 — interview both, та же логика.

3. **Готовы к старту:** S1 (49), S2 (44), S3-A (37), S5 (14), S8 (359 c
   stratification). Это **5 рабочих когорт**, достаточно для первой
   research-волны.

4. **Главный insight цифр:** **89.6% базы — inactive 14+ дней**. Перед
   любым feature-research стоит провести «exit-interview» research с
   churned-cohort. Это даёт самый высокий ROI на текущей фазе.

5. **Перед публикацией CSV / списков юзеров для рекрутинга** — пройти
   через god-mode endpoint, а не через прямой SQL-dump. PII handling
   live в админ-инфраструктуре, не должен ходить через email/Slack/Notion.

---

## Полный SQL-скрипт

Хранится в репо: [`docs/research/segment-sizes-2026-05.sql`](./segment-sizes-2026-05.sql).
Это тот же файл, что был использован для генерации цифр выше.
Запускается одной командой через psql.
