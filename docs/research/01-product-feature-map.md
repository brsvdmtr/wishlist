# 01 — WishBoard Product Feature Map

> **Дата:** 2026-05-19
> **Источники:** `docs/INDEX.md`, `docs/CURRENT_PRODUCT_STATE.md`, `docs/USER_FLOWS.md`, `docs/MONETIZATION.md`, `docs/ACCESS_MATRIX.md`, `docs/SETTINGS_AND_PRIVACY.md`, `docs/BACKEND_MAP.md`, `docs/FRONTEND_MAP.md`, `docs/ARCHITECTURE.md`, `docs/ANALYTICS_AND_GODMODE.md`, `docs/KNOWN_GAPS_AND_RISKS.md`, и прямая разведка кода (`apps/api/src/routes/*`, `apps/api/src/schedulers/*`, `apps/api/src/services/*`, `apps/bot/src/index.ts`, `apps/web/app/miniapp/MiniApp.tsx`, `apps/web/app/admin/*`, `packages/db/prisma/schema.prisma`).
> **Статус:** research-only — никакой код не менялся.

---

## 1. Краткое резюме

**WishBoard** — Telegram Mini App для вишлистов. Владелец создаёт wishlist, делится ссылкой через `t.me/{bot}?startapp=share_<token>`, друзья бронируют подарки в *режиме сюрприза* (имя бронирующего никогда не видно владельцу). Оплата — Telegram Stars.

### Размер продукта (по факту, май 2026)

| Метрика | Значение | Источник |
|---|---|---|
| Prisma models | **74** | `wc` по `schema.prisma` |
| Prisma enums | **36** | grep `^enum ` |
| Экраны Mini App | **59** | `Screen` union в `MiniApp.tsx` |
| API route-модули | **25** в `routes/` | Explore по `apps/api/src/routes/` |
| `/tg/*` POST/PATCH/DELETE handlers | ~165 (через `protectTgRoute`) | docs/BACKEND_MAP § 1 |
| Schedulers | **9** модулей | `apps/api/src/schedulers/` |
| Services | **16** модулей | `apps/api/src/services/` |
| `MiniApp.tsx` | ~16 663 LOC, 1 компонент, ~300 `useState` | docs/ARCHITECTURE § 4 |
| `apps/api/src/index.ts` | 1 789 LOC, composition-root (0 inline handlers) | docs/BACKEND_MAP § 1 |
| Bot (`apps/bot/src/index.ts`) | ~1 190 LOC, Telegraf | docs/ARCHITECTURE § 4 |
| Локали | 6: `ru en zh-CN hi es ar` (Arabic — RTL) | docs/FRONTEND_MAP § 8 |
| Add-on SKU | **14** | docs/CURRENT_PRODUCT_STATE |
| Pro-тарифы | Monthly 100 ⭐ · Yearly 800 ⭐ · Lifetime 2 490 ⭐ | docs/MONETIZATION § 1 |

### Карта подсистем верхнего уровня

```
┌─────────────────── Core loop ───────────────────┐    ┌── Monetization ──┐
│ Wishlists · Items · Categories · Reservations   │    │ Subscription Pro │
│ Comments · Subscriptions (на чужой вишлист)     │    │ Add-on SKU × 14  │
│ Sharing (share-token / curated selections)      │    │ Promo (WISHPRO)  │
└─────────────────────────────────────────────────┘    │ Credits (hint/   │
                                                       │  import)         │
┌─────────── Profile / Identity ───────────┐           │ Lifetime + auto- │
│ User · UserProfile · displayName · bio   │           │  renew protect.  │
│ Avatar · Birthday · DefaultCurrency      │           └──────────────────┘
│ Public profile / Showcase (PRO)          │
│ Profile subscriptions (PRO)              │           ┌── Engagement ───┐
└──────────────────────────────────────────┘           │ Lifecycle DM /  │
                                                       │   winback (S1-4)│
┌──────── Calendar / Reminders ────────────┐           │ Pro renewal DM  │
│ Events Calendar v2.1 · Holidays import   │           │ Birthday reminders│
│ Friend-birthdays import · Per-occasion   │           │ Subscription    │
│   reminders · Year-recap · Inbox         │           │   unread badges │
│ Gift Notes (occasions + ideas; 19 ⭐ или PRO) │       │ FloatingNav     │
│ Birthday Reminders (FREE + PRO advanced) │           └─────────────────┘
└──────────────────────────────────────────┘
                                                       ┌── Seasonal ─────┐
┌─────── Reservation extras ───────────────┐           │ Secret Santa    │
│ Smart Reservations (per-WL, 15 ⭐)        │           │   (~74 endpoints,│
│ Secret Reservations (24 ⭐)              │           │   Nov 15–Feb 15)│
│ Reservation PRO (50 ⭐ unlock, beta-gated)│           │   campaigns,    │
│   history · notes · reminders · purch.  │           │   draws, chat,  │
│ Group Gift (79 ⭐ unlock, скинуться)     │           │   polls, hints  │
└──────────────────────────────────────────┘           └─────────────────┘

┌─── Privacy / Access ───┐  ┌─── Admin / Internal ───┐  ┌── i18n / Locale ──┐
│ visibility (link_only  │  │ /admin (Basic Auth)    │  │ 6 локалей          │
│  / public_profile      │  │   — system-user CRUD   │  │ Manual override    │
│  / private) — PRO      │  │ /internal (BOT_TOKEN)  │  │ Multi-signal mar-  │
│ subscribePolicy        │  │ God Mode (whitelist+   │  │   ket bucket       │
│ commentPolicy          │  │   user.godMode)        │  │   detection (5-sig)│
│ Don't Gift (PRO)       │  │ /tg/admin/birthday-    │  │ RTL для ar         │
│ surprise mode core     │  │   reminders/metrics    │  │                    │
└────────────────────────┘  └────────────────────────┘  └────────────────────┘
```

### TL;DR оценка состояния

- **Core loop** (wishlists → items → share → reserve → notify) — **stable, production-grade**.
- **Monetization** — широкая (Sub × 3 SKU + 14 add-on + credits + promo + Lifetime) и **server-enforced**. Самая сильная сторона продукта.
- **Calendar / Birthday Reminders** — недавняя крупная инвестиция (W1–W80 редизайн + birthday-reminders движок). Активно дорабатывается.
- **Secret Santa** — масштабная сезонная подсистема (~74 endpoints, 18+ Prisma-моделей). Активна только Nov 15 – Feb 15.
- **Referral Program** — построено, но **выключено флагом** (`ReferralProgramConfig.enabled=false`).
- **Tags** — модель + admin-CRUD есть, **UI в Mini App отсутствует** — мёртвая фича для конечного пользователя.
- **Public web `/w/:slug`** — существует, но в docs помечено `NEEDS VERIFICATION if actively used`.
- **Reservation PRO** — beta-gated через `RESERVATION_PRO_BETA_IDS` (фокус-группа), хотя UI и API готовы.
- **Risk-ноты:** monolithic `MiniApp.tsx` (~16k LOC), 11+ in-memory `setInterval` cron'ов без distributed-lock, нет ни одного automated-теста (кроме `sort.test.ts` + узкие интеграционные).

---

## 2. Core User Journeys

Канонический список — `docs/USER_FLOWS.md` (36 flows). Группирую по бизнес-кластеру.

### 2.1 Acquisition & Activation
| # | Flow | Описание | Где живёт |
|---|---|---|---|
| F1 | `/start` → onboarding v2 | Многошаговый: try-import → catalog → create-wishlist → share | bot · `routes/onboarding.routes.ts` · screens `onboarding-*` |
| F2 | First-share prompt | После первой реальной wish — кнопка «расскажи друзьям» | `MiniApp.tsx` screen `first-share-prompt` |
| F3 | Promo redemption (`WISHPRO`) | Lifecycle-DM выдаёт код → юзер вводит в Settings → 30 дней PRO | `routes/promo.routes.ts` · `PromoCampaign` · `PromoRedemption` |

### 2.2 Owner: lifecycle вишлиста
| # | Flow | Описание |
|---|---|---|
| F4 | Create wishlist (name + emoji) | 402 при превышении лимита (FREE=2, PRO=10) |
| F5 | Add wish (manual) | title/url/price/photo/desc/priority |
| F6 | Add wish via URL import (PRO) | парсер 7 доменов → попадает в Drafts |
| F7 | Edit wish | PATCH partial, photo separate endpoint |
| F8 | Complete / soft-delete wish | 90-day TTL → purge cron |
| F9 | Archive / unarchive wishlist | `PATCH archivedAt` |
| F10 | Reorder wishlists + items | drag-to-reorder внутри priority-группы |
| F11 | Bulk operations | move / delete / archive / copy / hard-delete |
| F12 | Item placements (cross-wishlist) | одна wish может лежать в нескольких списках через `WishlistItemPlacement` |
| F13 | Categories (секции внутри списка) | create / rename / delete / move / reorder · collapsible для гостей |
| F14 | Don't Gift (Не дарить) | profile-level + per-wishlist 3 режима (PRO) |

