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
| `error:*`            | Client-side error tracking       |

## Source Paths

- God Mode middleware/routes: `apps/api/src/`
- God Mode UI: `apps/web/app/miniapp/` (god mode components)
