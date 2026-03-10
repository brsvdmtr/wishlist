# FRONTEND_MAP.md - Frontend Code Structure & Screens

## Architecture Overview

The Telegram Mini App is a **single React component** in one file:
- `apps/web/app/miniapp/MiniApp.tsx` (~2170 lines)
- Pure React useState hooks (no Redux/Zustand/Context)
- Inline CSS (no CSS modules, no Tailwind in Mini App)
- No routing library (manual screen state machine)

### Other Web Pages (Next.js App Router)
```
apps/web/app/
  layout.tsx              - Root layout (fonts, metadata)
  page.tsx                - Home page (landing)
  globals.css             - Global styles (Tailwind)
  middleware.ts           - Basic auth for /admin, www redirect
  miniapp/
    layout.tsx            - Mini App layout (no extra wrapping)
    page.tsx              - Mini App page (loads MiniApp component)
    MiniApp.tsx           - THE ENTIRE MINI APP (2170 lines)
  admin/
    page.tsx              - Admin list page
    new/page.tsx          - Create wishlist (admin)
    [id]/page.tsx         - Edit wishlist (admin)
  w/[slug]/
    page.tsx              - Public wishlist page (SSR)
    WishlistClient.tsx    - Client-side wishlist component
    error.tsx             - Error boundary
    not-found.tsx         - 404 page
  app/
    page.tsx              - Authenticated app page
  lib/
    auth.ts               - Auth helpers (localStorage token)
    api-proxy.ts          - API proxy for SSR
    admin-api-client.ts   - Admin API client with X-ADMIN-KEY
```

---

## Design System (MiniApp.tsx constants)

### Colors (C object)
```
bg: '#1B1B1F'           - Page background (dark)
surface: '#26262C'      - Card/surface background
surfaceHover: '#2E2E36' - Hovered surface
card: '#2F2F38'         - Card background (slightly lighter)
accent: '#7C6AFF'       - Primary purple
accentSoft: 'rgba(124,106,255,0.12)' - Purple tint
green: '#34D399'        - Success/reserved green
orange: '#FBBF24'       - Warning orange
red: '#F87171'          - Error/delete red
text: '#F4F4F6'         - Primary text (white-ish)
textSec: '#9CA3AF'      - Secondary text (grey)
textMuted: '#6B7280'    - Muted text (darker grey)
border: 'rgba(255,255,255,0.06)' - Subtle borders
borderLight: 'rgba(255,255,255,0.1)' - Visible borders
```

