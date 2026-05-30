# Billing reconciliation

**Last updated:** 2026-05-29 · **Owner:** backend

Cross-checks the three Telegram Stars money tables — `PaymentEvent`,
`Subscription`, `Purchase` — against each other and surfaces every
discrepancy that means "we charged (or granted) something but the ledger
disagrees with itself." Detection is **read-only**; the one optional
mutation is a narrow, provably-correct relink (see [§ Safe apply](#safe-apply)).

This closes the "credits/billing without reconciliation against Telegram
Stars provider records" risk flagged in the feature map. Today it reconciles
our **own** tables (keyed by the Telegram charge ids stored on them); live
comparison against Telegram's `getStarTransactions` ledger is a documented
future extension (see [§ Future: live Telegram ledger](#future-live-telegram-ledger)).

- Service: [`apps/api/src/services/billing-reconciliation.ts`](../../apps/api/src/services/billing-reconciliation.ts)
- CLI: [`apps/api/src/scripts/billing-reconcile.ts`](../../apps/api/src/scripts/billing-reconcile.ts)
- Admin endpoint: `GET /admin/billing/reconcile` (read-only)
- Tests: [`billing-reconciliation.test.ts`](../../apps/api/src/services/billing-reconciliation.test.ts) (unit) ·
  [`test/integration/billing-reconciliation.test.ts`](../../apps/api/test/integration/billing-reconciliation.test.ts) (real DB)

---

## How the money tables relate

Telegram Stars payments land in **two independent idempotency ledgers**
(written by [`apps/bot/src/payments.ts`](../../apps/bot/src/payments.ts), each
inside a single `prisma.$transaction`):

| Flow | Writes | Idempotency key |
|---|---|---|
| PRO subscription (monthly / yearly / lifetime) | `PaymentEvent` + `Subscription` | `PaymentEvent.telegramPaymentChargeId` (`@unique`) |
| One-time add-on (slots, credit packs, unlocks) | `Purchase` + an audit `PaymentEvent` | `Purchase.telegramChargeId` (`@unique`) |

The same Telegram charge id therefore appears on a `PaymentEvent` **and** on
its `Subscription.telegramChargeId` (subscription flow) **or** its
`Purchase.telegramChargeId` (add-on flow). That shared id is the **expected
join**, not a duplicate.

`PaymentEvent` is **overloaded** by `eventType` — only some rows are real
money. The reconciler classifies every row before checking it:

| `eventType` | Class | Reconciliation expectation |
|---|---|---|
| `payment_success`, `payment_success_yearly`, `payment_success_lifetime` | subscription payment (PRO) | must link to a live `Subscription` |
| `gc_payment_received` | subscription payment (**legacy** GIFT_CALENDAR) | counts as a payment trail; never auto-relinked (PRO-only) |
| `addon_payment_success` | add-on payment | must have a matching `Purchase` by charge id |
| `payment_success_post_lifetime` | lifetime guard | money taken after lifetime, **no** new value → refund candidate |
| `invoice_created`, `addon_invoice_created`, `gift_notes_invoice_created`, `gc_invoice_created` | non-payment (checkout stub, synthetic charge id) | **ignored** |
| `reminder_sent_*` | non-payment (renewal-reminder dedup marker) | **ignored** |

> The `gc_*` rows are a **legacy GIFT_CALENDAR** Stars flow (planCode
> `GIFT_CALENDAR`) whose producing code was removed but whose historical rows
> remain in prod. The taxonomy must keep recognising them — see the 2026-05-30
> [BUGFIX_LESSONS](../BUGFIX_LESSONS.md) entry. Audit coverage with
> `SELECT DISTINCT "eventType" FROM "PaymentEvent"` before trusting a clean run.

Subscriptions also carry a `source`. Only `telegram_stars` subs are *paid*
and must have a `PaymentEvent`. Free grants (`referral_reward`,
`survey_reward:*`, `winback`, `manual`, …) have `starsPrice = 0` and
legitimately have none — they are **excluded** from the missing-payment check.

---

## What it checks

| Finding kind | Sev | Meaning | Bucket |
|---|---|---|---|
| `payment_event_without_subscription` | 🔴 high | A subscription-payment event with no / dangling `subscriptionId`. Money taken, entitlement maybe not granted. | 1 |
| `payment_event_without_purchase` | 🔴 high | An add-on payment event with no matching `Purchase`. | 1 |
| `subscription_without_payment_event` | 🔴 high | A `telegram_stars` sub with zero `PaymentEvent`s — paid PRO granted with no payment trail. | 2 |
| `duplicate_provider_charge_id` | 🔴 high | One `providerPaymentChargeId` on ≥2 `PaymentEvent`s — two telegram charges map to one real payment. | 3 |
| `charge_id_user_mismatch` | 🔴 high | A `PaymentEvent.userId` differs from its linked `Subscription`/`Purchase` owner. | 3 |
| `unknown_sku_purchase` | 🔴 high | A `Purchase` for a SKU not in `ONE_TIME_SKUS` — money taken, nothing granted. | 4 |
| `duplicate_subscription_charge_id` | 🟡 med | One `Subscription.telegramChargeId` on ≥2 subs (the column is not `@unique`). | 3 |
| `lifetime_guard_charge` | 🟡 med | A `payment_success_post_lifetime` row — monthly/yearly charge after lifetime. Refund candidate. | 4 |
| `non_completed_purchase` | 🟡 med | A `Purchase` left in a non-`completed` status. | 4 |
| `stale_active_subscription` | ⚪ low | `status = ACTIVE` but `currentPeriodEnd` is in the past (non-lifetime) — expiry-sweep gap. | 4 |

The four buckets map directly to the original task: (1) PaymentEvent without
Subscription/Purchase, (2) Subscription without PaymentEvent, (3) duplicate
charge id, (4) failed/partial cases.

---

## Running it

Dry-run (read-only) is the **default**, so the safe path needs no flags and a
forwarded-flag hiccup can never silently mutate billing data.

### Local / dev (tsx)

```bash
pnpm billing:reconcile                 # dry-run, human-readable report
pnpm billing:reconcile -- --json       # full report as JSON (for jq / tickets)
pnpm billing:reconcile -- --apply      # perform the safe relink backfill
pnpm billing:reconcile -- --strict     # exit non-zero when work remains
pnpm billing:reconcile -- --help
```

**Exit codes** (for cron alerting): `0` clean · `2` (`--strict`) findings
remain · `3` (`--strict`) `--apply` succeeded but the post-apply re-check failed
(applied-but-unverified — never read as clean) · `1` unhandled error.

### Production (compiled, inside the API container)

`tsx` is a dev dependency and is **not** in the prod image. Run the compiled
output with `node`:

```bash
ssh vultr
docker exec wishlist-prod-api-1 node /app/apps/api/dist/scripts/billing-reconcile.js --dry-run
docker exec wishlist-prod-api-1 node /app/apps/api/dist/scripts/billing-reconcile.js --apply
```

### Admin endpoint (no SSH, read-only)

```bash
curl -s -H "X-ADMIN-KEY: $ADMIN_KEY" https://<host>/admin/billing/reconcile | jq .
```

Returns the same report as JSON. The endpoint is **read-only by design** — a
`GET` must be side-effect-free, so the `--apply` backfill is intentionally
CLI-only (it forces a human at a terminal for any mutation).

### Sample output

```
━━━ Billing reconciliation ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  generated: 2026-05-29T09:30:12.445Z
  scanned:   3 payment events · 1 subscriptions · 3 purchases
  result:    ⚠ 4 finding(s) — 🔴 4 high · 🟡 0 medium · ⚪ 0 low

  🔴 payment_event_without_subscription: 1
  🔴 [payment_event_without_subscription] Subscription payment with no subscriptionId link (null_link).
      pe=cmpqq0zbm00058…  user=cmpqq0zbc00008…  charge#4f9fb8021ceba32e  199 XTR
  ...
```

Every line carries **opaque internal ids** (`pe=`, `sub=`, `pur=`, `user=`)
you can look up in the DB, plus a `charge#<hash>` for correlating findings
that share a charge id. See [§ PII](#pii) for what is deliberately absent.

---

## Remediation

The tool **detects**; you decide. Look up the full row by its internal id
(e.g. `prisma.paymentEvent.findUnique({ where: { id } })`) to get the raw
charge id, payload, and amount, then act:

| Finding | Action |
|---|---|
| `payment_event_without_subscription` (null link) | Run `--apply` — it relinks unambiguous cases automatically. |
| `payment_event_without_subscription` (dangling) | Sub row is gone. Decide: re-create the entitlement, or refund. Manual. |
| `payment_event_without_purchase` | Verify with Telegram the charge succeeded; re-create the `Purchase` + grant the add-on, or refund. |
| `subscription_without_payment_event` | Confirm the user actually paid (Telegram). If yes, backfill a `PaymentEvent`; if it was a mis-grant, downgrade. |
| `duplicate_provider_charge_id` | Two telegram charges share one real payment — strong double-charge signal. Refund the extra via Telegram (`refundStarPayment`). |
| `charge_id_user_mismatch` | Attribution bug — figure out the true owner before any refund/grant. |
| `unknown_sku_purchase` | Money taken, nothing delivered. Map the SKU and grant manually, or refund. |
| `duplicate_subscription_charge_id` | Inspect both subs; usually a data-edit artifact. |
| `lifetime_guard_charge` | User already had lifetime — refund the redundant monthly/yearly charge. |
| `non_completed_purchase` | Finish or void the purchase depending on why it stalled. |
| `stale_active_subscription` | Usually self-heals on the next `schedulers/billing.ts` expiry sweep; if persistent, investigate the sweep. |

Refunds use Telegram's `refundStarPayment` (bot-side) — **not automated here**.

<a id="safe-apply"></a>
## Safe apply (`--apply`)

`--apply` performs exactly **one** mutation, the only provably-correct repair:

> Relink a subscription-payment `PaymentEvent` whose `subscriptionId` is
> `null` to the PRO `Subscription` whose `telegramChargeId` **exactly equals**
> the event's charge id.

Exact charge-id match is the *only* provably-correct target. There is
deliberately **no** "relink to the user's single PRO sub" fallback — that would
mislink an old or foreign payment to a since-replaced subscription (e.g. after
a delete→recreate). It re-queries the DB live (never trusts a stale report) and
the relink is a **conditional, atomic** `updateMany` guarded on
`subscriptionId IS NULL`, so it is **idempotent** and safe against a concurrent
payment webhook (a racing link makes the update a no-op, never a clobber). It
**skips** anything without an exact charge match — reporting each skip with a
reason.

Everything else — refunds, re-grants, backfilling missing rows, `EXPIRED`
transitions — stays **manual**. The tool will never move money or change an
entitlement on its own.

<a id="pii"></a>
## PII

The report is safe to paste into a ticket or share. It contains **only**:

- opaque internal cuids (`paymentEventId`, `subscriptionId`, `purchaseId`,
  `userId`) — queryable, not personally identifying;
- a one-way SHA-256 prefix of the Telegram charge id (`chargeIdHash`);
- `eventType`, `skuCode`, `status`, amount/currency, timestamps.

It **never** contains a raw `telegramPaymentChargeId` / `providerPaymentChargeId`,
an `invoicePayload` (which embeds the raw Telegram user id), a `rawPayload`,
an email, or a `telegramId`. Those columns are not even loaded into memory —
the raw payment identifiers live only in the DB. (Per the project's
"never log raw charge id / IP" discipline.)

## Scale note

The reconciler loads the three tables into memory and computes discrepancies
in JS — simple and exhaustive at the current scale (low thousands of rows). All
three loads run inside a single **`REPEATABLE READ` transaction**, so they share
one consistent snapshot — a payment written mid-scan can't produce a torn read
(a sub seen without its just-written payment → a phantom "no payment trail").
The row `count()` runs in that same snapshot and **refuses** to load once the
three tables together exceed `DEFAULT_MAX_SCAN_ROWS` (200 000), so the in-process
`GET /admin/billing/reconcile` can never OOM the API and there is no
count→load TOCTOU. Above that threshold the grouping/orphan checks must move to
streamed SQL aggregation. The CLI shares the same guard (override per-call via
the `maxScanRows` option if you ever need to force a larger in-memory pass).

<a id="future-live-telegram-ledger"></a>
## Future: live Telegram ledger

True provider-record reconciliation would additionally pull Telegram's own
Stars ledger via the Bot API `getStarTransactions` and cross-check every
`telegram_payment_charge_id` against it (catching charges Telegram recorded
that never reached our DB at all, and vice-versa). Not yet implemented because:

- `apps/api` holds no bot token today (it lives in `apps/bot`); and
- the Telegram API is reachable only from the prod host (RKN/IPv6 — see the
  `infra_ipv6_telegram` runbook), so it can't be exercised off-prod.

The service is structured so a provider-ledger source can be layered on as an
opt-in `--with-telegram` step without touching the internal checks. Refunds
would use the same `refundStarPayment` call referenced above.
```
