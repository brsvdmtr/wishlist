# Secret Santa — Architecture Document v2.2

> **Status:** Batch 1 deployed. Batch 2 approved to start.
> **Last updated:** 2026-03-18
> v2.1 — 5 final clarifications codified
> v2.2 — 8 pre-Batch-2 invariant rules added (§19)

---

## 1. Feature Overview

"Тайный Санта" is a seasonal group gift-exchange feature embedded in the WishBoard Telegram Mini App. Users form a campaign, optionally link their wishlists, trigger an anonymous draw, and exchange gifts. The feature is time-gated (season window), plan-gated for advanced features, and strictly enforces giver↔receiver anonymity at every layer.

---

## 2. Data Model

### 2.1 New Enums

```prisma
enum SantaCampaignStatus {
  DRAFT             // Owner building, not yet joinable
  OPEN              // Accepting participants
  LOCKED            // Closed to new joins, draw not yet run
  DRAW_IN_PROGRESS  // Draw job is actively running (lock state)
  ACTIVE            // Draw complete, gifts being prepared
  COMPLETED         // All gifts marked received/done
  CANCELLED         // Manually cancelled by owner or admin
}

enum SantaCampaignType {
  CLASSIC           // Each person gives to exactly one other
  MULTI_WAVE        // Multiple rounds; PRO only
}

enum SantaParticipantStatus {
  INVITED           // Invite sent, not yet accepted
  JOINED            // Active participant
  LEFT              // Voluntarily left before draw
  REMOVED           // Removed by organizer before draw
}

enum SantaGiftStatus {
  PENDING           // Draw done, not started
  BUYING            // Giver has marked "buying"
  SENT              // Giver has marked "sent"
  RECEIVED          // Receiver confirmed receipt
}

enum SantaDrawStatus {
  PENDING
  IN_PROGRESS
  DONE
  FAILED
}

enum SantaHintStatus {
  PENDING
  APPROVED
  REJECTED
}

enum SantaNotificationType {
  JOINED
  LEFT
  DRAW_DONE
  GIFT_STATUS_CHANGED
  HINT_REQUEST
  HINT_RESPONDED
  CAMPAIGN_CANCELLED
}
```

### 2.2 Core Models