### 2.3 Sharing & Guest
| # | Flow | Описание |
|---|---|---|
| F15 | Share by token | `POST /tg/wishlists/:id/share-token` → idempotent · открывается через `startapp=share_<token>` |
| F16 | Curated Selection (часть вишлиста) | PRO — поделиться выборкой wishes отдельным временным linkом |
| F17 | Public profile | `profile_<username>` deep link · viewing другого юзера |
| F18 | Guest view | гость видит позиции в *surprise mode* — счётчик броней, имена скрыты |
| F19 | Owner-as-guest detection | если открыл свой share-link, silent switch на owner view |
| F20 | Reserve / unreserve / purchase | actorHash = SHA-256(`tg_actor:<tgId>`); timing-safe compare на unreserve |
| F21 | Subscribe to wishlist (PRO) | FREE=2, PRO=5 · уведомления при изменении |
| F22 | Profile subscriptions (PRO) | подписка на чужой профиль/showcase |
| F23 | Link management | список активных share-link + counters + revoke |

### 2.4 Социальные расширения
| # | Flow | Описание |
|---|---|---|
| F24 | Comments на reserved item | PRO у любой стороны (OR-логика); 30-секунд debounce уведомлений |
| F25 | Hints (намёки) | PRO · 72-часовой Hint record · бот доставляет через `users_shared` |
| F26 | Showcase (PRO) | премиум публичный профиль: cover + bio + pinned wishlists + размеры одежды/обуви/брендов |
| F27 | Group Gift (Совместный подарок) | 79 ⭐ unlock · target amount + deadline + участники + чат |
| F28 | Birthday reminders | FREE: 14d + day-of friends, 30d owner self · PRO: + 7d/1d friends, 14d/7d owner, audience EXTENDED, primary wishlist, кастомное сообщение |

### 2.5 Reservation Pro layer
| # | Flow | Описание |
|---|---|---|
| F29 | Reservation history | active=false brons (beta-gate `RESERVATION_PRO_BETA_IDS`) |
| F30 | Reservation notes / purchased flag / reminder | приватная заметка (500 chars), cron'овые напоминания |
| F31 | Smart Reservations (per-WL, 15 ⭐) | TTL + auto-release + extensions · 5-min `reservations.ts` cron |
| F32 | Secret Reservations (24 ⭐) | бронь, в которой даже owner не видит факта брони от *этого* гостя |

### 2.6 Calendar & Gift Planning
| # | Flow | Описание |
|---|---|---|
| F33 | Events Calendar v2.1 | свой календарь: birthdays + anniversaries + holidays · per-occasion reminder · 4-step onboarding |
| F34 | Holiday import | per-country master list, dedup `(ownerUserId, holidayKey)` |
| F35 | Friend-birthday import | `linkedUserId` cascade SetNull |
| F36 | Gift Notes (occasions + ideas) | personal idea notebook · 19 ⭐ unlock или PRO · recurrence yearly/monthly · deep link `occasion_<id>` |

### 2.7 Settings, Privacy, Account
| # | Flow | Описание |
|---|---|---|
| F37 | Notification settings | 4 toggles (comments / reservations / subscriptions / marketing) — **все PRO-gated с silent ignore для FREE** |
| F38 | Wishlist privacy | `visibility` (link_only / public_profile / private), `allowSubscriptions`, `commentPolicy` — три PRO 403 |
| F39 | Profile privacy | `profileVisibility` ALL/LINK_ONLY/SUBSCRIBERS/NOBODY · `subscribePolicy` |
| F40 | Language settings | `languageMode` auto/manual + `manualLanguage` · `resolveEffectiveLocale()` |
| F41 | Appearance (PRO) | theme dark/black · accent violet/blue/pink/green (FREE locked to dark + violet) |
| F42 | Card display mode (PRO) | auto / showcase / compact (FREE всегда auto) |
| F43 | Delete account | hard delete с cascade |

### 2.8 Billing
| # | Flow | Описание |
|---|---|---|
| F44 | Pro purchase (monthly / yearly / lifetime) | Telegram Stars invoice → bot `successful_payment` → `Subscription` upsert |
| F45 | Cancel renewal | soft-cancel (`cancelAtPeriodEnd=true`) + anti-churn sheet с 9 фичами (wishlists, items, participants, comments, url, hints, subs, privacy, calendar) |
| F46 | Reactivate | clear `cancelAtPeriodEnd` |
| F47 | Lifetime override protection | если после lifetime прилетает `pro_monthly` — пишется `payment_success_post_lifetime`, lifetime row не перетирается |
| F48 | Add-on checkout (14 SKU) | invoice + sync · permanent / consumable / cosmetic типы |
| F49 | Gift Notes / Group Gift / Secret Res / Smart Res checkout | отдельные `*/checkout` endpoints, бизнес-смысл — тот же add-on |

### 2.9 Secret Santa (seasonal, Nov 15 – Feb 15)
| # | Flow | Описание |
|---|---|---|
| F50 | Create / join / leave campaign | invite token, CLASSIC или MULTI_WAVE |
| F51 | Exclusions + draw | constraint-respecting random, Hamiltonian cycle check |
| F52 | Assignment + gift status | 9-state machine PENDING → … → RECEIVED + ORPHANED |
| F53 | Anonymous campaign chat | participant aliases (adjective + animal + emoji), per-round seed |
| F54 | Polls | optional anonymity + deadlines |
| F55 | Hint requests | 48h TTL, ID giver/receiver не утекает |
| F56 | Exit requests | требуют approval организатора |
| F57 | Notifications (16 типов с dedup-keys) | через бот DM |
| F58 | Seasonal broadcasts | Nov 1 PROMO + Feb 1 CLOSING_SOON, защита от дубля |

### 2.10 Support
| # | Flow | Описание |
|---|---|---|
| F59 | Support ticket | ForceReply bridge: юзер → бот → `SUPPORT_CHAT_ID` группа → bot → юзер. Ticket id `SUP-NNNN` |

### 2.11 Lifecycle / Degradation (системные)
| # | Flow | Описание |
|---|---|---|
| F60 | Winback (S1–S4) | hourly cron · DM с promo · cooldown 60d/promo · 72h между DM · 5 marketing/45d |
| F61 | Degradation cycle | PRO expired → GRACE 14d → ARCHIVED → PURGED at 90d |
| F62 | Auto-restore on regain | если вернул PRO до purge — archived data восстанавливается |
| F63 | Maintenance recovery DM | `MaintenanceIncident`/`Exposure` модели → DM «всё работает, открой бот» |
| F64 | Pro renewal reminders | 7d / 1d · только для yearly + cancelled monthly · lifetime исключён explicit фильтром |

---

## 3. Feature Inventory

Колонки: **Frontend** (экран/компонент в `MiniApp.tsx` или web/admin), **Backend** (route module + endpoint), **Prisma** (ключевые модели), **Bot** (handler/scheduler), **Plan** (FREE/PRO/Lifetime/Add-on/Credits/Beta).

### 3.1 Wishlists & Items

| Feature | Frontend | Backend | Prisma | Bot | Plan |
|---|---|---|---|---|---|
| Wishlist CRUD | screens `my-wishlists` / `wishlist-detail` | `routes/wishlists.routes.ts` (32 handlers) — `POST/GET /tg/wishlists`, `PATCH/DELETE /tg/wishlists/:id`, `archive`/`unarchive`/`reorder`/`share-token`/`transfer-items` | `Wishlist`, `WishlistSettings` | — | FREE 2 · PRO 10 · add-on `extra_wishlist_slot` (39 ⭐) до cap FREE 3/PRO 5 |
| Wishlist Emoji | inline picker в create/edit form | `wishlists.routes.ts` PATCH | `Wishlist.emoji` | — | FREE |
| Item CRUD | `item-detail`, edit form | `routes/items.routes.ts` (23 handlers) — `POST/GET/PATCH/DELETE /tg/items[/:id]`, `complete`/`restore`/`move`/`copy`/`reorder`/`photo` | `Item`, `WishlistItemPlacement` | — | FREE 20/list · PRO 70/list · add-on `extra_items_5` (19 ⭐) / `extra_items_15` (39 ⭐) per-WL |
| Bulk item ops | bulk-select bottom bar | `items.routes.ts` `*/items/bulk-*` (6 verbs) | `Item.status` updates | — | все |
| Item photo (Sharp pipeline) | upload + thumb 480 / full 1600 | `routes/items.routes.ts` `POST/DELETE /tg/items/:id/photo` + `uploads/` middleware | `Item.imageUrl` + local file | — | все |
| Wishlist Categories | collapsible sections; long-press menu | `wishlists.routes.ts` category CRUD | `WishlistCategory` + Item.categoryId | — | все |
| Drafts (SYSTEM_DRAFTS) | screen `drafts` | автоматически создаётся через `getOrCreateDraftsWishlist` | `Wishlist.kind='SYSTEM_DRAFTS'` | — | 50 items cap |
| Archive view | screen `archive` | `GET /tg/archive` + `GET /tg/wishlists/:id/archive` | `Item.status=DELETED/COMPLETED/ARCHIVED` + `purgeAfter=+90d` | `schedulers/cleanup.ts` 60-min purge | все |
| Sort + filter (guest view) | `guest-view` segmented control | client-side (sort.ts тестируется) | — | — | `recommended` client-only PRO |
| Item placements (cross-WL) | UI работает прозрачно | `placements/` helpers | `WishlistItemPlacement` junction | — | все |

