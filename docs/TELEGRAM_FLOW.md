# TELEGRAM_FLOW — Telegram Bot & Mini App Integration
> Last updated: 2026-04-02 | Branch: main

## Overview

| Property | Value |
|----------|-------|
| **Bot username** | Configured via `NEXT_PUBLIC_BOT_USERNAME` env (default: WishHub_bot) |
| **Framework** | Telegraf 4.16 |
| **Source** | `apps/bot/src/index.ts` (~1,190 lines) |
| **Runtime** | Long polling (`bot.launch()` with no arguments; **no webhook**) |
| **Graceful shutdown** | Listens on `SIGINT` and `SIGTERM`, calls `bot.stop()` |
| **Missing token** | Prints warning, enters idle `setInterval` loop (no crash) |

---

## Bot Commands

| Command | Handler | Behavior |
|---------|---------|----------|
| `/start` | `bot.start()` | Welcome text + donation message; sets per-chat menu button; stores `telegramChatId` |
| `/start <payload>` | `bot.start()` | Detects deep link payload, shows inline WebApp button |
| `/help` | `bot.command('help')` | Help text + inline "Contact support" button (`open_support` callback) |
| `/support` | `bot.command('support')` | Immediately sends ForceReply support prompt |
| `/paysupport` | `bot.command('paysupport')` | Shows payment support info text |

Commands are registered via `setMyCommands` for `en` (default) and `ru` language codes. The `/help` command is not registered in the menu but works when typed.

### /start Handler Details

1. Calls `setChatMenuButton()` to set/refresh the persistent WebApp button.
2. Upserts `User.telegramChatId` in DB for future notifications.
3. If payload is present, dispatches by prefix (see Deep Link Payloads below).
4. If no payload, sends two messages: welcome text (link preview disabled) + donation text (link preview enabled for Tribute link).

---

## Deep Link Payloads

When a user opens `https://t.me/{BOT_USERNAME}?start=<payload>`, Telegram delivers it as `ctx.startPayload`. The bot pattern-matches on the prefix:

| Prefix | Mini App `startapp` value | Behavior |
|--------|---------------------------|----------|
| `santa_{token}` | `santa_join_{token}` | Looks up `SantaCampaign` by `inviteToken`. Shows join button if campaign is OPEN/DRAFT; error if expired/cancelled/closed. |
| `hint_{itemId}` | `{slug}__item_{itemId}` | Fetches item, checks availability and self-send. Shows hint message with view button pointing to the item within its wishlist. |
| `profile_{username}` | `profile_{username}` | Shows "View profile" button opening the public profile screen. |
| `draft_{itemId}` | `draft_{itemId}` | URL import result -- opens drafts screen with the new item. |
| `share_{token}` | `share_{token}` | Guest wishlist view via share token. |
| `{slug}__item_{id}` | `{slug}__item_{id}` | Direct item navigation within a wishlist. |
| _(no prefix match)_ | Payload passed through as-is | Treated as a wishlist slug; opens generic "View wishlist" button. |

### Link Generation (packages/shared)

```typescript
buildTgDeepLink(botUsername, payload)
  // -> https://t.me/{botUsername}?startapp={encodeURIComponent(payload)}

buildTgShareUrl(url, text)
  // -> https://t.me/share/url?url={url}&text={text}
```

---

## Mini App Integration

### Menu Button
- Type: `web_app`
- Text: `"Wishlist"`
- URL: `MINI_APP_URL` (e.g., `https://wishlistik.ru/miniapp`)
- Set globally via `setChatMenuButton()` on bot startup and refreshed per-chat on `/start`

### Inline Buttons
Deep link payloads produce `Markup.button.webApp(...)` buttons that open the Mini App with the appropriate `startapp` parameter.

---

## Telegram WebApp SDK

### Initialization (MiniApp.tsx)

1. Check `window.Telegram?.WebApp` exists; if not, show error screen.
2. Extract `initData` from `WebApp` for API auth headers.
3. Read `startapp` param from `WebApp.initDataUnsafe.start_param` for routing.
4. Parse `user` from `initDataUnsafe` for display and actor hash computation.
5. Configure: `WebApp.ready()`, `WebApp.expand()`, `setHeaderColor()`, `setBackgroundColor()`.

### SDK Features Used

| Feature | Purpose |
|---------|---------|
| `WebApp.initData` | Auth header (`X-TG-INIT-DATA`) for all API calls |
| `WebApp.initDataUnsafe.start_param` | Deep link routing |
| `WebApp.initDataUnsafe.user` | User info display |
| `WebApp.ready()` | Signal loading complete |
| `WebApp.expand()` | Full-height mode |
| `WebApp.setHeaderColor()` / `setBackgroundColor()` | Match dark theme |
| `WebApp.BackButton.show/hide/onClick` | Navigation back |
| `WebApp.HapticFeedback.impactOccurred` | Reserve action feedback |
| `WebApp.openTelegramLink(url)` | Share to Telegram |

---

## Auth / initData Validation