```prisma
model SantaSeasonConfig {
  id                    String   @id @default(cuid())
  seasonYear            Int      @unique
  seasonStartAt         DateTime
  seasonEndAt           DateTime
  campaignCreateEnabled Boolean  @default(true)
  // campaignCreateEnabled can be toggled by admin independently of date window
  // canCreateCampaign = effectiveInSeason && campaignCreateEnabled (NEVER mutated automatically)
  updatedAt             DateTime @updatedAt
}

model SantaCampaign {
  id              String               @id @default(cuid())
  title           String
  description     String?
  type            SantaCampaignType    @default(CLASSIC)
  status          SantaCampaignStatus  @default(DRAFT)
  ownerId         String
  inviteToken     String               @unique @default(cuid())
  // inviteToken is ALWAYS non-null. Revocation happens via status=CANCELLED.
  // Token rotation is NOT supported in Batch 1.
  minBudget       Int?
  maxBudget       Int?
  currency        String               @default("RUB")
  drawAt          DateTime?            // Scheduled auto-draw time (optional)
  seasonYear      Int
  cancelledAt     DateTime?
  cancelReason    String?
  createdAt       DateTime             @default(now())
  updatedAt       DateTime             @updatedAt

  owner           User                 @relation("OwnedSantaCampaigns", fields: [ownerId], references: [id], onDelete: Restrict)
  // onDelete: Restrict — prevents user account deletion while owning an active campaign.
  // User must cancel all owned campaigns before account deletion is allowed.
  participants    SantaParticipant[]
  rounds          SantaRound[]
  notifications   SantaNotification[]
  auditLogs       SantaAdminAuditLog[]
}

model SantaParticipant {
  id                String                  @id @default(cuid())
  campaignId        String
  userId            String
  status            SantaParticipantStatus  @default(JOINED)
  linkedWishlistId  String?
  joinedAt          DateTime                @default(now())
  leftAt            DateTime?

  campaign          SantaCampaign           @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  user              User                    @relation(fields: [userId], references: [id], onDelete: Cascade)
  linkedWishlist    Wishlist?               @relation(fields: [linkedWishlistId], references: [id], onDelete: SetNull)
  // onDelete: SetNull — emergency DB-level fallback ONLY.
  // Service layer MUST block wishlist deletion/archiving if linked to an active campaign (409 error).
  giverAssignments  SantaAssignment[]       @relation("GiverAssignments")
  receiverAssignments SantaAssignment[]     @relation("ReceiverAssignments")
  chatMessages      SantaChatMessage[]
  readCursors       SantaChatReadCursor[]
  pollVotes         SantaPollVote[]
  hintRequests      SantaHintRequest[]      @relation("HintRequester")
  hintResponses     SantaHintRequest[]      @relation("HintResponder")

  @@unique([campaignId, userId])
}

model SantaRound {
  id          String          @id @default(cuid())
  campaignId  String
  roundNumber Int             @default(1)
  drawStatus  SantaDrawStatus @default(PENDING)
  drawJobId   String?         // Idempotency key for draw job; set before draw starts
  drawnAt     DateTime?
  createdAt   DateTime        @default(now())

  campaign    SantaCampaign   @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  assignments SantaAssignment[]
  polls       SantaPoll[]

  @@unique([campaignId, roundNumber])
}

model SantaAssignment {
  id              String          @id @default(cuid())
  roundId         String
  giverParticipantId   String
  receiverParticipantId String
  giftStatus      SantaGiftStatus @default(PENDING)
  giftNote        String?         // Giver's private note
  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt

  round           SantaRound      @relation(fields: [roundId], references: [id], onDelete: Cascade)
  giver           SantaParticipant @relation("GiverAssignments", fields: [giverParticipantId], references: [id], onDelete: Cascade)
  receiver        SantaParticipant @relation("ReceiverAssignments", fields: [receiverParticipantId], references: [id], onDelete: Cascade)
  giftProgress    SantaGiftProgress[]
  hintRequests    SantaHintRequest[]

  @@unique([roundId, giverParticipantId])
  @@unique([roundId, receiverParticipantId])
  // Both uniques enforced: one person gives once, one person receives once per round.
}

model SantaGiftProgress {
  id           String          @id @default(cuid())
  assignmentId String
  status       SantaGiftStatus
  note         String?
  createdAt    DateTime        @default(now())

  assignment   SantaAssignment @relation(fields: [assignmentId], references: [id], onDelete: Cascade)
}

model SantaExclusion {
  id         String   @id @default(cuid())
  campaignId String
  userId1    String
  userId2    String
  createdAt  DateTime @default(now())

  @@unique([campaignId, userId1, userId2])
}

model SantaHintRequest {
  id             String          @id @default(cuid())
  assignmentId   String
  requesterParticipantId String
  responderParticipantId String
  question       String
  answer         String?
  status         SantaHintStatus @default(PENDING)
  createdAt      DateTime        @default(now())
  respondedAt    DateTime?

  assignment     SantaAssignment  @relation(fields: [assignmentId], references: [id], onDelete: Cascade)
  requester      SantaParticipant @relation("HintRequester", fields: [requesterParticipantId], references: [id], onDelete: Cascade)
  responder      SantaParticipant @relation("HintResponder", fields: [responderParticipantId], references: [id], onDelete: Cascade)
}

model SantaChatMessage {
  id              String           @id @default(cuid())
  campaignId      String
  participantId   String
  body            String
  createdAt       DateTime         @default(now())
  // Ordering: always by (createdAt, id) tuple — createdAt for time grouping, id as tiebreaker.

  campaign        SantaCampaign    @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  participant     SantaParticipant @relation(fields: [participantId], references: [id], onDelete: Cascade)

  @@index([campaignId, createdAt, id])
}

model SantaChatReadCursor {
  id                String           @id @default(cuid())
  campaignId        String
  participantId     String
  lastReadMessageId String?          // ID of last read message
  lastReadAt        DateTime?        // Timestamp of last read message's createdAt
  updatedAt         DateTime         @updatedAt
  // Unread count query: messages WHERE (createdAt, id) > (lastReadAt, lastReadMessageId)
  // Using composite comparison on the (createdAt, id) index.

  campaign          SantaCampaign    @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  participant       SantaParticipant @relation(fields: [participantId], references: [id], onDelete: Cascade)

  @@unique([campaignId, participantId])
}

model SantaPoll {
  id         String        @id @default(cuid())
  roundId    String
  question   String
  options    Json          // String[]
  closedAt   DateTime?
  createdAt  DateTime      @default(now())

  round      SantaRound    @relation(fields: [roundId], references: [id], onDelete: Cascade)
  votes      SantaPollVote[]
}

model SantaPollVote {
  id            String           @id @default(cuid())
  pollId        String
  participantId String
  optionIndex   Int
  createdAt     DateTime         @default(now())

  poll          SantaPoll        @relation(fields: [pollId], references: [id], onDelete: Cascade)
  participant   SantaParticipant @relation(fields: [participantId], references: [id], onDelete: Cascade)

  @@unique([pollId, participantId])
}

model SantaNotification {
  id         String                   @id @default(cuid())
  campaignId String
  userId     String
  type       SantaNotificationType
  payload    Json?
  readAt     DateTime?
  createdAt  DateTime                 @default(now())

  campaign   SantaCampaign            @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  user       User                     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model SantaAdminAuditLog {
  id         String        @id @default(cuid())
  campaignId String
  actorId    String
  action     String
  payload    Json?
  createdAt  DateTime      @default(now())

  campaign   SantaCampaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)
}
```

