# 03 — Monetization & Paywall Audit

**Дата:** 2026-05-19
**Автор:** product / pricing strategy
**Статус:** draft v1, ready for review
**Сопутствующие документы:** [docs/MONETIZATION.md](../MONETIZATION.md) · [docs/CURRENT_PRODUCT_STATE.md](../CURRENT_PRODUCT_STATE.md) · [docs/ONBOARDING_AND_ACTIVATION.md](../ONBOARDING_AND_ACTIVATION.md) · [docs/USER_FLOWS.md](../USER_FLOWS.md) · [docs/research/04-user-research-plan.md](04-user-research-plan.md) · [docs/research/05-research-segmentation-queries.md](05-research-segmentation-queries.md)

> Полный аудит монетизации WishBoard: тарифы, add-ons, paywall'ы, точки upgrade,
> entitlement-чекеры, риски рассинхронизации, оценка влияния на activation/виральность,
> и три варианта переупаковки тарифов.

---

## 0. TL;DR

**Что устроено хорошо:**

- Жёсткий single-source-of-truth: `PLANS` + `ONE_TIME_SKUS` + `ADDON_CAPS` в [apps/api/src/services/entitlement.ts:38-152](../../apps/api/src/services/entitlement.ts) — всё в одном файле, легко крутить.
- Server-side enforcement покрывает все основные numeric limits и feature flags. Bypass без реального PRO невозможен.
- Lifetime override + downgrade protection реализованы корректно (lifetime никогда не теряется случайно).
- Гость **не упирается ни в один paywall** при первом резерве — viral loop защищён.
- Referral program live: 30 дней PRO инвайтеру за каждого реферала (cap 3/мес, 12/год).

**Где болит:**

| Симптом | Severity | Где |
|---|---|---|
| 24 UpsellContext в коде, 9 задокументированы в MONETIZATION.md § 7 | 🟠 medium | `MiniApp.tsx:309-324` |
| 20 PRO-бенефитов в `getProBenefits()`, 13 в доке | 🟠 medium | `MiniApp.tsx:2290-2315` |
| Santa: 3 PRO-гейта (multi_wave, exclusions, exclusion_groups) полностью **не задокументированы** | 🔴 high | `santa.routes.ts:946, 1838, 1885, 1972` |
| `appearance` upsell context — **хардкод RU**, нет i18n keys | 🔴 high | `MiniApp.tsx:2241` |
| URL-import (`/tg/import-url`) — жёсткий 402 без graceful credit fallback в UI **во время activation** | 🔴 high | `import.routes.ts:99` |
| Cancel-flow: в доке "8 фичей, что вы теряете" — на деле только тост с датой | 🟠 medium | `MiniApp.tsx:7686-7726` |
| `bot_import` контекст задефайнен, но никогда не триггерится | 🟡 low | `MiniApp.tsx:2222` |
| Showcase-edit возвращает **403** вместо 402 (несогласованный паттерн) | 🟡 low | `me.routes.ts:748` |
| Santa hint-request возвращает 403 (не 402) + использует `isPro` вместо `hasReservationPro` | 🟡 low | `santa.routes.ts:2692` |
| FREE-лимит участников = 5 — на день рождения с 6 гостями владелец **обязан** платить, причём гость уже резервировал | 🟠 medium | `reservations.routes.ts:1199` |

**Главная рекомендация:**

1. **Перенести URL-import из жёсткого PRO-гейта в credit-based модель** — самый частый paywall на activation.
2. **Поднять FREE participants 5 → 10** — текущий лимит ломает birthday-кейс (главный сценарий продукта).
3. **Документировать или удалить Santa PRO-гейты.** Сейчас они enforce'ятся, но ни на пейволле, ни в settings не объявлены — пользователь узнаёт о них в момент создания кампании.
4. **Тестировать event-pass-first упаковку** на сезонных пиках (Santa в декабре, birthday-bundle весной).

---

## 1. Тарифы

### 1.1. Полная таблица

| | **FREE** | **PRO Monthly** | **PRO Yearly** | **PRO Lifetime** |
|---|---|---|---|---|
| Plan code в БД | `FREE` | `PRO` | `PRO` | `PRO` |
| `billingPeriod` | — | `monthly` | `yearly` | `lifetime` |
| Цена (Telegram Stars) | — | 100 XTR / мес | 800 XTR / год (one-time) | 2 490 XTR (one-time) |
| Эффективная цена/мес | — | 100 XTR | ~67 XTR | амортизация ~28 мес безубытка vs monthly |
| Auto-renew | — | да (TG-side) | нет | нет |
| Reminder DM | — | только если `cancelAtPeriodEnd=true` | за 7д и 1д до expiry | никогда |
| Sentinel `currentPeriodEnd` | — | now + 30 дн | now + 365 дн | 2099-12-31 |
| Soft-cancel | — | `cancelAtPeriodEnd=true` | n/a | заблокировано (409 `lifetime_cannot_cancel`) |
| Источник правды | `PLANS.FREE` | `PLANS.PRO` | `PLANS.PRO` | `PLANS.PRO` (отличается только биллингом) |

**Single source of truth:** [apps/api/src/services/entitlement.ts:38-55](../../apps/api/src/services/entitlement.ts) (после P5s-extraction перенесено из `index.ts`).

```ts
PLANS = {
  FREE: { code: 'FREE', wishlists: 2, items: 20, participants: 5, subscriptions: 2, features: [] },
  PRO:  { code: 'PRO',  wishlists: 10, items: 70, participants: 20, subscriptions: 5,
          features: ['comments', 'url_import', 'hints'] },
};
```

**Env-driven цены (defaults):**

| Variable | Default | Источник |
|---|---|---|
| `PRO_PRICE_XTR` | 100 | `entitlement.ts` |
| `PRO_YEARLY_PRICE_XTR` | 800 | `entitlement.ts` |
| `PRO_LIFETIME_PRICE_XTR` | 2490 | `entitlement.ts` |
| `PRO_SUBSCRIPTION_PERIOD` | 2 592 000 (30 дн) | `entitlement.ts` |
| `PRO_YEARLY_EXTEND_SECONDS` | 31 536 000 (365 дн) | `entitlement.ts` |
| `GIFT_NOTES_PRICE_XTR` | 19 | `entitlement.ts` |
| `GROUP_GIFT_PRICE_XTR` | 79 | `entitlement.ts` |
| `SECRET_RESERVATION_PRICE_XTR` | 24 | `entitlement.ts` |
| `SMART_RESERVATIONS_PRICE_XTR` | 15 | `entitlement.ts` |
| `RESERVATION_PRO_PRICE_XTR` | 50 | `entitlement.ts` |

### 1.2. Future tiers — не существуют формально, но есть кандидаты

В коде нет ни одного намёка на `PRO_PLUS`, `TEAM`, `BUSINESS`. Однако фактически уже формируется почва для будущих tier'ов:

- **"Reservation PRO"** — отдельный кластер из 5 фичей с собственным SKU (50 XTR unlock), уже сейчас работает как `hasReservationPro()` фильтр на 5 эндпоинтах. Кандидат на `PRO+`.
- **"Santa PRO"** — три гейта (`santa_multi_wave`, `santa_exclusions`, `santa_exclusion_groups`) — сейчас бандл с обычным PRO, но фичи сезонные. Кандидат на event-pass.
- **"Showcase / Public Profile"** — отдельный публичный продукт, который сейчас просто включён в PRO. По UX он самостоятелен и мог бы продаваться как **"Premium Profile / Showcase Annual"**.

### 1.3. Состояния подписки