### 3.2 Sharing, Reservation, Subscriptions

| Feature | Frontend | Backend | Prisma | Bot | Plan |
|---|---|---|---|---|---|
| Share-token link | screen `share` + share sheet | `POST /tg/wishlists/:id/share-token` (idempotent) + `GET /public/share/:token` | `Wishlist.shareToken` (12-char) | bot processes `share_<token>` startapp | все |
| Public wishlist API | screen `guest-view` | `routes/public.routes.ts` — `GET /public/wishlists/:slug[/items]`, `POST /public/items/:id/{reserve,unreserve,purchase}` rate-limited 120/min reads, 30/15min writes | `Wishlist`, `Item`, `ReservationEvent` | bot relays `share_*` deep links | все |
| Public web page `/w/:slug` (SSR) | `apps/web/app/w/[slug]/page.tsx` + `WishlistClient.tsx` + `error.tsx` + `not-found.tsx` | same `/public/*` API | — | — | все — **usage uncertain — см. Risk #21** |
| Curated Selections (часть вишлиста) | screen `curated-view` + `guest-link-expired` | `routes/selections-archive.routes.ts` (8 handlers) | `CuratedSelection`, `CuratedSelectionItem`, `CuratedSelectionSubscriber` | — | PRO |
| Link management | screen `link-management` | `GET /tg/me/active-links` | aggregates share-tokens + curated | — | все |
| Reserve / unreserve (TG) | `guest-item-detail` | `routes/items.routes.ts` `POST /tg/items/:id/{reserve,unreserve}` | `ReservationEvent`, `Item.reserverUserId` | sends "X reserved Y" DM owner | FREE 5 participants · PRO 20 |
| Reserve / unreserve (public web) | `WishlistClient.tsx` | `public.routes.ts` `/public/items/:id/{reserve,unreserve,purchase}` | actorHash в localStorage | — | все |
| Surprise mode (анонимность бронирующих от owner) | hard rule в API responses | owner-view endpoints не возвращают reserver-IDs | — | DM owner с `displayName` only | core |
| Subscriptions (на чужой WL) | toggle на `guest-view` | `wishlists.routes.ts` `POST /tg/wishlists/:id/subscribe`, DELETE, `routes/me.routes.ts` `/tg/me/subscriptions[/meta]` | `WishlistSubscription`, `SubscriptionUnread` | DM при добавлении/изменении item | FREE 2 · PRO 5 · add-on `extra_subscription_slot` (25 ⭐) max 3 |
| Profile subscriptions | screen `public-profile` | `routes/profiles.routes.ts` (3 handlers) | `ProfileSubscription` | — | PRO |
| Showcase | screens `showcase-editor` + `showcase-preview` | `me.routes.ts` `/tg/me/showcase` | `UserShowcase` + sizes/measurements/brands | — | PRO |
| Public profile page | screen `public-profile` | `profiles.routes.ts` `GET /public/profiles/:username` | `User` + `UserProfile` | — | все (respects `profileVisibility`) |
| Change badges / unread | в home tabs + per-item | `me.routes.ts` `/tg/me/subscriptions/meta`, `mark-read` | `SubscriptionUnread` + comment read-cursor | — | все |

### 3.3 Comments & Hints

| Feature | Frontend | Backend | Prisma | Bot | Plan |
|---|---|---|---|---|---|
| Comments (read/write) | inline на item-detail / guest-item-detail | `routes/comments.routes.ts` (6 handlers) — POST/GET/DELETE comments + mark-read | `Comment`, `parentCommentId` (1-level threads), `CommentReadCursor` | DM other party (30-s debounce) | PRO у *одной из сторон* (OR-logic) |
| commentPolicy `SUBSCRIBERS` | wishlist settings | enforced on POST | `Wishlist.commentPolicy` | — | PRO (silent enforcement) |
| Hints (anonymous nudge) | "Hint" button на own item | `routes/hints.routes.ts` (2 handlers) + bot `users_shared` flow | `Hint` (72h TTL, status SENT/DELIVERED/CANCELLED) | bot delivers DM с web_app button + retry 3×5s on network fail | PRO · add-on credits `hints_pack_5/10` (29/49 ⭐) |
| Hint kill on item state change | — | `cancelItemHints(itemId)` helper | sets status CANCELLED | — | — |

### 3.4 Reservation Pro layer

| Feature | Frontend | Backend | Prisma | Bot | Plan |
|---|---|---|---|---|---|
| Reservation history | `my-reservations` History tab | `routes/reservations.routes.ts` `GET /tg/reservations/history` (`hasReservationPro()` 403) | `ReservationEvent.endedAt/endReason` | — | **Beta-gated** via `RESERVATION_PRO_BETA_IDS` env (default `'8747175307'`); SKU `reservation_pro_unlock` 50 ⭐ |
| Private notes / purchased flag / reminder | inline cards | `reservations.routes.ts` `PATCH /tg/reservations/:itemId/meta`, `POST/DELETE .../reminder` | `ReservationMeta` (note ≤ 500 chars) | `schedulers/reservations.ts` 15-min cron sends DM | beta |
| Filters & sort (Active/History/All/Gifted/…) | client tabs + chips | client uses `reservationPro` flag | — | — | beta |
| Smart Reservations (per-WL TTL) | per-list settings | `reservations.routes.ts` smart-res endpoints + `services/wishlists.ts` | `WishlistSettings.smartResTtlHours/maxExtensions/allowExtend` | `schedulers/reservations.ts` 5-min auto-release + 15-min reminder | add-on `smart_reservations_unlock` 15 ⭐ per-WL |
| Secret Reservations | screens `secret-reservation-detail` + `secret-reservation-paywall` | own endpoints (audit показывает в `me`/`reservations`) | `SecretReservation` | — | add-on `secret_reservation_unlock` 24 ⭐ |

### 3.5 Calendar / Birthday / Gift Planning