### 2.3 Changes to Existing Models

**User:**
```prisma
// Add:
santaTestMode          Boolean              @default(false)
ownedSantaCampaigns    SantaCampaign[]      @relation("OwnedSantaCampaigns")
santaParticipations    SantaParticipant[]
santaNotifications     SantaNotification[]
```

---

## 3. Campaign Status Machine

```
DRAFT → OPEN → LOCKED → DRAW_IN_PROGRESS → ACTIVE → COMPLETED
                                                    ↘
                ← (any except COMPLETED) ← CANCELLED
```

### Status semantics:

| Status | Meaning |
|--------|---------|
| `DRAFT` | Owner is configuring; not joinable yet |
| `OPEN` | Accepting participants via invite link |
| `LOCKED` | No new joins; draw not yet triggered |
| `DRAW_IN_PROGRESS` | Draw job is running (mutex state, blocks re-trigger) |
| `ACTIVE` | Draw complete; assignments exist |
| `COMPLETED` | All gifts exchanged |
| `CANCELLED` | Owner or admin cancelled; inviteToken effectively revoked |

**Draw status separation:**
`SantaCampaign.status = DRAW_IN_PROGRESS` is the campaign-level lock.
`SantaRound.drawStatus` (`PENDING | IN_PROGRESS | DONE | FAILED`) tracks the draw job internally.
Together they make the draw atomic and idempotent.

---

## 4. Invite Token Contract

- `inviteToken` is **always non-null** (set at creation, never rotated in Batch 1).
- **Revocation = campaign cancellation.** A cancelled campaign returns 410 Gone on invite link access.
- Bot deep-link: `/start santa_{inviteToken}` → opens mini app to join screen.
- Token rotation (regenerate on demand) is deferred to a later batch.

---

## 5. canCreateCampaign Rule

```typescript
// Computed at request time — NEVER mutates SantaSeasonConfig
function canCreateCampaign(config: SantaSeasonConfig, user: User): boolean {
  const now = new Date();
  const effectiveInSeason = user.santaTestMode
    ? true  // godMode users bypass season dates
    : now >= config.seasonStartAt && now <= config.seasonEndAt;
  return effectiveInSeason && config.campaignCreateEnabled;
}
```

- `config.campaignCreateEnabled` is an admin-controlled flag (can disable creates mid-season without touching dates).
- `user.santaTestMode` bypasses only the date window; `campaignCreateEnabled=false` blocks everyone including test users.
- This is a **pure computed rule**, never stored as a field on User or Campaign.

---