Implemented in `apps/api/src/index.ts` as `validateTelegramInitData()`.

### HMAC Validation

1. Parse `initData` as URL-encoded key=value pairs.
2. Extract the `hash` field.
3. Build `data_check_string`: sort remaining pairs alphabetically by key, join with `\n`.
4. Compute secret: `HMAC-SHA256("WebAppData", BOT_TOKEN)`.
5. Compute expected hash: `HMAC-SHA256(secret, data_check_string)`.
6. Compare using **timing-safe comparison** (`crypto.timingSafeEqual` via SHA-256 fixed-length hashing).
7. Parse the `user` JSON field into `TelegramUser`.

### auth_date Expiry

- **Max age**: 24 hours (86,400s), configurable via `INIT_DATA_MAX_AGE_SECONDS` env.
- **Clock skew tolerance**: 30 seconds (`INIT_DATA_CLOCK_SKEW_SECONDS`).
- Rejects: missing `auth_date`, non-numeric, zero, negative, expired, or too far in the future.

### Dev Bypass

In non-production (`NODE_ENV !== 'production'`):
- Accepts `X-TG-DEV` header with a raw `telegramId`.
- Skips HMAC validation entirely.
- Constructs minimal `TelegramUser`: `{ id: <devId>, first_name: 'Dev User' }`.

---

## Payment / Billing

Payments are handled **entirely in the bot process** via direct Prisma writes. There is no API call to an `/internal/activate-subscription` endpoint.

### Payment Flow

1. Mini App sends a Telegram Stars invoice via the bot.
2. Telegram sends `pre_checkout_query` -- bot must answer within 10 seconds.
3. On user confirmation, Telegram sends `successful_payment`.
4. Bot processes the payment in a Prisma `$transaction`.

### Payload Formats

**Subscription**: `pro_monthly:<telegramId>:<uuid>`
- Upserts `Subscription` record (plan `PRO`, status `ACTIVE`, 30-day period or `subscription_expiration_date`).
- Creates `PaymentEvent` with `eventType: 'payment_success'`.
- Idempotency via `PaymentEvent.telegramPaymentChargeId` unique constraint.

**One-time add-on**: `addon:<skuCode>:<telegramId>:<targetId|_>:<sessionId>`
- 10 known SKUs:

| SKU | Type |
|-----|------|
| `extra_wishlist_slot` | Permanent add-on |
| `extra_subscription_slot` | Permanent add-on |
| `extra_items_5` | Permanent add-on (qty 5) |
| `extra_items_15` | Permanent add-on (qty 15) |
| `seasonal_decoration` | Permanent add-on |
| `gift_notes_unlock` | Permanent add-on |
| `hints_pack_5` | Consumable credits |
| `hints_pack_10` | Consumable credits |
| `import_pack_10` | Consumable credits |
| `import_pack_25` | Consumable credits |

- Creates `Purchase` record (idempotency via `telegramChargeId` unique).
- Creates `PaymentEvent` with `eventType: 'addon_payment_success'`.
- Permanent add-ons: creates `UserAddOn` record.
- Consumable credits: upserts `UserCredits` with increment.

---

## Support Bridge

A full ticket system with DB persistence, replacing the earlier simple forward-and-reply approach.

### Data Model

| Model | Purpose |
|-------|---------|
| `SupportTicket` | Ticket record with code, status, timestamps |
| `SupportMessage` | Individual messages (user or support), with Telegram message ID tracking |
| `SupportSession` | Tracks ForceReply prompts (24h expiry) |

### Ticket Lifecycle

1. User sends `/support` (or taps "Contact support" from `/help`).
2. Bot sends a ForceReply prompt and saves a `SupportSession` (24h TTL).
3. User replies to the prompt -- bot creates a `SupportTicket` (status: `WAITING_SUPPORT`) and first `SupportMessage`.
4. Message is forwarded to `SUPPORT_CHAT_ID` with header `[SUP-XXXX] Novoe obrashchenie`.
5. Support staff replies to the forwarded message in the group.
6. Bot detects the reply, saves a `SupportMessage` (role: `SUPPORT`), sets status to `WAITING_USER`, delivers to user via `sendMessage` with ForceReply.
7. User can reply to the delivered message for follow-ups (status flips back to `WAITING_SUPPORT`).
8. Staff sends `/close` as a reply to any ticket message to close it (status: `CLOSED`, user notified).

### Ticket Codes

Format: `SUP-XXXX` (zero-padded sequential, e.g., `SUP-0001`, `SUP-0042`).

### Rate Limiting

Maximum 1 non-closed ticket per user. Attempting to open a second returns a message referencing the existing ticket code.

### Media Support

Supported message types: text, photo, video, document. Unsupported types are labeled `[Unsupported message type]`. File IDs are stored in `SupportMessage.telegramFileId`.

### Configuration

- `SUPPORT_CHAT_ID` env var -- Telegram group/channel chat ID.
- Bot must be admin in the support group.

---

## Notifications

Notifications are sent by the API via the Telegram Bot API (not by the bot process directly).