| Feature | Frontend | Backend | Prisma | Bot | Plan |
|---|---|---|---|---|---|
| Events Calendar v2.1 | screen `calendar` (полный feature) | `services/calendar.ts` + `/tg/calendar/*` routes | `CalendarEvent`, `CalendarInboxEntry`, `CalendarHolidayMaster`, etc. | — | core (FREE) |
| Holiday import | inside calendar | bulk insert per country | `CalendarHolidayMaster` + `(ownerUserId, holidayKey)` dedup | — | FREE |
| Friend-birthday import | calendar | linked via `linkedUserId` (cascade SetNull) | `CalendarEvent.linkedUserId` | — | FREE |
| Calendar onboarding (4 шага, server-persisted) | inside `calendar` | persists via `User.calendarOnboardingSeenAt` | `User` | — | FREE |
| Year-recap (completed events + `actualGiftText`/`thankYouNote`) | inside `calendar` | calendar API | `CalendarEvent.actualGiftText/thankYouNote` | — | FREE |
| Today-context banner | home / calendar | server flag | — | — | FREE |
| Gift Notes — occasions | screens `gift-notes`, `gift-notes-occasion` | `routes/gift-notes.routes.ts` (29 handlers) | `GiftOccasion` (BIRTHDAY/ANNIVERSARY/HOLIDAY/OTHER, recurrence NONE/YEARLY/MONTHLY) | — | PRO **или** add-on `gift_notes_unlock` 19 ⭐ |
| Gift Notes — ideas | inside occasion screen | `gift-notes.routes.ts` ideas CRUD + reorder | `GiftOccasionIdea` (text/link/price/photo/note) | — | same |
| Gift Notes onboarding (demo-first 4-step) | screen `gift-notes-onboarding` | inside gift-notes router | — | — | FREE entry |
| Gift Notes paywall | screen `gift-notes-paywall` | `POST /tg/billing/gift-notes/checkout` | — | invoice flow | — |
| Birthday Reminders (FREE: 14d + day-of friends, 30d owner self) | Settings → 🎂 День рождения | `routes/birthday-reminders.routes.ts` (5 handlers) + `services/birthday-reminders.ts` | `BirthdayReminderDelivery`, `BirthdayReminderMute`, 8 new `UserProfile.birthday*` fields | `schedulers/birthday-reminders.ts` (60-min + 30s startup kick, MSK 9–22, kill `BIRTHDAY_REMINDERS_ENABLED`) | FREE |
| Birthday Reminders advanced (audience EXTENDED + primary WL + custom message + 7d/1d/14d/7d windows) | Settings | `PATCH /tg/me/birthday-settings` → 402 `birthday_reminders_advanced` для FREE | same | same scheduler с pro-aware logic | PRO |
| Birthday post-save opt-in sheet | after profile edit | inline UI | analytics `birthday.optin_*` | — | FREE |
| Birthday metrics dashboard (god-mode) | hidden tab в Settings | `GET /tg/admin/birthday-reminders/metrics` (god-only) | aggregates above | — | god-mode |
| Mute by recipient (`🔕` button in DM) | Settings → Birthday → Muted list | `routes/birthday-reminders.routes.ts` mute endpoints | `BirthdayReminderMute` | bot callback `bdm:<id>` | FREE |
| `notifyBirthdays` opt-out (incoming) | Settings | `me.routes.ts` PATCH | `UserProfile.notifyBirthdays` | — | FREE |

### 3.6 Group Gift & Secret Reservations

| Feature | Frontend | Backend | Prisma | Bot | Plan |
|---|---|---|---|---|---|
| Group Gift (Совместный подарок) | screens `group-gift-create`, `-detail`, `-join`, `-chat`, `-paywall` | `routes/group-gifts.routes.ts` (14 handlers) | `GroupGift`, `GroupGiftParticipation`, `GroupGiftChatMessage` | DM «X joined», complete/cancel notify | add-on `group_gift_unlock` 79 ⭐ (не входит в PRO) |
| Secret Reservation | screens `secret-reservation-detail/-paywall` | inside reservations | `SecretReservation` | — | add-on 24 ⭐ |

### 3.7 Secret Santa (seasonal subsystem)

| Feature | Frontend | Backend | Prisma | Bot | Plan |
|---|---|---|---|---|---|
| Status / season gate | feature-flag check | `routes/santa.routes.ts` `GET /tg/santa/status`, `services/santa-season.ts` | `SantaGlobalConfig`, `SantaSeasonConfig`, `SantaSeasonalBroadcastLog` | `schedulers/santa.ts` 60-min × 4 + startup jobs | seasonal Nov 15–Feb 15 |
| Campaigns | screens `santa-hub`, `santa-create`, `santa-campaign` | `santa.routes.ts` (~74 handlers) CRUD + draw + redraw + cancel + complete | `SantaCampaign` (CLASSIC/MULTI_WAVE), `SantaParticipant`, `SantaRound`, `SantaAssignment`, `SantaExclusion`, `SantaExitRequest` | seasonal broadcast Nov 1 / Feb 1 | core seasonal |
| Join / leave / remove | `santa-join` | santa.routes.ts | — | — | core seasonal |
| Anonymous chat | screen `santa-chat` | santa.routes.ts chat | `SantaChatMessage`, `SantaChatReadCursor`, `SantaChatMute`, `SantaParticipantAlias` | — | core seasonal |
| Polls | screen `santa-polls` | santa.routes.ts polls | `SantaPoll`, `SantaPollVote` | — | core seasonal |
| Exclusions | screen `santa-exclusions` | santa.routes.ts | `SantaExclusion` | — | core seasonal |
| Anonymous Hint Request | inside campaign | hint-request endpoints | `SantaHintRequest` (48h TTL) | bot delivers | core seasonal |
| Organizer dashboard + audit | `santa-organizer` | santa.routes.ts | `SantaAdminAuditLog` (immutable) | — | core seasonal |
| Notifications | inside campaign | `SantaNotification` (16 типов с `dedupeKey`) | — | bot DMs | core seasonal |
| Receiver wishlist view | `santa-receiver-wishlist` | santa.routes.ts | — | — | core seasonal |
| Item reservation (santa-specific) | inside campaign | — | `SantaItemReservation` | — | core seasonal |

### 3.8 Privacy & Settings

| Feature | Frontend | Backend | Prisma | Bot | Plan |
|---|---|---|---|---|---|
| Profile editing | screen `profile` | `me.routes.ts` `GET/PATCH /tg/me/profile` + avatar | `User`, `UserProfile` | — | все |
| Avatar upload | inline | `POST/DELETE /tg/me/profile/avatar` 512 px q80 | `UserProfile.avatarUrl` | — | все |
| 4 notification toggles (comments/reservations/subscriptions/marketing) | Settings | `GET/PATCH /tg/me/settings` | `UserProfile.notify*` | — | **все 4 PRO-only, silent ignore для FREE** |
| Wishlist visibility (link_only / public_profile / private) | wishlist settings sheet | `PATCH /tg/wishlists/:id` | `Wishlist.visibility` | — | PRO 403 для public_profile/private |
| Wishlist commentPolicy (ALL / SUBSCRIBERS) | same | same | `Wishlist.commentPolicy` | — | PRO 403 для SUBSCRIBERS |
| Wishlist allowSubscriptions (ALL / NOBODY) | same | same | `Wishlist.allowSubscriptions` | — | PRO 403 для NOBODY |
| profileVisibility (ALL / LINK_ONLY / SUBSCRIBERS / NOBODY) | Settings | `me.routes.ts` | `UserProfile.profileVisibility` | — | все |
| subscribePolicy (ALL / LINK_ONLY / APPROVED / NOBODY) | Settings | same | `UserProfile.subscribePolicy` | — | **`APPROVED` reserved for future use** (не используется) |
| commentsEnabled (profile-level off-switch) | same | same | `UserProfile.commentsEnabled` | — | PRO (silent ignore) |
| hintsEnabled | same | same | `UserProfile.hintsEnabled` | — | FREE |
| cardDisplayMode (auto/showcase/compact) | same | same | `UserProfile.cardDisplayMode` | — | PRO (FREE forced to `auto`) |
| newWishlistPosition (top/bottom) | same | same | `UserProfile.newWishlistPosition` | — | PRO для `bottom`; FREE forced top (silent) |
| Don't Gift (profile-level + per-wishlist 3 modes) | Settings + per-WL settings | dedicated endpoints | `UserProfile.dontGift*` + `Wishlist.dontGiftMode` | — | PRO |
| Appearance (theme / accent) | Settings | served via `GET /tg/me/plan.appearance` | `User.themePreference` `accentPreference` | — | PRO для black/blue/pink/green |
| Language settings (auto/manual) | Settings | `me.routes.ts` | `UserProfile.languageMode/manualLanguage` | — | все |
| Default currency (RUB/USD/EUR/GBP) | Settings | same | `UserProfile.defaultCurrency` | — | все (no FX conversion implemented) |
| Delete account | Settings | `DELETE /tg/me/account` (cascade) | — | — | все |

### 3.9 Monetization (overview — детали в §4)