## 6. Draw Algorithm

1. **Pre-check:** Hopcroft-Karp feasibility — verify a valid assignment exists given exclusion constraints. If not feasible, return 422 with reason.
2. **Lock:** `UPDATE santa_campaigns SET status='DRAW_IN_PROGRESS' WHERE id=? AND status='LOCKED'` — if 0 rows updated, another job already owns the draw (idempotent exit).
3. **Assign:** Fisher-Yates shuffle with backtracking on exclusion violations. Runs in-memory on the participant list.
4. **Write:** Bulk insert `SantaAssignment` rows inside a transaction. Set `round.drawStatus = DONE`, `round.drawnAt = now()`, `campaign.status = ACTIVE`.
5. **Failure:** If draw fails (e.g., no valid assignment possible after shuffle), set `round.drawStatus = FAILED`, `campaign.status = LOCKED` (allows retry).
6. **`drawJobId`:** Set to a UUID before starting; used to detect and de-duplicate retries.

---

## 7. Anonymity Enforcement

Anonymity is enforced at **three independent layers** — all three must hold:

| Layer | Mechanism |
|-------|-----------|
| **Endpoint contracts** | Receiver-info endpoints use campaign-centric paths (`/tg/santa/campaigns/:id/inbound/*`); no assignment ID ever exposed to receiver |
| **Role-aware serializers** | `serializeAssignment(assignment, requestorRole)` omits giver fields for receiver, omits receiver fields for giver |
| **Service-layer guards** | `SantaService.getAssignment(userId, assignmentId)` verifies caller is the giver; `getInboundInfo(userId, campaignId)` verifies caller is the receiver |

**Anonymity test suite** (mandatory before Batch 1 merge):
- Receiver cannot GET their own assignment ID
- Giver cannot discover receiver's wishlist without going through their assignment
- Cross-participant leakage: user A cannot read user B's assignment info

---

## 8. Receiver Flow (Campaign-Centric)

Receiver never knows their assignment ID. All inbound endpoints are campaign-scoped:

```
GET  /tg/santa/campaigns/:id/inbound/profile   → receiver gets giver's anonymized info
GET  /tg/santa/campaigns/:id/inbound/wishlist  → giver gets receiver's wishlist items
POST /tg/santa/campaigns/:id/inbound/hints     → giver sends hint question to receiver
GET  /tg/santa/campaigns/:id/inbound/hints     → receiver sees pending questions
POST /tg/santa/campaigns/:id/inbound/hints/:hintId/answer → receiver answers
```

Server resolves the actual `SantaAssignment` by looking up `(roundId, giverParticipantId)` or `(roundId, receiverParticipantId)` from the authenticated user's participation.

---

## 9. Season Gate

```
GET /tg/santa/season
→ {
    inSeason: boolean,           // effectiveInSeason (respects santaTestMode)
    canCreate: boolean,          // inSeason && config.campaignCreateEnabled
    seasonStart: ISO8601 | null,
    seasonEnd: ISO8601 | null,
    testMode: boolean            // user.santaTestMode (godMode users only)
  }
```

- If no `SantaSeasonConfig` exists for current year → `inSeason: false`, `canCreate: false`.
- Frontend shows/hides Santa entry point based on `inSeason`.
- God mode toggle for `santaTestMode` is in Profile screen → God Mode section (existing pattern).

---

## 10. Account Deletion Guard

`DELETE /tg/me/account` must block if the user owns any campaign with status NOT IN (`COMPLETED`, `CANCELLED`):

```typescript
const activeCampaigns = await prisma.santaCampaign.findMany({
  where: {
    ownerId: userId,
    status: { notIn: ['COMPLETED', 'CANCELLED'] },
  },
  select: { id: true, title: true, status: true },
});

if (activeCampaigns.length > 0) {
  return res.status(409).json({
    error: 'active_santa_campaigns',
    message: 'Cancel or complete your Secret Santa campaigns before deleting your account.',
    campaigns: activeCampaigns.map(c => ({ id: c.id, title: c.title, status: c.status })),
  });
}
```

Frontend shows friendly message listing campaign titles with a link to cancel them.

---