### Button Styles
- `btnPrimary`: Purple background (#7C6AFF), white text, 14px 24px padding, 14px border-radius
- `btnSecondary`: Soft purple bg, accent text
- `btnGhost`: Transparent bg, muted text
- `inputStyle`: Dark input with border, 14px padding, 14px border-radius

### Typography
- Font: `-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif`
- Title: 20px bold (wishlist title), 26px bold (item detail title)
- Price: 22px bold
- Body: 14px
- Caption: 12-13px

---

## Screen State Machine

```
Type Screen = 'loading' | 'error' | 'my-wishlists' | 'wishlist-detail' |
              'item-detail' | 'share' | 'guest-view' | 'guest-item-detail' |
              'archive' | 'my-reservations'

Flow:
  loading -> error (if no Telegram WebApp)
  loading -> my-wishlists (owner, no startapp param)
  loading -> guest-view (has startapp=share_XXX param)
  loading -> wishlist-detail (owner with startapp=own_wishlistId)

  my-wishlists -> wishlist-detail (tap wishlist)
  my-wishlists -> my-reservations (tap "Забронировано мной" card)
  wishlist-detail -> item-detail (tap item)
  wishlist-detail -> share (tap "Поделиться")
  wishlist-detail -> archive (tap "Архив")

  my-reservations -> guest-item-detail (tap reservation item, sets fromReservations flag)

  guest-view -> guest-item-detail (tap item)
```

---

## Screen Details

### 1. Loading Screen (`screen === 'loading'`)
- Animated emoji spinner
- "Загрузка..." text
- Initializes Telegram WebApp SDK
- Detects: startapp param, user identity, deep link routing

### 2. Error Screen (`screen === 'error'`)
- Shows error message
- "Откройте через Telegram" link if not in Telegram context

### 3. My Wishlists (`screen === 'my-wishlists'`)
- **Data loaded**: GET /tg/wishlists (also lazy-loads GET /tg/reservations after wishlists load)
- **Shows**: List of owned wishlists with itemCount, reservedCount
- **"Забронировано мной" card**: Always visible at the top of the list. Green gradient background when `reservationsCount > 0`, surface color when empty. Shows reservation count. Tap -> navigates to `my-reservations` screen.
- **Actions**:
  - Tap wishlist -> open it
  - Tap "Забронировано мной" card -> my-reservations screen
  - "Создать вишлист" button -> BottomSheet with title + deadline fields
- **Plan limit display**: "Free-план: N из 2 вишлистов"

### 4. Wishlist Detail (`screen === 'wishlist-detail'`)
- **Data loaded**: GET /tg/wishlists/:id/items
- **Header**: Title with pencil edit icon, item count, deadline
- **Buttons**: "Архив", "Поделиться"
- **Privacy notice**: "Ты не видишь, кто и что забронировал — сюрприз!"
- **Item list**: WishCardOwner components with status badges
- **Empty state**: "Пока пусто" with add button
- **FAB**: "+ Добавить желание" fixed bottom button
- **Actions**: Tap item -> item-detail, delete, complete

### 5. Item Detail - Owner (`screen === 'item-detail'`)
- **Shows**: Hero image (230px), title (26px), price (22px), priority pill, description
- **CommentsThread**: If item is RESERVED, shows comment exchange
- **Actions**:
  - "Редактировать" (primary) -> opens item form
  - "Завершить" / "Удалить" (secondary)

### 6. Share Screen (`screen === 'share'`)
- **Data loaded**: POST /tg/wishlists/:id/share-token (generates token if needed)
- **Shows**: Share preview with wishlist title, item count, deep link
- **Actions**:
  - "Скопировать ссылку" -> clipboard
  - "Отправить в Telegram" -> opens Telegram share dialog
- **Privacy notice**: Explains what guests see

### 7. Guest View (`screen === 'guest-view'`)
- **Data loaded**: GET /public/share/:token (or /public/wishlists/:slug fallback)
- **Auto-detect**: If viewer is the owner, switches to owner view
- **Price filters**: "Все", "До 3000", "До 10000", "До 25000"
- **Item list**: WishCardGuest components
- **Actions**: Tap item -> guest-item-detail, reserve/unreserve

### 8. Guest Item Detail (`screen === 'guest-item-detail'`)
- **Shows**: Hero image, title, price, priority, description (read-only)
- **Status badges**: "Забронировано мной", "Уже забронировано", "Доступно"
- **CommentsThread**: If user is reserver, shows comment exchange
- **Actions**: "Забронировать" / "Отменить бронь"
- **Third-party hint**: "Только бронирующий видит эту зону"

### 9. Archive (`screen === 'archive'`)
- **Data loaded**: GET /tg/wishlists/:id/archive
- **Shows**: COMPLETED and DELETED items
- **Actions**: "Восстановить" per item

### 10. My Reservations (`screen === 'my-reservations'`)
- **Data loaded**: GET /tg/reservations
- **Shows**: Items reserved by the current user, grouped by owner (ownerName)
- **Layout**: Owner groups with avatar circles (first letter of ownerName), owner name header, then ReservationCard components for each item
- **Actions**:
  - Tap reservation item -> guest-item-detail (sets `fromReservations` flag)
  - "Снять бронь" button on ReservationCard -> unreserve item (handleUnreserveFromReservations)
- **Mark-read**: Fires `POST /tg/items/:id/comments/mark-read` when viewing an item from reservations
- **Empty state**: Message when no reservations exist
- **Not a Pro feature** — available to all users

---

## Reusable Components

### BottomSheet
- **Props**: isOpen, onClose, title?, children
- **Style**: position:fixed, slides up from bottom, 85vh max height
- **Used for**: Create wishlist, rename wishlist, edit description, reserve item, item form, delete confirmation

### ItemThumb
- **Props**: item (Item | GuestItem)
- **Renders**: Image (52x52 rounded) or emoji fallback
- **Emoji selection**: Deterministic hash of item title -> EMOJIS array

### WishCardOwner
- **Props**: item, onTap, onDelete, onComplete
- **Shows**: Thumb, title, price, priority badge, status indicator
- **Status badges**: "Забронировано" (green), "Куплено" (green)

### WishCardGuest
- **Props**: item, onTap, onReserve, onUnreserve, myActorHash
- **Shows**: Thumb, title, price, priority badge, reservation status
- **CTA**: "Забронировать" / "Отменить бронь" / "Уже забронировано"

### ReservationCard
- **Props**: item (ReservationItem), onTap, onUnreserve
- **Shows**: ItemThumb, title, price, unread comment badge (if `unreadComments > 0`), "Забронировано" pill (green)
- **CTA**: "Снять бронь" button
- **Type**: `ReservationItem = Item & { ownerName: string|null, ownerId: string, unreadComments: number }`

### CommentsThread (module-level component)
- **Props**: commentRole, comments, commentText, setCommentText, commentSending, myActorHash, onDeleteComment, onSendComment, isArchive
- **Design**: Surface card wrapper, chat-bubble style messages
- **Composer**: Textarea (300 char limit) + round send button
- **Message types**: USER (with display name) and SYSTEM (centered, muted)
- **Keyboard handling**: `handleTextareaFocus()` adds 50vh spacer for Telegram WebView

### ShareScreen (inline in MiniApp)
- **Props**: Uses closured state
- **Shows**: Share link preview, copy button, Telegram share button

---

## State Variables (30+ useState hooks)

### Authentication
- `tgRef` - Telegram WebApp SDK reference
- `initDataRef` - Telegram initData string (for API auth header)
- `urlStartParamRef` - Deep link start parameter
- `myActorHashRef` - Computed actor hash for current user

### Owner State
- `wishlists` - Wishlist[] list
- `planLimits` - { wishlists: 2, items: 10 }
- `currentWl` - Currently viewed Wishlist
- `items` - Item[] in current wishlist

### Reservations State
- `reservations` - ReservationItem[] list (items reserved by current user)
- `reservationsCount` - Number of active reservations (from GET /tg/wishlists response)
- `reservationsLoading` - Loading flag for reservations fetch
- `fromReservations` - Boolean flag indicating navigation came from my-reservations screen

### Guest State
- `guestWl` - Guest wishlist data
- `guestItems` - GuestItem[] list
- `priceFilter` - Selected price filter index
- `reservingItem` - Item being reserved (for BottomSheet)
- `guestName` - Name entered for reservation

### UI State
- `screen` - Current screen (Screen type)
- `loading` - Global loading flag
- `toasts` - Toast[] notifications
- `errorMsg` - Error message for error screen

### Forms
- `showCreateWl`, `wlTitle`, `wlDeadline` - Create wishlist form
- `showRenameWl`, `renameWlTitle`, `renameSaving` - Rename wishlist
- `showItemForm`, `editingItem` - Item form state
- `itemTitle`, `itemDescription`, `itemUrl`, `itemPrice`, `itemPriority`, `itemImageUrl` - Item fields
- `itemPhotoFile`, `itemPhotoLocalUrl`, `itemPhotoDeleted`, `photoUploading`, `photoError` - Photo state
- `deletingItem` - Delete confirmation state
- `editingDescription`, `descriptionText` - Description edit

### Comments
- `comments` - CommentDTO[]
- `commentText` - Current comment input
- `commentRole` - 'owner' | 'reserver' | null
- `commentSending` - Loading flag

---

## API Layer

All API calls use `tgFetch()` helper which wraps `fetch()`:
- Adds `X-TG-INIT-DATA` header from `initDataRef`
- Adds `Content-Type: application/json`
- Base URL from `apiBase` prop

Guest API calls use plain `fetch()` to public endpoints.

---

## Key UI Patterns

### Toast Notifications
- Position: fixed, bottom 24px, z-index 200
- Auto-dismiss after 2.5s
- Types: success (green), error (red)
- Stack from bottom

### Keyboard Handling (Telegram WebView)
- Telegram WebView doesn't change `visualViewport.height` when keyboard opens
- Solution: `handleTextareaFocus()` adds temporary 50vh spacer div
- Scrolls textarea to 35% from top of viewport
- Spacer removed on blur

### Back Navigation
- Uses Telegram BackButton API
- `navBack()` function handles screen stack manually
- guest-item-detail -> guest-view (default), or guest-item-detail -> my-reservations (if `fromReservations` flag is set)
- item-detail -> wishlist-detail
- share -> wishlist-detail
- archive -> wishlist-detail
- wishlist-detail -> my-wishlists
- my-reservations -> my-wishlists

### Haptic Feedback
- `tgRef.current?.HapticFeedback?.impactOccurred('medium')` on reserve
- Used sparingly for key actions

---

## Conditional Rendering by Role

| UI Element | Owner | Reserver | Third Party |
|------------|-------|----------|-------------|
| Edit pencil (wishlist title) | Yes | No | No |
| Item form / edit | Yes | No | No |
| Delete item | Yes | No | No |
| Complete item | Yes | No | No |
| Share button | Yes | No | No |
| Archive button | Yes | No | No |
| Reserve button | No | No (unreserve instead) | Yes |
| Comments thread | Yes (if reserved) | Yes | No |
| Description | Full (edit) | Read-only | Read-only |
| "Кто забронировал" | Hidden | N/A | N/A |
| Price filter | No | Yes | Yes |