| `status` | `billingPeriod` | `cancelAtPeriodEnd` | Эффект для пользователя |
|---|---|---|---|
| `ACTIVE` | `monthly` | `false` | Авто-продление |
| `ACTIVE` | `monthly` | `true` | Доступ до `currentPeriodEnd`, потом FREE |
| `ACTIVE` | `yearly` | n/a | One-time, истечёт в `currentPeriodEnd` |
| `ACTIVE` | `lifetime` | `false` | Permanent (`currentPeriodEnd=2099-12-31` sentinel) |
| `CANCELLED` | (любой не-lifetime) | — | Если `currentPeriodEnd > now` — всё ещё PRO |
| `EXPIRED` | (любой не-lifetime) | — | Помечен hourly job'ом; FREE |

**Lifetime exclusion:** `billing.ts:66-82` явно фильтрует `NOT { billingPeriod: 'lifetime' }` в expiry sweep — defensive, потому что 2099 sentinel уже выкидывает lifetime из окна.

### 1.4. Promo-PRO

Не отдельный tier, но действующий способ получить PRO без оплаты:

- Источник: `PromoCampaign` + `PromoRedemption` (см. [MONETIZATION.md § 17](../MONETIZATION.md)).
- Триггеры выдачи: `source === 'onboarding'` или `source === 'winback'` (или godMode).
- Duration: задаётся в `PromoCampaign.grantDurationDays` (типично 30).
- Co-existence: lifetime + active promo одновременно — допустимо; resolver выберет paid subscription, promo display сохраняется в UI.

---

## 2. Add-ons и Credits

### 2.1. Полный каталог SKU (14 шт.)

Источник: [`ONE_TIME_SKUS`](../../apps/api/src/services/entitlement.ts) lines 129-144.

| SKU | Цена | Тип | Эффект | targetRequired | Бандл в PRO? |
|---|---|---|---|---|---|
| `extra_wishlist_slot` | 39 XTR | permanent | +1 вишлист сверх лимита плана | нет | нет |
| `extra_subscription_slot` | 25 XTR | permanent | +1 подписка на чужой вишлист | нет | нет |
| `extra_items_5` | 19 XTR | permanent | +5 слотов под желания в выбранном списке | да (wishlistId) | нет |
| `extra_items_15` | 39 XTR | permanent | +15 слотов | да | нет |
| `hints_pack_5` | 29 XTR | consumable | +5 hint credits | нет | PRO bypasses |
| `hints_pack_10` | 49 XTR | consumable | +10 hint credits | нет | PRO bypasses |
| `import_pack_10` | 39 XTR | consumable | +10 import credits | нет | PRO bypasses |
| `import_pack_25` | 79 XTR | consumable | +25 import credits | нет | PRO bypasses |
| `seasonal_decoration` | 29 XTR | cosmetic | Декорация на конкретный вишлист | да | нет |
| `gift_notes_unlock` | 19 XTR | permanent | Календарь / Gift Notes | нет | **да, в PRO бесплатно** |
| `reservation_pro_unlock` | 50 XTR | permanent | История броней + заметки + напоминания + статус "куплено" + фильтры | нет | **да, в PRO бесплатно** |
| `group_gift_unlock` | 79 XTR | permanent | Создание складчины (group gift) | нет | **нет, отдельно даже для PRO** |
| `secret_reservation_unlock` | 24 XTR | permanent | Тайные брони (владелец не видит, кто резервировал) | нет | **нет, отдельно даже для PRO** |
| `smart_reservations_unlock` | 15 XTR | permanent | Тайм-лимит бронирований на конкретный вишлист | да (per-wishlist) | **нет, отдельно даже для PRO** |

**Несоответствие №1 (PRO bundle vs add-on):** четыре SKU не входят в PRO — `group_gift`, `secret_reservation`, `smart_reservations`, `seasonal_decoration`. Это создаёт ощущение "купил PRO за 100 XTR — а самые интересные фичи всё ещё за деньги". См. § 8.5.

### 2.2. Caps (anti-substitution rules)

Источник: [`ADDON_CAPS`](../../apps/api/src/services/entitlement.ts:147-152).

| Cap | FREE | PRO |
|---|---|---|
| `extra_wishlist_slot` | 3 (итого ≤ 5) | 5 (итого ≤ 15) |
| `extra_subscription_slot` | 3 (любой план) | 3 |
| `extra_items_5` per list | 3 (= +15) | 3 |
| `extra_items_15` per list | 1 (= +15) | 1 |

**Замысел caps:** не дать FREE-юзеру построить псевдо-PRO из add-ons. Сейчас FREE максимум: 5 вишлистов × 35 итемов × 5 подписок — что эквивалентно ~30% PRO по объёму, но без всех feature flags. Корректно.

### 2.3. Credits

Источник: `UserCredits` модель + `import.routes.ts:99` / `hints.routes.ts:177`.

| Credit | Поле | Расход | PRO bypass |
|---|---|---|---|
| Hint credits | `UserCredits.hintCredits` | списываются при доставке hint (`POST /internal/hints/credit`), после FREE-квоты — **не** при создании волны | да |
| Import credits | `UserCredits.importCredits` | `POST /tg/import-url` (−1) | да |

**Текущая UX-болевая точка:** в коде `import.routes.ts:99` проверка идёт через `features.includes('url_import')`. Credit-based fallback существует (см. `hints.routes.ts`), но для url_import — **не проверял в этом аудите, нужно подтвердить отдельным тестом** что credit-сценарий точно работает на FREE юзере без PRO. Если работает — это значит upsell на `url_import` уже сейчас может предлагать купить `import_pack_10` за 39 XTR вместо подписки. В UI (`MiniApp.tsx:14282-14304`) этот путь не выделен — пользователь видит только PRO-замок.

---

## 3. Лимиты по тарифам

### 3.1. Numeric limits

| Лимит | FREE | PRO | Add-on можно догнать? |
|---|---|---|---|
| Вишлистов | 2 | 10 | до 5 (FREE) / до 15 (PRO) |
| Желаний в каждом | 20 | 70 | до 35 (FREE) / до 85 (PRO) per list |
| Участников (distinct gifters) на список | 5 | 20 | **нет** |
| Подписок на чужие вишлисты | 2 | 5 | до 5 (FREE) / до 8 (PRO) |

**Особенность:** "Участников" — это уникальные `reserverUserId` среди броней. Гейт на стороне **владельца** (см. § 4). Add-on на расширение этого лимита не существует.

### 3.2. Feature flags (`features` array)

| Feature flag | FREE | PRO |
|---|---|---|
| `comments` | нет | да |
| `url_import` | нет | да |
| `hints` | нет | да |

### 3.3. Boolean PRO-gated (нет в `features`, но `isPro` check)

| Surface | FREE | PRO |
|---|---|---|
| Visibility `PUBLIC_PROFILE` / `PRIVATE` (wishlist setting) | 403 | да |
| `allowSubscriptions=NOBODY` | 403 | да |
| `commentPolicy=SUBSCRIBERS` | 403 | да |
| Notification settings (comments / subs) | silent ignore | да |
| `newWishlistPosition='top'` (Settings) | silent ignore | да |
| Showcase (PATCH `/tg/me/showcase`) | 403 | да |
| Curated Selections (POST `/tg/wishlists/:id/selections`) | 402 | да |
| Profile Subscriptions (follow user) | 403 | да |
| Wishlist Categories (POST `/tg/wishlists/:id/categories`) | 402 | да |
| Don't-Gift Mode `local` / `hidden` | 402 | да |
| Don't-Gift Banner (PATCH wishlist) | 402 | да |
| Birthday Reminders advanced (4 поля) | 402 | да |
| Card Display Mode `showcase` | принудительный `auto` | да |
| Santa Multi-Wave campaign | 402 `santa_multi_wave` | да |
| Santa Exclusions | 402 `santa_exclusions` | да |
| Santa Exclusion Groups | 402 `santa_exclusion_groups` | да |
| Santa Hint Request | **403** `pro_required` | да |