## 11. Wishlist Delete/Archive Guard

When deleting or archiving a wishlist, check for active Santa links:

```typescript
const activeSantaLink = await prisma.santaParticipant.findFirst({
  where: {
    linkedWishlistId: wishlistId,
    campaign: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
  },
  include: { campaign: { select: { title: true } } },
});
if (activeSantaLink) {
  return res.status(409).json({
    error: 'wishlist_in_santa_campaign',
    campaignTitle: activeSantaLink.campaign.title,
  });
}
```

This guard runs for both `DELETE /tg/wishlists/:id` and `POST /tg/wishlists/:id/archive`.

---

## 12. Chat — Message Ordering & Unread Count

**Message ordering:** Always by `(createdAt, id)` composite — `createdAt` for chronological grouping, `id` (cuid, lexicographically monotone) as tiebreaker for same-millisecond messages.

**Index:** `@@index([campaignId, createdAt, id])` on `SantaChatMessage`.

**Unread count:**
```sql
SELECT COUNT(*) FROM santa_chat_messages
WHERE campaign_id = ?
  AND (created_at, id) > (?, ?)   -- cursor pair: lastReadAt, lastReadMessageId
  AND participant_id != ?          -- exclude own messages
```

**Cursor update:** When user opens chat or scrolls to bottom, PATCH cursor with `{ lastReadMessageId, lastReadAt }` of the newest visible message.

**`SantaChatReadCursor` fields:**
- `lastReadMessageId String?` — ID of last read message
- `lastReadAt DateTime?` — `createdAt` of last read message (needed for composite comparison)

---

## 13. API Endpoints — Batch 1

### Season
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/tg/santa/season` | User | Season status + canCreate |
| `POST` | `/tg/santa/season/test-mode` | GodMode | Toggle `User.santaTestMode` |

### Campaigns
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/tg/santa/campaigns` | User | Create campaign (season-gated) |
| `GET` | `/tg/santa/campaigns` | User | My campaigns (owned + joined) |
| `GET` | `/tg/santa/campaigns/:id` | Participant | Campaign detail |
| `PATCH` | `/tg/santa/campaigns/:id` | Owner | Update title, description, budget, drawAt |
| `POST` | `/tg/santa/campaigns/:id/open` | Owner | DRAFT → OPEN |
| `POST` | `/tg/santa/campaigns/:id/lock` | Owner | OPEN → LOCKED |
| `POST` | `/tg/santa/campaigns/:id/cancel` | Owner | → CANCELLED |
| `POST` | `/tg/santa/campaigns/:id/draw` | Owner | Trigger draw (LOCKED → DRAW_IN_PROGRESS) |

### Participants
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/tg/santa/invite/:token` | User | Resolve invite (→ campaign preview) |
| `POST` | `/tg/santa/campaigns/:id/join` | User | Join via invite token |
| `POST` | `/tg/santa/campaigns/:id/leave` | Participant | Leave (before draw only) |
| `DELETE` | `/tg/santa/campaigns/:id/participants/:uid` | Owner | Remove participant (before draw) |
| `PATCH` | `/tg/santa/campaigns/:id/wishlist` | Participant | Link/unlink wishlist |

### Exclusions
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/tg/santa/campaigns/:id/exclusions` | Owner | List exclusions |
| `POST` | `/tg/santa/campaigns/:id/exclusions` | Owner | Add exclusion |
| `DELETE` | `/tg/santa/campaigns/:id/exclusions/:id` | Owner | Remove exclusion |

### Inbound (Receiver-centric, post-draw)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/tg/santa/campaigns/:id/inbound/wishlist` | Giver | Get receiver's wishlist |
| `GET` | `/tg/santa/campaigns/:id/inbound/hints` | Receiver | See pending hint questions |
| `POST` | `/tg/santa/campaigns/:id/inbound/hints` | Giver | Ask receiver a question |
| `POST` | `/tg/santa/campaigns/:id/inbound/hints/:hintId/answer` | Receiver | Answer hint |

### Gift Status (post-draw)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `PATCH` | `/tg/santa/campaigns/:id/gift-status` | Giver | Update own gift status |
| `POST` | `/tg/santa/campaigns/:id/confirm-received` | Receiver | Confirm gift received |

