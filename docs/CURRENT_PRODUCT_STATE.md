# Current Product State

Production feature inventory for the Wishlist Telegram Mini App.

**Last updated:** 2026-05-08

---

## Core Features

- **Wishlists** with public sharing via slug, item management, reservations
- **Wishlist Categories** — organize wishes into sections within a wishlist. Create/rename/delete categories, move items between them, drag to reorder. Collapsible sections for owner and guests
- **URL import/parsing** for adding items from external links
- **Comments** on wishlist items
- **Hints** for item gifting guidance
- **Gift Notes** (19 XTR one-time purchase)
- **Group Gift (Совместный подарок)** — pool money together for one gift. Organizer creates a collection (79 XTR one-time unlock), invites participants via deep link, tracks progress. Features: target amount, deadline, pinned payment info, participant chat, complete/cancel. Shows in "My Reservations" for both organizer and participants
- **Don't Gift (Не дарить)** — PRO feature. Profile-level gift restrictions. Users specify preset categories and custom items they don't want to receive. Visible to friends on guest view. Also available per-wishlist with three modes: global/custom/disabled
- **Secret Santa** campaigns
- **Support tickets** from within the app
- **Item Placements** — share a single wish across multiple wishlists via WishlistItemPlacement junction table
- **Events Calendar v2.1** — Personal calendar of gift-giving occasions: birthdays, anniversaries, holidays, custom events. Holiday import (per-country master list, dedup'd by `(ownerUserId, holidayKey)`), friend-birthday import (with `linkedUserId` so deletes cascade SetNull), per-occasion reminders (`offsetDays` + `timeOfDay`), in-app inbox, "today-context" banner, year-recap of completed events with `actualGiftText`/`thankYouNote`. Idea cards support emoji, link, price, photo, note. Soft-linked to wishlists / Santa campaigns / friends for cross-feature navigation. Server-persisted 4-step onboarding (`User.calendarOnboardingSeenAt`) so devices don't re-show the flow
- **Wishlist Emoji** — User-pickable emoji on each wishlist (single-grapheme + emoji-only validation; auto-pick from title hash when unset). Picker with quick-pick grid + "Свой" custom-emoji input

## Monetization

- **PRO subscription**: 100 XTR/month (auto-renewing) **or** 800 XTR/year (one-time, ~33% savings)
- **14 add-on SKUs** (including Gift Notes at 19 XTR, reservation_pro_unlock at 50 XTR, group_gift_unlock at 79 XTR, secret_reservation_unlock at 24 XTR, smart_reservations_unlock at 15 XTR)

### Plan Limits

| Resource        | FREE | PRO |
|-----------------|------|-----|
| Wishlists       | 2    | 10  |
| Items           | 20   | 70  |
| Participants    | 5    | 20  |
| Subscriptions   | 2    | 5   |

PRO-only features: `comments`, `url_import`, `hints`, `dont_gift`, `showcase`, `curated_selections`, `profile_subscriptions`.

See also: `docs/MONETIZATION.md`

## Scale

- **73 Prisma models**, **36 enums**
- **59 screens** in the Mini App
- **14 add-on SKUs**

## Lifecycle & Retention

- **Lifecycle/winback engine** for user re-engagement
- **Archive** with 90-day automatic purge
- **Guaranteed welcome delivery** — track and retry /start messages (User.welcomeSent field)
- **Watchdog** — resilient health monitoring with improved recovery

## Feature Flags

| Flag                      | Status                    |
|---------------------------|---------------------------|
| v2.1 UI refresh           | Rolled out (100%) — all 80 wave items shipped (W1–W80) |
| Card redesign             | Rolled out (100%)         |
| Item detail redesign      | Rolled out (100%)         |
| Profile redesign          | Rolled out (100%)         |
| Onboarding v2             | Default                   |
| Onboarding v1             | Deprecated                |
| Referral Program          | Disabled (enabled=false, flag-controlled) |

## Operational Toggles

- `MAINTENANCE_MODE` — blocks `/tg/*` and `/public/*` endpoints
- `MARKETPLACE_PARSER_DISABLED` — disables URL import parsing
- **Maintenance Recovery Notifications** — automated system that notifies users who saw a maintenance screen after service recovers. Uses MaintenanceIncident/MaintenanceExposure models, sends recovery messages with "Open bot" CTA
- **API Security Layer (Wave 1 P0, shipped 2026-04-29; Wave 2 expansion shipped 2026-05-06..07)** — Idempotency-Key middleware + per-category rate limits + IP throttle for state-changing routes. **Wave 2** extended coverage to Santa, gift-notes, items Pro extras (priority/photo upload), categories, subscriptions, and remaining P4 misc state-changing routes — full coverage of `/tg/*` POST/PATCH/DELETE. Soft-require: critical routes log `api.idem_missing_on_critical_endpoint` rather than 400, so cached Mini App versions aren't bricked. Multipart endpoints opt out of replay (lock-only). Env kill switches: `SECURITY_IDEMPOTENCY_ENABLED`, `SECURITY_RATE_LIMIT_ENABLED`, `SECURITY_IP_THROTTLE_ENABLED`. See [docs/API_SECURITY.md](API_SECURITY.md)
- **Production server: Vultr Amsterdam (since 2026-05-03)** — Migrated from Timeweb. Deploy via `git push` triggering GitHub Actions (`admin-ops.yml` for ops). Previous Timeweb host being decommissioned. See [docs/VULTR_MIGRATION_RUNBOOK.md](VULTR_MIGRATION_RUNBOOK.md), [docs/INFRA_AND_ENV.md](INFRA_AND_ENV.md)
- **Logging hardening (2026-05-07)** — Docker `json-file` driver capped at 20m × 5 across api/bot/web/postgres; `pino-roll` to host bind-mount (`/opt/wishlist/logs/{api,bot}/`) with daily rotation, 100 MB cap, 14-file retention. Three append-only ops logs covered by `logrotate` (weekly × 8, gzip, copytruncate). Weekly Docker prune TTL tightened 168h → 72h. Bot uses main-thread multistream (pino-roll worker stalled 2026-05-02 — kept on main thread by design). See [docs/INFRA_AND_ENV.md § Logging, Cleanup & Retention](INFRA_AND_ENV.md)

## Analytics

- **Market Segmentation** — `normalizedLocale`, `marketBucket`, `supportedImportRegion` fields on UserProfile. Segments: ru, en, zh-CN, hi, es, ar, other_known, unknown

## Recently Shipped

- **API Architecture Refactor closure (P1–P5s, ~2026-05-04..07)** — `apps/api/src/index.ts` reduced from ~21,300 LOC to **1,789 LOC** as a composition root (bootstrap, middleware, router/scheduler registration, `app.listen`). 23 domain routers extracted to `apps/api/src/routes/<domain>.routes.ts`; 9 cron schedulers to `apps/api/src/schedulers/<job>.ts`; 13 cross-cutting services to `apps/api/src/services/<name>.ts` (analytics, birthday-reminders, calendar, entitlement, items, lifecycle, locale, onboarding, referral-hooks, santa-season, telegram-auth, url-import, wishlists). New backend code MUST land in routes/services/schedulers — `index.ts` is closed for new handlers. See [docs/API_ARCHITECTURE_RULES.md](API_ARCHITECTURE_RULES.md), [docs/SCHEDULERS.md](SCHEDULERS.md), [docs/SERVICES.md](SERVICES.md), [docs/REFACTOR_API_INDEX_HANDOFF.md](REFACTOR_API_INDEX_HANDOFF.md)
- **API Security Wave 2 (2026-05-06..07)** — Extended idempotency + rate-limit coverage to Santa actions, gift-notes routes (web + api), items Pro extras (priority bump, photo upload), categories, subscriptions, and remaining P4 misc state-changing endpoints. Mini App callers now wire `idempotency: { action }` consistently for Santa and gift-notes. Closes the gap between Wave 1 P0 (billing/account/profile/wishlist core) and full `/tg/*` POST/PATCH/DELETE coverage
- **Vultr production migration (2026-05-03)** — Production moved from Timeweb (`31.130.149.249`) to Vultr Amsterdam (`199.247.24.125`). Deploy now via `git push` → GitHub Actions; ops via `admin-ops.yml`. Local SSH alias `Host vultr` → `~/.ssh/vultr_wishlist`. Telegram API IPv6 SNAT workaround (RKN-blocked IPv4) applied. Old Timeweb VPS being decommissioned
- **Contextual reminder deep links (2026-05-07)** — Reservation-reminder and gift-occasion-reminder bot DMs now open the Mini App **on the relevant entity** instead of the generic home. New start-param prefixes: `rrem_<itemId>__m_<metaId>` (reservation reminder → my-reservations + GuestItem detail) and `evnt_<occasionId>` (event reminder → gift-notes-occasion). Distinguishes 404 (deleted-toast), 403 `gift_notes_required` (paywall), and other errors (generic toast). Bootstrap state-reset block exempts the new prefixes; both branches clear cross-boot state on failure. Helpers: `buildReservationReminderDeepLink`, `buildEventReminderDeepLink` (`apps/api/src/telegram/deepLinks.ts`); parsers `parseReservationReminderPayload`, `parseEventReminderPayload` (`apps/web/app/miniapp/startParam.ts`). +5 deepLinks tests + 6 startParam tests
- **Logging hardening (2026-05-07)** — Docker `json-file` driver capped (20m × 5) on all 4 prod services; ops cron emits to `/opt/wishlist/logs/ops/*.log` with `logrotate` weekly × 8 gzip; weekly Docker prune TTL 168h → 72h (build cache had grown to 37 GB on 94 GB disk). API logs to bind-mounted host dir (`/opt/wishlist/logs/api/`) via `pino-roll` daily rollover. Bot logger fix (`1e85ab6`): replaced stalled `pino-roll` worker thread with main-thread multistream + structured startup logs. See [docs/INFRA_AND_ENV.md § Logging, Cleanup & Retention](INFRA_AND_ENV.md)
- **Hint delivery resilience (2026-05-03..04)** — First-click is fast and idempotent (cancel stale SENT hints, match bot's 30-min lookup window, retry recipient `sendMessage` 3× 5s on network failure). Confirmation copy reworded to be explicit about anonymity. Bot startup classifies aborts as transient and silences config noise. See [docs/BUGFIX_LESSONS.md § Hint window mismatch](BUGFIX_LESSONS.md)
- **Support handoff polish** — `/tg/support/contact` now shows the user's active plan and cleans duplicate metadata in the bot DM. Mini App closes after handoff. Misc DX: `APP_RELEASE` env now sourced from git HEAD during deploy
- **Birthday Reminders** — Bot-driven social notifications for friends (subscribers + connected users) before a user's birthday, plus self-reminders to update wishlist. FREE: 14d + day-of friend reminders, 30d owner self-reminder. PRO: adds 7d/1d friend windows, 14d/7d owner windows (conditional on wishlist state), audience EXTENDED (reservers + secret reservers), primary birthday wishlist override, custom italicised message in friend DM. Per-recipient mute via 🔕 button in bot DM. Quiet hours 9–22 MSK; daily cap of 3 friend reminders per recipient. Kill switch `BIRTHDAY_REMINDERS_ENABLED`. New schema: `BirthdayReminderDelivery`, `BirthdayReminderMute`, 8 new `UserProfile` fields. New paywall context `birthday_reminders_advanced`. ~75 i18n keys × 6 locales.
- **v2.1 UI Refresh** — Complete visual redesign across all screens (80 wave items). Glass morphism, mesh gradients, accent glow, liquid-glass header/input bars, v2.1 display typography (26/700/−0.035em). All primitives from `@wishlist/ui` adopted (Button, Card, Chip, Banner, SectionHeader, ListRow, StatTile, FloatingNav, HeroCard)
- **FloatingNav** — Persistent Instagram-like bottom navigation bar globally replacing the outer home tab bar. Tabs: Home / Archive / Profile / Reservations
- **Yearly PRO Plan** — 800 XTR one-time purchase extends PRO by 365 days (~33% savings vs monthly). Monthly/yearly toggle on paywall. Bot sends DM renewal reminders at 7 days and 1 day before expiry
- **Appearance Customisation** (PRO) — Theme (dark/black) and accent colour (violet/blue/pink/green). Persisted on `User.themePreference` / `User.accentPreference`. Served in `GET /tg/me/plan` as `appearance`. FREE locked to dark+violet
- **API Security Layer (Wave 1 P0)** — Idempotency keys, per-category rate limits (18 categories), IP throttle for state-changing endpoints. Critical routes use soft-require (log only). Multipart endpoints opt out of replay. New `IdempotencyKey` model, `IdempotencyStatus` enum
- **Wishlist Emoji** — User-pickable emoji on each wishlist (single-grapheme + emoji-only validation). Picker with quick-pick grid + "Свой" custom-emoji input. Falls back to hash-derived auto-pick from title when unset
- **Bot Network Resilience** — Bot heartbeat watchdog, error-noise filters, lifecycle dead-air alarm, bot startup-noise silencer (4 follow-ups)
- **Profile race-safe upsert** — replaced fragile `upsert` with `create + catch P2002`, eliminating concurrent profile-creation race
- **Showcase** — PRO premium public profile page with cover photo, bio, pinned wishlists, preferences (clothing/shoe/ring sizes, body measurements, brand preferences). New screens: showcase-editor, showcase-preview
- **Profile Subscriptions** — Follow other users' public profiles/showcases (PRO)
- **Curated Selections ("часть вишлиста")** — Share a selected subset of wish items via a temporary link (PRO). Guests can subscribe to curated selections
- **Smart Reservations** — Per-wishlist time-limited reservations with auto-release, reminders, and extensions (39 XTR add-on per wishlist). Wishlist settings control TTL hours, max extensions, allow-extend flag
- **Per-wishlist Don't Gift** — Extend "What not to gift" to per-wishlist level with 3 modes: global/custom/disabled
- **Link Management** — View active share links (wishlists/curated selections), revoke them. Endpoint: /tg/me/active-links
- **Secret Reservations** — Reserve a wish secretly so the owner doesn't see who reserved (24 XTR one-time add-on). New screens: secret-reservation-detail, secret-reservation-paywall
- **Comment Quick Reply** — Reply to comments from notifications; threaded one-level replies (parentCommentId on Comment model)
- **Gift Notes onboarding** — Demo-first paywall, 4-step onboarding. New screen: gift-notes-onboarding
- **Referral Program** — Invite-a-friend PRO rewards (30 days PRO per qualified referral). Gated behind enabled=false. New screens: referral, referral-history
- **FAQ** — 50 questions organized into 15 sections (About, Plans, Payments, Reservations, Secret Reservations, Smart Reservations, Group Gift, Gift Notes & Don't Gift, Showcase & Selections, Links & Access, Comments & Subscriptions, Secret Santa, Archive & Deletion, Support, Upcoming Features). Sectioned accordion UI
- **Legal documents v2.0** (effective 30.04.2026) — Privacy Policy, Terms of Use, Pro & Purchase Terms. Terms of Use adds sections on Reservations, Group Gift liability, Public Links, Limitation of Liability. Pro & Purchase Terms adds pricing mechanics (Monthly 100 XTR, Yearly 800 XTR, add-ons, cancellation, refunds). All in 6 locales

## Key Source Paths

- Frontend: `apps/web/app/miniapp/`
- API: `apps/api/src/`
- DB schema: `packages/db/prisma/schema.prisma`