### 3.4. Reservation PRO cluster (5 фичей)

Гейт: `hasReservationPro(user, isPro, addOns)` = `godMode || isPro || addon.reservation_pro_unlock`.

| Фича | Endpoint | Доступ |
|---|---|---|
| История броней | `GET /tg/reservations/history` | hasReservationPro |
| Приватные заметки | `PATCH /tg/reservations/:itemId/meta` | hasReservationPro |
| Флаг "куплено" | `PATCH /tg/reservations/:itemId/meta` | hasReservationPro |
| Напоминания | `POST /tg/reservations/:itemId/reminder` | hasReservationPro |
| Фильтры / сортировка | client-side (`reservationPro` флаг) | hasReservationPro |

**Beta-история:** в MONETIZATION.md § 3 упомянут `RESERVATION_PRO_BETA_IDS` env-список. Но в коде сейчас `isReservationBeta(user) => true` для всех ([entitlement.ts:89-91](../../apps/api/src/services/entitlement.ts)), т.е. beta открыт публично. Доку нужно обновить.

### 3.5. Lifetime-only features

Не существует. Lifetime — это просто permanent PRO с другим биллингом.

---

## 4. Paywall Triggers (Backend)

Все 402/403 связанные с PRO. Сгруппировано по типу гейта.

### 4.1. Numeric limit (402)

| Endpoint | Гейт | Файл |
|---|---|---|
| `POST /tg/wishlists` | `count >= ent.effectiveWishlistLimit` | `wishlists.routes.ts:678` |
| `POST /tg/wishlists/:id/items` | `itemCount >= ent.plan.items + addons` | `items.routes.ts:267, 327, 398, 404, 1174, 1252, 1391` |
| `POST /tg/wishlists/:id/subscribe` | `count >= ent.effectiveSubscriptionLimit` | `wishlists.routes.ts:1078` |
| `POST /tg/items/:id/reserve` (participants) | `distinct reserverUserId >= ent.plan.participants` | `reservations.routes.ts:1237` |

### 4.2. Feature flag (402)

| Endpoint | Гейт | Файл |
|---|---|---|
| `POST /tg/items/:id/comments` | `!owner.features.comments && !commenter.features.comments` | `comments.routes.ts:222` |
| `POST /tg/items/:id/hint` | `!ent.features.hints && credits=0` | `hints.routes.ts:177` |
| `POST /tg/import-url` | `!ent.features.url_import && credits=0` | `import.routes.ts:99` |
| `POST /internal/import-url` | то же | `internal.routes.ts:96` |

### 4.3. PRO boolean gates (402)

| Endpoint | Гейт | Файл |
|---|---|---|
| `POST /tg/wishlists/:id/categories` | `!ent.isPro` | `wishlists.routes.ts:1462-1464` |
| `PATCH /tg/wishlists/:id/dont-gift-banner` | `!ent.isPro` (computed) | `wishlists.routes.ts:792` |
| `POST /tg/wishlists/:id/selections` | `!ent.isPro` | `selections-archive.routes.ts:531-533` |
| `PATCH /tg/wishlists/:id` (smart-res) | `!hasSmartReservations(wlId)` | `wishlists.routes.ts:799-800` |
| `PATCH /tg/me/birthday-settings` (audience EXTENDED) | `data.audience==='EXTENDED' && !isPro` | `me.routes.ts:620` |
| `PATCH /tg/me/birthday-settings` (advanced windows) | `data.advancedWindowsEnabled && !isPro` | `me.routes.ts:624` |
| `PATCH /tg/me/birthday-settings` (primary wishlist) | `data.primaryWishlistId && !isPro` | `me.routes.ts:628` |
| `PATCH /tg/me/birthday-settings` (custom message) | `data.customMessage && !isPro` | `me.routes.ts:632` |
| `POST /tg/santa/campaigns` (multi-wave) | `!ent.isPro` | `santa.routes.ts:946` 🔴 не задокументировано |
| `POST /tg/santa/campaigns/:id/exclusions` | `!ent.isPro` | `santa.routes.ts:1838` 🔴 не задокументировано |
| `POST /tg/santa/campaigns/:id/exclusion-groups` | `!ent.isPro` | `santa.routes.ts:1885, 1972` 🔴 не задокументировано |
| `GET /tg/reservations/history` | `!hasReservationPro()` | `reservations.routes.ts:469` |
| `PATCH /tg/reservations/:itemId/meta` | `!hasReservationPro()` | `reservations.routes.ts:1048` |
| `POST /tg/reservations/:itemId/reminder` | `!hasReservationPro()` | `reservations.routes.ts:1099` |

### 4.4. PRO boolean gates (403) — несогласованный статус-код

| Endpoint | Гейт | Файл |
|---|---|---|
| `PATCH /tg/wishlists/:id` (visibility=PUBLIC_PROFILE/PRIVATE) | `!isPro` | `wishlists.routes.ts:782-783` |
| `PATCH /tg/wishlists/:id` (allowSubscriptions=NOBODY) | `!isPro` | `wishlists.routes.ts:785-786` |
| `PATCH /tg/wishlists/:id` (commentPolicy=SUBSCRIBERS) | `!isPro` | `wishlists.routes.ts:788-789` |
| `PATCH /tg/me/showcase` | `!ent.isPro` | `me.routes.ts:748` |
| `POST /tg/profiles/:id/subscribe` | `!ent.isPro` | `me.routes.ts:231+` |
| `POST /tg/santa/.../hint-request` | `!ent.isPro` | `santa.routes.ts:2692` 🔴 inconsistent (должно быть 402) |

### 4.5. Add-on gate (403)

| Endpoint | Гейт | Файл |
|---|---|---|
| `POST /tg/items/:id/group-gift` | `!ent.hasGroupGift` | `group-gifts.routes.ts:193-195` |

### 4.6. Уникальные envelope-форматы (риск client confusion)

Сейчас в коде минимум **6 разных форматов** ответа на paywall:

```
{ error: 'Pro feature', feature: 'comments', planCode: 'FREE' }
{ error: 'Plan limit reached', limit: 2, planCode: 'FREE' }
{ error: 'Subscription limit reached', limit: 2, planCode: 'FREE' }
{ error: 'Participant limit reached', feature: 'participant_limit', limit: 5 }
{ error: 'pro_required', feature: 'birthday_reminders_advanced', context: 'audience' }
{ error: 'pro_required', message: 'Upgrade to Pro to use this visibility setting' }
{ error: 'group_gift_required', priceXtr: 79 }
{ error: 'smart_reservations_required' }
```

Frontend (`MiniApp.tsx:6560-7125` и т.д.) парсит каждый случай отдельно, разветвляясь по `body.feature`, `body.planCode`, `body.error`. Это работает, но любая будущая фича рискует случайно нарушить контракт.

### 4.7. Rate limit на billing endpoints

[`rateLimits.ts:35`](../../apps/api/src/security/rateLimits.ts): категория `payment` — 5 запросов за 10 минут на пользователя. Применяется ко всем `/tg/billing/*` ручкам. OK.

---

## 5. UI Paywall Touchpoints (Frontend)

### 5.1. ProUpsellSheet — единый компонент

- Определён: [`MiniApp.tsx:3467-3528`](../../apps/web/app/miniapp/MiniApp.tsx).
- Рендерится один раз в дереве (line 26086).
- Управляется через `setUpsellSheet({ context, wishlistId? })` — вызывается из **60+ мест**.
- Антиспам: throttle "max 1 auto-show per session + 30s cooldown" (line 5731, при `auto: true`).

### 5.2. Все 24 UpsellContext

