# TELEGRAM_FLOW — Telegram Bot & Mini App Integration
> Last updated: 2026-03-17 · Branch: claude/wizardly-satoshi

## Bot Overview

**Bot username**: Configured via `NEXT_PUBLIC_BOT_USERNAME` env (default: WishHub_bot)
**Framework**: Telegraf 4.16.3
**Source**: `apps/bot/src/index.ts` (~1000 lines)
**Runtime**: Long polling (not webhook)

---

## Bot Commands

| Command | Description | Behavior |
|---------|-------------|----------|
| `/start` | Open WishBoard | Shows welcome text + inline keyboard |
| `/start <payload>` | Deep link | Shows "Смотри вишлист" + WebApp button with payload |
| `/help` | Help text | Shows product description |

### /start Handler Details

```
1. Sets per-chat menu button (WebApp type)
2. Stores telegramChatId in User record (for future notifications)
3. If payload present:
   - Replies with inline keyboard button:
     type: web_app
     text: "Смотреть вишлист 🎁"
     url: {MINI_APP_URL}?startapp={payload}
4. If no payload:
   - Replies with welcome text
```

### Menu Button
- Type: `web_app`
- Text: "Вишлист"
- URL: `MINI_APP_URL` (e.g., https://wishlistik.ru/miniapp)
- Set globally via `setChatMenuButton()`

---

## Deep Linking

### Link Format
```
Owner sharing: https://t.me/{BOT_USERNAME}?startapp=share_{SHARE_TOKEN}
```

### Deep Link Flow (Guest)
```
1. Owner generates share link in MiniApp
   -> POST /tg/wishlists/:id/share-token -> returns shareToken
   -> Frontend builds: https://t.me/{BOT_USERNAME}?startapp=share_{shareToken}

2. Owner shares link (clipboard or Telegram share dialog)

3. Guest opens link in Telegram
   -> Telegram sends /start with startPayload = "share_{shareToken}"
   -> Bot replies with inline WebApp button

4. Guest taps WebApp button
   -> Opens Mini App: {MINI_APP_URL}?startapp=share_{shareToken}

5. MiniApp reads startapp param:
   - Extracts share token from "share_XXX" prefix
   - Calls GET /public/share/{token}
   - Loads guest wishlist view
   - Auto-detects if viewer is the owner -> switches to owner view
```

### Deep Link Payload Format
| Prefix | Meaning | Example |
|--------|---------|---------|
| `share_` | Guest wishlist view (share token) | `share_abc123def456` |
| `hint_` | Hint notification → opens item for recipient | `hint_cma1b2c3d4` |
| `draft_` | URL import result → opens drafts screen | `draft_cma1b2c3d4` |
| `{slug}__item_{id}` | Direct item navigation within a wishlist | `my-wishlist__item_cma1b2c3d4` |
| (no prefix) | Legacy: passed as wishlist slug or direct startapp param | `my-wishlist-slug` |

### Link Generation (packages/shared)
```typescript
buildTgDeepLink(botUsername, payload)
  -> https://t.me/{botUsername}?startapp={encodeURIComponent(payload)}

buildTgShareUrl(url, text)
  -> https://t.me/share/url?url={url}&text={text}
```

---

## Telegram WebApp SDK Integration

### Initialization (MiniApp.tsx)
```
1. Check window.Telegram?.WebApp exists
   - If not: show error "Откройте через Telegram"

2. Extract initData from WebApp
   - Store in initDataRef for API auth headers

3. Read startapp param from WebApp.initDataUnsafe
   - Determines initial screen (owner vs guest)

4. Parse user from initData
   - Set tgUser state
   - Compute myActorHash from telegramId

5. Configure WebApp:
   - WebApp.ready()
   - WebApp.expand() - full height
   - WebApp.setHeaderColor(C.bg)
   - WebApp.setBackgroundColor(C.bg)
```

### SDK Features Used
| Feature | Where Used |
|---------|-----------|
| `WebApp.initData` | Auth header for all API calls |
| `WebApp.initDataUnsafe.start_param` | Deep link routing |
| `WebApp.initDataUnsafe.user` | User info display |
| `WebApp.ready()` | Signal loading complete |
| `WebApp.expand()` | Full-height mode |
| `WebApp.setHeaderColor()` | Match dark theme |
| `WebApp.setBackgroundColor()` | Match dark theme |
| `WebApp.BackButton.show/hide/onClick` | Navigation back |
| `WebApp.HapticFeedback.impactOccurred` | Reserve action feedback |
| `WebApp.openTelegramLink(url)` | Share to Telegram |

### BackButton Management
```
Shown on: wishlist-detail, item-detail, share, guest-view,
          guest-item-detail, archive, settings
Hidden on: my-wishlists, loading, error

onClick handlers:
  guest-item-detail -> guest-view
  item-detail -> wishlist-detail
  share -> wishlist-detail
  archive -> wishlist-detail
  wishlist-detail -> my-wishlists
  guest-view -> (no back, it's the entry point for guests)
```

---

## Telegram Authentication (API Side)

### Signature Validation (`validateTelegramInitData`)
```
Input: initData string (URL-encoded key=value pairs)
Process:
  1. Parse key=value pairs
  2. Extract "hash" field
  3. Build data_check_string:
     - Sort remaining pairs alphabetically by key
     - Join with newlines: "key=value\nkey=value"
  4. Compute HMAC-SHA256:
     - secret = HMAC-SHA256("WebAppData", BOT_TOKEN)
     - hash = HMAC-SHA256(secret, data_check_string)
  5. Compare hex(hash) with provided hash
  6. Parse "user" JSON field -> TelegramUser

Output: TelegramUser | null
```

### Dev Bypass
```
In non-production (NODE_ENV !== 'production'):
  - Accept X-TG-DEV header with raw telegramId
  - Skip signature validation
  - Construct minimal TelegramUser: { id, first_name: 'Dev' }
```

---

## Notifications (API -> Telegram)

### Trigger Points
| Event | Recipient | Message Template |
|-------|-----------|-----------------|
| Item reserved | Owner | `🎁 {displayName} забронировал желание «{title}»` |
| Comment (reserver -> owner) | Owner | `💬 {displayName} прокомментировал «{title}»:\n{text}` |
| Comment (owner -> reserver) | Reserver | `💬 Автор прокомментировал «{title}»:\n{text}` |
| Description updated | Reserver | `📝 Описание обновлено в «{title}»` |
| Batch comments | Recipient | `💬 У вас {N} новых комментариев в «{title}»` |
| Wishlist item added/removed/reserved | Subscriber | `🔔 В вишлисте «{title}» у {ownerName} появилось новое желание` |

### Display Name Source
- **Reservation notifications**: `displayName` from reserve request body
- **Comment notifications (reserver)**: `reservationEvents[0].comment` (chosen display name)
- **Comment notifications (owner)**: "Автор" (hardcoded label)

### Notification Queue
- 30-second debounce per `itemId:recipientUserId`
- First message: sent immediately
- Subsequent within window: count accumulated
- After 30s: sends batch summary if count > 0
- In-memory (Map) - lost on server restart (acceptable)

---

## Support Ticket Bridge

A ForceReply-based bridge between user DMs and a Telegram support group.

### Flow:
1. User sends message to bot (any text, not a command)
2. Bot routes message to SUPPORT_GROUP_CHAT_ID (env var)
   → Forwards to group with user's Telegram profile link
3. Support team replies to the forwarded message in the group
4. Bot detects reply to forwarded message
   → Sends reply to original user's chatId via bot.telegram.sendMessage
5. User receives support reply in bot DM

### Configuration:
- `SUPPORT_GROUP_CHAT_ID` env var — Telegram group/channel chat ID
- Support team must have `SUPPORT_GROUP_CHAT_ID` configured
- Bot must be admin in the support group

### Notes:
- One-directional: user → group → user
- Reply routing uses `reply_to_message.forward_origin` to identify original user
- No ticket IDs or threading beyond Telegram message replies

---

## Telegram Billing Webhooks

### Pre-checkout Query
- Telegram sends `pre_checkout_query` when user confirms payment intent
- Bot must answer within 10 seconds: `bot.telegram.answerPreCheckoutQuery(id, true)`
- If not answered: payment fails on user side

### Successful Payment
- Telegram sends `message.successful_payment` after Stars payment
- Bot calls: `POST {API_BASE_URL}/internal/activate-subscription`
  Body: `{ telegramId, chargeId, amount, currency }`
- API creates/extends Subscription record

### Internal activate-subscription endpoint
- `POST /internal/activate-subscription`
- Requires `Authorization: Bearer {ADMIN_KEY}`
- Creates or extends Subscription with 30-day period

---

## Opening MiniApp Outside Telegram

### Behavior
- `window.Telegram?.WebApp` will be undefined
- MiniApp shows error screen: "Откройте через Telegram"
- No API calls made
- No crash

### Known Limitations
- Cannot test Mini App in regular browser without dev bypass
- For development: use X-TG-DEV header
- Telegram Desktop and Mobile have slightly different WebView behaviors
- Telegram WebView does NOT change `visualViewport.height` when keyboard opens

---

## Edge Cases

### Handled
- Bot token missing: bot prints warning and enters idle loop (no crash)
- Guest opens own wishlist: auto-detected, switches to owner view
- Share token not generated yet: created on first share request
- Telegram initData expired: API returns 401, frontend shows error
- Bot fails to set menu button: error caught, logged, continues

### NOT Handled / Gaps
- No webhook support (long polling only) - may need for scaling
- No rate limiting on bot commands
- No graceful shutdown timeout for bot
- Chat ID stored only on /start - if user blocks/restarts, chatId may be stale
- No retry mechanism for failed Telegram notifications
- Telegram initData format is Telegram-controlled; changes would require updating `validateTelegramInitData()` in `apps/api/src/index.ts`