| Feature | Frontend | Backend | Prisma | Bot | Plan |
|---|---|---|---|---|---|
| `GET /tg/me/plan` | везде через `useEffect` | `routes/me.routes.ts` | aggregates | — | все |
| Pro paywall (`ProUpsellSheet` with 9 контекстов) | inline везде | — | — | — | — |
| Pro Monthly / Yearly / Lifetime tile (2+1 layout) | в каждом paywall sheet | — | — | — | — |
| Pro checkout | invoice via `Telegram.WebApp.openInvoice` | `routes/billing.routes.ts` `POST /tg/billing/pro/checkout` (`plan` monthly/yearly/lifetime) | `Subscription`, `PaymentEvent` | bot `pre_checkout_query` + `successful_payment` | — |
| Sync | poll | `POST /tg/billing/pro/sync` | — | — | — |
| Cancel (soft) + anti-churn sheet | Settings | `POST /tg/billing/subscription/cancel` (409 `lifetime_cannot_cancel`) | `Subscription.cancelAtPeriodEnd` | — | — |
| Reactivate | Settings | `POST /tg/billing/subscription/reactivate` | — | — | — |
| Renewal reminders | bot DM | `schedulers/pro-renewal.ts` 60-min, 7d / 1d milestones, lifetime exclude | `PaymentEvent` synthetic idempotency | DM `bot_pro_renewal_7d/1d` | — |
| Lifetime downgrade-protection | static info note Settings | bot transactional logic | `PaymentEvent.eventType='payment_success_post_lifetime'` | — | — |
| Add-on store (14 SKU) | inline в `ProUpsellSheet` | `POST /tg/billing/addon/checkout` + `/sync` + `GET /tg/billing/addon/status` | `UserAddOn`, `UserCredits`, `Purchase`, `PaymentEvent` | bot `successful_payment` routing | per SKU |
| Promo codes (WISHPRO etc.) | input в Settings | `routes/promo.routes.ts` (2 handlers) — `POST /tg/promo/apply`, `GET /tg/promo/check` rate 5/60s | `PromoCampaign`, `PromoRedemption` (ACTIVE/EXPIRED/ACCEPTED_FOR_PAID/REVOKED) | lifecycle scheduler выдаёт коды | — |
| Lifecycle / winback (S1–S4) | invisible | `schedulers/lifecycle.ts` 60-min · `services/lifecycle.ts` | `LifecycleTouch`, `DegradationState` (NONE/GRACE_PERIOD/ARCHIVED/PURGED) | DM с web_app button | — |
| Billing expiry sweep + degradation | invisible | `schedulers/billing.ts` 60-min (4 jobs) | `Subscription.status`, degradation phases | — | — |
| Payment history | Settings | `GET /tg/billing/history` last 20 | `PaymentEvent` | — | все |

### 3.10 Onboarding & Activation

| Feature | Frontend | Backend | Prisma | Bot | Plan |
|---|---|---|---|---|---|
| Onboarding v2 (default) | 10 screens `onboarding-*` | `routes/onboarding.routes.ts` (9 handlers): status, start, complete, dismiss, try-import (rate 3/min, **no PRO gate**), catalog, catalog/select, trigger | `UserOnboardingState`, `User.onboardingCheckedRef`-like flags | `/start` registers menu button | FREE |
| Market segment catalog (ru / global) | inside `onboarding-catalog` | `getCatalogForSegment(segment)` in `packages/shared` | — | — | FREE |
| Multi-signal market bucket resolver (5-signal chain) | sends `X-Browser-Language` + `X-Browser-Timezone` headers | `services/locale-detection.ts` + `services/locale.ts` + `packages/db/locale-persistence` | `UserProfile.normalizedLocale`, `marketBucket`, `supportedImportRegion`, `User.lastName/username/isPremium` | bot `/start` upserts | FREE (kill switch `LOCALE_DETECTION_ENABLED`) |
| Onboarding v1 (deprecated) | flag-on path | — | `UserOnboardingState.variant='v1_demo'` | — | — |

### 3.11 Admin / Internal / God Mode

| Feature | Frontend | Backend | Prisma | Bot | Plan |
|---|---|---|---|---|---|
| Admin panel (system-user wishlist/item/tag CRUD) | `apps/web/app/admin/{page,new/page,[id]/page}.tsx` (3 экрана) protected by HTTP Basic Auth в `apps/web/middleware.ts` | `routes/admin.routes.ts` (26 handlers; ~10 god-only) `/wishlists`, `/items`, `/tags` под `X-ADMIN-KEY` | `User` (system), `Tag` | — | admin |
| Internal API (bot → API) | — | `routes/internal.routes.ts` (8 handlers, `X-INTERNAL-KEY=BOT_TOKEN`) — `POST /internal/import-url`, `GET /internal/support/lookup` + 6 more | — | bot consumer | internal |
| God Mode toggle | Settings | `routes/me.routes.ts` `POST /tg/me/god-mode` (whitelist `GOD_MODE_TELEGRAM_IDS` + flag `user.godMode`) | `User.godMode` | — | god |
| God stats dashboard | inside Settings, gated by `godMode && canGodMode` | `GET /tg/god-stats` — overview, funnel (7 шагов), engagement, proLimits24h, errors24h, onboarding+AB, localeSegments | `AnalyticsEvent` aggregates | — | god |
| Retention dashboards | same | `GET /tg/retention-stats`, `GET /tg/retention-recent` | `LifecycleTouch`, `PromoRedemption` | — | god |
| Locale segment analytics | same | `GET /tg/analytics/locale-segments` | `UserProfile.normalizedLocale/marketBucket` | — | god |
| Birthday reminders metrics | hidden Settings tab | `GET /tg/admin/birthday-reminders/metrics` | `BirthdayReminderDelivery`, `Mute`, `ServiceHeartbeat['birthday_reminders']` | — | god |
| Maintenance mode | `screen 'maintenance'` (when API 503 code=MAINTENANCE) | `routes/maintenance.routes.ts` (2 handlers) + middleware gate | `MaintenanceIncident`, `MaintenanceExposure` | — | env `MAINTENANCE_MODE` |
| Maintenance recovery DM | — | — | `MaintenanceExposure` driven | DM «всё работает» | — |
| Admin alerts (uncaughtException/unhandledRejection/watchdog) | — | `notifications/adminAlerts.ts` → `ADMIN_ALERT_CHAT_IDS` | — | DM в админ-чат | — |

### 3.12 Support