| Context | Где триггерится | i18n покрытие |
|---|---|---|
| ✅ `comments` | Comments lock (16152-16433) | full |
| ✅ `url_import` | Item-add URL input lock (14282-14304) | full |
| ✅ `hints` | Hint CTA на item-detail | full |
| ✅ `wishlist_limit` | Wishlist create 402 | full |
| ✅ `item_limit` | Item add 402 | full |
| ✅ `participant_limit` | Reserve 402 (owner-side) | full |
| ✅ `subscription_limit` | Follow 402 | full |
| ✅ `sort_recommended` | Sort options PRO-only | full |
| ✅ `birthday_reminders_advanced` | PATCH birthday 402 | full |
| 🆕 `reservation_pro` | Secret reservation paywall, reservation detail | full |
| 🆕 `categories` | Category create/move 402 | full |
| 🆕 `dont_gift` | Profile-level dont-gift toggle 402 | full |
| 🆕 `dont_gift_banner` | Wishlist-scoped anti-gift banner 402 | full |
| 🆕 `curated_selection` | Curated selections create | full |
| 🆕 `smart_reservations` | Smart reservation unlock (per-wishlist) | full |
| 🆕 `showcase` | Showcase editor / public profile entry | full |
| 🆕 `appearance` | Theme/accent customization | **🔴 хардкод RU, нет i18n** |
| 🆕 `pro_main` | Settings → connect_pro, bot deep-link | full |
| 🆕 `search` | Search hits PRO-only result types | full |
| 🆕 `bot_import` | Mirror of url_import — **никогда не триггерится** | full (unused) |

✅ задокументировано в MONETIZATION.md, 🆕 — нет.

### 5.3. Где FREE-юзер физически видит upgrade

1. **Settings → PRO plan card (FREE-вариант)** — `MiniApp.tsx:18687-18876`. Показ 20 бенефитов, CTA "Connect Pro" 100 ⭐.
2. **Inline locks по фичам** — comments, URL import, hints. Локализованный замок + ProBadge.
3. **ProUpsellSheet (bottom sheet)** — по 24 контекстам.
4. **Showcase entry card** — locked card на Settings экране с CTA.
5. **Secret reservation paywall** — full-screen overlay для `secret-reservation-paywall` экрана.
6. **Bot DM** — winback (`lifecycle.ts`), renewal reminder (`pro-renewal.ts`), referral-related (`referral.routes.ts`).
7. **ProBadge на полях Settings** — birthday fields, notification toggles, new wishlist position.
8. **Anti-churn cancel flow** — но **только** success toast, без bottom sheet с потерями (см. § 8.6).

### 5.4. Settings PRO card (PRO-вариант)

[`MiniApp.tsx:18972-19162`](../../apps/web/app/miniapp/MiniApp.tsx) — показывает:

- Limits (3 строки): вишлисты, желания, участники.
- Features (10 чекмарков): комменты, URL, hints, подписки, приватность, календарь, lite share, dont-gift, smart res, secret notes.
- Subscription status (Lifetime / Active-renewing / Cancelled).
- Cancel / Resume CTA.
- Promo code input (для всех PRO).

### 5.5. Add-on UI

Add-ons предлагаются в **двух** местах:

1. **Внутри ProUpsellSheet** — релевантный SKU для контекста (например, `extra_wishlist_slot` при `wishlist_limit`). Mapping в `CONTEXT_ADDON_SKUS`.
2. **Внутри Settings plan card (FREE)** — pre-filtered список: `extra_wishlist_slot`, `extra_items_5`, `extra_items_15`, `extra_subscription_slot`, `gift_notes_unlock`, `reservation_pro_unlock`.

`seasonal_decoration` доступна только через wishlist-edit surface.
`secret_reservation_unlock` доступна только через `secret-reservation-paywall` screen.
`smart_reservations_unlock` доступна только через `smart_reservations` upsell context (per-wishlist).
`group_gift_unlock` доступна через item-detail → "сделать складчиной".

### 5.6. Telegram Stars invoice flow

3 call site: PRO checkout (line 7613), add-on checkout (line 7855), referral link (line 22238). Все вызывают `Telegram.WebApp.openInvoice()`, poll `/tg/billing/*/sync` до 6× с 1с интервалом, обновляют local state.

---

## 6. Backend Entitlement Checks

Файл: [`apps/api/src/services/entitlement.ts`](../../apps/api/src/services/entitlement.ts) (329 LOC).

### 6.1. Core resolver — `getUserEntitlement(userId, godMode?)`

Priority order:

1. **Active `Subscription`** with `planCode='PRO'`, `status IN ('ACTIVE','CANCELLED')`, `currentPeriodEnd > now()` → `proSource: 'subscription'`.
2. **Active `PromoRedemption`** with `status='ACTIVE'`, не истёкший → `proSource: 'promo'`.
3. **`godMode=true`** (telegramId in `GOD_MODE_TELEGRAM_IDS` env) → `proSource: 'god_mode'`.
4. Иначе → `PLANS.FREE`, `isPro: false`.

Возвращает: `plan` (FREE/PRO copy), `isPro`, `proSource`, `subscription`, `promoPro`, `addOns`.

### 6.2. Effective entitlements — `getEffectiveEntitlements()`

Поверх base plan накладывает add-ons и credits:

```
effectiveWishlistLimit       = plan.wishlists + Σ(UserAddOn.wishlist_slot)
effectiveSubscriptionLimit   = plan.subscriptions + Σ(UserAddOn.subscription_slot)
extraItemsPerWishlist[wId]   = Σ(UserAddOn.item_slot_5|15 with targetId=wId)
hintCredits                  = UserCredits.hintCredits (PRO bypasses)
importCredits                = UserCredits.importCredits (PRO bypasses)
hasGiftNotes                 = isPro || UserAddOn.gift_notes_unlock
hasGroupGift                 = godMode || UserAddOn.group_gift_unlock
hasSecretReservations        = UserAddOn.secret_reservation_unlock
hasSmartReservations(wId)    = isPro || UserAddOn.smart_reservations_unlock with targetId=wId
```

### 6.3. Specialized gates

| Функция | Логика | Места вызова |
|---|---|---|
| `hasReservationPro(user, isPro, addOns)` | `godMode \|\| isPro \|\| addon.reservation_pro_unlock` | reservations.routes.ts × 3 |
| `hasSmartReservations(user, isPro, addOns, wlId)` | `godMode \|\| isPro \|\| per-wishlist add-on` | wishlists.routes.ts:799 |
| `isReservationBeta(user)` | возвращает `true` для всех (beta открыта) | items.routes.ts, reservations.routes.ts |

### 6.4. Особенности lifetime resolver'а

- `subscription.billingPeriod === 'lifetime'` — единственный признак (никогда не сравнивать `currentPeriodEnd` с эвристикой).
- На `pro_monthly` / `pro_yearly` payment'е после lifetime — НЕ overwrite Subscription, пишется `PaymentEvent.eventType='payment_success_post_lifetime'`, бот молчит.
- Cancel/reactivate для lifetime: 409 `lifetime_cannot_cancel`.

### 6.5. Schedulers, работающие с биллингом

| Scheduler | Cadence | Что делает |
|---|---|---|
| `subscriptionExpirySweep` ([billing.ts:66](../../apps/api/src/schedulers/billing.ts)) | hourly | ACTIVE→EXPIRED, исключает lifetime |
| `promoRedemptionExpiry` ([billing.ts:85](../../apps/api/src/schedulers/billing.ts)) | hourly | ACTIVE PromoRedemption → EXPIRED + старт GRACE_PERIOD |
| `degradationGracePeriod` ([billing.ts:122](../../apps/api/src/schedulers/billing.ts)) | hourly | После grace — ARCHIVE затем PURGE |
| `proRenewalReminder` ([pro-renewal.ts](../../apps/api/src/schedulers/pro-renewal.ts)) | hourly | DM за 7д и 1д до expiry; ИСКЛ. lifetime |
| `lifecycle` ([lifecycle.ts](../../apps/api/src/services/lifecycle.ts)) | hourly | Winback, day-N nudges (см. § 11) |