### Chat
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/tg/santa/campaigns/:id/chat` | Participant | List messages (paginated by cursor) |
| `POST` | `/tg/santa/campaigns/:id/chat` | Participant | Send message |
| `PATCH` | `/tg/santa/campaigns/:id/chat/cursor` | Participant | Update read cursor |

---

## 14. Frontend — New Screens (Batch 1)

### New `Screen` values:
```typescript
type Screen = ... | 'santa-home' | 'santa-hub' | 'santa-create' | 'santa-campaign' | 'santa-join';
```

### SantaHomeBlock (on my-wishlists screen)
- Shows only if `inSeason` (from `/tg/santa/season`)
- Shows user's active campaigns summary
- CTA: "Создать кампанию" (if `canCreate`) | "Мои кампании"

### santa-hub screen
- Lists all campaigns (owned + joined) with status badges
- FAB: "Создать" (gated by `canCreate`)

### santa-create wizard
- Step 1: Title, type (Classic/Multi-wave), budget range
- Step 2: Description, optional draw date
- Creates campaign in DRAFT, then opens → OPEN

### santa-campaign screen (basic)
- Campaign info, participant list, invite link with copy button
- Owner controls: Lock, Draw (when LOCKED), Cancel
- Post-draw: shows own assignment (giver view), gift status controls

### santa-join screen
- Shown when opening deep link `/start santa_{token}`
- Shows campaign preview (title, participant count, organizer name)
- "Вступить" button → POST /tg/santa/campaigns/:id/join

---

## 15. Bot Changes (Batch 1)

**`/start` handler — new deep link prefix:**
```typescript
if (startParam.startsWith('santa_')) {
  const token = startParam.slice('santa_'.length);
  // Resolve campaign, build Mini App URL with ?screen=santa-join&token={token}
  // Open Mini App via reply_markup InlineKeyboardButton with WebApp
}
```

---

## 16. Free vs Pro

| Feature | Free | Pro |
|---------|------|-----|
| Create campaign | ✓ (1 active) | ✓ (unlimited) |
| Multi-wave type | ✗ | ✓ |
| Exclusions | ✗ (0) | ✓ (up to 3 per pair) |
| Chat | ✗ | ✓ |
| Polls | ✗ | ✓ |
| Export participants | ✗ | ✓ |

---

## 17. Batch Plan

### Batch 1 — Foundation (6–10 days)
- Prisma migration: all Santa models + enums
- API: season, CRUD campaigns, join/leave/invite, wishlist linking, delete/archive guards, santa-test-mode
- Bot: `/start santa_*` handler
- Frontend: santa state, SantaHomeBlock, santa-hub, santa-create, basic santa-campaign, santa-join

### Batch 2 — Draw + Gift Flow (5–8 days)
- Draw algorithm: Hopcroft-Karp + Fisher-Yates with backtracking
- API: draw trigger, gift status, confirm-received, inbound endpoints, hint system
- Frontend: post-draw views, gift tracking, hint Q&A

### Batch 3 — Social Layer (4–6 days)
- Group chat (Pro)
- Polls (Pro)
- Reveal system (when all gifts received)
- Notifications (Telegram + in-app)

### Batch 4 — Polish (3–4 days)
- Multi-wave support (Pro)
- Admin tools, audit log viewer
- Export, season config management
- Edge cases, anonymity test suite completion

---

## 19. Pre-Batch-2 Invariant Rules (Addendum v2.2)

These 8 rules are binding constraints for all Batch 2+ implementation. Violating any of them is a hard defect.

---

### Rule 1 — Draw cannot be triggered twice

- `POST /tg/santa/campaigns/:id/draw` MUST use an atomic status transition:
  ```sql
  UPDATE santa_campaigns SET status='DRAW_IN_PROGRESS'
  WHERE id=? AND status='LOCKED'
  ```
  If 0 rows updated → return **409 Conflict** (`draw_already_running`). No second draw starts.
- No reset, re-draw, or retry path runs in parallel with an active draw job. Any retry requires campaign to be back in `LOCKED` state (only possible after `round.drawStatus = FAILED`).
- State transitions (`LOCKED → DRAW_IN_PROGRESS → ACTIVE` and `LOCKED → DRAW_IN_PROGRESS → LOCKED` on failure) must be covered by integration tests, not just code comments.
- `SantaRound.drawJobId` is set to a UUID **before** the draw starts; a duplicate job for the same `drawJobId` exits immediately.

---

### Rule 2 — DB invariants are enforced at the schema level

The following invariants must hold and are enforced by the schema's `@@unique` constraints — not application logic alone:

| Invariant | Enforcement |
|-----------|------------|
| One giver per round | `@@unique([roundId, giverParticipantId])` on `SantaAssignment` |
| One receiver per round | `@@unique([roundId, receiverParticipantId])` on `SantaAssignment` |
| Self-pair impossible | Application MUST check `giverParticipantId != receiverParticipantId` before insert; this is NOT enforced at DB level and MUST be enforced in the draw algorithm |
| CLASSIC: N participants → exactly N assignments | Verified post-insert: `count(assignments) == count(activeParticipants)` |
| ONE_TO_ONE pair: exactly 2 assignments A→B and B→A | Not a current type but documented for future: if added, requires a round-type check post-insert |

Tests that must exist:
- Attempt to insert duplicate giver → expect unique constraint violation
- Attempt to insert duplicate receiver → expect unique constraint violation
- Attempt to insert self-pair → expect application error before insert
- Draw produces exactly N assignments for N participants

---

### Rule 3 — Anonymity must not leak through serializers

The serialization layer is the last defense. Rules:

| Caller role | What they get |
|-------------|--------------|
| Owner | Aggregate progress only: `{ pending: N, buying: N, sent: N, received: N }`. No individual pairs ever. |
| Giver | Their own assignment: `{ receiver: { displayName, avatarUrl, wishlistPreview } }`. No `receiverUserId`, no `receiverParticipantId` in any response body. |
| Receiver (inbound) | Signal only: `{ hasGiver: true, giftStatus }`. No giver identity at any point before reveal. |
| Other participant | Zero cross-participant data. |

**`serializeAssignment(assignment, role)`** — this function must exist as a dedicated serializer and be the only place assignment data leaves the service layer. It must be impossible to accidentally return a raw `SantaAssignment` Prisma object to a route handler.

**Stat/aggregate endpoints** (e.g., campaign detail, participant list) must not include fields that allow de-anonymization by correlation (e.g., no "participant X has linked wishlist Y" exposed to other participants if Y uniquely identifies the person post-draw).

**Mandatory anonymity checklist** (must pass before Batch 2 merge):
- [ ] Receiver cannot discover their assignment ID by any API call
- [ ] Giver response does not contain `receiverUserId` or `receiverParticipantId`
- [ ] Owner campaign detail does not expose individual giver↔receiver pairs
- [ ] Cross-participant access: user A cannot GET user B's assignment detail
- [ ] No aggregate/stat endpoint leaks pairing information by correlation

---

### Rule 4 — Receiver flow is permanently campaign-centric

The receiver never addresses resources via `assignmentId`. Receiver endpoints are locked to:

```
/tg/santa/campaigns/:id/inbound/*
```

The server resolves the receiver's assignment by:
```typescript
const participant = await prisma.santaParticipant.findUnique({ where: { campaignId_userId: { campaignId: id, userId: user.id } } });
const assignment = await prisma.santaAssignment.findUnique({ where: { roundId_receiverParticipantId: { roundId, receiverParticipantId: participant.id } } });
```

No shortcut via `GET /tg/santa/assignments/:assignmentId` is ever exposed to receivers. This rule cannot be relaxed in future batches without a full anonymity re-review.

---

### Rule 5 — Validate and execute draw are separate operations

```
GET  /tg/santa/campaigns/:id/draw/validate   → feasibility check only, no side effects
POST /tg/santa/campaigns/:id/draw            → execute draw, triggers full state machine
```

`GET /draw/validate` contract:
- Reads participants + exclusions
- Runs Hopcroft-Karp feasibility check **in memory only**
- Returns `{ feasible: boolean, reason?: string, problematicExclusions?: [...] }`
- **Zero DB writes.** Zero state mutations. Can be called repeatedly.

`POST /draw` contract:
- Does NOT call validate internally (validate is for the UI only)
- Runs its own feasibility pre-check before acquiring the lock
- If infeasible at lock time → returns 422 with reason (not 500)
- If feasible → acquires lock → runs Fisher-Yates → commits atomically

The validate endpoint is specifically for the owner's UI: "Show me if this draw is possible before I commit."

---

### Rule 6 — Impossible constraints produce human-readable errors

When draw is infeasible due to exclusions:

```json
{
  "error": "draw_infeasible",
  "reason": "exclusions_prevent_valid_assignment",
  "message": "С текущими ограничениями жеребьёвка невозможна. Уберите одно из ограничений, чтобы продолжить.",
  "problematicExclusions": [
    { "userId1": "...", "name1": "Анна", "userId2": "...", "name2": "Борис" }
  ],
  "suggestion": "Remove exclusion between Анна and Борис to make draw possible."
}
```

A generic 500 or opaque 422 is never acceptable when the infeasibility is user-caused. The error must name the constraints that prevent the draw. The Hopcroft-Karp analysis naturally produces the minimal vertex cover (König's theorem) — use it to identify the problematic exclusion edges.

---

### Rule 7 — Gift flow is role-aware from day one

Post-draw, no "temporary wide response" that gets narrowed later. The contract is fixed at Batch 2 launch:

**Giver view** (`GET /tg/santa/campaigns/:id/gift-status` with role=giver):
```json
{
  "role": "giver",
  "giftStatus": "BUYING",
  "receiver": {
    "displayName": "Анна К.",
    "avatarUrl": "...",
    "wishlistItems": [...]
  }
}
```
No `receiverUserId`, `receiverParticipantId`, or any cross-linkable identifier.

**Receiver view** (inbound endpoint):
```json
{
  "role": "receiver",
  "giftStatus": "SENT",
  "hasGiver": true
}
```
No giver identity until reveal. `giftStatus` is the only signal exposed before reveal.

**Organizer view** (campaign detail):
```json
{
  "progress": { "pending": 2, "buying": 3, "sent": 1, "received": 0 }
}
```
Individual pairs never exposed to organizer.

---

### Rule 8 — Hints are separate from core draw in Batch 2

Batch 2 scope:
1. Draw validation (`GET /draw/validate`)
2. Draw execution + lock/idempotency (`POST /draw`)
3. Assignment persistence + role-aware serializer
4. Giver view (receiver's wishlist, gift status controls)
5. Receiver inbound view (signal only, no giver identity)
6. Reveal contract skeleton (stubbed, not functional — defines the future interface)

**Hints are Batch 2.5 or Batch 3**, because they independently introduce:
- A new anonymous routing path (`giver → receiver` question without identity exposure)
- A new notification flow (hint request + answer notification)
- A new access-rights matrix (only giver can request; only receiver can answer; neither sees the other's identity in the process)

Adding hints in the same batch as the draw engine risks cascading complexity. They ship when the draw + gift flow is stable.

---

### Batch 2 Implementation Order (binding)

| Step | Endpoint / Component | Notes |
|------|---------------------|-------|
| 1 | `GET /draw/validate` | Hopcroft-Karp, no side effects |
| 2 | `POST /draw` | Lock + Fisher-Yates + atomic commit |
| 3 | Assignment serializer | `serializeAssignment(a, role)` — single codepath |
| 4 | Giver view endpoints | `/gift-status`, `/inbound/wishlist` |
| 5 | Receiver inbound view | `/inbound/*` campaign-centric |
| 6 | Reveal skeleton | Stub with correct interface, no logic yet |
| 7 | Hints (optional, end of batch or 2.5) | Only after steps 1–6 are stable |

---

## 18. Open Questions (Deferred)

- Token rotation (Batch 2+)
- Multi-wave draw sequencing details
- Admin panel for SantaSeasonConfig management
- Notification delivery (Telegram Bot API push vs polling)
- Campaign reveal animation design