### Trigger Points

| Event | Recipient | Template |
|-------|-----------|----------|
| Item reserved | Owner | `{displayName} reserved "{title}"` |
| Comment (reserver to owner) | Owner | `{displayName} commented on "{title}": {text}` |
| Comment (owner to reserver) | Reserver | `Author commented on "{title}": {text}` |
| Description updated | Reserver | `Description updated on "{title}"` |
| Batch comments | Recipient | `You have {N} new comments on "{title}"` |
| Wishlist activity | Subscriber | `New item in "{title}" by {ownerName}` |

### Notification Queue
- 30-second debounce per `itemId:recipientUserId`.
- First message: sent immediately; subsequent within window: accumulated.
- After 30s: batch summary if count > 0.
- In-memory (`Map`) -- lost on server restart (acceptable trade-off).

### Lifecycle Messaging

The system sends targeted lifecycle messages via the bot's DM channel:
- **Winback messages**: Sent to users whose PRO subscription has lapsed.
- **Engagement messages**: Sent based on user activity patterns.
- All lifecycle touches are logged in the `LifecycleTouch` model to prevent duplicates.

---

## URL Import via Bot

1. User sends a message containing a URL to the bot (not a command).
2. Bot extracts the first URL (warns if multiple URLs detected).
3. Any surrounding text is passed as a `note`.
4. Bot sends `POST {API_BASE_URL}/internal/import-url` with `{ userId, url, note, source: 'bot' }` (auth via `X-INTERNAL-KEY: BOT_TOKEN`).
5. API creates a draft item (parses the URL for title, price, image).
6. Bot replies with item details and an inline button: `draft_{itemId}` deep link.
7. Handles 402 (drafts full), 400 (bad URL), and parse status (`failed`/`partial`) with appropriate messages.

---

## Hint Delivery

### Direct Delivery via `users_shared`

When a user selects recipients via a `request_users` keyboard button (from the Mini App hint flow):

1. Telegram sends a `users_shared` event with the selected user IDs.
2. Bot finds the sender's most recent active hint (created in last 30 minutes).
3. For each selected recipient (excluding self and item owner):
   - Attempts direct bot delivery via `sendMessage` with an inline WebApp button.
   - If delivery fails (user hasn't started the bot), counts as `pending`.
4. Updates `Hint` record with `status: DELIVERED`, `sentCount`, `pendingCount`.
5. Sends summary to sender (X sent, Y pending).
6. For pending recipients, sends a fallback deep link (`hint_{itemId}`) that the sender can share manually.

---

## Operational

### Heartbeat

- `ServiceHeartbeat` record upserted every 60 seconds.
- The `/health/deep` endpoint can detect bot absence by checking the heartbeat timestamp.

### Admin Alerts

- Sent to all chat IDs in `ADMIN_ALERT_CHAT_IDS` (comma-separated env var).
- Triggered on: bot startup, uncaught exceptions, unhandled rejections.
- Best-effort (never throws), uses raw `fetch` to Telegram Bot API.

### Graceful Shutdown

- `process.once('SIGINT', () => bot.stop('SIGINT'))`
- `process.once('SIGTERM', () => bot.stop('SIGTERM'))`

### Error Handling

- `uncaughtException`: sends admin alert, then `process.exit(1)`.
- `unhandledRejection`: sends admin alert, does **not** exit.

---

## Localization

### Bot Descriptions

Set via `setMyDescription` API for 6 locales:

| Locale | Telegram `language_code` |
|--------|--------------------------|
| `en` | _(default, no code)_ |
| `ru` | `ru` |
| `zh-CN` | `zh` |
| `hi` | `hi` |
| `es` | `es` |
| `ar` | `ar` |

### Per-message Localization

All user-facing bot messages use `t(key, locale)` from `@wishlist/shared`. The locale is detected from `ctx.from.language_code` via `detectLocale()`.

---

## Fallback Outside Telegram

- `window.Telegram?.WebApp` will be `undefined`.
- Mini App shows error screen: "Open via Telegram" (no API calls, no crash).
- For development: use `X-TG-DEV` header to bypass auth.
- Telegram Desktop and Mobile have slightly different WebView behaviors.
- Telegram WebView does NOT change `visualViewport.height` when keyboard opens.

---

## Edge Cases

### Handled
- Bot token missing: prints warning, enters idle loop (no crash).
- Guest opens own wishlist: auto-detected, switches to owner view.
- Share token not generated yet: created on first share request.
- Telegram initData expired: API returns 401, frontend shows error.
- Bot fails to set menu button: error caught, logged, continues.
- Duplicate payments: idempotency via unique `telegramChargeId` / `telegramPaymentChargeId`.
- Self-send hint: detected and blocked with user-friendly message.

### Known Limitations
- Long polling only -- may need webhook for scaling.
- No rate limiting on bot commands.
- Chat ID stored only on `/start` -- if user blocks/restarts, chatId may be stale.
- No retry mechanism for failed Telegram notifications.
- Notification queue is in-memory -- lost on restart.