---

## 7. Frontend Entitlement Checks

### 7.1. Где читается `isPro` / `planInfo.code` в JSX

40+ мест (полный список в раздел "Audit findings"). Категории:

- **State-driven UI** (card layout, badges): 12+ места показа ProBadge.
- **Action-gating** (disable + show upsell on tap): 15+ мест (notifications toggle, birthday fields, sort options).
- **Hidden UI** (PRO-only contents скрыты для FREE): 8+ мест (showcase entry, comments form, URL import).
- **Counters** (X из Y): wishlist creation, subscription, item add.

### 7.2. Все 13 catch sites на 402 в `MiniApp.tsx`

| Line | Endpoint | Контекст |
|---|---|---|
| 6560 | POST /wishlists/:id/subscribe | subscription_limit |
| 7006 | POST /import-url | url_import |
| 7113 | POST /wishlists/:id/items (placement) | item_limit (с проверкой planCode) |
| 7423 | POST /items/:id/comments | comments (+ track паттерн) |
| 7492 | POST /items/:id/hint | hints |
| 9639 | POST /wishlists | wishlist_limit |
| 9927 | POST /wishlists/:id/categories | categories |
| 10006/14 | POST /items/move-category | categories |
| 10161 | PATCH /me/dont-gift | dont_gift |
| 10250 | PATCH /wishlists/:id/dont-gift-banner | dont_gift_banner |
| 10611 | POST /wishlists/:id/items (create item) | item_limit |
| 20997 | PATCH /me/birthday-settings | birthday_reminders_advanced (+ event track) |

> **Замечание:** `POST /items/:id/reserve` участник-limit возвращает **409**, а не 402, и обрабатывается как silent toast — это не upsell-driven, и **правильно**: гость не должен видеть upsell владельца.

### 7.3. Throttle и анти-спам

- Auto-show: max 1 на сессию + 30с cooldown между показами (`MiniApp.tsx:5731`).
- Manual show (по тапу) — не троттлится.
- Bot DM ratelimit: через `LifecycleTouch` модель — гарантирует, что одно и то же CRM-сообщение не отправится дважды.

---

## 8. Риски рассинхронизации frontend/backend

### 8.1. Документация vs реальность

| Что в [MONETIZATION.md](../MONETIZATION.md) | Что в коде | Действие |
|---|---|---|
| 13 PRO benefits | 20 (+7 новых) | Обновить § 2 |
| 9 UpsellContext | 24 (+15 новых) | Обновить § 7 |
| `RESERVATION_PRO_BETA_IDS` env | `isReservationBeta(u) => true` для всех | Удалить упоминание beta |
| Cancel flow "8 фичей, что вы теряете" | Только success toast | Реализовать sheet ИЛИ обновить доку |

### 8.2. Frontend гейты без backend enforcement

Только один: **sort_recommended** (recommended guest sort). PRO-чип на client, но сервер не проверяет — нужен custom client чтобы обойти. Низкий риск, но желательно добавить как примечание в код.

### 8.3. Backend гейты без visible client preview

- **Категории вишлиста (POST `/categories`)** — backend 402, на client есть upsell, но в Settings PRO-card среди features этой строки нет.
- **Don't-gift global vs local/hidden** — backend 402 на не-global, в UI запутанно (`dont_gift` контекст + `dont_gift_banner` контекст — два разных upsell).
- **Card display mode 'showcase'** — `getEffectiveEntitlements()` принудительно отдаёт `'auto'` для FREE; UI этого не объясняет.
- **3 Santa PRO-гейта** — нет ни в Settings, ни в paywall, ни в getProBenefits. Юзер узнаёт о них **только в момент** создания multi-wave кампании.

### 8.4. Status code inconsistency

Большинство feature-related paywall'ов → **402**. Privacy / showcase / profile_subscribe → **403**. Group gift add-on → **403**. Этот микс работает, но усложняет analytics ("сколько paywall impression было сегодня" не сводится одним фильтром). Рекомендую один статус (402) для всех "купи PRO/SKU" ситуаций; 403 оставить только для "тебе сюда не положено" (нет прав, чужой объект).

### 8.5. PRO bundling гэп

Эти 4 SKU **не** включены в PRO:
- `secret_reservation_unlock` (24 XTR)
- `smart_reservations_unlock` (15 XTR per list)
- `group_gift_unlock` (79 XTR)
- `seasonal_decoration` (29 XTR per list)

Это сознательное решение (см. MONETIZATION.md § 14-16), но порождает обиду: PRO-юзер всё равно платит. Альтернативы:
- Включить `secret_reservation` и `smart_reservations` в PRO (потерять ~50% мелких add-on revenue в обмен на снижение friction).
- Сделать "PRO Plus" tier который включает всё (но это новый ценовой ярус).
- Дать PRO 1-2 бесплатных использования в месяц как goodwill.

### 8.6. Cancel flow gap

MONETIZATION.md § 5 описывает "bottom sheet с 8 фичами что вы потеряете". В коде (`handleCancelSub` line 7686-7726) — только тост `cancel_success` с датой. Это значит:
- i18n ключи `cancel_feat_*` (11 шт) **существуют**, но не рендерятся.
- Anti-churn UX не работает как задумано.

Это либо **выпало из релиза**, либо **раньше работало и было удалено** — нужно проверить git log по `cancel_feat_` и `handleCancelSub`.

### 8.7. `bot_import` контекст-сирота

`MiniApp.tsx:2222` — задефайнен `getUpsellContent('bot_import')`, но grep по `showUpsell('bot_import')` / `setUpsellSheet({ context: 'bot_import' })` — **ноль вхождений**. Либо нужно удалить, либо проверить почему так и не подключено.

### 8.8. `appearance` контекст без i18n

`MiniApp.tsx:2241` — все строки хардкод по-русски ("Персонализация внешнего вида", "OLED-чёрная тема", и т.д.). При смене локали юзер видит русский. Это **высокий приоритет** для починки (1 час работы), особенно учитывая что весь остальной i18n — wave 1..10 уже закрыт.

---

## 9. Paywall'ы, которые могут ломать activation или viral loop

> Контекст: WishBoard = вишлист → шеринг ссылки → друг резервирует → друг ставит app.
> Activation = user → wishlist → первый item.
> Viral loop = owner → share → guest reserve → guest engages.

### 9.1. Activation killers (по убыванию severity)

| Точка | Severity | Что происходит | Почему критично |
|---|---|---|---|
| **URL-import первого item'а** | 🔴 high | FREE юзер пастит ссылку из Озона в "добавить желание" → 402 → upsell | URL-import — **главный способ** заполнить вишлист быстро. Если первый item падает, retention обрушится. |
| **Group gift как primary use case** | 🔴 high | Пользователь пришёл "по реферралу складчины", создаёт первую складчину → 403 + 79 XTR paywall | 79 XTR на день 1 — высокий барьер. Альтернатива: trial (первая складчина free, дальше 79 XTR). |
| **Категории вишлиста** | 🟠 medium | Юзер создаёт второй wishlist с категориями → 402 | Категории появились как PRO в недавнем релизе, в MONETIZATION.md их вообще нет. |
| **Showcase entry в Settings** | 🟡 low | FREE юзер видит "Showcase" с замком при первом заходе в Settings | Не ломает actiavation, но создаёт wall of locks. |
| **Birthday advanced при первом setup** | 🟡 low | Юзер ставит ДР, хочет настроить custom message → 402 | Не критично: 14d + day-of остаются FREE; advanced не нужен сразу. |

### 9.2. Viral loop blockers

