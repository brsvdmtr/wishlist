# Analytics and God Mode

Internal analytics dashboard gated behind God Mode access.

**Last updated:** 2026-04-02

---

## God Mode Access Control

**Double-gated:**

1. `GOD_MODE_TELEGRAM_IDS` env — comma-separated list of allowed Telegram user IDs
2. `godMode` flag in the database user record must be `true`

Both conditions must be met for access.

## God Stats Endpoint

Returns a comprehensive analytics payload:

| Section            | Description                                              |
|--------------------|----------------------------------------------------------|
| `overview`         | High-level user/wishlist/item counts                     |
| `funnel`           | 7-step conversion funnel                                 |
| `engagement`       | Usage frequency and depth metrics                        |
| `proLimits24h`     | PRO limit hits in the last 24 hours                      |
| `errors24h`        | Error counts in the last 24 hours                        |
| `onboarding`       | Onboarding completion/drop-off stats                     |
| `onboardingAB`     | A/B test results for onboarding variants                 |
| `localeSegments`   | Language breakdown across 3 scopes: `active30d`, `new7d`, `all` |

## Retention Stats Endpoint

- Lifecycle touch tracking
- Winback attribution
- Promo campaign tracking

## Tracked Event Patterns

| Pattern              | Purpose                          |
|----------------------|----------------------------------|
| `feature_gate_hit_*` | Tracks when users hit plan limits |
| `onboarding_*`       | Onboarding screen flow events    |
| `demo_item_*`        | Demo item lifecycle events       |
| `gift_*`             | Gift note events                 |
| `birthday.*`         | Birthday reminder lifecycle (settings, opt-in, mutes, scheduler, bot, deep-link attribution) |
| `error:*`            | Client-side error tracking       |

## Birthday Reminders

Bot-driven social birthday notifications + self-reminders to update wishlist. See `docs/BACKEND_MAP.md` § 13 (scheduler) and `docs/MONETIZATION.md` § 16a (Pro gating).

### God Mode dashboard endpoint

`GET /tg/admin/birthday-reminders/metrics` (God Mode only) returns:

| Field | Description |
|---|---|
| **Readiness** | `users_with_birthday`, `users_with_friend_reminders_enabled`, `users_with_public_birthday_profile`, `users_with_public_wishlist`, `users_with_active_public_items`, `users_with_primary_wishlist` |
| **24h delivery breakdown** | counts by `status` (`pending`/`sent`/`skipped`/`failed`/`deferred`), by `reminderKind` (`friend_14d`, `friend_7d`, `friend_1d`, `friend_today`, `owner_30d`, `owner_14d`, `owner_7d`, `owner_today`), by `skipReason`, by `failureReason` |
| **Engagement** | `sent`, `clicked`, `ctr` (computed from `BirthdayReminderDelivery.clickedAt` set by `GET /tg/birthday-reminders/resolve/:deliveryId`) |
| **Mutes** | total + 24h `BirthdayReminderMute` count |
| **Scheduler** | `ServiceHeartbeat[serviceName='birthday_reminders']` last-run timestamp + `metadata` JSON, plus stuck-pending count |
| **Alerts** | `schedulerStale` (heartbeat older than expected interval), `stuckPendingHigh` (pending rows older than 30 min above threshold), `noSendsDespiteCandidates` (scan found candidates but zero rows transitioned to `sent`) |

### Event list (under `// ===== Birthday Reminders =====` in `packages/shared/src/analyticsEvents.ts`)

**Settings writes**

- `birthday.settings_opened`
- `birthday.friend_reminders_enabled` / `birthday.friend_reminders_disabled`
- `birthday.owner_reminders_enabled` / `birthday.owner_reminders_disabled`
- `birthday.audience_changed`
- `birthday.advanced_windows_enabled` / `birthday.advanced_windows_disabled`
- `birthday.primary_wishlist_set` / `birthday.primary_wishlist_cleared`
- `birthday.custom_message_saved` / `birthday.custom_message_cleared`
- `birthday.receiving_enabled` / `birthday.receiving_disabled`

**Opt-in sheet (post-save of birthday in profile edit)**

- `birthday.optin_shown` / `birthday.optin_accepted` / `birthday.optin_dismissed`

**Mutes**

- `birthday.mute_added` / `birthday.mute_removed`

**PRO**

- `birthday.paywall_shown` / `birthday.paywall_converted` / `birthday.pro_required_hit`

**Scheduler (server)**

- `birthday.scheduler_run_started` / `birthday.scheduler_run_completed` / `birthday.scheduler_run_failed`
- `birthday.candidate_found`
- `birthday.delivery_created` / `birthday.delivery_sent` / `birthday.delivery_skipped` / `birthday.delivery_deferred` / `birthday.delivery_failed` / `birthday.delivery_retry`

**Bot**

- `birthday.bot_message_sent` / `birthday.bot_message_failed` / `birthday.bot_cta_clicked` / `birthday.bot_mute_clicked`

**Mini App attribution (deep-link session)**

- `birthday.deeplink_opened` / `birthday.deeplink_resolve_failed`
- `birthday.banner_seen` / `birthday.banner_dismissed` / `birthday.banner_cta_clicked`
- `birthday.public_wishlist_opened` / `birthday.public_profile_opened`
- `birthday.item_opened` / `birthday.item_reserved` / `birthday.secret_reservation_clicked`
- `birthday.gift_completed` / `birthday.subscribe_clicked`

**Owner attribution**

- `birthday.owner_update_wishlist_opened` / `birthday.owner_item_added` / `birthday.owner_wishlist_made_public`

### Birthday session attribution

`trackBirthdayAttributedEvent()` in `MiniApp.tsx` automatically adds `birthdaySource: true`, `birthdayDeliveryId`, `birthdayReminderKind`, and `birthdayUserId` props to other analytics events fired during a birthday-context session (set when `br_<deliveryId>` resolves at app boot). This lets the dashboard distinguish actions taken from a birthday DM from organic activity.

## Source Paths

- God Mode middleware/routes: `apps/api/src/`
- God Mode UI: `apps/web/app/miniapp/` (god mode components)
- Birthday-reminder events: `packages/shared/src/analyticsEvents.ts`