| Feature | Frontend | Backend | Prisma | Bot | Plan |
|---|---|---|---|---|---|
| Support contact | Settings «Contact support» | `routes/support.routes.ts` (2 handlers) `POST /tg/support/session`, `GET /tg/support/lookup` + internal lookup | `SupportSession`, `SupportTicket` (`SUP-NNNN`), `SupportMessage` | ForceReply bridge юзер ↔ `SUPPORT_CHAT_ID` | все |
| Support handoff polish | sends user's plan in bot DM | same | — | bot DM cleanup | все |
| User-side ticket history | **отсутствует** (см. Risk #39) | — | — | — | gap |

### 3.13 Auxiliary

| Feature | Frontend | Backend | Prisma | Bot | Plan |
|---|---|---|---|---|---|
| URL import (PRO) | inline в wishlist editor | `routes/import.routes.ts` (1 handler) + `services/url-import.ts` + `url-parser.ts` (~1 059 LOC, 7 domain adapters) + `browser-network-extractor.ts` (Puppeteer) | `Item.sourceUrl/sourceDomain/importMethod` | — | PRO **или** credit pack 10/25 (39/79 ⭐) |
| Marketplace parser kill switch | — | `MARKETPLACE_PARSER_DISABLED=1` routes к fallback | — | — | ops |
| In-memory parse cache | — | 1 000 entries / 24 h positive, 5-min negative | — | — | — |
| Analytics event logging | — | `routes/analytics.routes.ts` (1) + `routes/telemetry.routes.ts` (1) + `services/analytics.ts` | `AnalyticsEvent` (90-day retention via `ops/cleanup-analytics.mjs` cron) | — | — |
| FAQ | screen `faq` (50 Q × 15 sections) | static in i18n | — | — | все |
| Changelog | screen `changelog` | static | — | — | все |
| Legal v2.0 (effective 30.04.2026) | screens `legal`, `legal-doc` | static · 6 locales | — | — | все |
| First-share prompt | screen `first-share-prompt` | trigger after first real wish | — | — | FREE entry |
| FloatingNav (Instagram-style) | global bottom nav | from `@wishlist/ui` | — | — | UI |
| Wave 4 primitives + v2.1 UI refresh | везде | `packages/ui` + `packages/ui-tokens` | — | — | UI |
| Referral Program | screens `referral`, `referral-history` | `routes/referral.routes.ts` (4 handlers) + `services/referral-hooks.ts` + `schedulers/referral.ts` (15 min) | `ReferralProgramConfig`, `Referral*` | — | **DISABLED by default** (`enabled=false`) — см. Risk |
| Search | — | `routes/search.routes.ts` (2 handlers) + `services/search.ts` | — | — | unclear scope (not surfaced in FRONTEND_MAP) |
| ForeignWishlistAccess history | — | `services/foreign-wishlist-access.ts` | (presumed) `ForeignWishlistAccess` | — | tracking |

---

## 4. Monetization Mapping

Pricing source-of-truth: `apps/api/src/index.ts` constants `PLANS`, `ONE_TIME_SKUS`, `ADDON_CAPS` + env vars (`PRO_PRICE_XTR`, `PRO_YEARLY_PRICE_XTR`, `PRO_LIFETIME_PRICE_XTR`, `GIFT_NOTES_PRICE_XTR`).

### 4.1 Tier matrix

| Resource / feature | **FREE** | **PRO Monthly** | **PRO Yearly** | **PRO Lifetime** | **Add-on / Credit** |
|---|---|---|---|---|---|
| Wishlists | 2 (≤ 5 с add-on) | 10 (≤ 15 с add-on) | 10 (≤ 15) | 10 (≤ 15) | `extra_wishlist_slot` 39 ⭐ (cap FREE 3 / PRO 5) |
| Items / wishlist | 20 (≤ 50) | 70 (≤ 100) | 70 (≤ 100) | 70 (≤ 100) | `extra_items_5` 19 ⭐ ×3 или `extra_items_15` 39 ⭐ ×1 |
| Participants (distinct reservers) | 5 | 20 | 20 | 20 | — |
| Subscriptions | 2 (≤ 5) | 5 (≤ 8) | 5 (≤ 8) | 5 (≤ 8) | `extra_subscription_slot` 25 ⭐ ×3 |
| Comments (PRO у одной из сторон) | — | ✓ | ✓ | ✓ | — |
| URL import | — | ✓ | ✓ | ✓ | credits `import_pack_10` 39 ⭐ / `import_pack_25` 79 ⭐ |
| Hints (намёки) | — | ✓ | ✓ | ✓ | credits `hints_pack_5` 29 ⭐ / `hints_pack_10` 49 ⭐ |
| `visibility=PUBLIC_PROFILE` / `PRIVATE` | — (403) | ✓ | ✓ | ✓ | — |
| `allowSubscriptions=NOBODY` | — (403) | ✓ | ✓ | ✓ | — |
| `commentPolicy=SUBSCRIBERS` | — (403) | ✓ | ✓ | ✓ | — |
| 4 notification toggles | silent ignore | ✓ | ✓ | ✓ | — |
| Sort `recommended` (guest) | client-only upsell | ✓ | ✓ | ✓ | — |
| Showcase (PRO public profile) | — (403) | ✓ | ✓ | ✓ | — |
| Curated Selections | — (403) | ✓ | ✓ | ✓ | — |
| Profile Subscriptions (follow) | — (403) | ✓ | ✓ | ✓ | — |
| Appearance theme `black` + accents | dark+violet only | ✓ | ✓ | ✓ | — |
| `cardDisplayMode` showcase/compact | auto forced | ✓ | ✓ | ✓ | — |
| `newWishlistPosition=bottom` | silent ignore | ✓ | ✓ | ✓ | — |
| Don't Gift (профиль + per-WL) | — | ✓ | ✓ | ✓ | — |
| Gift Notes (occasions+ideas) | — | ✓ | ✓ | ✓ | `gift_notes_unlock` 19 ⭐ (одноразовый) |
| Group Gift create | **не входит в PRO** | — | — | — | `group_gift_unlock` 79 ⭐ |
| Secret Reservation create | **не входит в PRO** | — | — | — | `secret_reservation_unlock` 24 ⭐ |
| Smart Reservations per-WL | **не входит в PRO** | — | — | — | `smart_reservations_unlock` 15 ⭐ per WL |
| Reservation PRO (history/notes/reminders/purchased/filters) | — | beta-only | beta-only | beta-only | `reservation_pro_unlock` 50 ⭐ + `RESERVATION_PRO_BETA_IDS` env |
| Birthday Reminders core | ✓ (14d + day-of friends, 30d owner) | + 7d/1d friends + 14d/7d owner + EXTENDED audience + primary WL + custom msg | same | same | — |
| Seasonal decoration (wishlist) | — | — | — | — | `seasonal_decoration` 29 ⭐ per-WL |
| **Price** | 0 | 100 ⭐ / месяц | 800 ⭐ (365d одноразово, ~33% дисконт) | 2 490 ⭐ navсегда | per-SKU 15–79 ⭐ |

### 4.2 Лестница монетизации

```
   FREE
    │
    │── upsell (9 контекстов: comments, url_import, hints, wishlist_limit,
    │    item_limit, participant_limit, subscription_limit, sort_recommended,
    │    birthday_reminders_advanced) → 402 / 403
    │
    ├─→ Promo (WISHPRO etc.) — 30 дней Pro, ACCEPTED_FOR_PAID если уже PRO
    │
    ├─→ Add-on credits (impulse, low-friction): hints/import packs
    │
    ├─→ Add-on permanent (impulse / fallback): extra slots, gift_notes, group_gift,
    │   secret/smart reservation, reservation_pro, seasonal_decoration (14 SKU)
    │
    ├─→ Pro Monthly 100 ⭐ (auto-renew, soft cancel)
    │       │
    │       ├─→ Pro Yearly 800 ⭐ (one-time, ~33% off, ручное продление)
    │       │
    │       └─→ Pro Lifetime 2 490 ⭐ (one-time, навсегда, downgrade-protected)
    │
    └─→ Lifecycle DM scheduler (S1–S4) с promo offers, cooldown 60d/promo, 72h/DM
```

### 4.3 Server-side enforcement (важно)

Все лимиты и feature-gates **enforced server-side** в route handlers. Клиент только показывает upsell — bypass через custom client невозможен **кроме**:

- **Sort `recommended`** — client-only PRO check (Risk #30 в KNOWN_GAPS, low-severity, не рекламируется на paywall).

Контракты ошибок:
- **402** — числовой лимит (`wishlist_limit`, `item_limit`, `participant_limit`, `subscription_limit`) или feature-флаг (`comments`/`url_import`/`hints`/`birthday_reminders_advanced`).
- **403** — wishlist/profile PRO settings (`pro_required`).
- **409** — `lifetime_cannot_cancel` для cancel/reactivate на Lifetime.
- **429** — rate limit (import 10/min, promo 5/min, onboarding-import 3/min, public actions 30/15min) или anti-spam.

---

## 5. Risky / Unclear / Admin-only / Unused

### 5.1 Disabled / hidden by feature flag

| Item | Где | Состояние | Влияние |
|---|---|---|---|
| **Referral Program** | screens `referral`, `referral-history`; `routes/referral.routes.ts` (4 handlers); `services/referral-hooks.ts`; `schedulers/referral.ts` 15-min; Prisma `ReferralProgramConfig.enabled` | **выключено** (`enabled=false`, `inRollout`, `ui.entryPointPaywall` все false) | Полный subsystem существует, но UI и API недоступны. Решение: или включить (и принять risk recurrence-attribution edge cases), или явно retire. |
| **subscribePolicy = `APPROVED`** | `UserProfile.subscribePolicy` enum value | "reserved for future use" (docs/SETTINGS_AND_PRIVACY §4) | Enum валиден, но никакой логики approval не реализовано — выглядит как "забыли убрать". |
| **`AUTH_SECRET` env** | docker-compose | Определена, **не используется в коде** (Risk #12 в KNOWN_GAPS) | Мёртвая переменная, путает оператора. |
| **Marketplace parser kill switch** | `MARKETPLACE_PARSER_DISABLED=1` | Live feature flag, не отключено | Ops-инструмент, ок. |
| **Onboarding v1** | `UserOnboardingState.variant='v1_demo'` | Deprecated, не выдаётся новым юзерам | Старые users могут иметь записи; чистка не блокирующая. |

### 5.2 Beta-gated (focus-group only)

| Item | Где | Состояние |
|---|---|---|
| **Reservation PRO** layer | `hasReservationPro()` checks `RESERVATION_PRO_BETA_IDS` env (default `'8747175307'`) | UI (`my-reservations` PRO tab), API (`/tg/reservations/history`, `meta`, `reminder`), cron (`schedulers/reservations.ts` 15-min reminders), SKU (`reservation_pro_unlock` 50 ⭐) — **всё готово**. Покупка SKU не открывает доступ всем PRO юзерам — гейт по env. Несоответствие: на paywall фичи `plan_pro_f10..f14` рекламируются как PRO. |

### 5.3 Admin-only / God-mode-only surface

| Item | Где | Доступ |
|---|---|---|
| `/admin/{,new,[id]}` Next.js routes | `apps/web/app/admin/` | HTTP Basic Auth (`ADMIN_BASIC_USER/PASS`) + API `X-ADMIN-KEY` |
| `routes/admin.routes.ts` (26 handlers, ~10 god-only) | `apps/api/src/routes/` | `X-ADMIN-KEY` |
| `routes/internal.routes.ts` (8 handlers) | same | `X-INTERNAL-KEY` = `BOT_TOKEN` |
| God Mode toggle `/tg/me/god-mode` | bot/godMode flag | whitelist `GOD_MODE_TELEGRAM_IDS` |
| God stats `/tg/god-stats`, retention, locale segments | Settings UI gated by `canGodMode` | whitelist + flag |
| Birthday metrics `/tg/admin/birthday-reminders/metrics` | hidden tab | whitelist + flag |
| Admin alerts via `ADMIN_ALERT_CHAT_IDS` | `notifications/adminAlerts.ts` | bot DMs |

### 5.4 «Tags» — модель есть, UI нет (мёртвая фича для конечного пользователя)

- `Tag` модель в Prisma присутствует, `routes/admin.routes.ts` имеет CRUD endpoints (`/wishlists/:id/tags`, `/tags/:id`, `/items/:itemId/tags/:tagId`).
- Mini App не имеет UI для тегов: документировано в KNOWN_GAPS Risk #20.
- Поле `?tag=` фильтр существует в `GET /public/wishlists/:slug/items`, но никем не вызывается из официального клиента.
- **Признак dead code** на уровне UX.

### 5.5 «Coming soon» / частично доделанное

| Item | Где |
|---|---|
| Toast `toast_section_coming_soon` | `MiniApp.tsx:12793` (общий feature-unlock placeholder) |
| Sort button "expiring" → coming soon toast | `MiniApp.tsx:12843` (`sort_button_expiring`) |
| Settings rows с `comingSoonLabel` | `MiniApp.tsx:20774` |
| Birthday field placeholder когда не задан | `MiniApp.tsx:21011` (`settings_coming_soon`) |
| Currency conversion | docs INDEX §"NOT covered": Item supports RUB/USD/EUR/GBP, но **нет конверсии между ними** |
| "Reserved by me" visibility for other users | same |
| Custom archive/inbox display | same |

### 5.6 Public web page `/w/:slug` — usage uncertain

- `apps/web/app/w/[slug]/{page,WishlistClient,error,not-found}.tsx` — SSR-страница для гостей, открывающих shared link **вне** Telegram.
- KNOWN_GAPS Risk #21: «NEEDS VERIFICATION if actively used or if all traffic goes through Mini App».
- Telegram-first продукт (90+% трафика наверняка идёт через Mini App). Web fallback может быть валидной "обычной" share-точкой, но **не подтверждено по аналитике**. Если не используется — кандидат на удаление (упрощает infra и `apps/web` checks).

### 5.7 Architectural & operational risks (extract)

| # | Risk | Severity (по KNOWN_GAPS) |
|---|---|---|
| 33 | **No automated tests** (кроме `sort.test.ts` и узких интеграционных) | CRITICAL |
| 36 | Monolith `MiniApp.tsx` ~16 663 LOC, ~300 useState | HIGH |
| 37 | 11+ in-memory `setInterval` cron jobs без distributed locking — если когда-то добавят 2-й API instance, double-fire | MEDIUM |
| 28 | SSL auto-renewal **не настроен** на Vultr (cert до 2026-07-16, certbot не установлен) | HIGH (deadline) |
| 35 | Credits / billing без auto-reconciliation против Telegram Stars provider records | HIGH |
| 39 | Support — admin-only reply, нет user-facing ticket history/status | LOW |
| 40–42 | Secret Santa: token rotation, multi-wave consistency, admin tooling gaps | MEDIUM каждый |
| 13–15 | Photo cleanup on item soft-delete / wishlist hard-delete; `reserverUserId` not cleared on complete | LOW each |
| 31 | `commentPolicy=SUBSCRIBERS` — owner всегда может комментить (intentional, but undocumented) | LOW |

### 5.8 Несоответствия paywall ↔ enforcement (нюансы)

- **`plan_pro_f10..f14`** (Reservation history / notes / reminders / purchased / filters) рекламируются на paywall как PRO-фичи, но фактический gate — `hasReservationPro()` = beta whitelist **или** SKU `reservation_pro_unlock`. Юзер на чистом monthly PRO без SKU и без beta — попадёт на 403. **Это противоречит обещанию paywall.**
- **`sort: recommended`** — client-only PRO. Кастомный клиент обходит.
- **`birthday_reminders_advanced`** — единственный paywall context, который возвращает 402 из settings-патча (а не 403). Контракт явно отличается: `{ error: 'pro_required', feature, context: <field> }`.
- **Group Gift / Secret Reservation / Smart Reservations / Gift Notes** — не входят в PRO, всегда отдельные SKU. На paywall честно показано как add-on, но в Settings PRO-card не упоминаются.

---

## 6. Recommendations

> Группы предложений ниже даны **в исследовательских целях** — это не план изменений, а вопросы к продукту. Решения за тобой.

### 6.1 KEEP — оставить и инвестировать

| Feature | Почему |
|---|---|
| Core wishlist loop (wishlists / items / categories / share-token / reserve / surprise mode) | Это продукт. Бесспорно работает. |
| Pro Monthly + Yearly + **Lifetime** (с downgrade-protection) | Lifetime — самый недавний и удачный SKU (мае 2026), даёт price-anchoring и долгоживущих пользователей. |
| Add-on SKU model (14 SKU + credits) | Сильно дифференцированная монетизация, реальный fallback после отказа от PRO. |
| URL import (PRO) + 7 domain adapters + Sharp pipeline | Якорная PRO-фича для русского рынка (Ozon/WB/Yandex). Хорошо инкапсулирована (`url-parser.ts` ~1 059 LOC). |
| Birthday Reminders engine | Свежая инвестиция (8 новых полей, scheduler, dashboard, опт-ин). Двигатель retention в B2C-социалке. |
| Events Calendar v2.1 + Gift Notes | Расширяет use-case за пределы "одного дня рождения" → year-round планирование подарков. |
| Lifecycle / winback (S1–S4) | Документированный сегментированный механизм. WISHPRO как монетизированный hook. |
| Idempotency + rate limit + IP throttle Wave 1+2 | Закрывает весь `/tg/*` POST/PATCH/DELETE (~165 routes). Не трогать без сильной причины. |
| Composition-root architecture (`index.ts` 1 789 LOC, 25 routers, 9 schedulers, 16 services) | Закрытая P1–P5/P5r/P5s рефакторинг-волна. Новый код должен следовать этим правилам. |
| Multi-signal market bucket resolver (5-сигнал) | Закрыл "287/375 unknown" gap на god-mode dashboard. Аналитика сегментов теперь рабочая. |
| Surprise-mode invariant (owner никогда не видит reserver) | Core differentiator продукта. Не ломать. |

### 6.2 HIDE / RETIRE — спрятать или явно убрать

| Item | Предлагаемое действие | Причина |
|---|---|---|
| **Referral Program** (UI screens, routes, scheduler, ReferralProgramConfig) | Решить: или включить с честным rollout, или удалить subsystem полностью | Висящий мёртвый груз: 4 routes + scheduler + 2 screens + i18n + Prisma модели — все за флагом `enabled=false`. Поддерживать кодовую базу без бенефита. |
| **Tag CRUD** в admin router + `Tag` модель + `?tag` filter в public router | Удалить admin endpoints и `Tag` модель если не планируется UI; либо запланировать UI спринт | Risk #20: модель есть, юзер не видит. Технический долг. |
| **`subscribePolicy = APPROVED`** enum value | Удалить из enum (миграция) или реализовать approval flow | "Reserved for future use" уже год+. Зомби-state. |
| **Onboarding v1 deprecated path** | Удалить v1-only ветки в `routes/onboarding.routes.ts` и `MiniApp.tsx` | v2 — default, v1 — pure dead code. |
| **`AUTH_SECRET` env** | Удалить из docker-compose + .env.example | Не используется, путает оператора (Risk #12). |
| **Public web `/w/:slug`** | Подтвердить traffic в last 30d через `AnalyticsEvent` → если < N hits, удалить SSR route + WishlistClient | Risk #21 — usage uncertain, дополнительные SSR routes раздувают `apps/web`. |
| **"Coming soon" placeholders** (sort `expiring`, settings rows, birthday placeholder) | Решить per-item: ship или удалить | Если несколько релизов "coming soon" — пользователь учится игнорировать. |
| **Currency conversion** | Не делать как фичу, явно задокументировать «no conversion» в UI tooltip | docs INDEX §"NOT covered". Лучше явно сказать "цена в выбранной валюте, без пересчёта", чем оставлять ожидание. |

### 6.3 TEST — приоритеты для покрытия (Risk #33 — нет тестов)

| Сценарий | Класс теста | Почему критично |
|---|---|---|
| **Lifetime downgrade protection** (`pro_monthly` после lifetime → `payment_success_post_lifetime`, NOT overwrite) | integration + real Telegram payment fixture | Деньги, аудит, реальный edge-case |
| **Surprise mode** — owner GET item endpoints не возвращают reserver IDs / displayName | integration | Core privacy invariant |
| **PRO entitlement resolver** priority order (subscription > promo > god_mode > FREE) | unit с мок-Prisma | Один баг = всё ломается |
| **Effective entitlements** (base + add-ons + caps) | unit | 14 SKU × 2 plans × edge caps — много веток |
| **Idempotency-Key** middleware на критичных routes (billing, wishlist create, item create) | integration | Денежная критичность |
| **Soft-delete TTL** (90-day purge cron) | unit на pure-function helper, integration на cron | Без тестов orphans копятся (Risks #13–15) |
| **commentPolicy OR-logic** (PRO у одной стороны достаточно) | integration | Был баг такого класса в BUGFIX_LESSONS |
| **Birthday scheduler quiet hours** + audience EXTENDED PRO-aware logic | integration с фиктивным временем | Свежий subsystem, много веток |
| **Smart Reservations auto-release** (5-min cron, expires + TTL + extensions) | integration | Деньги/UX (release ↔ reminder) |
| **Hint delivery resilience** (3× retry, 30-min window) | integration | Был баг — см. BUGFIX_LESSONS 2026-05-03 |
| **subscribe gate order** (wishlist `allowSubscriptions` → owner `subscribePolicy`) | unit | Critical access control |
| **Race на `getOrCreateProfile`** под нагрузкой | integration с реальной PG | Recurrence известна (BUGFIX_LESSONS 2026-04-30) |

### 6.4 REMOVE / CLEAN UP — точечная санитария

| Item | Действие |
|---|---|
| Orphaned photo files on item soft-delete | Расширить `DELETE /tg/items/:id` → `deleteUploadFile(imageUrl)` (Risk #13) |
| Orphaned photo files on wishlist hard-delete | CASCADE-aware unlink (Risk #14) |
| `reserverUserId` не cleared on item complete/delete | Очистить в `services/items.ts` transition helpers (Risk #15) |
| 11+ in-memory cron jobs | Если идёт scale-out → внедрить Redis-based lock на scheduler-level (Risk #37). Сейчас single-instance — не блокирующее. |
| `setInterval` startup-replay (timers сбрасываются при рестарте) | Добавить "missed window" detection в каждом scheduler (особенно birthday-reminders уже имеет startup kick — копировать паттерн) |
| Logs — сейчас на host bind-mount `/opt/wishlist/logs/{api,bot}/` с pino-roll | Already done — не трогать |
| AUTH_SECRET env | Удалить (см. §6.2) |
| Docs/research/ — этот файл | Поддерживать как живой обзор; обновлять при крупных waves (Lifetime, Birthday Reminders v1, Calendar v2.1 уже были такими событиями) |

### 6.5 STRATEGIC questions (для тебя как продукт-овнера)

1. **Reservation PRO — раскрыть или спрятать?** Сейчас оплата SKU `reservation_pro_unlock` (50 ⭐) **не даёт доступ всем PRO** — нужен beta-whitelist. Это либо bug, либо нужно прятать SKU. Расхождение с paywall `plan_pro_f10..f14` обманывает Pro-юзера без SKU.
2. **Group Gift / Secret Reservation / Smart Reservations / Gift Notes** — почему **не входят в PRO**? У Lifetime-юзера за 2 490 ⭐ Gift Notes уже включён, но GroupGift всё равно нужно купить отдельно за 79 ⭐. Это сознательное "add-on tax" или артефакт roadmap'а? Стоит документировать решение в `DESIGN_DECISIONS.md`.
3. **Referral Program** — go/no-go. 4 routes, scheduler, 2 screens, конфиг-модель — не бесплатно поддерживать.
4. **Tags** — нужен ли в UI ever? Если нет — снять admin endpoints и модель.
5. **Public web `/w/:slug`** — измерить traffic, принять решение.
6. **Reservation PRO beta** — переход к `isPro` gate (фаза 2 уже упомянута в docs/MONETIZATION § Reservation PRO) — когда?

---

## 7. Quick reference

### 7.1 Где что лежит

| Что | Путь |
|---|---|
| `PLANS` / `ONE_TIME_SKUS` / `ADDON_CAPS` constants | `apps/api/src/index.ts` (search by name) |
| Entitlement resolver | `apps/api/src/services/entitlement.ts` |
| Locale detection | `apps/api/src/services/locale-detection.ts`, `locale.ts`, `packages/db/locale-persistence` |
| 25 route modules | `apps/api/src/routes/` |
| 9 schedulers | `apps/api/src/schedulers/` |
| 16 services | `apps/api/src/services/` |
| Security (idempotency / rate-limit / IP throttle) | `apps/api/src/security/` |
| Bot | `apps/bot/src/index.ts` |
| Mini App monolith | `apps/web/app/miniapp/MiniApp.tsx` (~16 663 LOC) |
| Public SSR wishlist | `apps/web/app/w/[slug]/{page,WishlistClient}.tsx` |
| Admin Next.js | `apps/web/app/admin/{page,new/page,[id]/page}.tsx` |
| i18n keys (6 locales) | `packages/shared/src/i18n.ts` |
| Prisma schema | `packages/db/prisma/schema.prisma` (2 205 LOC, 74 models, 36 enums) |
| Design system primitives | `packages/ui/` |
| Design tokens | `packages/ui-tokens/` |

### 7.2 Env kill switches (read-only inventory)

| Env | Эффект |
|---|---|
| `MAINTENANCE_MODE` | 503 на `/tg/*` + `/public/*` |
| `MARKETPLACE_PARSER_DISABLED` | URL import → fallback пути |
| `SECURITY_IDEMPOTENCY_ENABLED` | Wave-1+2 idempotency layer off |
| `SECURITY_RATE_LIMIT_ENABLED` | Rate limits off |
| `SECURITY_IP_THROTTLE_ENABLED` | IP throttle off |
| `BIRTHDAY_REMINDERS_ENABLED` | Birthday scheduler off |
| `LOCALE_DETECTION_ENABLED` | Multi-signal market-bucket resolver off |
| `GOD_MODE_TELEGRAM_IDS` | whitelist для god-mode toggle |
| `RESERVATION_PRO_BETA_IDS` | beta-gate для Reservation PRO (default `'8747175307'`) |
| `ADMIN_KEY`, `ADMIN_BASIC_USER/PASS` | admin auth |
| `BOT_TOKEN` | also serves as `X-INTERNAL-KEY` |
| `LOG_FILE_PATH_API/BOT` | pino-roll target; пустая строка — stdout only |

### 7.3 Pricing snapshot (источник: `apps/api/src/index.ts`)

```
PRO Monthly     100 ⭐  (auto-renew, soft cancel)
PRO Yearly      800 ⭐  (one-time, ~33% off)
PRO Lifetime  2 490 ⭐  (one-time, permanent)

Add-on SKUs (14):
extra_wishlist_slot       39 ⭐  permanent (cap FREE 3 / PRO 5)
extra_subscription_slot   25 ⭐  permanent (cap 3 any plan)
extra_items_5             19 ⭐  permanent per-WL (×3 max)
extra_items_15            39 ⭐  permanent per-WL (×1 max)
hints_pack_5              29 ⭐  consumable
hints_pack_10             49 ⭐  consumable
import_pack_10            39 ⭐  consumable
import_pack_25            79 ⭐  consumable
seasonal_decoration       29 ⭐  cosmetic per-WL
gift_notes_unlock         19 ⭐  permanent (или включено в PRO)
reservation_pro_unlock    50 ⭐  permanent (+ beta whitelist gate)
group_gift_unlock         79 ⭐  permanent (НЕ входит в PRO)
secret_reservation_unlock 24 ⭐  permanent (НЕ входит в PRO)
smart_reservations_unlock 15 ⭐  permanent per-WL (НЕ входит в PRO)
```

---

## 8. Открытые вопросы / follow-up research

1. **Реальное использование `/w/:slug`** — нужны метрики из `AnalyticsEvent` или nginx access logs за 30 дней.
2. **Сколько юзеров на Reservation PRO beta?** — `SELECT COUNT(*) FROM User WHERE telegramId IN <RESERVATION_PRO_BETA_IDS>` + сколько купили SKU `reservation_pro_unlock`.
3. **Distribution Pro Monthly / Yearly / Lifetime** — для понимания, насколько Lifetime каннибализирует Monthly.
4. **Coverage god-mode dashboard** vs. реальное использование — кто из whitelisted ID реально открывал god-stats последние 14 дней.
5. **`subscribePolicy=APPROVED` adopters** — есть ли вообще такие записи в БД? Если 0 — миграция-удаление безопасна.
6. **Tag adoption** — `SELECT COUNT(*) FROM Tag` и `SELECT COUNT(*) FROM (Item ↔ Tag)`.
7. **Onboarding v1 leftover** — сколько юзеров с `UserOnboardingState.variant='v1_demo'` сейчас в активной воронке.
8. **Add-on revenue split** — какие SKU реально продают (по `PaymentEvent`).

— Конец отчёта —