| Точка | Severity | Что происходит |
|---|---|---|
| **Participant limit (5 на FREE)** | 🟠 medium | Owner получает 5 уникальных бронеров → 6-й гость попадает в 402 у владельца. Гость **не виноват**, но не может зарезервировать. |
| **Comments either-or** | 🟢 ok | Если хоть один из owner/commenter — PRO, всё работает. Низкий friction. |
| **First reservation by guest** | 🟢 ok | Не блокируется. Гость может резервировать сразу. |
| **Curated selection sharing** | 🟡 low | Owner не может создать "лайт-share" если FREE; full-share работает всегда. |

### 9.3. Что НЕ ломает loop (специально проверено)

- **Создание первого вишлиста** — FREE.
- **Добавление первого item'а (manual)** — FREE.
- **Шеринг ссылки** — всегда FREE, токен генерируется без проверок (`wishlists.routes.ts:460`).
- **Просмотр чужого вишлиста гостем** — FREE.
- **Резерв item'а гостем** — FREE.
- **Подписка на чужой вишлист (первая)** — FREE (FREE-лимит 2).

### 9.4. Виральные плюшки, которые ускоряют loop

- **Referral program** (`referral.routes.ts`): инвайтер получает 30 дней PRO за каждого реферала, cap 3/мес, 12/год. Включается админом (`ReferralProgramConfig.enabled` default `false` — **проверь in prod**).
- **Promo PRO** через `WISHPRO`-подобные коды (`promo.routes.ts`) — даёт временный PRO бесплатно.
- **Winback DM** — пользователь, потерявший PRO, получает напоминалку с промо-кодом (см. `lifecycle.ts`).

### 9.5. Главные рекомендации для loop

1. **URL-import: hard 402 → graceful credit upsell.** Дать FREE 5 бесплатных импортов в месяц с явным счётчиком "осталось 4 из 5", потом предложить пак за 39 XTR или PRO. Текущий хард-замок — самый большой риск activation.
2. **Participants: 5 → 10.** ДР с 8 гостями — типовой кейс. 5 — слишком тесно.
3. **Documenting Santa gates** или их пересмотр. Если планируется монетизировать Santa отдельно (event-pass) — сейчас самый момент.

---

## 10. Какие фичи лучше оставить бесплатными с квотой

Принцип: фичи, которые **повышают habit-формирование и virality**, должны иметь free quota; платная только сверх квоты.

| Фича | Сейчас | Предлагается | Почему |
|---|---|---|---|
| **URL Import** | Hard 402 для FREE | 5 импортов/мес FREE, потом credit/PRO | Главный onboarding-step, не должен ломаться |
| **Hints** | ✅ 3 hints/мес FREE — **shipped 2026-05-21** | — | Hints — soft-virality, "намекни другу" — каждое использование тянет к диалогу. FREE-квота списывается при **доставке** (hint → DELIVERED), не при создании hint-волны: недоставленный hint квоту не тратит. Audit-ledger `HintQuotaCharge`. |
| **Comments** | Either-or PRO | Оставить either-or | Гениальная механика, любая сторона PRO разблокирует — оптимально |
| **Participants per list** | 5 на FREE | 10 на FREE | ДР-кейс ломается на 5; 10 — комфортный потолок |
| **Categories** | Hard 402 | 3 категории FREE на вишлист, дальше PRO | Категории помогают NUX второго вишлиста; сейчас полностью closed |
| **Curated Selections** | Hard 402 | 1 selection/квартал FREE | Lite-share — потенциально вирусный канал |
| **Don't-gift list (global)** | Уже FREE | Оставить | Personalization, удержание |
| **Don't-gift list (per-wishlist)** | Hard 402 | Оставить PRO | Узко-полезно, PRO-сегмент |
| **Hint requests в Santa** | Hard 403 | 1 hint/кампания FREE | Поднимет engagement сезонного продукта |
| **Wishlist count** | 2 на FREE | Оставить 2 | Создаёт явный upgrade trigger без ломания UX |
| **Secret Reservation** | Hard add-on (24 XTR) | 1 free secret res на пользователя в год | Wow-feature, попробовать → захотеть ещё |
| **Smart Reservations** | Per-list 15 XTR | Per-list 15 XTR (оставить) | Узкая utility, тех-долг владельца |

---

## 11. Какие фичи лучше продавать как add-on/event pass

Принцип: фичи **сезонные**, **разовые**, или с **низкой recurring-полезностью** — лучше продаются time-boxed пасами, чем монотонной подпиской.

### 11.1. Уже add-on'ы (правильно)

- `extra_wishlist_slot`, `extra_subscription_slot` — perma slots, очевидный add-on.
- `extra_items_5/15` per list — на конкретный вишлист, разовая боль.
- `seasonal_decoration` — cosmetic.
- `gift_notes_unlock` — но: включён в PRO, можно тестить отдельно.
- `secret_reservation_unlock` — perma unlock на one wow-фичу.
- `smart_reservations_unlock` — perma per-list.
- `group_gift_unlock` — perma unlock на ивент-функцию.

### 11.2. Кандидаты на новые event-passes

| Pass | Что внутри | Длительность | Цена (предв.) | Сезон |
|---|---|---|---|---|
| **🎂 Birthday Pass** | birthday advanced (audience EXTENDED, primary wl, custom message, advanced windows) | 60 дн (40 до ДР + 20 после) | 49 XTR | за месяц до ДР |
| **🎅 Santa Season Pass** | multi-wave + exclusions + exclusion groups + hint requests + showcase | 60 дн (15 Nov – 15 Jan) | 89 XTR | декабрь |
| **🎁 New Year Pass** | curated selections + lite share + dont-gift local + smart reservations × 2 lists | 30 дн (15 Dec – 15 Jan) | 69 XTR | NY |
| **💍 Anniversary Pass** | gift notes + reservation pro + showcase | 30 дн вокруг даты | 39 XTR | по триггеру |
| **✨ Showcase Annual** | showcase + curated selections + premium profile | 365 дн | 299 XTR | always-on |
| **🔥 Gifting Spree Pass** | URL import unlimited + hints × 30 + secret res × 3 + 5 extra wishlists | 30 дн | 99 XTR | high-shopping season |

### 11.3. Преимущества event-pass модели

- **Меньший psychological barrier** — 49-99 XTR на ивент vs 100 XTR/мес подписка.
- **Сезонная актуальность** — Santa Pass нужен только в декабре, цена оправдана.
- **Лестница к PRO** — юзер, купивший 3 пасса за год (~177 XTR), уже психологически готов к Lifetime (2 490 XTR за 9-12 средних пассов).
- **Не каннибализирует PRO для power-users** — те, кому нужно всегда, всё равно купят PRO.

### 11.4. Риски event-pass

- **Сложность UX** — пасс с окном "29 дней до конца" требует countdown и нотификаций. Без них юзер не знает, что owns pass.
- **Поддержка multiple active passes** — нужно `getEffectiveEntitlements()` уметь складывать N паспортов. Сейчас архитектура `UserAddOn` — fine для perma SKU, но для time-bound нужно `expiresAt` поле.
- **Аналитика конверсии** — каждый пасс требует своего funnel.
- **PRO becomes confusing** — если есть 5 разных пассов, "что мне выгоднее" — задача для калькулятора.

---

## 12. Три варианта переупаковки тарифов

### Вариант A — Conservative

**Гипотеза:** существующая монетизация в основе верная, проблема в нескольких хард-paywall точках. Мягкие правки.

#### FREE
- Wishlists: 2 (без изменений)
- Items: 20 (без изменений)
- **Participants: 5 → 10** (главная правка)
- Subscriptions: 2 (без изменений)
- **URL Import: hard 402 → 5 импортов/мес** (через `importCredits` дефолт; счётчик в UI)
- **Hints: hard 402 → 3 hints/мес** (тот же механизм)
- Comments: either-or PRO (без изменений)
- **Categories: 1-я категория FREE per wishlist, далее PRO** (новое)
- **Santa hint request: 1/кампания FREE** (новое)

#### PRO (100 XTR/мес, 800/год, 2490 lifetime)
Всё как сейчас + неограниченный URL/hints/categories.

#### Add-ons
- Сохранить все 14 SKU.
- **Удалить** `seasonal_decoration` (низкий ROI на UI surface).
- **Снизить** `secret_reservation_unlock` 24 → 19 XTR (impulse buy).

#### Какие paywall'ы убрать/перенести
- ❌ `url_import` hard 402 → credit-based с явным free quota.
- ❌ `hints` hard 402 → credit-based.
- ❌ `categories` hard 402 → free 1-я категория.
- ❌ `participant_limit` сдвиг 5 → 10.
- ✅ Оставить: comments either-or, showcase PRO, all reservation-pro features.

#### Метрики после изменения
- **D7 retention** (главное; ожидание +5-10pp).
- **First-item-success rate** (item успешно добавлен → wishlist не пустой); ожидание +15-25pp за счёт URL-import fix.
- **K-factor** (invited users per active user); ожидание +5-10pp за счёт participant lift.
- **PRO conversion rate** среди FREE юзеров (контрольная — не должна упасть >5pp).
- **ARPPU** (revenue per paying user); проверка не упала ли из-за дешевле SKU.
- **Paywall impressions per session** — должен снизиться (меньше шума).

#### Риски
- ARPU может слегка просесть из-за добавки free quota на URL/hints.
- Юзеры, ранее покупавшие `import_pack_10` за 39 XTR, могут перестать (5 free × 6 мес = 30 free vs пак 10).

---

### Вариант B — Growth-first

**Гипотеза:** для текущей стадии (400 юзеров, 2 мес) главная задача — top-of-funnel и K-factor. PRO становится утилитой для power-users, FREE — generous default.

#### FREE
- **Wishlists: 2 → 3**
- **Items: 20 → 30**
- **Participants: 5 → 10**
- **Subscriptions: 2 → 5** (равно PRO! — следить ниже)
- **URL Import: 10/мес** + credit fallback
- **Hints: 5/мес**
- Comments: either-or PRO
- **Categories: до 3 категорий FREE per wishlist**
- **Don't-gift global: FREE** (уже так)
- **Curated Selection: 1 в месяц FREE** (lite-share как viral driver)
- Birthday: 14d + day-of (как сейчас); advanced — PRO
- Santa: 1 кампания / multi-wave / hint — FREE; exclusions PRO; групповые exclusions PRO

#### PRO (та же цена 100/800/2490)
**Чем теперь "ценен" PRO:**
- Unlimited URL/hints
- Advanced privacy (visibility, allowSubs, commentPolicy)
- Showcase + curated unlimited
- Don't-gift local/hidden
- All reservation pro (history, notes, reminders, purchased)
- All birthday advanced
- All santa advanced (exclusions, exclusion groups, multi-wave unlimited)
- **5 → 10 subscriptions** (отделяем от FREE на 2×)
- 70 items / 10 wishlists / 20 participants — как сейчас

#### Add-ons
- Сохранить 14 SKU.
- **Снять** `extra_subscription_slot` (FREE теперь 5, PRO 10 — слот менее ценен).
- **Снизить** `extra_items_5` 19 → 15 XTR, `extra_items_15` 39 → 29 XTR (item add-ons теперь главное для FREE-users-around-3rd-wishlist).
- **Удалить** `seasonal_decoration` (или сделать FREE → монетизация cosmetics через отдельную систему позже).

#### Какие paywall'ы убрать/перенести
- ❌ `wishlist_limit` 2 → 3
- ❌ `subscription_limit` 2 → 5
- ❌ `participant_limit` 5 → 10
- ❌ `url_import` hard 402 → 10/мес
- ❌ `hints` hard 402 → 5/мес
- ❌ `categories` hard 402 → 3 FREE
- ❌ `dont_gift` (global) — оставить уже FREE
- ❌ `santa_multi_wave` — первая кампания FREE
- ✅ Оставить: showcase PRO (узкий продукт), reservation pro cluster, birthday advanced.

#### Метрики
- **Activation rate (% юзеров с ≥1 item за 24ч)** — главный KPI; ожидание +15-25pp.
- **D7 / D30 retention** — ожидание +8-12pp.
- **K-factor** — ожидание +10-15pp.
- **PRO conversion** — **может упасть на 3-7pp** в краткосроке, но абсолютное число PRO юзеров должно вырасти из-за роста base.
- **Avg wishlists per user** — рост 1.2 → 1.6.
- **Avg participants per popular wishlist** — рост 3.5 → 5-6.
- **Long-term LTV** — ожидание +20% за счёт большей retention.

#### Риски
- Ближайшие 2-3 мес PRO-выручка может просесть. Нужен запас.
- "Generous FREE" может создать культуру не-платить. Митигация: фронт-загруженные **трайлы** для high-value фичей (showcase, reservation pro).
- `extra_subscription_slot` SKU становится почти бесполезным — можно дропнуть.

---

### Вариант C — Event-pass-first

**Гипотеза:** FREE generous, PRO для power-users, **главный денежный поток — сезонные/событийные пассы**. WishBoard по природе использует "ивенты" (ДР, НГ, Santa, годовщины) — упаковать монетизацию ровно под них.

#### FREE
Идентичен Варианту B (все либералы).

#### PRO (та же цена 100/800/2490)
- Все always-on фичи (showcase, reservation pro cluster, advanced privacy, unlimited limits).
- **Не** включает event-bound фичи (Santa multi-wave, Birthday advanced, Anniversary kit) — они продаются отдельно как passes.

#### Add-ons + Passes

**Permanent add-ons (как сейчас):**
- `extra_wishlist_slot` (39 XTR)
- `extra_items_5/15` (19/39 XTR)
- `extra_subscription_slot` (25 XTR)
- `secret_reservation_unlock` (24 XTR)
- `smart_reservations_unlock` per list (15 XTR)
- Hint / import packs (29/49/39/79 XTR)

**Сезонные паспорта (новое):**
- 🎂 **Birthday Pass** — 49 XTR, 60 дн вокруг ДР, разблокирует все 4 birthday advanced поля + 5 extra участников. Триггер: за 30 дн до ДР owner-а в Settings.
- 🎅 **Santa Season Pass** — 89 XTR, 15 Nov – 15 Jan, multi-wave + exclusions + exclusion groups + 5 hint requests. Триггер: автоматический баннер 1 Nov.
- 🎁 **New Year Pass** — 69 XTR, 15 Dec – 15 Jan, 5 curated selections + dont-gift local + 2 smart res slots. Триггер: 10 Dec.
- 💍 **Anniversary Pass** — 39 XTR, 30 дн от даты, gift notes + reservation pro + showcase preview. Триггер: пользовательский ввод даты.
- 🔥 **Gifting Spree Pass** — 99 XTR, 30 дн, URL unlimited + 30 hints + 3 secret res + 5 extra wishlists. Always-purchasable, для шопинг-сезона.
- ✨ **Showcase Annual** — 299 XTR, 365 дн, showcase + curated unlimited + custom profile theme. Alternative для тех кто не хочет PRO целиком.

#### Какие paywall'ы убрать/перенести
- ❌ `wishlist_limit` 2 → 3
- ❌ `subscription_limit` 2 → 5
- ❌ `participant_limit` 5 → 10
- ❌ `url_import` hard 402 → 10/мес FREE
- ❌ `hints` hard 402 → 5/мес FREE
- ❌ `categories` hard 402 → 3 FREE
- ❌ `birthday_reminders_advanced` → переезжает в Birthday Pass (НЕ в PRO бандл)
- ❌ `santa_multi_wave / exclusions / exclusion_groups` → переезжают в Santa Season Pass
- ⚠️ `showcase` остаётся в PRO, но **также** доступен через Showcase Annual.

#### Архитектурные изменения (предупреждение)

Event-pass требует расширения схемы:
- `UserAddOn` сейчас permanent — нужно поле `expiresAt`.
- `getEffectiveEntitlements()` должен фильтровать активные/истёкшие пассы.
- Bot reminder system нужен extend на pass-expiry (за 7д до конца).
- Аналитика: каждый pass — своя воронка.

Это **3-4 недели dev-работы**, не "включил флаг".

#### Метрики
- **Pass-purchase-rate per event window** (главный) — % юзеров, которые в окне Pass-сезона купили пасс.
- **Repeat-pass-buys per user/год** — индикатор LTV; цель ≥ 2 пассов/год для активных юзеров.
- **Pass → PRO conversion** — % юзеров, купивших ≥3 пасса за 12 мес и перешедших на PRO/Lifetime. Цель ≥ 25%.
- **Cross-pass conversion** — купив Santa Pass, какой % покупает Birthday Pass и т.п.
- **PRO conversion direct (без passes)** — может упасть на 10-20pp; компенсация — обороты passes.
- **Seasonal revenue concentration** — % выручки в декабре / мае (birthday peak); цель — диверсификация по пассам.

#### Риски
- **Высокая сложность** — самый рискованный вариант с точки зрения dev + UX.
- **"Какой пасс мне нужен" decision fatigue** — нужен калькулятор сравнения.
- **Сезонная зависимость** — пик в декабре, провал в феврале. Митигация — always-on Gifting Spree Pass + Showcase Annual.
- **PRO становится "невыразительным"** — нужно очень чётко позиционировать "PRO для тех, кто всегда дарит и получает".

---

## 13. Сравнение вариантов

| | A: Conservative | B: Growth-first | C: Event-pass-first |
|---|---|---|---|
| **Изменения схемы БД** | минимум | средне | значительно (expiresAt + pass model) |
| **Dev-время** | 1 нед | 2-3 нед | 4-6 нед |
| **Risk to current ARPU** | низкий | средний | высокий |
| **Upside to top-of-funnel** | +5-10% | +20-35% | +25-45% |
| **Upside to LTV** | +5-10% | +15-25% | +30-50% (при successful execution) |
| **UX complexity** | низкая | низкая | высокая |
| **Аналитика complexity** | без изменений | без изменений | значительно сложнее |
| **Когда выкатывать** | сейчас (минимум риска) | через 1 мес (тест A → B) | через 3 мес (после Bsuccess) |

**Моя рекомендация (как pricing strategist):**

1. **Сейчас:** Вариант A. Минимум риска, быстрый win на activation (URL-import fix). Можно деплоить за неделю.
2. **+1 мес после A:** A/B-тест Варианта B на новых юзерах (после стабилизации A метрик).
3. **+3 мес:** если B показал K-factor и retention рост — выкатывать C на сезон Santa (декабрь) как **pilot** event-pass.
4. **Параллельно:** починить i18n `appearance`, удалить `bot_import`-сироту, привести status code 402/403 к единому контракту, написать и реализовать cancel-flow bottom sheet.

---

## 14. Action items (priority-ranked)

### P0 (1-2 недели)

- [ ] Починить i18n для `appearance` UpsellContext (хардкод RU).
- [ ] URL-import: hard 402 → graceful credit fallback с counter в UI. Дать 5 free imports/мес. (Вариант A core.)
- [x] Hints: hard 402 → 3 free/мес. **Shipped 2026-05-21** — FREE-квота списывается при доставке hint (DELIVERED), не при создании волны; idempotent audit-ledger `HintQuotaCharge`; grace-доставка если квота кончилась между созданием и доставкой. См. `services/hint-credits.ts`.
- [ ] Participant limit FREE: 5 → 10. (Update PLANS.FREE.participants in entitlement.ts.)
- [ ] Document или удалить 3 Santa PRO gates. Если оставлять — добавить в Settings PRO card features list и в getProBenefits.
- [ ] Удалить `bot_import` upsell context-сироту (или подключить).
- [ ] Cancel-flow bottom sheet — выяснить почему не рендерится (git log по `cancel_feat_`); восстановить или формально удалить из доки.

### P1 (1 мес)

- [ ] Унифицировать paywall error envelope (предложение: `{ error: 'pro_required' | 'addon_required', feature, context, planCode, priceXtr? }`).
- [ ] Унифицировать status code: 402 для всех "купи", 403 только для "не положено".
- [ ] Обновить MONETIZATION.md § 2 (13 → 20 benefits) и § 7 (9 → 24 contexts).
- [ ] Решить: остаются ли `secret_reservation`, `smart_reservations`, `seasonal_decoration` отдельно от PRO. Если убираем в PRO — обновить `getEffectiveEntitlements` + миграция.
- [ ] Запустить Вариант B A/B-тест на cohort новых юзеров.

### P2 (квартал)

- [ ] Архитектура для event-pass: `UserAddOn.expiresAt`, `PassDefinition` модель, expiry-scheduler, expiry-reminder DM.
- [ ] Sky-pricing на Santa Season Pass + Birthday Pass.
- [ ] Decision-калькулятор: "что мне выгоднее — Pass или PRO" UI.
- [ ] Lifetime-pricing review: 2 490 XTR соответствует ~24 мес монтли (good). При движении к event-passes — переоценить.

---

## 15. Источники и references

- [docs/MONETIZATION.md](../MONETIZATION.md) — текущий source-of-truth (на 2026-05-08).
- [apps/api/src/services/entitlement.ts](../../apps/api/src/services/entitlement.ts) — все константы, resolver, gate-функции (329 LOC).
- [apps/api/src/routes/](../../apps/api/src/routes/) — 21 route file с inline paywall checks.
- [apps/api/src/schedulers/billing.ts](../../apps/api/src/schedulers/billing.ts) — expiry, grace, degradation jobs.
- [apps/api/src/schedulers/pro-renewal.ts](../../apps/api/src/schedulers/pro-renewal.ts) — renewal reminder.
- [apps/api/src/services/lifecycle.ts](../../apps/api/src/services/lifecycle.ts) — winback/CRM.
- [apps/api/src/security/rateLimits.ts](../../apps/api/src/security/rateLimits.ts) — `payment` category (5/10min).
- [packages/db/prisma/schema.prisma](../../packages/db/prisma/schema.prisma) — `Subscription`, `PromoCampaign`, `PromoRedemption`, `UserAddOn`, `UserCredits`, `ReferralProgramConfig`, `DegradationState`, `LifecycleTouch`, `PaymentEvent`.
- [packages/shared/src/i18n.ts](../../packages/shared/src/i18n.ts) — 300+ monetization keys (18 089 LOC total).
- [apps/web/app/miniapp/MiniApp.tsx](../../apps/web/app/miniapp/MiniApp.tsx) — 33 310 LOC monolith с всеми UI gate'ами.
- [docs/CURRENT_PRODUCT_STATE.md](../CURRENT_PRODUCT_STATE.md) — фичи в проде.
- [docs/ONBOARDING_AND_ACTIVATION.md](../ONBOARDING_AND_ACTIVATION.md) — определение activation.
- [docs/research/04-user-research-plan.md](04-user-research-plan.md) — план интервью.
- [docs/research/05-research-segmentation-queries.md](05-research-segmentation-queries.md) — сегментные запросы.

---

**Конец документа.** Готов к review владельцу. Следующий шаг — обсудить выбор варианта (A / B / C) и собрать гипотезы для тестирования.
