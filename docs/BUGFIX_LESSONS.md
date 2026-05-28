# Bug-fix Lessons

Structured log of bug fixes — symptom + root cause, lesson, rule, better code.
New entries go at the top.

---

## 2026-05-28 — Referral analytics: `first_*_created` events are not invitee-only — add `hasAttribution` prop

### Symptom

[`docs/research/referral-decision.md § 8`](research/referral-decision.md)
flagged that `referral.first_item_created` (63 events / 30 days) and
`referral.first_wishlist_created` (21 / 30 days) fire for **every** user
on every first wishlist / item create — not just invitees. The names
strongly imply "first item by an invitee", which is what an analyst
needs at launch to compute conversion / qualifying rates. Without a way
to filter, the events mix signal (invitees crossing the qualifying
threshold) with noise (every organic user reaching the same milestone)
and become unusable for the launch dashboard.

This is structural — the hook runs unconditionally from
`wishlists.routes.ts:874` and `:2084`, then enters
`runReferralProgressHook` which emits the event before
`tryQualifyAttribution` even runs. `tryQualifyAttribution` itself
short-circuits cleanly on `no attribution row → not_applicable`, but the
event is already in the DB.

### Lesson

- **Naming a server-authoritative analytics event after a domain it
  doesn't gate is a permanent footgun.** Once the event is in
  `AnalyticsEvent` with a misleading name, every future dashboard query
  has to remember to filter or join the right column. The cheapest fix
  is to keep the name (renaming would break existing queries +
  dashboards built on the 90+ events already in DB) and add a
  disambiguating prop — `hasAttribution: boolean` — that the dashboard
  filters on.
- **The signal we want is `UserProfile.referredByUserId IS NOT NULL`.**
  That column is set only by `tryCreateAttribution` in the bot when
  `config.enabled = true`, so during the current OFF window it's
  uniformly false (matches reality: 0 invitees). When the program flips
  back on, future invitees will surface as `hasAttribution=true`
  without changing the event name.
- **One extra `SELECT referredByUserId FROM UserProfile WHERE userId=?`
  per first-milestone fire is fine.** The hook is bounded — runs once
  per item/wishlist create, low-volume relative to the DB. Don't
  short-circuit on "we'll query when we actually need it" — the cost is
  not the query, the cost is the future analyst stuck reverse-engineering
  whose conversion they're seeing.

### Rule

- **Any analytics event whose name implies an audience or condition
  (`invitee_*`, `paid_*`, `gifted_*`, etc.) must include the
  condition's truth value as a prop**, or be gated so it only fires
  when the condition holds. Naming-only signals get filtered out as
  noise.
- **Before adding a new prop to an analytics event, check that all
  existing call sites still emit it.** `referral.first_wishlist_created`
  and `first_item_created` are emitted only from `runReferralProgressHook`
  — single owner, easy. Multi-emitter events need every caller updated
  in the same commit.

### Better code

- [`apps/api/src/services/referral-hooks.ts:128-150`](../apps/api/src/services/referral-hooks.ts) —
  added one `prisma.userProfile.findUnique({ select: { referredByUserId: true } })`
  before the milestone block; both events now emit
  `props: { hasAttribution }` where `hasAttribution = profile?.referredByUserId != null`.
- [`apps/api/src/services/referral-hooks.test.ts`](../apps/api/src/services/referral-hooks.test.ts) —
  added 3 new tests: invitee→true for first_wishlist, invitee→true for
  first_item, missing UserProfile row→false (defensive). Existing
  "organic user" tests updated to assert `hasAttribution: false`.

### What's NOT in this fix

- **Renaming the events** — would invalidate existing dashboard
  queries and 84+ rows already in `AnalyticsEvent` from the 38-day
  period when the program was accidentally ON. Prop-based
  disambiguation is the cheaper migration.
- **Suppressing the event when `markFirstWishlist`/`markFirstItem`
  no-ops on a repeat call** — the markers are idempotent but the
  current API doesn't return "was this the first call or a no-op?".
  Adding that return type is a separate change with broader impact;
  the dashboard can still answer "distinct users per milestone" via
  `COUNT(DISTINCT userId)` on the event, so the over-emit doesn't
  block the launch metric.
- **Backfilling `hasAttribution` on the existing 84 rows** — they all
  predate the foundation fix (2026-05-27) so `referredByUserId` was
  uniformly NULL on the source profiles. Treat the pre-2026-05-28
  rows as the "uninstrumented" baseline; future launch metrics start
  from the prop's first emission.

---

## 2026-05-28 — Security audit cont'd: Mini App XSS hygiene + Referer-no-referrer

Three Low-severity Mini App findings that the agent flagged in the
2026-05-28 audit + a partial M2 (referer-leak, IP-leak deferred).
Bundled here because individually they're 5-line fixes but the
underlying patterns are worth pinning.

### Findings

1. **L1 — `topbar.innerHTML = ${tgUser.first_name}` self-XSS.** The
   topbar render at `MiniApp.tsx:7846` was old-style imperative DOM
   inside a `useEffect` and used `innerHTML` to interpolate the
   current user's Telegram `first_name`. Self-XSS only (the value is
   from the viewer's own `initDataUnsafe.user`, not another user's
   data), so no cross-user impact. But Telegram permits practically
   any Unicode in profile names including `<`, `>`, `&`, `"` — so
   the user could XSS themselves by setting first_name to
   `<img src=x onerror=alert(1)>`. Real defense-in-depth concern: the
   pattern, if copied to a context where `tgUser` is a foreign
   participant (Santa, group-gift, comments), becomes cross-user.

2. **L2 — `dangerouslySetInnerHTML={{ __html: t('reserve_privacy') }}`.**
   The translation contains a single hard-coded `<b>…</b>` segment.
   Today the values are bundled at build time from
   `packages/shared/src/i18n.ts`, so they're not user-controlled. But
   `dangerouslySetInnerHTML` is forever a load-bearing trust
   assumption: the moment translations move to DB / CMS / runtime
   merge with user overrides, the file becomes a stored-XSS sink.

3. **Partial M2 — `<img>`s render external URLs that leak Referer.**
   12+ `<img src={item.imageUrl}>` callsites + 2 CSS
   `backgroundImage: url(...)` callsites send the page Referer to
   third-party image hosts when fetching. An attacker hosting
   `https://attacker.example/track.gif` as a wishlist item image
   gets the Referer header of every guest who views that wishlist —
   leaks the share-link / public profile URL the viewer was on. Full
   M2 (server-side image proxy) is deferred because of bandwidth
   implications; the Referer-leak portion is closed cheaply via a
   document-level `<meta name="referrer" content="no-referrer">`.

### Lesson

- **`innerHTML` is the wrong primitive for any string that isn't a
  hard-coded constant.** `textContent` / `createElement` are about
  the same length and remove the entire XSS class. The `useEffect`
  + imperative DOM pattern lives in MiniApp.tsx because some
  rendering is outside React's tree (the topbar predates the React
  port); even there, the DOM API is safe-by-default and `innerHTML`
  needs a `// safe — this string came from <constant>` justification
  comment if it stays.
- **`dangerouslySetInnerHTML` should never render a translation
  string verbatim.** Use `<b>` / `<i>` / `<a>` JSX nodes explicitly,
  or write a tiny inline parser that converts a single known tag to
  structured JSX (the pattern we landed: `match(/^(.*?)<b>(.*?)<\/b>(.*)$/s)`).
- **The document-level `referrer` Metadata controls every
  subresource.** `<img>` (per-element `referrerPolicy`), CSS
  `backgroundImage`, fetch, every external load — all of them
  honour the `<meta name="referrer">` policy. Setting it once in
  `app/miniapp/layout.tsx` is a single line that closes the
  Referer-leak class for the entire route.

### Rule

- **No new `innerHTML` writes anywhere in `apps/web`.** Use
  `textContent` for plain strings; use DOM-construction
  (`createElement` + `appendChild`) for structural HTML; use React
  for everything else. If you find existing `innerHTML` while
  touching a region, replace it on touch.
- **`dangerouslySetInnerHTML` requires an explicit
  `// safe — origin: ...` comment** on the same line and proof in
  review that the string is a hard-coded constant (i18n bundle,
  static asset, design-system token). New uses without the comment
  get rejected at review.
- **`apps/web/app/miniapp/layout.tsx` keeps `referrer:
  'no-referrer'`** in its `Metadata`. Removing it requires a
  separate decision logged in
  `docs/design-system/DESIGN_DECISIONS.md` or equivalent.

### Better code

- `apps/web/app/miniapp/MiniApp.tsx:7844-7860` — `innerHTML` block
  rewritten as `replaceChildren` + `createElement` + `textContent`.
- `apps/web/app/miniapp/MiniApp.tsx:20450` —
  `dangerouslySetInnerHTML` block rewritten as inline JSX with a
  `match(/^(.*?)<b>(.*?)<\/b>(.*)$/s)` parser. Falls back to plain
  text if the translation no longer contains a `<b>` segment.
- `apps/web/app/miniapp/layout.tsx` — `metadata.referrer =
  'no-referrer'` added, emits `<meta name="referrer"
  content="no-referrer">` on every Mini App route.

### What's NOT in this fix

- **L4 (`startParam` regex `/^[a-z0-9_-]{10,40}$/i`)** was a
  false-positive. The file's own comment explains the `_-` is
  intentional for legacy ids + test fixtures; tightening would
  break backwards compatibility. The agent's own assessment was
  "not directly exploitable" — kept as-is.
- **L3 (localStorage onboarding flags)** is a privacy / hygiene
  concern, not a security one. The keys (`changelog_seen_id`,
  `gift_notes_onboarded`) hold non-PII state and don't motivate a
  fix.
- **Full M2 (server-side image proxy)** stays deferred. The
  Referer-leak portion is closed by the meta tag; the IP-leak
  portion needs the proxy. Implementing it means an
  `/api/proxy-image` endpoint that re-encodes through sharp,
  reusing the H1 DNS-pin + magic-byte gates from
  `downloadAndProcessImage` — net ~2× server bandwidth on every
  guest view of a wishlist with external images. Cost-vs-coverage
  decision deferred to a dedicated infra spike.

---

## 2026-05-28 — Security audit cont'd: cascade COMPLETED/CANCELLED Santa campaigns on account delete

### Симптом

`DELETE /tg/me/account` is documented to "delete user and all related
data" but the implementation hit a Postgres FK violation in a specific
case: when the user owned COMPLETED or CANCELLED Santa campaigns. The
sequence:

1. Pre-delete guard (`me.routes.ts:1287`) finds active campaigns by
   `status: { notIn: ['COMPLETED', 'CANCELLED'] }`. With only
   completed/cancelled campaigns the list is empty → guard passes,
   returns 200 path.
2. `prisma.user.delete({ where: { id: user.id } })` fires.
3. `SantaCampaign.owner` is declared with `onDelete: Restrict` (schema
   line 1087) — Postgres rejects the user delete because there are
   still FK references.
4. User sees a 500 / unhandled error; account is NOT actually deleted.

Other related entities (Wishlist, Profile, Comment, Hint, etc.) use
`onDelete: Cascade`, so they go away cleanly. SantaCampaign was the
single outlier — intentionally so, to prevent accidental orphaning
mid-campaign — but the handler never cleaned them up after the user
explicitly OK'd deletion.

### Root cause

Mismatch between two layers' definitions of "data to keep":
- The schema's `onDelete: Restrict` says "never cascade-delete a
  campaign just because the owner is gone."
- The handler's pre-check says "block deletion when active campaigns
  exist; completed/cancelled are fine to leave behind."

Neither layer is wrong on its own, but the gap between them — what to
DO with completed/cancelled campaigns at user-delete time — was
unspecified. The default behavior (let Postgres reject) is the worst
possible outcome: the operation fails partway, and the user has no
clear path forward.

### Lesson

- **Every `onDelete: Restrict` relation on a user-aggregate model
  needs an explicit handler-level decision.** Either cascade in code
  (delete the children first, then the user), reassign ownership, or
  block at the API boundary with a clear error. "Just let Postgres
  reject" is never the right answer because the caller can't
  distinguish a real FK violation from a 500.
- **Pre-delete guards and post-delete behavior must agree.** If the
  guard blocks on `status notIn [COMPLETED, CANCELLED]`, the handler
  must explicitly process those statuses before the user delete. The
  guard's filter list is the contract; the handler implements the
  contract.
- **Race-resistant deletes use Serializable + re-check.** A
  concurrent POST that creates a new active campaign between the
  guard and the delete would otherwise either (a) cascade away the
  brand-new campaign or (b) trip the FK. Wrap the cleanup + delete in
  a transaction with a re-check that throws a typed error → translated
  to a 409 at the response boundary.

### Rule

- **For every `onDelete: Restrict` relation pointing at a deletable
  entity, the deleting handler must:**
  1. Run a pre-check that returns a friendly 409 with the blocking
     rows when the relation has any "still-valuable" children
     (active campaigns, in-flight orders, open tickets).
  2. Inside a Serializable txn: re-check the pre-condition,
     explicitly delete the "OK to clean up" children, then delete
     the parent.
  3. Translate the typed race-error to 409, not 500.
- **No `prisma.user.delete()` without an audit of every relation's
  `onDelete` setting.** Cascade relations handle themselves; SetNull
  relations need confirmation that NULL is semantically OK for the
  child; Restrict relations need explicit handler code (the case
  above).

### Better code

`apps/api/src/routes/me.routes.ts:1280-1349`:

```ts
try {
  await prisma.$transaction(async (tx) => {
    const stillActive = await tx.santaCampaign.count({
      where: { ownerId: user.id, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
    });
    if (stillActive > 0) throw new Error('active_santa_campaigns_race');
    await tx.santaCampaign.deleteMany({
      where: { ownerId: user.id, status: { in: ['COMPLETED', 'CANCELLED'] } },
    });
    await tx.user.delete({ where: { id: user.id } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
} catch (err) {
  if (err instanceof Error && err.message === 'active_santa_campaigns_race') {
    return res.status(409).json({ error: 'active_santa_campaigns', ... });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
    return res.status(409).json({ error: 'concurrent_modification', code: 'SERIALIZATION_CONFLICT' });
  }
  throw err;
}
```

### Regression tests

`apps/api/src/routes/me.account-delete.test.ts` — new file, 3 tests:
1. Returns 409 with the campaign list when active campaigns are
   owned (existing guard preserved).
2. Cascades COMPLETED/CANCELLED then deletes the user — verifies
   the call order so the FK Restrict doesn't trip.
3. Returns 409 (not 500) when a new active campaign is created in
   the race window between the outer check and the inner re-check.

### What's NOT in this fix

- The schema-level `onDelete: Restrict` on `SantaCampaign.owner`
  stays — accidental cascade on a mid-event campaign is still the
  greater of two evils. The handler-level cleanup is the right
  layer to apply the user-consented removal.
- Soft-delete / data-export-before-delete is out of scope. If the
  product later adds "download my data" before account close, the
  cleanup logic moves there.
- Participant notification ("the campaign you joined is gone because
  the organizer deleted their account") is deferred. The participants
  cascade away via `SantaParticipant.campaign onDelete: Cascade`, so
  they get no notification today.

---

## 2026-05-28 — Security audit cont'd: god-mode env-only (no DB persistence)

### Симптом

God-mode was stored as `User.godMode` boolean column. The toggle endpoint
(`POST /tg/me/god-mode`) checked `GOD_MODE_TELEGRAM_IDS` env at write time
and flipped the DB flag — but every subsequent read used the DB flag
directly, with NO env re-check. Concrete bypass:

1. Operator A added to `GOD_MODE_TELEGRAM_IDS=A`. Toggles god on →
   `User(A).godMode = true` persisted in DB.
2. Operator A removed from env (incident response, team rotation,
   contractor offboarding). Server restart picks up new env.
3. Operator A's next API request → `getOrCreateTgUser` returns the user
   row with `godMode: true` straight from the DB.
4. Every downstream `if (!user.godMode)` admin gate and every
   `getEffectiveEntitlements(userId, godMode: true)` call still grant
   unlimited PRO / admin endpoints. The env revocation didn't propagate.

The DB column was a parallel source of truth that desynced from the
intended source of truth (env). Same anti-pattern as a session that
caches "is admin" without re-checking the admin allowlist on every
request — works until the allowlist changes.

### Root cause

The toggle endpoint was designed when god-mode was a "dev convenience"
(flip it on for yourself once, no re-auth). The threat model expanded
when god-mode became privilege-granting (PRO entitlement bypass, admin
analytics access, Santa test-mode toggle, etc.). Once it grants
privilege, the access decision MUST be re-evaluated on every request
against the live env allowlist — same way you'd never trust a session
flag for `is_admin` without re-checking your admin table.

The DB column was structurally wrong; it should never have existed.

### Lesson

- **Privilege-granting flags are computed, not stored.** Anything an
  operator's removal-from-env should immediately revoke must be
  derived from env at read time, not stored. Storing it creates a
  desync window where the DB lags the env, and the larger the team /
  the more contractors / the more incidents, the more likely that
  window matters.
- **Toggle endpoints are anti-patterns for env-derived state.** If the
  source of truth is env, "toggle" is semantically meaningless — env
  is set by the operator updating `/opt/wishlist/.env` and restarting,
  not by a HTTP request. The toggle endpoint was a misleading UI
  element that suggested user agency where there was none.
- **Foreign-user privilege reads need the same env check.** It's easy
  to fix the "I see my own god-mode" path and miss the "I'm reading
  ANOTHER user's god-mode for entitlement comparison" path. Both
  `reservations.routes.ts:1203` (owner's god-mode when reserving on
  their wishlist) and `public.routes.ts:483` (owner's god-mode for
  public profile entitlements) read `User.godMode` directly; both
  needed updating to use `isGodModeTelegramId(otherUser.telegramId)`.

### Rule

- **Any new privilege-granting flag (admin, beta, god, dev) must
  derive from env at read time** — not stored in DB, not cached in
  session. If you find yourself writing `await prisma.user.update({
  data: { isAdmin: true } })` for a privilege-granting field, stop —
  there's an `XADMIN_TELEGRAM_IDS` env var you should consult instead.
- **`isGodModeTelegramId(telegramId)` is the only god-mode predicate.**
  Don't read `User.godMode` directly anywhere. The column is
  deprecated and dropped by a follow-up migration; the schema-level
  `@default(false)` keeps existing rows valid until then.
- **When you delete a toggle endpoint, also delete the client UI that
  drives it.** Otherwise the next operator gets a confusing 404 toast
  and may try to "fix" it. The Mini App's god-mode button at
  `screens/profile/ProfileRoot.tsx:1155` was replaced with a read-only
  "env" pill in the same commit as the server change.

### Better code

- `apps/api/src/services/telegram-auth.ts`:
  - New export `isGodModeTelegramId(telegramId)` — pure function over
    `process.env.GOD_MODE_TELEGRAM_IDS`. Whitespace-tolerant
    comma-separated allowlist.
  - `getOrCreateTgUser` now overrides the DB `godMode` field with
    the env-derived value before returning. Every caller using
    `req.tgUser → getOrCreateTgUser → user.godMode` automatically
    gets the live env answer.
- `apps/api/src/services/entitlement.ts:259`:
  - `getEffectiveEntitlements(userId)` (no godMode arg) — looks up
    `telegramId`, passes through `isGodModeTelegramId`. Stops reading
    the deprecated `godMode` column on the auto-resolve path.
- `apps/api/src/routes/reservations.routes.ts:1203`,
  `apps/api/src/routes/public.routes.ts:483` — foreign-user reads
  switch `select: { godMode: true }` → `select: { telegramId: true }`
  and apply `isGodModeTelegramId(otherUser.telegramId)`.
- `apps/api/src/routes/me.routes.ts:1303-1322` — `POST /me/god-mode`
  handler removed (kept as a doc-only comment for the historical
  context). `apps/api/src/index.ts:688` route registration removed in
  the same commit.
- `apps/web/app/miniapp/screens/profile/ProfileRoot.tsx:1140` — the
  interactive toggle button is replaced with a read-only "env" chip
  next to the status text. Operators still see their current god
  state but can't click anything.

### Schema migration

The `User.godMode` column itself is not dropped in this commit. Reason:
schema migrations require a separate rollout discipline (deploy code
that no longer reads the column → wait for full rollout / cache
invalidation → migration that drops the column → wait → ...). Both
steps in one commit are reversible only by another two-step rollback.
A follow-up `prisma migrate` will drop the column once this code has
been live for one full deploy cycle.

Until then: writes to the column stop (toggle removed), reads from the
column stop (`getOrCreateTgUser` overrides, `getEffectiveEntitlements`
no longer reads on the auto-resolve path, foreign-user reads switched).
The remaining DB rows with `godMode: true` are inert.

### Regression tests

- `apps/api/src/services/telegram-auth.test.ts` — 6 new tests on
  `isGodModeTelegramId`: env in/out, empty/unset env, whitespace
  tolerance, null/undefined telegramId, and the regression case
  where stale DB `godMode=true` does NOT grant access if env is
  empty.
- `apps/api/src/services/entitlement.test.ts:592` — rewritten "falls
  back to DB godMode" test to assert env-derived fallback instead.
  Plus a new test asserting NO god-mode when env doesn't include
  the user's telegramId.

---

## 2026-05-28 — Security audit cont'd: URL scheme allowlist на Mini App `<a href>`

Continuation of the 2026-05-28 audit. Closes the Mini App phishing vector
where user-controlled URLs from wishlist items / gift-occasion ideas were
rendered as live `<a href>` links without any scheme validation.

### Симптом

Eight `<a href={X}>` callsites in the Mini App (`MiniApp.tsx:1784, 14818,
16033, 16283`; `screens/calendar/CalendarDetail.tsx:572, 617`;
`screens/guest/GuestViewRoot.tsx:391`; `screens/santa/SantaRoot.tsx:2496`)
took the URL straight from the API response and passed it into `href`
without checking the scheme. The values are user-controlled: a wishlist
owner types the link into their item, and every guest who views the list
sees that link rendered as a clickable anchor.

Concrete attack: owner sets `item.url` to `tg://resolve?domain=evil_bot`.
Guest opens the wishlist in the Mini App, clicks the link, lands on the
attacker's bot inside Telegram. The bot can:

- Phish for Telegram-account-linkable data (claim to be a "WishBoard
  helper", ask for the wishlist code, harvest gift selections).
- Run a /start that adds the user to an attacker-controlled channel.
- Mimic the WishBoard support flow (most users won't notice the bot
  username differs).

Same pattern works for `javascript:alert(1)` and `data:text/html,…` —
blocked in modern Chrome / iOS Safari for top-level navigation, but the
Telegram WebViews on Android trail upstream Chrome by months, and `<a
href="javascript:…">` historically slipped through some embeds.

### Root cause

The Mini App was treating `item.url` as a trusted product link. The
mental model was "users type real product URLs from marketplace pages,
worst case is a 404". The threat model is "user A's wishlist is viewed
by user B, and user A can write whatever scheme they want into a value
that ends up in B's `<a href>`".

This is structurally the same class as the C1 fix above
(escapeTgHtml in Telegram notifications) — user content flowing into a
context with an active interpretation (HTML / URL scheme) — except the
context is `<a href>` in B's browser instead of `parse_mode=HTML` in
B's Telegram notification. Both surfaces need to ask "what scheme /
markup is this string about to be interpreted as?" before rendering.

### Lesson

- **Every `<a href={X}>` in the Mini App where X is user-controlled
  needs scheme validation.** http/https/mailto only. No `tg://`, no
  `javascript:`, no `data:`, no `file:`. The Mini App lives inside
  Telegram so the `tg://` exclusion matters specifically — inside
  Telegram WebViews tg:// links open in-app, which is exactly what an
  attacker wants for a deep-link phishing flow.
- **The URL parser strips control characters as a primary defense, not
  a secondary one.** Newlines / tabs inside a scheme name have
  historically bypassed naïve regex-only checks (`java\nscript:`
  parses as `javascript:` in some browsers). The helper rejects
  control chars before scheme inspection.
- **Wrap once at the boundary, not at every render.** `safeUserUrl()`
  takes the raw URL and returns either the trimmed URL or `null`. The
  callsite either gets a safe URL or falls back to `'#'`. No callsite
  is allowed to do its own scheme checking — they all share the helper
  so the contract is uniform.

### Rule

- **No new `<a href={someUserField}>` in the Mini App without
  `safeUserUrl()`** at the boundary. Lint-rule candidate (not added
  yet): forbid `JSXAttribute[name=href][value.type=JSXExpressionContainer]`
  where the expression is not call-named `safeUserUrl`.
- **`safeUserUrl()` is for USER-CONTROLLED URLs only.** App-constructed
  deep links (the `tg://t.me/…` onboarding CTA, the `WebApp.openInvoice`
  invoice URL the server returned) bypass it because they're trusted
  by construction. Mixing the two cases would block legitimate flows.
- **`rel="noopener noreferrer"` is mandatory** on every external `<a
  target="_blank">` in user content. Modern browsers auto-add noopener,
  but explicit is the contract — and Telegram WebViews on older
  Android trail browsers by months, so we don't rely on the default.

### Better code

- `apps/web/app/miniapp/lib/isSafeUrl.ts` — new file. `isSafeUserUrl()`
  + `safeUserUrl()`. Allowlist: `http:`, `https:`, `mailto:`. Rejects
  control chars + non-allowlisted schemes + relative URLs.
- `apps/web/app/miniapp/lib/isSafeUrl.test.ts` — 15 tests covering
  positives (http/https/mailto + whitespace trim), phishing rejections
  (tg://, javascript:, data:, vbscript:), control-char bypasses,
  internal schemes (file:/chrome:/about:/intent:/ftp:), and malformed
  inputs.
- Eight callsite patches: each `<a href={X}>` is now `<a
  href={safeUserUrl(X) ?? '#'}>` and `rel` is normalised to
  `"noopener noreferrer"`.

### What's deliberately NOT in scope

- The visible chip / link UI is unchanged. If `safeUserUrl()` returns
  null, the anchor still renders but `href='#'` makes the click inert.
  A cleaner UX would render plain text instead — deferred until we see
  whether real users hit the inert state often enough to justify it.
- Cyrillic / look-alike domain detection (`https://wíldberries.ru/...`).
  Punycode confusables are a separate phishing class; out of scope for
  this audit.
- The non-Mini App surfaces (admin web UI, public share page) are
  unchanged — they have their own attack surfaces but didn't surface
  in the Mini App audit scope.

---

## 2026-05-28 — Security audit cont'd: DNS rebinding pin + upload magic-bytes + Helmet

Continuation of the 2026-05-28 audit. Three High/Medium findings tightened
on the upload + network surface; less impactful than the Critical bundle
above but each closes a known defense-gap with a clear, contained patch.

### Симптом

1. **H1 — DNS rebinding TOCTOU в `imageProcessor.ts`.** The
   `downloadAndProcessImage` helper resolves DNS via `assertDnsIsSafe(url)`
   and then calls `fetch(url.href, …)`, which resolves the hostname AGAIN
   at connect time. An attacker controlling DNS for an inbound hostname
   can flip the answer between the two queries: `assertDnsIsSafe` sees a
   public address, `fetch` ends up connecting to `169.254.169.254` / a
   private IP. The audit comment in the file already acknowledged the
   window — this fix closes it.
2. **M1 — Upload MIME claim is client-controlled.** Multer's `fileFilter`
   trusts `file.mimetype` from the multipart Content-Type header. An
   attacker can claim `image/jpeg` while uploading SVG (XML, potentially
   XXE-laden), HEIC, a PDF, or any other format. Sharp does re-encode the
   buffer to JPEG and strip foreign payload, but bytes shouldn't reach a
   decoder at all if they obviously aren't an image.
3. **M3 — No origin-side HSTS / `X-Content-Type-Options` / Referrer-Policy
   на API.** Cloudflare sits in front (2026-05-22) and sets some headers
   itself, but origin-only hardening matters when CF is bypassed (direct
   IP probes, mis-routed CDN edge, internal LAN traffic). Without `nosniff`
   на `/api/uploads/<uuid>.jpg`, a polyglot that slipped past the magic
   gate could be MIME-sniffed as HTML by some browsers.

### Root cause

1. **H1** — `undici`'s default fetch uses the OS resolver, which has no
   coordination with `dns.resolve` calls made earlier in Node. Two calls
   = two queries = two potentially-different answers.
2. **M1** — Defense was assumed to be the sharp re-encoding step. True
   for image-shaped polyglots, but SVG-claimed-as-JPEG is an arbitrary
   XML document that sharp's SVG path will happily process via librsvg.
3. **M3** — Express bootstrap had `corsMiddleware → express.json →
   requestLogger`. No layer added security headers; we relied entirely on
   Cloudflare for HSTS / nosniff / etc. Adding Helmet at origin makes the
   chain defensible-in-depth without changing the CF policy.

### Lesson

- **Validate-then-pin is the only safe pattern for SSRF-sensitive outbound
  HTTP.** `validateUrl()` + `assertDnsIsSafe()` returns the safe IPs; pass
  ONE of them into the connect path so the resolver is never consulted a
  second time. `curl-impersonate.ts` already does this via its `pin`
  option; `imageProcessor.ts` now does it via `undici.Agent({ connect:
  { lookup } })`. Any new outbound fetch in this codebase must follow the
  same pattern — anything else has a TOCTOU window that's exploitable in
  CI/CD environments where the attacker can win the DNS race.
- **MIME claims from the client are client-supplied input.** Treat them
  as you would a `?role=admin` query param. Magic-byte validation is
  cheap and a one-time per-upload cost; it belongs upstream of every
  decoder that touches attacker bytes.
- **Origin headers are not redundant with CDN headers.** Cloudflare and
  origin both set HSTS — fine; the browser deduplicates harmlessly.
  Origin headers protect the paths CF doesn't cover (direct IP, internal
  routing tools, future CDN-less debug deploys).

### Rule

- **Every new outbound `fetch` in API code where the URL is, transitively,
  user-supplied** — must (1) call `validateUrl()` for structure, (2) call
  `assertDnsIsSafe()` for the resolved IPs, (3) construct an `undici.Agent`
  with a pinned-IP `connect.lookup` for the actual request, (4) close the
  agent in `finally`. The four-step pattern is the contract; abbreviated
  forms (skip pinning "just for this one helper") reintroduce the TOCTOU
  window.
- **Every multer-backed route** must call `hasAllowedImageMagic(buffer)`
  (or its format-specific equivalent for non-image uploads) before
  anything downstream — sharp, archive extraction, MIME inference for
  serving — touches the bytes. The MIME claim in `file.mimetype` is a
  weak hint, not a gate.
- **Helmet (or an equivalent header layer) is mandatory on every
  Express bootstrap** in this codebase, even for pure-JSON APIs. CSP
  may be opt-out per-process (irrelevant if no HTML is served), but
  HSTS / `X-Content-Type-Options: nosniff` / `Referrer-Policy` /
  `X-DNS-Prefetch-Control: off` are not negotiable.

### Better code

- `apps/api/src/uploads/imageProcessor.ts`:
  - `downloadAndProcessImage` — `safeIps` from `assertDnsIsSafe` →
    `Agent({ connect: { lookup: (_h, _o, cb) => cb(null, ip, family) } })`
    passed as `dispatcher`. Replaces the previous unpinned `fetch`.
  - `processImage` — calls `hasAllowedImageMagic(buffer)` first; throws
    "Unsupported file type" with the same message multer's fileFilter
    uses, so existing handlers and tests classify the error identically.
- `apps/api/src/index.ts` — `app.use(helmet({ contentSecurityPolicy:
  false }))` between `etag` config and `corsMiddleware`. CSP off because
  the API serves JSON + static images, not HTML.
- Test: `apps/api/src/uploads/imageProcessor.test.ts` — 10 unit tests
  for `hasAllowedImageMagic` covering JPEG/PNG/GIF87/GIF89/WebP positives
  plus SVG/HTML/PDF/BMP/TIFF/HEIC/ZIP negatives plus the < 12-byte floor.

---

## 2026-05-28 — Security audit triage: HTML-injection в Telegram-уведомлениях + quota race на item create/restore

Не классический «прилетел баг — починили», а аудит всего проекта на security
(6 параллельных Explore-агентов). Из 30+ находок четыре прошли валидацию как
эксплуатируемые Critical-сценарии и легли в этот bundle. Остальные — false
positives либо отдельные тикеты в очередь.

### Симптом

Аудит подсветил три класса проблем, все три уже реальные в проде:

1. **Telegram HTML-injection.** Item title, displayName, custom birthday
   message и subscriber-notify metadata интерполируются в i18n-шаблоны и
   отправляются через `sendTgNotification` / `sendTgBotMessage` с
   `parse_mode: 'HTML'` (`apps/api/src/telegram/botApi.ts:32,61`). При этом
   функция `escapeTgHtml()` уже существовала и применялась только в
   `comments.routes.ts`, `commentNotificationQueue.ts` и
   `research-survey-invite.ts` — но НЕ в reservations, items, group-gifts,
   schedulers/reservations, services/items, schedulers/birthday-reminders.
   Любой пользователь мог поставить title `<a href="https://evil">click</a>`
   и владелец вишлиста получал клик-уведомление с реальной ссылкой на
   фишинг-домен.
2. **Item quota race.** `POST /tg/wishlists/:id/items` делал `count() → check
   < limit → create()` снаружи транзакции (`wishlists.routes.ts:1921`). Два
   параллельных POST из одной сессии оба читали count=19 при лимите 20, оба
   проходили гейт, оба создавали → 21 item в FREE-вишлисте. Дешёвый
   monetization-bypass через double-tap кнопки или GraphQL/REST batch.
3. **Item restore quota bypass.** `POST /tg/items/:id/restore` и
   `POST /tg/items/bulk-restore` флипали `status: DELETED|COMPLETED →
   AVAILABLE` без проверки capacity. Поскольку placement-rows у архивных
   item'ов остаются на месте и фильтруются только по item.status в
   `countActivePlacementsInWishlist`, схема create-20 → delete-10 →
   create-10 → restore-10 давала 30 active items при FREE-лимите 20.

### Root cause

**Общий шаблон у всех трёх — "доверять оптимистичной проверке без
транзакции".** Authoring-layer (route handler) считает что `await count()`
даст stable view, пока не дойдёт до `await create/update`. На read-committed
PostgreSQL это просто неправда: между двумя awaits любой concurrent writer
может изменить состояние, на которое мы опирались. C2 и C3 — буквально один
и тот же anti-pattern; шаблон Serializable+P2034 для категорий уже жил в
коде (`wishlists.routes.ts:1685`, `santa.routes.ts:2780`), но не был
распространён на новые state-changing routes.

Для HTML-injection root cause проще: `escapeTgHtml()` появилась с одним
конкретным callsite (comments), и каждый следующий разработчик скопировал
готовый паттерн `sendTgNotification(chatId, t(key, locale, {title}))` без
проверки, что title прошёл через escape. Утилита была, дисциплина её
применения — нет.

### Lesson

1. **`escapeTgHtml()` обязателен на любой interpolation, идущий через
   `parse_mode: 'HTML'`.** Контракт ровно такой: всё, что НЕ из статичного
   i18n-template, escape-нуть на границе в payload. Telegram парсит `<b>`,
   `<a>`, `<code>` — никакой "доверенной" user-controlled строки не
   существует, даже first_name из initDataUnsafe, потому что Telegram
   разрешает почти любые Unicode-символы в profile name (включая `<>&`).

2. **Quota-check pattern должен быть формализован как Serializable txn.**
   В проекте уже есть рабочий шаблон в `wishlists.routes.ts:1685` (Categories
   quota) и `santa.routes.ts:2780` (Santa join cap):
   ```ts
   let outcome: ... | { kind: 'conflict' };
   try {
     outcome = await prisma.$transaction(async (tx) => {
       const cnt = await tx.X.count(...);
       if (cnt >= limit) return { kind: 'over_limit', ... };
       const row = await tx.X.create(...);
       return { kind: 'ok', row };
     }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
   } catch (err) {
     if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
       outcome = { kind: 'conflict' };
     } else throw err;
   }
   if (outcome.kind === 'conflict') return res.status(409).json({ ... });
   ```
   Это shared pattern — копировать целиком, не "оптимизировать".

3. **State-transitions (status DELETED → AVAILABLE) — это тот же class
   как create.** Restore делает то, что create делает: добавляет active
   placement в wishlist. Если create check'ает quota, restore тоже обязан
   check'ать. Если restore не check'ит — это не "minor convenience flow",
   это просто create через back-door. Аналогично работает unarchive любого
   container'а.

4. **Find/replace audit — обязательная часть введения security-utility.**
   Когда добавили `escapeTgHtml()` в одно место — должны были одновременно
   gграрнуть `grep -rn "parse_mode.*HTML"` + `grep -rn "sendTgNotification"`
   и убедиться, что во всех callsites с user input уже стоит escape. Что-то
   вроде ESLint custom rule (или CI lint), которое падает на нескриненный
   interpolation в `t(..., HTML-template)`, было бы лучше. Пока сделали
   manual sweep.

### Rule

- **Новый state-changing route с quota / capacity / dedup check** — обязан
  использовать Serializable txn по шаблону из `wishlists.routes.ts:1685`.
  Снаружи txn разрешена только optimistic fast-path проверка (для UX —
  чтобы не пейлоадить serializable retry на очевидный over-limit). In-tx
  recount — единственный источник истины для capacity.

- **Любой `sendTgNotification` / `sendTgBotMessage` callsite, который
  интерполирует user-controlled значение (item title, display name, custom
  message, search query, comment text)** — должен пропускать значение через
  `escapeTgHtml()` ровно один раз, на границе. Не доверять `t(...)` — i18n
  template даёт только статичный wrap, dynamic substitutions остаются raw.

- **State transitions, которые re-activate ресурсы (status → AVAILABLE,
  archivedAt → null, etc.)** должны проходить тот же entitlement / capacity
  check, что и creation path. Не делать `prisma.X.update({status: ...})` без
  recount.

- **Аудит безопасности новых утилит**: добавил `escape*` / `validate*` /
  `enforce*` helper — в том же PR пройди `grep -rn` по всем потенциальным
  callsite-паттернам (`parse_mode`, `prisma.X.update`, etc.) и убедись, что
  утилита применена во всех релевантных местах. Иначе она становится
  опциональной — а opt-in security utility = uneven coverage.

### Better code

Все три класса фикснуты в одном bundle (этот коммит):

1. **C1 (HTML escape)** — добавлен `escapeTgHtml()` на 9 callsite в 6
   файлах: `reservations.routes.ts:985,1294`, `items.routes.ts:861,932,1001`,
   `group-gifts.routes.ts:383`, `schedulers/reservations.ts:231,240,286`,
   `services/items.ts:131-145`, `schedulers/birthday-reminders.ts:195-204`.
   Регрессии: `telegram/html.test.ts` (юнит) +
   `services/items.test.ts → notifySubscribersOfChange escape regression`.

2. **C2 (Item create race)** — `wishlists.routes.ts:1981+` обёрнут в
   Serializable txn с in-tx recount + P2034 → 409. Pre-tx fast-path
   проверка сохранена для UX (моментальный 402 на очевидный over-limit).

3. **C3 (Restore quota)** — `items.routes.ts:1017+` (single restore) и
   `items.routes.ts:496+` (bulk-restore) — recount всех host-wishlist
   placements в Serializable txn перед статус-флипом. Bulk-restore делает
   greedy allocation: items без места в host-wishlist'е попадают в
   `failed: [{itemId, reason: 'target_limit_reached'}]`. Регрессия:
   `routes/items.routes.test.ts → POST /items/:id/restore — capacity recheck`.

### Что НЕ вошло в этот bundle

Из 30+ находок аудита 4 были подтверждены как Critical. Остальное:

- **DNS rebinding TOCTOU в `imageProcessor.ts:97-104`** (URL-based avatar
  upload) — отдельный фикс с `undici.Agent({connect: {lookup}})` для pin'а
  IP-адреса между `assertDnsIsSafe()` и `fetch()`. Severity High,
  не Critical → отдельный коммит.
- **Item URL scheme allowlist в Mini App** — `<a href={item.url}>` без
  scheme-фильтра позволяет `tg://user?id=...` deeplink, phishing-вектор.
  Отдельный коммит.
- **God-mode flag persisted в DB** — `user.godMode=true` остаётся после
  удаления из `GOD_MODE_TELEGRAM_IDS` env. Insider-only, severity Medium.
- **File upload MIME magic-bytes** — opt-in, отдельный тикет.
- **Mini App `topbar.innerHTML = ${tgUser.first_name}`** — self-XSS only,
  Low.

False positives из аудита:
- Smart Reservations TTL bypass (server controls expiresAt).
- Telegram webhook signature missing (бот на long polling, нет surface).
- Reservation visibility leak (`reserverUserId` виден участникам по
  дизайну, скрыт от OWNER — это работает корректно).

---

## 2026-05-27 — E11 `useExperiment` race: 401 before initData ready → user silently pinned to control

### Симптом

E11 deploy выкатили (`b5ff648`), env vars в контейнере (`EXP_E11_POST_RESERVE_CTA_ENABLED=true`,
`ROLLOUT=50`). Пользователь зашёл, сделал reservation — sheet не показался.
Решил «ну видимо в control попал». Проверил `ExperimentAssignment` — **0 строк**.
Запрос на эндпоинт делался (3 GET'а в access-log за период тестирования),
но все возвращали **401 Unauthorized**.

`docker logs wishlist-prod-api-1`:
```
GET /tg/experiments/e11-post-reserve-cta  → 401  (нет X-TG-INIT-DATA в headers)
GET /tg/experiments/e11-post-reserve-cta  → 401
GET /tg/experiments/e11-post-reserve-cta  → 401
POST /tg/telemetry  → 200  ("x-tg-init-data": "[REDACTED]" — есть!)
```

То есть telemetry POST через тот же `tgFetch` приходит **с** initData header'ом,
а GET на experiments — **без**.

### Root cause

Race условие в порядке React effects:

1. Main MiniApp component монтируется.
2. `useExperiment(tgFetch, 'e11-post-reserve-cta')` объявлен высоко в источнике
   (после `tgFetch` declaration, до tg-context-detected effect).
3. Effect внутри `useExperiment` запускается → вызывает
   `tgFetch('/tg/experiments/...', { method: 'GET' })`.
4. `tgFetch` читает `initDataRef.current` и добавляет header только если оно
   не пустое:
   ```ts
   ...(initDataRef.current ? { 'X-TG-INIT-DATA': initDataRef.current } : {}),
   ```
5. **`initDataRef.current` всё ещё `''` в этот момент** — оно ставится в другом
   `useEffect`, который декларирован ниже по источнику и поэтому стреляет
   позже в reconciliation:
   ```ts
   // line ~7873
   initDataRef.current = tg.initData;  // ← happens AFTER useExperiment's effect
   ```
6. Server отвечает 401.
7. `experiments.ts` ловит `!res.ok` → `variantCache.set(key, 'control')` →
   юзер залочен в control на всю сессию. Следующий mount читает из cache,
   не делает re-fetch.
8. Telemetry POST стреляет позже (после первого user-action), к этому моменту
   `initDataRef.current` уже populated → header приходит → 200.

`tgFetch` не делает retry на 401, и `useExperiment` cache'ировал control —
double-broken.

### Lesson

1. **Порядок React effects = порядок их декларации в источнике.** Hook,
   декларированный высоко в компоненте, стреляет в `useEffect` фазе раньше,
   чем hook ниже — даже если оба `useEffect` без dependencies. Если поздний
   effect устанавливает ref/state, от которого зависит ранний — у тебя
   race.

2. **Refs, читаемые из автоматических http-headers, должны быть «ready-flagged».**
   `initDataRef.current` без сопровождающего `tgReady: boolean` state создаёт
   беззвучный auth-bypass для любого hook'а, который дёрнет `tgFetch` до того,
   как ref заполнится. Boolean-state forces re-renders когда auth готов;
   ref-only — нет.

3. **Cache на негативный ответ = sticky failure.** `experiments.ts` кэшировал
   `control` ИЛИ на success, ИЛИ на `!res.ok`. Это значит, что один transient
   401 (network glitch, race, server-side temp issue) пинит юзера в control
   на всю session — а следующий mount даже не пытается re-fetch. Negative
   cache допустим только когда ты можешь различить «истинно не в treatment»
   и «не смогли получить ответ».

4. **Telemetry hits ≠ experiments hits в проде.** Я проверил, что
   POST `/tg/telemetry` приходит (видел event'ы в DB). Но GET
   `/tg/experiments/:key` не имел отдельной проверки. После деплоя надо
   **explicitly** проверить, что **именно тот endpoint, на который завязана
   фича**, отвечает 200 — а не предполагать, что раз другие запросы из той
   же сессии работают, то и этот тоже.

5. **`ExperimentAssignment` table = ground truth для дебага вариантов.**
   Если после deploy'я никаких assignment'ов нет — endpoint не вызывался
   ИЛИ возвращал error. Это первое место куда смотреть, не «может я
   просто в control попал».

### Rule

- **Любой hook, делающий authenticated GET на mount, должен быть gated на
  ready-flag** для auth context. Pattern:
  ```ts
  const { variant } = useExperiment(tgFetch, KEY, { ready: tgReady });
  ```
  где `tgReady` — это `useState(false)` → `setTgReady(true)` в том же
  effect, где ref'а с initData ставится.

- **`useExperiment` (и аналогичные hook'и) не должны кэшировать `control` на
  `!res.ok`.** Cache write идёт только на successful resolution. Transient
  failures = `isReady: true` (UI moves past loading) НО без cache, чтобы
  следующий mount мог retry.

- **Post-deploy verification для experiment-gated features**:
  ```sql
  SELECT COUNT(*), variant FROM "ExperimentAssignment"
  WHERE "experimentKey" = '<your-key>'
    AND "createdAt" >= '<deploy-ts>'
  GROUP BY 2;
  ```
  Если 0 строк через >5 минут после первого Mini App open — endpoint не
  вызывался или 401. Проверь `docker logs api | grep /tg/experiments`.

- **Никогда не использовать ref-only signaling для auth state.** Если
  что-то зависит от того, что ref заполнен — оно должно зависеть от
  state-flag, который форсит re-render.

### Better code

`apps/web/app/miniapp/lib/experiments.ts`:
- `useExperiment` теперь принимает `{ ready?: boolean }` (default true для
  back-compat). Когда false — effect skip'ает fetch и держит SSR-safe
  default. Когда flip'ает true — effect re-runs и стреляет авторизованный
  GET.
- Negative-cache убран: cache write идёт только на successful path
  (`if (res.ok)`). Transient 401/5xx/network = `isReady: true` без cache
  → следующий mount retry'ит.

`apps/web/app/miniapp/MiniApp.tsx`:
- Новый `tgReady: boolean` state. `setTgReady(true)` происходит в том же
  effect, что и `initDataRef.current = tg.initData`.
- `useExperiment(tgFetch, E11_EXPERIMENT_KEY, { ready: tgReady })`.

3 новых unit-теста в `experiments.test.ts`:
- `ready: false` → fetch не вызывается, state остаётся default.
- `ready` flip false→true → fetch вызывается ровно 1 раз.
- non-OK ответ → НЕ кэшируется; следующий mount делает re-fetch и резолвится.

### Follow-up

- Старые потенциальные жертвы той же race-в-будущем (любой другой
  `useExperiment` или auth-headered GET на mount) — таких сейчас нет
  (`grep useExperiment` показал только E11 caller). Pattern teaching:
  ВСЕ будущие hook'и должны принимать ready-flag.
- Long-term: refactor'ить `tgFetch` чтобы при отсутствии initData он либо
  ждал короткий timeout, либо явно reject'ил с CodedError'ом, чтобы caller
  мог сразу различить «auth race» vs «server 401». Сейчас оба = `res.ok===false`.

---

## 2026-05-27 — Spec drift: untracked документ старше 48 ч теряет валидность line numbers + advise to non-existent code

### Симптом

Спека `docs/research/guest-conversion-spec.md` создана 2026-05-25, лежала
untracked. Через 2 дня я начал implementation по ней. Перед началом
сделал code-audit — нашёл, что:

1. **Все line numbers ~−1200 устарели** — после `git log` показал
   F4 wave extractions (Profile, Showcase, GroupGift, Santa, GiftNotes,
   Guest, Referral кластеры вынесены в отдельные модули, MiniApp.tsx
   ужался ~30k → 23.6k LOC).
2. **Спека рекомендовала добавить beacon в `ref_<CODE>` branch
   MiniApp.tsx — но такого branch'а нет.** `ref_*` обрабатывается только
   ботом (`/start ref_<CODE>`); бот не передаёт payload в Mini App.
3. **Спека говорила про `share_<TOKEN>` prefix — его тоже не существует.**
   Share token = весь `startParam`, обрабатывается catch-all `else if`.
4. **Спека пропустила `profile_<username>` branch и birthday deep link** —
   оба ведут на shared-content view, но не упоминались.

Если бы implement'нул по спеке вслепую, добавил бы код в ветку, которая
никогда не вызывается, и пропустил `profile_` (15-30% share-traffic
по эстимату).

### Root cause

Spec — это **снимок состояния кода в момент написания**. Активная
кодовая база за 2 дня может пройти крупный refactor (в этом случае —
F4 cluster extractions). Архитектурные предположения спеки (какие
branch'и существуют, что обрабатывает Mini App vs бот) могут быть
неверны даже если код не двигался — спека была написана по аудит-документу
`02-analytics-audit.md`, который тоже мог содержать неточности.

### Lesson

Untracked spec > 48 ч в активной кодовой базе = **обязательный
code-audit-pass перед pickup**:
1. Grep всех упомянутых файлов/функций/строк, sanity-check совпадения.
2. Прочитать bootstrap / orchestration ветку ВСЮ (не только описанную
   часть) — спека могла пропустить branches.
3. Verify, что упомянутые архитектурные элементы (branch'и, helper'ы,
   endpoint'ы) реально существуют в коде — не только в имени.
4. Если spec написан по другому doc'у (аудит/research) — этот upstream-doc
   тоже мог устареть.

### Rule

**Before implementing from an untracked spec older than 2 days:**
- Run `git log --since='<spec-date>'` for every referenced file.
- For every referenced line number, read the file at that line and verify
  the described code is there (not drifted).
- For every "branch X / endpoint Y / helper Z" claim, grep the codebase
  and confirm existence.
- Update the spec in-place with corrected line numbers + flag
  architecturally-wrong sections BEFORE writing implementation code.

### Better code (process)

В этой работе спека обновлена in-place перед implementation
(commit … 2026-05-27): добавлен § 10 review log с таблицей расхождений,
переписаны §§ 1-3 с актуальными line numbers, добавлены пропущенные
branches, перенесён `ref_` fix с Mini App на bot-side, добавлен § 6.2
с decision rationale по birthday. Implementation потом прошёл чисто по
обновлённой спеке.

---

## 2026-05-27 — Mini App деплой положил прод: BusyBox `cp -rn` молча НЕ копирует

### Симптом

Сразу после deploy'я `1f762cf` (introduce persistent chunks volume),
пользователь: "теперь миниапп не открывается, висит картинка эта и
все". Скриншот — BootSplash 🎁 WishBot, JS не гидрирует.

Метрики:
- `GET /_next/static/chunks/app/miniapp/page-eb09c6b58bab0faf.js` → 404
  (новый page chunk из этого билда)
- `GET /_next/static/chunks/webpack-19e13427aad3dfc7.js` → 404 (новый
  webpack runtime chunk)
- Origin direct: те же 404
- Build manifest упоминает оба — то есть Next.js ожидает что они
  есть. Просто их **физически нет** в `chunks/` dir внутри контейнера

Volume mount работал, files в `chunks-baked/` присутствовали, владелец
правильный (1001:1001), entrypoint exec'ал манульно — копировал OK. Но
после container start через deploy — новых файлов в volume не было.

### Root cause

**BusyBox `cp -rn src/. dst/` молча пропускает рекурсию в субдиры
которые уже есть в dst.** Воспроизводимый bug в Alpine BusyBox v1.37:

```sh
mkdir -p /tmp/src/sub /tmp/dst/sub
echo NEW > /tmp/src/a.js
echo NEW2 > /tmp/src/sub/b.js
echo OLD > /tmp/dst/old.js

cp -rn /tmp/src/. /tmp/dst/   # exit 0, нет stderr
ls /tmp/dst                    # old.js, sub/ (по-прежнему пустой!)
ls /tmp/dst/sub                # пусто — b.js НЕ скопирован
                               # a.js на верхнем уровне ТОЖЕ не скопирован
```

GNU coreutils (Linux host) handles this case correctly — копирует
recursively. Вот почему мой emergency `sudo cp -rn /tmp/wb-baked/.
/opt/wishlist/web-chunks/` с хоста сработал, а entrypoint внутри
контейнера — нет.

В нашем случае: volume был prepopulated со старыми chunks включая
`app/miniapp/`. Entrypoint запустил `cp -rn baked/. chunks/`. BusyBox
увидел "chunks/app/miniapp/ exists" → НЕ рекурсивался в неё. Новые
chunks которые жили в `baked/app/miniapp/page-eb09c.js` никогда не
попали в volume.

Дополнительный фактор: **Next.js standalone кэширует listing
static-файлов при старте**. Файлы добавленные ПОСЛЕ Next.js boot →
404. То есть entrypoint MUST копировать ДО `exec node server.js`,
иначе бесполезно. (С этим в моём entrypoint всё было ок — cp перед
exec, просто сам cp не сработал.)

### Lesson

1. **BusyBox cp ≠ GNU cp.** Семантика флагов отличается. На Alpine
   контейнерах нельзя слепо использовать GNU-isms. Особенно
   `-rn` + `src/.` trailing dot syntax — broken для существующих
   субдиров.
2. **Silent failure modes** — самые страшные. Exit code 0, нет
   stderr, нет docker logs. Если бы entrypoint логировал
   `baked=N chunks_dir_now=M` после копии, проблема обнаружилась
   бы на первом деплое а не от user complaint.
3. **Local testing в WRONG environment даёт ложное green.** Тестировал
   logic мысленно через GNU cp — там работало. Контейнер Alpine
   BusyBox — другой мир.
4. **Pre-deploy host setup может маскировать container-side bugs.**
   Pre-populated volume через `docker cp` с хоста (GNU tar/cp под
   капотом), а потом ожидал что entrypoint доделает merge. Mismatch
   между моими экспериментами и production-path.
5. **`set -e` + `cmd 2>/dev/null || true`** — anti-pattern для
   defensive error handling. Маскирует именно те ошибки которые надо
   видеть. Лучше явно логировать exit code.
6. **Next.js standalone serves static via build-time-frozen
   manifest.** Files appearing in chunks/ dir после `next start`
   boot — invisible to server. Подтверждённо: `ls chunks/` показывает
   файл, `wget /_next/static/chunks/<that file>` → 404. Entrypoint
   должен мутировать chunks/ ДО запуска node.

### Rule

- **Любой shell скрипт работающий и на dev (macOS/Ubuntu) и в
  prod (Alpine container)** должен быть протестирован НЕПОСРЕДСТВЕННО
  в prod-container окружении до коммита.
  Команда для quick-check: `docker run --rm -v $(pwd)/script.sh:/s alpine sh /s`.
- **Никогда не использовать `cp -rn src/. dst/`** в скриптах
  ориентированных на Alpine/BusyBox. Использовать `find . -type f |
  while read f; do [ -e "$dst/$f" ] || cp "$f" "$dst/$f"; done`
  — portable, semantically explicit.
- **Все entrypoint скрипты должны логировать**: timestamp старта,
  входные пути, summary (n files merged / m skipped), exit code
  каждого подкоманды если ненулевой. `docker logs` — единственное
  окно в startup поведение контейнера.
- **Никаких `command 2>/dev/null || true`** в production
  entrypoint'ах. Использовать `command 2>&1 || echo "[entrypoint]
  $command failed: $?"`. `|| true` маскирует именно те ошибки
  ради видимости которых тулинг и существует.

### Better code

- `ops/web-entrypoint.sh` — переписан с `cp -rn baked/. chunks/`
  на portable find-loop:
  ```sh
  cd "$BAKED_DIR"
  find . -type f | while IFS= read -r REL; do
    DST="$CHUNKS_DIR/${REL#./}"
    if [ -e "$DST" ]; then
      SKIPPED=$((SKIPPED + 1))
    else
      mkdir -p "$(dirname "$DST")"
      if cp "$REL" "$DST"; then
        COPIED=$((COPIED + 1))
      else
        FAILED=$((FAILED + 1))
        echo "$LOG_PREFIX cp failed: $REL -> $DST" >&2
      fi
    fi
  done
  ```
- Добавлен summary log `[web-entrypoint $timestamp] baked=N
  chunks_dir_now=M` — `docker logs wishlist-prod-web-1` теперь
  показывает что entrypoint реально делал.
- Early-return когда BAKED_DIR отсутствует (раньше тихо exec'ил CMD).

### Follow-up

- Stress-test всех остальных shell скриптов в `ops/` и `infra/` на
  BusyBox compatibility. Особенно те что используют GNU-only флаги.
- Рассмотреть переезд с Alpine на debian-slim base image для web —
  устранит класс этих issues. Trade-off: размер +30MB.

### Related

- См. запись ниже того же 2026-05-27 (stale-HTML 404 syndrome) —
  этот bug это последствие фикса предыдущего: при введении
  persistent volume mount я не дотестировал entrypoint на BusyBox.

---

## 2026-05-27 — "опять долгие загрузки": НАСТОЯЩИЙ root cause — stale-HTML 404 на удалённые chunks

### Симптом

Тот же пользователь: `опять долгие загрузки миниаппа`. Сначала прошла
длинная цепочка диагностики (см. запись ниже) — но финальный фикс
оказался про другое.

### Root cause

Next.js standalone build **удаляет старые chunks** при каждом rebuild'е
контейнера. Сегодня деплоев было **три**:

1. `a9a1c5a` — meta description tweak (попытка force rehash, не сработала)
2. `eaf5898` — `id="telegram-webapp-sdk"` Script prop
3. `f8f3cde` — docs only

После каждого `docker compose build web` файловая система контейнера
получает свежий `.next/static/chunks/`, старые файлы исчезают:

```
docker exec wishlist-prod-web-1 ls .next/static/chunks/app/miniapp/
  layout-a8418b884d92b00f.js   (stable across builds — shared next/script boilerplate)
  page-0af2134211eec317.js     (текущий)
  # 0f51 / 727a / older NOT here
```

Telegram WebView (несмотря на `Cache-Control: private, no-cache,
no-store, max-age=0, must-revalidate` на HTML) **держит кэшированный
HTML** через сессии. Cached HTML ссылается на старые chunk URL'ы. После
deploy:

```
GET https://wishlistik.ru/_next/static/chunks/app/miniapp/page-727a926b56d8f149.js
  → origin: 404
  → CF cache: HIT age=77825s   (вчерашний кэш всё ещё живой)

GET https://wishlistik.ru/_next/static/chunks/app/miniapp/page-0f51cd54f855c894.js
  → origin: 404
  → CF cache: 404               (CF не успел закэшировать этот mini-window)
```

Кому повезло — CF держит вчерашний chunk → app работает (но это
бомба замедленного действия, через 24ч age превысит TTL и chunks
протухнут).
Кому не повезло — 404 → ChunkLoadError → React не монтируется → пустой
BootSplash навсегда.

**`MiniAppErrorBoundary` это render-time error boundary** — она НЕ ловит
script/link load failures (они fire'ят `error` на самом элементе, не
bubble'ят через React дерево).

### Lesson

1. **Каждый deploy инвалидирует chunks** — Next.js standalone не
   сохраняет старые. Для пользователей с cached HTML это значит
   404 на ассеты, которые HTML просит.
2. **`Cache-Control: no-store` на HTML не гарантия** — мобильные
   WebView (Telegram, Instagram, FB) часто игнорируют и держат HTML
   в памяти/сторадже WebView ради perceived perf.
3. **React Error Boundary НЕ ловит chunk load fails.** Те — DOM-level
   `error` event на `<script>`/`<link>`, не bubbling.
   `window.addEventListener('error', fn, true)` с capture=true —
   единственный надёжный способ.
4. **Multiple deploys per hour amplify the problem** — каждый rebuild
   создаёт новый "временной слой" chunk-хэшей. Пользователи между
   deploy'ями оказываются в "невозможном" состоянии: их HTML ссылается
   на chunks из эпохи, которую полностью удалили из контейнера и не
   успели затянуть в CF cache.
5. **CF cache HIT может быть PRO** в этом сценарии: keeps yesterday's
   chunks alive at edge for stale HTML users while we deploy. Без
   CF deploy был бы ещё более disruptive. Но age TTL — мина под
   следующее утро.

### Rule

- **Минимум deploys на код-changes per day.** Если уже задеплоил —
  следующий должен быть либо критический фикс, либо подождать день.
- **При жалобе на загрузку Mini App после недавнего deploy'я**:
  - Проверить `docker exec ... ls .next/static/chunks/` на отсутствующие
    chunks
  - Проверить через `curl https://.../old-chunk-url.js` — origin 404
    но CF возможно HIT
  - Это **stale-HTML 404 syndrome**, не network/cache issue
- **Любая глобальная boot-критичная зависимость (chunk, font, CSS)**
  должна иметь client-side error recovery: либо retry, либо reload,
  либо graceful degradation. Happy-path-only мысль "ну будет 200,
  оно всегда 200" — недопустима для production.
- **При deploy на staging/prod где есть mobile WebView**: stress-test
  stale-HTML scenario — fetch HTML, deploy, потом запросить старые
  chunks. Если все 200 от CF и 404 от origin — посчитать TTL до того
  как CF их вытеснит.

### Better code

- `apps/web/app/layout.tsx` — добавлен window-level capturing listener
  `error` event'а через `<Script id="wb-stale-chunk-reload"
  strategy="beforeInteractive">`. Ловит script/link 404 из
  `/_next/static/` → один `location.reload()` (guard'нут
  sessionStorage от loop'а). `load` event сбрасывает guard для
  следующего deploy'я.

### Follow-up

- **[приоритет] Volume mount для chunks**: `wishlist_web_chunks:/app/apps/web/.next/static/chunks` 
  в docker-compose.prod.yml + deploy step "rsync new chunks INTO 
  volume (additive)" чтобы старые chunks выживали rebuild'ы. + 
  cron-prune chunks старше N дней. Это устраняет root cause а не 
  лечит симптом.
- **Generated build ID** в Next.js (`generateBuildId` в next.config) 
  — стабильный per-source-commit ID; не помогает с chunk hash'ами, 
  но даёт способ детектить "old HTML" client-side через 
  `__NEXT_DATA__.buildId` mismatch.
- **CF Cache Reserve** (paid) — persistent backing store для cache; 
  снижает риск что CF вытеснит вчерашние chunks из edge.

### Related

- См. предыдущую запись 2026-05-27 ниже — длинная цепочка 
  ошибочных гипотез (битый brotli, slow path сеть, CF settings) 
  которые отвлекали от настоящего root cause. Урок про **проверять 
  origin filesystem перед обвинением CDN cache**.

---

## 2026-05-27 — Mini App виснет на грузилке: транзиентный slow path между клиентом и CF edge (НЕ битая запись cache)

### Симптом

Пользователь ("опять долгие загрузки миниаппа") видит **пустой тёмный
экран** с грузилкой 🤖 Telegram'а в Mini App. Симптом периодический
("опять") — у части заходов всё ок, у части висит десятки секунд.

Метрики:
- API origin: 0-2 мс (responseTime в pino-логах в норме)
- CPU/память сервера: load 0.00, 33% idle, всё спокойно
- `curl` к `layout-*.js` brotli из дома: разброс 0.3с — 24.8с между запросами
- Тот же URL **из сервера** (50 запросов): 21-101мс, **0 slow**
- HTML страница `/miniapp` стабильно 280-485мс TTFB
- На **одном HTTP/2 connection** все запросы быстрые (94-310мс),
  slow path — только при установке нового TCP+TLS

### Root cause — что НЕ оказалось, и что оказалось

**Первоначальная гипотеза (неверная):** битая brotli-запись в CF edge
cache. Спецификой `cf-cache-status: HIT, age: 73140` казалось что edge
node "застрял" с broken variant'ом.

**Проверка отвергла**: после CF API purge slow path вернулся через
несколько минут на свежий cache. И вылезал не только на `layout-*.js`,
но и на `polyfills-*.js` (112KB), `3324-*.js` (173KB). Размер не
коррелирует, brotli не коррелирует, конкретный POP не коррелирует
(AMS/CPH/WAW/OSL/RIX все показывали slow при разных запросах).

**Настоящий root cause:** транзиентный slow path в установке TCP+TLS
connection между клиентом (мой Mac в Польше, очевидно похожая ситуация
у пользователя в RU) и Cloudflare edge POP. ~3-15% cold connection'ов
получают latency 5-25 секунд вместо нормальных 200-500мс. Из сервера
(прямой backbone path до CF) — 0% slow на 50 попытках. Из браузера на
одном HTTP/2 connection — все subsequent запросы быстрые.

**В реальном браузере** все chunks Mini App'а грузятся по одному
multiplexed HTTP/2 connection после HTML. Slow handshake происходит
один раз — на HTML. Если HTML словил slow path → пустой экран
надолго. Если повезло → быстрая загрузка.

Это **сетевая проблема CF edge ↔ клиент**, не наша инфраструктура.
Origin healthy, CF settings clean, code healthy.

### Lesson

1. **Не каждый "медленный Mini App" = медленный backend.** Когда API
   логи пустые/быстрые, а пользователь видит зависание — следующий
   слой это CF edge / связность / cold-connection handshake.
   Origin-only health-check этого класса бага не словит.
2. **TTFB через `curl` ≠ TTFB через браузер.** `curl` без keep-alive
   делает cold connection каждый раз, поэтому ловит handshake-latency
   на каждом запросе. Браузер — один connection на 100+ ассетов.
   Реалистичный тест: `curl --parallel --parallel-max 1 -o A -o B -o C`
   или просто браузер DevTools Network.
3. **CDN slow path может быть network-side**, не cache-side. Проверять
   и: (a) с разных vantage points (мой Mac, сервер, RU-host),
   (b) с keep-alive vs cold, (c) на разных URL/encodings/POPs.
4. **`cf-cache-status: HIT` не гарантирует быструю отдачу.** HIT =
   "найдено в кэше"; latency сегмента edge→client может быть любой.
5. **Контент-хэш Next.js привязан к compiled output, не source.**
   Изменения в `metadata` / `viewport` / комментариях НЕ меняют hash
   client-chunk'а — Next.js извлекает их при build и в bundle они не
   доходят. Менять надо JSX или импорты.
6. **`layout-*.js` chunk это shared `next/script` boilerplate**, не
   код моего `MiniAppLayout`. Содержимое стабильно от деплоя к
   деплою если не меняется `next` сам. Поэтому правки в
   `apps/web/app/miniapp/layout.tsx` рехешат `page-*.js` (через
   dependency graph), но `layout-*.js` остаётся прежним.
7. **Tiered Cache на CF может УХУДШИТЬ ситуацию** для зон где
   нативная edge-cache топология уже работает — переключает
   запросы на более разнообразные POPs (часть из которых slow).
   Эмпирически проверял: 1/30 slow → 8/30 после enable.

### Rule

- **При жалобе "Mini App виснет / долго грузится"** диагностический
  чеклист:
  1. `docker ps`, `docker logs --since 10m`, `top`, `df -h` на проде
  2. `curl http://localhost:3001/health` и `localhost:3000/miniapp` 
     с сервера — origin sanity
  3. `curl -w '%{time_starttransfer}'` на `/miniapp` и chunks из
     ВНЕШНЕЙ точки, 20+ повторов — поймать P95/P99 от клиента
  4. `jq '.req.url' /opt/wishlist/logs/api/api.log.YYYY-MM-DD` —
     посмотреть распределение трафика, упал ли real-user volume
  5. С keep-alive (`curl --parallel`) — отделить handshake от data
- **Не ставить диагноз "битый CDN cache" на основе одного measurement.**
  Сначала исключить network-side variability через сервер-side
  замеры.
- **CF Tiered Cache** включать только после A/B замера — может
  ухудшить.
- **CF API permissions** для оперативной работы должны включать:
  `Zone Read`, `Cache Purge`, `Zone Settings: Read+Edit`. Без них
  диагностика и mitigation сильно медленнее.

### Better code

- `apps/web/app/miniapp/layout.tsx` — добавлен `id="telegram-webapp-sdk"`
  к `<Script>` (стандартная практика, ничего не ломает). Цель была
  форсировать rehash chunk'а — НЕ сработала, см. lesson #6.
- `apps/web/app/miniapp/layout.tsx` — `metadata.description` точнее
  описывает приложение для SEO. Не влияет на client chunk hash.
- **CF zone settings**: `early_hints: on` (включил, оставил —
  даёт браузеру 103 Early Hints перед HTML 200 → preload подсказки
  доезжают раньше); `tiered_cache: off` (пробовал on, стало хуже,
  откатил).
- **CF cache purge** одного URL сработал точечно — TTFB на нём стал
  стабильнее на час, но потом slow path вернулся; это network
  pattern, а не cache poisoning.

### Follow-ups (не закрыты этим инцидентом)

- **Reduce critical chunk count** в bundle. Cold connection slow path
  ловится только на handshake; уменьшать критический параллельный
  fan-out не помогает (всё на одном HTTP/2). Но **уменьшить общий
  bundle size** — реально, через webpack `splitChunks.minSize` bump
  и `next dynamic import` для не-критичных секций. Меньше байт =
  быстрее даже при slow path.
- **Resource hints в HTML** — `<link rel="preconnect">` к origin
  уже не нужен (тот же origin); но `<link rel="modulepreload">`
  для критичных chunk'ов может ускорить старт.
- **Скрипт `scripts/cf-purge.sh "<url>"`** — wrapper над API token
  в `~/.config/cloudflare/credentials`. Полезно для быстрых
  incident response.
- **Multi-CDN или RU-friendly CDN** (Yandex Cloud / VK CDN) для
  статики — длинный проект, но окончательно решает RU↔CF проблему.
- **Cloudflare support ticket** с примерами cf-ray для slow request'ов
  — пусть смотрят backbone маршрутизацию.

### Related

- См. `feedback_api_html_substitution.md` (2026-05-25) — другой класс
  CF-related bug'ов: подмена API ответа HTML'ом. Похожий принцип:
  слой между клиентом и origin может тихо ломать поверхность.

---

## 2026-05-25 — Maintenance UI ломалось из-за HTML-подмены API ответа (двойной regression)

### Симптом

После релиза `8943664` включил `MAINTENANCE_MODE=true` на проде для
визуальной проверки новой v2.1 заглушки. В Telegram Mini App пользователь
увидел **не нашу новую заглушку**, а generic «Нет связи / Нет
подключения к интернету» с тарелкой 📡 и красной надписью «Ошибка
загрузки». То есть L3-экран maintenance не рендерился совсем.

### Root cause

Два независимых слоя одновременно подменяли JSON-ответ API
`503 + {code:"MAINTENANCE"}` на HTML-заглушку:

1. **nginx** в `location /api/` имел `proxy_intercept_errors on`, в
   сочетании с server-level `error_page 502 503 504 /maintenance.html` →
   503 от API превращался в HTML.
2. **CF Worker** (новый в этом же релизе) проверял `Accept` хедер через
   `wantsHtml()` который возвращал `true` для `*/*` и пустого Accept.
   Браузерный `fetch()` шлёт `Accept: */*` по умолчанию → Worker
   подменял ответ.

В итоге Mini App'овский `tgFetch` получал HTML, не мог распарсить как
JSON, падал в generic error path вместо детекта `code:MAINTENANCE` →
показывал «Нет связи».

Curl-тесты ничего не ловили потому что я использовал `Accept:
text/html` или умолчания, не воспроизводящие fetch().

### Lesson

1. **API endpoints (`/api/*`, `/tg/*`, `/internal/*`) НИКОГДА не должны
   иметь свой ответ подменён HTML'ом ни на каком промежуточном слое.**
   Их потребитель — JS код, ожидающий JSON. HTML ломает парсер →
   fallback на generic error.
2. **Любой fallback по `Accept` хедеру должен требовать ЯВНЫЙ
   `text/html`, а не `*/*`.** Потому что `*/*` — дефолт для fetch/XHR,
   а ему нужен JSON, не HTML.
3. **Тестировать на реальной поверхности (Telegram Mini App), а не
   через curl с произвольными хедерами.** Curl скрыл оба бага.

### Rule

- nginx `proxy_intercept_errors on` — **только** на root location
  (web/Next.js), никогда на /api/, /uploads/, /tg/. Документировать
  комментарием в шаблоне.
- CF Worker / любой edge fallback: `wantsHtml()` = `accept.includes('text/html')`.
  Никаких `*/*` или пустого Accept fallback.
- Любая новая middleware которая мутирует тело ответа: явный guard
  "только для не-API путей" или "только Accept: text/html".

### Better code

- `ops/vultr/nginx-wishlistik.conf.template` — убрал
  `proxy_intercept_errors on;` из `location /api/` и `location /uploads/`,
  добавил комментарий с обоснованием.
- `infra/cloudflare/maintenance-worker/src/index.ts` — `wantsHtml()`
  упрощено до `accept.includes('text/html')`. Регрессионный тест
  `passes through 503 to fetch()/XHR caller (Accept: */*) so Mini App
  sees real JSON` в `test/worker.test.ts`.
- Прод-конфиг nginx обновлён live (`sudo sed -i` + `nginx -s reload`).
- Worker задеплоен `wrangler deploy`.

### Related

- 2026-05-25 follow-up к [этой записи ниже]: исходное обещание
  «уведомим в бот» сломалось ещё и из-за того, что без этого фикса
  L3 экран вообще не показывался, и `POST /tg/maintenance-exposure`
  не уходил → exposure не записывался → recovery-уведомление никому.

---

## 2026-05-25 — Maintenance recovery promise was a half-truth at L1 (post-CF migration)

### Симптом

После миграции на Cloudflare 2026-05-22 пользователи стали получать
**CF-дефолтную страницу `502 Bad Gateway`** вместо нашей красивой заглушки
"Технические работы" при недоступности origin. И главное — обещание из
заглушки "когда восстановится, мы сообщим в бот" в этом сценарии **никогда
не выполнялось**, потому что:

1. Пользователь видел CF 502 (а не нашу `maintenance.html`).
2. Даже если бы видел нашу — статический HTML никакого `POST
   /tg/maintenance-exposure` не делал (его делает только in-app экран из
   `MiniApp.tsx`).
3. Watchdog при recovery шёл по `MaintenanceExposure` строкам в БД и слал
   recovery-сообщение только тем, чьи exposure записаны → L1 пользователи в
   эту воронку не попадали вообще.

Обещание формально было правдой только для L3 (in-app, API в режиме
MAINTENANCE_MODE). Для L1 (origin недоступен с CF edge) — заведомо ложь.

### Root cause

Текст "мы сообщим в бот" жил в `packages/shared/src/i18n.ts` и применялся
**и в** static stub, **и в** in-app экране, **без проверки** что у этих двух
поверхностей радикально разные пути записи exposure:

- L3 in-app: `POST /tg/maintenance-exposure` (API reachable) → строка в
  `MaintenanceExposure` → попадает в `send-recovery-notifications` fan-out.
- L1 static stub: **никакого POST вообще** — пользователь видит HTML, и
  всё. Это устроило бы при наличии записи "в этот момент кто-то был
  exposed", но такой записи не было.

После CF миграции это стало особенно ощутимо, потому что L1 случаи начали
происходить чаще (CF default 5xx ↔ нашей заглушки): любой network blip
между CF edge и нашим origin показывает CF 502, не nginx-овую страницу.

### Lesson

1. **Любое end-to-end обещание ("мы что-то сделаем") должно
   реверс-инженериться от обещания до источника фактов.** Если ты пишешь "мы
   уведомим", открой fan-out код, спроси "откуда берётся список адресатов",
   потом "как туда попадают записи", и проверь что **все** UI-поверхности,
   делающие обещание, попадают в этот список. Иначе обещание превращается в
   обман на доле трафика.
2. **Многослойный fallback требует многослойного контракта.** L1/L2/L3 — не
   "три способа показать один и тот же экран", это три независимых runtime
   environment'а с разными возможностями (статический HTML vs JS-bundle vs
   полноценный API access). Контракт для пользовательского обещания должен
   проверяться в каждом из них или **обещание не делается** в тех слоях, где
   нельзя гарантировать.
3. **CF миграции расширяют поверхность отказов в новые места.** До CF
   "origin недоступен" означало "хост лёг" (редкость). После CF тот же
   класс события включает любой network blip между POP и origin — это
   нормальная фоновая частота, не редкость. Соответственно UX-обещания,
   которые раньше срабатывали "почти всегда", стали "иногда".

### Rule

- **Перед добавлением CDN/proxy/edge-слоя** перед origin, перечислить все
  UX-обещания, делаемые на origin-served страницах, и проверить какие из
  них всё ещё выполнимы при недоступности origin. Несовместимые либо
  переписать (снять обещание), либо обеспечить на уровне edge (worker + KV
  буфер, как в этом фиксе).
- **Каждое обещание в i18n строке** ("уведомим", "напомним", "сохраним")
  обязано иметь рядом ссылку на код, который это обещание держит. Если
  такой код не существует или зависит от условия не во всех путях — либо
  переписать строку (вынести обещание под условие), либо построить
  недостающую часть (как L1 KV буфер).

### Better code

- Static stub (`ops/maintenance/maintenance.html`) теперь шлёт
  fire-and-forget POST на `/__cf-maintenance-exposure` — worker валидирует
  Telegram initData по HMAC и пишет в CF KV namespace
  `MAINTENANCE_EXPOSURES` с TTL 7 дней.
- Watchdog (`ops/watchdog/health-watchdog.mjs`) на recovery дренит KV
  через worker, отдаёт батчем в `/internal/maintenance/ingest-buffered`,
  откуда они становятся обычными `MaintenanceExposure` строками и попадают
  в существующий `send-recovery-notifications` fan-out.
- Идемпотентность гарантируется `@@unique([incidentId, userId, surface])`
  на `MaintenanceExposure` + watchdog DELETE на ack'нутые KV ключи только
  после успешного ingest (at-least-once).
- Kill switch: `MAINTENANCE_WORKER_DISABLED=1` в `wrangler.toml` →
  redeploy → worker превращается в pass-through, нет влияния на прод.
- Полная схема: [`MAINTENANCE_FLOW.md`](./MAINTENANCE_FLOW.md).

### Related

- `docs/design-system/DESIGN_DECISIONS.md` 2026-05-25 запись по новому
  v2.1 visual'у заглушки.
- CF Worker: `infra/cloudflare/maintenance-worker/`.
- 35 unit/integration тестов в worker'е + 8 новых тестов для
  `/internal/maintenance/ingest-buffered`.

---

## 2026-05-25 — Browserslist double-source: prod build fails after F1 deploy

### Симптом

После commit `9c1e220` ("F1 lazy-load 4 Mini App screens via next/dynamic")
GitHub Actions deploy упал на стадии Docker build:

```
HookWebpackError: /app/apps/web contains both .browserslistrc and package.json with browsers
…
BrowserslistError: /app/apps/web contains both .browserslistrc and package.json with browsers
…
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @wishlist/web@0.0.0 build: `next build`
```

Прод не пострадал — Docker не пересобрал контейнер, поэтому старый
`wishlist-prod-web-1` остался крутиться на предыдущем релизе. Но новый
deploy (включая весь F1 lazy-loading) **не дошёл до пользователей**.

### Root cause

В F0 (`6525761`) я добавил `browserslist` поле в `apps/web/package.json`.
Замер после F0 показал, что Next.js **не подхватил** этот источник для
полифилов (хеш `polyfills-*.js` не сменился). Я предположил, что в
monorepo-раскладке поле в package.json игнорируется, и в F1 (`9c1e220`)
добавил **дополнительно** `apps/web/.browserslistrc` как "более
надёжный источник".

Browserslist резолвер запрещает оба источника одновременно — это
defensive throw, чтобы не было сомнений, какая конфигурация активна.
Локально `tsc --noEmit` и `vitest run` это не ловят, потому что они не
запускают Webpack / browserslist resolve. Поймала только реальная
сборка Next.js в Docker.

### Lesson

1. **`tsc --noEmit` ≠ build verification.** Конфиг-уровневые ошибки
   (browserslist source resolution, Next experimental flags,
   tailwind purge globs) проявляются только при настоящем `next build`.
   Перед deploy конфиг-меняющего коммита нужен **локальный
   `pnpm -C apps/web build`**, а не только tsc.
2. **Не дублируй источники конфигурации "на всякий случай".** Если
   первый источник не работает — нужно понять почему, а не подкладывать
   второй параллельно. У browserslist, eslint, tsconfig и других
   resolver'ов есть defensive checks на double-source — это by design.
3. **Если замер первой попытки не показал ожидаемого эффекта,
   гипотеза о причине должна быть верифицирована до второй попытки.**
   Я предположил "monorepo не подхватывает package.json browserslist"
   без проверки — на самом деле он подхватывался, просто Next.js
   polyfills имеют свой baseline target независимый от browserslist.

### Rule

Перед push'ем коммита, изменяющего **любой** из:
- `next.config.mjs` (experimental flags, transpilePackages,
  optimizePackageImports)
- `browserslist` (где угодно — package.json / .browserslistrc /
  browserslist field)
- `tsconfig.json` (paths, moduleResolution)
- `tailwind.config.ts` (content globs, plugins)
- Dockerfile.web / Dockerfile.api

**локально запустить полный `pnpm -C apps/web build`** (или
`pnpm -C apps/api build` соответственно). `tsc --noEmit` оставляем
для итеративной разработки внутри ветки, но конфиг-PR без локального
билда — нет.

### Better code

Fix: удалить `browserslist` поле из `apps/web/package.json`, оставить
только `.browserslistrc`. Один источник правды.

После фикса prod-build проходит; F1 lazy-loading доезжает до проды.

---

## 2026-05-25 — Referral program: «включена в проде, но не запущена» — 38 дней невидимого funnel

### Симптом

При аудите состояния Referral Program обнаружено расхождение между документацией
и проденым состоянием:

- `docs/research/06-experiment-backlog.md` утверждал «`ReferralProgramConfig.enabled = false`»
- Прод: `enabled=true, rolloutPercent=100`, last update 2026-04-17 ручным workflow
- 54/315 пользователей уже получили `referralCode`
- Mini App рендерил Profile-tile, Paywall sheet и Home banner с приглашением
- **0 атрибуций** в DB за 38 дней
- 11 типов referral.* событий в `AnalyticsEvent`, ВСЕ — только launch-day тестирование 2026-04-17

UI-engagement события (`referral.entry_point_impression`, `share_intent`,
`rules_opened`, `home_banner_dismissed` и т.д.) emit'ились во фронтенде, но
**физически не попадали в DB**: 0 строк в `AnalyticsEvent` за 38 дней при
54 пользователях с реф-кодами.

### Root cause

Программа состояла из трёх независимых слоёв, каждый из которых имел свой
gap:

1. **Telemetry allowlist gap.** `/tg/telemetry` фильтрует события через
   `ANALYTICS_EVENT_PREFIXES` (префиксный allowlist) +
   `ANALYTICS_EVENT_EXACT` (точечный). Префикс `referral.` **не входил**
   ни в один из них — все UI события дропались **молча** на ingress.
   Комментарий в коде даже это объяснял: "Today these are de-facto
   blocked because their domain prefix (`referral.`) isn't in
   ANALYTICS_EVENT_PREFIXES".
2. **Bot defense-in-depth gap.** `apps/bot/src/index.ts` в `/start ref_X`
   ветке вызывал `tryCreateAttribution` **без** предварительной проверки
   `config.enabled`. Защита держалась только на data-layer гейте внутри
   `tryCreateAttribution`. Любой сбой загрузки конфига или регресс
   гейта мгновенно ломал bot-side kill-switch.
3. **Fraud signal emit gap.** `packages/db/src/referral.ts:processReward`
   считал fraud score, но **не emit'ил** `referral.fraud_signal_*` и
   `referral.fraud_score_calculated` — потому что @wishlist/db не имел
   импорта на analytics-хелперы. 12 событий в allowlist при 0 emit
   в коде.
4. **Dead UI flag.** `entryPointPostShare` жил в DB / admin endpoint /
   `/tg/referral/rules-config` response / TypeScript type — но ни одного
   рендерера не было написано. Чистый dead code, который вводил в
   заблуждение при чтении конфига.

### Урок

«Feature flag = OFF» в документации **не равно** проденому состоянию. Прод
— единственный источник правды для feature flags. Аналогично: «событие
есть в allowlist» **не равно** «событие реально попадает в `AnalyticsEvent`».
Между двумя точками — три фильтра (frontend buffer flush, telemetry
ingestion allowlist, prisma write success), и без proxy-метрики "ratio
emitted vs ingested per event name" любой из них может молча убить
половину funnel.

Конкретно для рефералки: telemetry allowlist должен быть **производным**
от typed-таксономии (`PRODUCT_EVENTS` + `ANALYTICS_EVENTS`), а не
параллельным списком. Расхождение `~10/68` events emitted в данном случае
— прямое следствие того, что список событий растёт в одном файле, а
ingress-фильтр в другом.

### Правило

1. **Аудит state drift раз в квартал** для всех singleton-config таблиц
   (`ReferralProgramConfig`, `SantaGlobalConfig`, `SantaSeasonConfig`, etc.):
   сравнить значения в проде с тем, что утверждает `docs/research/*.md`.
   Drift = либо обновить docs, либо вернуть прод в соответствие.
2. **Любой новый event с домен-префиксом** (`<domain>.<action>`) должен
   быть либо добавлен в `ANALYTICS_EVENT_EXACT` (client-trustable) либо
   явно отнесён к `LEGACY_SERVER_ONLY_EVENTS` (server-only). Префиксное
   расширение `ANALYTICS_EVENT_PREFIXES` — только когда **все** event'ы
   домена client-trustable.
3. **Сервисы с feature flag MUST иметь explicit kill-switch на каждом
   слое**, который умеет инициировать действие (bot handler, API route,
   scheduler), не только на data layer. Defense-in-depth: один сломавшийся
   гейт ≠ полностью открытая фича.
4. **DB layer (@wishlist/db) может emit'ить в `AnalyticsEvent` напрямую**
   через `prisma.analyticsEvent.create` — это допустимо, если событие
   неразрывно связано с состоянием, которое DB layer и так пишет (fraud
   scoring, attribution lifecycle). Не нужно «обязательно через сервис».
5. **Re-enable gate для рефералки на следующий запуск** (см.
   `docs/research/referral-decision.md § 7`):
   - `referral.invitee_converted_to_paid` уже emit'ится в
     `apps/bot/src/analytics.ts:150` — но не выстреливает до первой
     реальной атрибуции с конверсией. Не код-gap, а usage-gap.
   - `referral.invitee_retained_d7/d30` теперь покрыт ежедневным
     scheduler'ом (`apps/api/src/schedulers/referral-retention.ts`).

### Лучший код

- **Прод как single source of truth:**
  ```bash
  ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist \
    -c "SELECT enabled, rolloutPercent, configVersion, updatedByAdminId \
        FROM \"ReferralProgramConfig\";"'
  ```
- **Telemetry allowlist расширение exact-match, не prefix:**
  ```ts
  // apps/api/src/routes/telemetry.routes.ts
  const ANALYTICS_EVENT_EXACT = new Set<string>([
    'api_server_error', 'pro_cta_clicked', 'error_boundary_triggered',
    // referral.* — client-trustable UI engagement events only.
    'referral.entry_point_impression',
    'referral.share_intent',
    // ... ~22 client names
    // NB: server-authoritative names (referral.attributed, fraud_signal_*,
    // invitee_converted_to_paid) intentionally NOT here.
  ]);
  ```
- **Bot defense-in-depth (короткое замыкание):**
  ```ts
  // apps/bot/src/index.ts /start ref_ branch, line 0 before DB lookups
  const earlyConfig = await loadReferralConfig(prisma);
  if (!earlyConfig.enabled) {
    prisma.analyticsEvent.create({
      data: { event: 'referral.feature_flag_evaluated', userId: user?.id ?? null,
              props: { flag: 'enabled', value: false, context: 'bot.start', refCode } },
    }).catch(() => {});
    return ctx.reply(t('bot_referral_welcome', locale), ...);
  }
  ```
- **DB-layer emit для неразрывной с state корреляции:**
  ```ts
  // packages/db/src/referral.ts: processReward, after computeFraudSignals
  prisma.analyticsEvent.create({
    data: { event: 'referral.fraud_score_calculated', userId: att.inviterUserId,
            props: { attributionId, score, signalCount: signals.length } },
  }).catch(() => {});
  for (const hit of signals) {
    prisma.analyticsEvent.create({
      data: { event: `referral.fraud_signal_${hit.signal}`, userId: att.inviterUserId,
              props: { attributionId, weight: hit.weight, score, ...hit.details } },
    }).catch(() => {});
  }
  ```

### Files

- `docs/research/referral-decision.md` — полный decision doc (§ 1–9)
- `docs/research/06-experiment-backlog.md` — обновлён factual lines 19, 595
- `apps/api/src/routes/telemetry.routes.ts` — exact-match allowlist для UI событий
- `apps/api/src/routes/telemetry.routes.test.ts` — 6 новых тестов
- `apps/bot/src/index.ts` — defense-in-depth kill-switch в /start ref_
- `apps/web/app/miniapp/MiniApp.tsx:5145` — удалён `entryPointPostShare` из типа
- `apps/api/src/routes/referral.routes.ts:481` — удалён из `/rules-config` response
- `apps/api/src/routes/referral.routes.test.ts` — тест на отсутствие поля
- `packages/db/src/referral.ts:processReward` — emit fraud_* событий
- `packages/db/src/referral.test.ts` — 4 новых fraud-emit теста (mock prisma.analyticsEvent.create)
- `apps/api/src/schedulers/referral-retention.ts` — новый daily scheduler
- `apps/api/src/schedulers/referral-retention.test.ts` — 5 тестов d7/d30 cohort + idempotency
- `apps/api/src/index.ts` — регистрация retention scheduler

### Prod action

```sql
-- Выполнено 2026-05-25 13:47 UTC через PATCH /admin/referral/config
UPDATE "ReferralProgramConfig"
SET enabled=false,
    configVersion='v2-disabled-2026-05-25',
    updatedByAdminId='manual-decision-2026-05-25',
    updatedAt=NOW()
WHERE id='default';
-- Cache invalidated by endpoint; referral.config_changed event emitted.
```

---

## 2026-05-25 — E04: auto-created default wishlist — двойной wishlist после онбординга легко пропустить

### Симптом (предотвращён, не отгружен)

Активационная задача E04: при первом входе в Mini App новому пользователю
должен материализоваться REGULAR wishlist по умолчанию, чтобы первый item
можно было добавить без шага "создай свой первый вишлист". Очевидная
наивная реализация — `getOrCreateProfile` → `if (!hasRegular) create()` —
ломает онбординг: новый пользователь, который через 3 секунды после
бутстрапа жмёт "пройти онбординг" и в конце вводит своё название,
получает ДВА REGULAR wishlist'а ("Мой вишлист" пустой + его именованный
со всем привезённым), потому что `POST /tg/onboarding/create-wishlist`
безусловно делал `prisma.wishlist.create(...)`. До прода не доехало —
поймано на стадии дизайна, но точно бы протёрлось в кэш Telegram-клиента,
если бы я не подумал про взаимодействие двух флоу.

### Root cause

Идемпотентность по "wishlist уже есть" в воркфлоу с двумя независимыми
точками создания (bootstrap-автодефолт + onboarding-named-wishlist) **не
сводится** к проверке количества wishlist'ов. Нужен явный маркер
"автоматически созданный, готов к замене" — иначе вторая точка создаёт
дубль вместо того, чтобы переименовать первый.

### Урок

Когда фича вводит **новый автоматический источник создания** уже
существующей сущности, ВСЕГДА нарисуй полную табличку "кто создаёт →
кто переиспользует → кто удаляет/переименовывает" перед тем как писать
сервис. Идемпотентность ≠ "сделать noop на повторе"; для сущностей с
несколькими создателями она требует **маркера** на уровне таблицы,
который второй создатель видит и понимает, что писать сверху, а не
рядом.

### Правило

Любой новый сервис вида `getOrCreate*` на сущности с уже работающим
ручным создателем (POST routes, onboarding handlers, миграции из старых
систем) идёт в код только с одним из двух планов:

1. Маркер на сущности (`isDefault Boolean` / `source enum` /
   `createdByJob String`), на который второй создатель смотрит и
   **переписывает строку in-place** (UPDATE), вместо INSERT-а.
2. Гарантированный временной интервал, в котором только один создатель
   активен (например, "bootstrap создаёт только после
   onboarding.status='DISMISSED'") — но это хрупко, потому что
   зависит от порядка вызовов API клиентом, который мы не контролируем
   в Telegram WebView.

Маркер сильно предпочтительнее: он не зависит от тайминга и допускает
любой порядок вызовов фронта.

### Лучший код

`packages/db/prisma/schema.prisma:Wishlist` теперь имеет
`isDefault Boolean @default(false)`. `services/wishlists.ts:
createGetOrCreateDefaultWishlist()` создаёт REGULAR с `isDefault=true`
только если у юзера **0 REGULAR**. `POST /tg/onboarding/create-wishlist`
делает `findFirst({ isDefault: true })` и либо UPDATE-ит существующую
строку (новое имя + `isDefault: false`), либо CREATE-ит новую — оба
пути возвращают один и тот же `wishlist.id`, в который дальше
переезжают items из SYSTEM_DRAFTS. Тесты в
`services/wishlists.test.ts` пинят: 0 wishlist'ов → создать + emit
`wishlist.default_created`; уже есть REGULAR → no-op без emit; P2002
race → fallback на findFirst. Снапшот PRODUCT_EVENTS блокирует
"забыли зарегистрировать `wishlist.default_created`", параметрическая
проверка в i18n.parity ловит "забыли перевести `default_wishlist_title`
на одну из 6 локалей".

---

## 2026-05-25 — `group_gift_unlock` блокировался на pre_checkout: дрейф двух SKU-списков в боте

### Симптом

Обнаружено во время добавления тестов billing/entitlement: KNOWN_ADDON_SKUS
из `apps/bot/src/payments.ts` (источник правды процессора, 14 SKU) и
inline-Set `KNOWN_SKUS` в `pre_checkout_query`-хендлере того же файла
(13 SKU) разошлись. `group_gift_unlock` присутствовал у процессора и у
billing-роутов apps/api, но отсутствовал в pre_checkout — Telegram
отвечал юзеру `'Unknown SKU'` и снимал инвойс до оплаты. Пользователи,
кликнувшие "купить Group Gift" из Mini App, никогда не могли довести
покупку до конца.

### Root cause

Два независимых hand-maintained списка одних и тех же SKU. При добавлении
`group_gift_unlock` в апреле обновили `SKU_ADDON_TYPES` и
`ONE_TIME_SKUS` в apps/api, но забыли соответствующую запись в
pre_checkout's `KNOWN_SKUS`. Никакого алёрта/теста, ловящего такой дрейф,
не было — `group_gift_unlock` молча выпал из всего покупательного пути
и баг прожил до code-review нового тест-сьюта.

### Урок

SKU-каталоги, дублированные между точками жизненного цикла одного и того
же кода (валидация → обработка → анализ), — гарантированный источник
silent drift. Любая попытка "одно из них поправить, второе тоже поправлю"
ловит вас рукав за рукав в пределах одного PR-а и забывается через 3.

### Правило

SKU/catalog enum'ы используются как Set'ы валидации? **Один источник
правды, экспортируемый из processor-модуля.** Все остальные
allow-list'ы импортируют его, а не пересоздают руками.

### Лучший код

`apps/bot/src/payments.ts:KNOWN_ADDON_SKUS = new Set([...Object.keys(SKU_ADDON_TYPES), ...Object.keys(SKU_CREDITS)])`
— union-производное, не hand-maintained. `apps/bot/src/index.ts`
pre_checkout-хендлер импортирует `KNOWN_ADDON_SKUS` и проверяет
`.has(skuCode)`. Тест `payments.test.ts` `KNOWN_ADDON_SKUS coverage`
ловит расхождение между процессором и apps/api `ONE_TIME_SKUS` при
прогоне CI.

---

## 2026-05-24 — Lifecycle `dead_air`: stopped-touch не считался → пул залипал на месяц

### Симптом

`lifecycle_dead_air` warn в `api.log.2026-05-24.1` (threshold=24,
candidatesFound=400). С 2026-05-23 14:14 UTC и далее: 41+ цикл подряд
`touchesSent=0` при стабильном пуле 400+ кандидатов. Последний реальный
touch — 2026-05-23 14:14. SQL-симуляция гейтов давала 90 кандидатов,
проходящих все ранние фильтры (classifier / shouldStop / caps / cadence /
MAX_WAVES), но scheduler упорно скипал всех.

### Root cause

Двойной учёт одного и того же touch-records — несогласованный между
`episodeTouches`-каунтером и upsert-«если уже есть, скип»-гардом.

`checkLifecycleCaps` считал «открытые» touches:

```ts
prisma.lifecycleTouch.count({ where: { userId, segment, sentAt: { not: null }, stoppedAt: null } })
```

Touch с `stopReason ∈ {delivery_failed, chat_not_found, bot_blocked}` имеет
`stoppedAt != null` → не попадает в счёт → `episodeTouches = 0` →
`nextTouchNumber = 1`.

Дальше в loop body upsert на `(userId, episodeKey, touchNumber=1)` находит
уже существующую stopped-запись (sentAt стампнут на прошлой попытке),
возвращает её как есть, и следующая строка коротит:

```ts
if (touch.sentAt) continue;
```

Юзер выпадает из рассылки до следующего календарного месяца, когда
`episodeKey` рольёт (`S1_user_2026-05` → `S1_user_2026-06`) и upsert
создаст новую запись.

Симптом проявился именно в конце мая, потому что:
1. 2026-05-01 был бурст создания 124 S1 touch-1 записей за день
   (типичный месячный rollover).
2. К 2026-05-22 reachable-пул высох: 305 / 478 historical S1 touch-1
   записей имели stop-reason (delivery_failed/chat_not_found/bot_blocked).
   Все эти юзеры уже имели «сожжённую» майскую запись и более не были
   достижимы до 2026-06.
3. Module-scope counter `lifecycleDeadCycles` обнуляется на рестарт api.
   Между деплоями реже стали — counter дотянул до threshold=24 и warn
   зафайерил впервые.

Это та же ошибка-класса, что фикс на line 339–342 уже описывает для
`transient_failure` («The earlier version stamped sentAt+stoppedAt on every
failure, which permanently sank the touch for the rest of the monthly
episode»). Предыдущий фикс закрыл только transient-кейс; permanent-кейсы
(`bot_blocked`/`chat_not_found`/`delivery_failed`) остались на сломанной
семантике.

### Урок

Если двум разным гардам нужно решить «эта попытка уже была», они должны
смотреть на ОДНО И ТО ЖЕ множество записей. Любое расхождение фильтров
(один считает open-only, другой смотрит «есть запись с sentAt») создаёт
тихий тупик: первый говорит «можно», второй — «уже было».

Месячный `episodeKey` — это календарный «окно эпизода». Cap-счётчик
должен фильтроваться по тому же окну, иначе он либо тащит lifetime-историю
(блокирует возвращающихся юзеров навсегда), либо игнорирует свежие
попытки (порождает текущий dead-air).

### Правило

- Когда два места кода сравнивают «существует ли уже X», у них должны быть
  идентичные условия отбора. Если одно фильтрует по `stoppedAt: null`,
  второе обязано тоже учитывать `stoppedAt`. Расхождение = баг.
- В лайфсайкл-флоу: cap-счётчик по сегменту/эпизоду должен ВКЛЮЧАТЬ
  stopped touches. Stop-reason — это «попытка состоялась с известным
  исходом», а не «попытки не было».
- Episode-cap должен фильтроваться по тому же `episodeKey`, что и upsert,
  чтобы окна не разъезжались. `segment + stoppedAt: null` пересекалось
  с lifetime → блокировало возвращающихся юзеров с 3+ delivered touches
  в истории.
- Module-scope counters (`lifecycleDeadCycles`) — это сигнал, не лекарство.
  Counter обнуляется рестартами, так что dead-air ловится только если
  процесс прожил threshold * cadence часов. Это нужно учитывать при
  выборе threshold: 24 циклов ≈ 24 часа без рестарта.

### Лучший код

```ts
// ❌ До: считаем «открытые» touches per-сегмент lifetime →
// stopped запись в текущем месяце не считается, upsert находит её,
// `if (touch.sentAt) continue` морозит юзера до 1-го числа след. месяца.
prisma.lifecycleTouch.count({
  where: { userId, segment, sentAt: { not: null }, stoppedAt: null },
}),

// ✅ После: считаем ВСЕ попытки в текущем monthly episodeKey, включая stopped.
// Совпадает с тем, что проверяет upsert ниже по коду. Окна одинаковые,
// семантика «попытка состоялась» — единая.
const monthKey = now.toISOString().slice(0, 7);
const episodeKey = `${segment}_${userId}_${monthKey}`;
prisma.lifecycleTouch.count({
  where: { userId, episodeKey, sentAt: { not: null } },
}),
```

Regression test: `apps/api/src/schedulers/lifecycle.test.ts` →
«counts current-monthly-episode attempts via episodeKey (not
segment+stoppedAt:null)». Pre-fix mock возвращает 0 на старую сигнатуру
where, тест валит `expect(sendLifecycleDM).toHaveBeenCalledTimes(1)`.
Post-fix: mock возвращает 1 на новую сигнатуру, `nextTouchNumber=2`,
upsert создаёт свежую запись, sendDM зовётся.

---

## 2026-05-22 — Группа-исключение Secret Santa не создаётся: zod `.min(2)` валит дефолтный `[]`

### Симптом

`POST /tg/santa/campaigns/:id/exclusions/groups` с телом `{ label }` (без
`memberUserIds`) отдавал **400 zodError** вместо 201. Mini App `createGroup`
(`MiniApp.tsx`) шлёт ровно `{ label }` — значит PRO-пользователь, тапнув
«создать группу-исключение», получал 400, и группа не создавалась. При этом
дальше по хендлеру пустой массив уже обрабатывался явно
(`memberUserIds.length > 0 ? {...} : undefined`) — то есть пустая группа
была задуманным сценарием.

### Root cause

Схема запроса:

```ts
memberUserIds: z.array(z.string().min(1)).min(2).max(50).optional().default([]),
```

Когда поле опущено, `ZodDefault` подставляет `[]` и **прогоняет это значение
через внутренний тип**: `ZodDefault._parse` при `undefined` берёт
`defaultValue()` и зовёт `innerType._parse(data)`. Внутренний тип здесь —
массив с `.min(2)`. Проверка `.min(2)` срабатывает на `[]` (длина 0 < 2) →
ошибка → `safeParse` неуспешен → `zodError(res, ...)` → 400.

`.default()` в zod 3 **не** короткозамыкает валидацию: дефолт проходит ту же
схему, что и пользовательский ввод. `.optional()` перед `.default()` тоже не
спасает — `ZodDefault` подставляет значение раньше, чем `ZodOptional` увидел
бы `undefined`.

### Урок

Значение, переданное в `.default(x)`, **обязано само проходить валидацию
внутреннего типа**. `.min(N)` + `.default([])` на одном поле —
самопротиворечие: дефолт `[]` гарантированно не пройдёт `.min(N≥1)`, и
«поле опущено» детерминированно превращается в 400.

Расхождение схемы с клиентом тест не ловил, потому что существующий тест
группы-исключений сам обходил баг, посылая `memberUserIds: ['a','b']`.
Воркэраунд в тесте замаскировал дефект схемы.

### Правило

- Перед тем как писать `.default(x)`, мысленно прогони `x` через всю схему
  *до* `.default()`. Если `x` её не проходит — схема сломана.
- Опциональное поле с допустимым пустым значением не должно иметь нижней
  границы, несовместимой с пустым значением. `z.array(...).min(2)` и
  `.default([])` вместе запрещены.
- Тест на схему запроса посылает **ровно то тело, что шлёт реальный клиент**.
  Воркэраунд в тесте («дошлём полей, чтобы пройти валидацию») — это сигнал
  бага в схеме, а не свойство теста. Гард — `santa.routes.test.ts`
  («PRO owner creating an exclusion group with only { label } → 201»).

### Лучший код

```ts
// ❌ До: .min(2) валит дефолтный [], омит поля → 400
memberUserIds: z.array(z.string().min(1)).min(2).max(50).optional().default([]),

// ✅ После: пустой/опущенный массив допустим — флоу «создать пустую группу,
// потом добавлять участников по одному» (ровно так и делает Mini App createGroup)
memberUserIds: z.array(z.string().min(1)).max(50).optional().default([]),
```

---

## 2026-05-22 — Paywall `appearance` захардкожен по-русски; мёртвый upsell-контекст `bot_import`

### Симптом

Аудит monetization-UI (`docs/research/03-monetization-paywall-audit.md`,
§8.7–8.8) нашёл два дефекта в `getUpsellContent` (`MiniApp.tsx`):

1. Контекст пейволла `appearance` (PRO-гейт OLED-тёмной темы и акцентных
   цветов) отдавал `title` / `subtitle` / `benefits` **строковыми
   литералами на русском** — при том что все остальные ~19 контекстов
   резолвят копирайт через `t(key, locale)`. Пользователь в
   en/zh-CN/hi/es/ar, упёршийся в гейт оформления, видел русский текст.
2. Контекст `bot_import` — член union'а `UpsellContext` со своей записью
   в `getUpsellContent` (побайтовый дубль `url_import`), но **ни одного
   триггера**: `grep` по `showUpsell('bot_import')` /
   `setUpsellSheet({ context: 'bot_import' })` — ноль вхождений.

### Root cause

1. `appearance` добавляли точечно (v2.1, тема/акцент-гейт), скопировав
   форму соседней записи, но вместо `t(...)` вписали готовый русский
   текст — i18n-ключи так и не завели. `i18n.parity.test.ts` это не
   ловит: он сверяет ключи, *существующие* в словарях; ключа, которого
   нет ни в одном словаре, для parity-проверки не существует.
2. `bot_import` пережил рефактор флоу импорта. Сценарий «импорт в боте →
   пейволл» уже закрыт контекстом `pro_main`: бот на исчерпании лимита
   (`bot_import_pro_required`) отдаёт deep-link `?startapp=upgrade_pro`,
   открывающий Mini App в `pro_main`. Отдельный `bot_import` стал не
   нужен, но член union'а и ветка `getUpsellContent` остались висеть.

### Урок

Захардкоженный текст в одной записи словаре-подобной структуры
**невидим для key-parity-проверок** — ключа нет, ругаться не на что.
Ловится только проверкой «каждая запись построена через `t()`», а не
«каждый ключ есть во всех локалях».

Мёртвый член string-literal-union не даёт ошибки компиляции — на него
просто никто не ссылается. TypeScript проверяет, что `Record<Union, …>`
*исчерпывающий* (все члены покрыты), но не что каждый член
*используется*. Мёртвый член тихо тянет за собой ветку кода.

### Правило

- Любая новая запись в `getUpsellContent` (и в любом
  `Record<…, { видимый текст }>`) строит весь копирайт через
  `t(key, locale)`. Строковые литералы-копирайта запрещены. Гард —
  `monolith-guards.test.ts` («appearance upsell builds copy via t()»).
- Новые i18n-ключи заводятся **сразу во всех 6 локалях** —
  `i18n.parity.test.ts` CI-блокирующий, ru/en + EN-fallback его не
  пройдёт (а зависимость от fallback'а = баг, не фича).
- Член `UpsellContext` живёт, только пока у него есть реальный триггер
  (`showUpsell` / `setUpsellSheet` с этим контекстом). Нет триггера →
  удаляются и член union'а, и ветка `getUpsellContent`. Гард —
  `monolith-guards.test.ts` («dead bot_import upsell context removed»).

### Лучший код

```ts
// ❌ До: appearance — единственный контекст с хардкодом RU
appearance: {
  emoji: '🎨',
  title: 'Персонализация внешнего вида',
  subtitle: 'PRO открывает OLED-чёрную тему и акцентные цвета…',
  showTable: false,
  benefits: ['OLED-чёрная тема (экономит батарею)', /* …ещё RU… */],
},

// ✅ После: как все остальные контексты — через t()
appearance: {
  emoji: '🎨',
  title: t('upsell_appearance_title', locale),
  subtitle: t('upsell_appearance_subtitle', locale),
  showTable: false,
  benefits: [
    t('upsell_appearance_b1', locale),
    t('upsell_appearance_b2', locale),
    t('upsell_appearance_b3', locale),
  ],
},
```

Регрессия закрыта: `packages/shared/src/i18n.upsellAppearance.test.ts`
(5 ключей × 6 локалей резолвятся в локализованную копию, без
raw-key-fallthrough, без кириллицы в не-RU) +
`apps/web/app/miniapp/monolith-guards.test.ts` (appearance строится
через `t()` и не содержит кириллицы; `bot_import` полностью удалён из
монолита).

---

## 2026-05-21 — Mini App не открывается: «Application error» из-за hydration mismatch

### Симптом

Telegram Mini App падал у всех на загрузке белым экраном — «Application
error: a client-side exception has occurred». В консоли — React-ошибки
гидратации #418 / #423 / #425. Аналитика: после 12:44 UTC — ноль сессий
(`user.session_started`), приложение лежало ~6 часов. Краш срабатывал
ДО первого события `miniapp.open_attempt` — то есть на самом рендере
бандла, не доходя до bootstrap.

### Root cause

Две независимые проблемы, обе — нарушение SSR-инварианта «первый рендер
клиента обязан совпасть с серверным HTML»:

1. **`ThemeProvider` читал `localStorage` в инициализаторе `useState`.**
   `useState(() => readStoredPref())` → на сервере `window` нет, тема
   `dark/violet`; на клиенте у PRO-пользователя с кастомной темой —
   `black/blue`. Атрибуты `data-theme`/`data-accent` на корневом
   `.wb-phone` расходились → React не мог сгидрировать → #418.

2. **`MiniAppInner` (~30k строк) целиком уходил в SSR.** Любое
   server/client-расхождение в его дереве (тема, локаль, Telegram-контекст,
   `Date.now()`/`Math.random()` в рендере) — потенциальный mismatch. SSR
   для Telegram Mini App бесполезен в принципе: нет SEO, первый кадр всё
   равно сплэш, без `window.Telegram` приложение не работает.

Чистая пересборка `--no-cache` дала **байт-в-байт тот же бандл** (те же
хеши чанков) — это исключило порчу артефакта сборки и доказало, что баг
детерминированный, в исходнике.

### Урок

В Next.js (как и в любом SSR-фреймворке) **первый рендер компонента —
чистая функция пропсов**. Любое чтение браузерного состояния
(`localStorage`, `window`, `navigator`, `matchMedia`, `Date.now()`) в теле
рендера или в инициализаторе `useState`/`useMemo` ломает гидратацию.
Браузерное состояние читается ТОЛЬКО в `useEffect` — после коммита первого
(SSR-идентичного) рендера.

Клиент-онли поверхность (Telegram Mini App) **не нужно** отдавать в SSR
вообще — это не оптимизация, а только источник mismatch-ов.

### Правило

1. **Никакого `localStorage`/`window`/`navigator`/`Date`/`Math.random` в
   инициализаторе `useState`/`useMemo` и в теле рендера.** Стартовое
   состояние = дефолт или проп; браузерное состояние подтягивается в
   `useEffect` после монтирования.
2. **Клиент-онли поверхности гейтить mount-флагом** (`useState(false)` +
   `useEffect(() => setMounted(true))`), отдавая в SSR детерминированный
   плейсхолдер. Сервер и первый рендер клиента обязаны совпадать.
3. **`--no-cache` пересборка с байт-идентичным бандлом** = баг
   детерминированный → ищи в исходнике, не в инфраструктуре.

### Лучший код

```tsx
// ❌ До: useState-инициализатор читает localStorage — на сервере его нет
const [pref] = useState(() => {
  const stored = readStoredPref();            // window.localStorage
  return { theme: stored.theme ?? 'dark', accent: stored.accent ?? 'violet' };
});

// ✅ После: стартовое состояние = дефолт/проп; localStorage — в useEffect
const [pref, setPref] = useState(() => ({
  theme: initial?.theme ?? 'dark',
  accent: initial?.accent ?? 'violet',
}));
useEffect(() => {
  const stored = readStoredPref();
  if (stored.theme || stored.accent) setPref((p) => ({ ...p, ...stored }));
}, []);
```

```tsx
// ❌ До: весь MiniAppInner (~30k строк) рендерится на сервере
<ThemeProvider><MiniAppInner {...props} /></ThemeProvider>

// ✅ После: клиент-онли часть за mount-гейтом, в SSR — детерминированный сплэш
const [mounted, setMounted] = useState(false);
useEffect(() => { setMounted(true); }, []);
<ThemeProvider>{mounted ? <MiniAppInner {...props} /> : <BootSplash />}</ThemeProvider>
```

**Commit:** `fix(miniapp): client-only mount gate + SSR-safe ThemeProvider`

---

## 2026-05-21 — From-scratch `prisma migrate deploy` падает: дубликат enum-значения + коллизия timestamp'ов

### Симптом

`pnpm -C packages/db db:migrate:deploy` против **пустой** базы падал на
миграции `20260302000000_add_wishlist_deadline_and_item_statuses`:

```
Error: P3018 — Database error code: 42710
ERROR: enum label "COMPLETED" already exists
```

После починки первой ошибки вскрылась вторая — падение на
`20260325000000_lifecycle_touches`:

```
Error: P3018 — Database error code: 42P01
ERROR: relation "PromoRedemption" does not exist
```

Прод не затронут: его БД мигрировалась инкрементально, каждый деплой применял
только новые миграции — поэтому ситуации «вся история применяется разом» там
никогда не возникало. Ломается только применение **с нуля**: свежая dev-база
и CI-job, реплеящий историю целиком.

### Root cause

Две независимые ошибки в истории миграций, обе невидимы при инкрементальном
применении и видны только при полном реплее с нуля:

1. **Дубликат enum-значения.** `20260301000000_add_completed_deleted_statuses`
   уже добавляет `COMPLETED` и `DELETED` в `ItemStatus`. Следующая миграция
   `20260302000000` повторяла те же `ALTER TYPE ... ADD VALUE` (плюс свой
   уникальный `ADD COLUMN "deadline"`). Повторный `ADD VALUE` валит Postgres
   с 42710.

2. **Коллизия одинаковых timestamp'ов.** Три миграции имеют идентичный
   префикс `20260325000000`. Prisma применяет миграции в **лексикографическом
   порядке имени папки**: `add_wishlist_privacy` → `lifecycle_touches` →
   `promo_system`. Но `lifecycle_touches` делает `ALTER TABLE
   "PromoRedemption"`, а саму таблицу создаёт `promo_system` — который из-за
   буквы «p» сортируется ПОСЛЕ. По датам коммитов `promo_system` написан
   раньше (25 марта 10:48), чем `lifecycle_touches` (12:18); прод применил их
   правильно разными деплоями — а сортировка по имени этот порядок ломает.

### Урок

Прод, применяющий миграции инкрементально, **никогда не проверяет**, что вся
история реплеится с нуля. Дубликаты DDL и коллизии порядка между миграциями с
одинаковым timestamp'ом сидят в истории незаметно — до первой свежей базы
(новый разработчик, CI integration-тесты, восстановление из миграций). Имя
папки миграции — это одновременно и порядок применения, и идентичность записи
в `_prisma_migrations`.

### Правило

- Имена папок миграций **уникальны по timestamp'у**. Перед коммитом новой
  миграции `ls migrations | sed 's/_.*//' | sort | uniq -d` должен быть пуст.
- Каждый объект БД (enum-значение, таблица, колонка) добавляется **ровно
  одной** миграцией-владельцем. Не дублировать `ADD VALUE` / `ADD COLUMN`.
- Историю чинят **правкой содержимого** миграции, а не переименованием папки:
  `migrate deploy` сопоставляет применённые миграции по `migration_name`, а не
  по checksum — правка содержимого уже-применённой миграции для прода
  безопасна (checksum «уплывает», но `migrate deploy` и `migrate status` это
  игнорируют, exit 0). Переименование папки сломало бы `_prisma_migrations`
  на проде.
- Регрессия закрыта CI-job'ом `migration-replay`: from-scratch `migrate
  deploy` против пустой БД на каждом PR.

### Лучший код

```sql
-- ❌ 20260302000000: повторяет enum-значения из 20260301000000 → 42710 с нуля
ALTER TYPE "ItemStatus" ADD VALUE 'COMPLETED';
ALTER TYPE "ItemStatus" ADD VALUE 'DELETED';
ALTER TABLE "Wishlist" ADD COLUMN "deadline" TIMESTAMP(3);

-- ✅ дубликат убран, осталась только уникальная для миграции часть
ALTER TABLE "Wishlist" ADD COLUMN "deadline" TIMESTAMP(3);
```

```sql
-- ❌ 20260325000000_lifecycle_touches: ALTER чужой таблицы, которой ещё нет
ALTER TABLE "PromoRedemption" ADD COLUMN "offeredAt" TIMESTAMP(3);

-- ✅ перенесено в 20260325000000_promo_system — миграцию-владельца таблицы
--    PromoRedemption (она же её и создаёт), сортируется до использования
```

---

## 2026-05-20 — «Счётчик импортов не обновился» — корректное поведение без UI-сигнала читается как баг

### Симптом

Пользователь импортировал товар по ссылке (`market.yandex.ru/cc/9UCAYv`) и
сообщил: «не обновился счётчик оставшихся импортов». Выглядело как пропавшее
списание кредита.

### Root cause

**Кода-бага не было.** Парсер не смог разобрать ссылку (`parseStatus:
'failed'`) — создалась карточка-заглушка с `title` = домен. По спецификации
кредит списывается только при `parseStatus` `ok`/`partial`, а `failed` —
бесплатный. Счётчик честно не двинулся.

Но Mini App показывал **один и тот же** тост `drafts_card_created`
(«Карточка создана!», тон `success`) для всех трёх исходов парсинга. У
пользователя не было ни одного сигнала, что (а) парсинг провалился и (б)
импорт не засчитан — поэтому корректное «не списали» прочиталось как
пропавшее списание.

### Урок

Когда у действия несколько исходов, и часть из них **молча** отличается по
side-effect'ам (тут: `failed` не тратит кредит), UI обязан показать, какой
исход случился. Единый success-тост на все ветки превращает корректное
поведение в «баг» в глазах пользователя.

### Правило

Действие с несколькими статусами результата (`ok` / `partial` / `failed`
и т.п.) маппит **каждый** статус на отдельную обратную связь — копирайт
и/или тон. Нельзя переиспользовать один success-тост на исходы, которые
расходятся по видимым последствиям (списание кредита, частичные данные).

### Лучший код

```ts
// ❌ До: один тост на любой исход парсинга — failed читается как успех
pushToast(t('drafts_card_created', locale), 'success');

// ✅ После: чистый резолвер статус→тост (importResultToast.ts, юнит-тест)
//   ok      → success, «Карточка создана!»
//   partial → success, «…— проверьте детали»
//   failed  → info,    «…— добавили карточку, импорт не засчитан»
const toast = importResultToast(okBody?.parseStatus ?? 'ok', locale);
pushToast(toast.message, toast.tone);
```

---

## 2026-05-20 — Flaky CI: `produces NO write side-effects` падал на глобальном `count()` (гонка параллельных vitest-воркеров)

### Симптом

Деплой коммита `5e487a3` (фикс фильтра достижимости survey) упал на
`tests`-джобе: `1 failed | 78 passed`. Падал **не новый** тест, а
существующий `research-survey-recipients.test.ts > produces NO write
side-effects`: `expected { responses: 0 } to equal { responses: 1 }`
(в другом прогоне — `answers: 6` vs `9`). Локально тест проходил.

### Root cause

Тест снимал «до/после» снапшоты глобальными `db.researchSurveyResponse
.count()` / `.researchSurveyAnswer.count()` — **без `where`**. Vitest
гоняет integration-файлы в параллельных воркерах против одной тестовой
БД; соседний `research-survey.test.ts` создаёт `ResearchSurveyResponse`/
`Answer` через `submitAnswer`/`completeSurvey`. Его записи попадали между
`pre` и `post` снапшотами → глобальный счётчик прыгал.

Падение замаскировалось под «side-effect от `selectSurveyRecipients`»,
хотя `selectSurveyRecipients` строго read-only. Латентная флака — прошлым
деплоям везло с таймингом; новый код в файле сдвинул окно.

### Урок

**Integration-тест, снимающий снапшот `count()`, обязан скоупить счёт к
собственным данным теста.** Глобальный `count()` детерминирован только
при последовательном прогоне; под параллельными воркерами на общей БД он
— гонка. Скоуп по `surveyId` (или PREFIX-владельцу) делает тест
невосприимчивым к любым соседним файлам.

### Правило

Любой `.count()` агрегат в integration-тесте — со `where`, привязанным к
фикстуре теста (свой `surveyId`, PREFIX-telegramId и т.п.). Безусловные
агрегаты по таблице в общей тестовой БД запрещены.

### Лучший код

```ts
// ❌ До: глобальный счётчик — гонка с параллельными воркерами
const pre = { responses: await db.researchSurveyResponse.count() };

// ✅ После: счёт скоуплен к survey этого теста
const countOwn = async () => ({
  responses: await db.researchSurveyResponse.count({ where: { surveyId: survey.id } }),
  answers: await db.researchSurveyAnswer.count({ where: { response: { surveyId: survey.id } } }),
});
const pre = await countOwn();
```

**Commit:** `test(survey): deflake produces-no-write-side-effects (scope counts)`

---

## 2026-05-20 — Survey-приглашения: 45% волны падают с `chat_not_found` (фильтр получателей не проверял достижимость бота)

### Симптом

Пилотная волна survey `pmf-discovery` (2026-05-20): из 60 разосланных
приглашений **27 (45%) упали с `chat_not_found`** — у бота нет DM-чата с
этими пользователями. Планировщик отправки пометил их FAILED; слоты
почасового лимита потрачены впустую. Ручная добивочная волна, которая
фильтровала по достижимости, доставила 20/27 (74%, 0 `chat_not_found`).

### Root cause

`loadEligiblePool` в `apps/api/src/services/research-survey/recipients.ts`
собирал пул получателей по сегментам, но базовый фильтр **не проверял,
может ли бот вообще доставить DM**. Большинство пользователей запускают
Mini App с кнопки меню и никогда не открывают чат с ботом — DM-чата нет,
сообщение боту падает с `chat_not_found`.

Канал доставки (DM от бота) имеет жёсткое предусловие — «DM-чат
существует», — которого не было ни в одном слое отбора. Отбор
оптимизировал «кого мы хотим спросить», игнорируя «до кого физически
дотянемся».

### Урок

**Фильтр получателей обязан кодировать жёсткие ограничения канала
доставки, а не только бизнес-критерии таргетинга.** Рассылка идёт через
канал X → в eligibility-фильтр входит предикат «адресуем по каналу X».
Иначе квота канала горит на заведомо недоставимых адресатах, а счётчики
когорт врут — в выборку попадают люди, которые не могли получить
приглашение.

Валидированный сигнал достижимости: ≥1 строка `LifecycleTouch` с
`delivered = true` (бот доказанно доставлял DM). На пилоте: 30/30
доставленных приглашений имели такую строку, 0/27 `chat_not_found` — нет.
`User.welcomeSent` непригоден (true почти у всех); событие
`bot.start_received` слабое (есть у ~5/30 достижимых).

Второй урок: фильтр сужает пул **неравномерно**. Lifecycle-DM нацелены на
ранний отток, поэтому достижимые пользователи концентрируются в ранних
substrata S8; сегменты позднего этапа воронки (S5 — гостевые
резервирующие) могут иметь почти нулевой достижимый пул. Это ограничение
канала, не баг — планирование волн обязано это учитывать.

### Правило

Новый канал рассылки → в eligibility-фильтр добавляется предикат
«адресуем по этому каналу», подтверждённый данными (не предполагаемый).
`SelectionReport.skipped` показывает, сколько отсеяно по каждой причине:
усадка пула должна быть видимой, а не молчаливой.

### Лучший код

```ts
// ❌ До: базовый фильтр отбирает «кого хотим спросить», игнорируя канал
where: {
  godMode: false,
  telegramId: { not: null },
  profile: { is: { notifyMarketing: true } },
  // ...нет проверки, что бот может доставить DM
}

// ✅ После: достижимость — часть выборки. Один запрос тянет весь базовый
// пул и помечает каждого кандидата флагом доставимости:
select: {
  // ...
  lifecycleTouches: { where: { delivered: true }, select: { id: true }, take: 1 },
}
const pool = candidates.filter((u) => u.lifecycleTouches.length > 0);
// notReachable = candidates.length - pool.length — точный комплемент;
// он в SelectionReport.skipped: усадка пула больше не молчит
```

**Commit:** `fix(survey): require bot-reachability for survey recipient selection`

---

## 2026-05-20 — CI-деплой пропускает пересборку при ретрае после падения (`PREV_SHA` из `git HEAD`)

### Симптом

Деплой коммита `03adbb7`: первая попытка GitHub Actions упала на
`docker compose build web` (временный таймаут `next build` при скачивании
Google Fonts). Перезапуск упавшего job'а через `gh run rerun --failed`
показал **зелёный** статус — но web-контейнер так и не пересобрался
(`docker ps` показывал web `Up 8 hours` вместо свежего). Прод остался на
старом фронте, хотя CI рапортовал успешный деплой. Поймано вручную по
post-deploy health-check'у.

### Root cause

`.github/workflows/deploy.yml` пересобирает только изменившиеся сервисы:
`CHANGED=$(git diff --name-only "$PREV_SHA" "$NEW_SHA")`. Базлайн брался
так:

```bash
PREV_SHA=$(git rev-parse HEAD)   # ← «что сейчас задеплоено»
git reset --hard origin/main
NEW_SHA=$(git rev-parse HEAD)
```

Замысел: `PREV_SHA` = задеплоенный коммит. Но `git reset --hard` двигает
HEAD **до** сборки. Если сборка падает — HEAD уже на новом SHA, а скрипт
завершается с ошибкой. При ретрае:

- `PREV_SHA = git rev-parse HEAD` = **уже новый SHA** (сдвинут упавшей
  попыткой);
- `git reset --hard origin/main` — no-op;
- `NEW_SHA == PREV_SHA` → `git diff` **пустой**;
- detection не находит ни одного сервиса → ветка «no service-level
  changes» → `docker compose up -d --no-build api bot` + `exit 0`.

Пересборка молча пропущена, exit code 0, CI зелёный.

Отдельно: в репозитории **уже был** правильный артефакт —
`.deploy/last-successful-release`, который пишет `ops/deploy.sh` (ручной
деплой) и читает `ops/rollback.sh`. CI-деплой его игнорировал и вёл
собственный — ошибочный — учёт «прошлого релиза». Два пути деплоя с
расходящимся представлением о том, что задеплоено.

### Урок

**`git HEAD` ≠ «последний успешно задеплоенный коммит».** HEAD двигается
даже при упавшем деплое. Любой шаг вида «сделай А или Б в зависимости от
того, что изменилось с прошлого раза» обязан сравнивать с **персистентным
маркером последнего УСПЕХА**, а не с мутабельным runtime-состоянием
(git HEAD, тег текущего образа), которое меняется в середине процесса.

Второй урок: **ретрай упавшего деплоя обязан быть идемпотентным** — давать
тот же результат, что чистый прогон. Здесь ретрай молча делал меньше, чем
первый прогон, потому что первый прогон оставил после себя побочный
эффект (сдвинутый HEAD).

### Правило

1. **Базлайн change-detection — персистентный маркер, не git-состояние.**
   `deploy.yml` теперь читает `PREV_SHA` из
   `.deploy/last-successful-release`.
2. **Маркер пишется последним действием успешного пути** — после
   build + `up -d` + health-check. Упавший процесс не обновляет базлайн,
   поэтому ретрай видит ту же дельту, что и первая попытка.
3. **Есть артефакт «last good» — переиспользуй, не плоди параллельный.**
   CI-деплой и `ops/deploy.sh`/`ops/rollback.sh` теперь используют один и
   тот же `.deploy/last-successful-release`.
4. **`exit 0` обязан означать «сделано то, что должно».** Ветка «нечего
   пересобирать» легитимна только когда дельта реально пуста — а не когда
   дельту посчитали от испорченного базлайна.

### Лучший код

```bash
# ❌ До: базлайн из git HEAD — на ретрае после падения diff пустой,
#        пересборка пропущена, CI зелёный.
PREV_SHA=$(git rev-parse HEAD)
git reset --hard origin/main
NEW_SHA=$(git rev-parse HEAD)
CHANGED=$(git diff --name-only "$PREV_SHA" "$NEW_SHA")

# ✅ После: базлайн из персистентного маркера последнего успеха.
RELEASE_MARKER=/opt/wishlist/.deploy/last-successful-release
PREV_SHA=""
[ -f "$RELEASE_MARKER" ] && PREV_SHA=$(tr -d '[:space:]' < "$RELEASE_MARKER")
if ! { [ -n "$PREV_SHA" ] && git rev-parse --verify --quiet "${PREV_SHA}^{commit}" >/dev/null; }; then
  # Маркер потерян/битый. НЕ фоллбэчимся на git HEAD — на ретрае после
  # падения он уже сдвинут `git reset --hard`, и баг воспроизведётся.
  # Пустой PREV_SHA = «нет базлайна» → пересобрать всё (over-rebuild безопасен).
  PREV_SHA=""
fi
git reset --hard origin/main
NEW_SHA=$(git rev-parse HEAD)
if [ -z "$PREV_SHA" ]; then
  SERVICES="api bot web"                                  # нет базлайна → полная пересборка
else
  CHANGED=$(git diff --name-only "$PREV_SHA" "$NEW_SHA")   # CHANGED → SERVICES
fi
# ... и в КОНЦЕ каждой успешной ветки (после health-check + проверки
# незавершённых миграций — застрявшая миграция = exit 1, маркер не пишется):
echo "$NEW_SHA" > "$RELEASE_MARKER"
```

Регрессионный тест: `ops/deploy-workflow.test.mjs` (`node:test`, гоняется
через `pnpm test:ops`) — grep-guard на `deploy.yml`: `PREV_SHA` читается из
маркера, маркер пишется в обеих success-ветках (с проверкой порядка — после
health-check), а отсутствие маркера форсит полную пересборку (без фоллбэка
на `git HEAD`). Падает на pre-fix коммите (3 из 33 ops-тестов).

**Commit:** см. `git log --grep="fix(deploy): source PREV_SHA from release marker"`

---

## 2026-05-20 — PRODUCT_EVENT `user.session_started` объявлен и потребляется rollup'ом, но ни один клиент его не эмитит

### Симптом

После деплоя `0cf385a` (UserDailyActivity rollup) колонка
`sessionStarted` оказалась нулевой **на каждой строке** 90-дневного
backfill'а. Прямая проверка AnalyticsEvent:

```
SELECT COUNT(*) FROM "AnalyticsEvent"
WHERE event = 'user.session_started'
  AND "createdAt" >= NOW() - INTERVAL '3 hours';
-- 0
```

Ноль строк за все 3 часа, по всем пользователям. Не «мало активности» —
ровно ноль.

### Root cause

`user.session_started` прошёл весь pipeline, кроме самого первого шага:

1. **Объявлен** — `packages/shared/src/analyticsEvents.ts` как
   PRODUCT_EVENT с `sources: ['client']`.
2. **Пропущен ingest'ом** — `routes/telemetry.routes.ts` пускает его
   через `isClientTelemetryAllowedEvent` (clientAllowed).
3. **Потребляется** — `services/daily-activity.service.ts` `EVENT_TO_FIELD`
   маппит `'user.session_started' → 'sessionStarted'`.
4. **Эмиттера НЕТ.** Ни один callsite в `apps/web` не вызывал
   `trackEvent('user.session_started')`. Таксономия, allowlist и
   потребитель есть — событие просто никем не порождается.

Коварство в том, что **тесты каждого слоя были зелёные**:
`analyticsEvents.test.ts` проверял таксономию, `telemetry.routes.test.ts`
— что ingest принимает событие, `daily-activity.service.test.ts` — что
rollup его маппит. Каждый тест формы «**если** событие придёт — оно
корректно обработается». Никто не проверял «событие **приходит**».

### Урок

**Declared + consumed ≠ emitted.** Событие может пройти всю цепочку
(taxonomy → ingest allowlist → rollup mapping) с зелёным CI и иметь ноль
callsite'ов. Каждый слой тестирует контракт «на входе», но сам вход
может никогда не наступить — а отсутствие данных выглядит неотличимо от
«нет активности».

Сигнал, который надо ловить: **новая колонка durable-таблицы, дающая
ноль/дефолт на КАЖДОЙ строке backfill'а** — это почти всегда «нет
эмиттера», а не «нет активности». Реальная активность шумит; идеальный
ноль — это ненайденный provider.

### Правило

1. **Добавляя событие в `EVENT_TO_FIELD` (или иной durable rollup),
   убедись, что эмиттер уже существует**, прежде чем считать фичу
   готовой. Для client-sourced событий — grep по `apps/web` на
   `trackEvent('<name>')`. Нет callsite'а — фича не готова.
2. **Каждый новый client-sourced PRODUCT_EVENT, потребляемый rollup'ом,
    ships с регрессионным guard'ом, что callsite существует.** Для
   событий, эмитящихся из монолита `MiniApp.tsx`, guard живёт в
   `apps/web/app/miniapp/monolith-guards.test.ts` (grep-style проверка
   исходника — extraction монолита ещё не сделана).
3. **Нулевой результат backfill'а по новой колонке = блокер, а не
   «деплоим, потом посмотрим».** Дефолт на всех строках проверяется до
   закрытия задачи.

### Лучший код

`apps/web/app/miniapp/MiniApp.tsx` — `trackEvent` зеркалит каждый
успешный bootstrap в канонический PRODUCT_EVENT. Сервер резолвит
`userId` из `req.tgUser.id` → `User.id` (cuid) в `telemetry.routes.ts`;
клиент `userId` не отправляет.

```ts
// ❌ До: ~22 callsite'а 'miniapp.bootstrap_succeeded', ни одного эмиттера
//        'user.session_started' → rollup-колонка sessionStarted мёртвая.

// ✅ После: единое зеркало в trackEvent — покрывает все ветки
//          deep-link'ов разом; bootstrap_succeeded → session_started
//          ≤1 на mount (ref-guard), каждый app-open = одно событие;
//          rollup суммирует в sessionStarted как и все COUNTER_FIELDS.
// reuse `entry` → идентичный prop shape (bootSessionId, durationMs, …),
// одна точка построения props.
if (event === 'miniapp.bootstrap_succeeded' && !sessionStartedRef.current) {
  sessionStartedRef.current = true;
  telemetryBufferRef.current.push({
    ...entry,
    event: 'user.session_started',
    props: { ...entry.props, clientEventId: crypto.randomUUID() },
  });
}
```

`apps/web/app/miniapp/monolith-guards.test.ts` — новый guard
«MiniApp.tsx — user.session_started emitter guard»: проверяет, что
исходник содержит эмиттер `'user.session_started'` и что он завязан на
`event === 'miniapp.bootstrap_succeeded'`. Падает на pre-fix коммите,
проходит на fix-коммите.

**Commit:** см. `git log --grep="fix(analytics): emit user.session_started"`

---

## 2026-05-19 — `daily-activity` rollup падал на FK violation у удалённых users

### Симптом

Сразу после деплоя `0cf385a` (новый UserDailyActivity rollup) первый
ручной prod-backfill упал:

```
[backfill-daily-activity] from=2026-02-19 to=2026-05-19 days=90
[backfill-daily-activity] fatal:
Invalid `prisma.userDailyActivity.upsert()` invocation:
Foreign key constraint failed on the field: `UserDailyActivity_userId_fkey (index)`
```

Dry-run (`--dry-run --days 90`) проходил чисто: 90 дней, 64 user-day,
152 events, ноль ошибок. Реальный backfill сразу 23503-нулся. Если бы
не ручной gate перед записью, то же самое случилось бы со scheduler'ом
на следующем hourly tick'е — и наполнение таблицы тихо бы стопалось.

### Root cause

`AnalyticsEvent.userId` — soft pointer:

```prisma
model AnalyticsEvent {
  ...
  userId    String?   // nullable, NO foreign key
  ...
}
```

(см. [schema.prisma:1369-1382](../packages/db/prisma/schema.prisma)).
Когда `User` hard-удаляется, его строки в AnalyticsEvent остаются —
это by design, чтобы god-mode сегментные запросы не теряли историю.

Моя свежая `UserDailyActivity`, наоборот, объявлена с
`ON DELETE CASCADE` FK на `User.id`:

```sql
CONSTRAINT "UserDailyActivity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ...
```

(см. [packages/db/prisma/migrations/20260520000000_add_user_daily_activity/migration.sql](../packages/db/prisma/migrations/20260520000000_add_user_daily_activity/migration.sql)).

CASCADE решает будущие удаления, но не помогает на INSERT для уже
удалённого user'а. На проде: 34 dangling cuid'а, 175 events за 90
дней. Самые "толстые" 13 events на один ghost-id. После
сегодняшней миграции [20260519180000_normalize_analyticsevent_userid](../packages/db/prisma/migrations/20260519180000_normalize_analyticsevent_userid/migration.sql)
весь numeric-telegram-id мусор был зачищен в NULL, но dangling-cuid
(удалённые после нормализации users) — отдельный класс данных.

В `aggregateDay()` я брал `prisma.analyticsEvent.findMany` без
проверки существования user'а и сразу шёл в `prisma.userDailyActivity.upsert` —
первая попавшаяся осиротевшая строка ломала весь день, а с ним и
всю range-операцию backfill'а.

### Урок

**`AnalyticsEvent.userId` ≠ валидный `User.id` живого user'а.** Это
nullable soft pointer, который **может указывать на**:

1. Существующий `User.id` (cuid) — happy path.
2. `NULL` — анонимные / системные events.
3. **Cuid удалённого user'а** — long tail, постоянно растёт.

Любой код, который upsert'ит производную таблицу с FK на `User`, обязан
явно фильтровать (3) до записи. Тест на чистом mock'е не ловит — у мока
нет понятия FK. Нужен integration test против живого Postgres'а с
заранее-известно-несуществующим userId в AnalyticsEvent.

Дополнительный урок: **dry-run не покрывает write path'и**. Мой
`--dry-run --days 90` пробежал чисто, потому что fatal жил в `upsert`,
а `dryRun: true` ровно его и пропускал. То есть текущая семантика
dry-run'а помогает оценить scale (объём rows / events), но не
verify-ить, что write actually works. Это feature, не bug — но
называть `dry-run` "проверкой готовности к real backfill" — leak of
abstraction. См. правило ниже.

### Правило

1. **Любая новая таблица с FK на `User`, которая заполняется из
   `AnalyticsEvent`, должна фильтровать `userId` через лукап в `User`
   перед записью.** Шаблон:

   ```ts
   const candidateIds = Array.from(byUser.keys());
   const existing = await prisma.user.findMany({
     where: { id: { in: candidateIds } },
     select: { id: true },
   });
   const validIds = new Set(existing.map((u) => u.id));
   for (const id of candidateIds) if (!validIds.has(id)) byUser.delete(id);
   ```

2. **Drop-count должен попадать в логи и в return-shape** (`droppedUsers`
   в `AggregateDayResult`), иначе массовая чистка users проедет молча.

3. **Integration test обязателен** на dangling-userId case — unit-test
   с mock-Prisma не отлавливает FK 23503. Тест должен создавать
   `AnalyticsEvent` с cuid-shaped id, которого нет в `User`, и
   утверждать, что `aggregateDay` не throw'ит, ghost-bucket дропается,
   валидные users по-прежнему upsert'ятся. См.
   [`apps/api/test/integration/daily-activity-rollup.test.ts`](../apps/api/test/integration/daily-activity-rollup.test.ts)
   "drops events whose userId no longer exists in User".

4. **Dry-run в backfill-скриптах НЕ доказывает, что real write
   пройдёт.** Минимум, что dry-run проверяет — read path + range
   шейп + распределение counters. Для real-write confidence нужен
   integration test или ручной smoke на single day (`--from D --to D`,
   not 90).

### Лучший код

`apps/api/src/services/daily-activity.service.ts`:
- `aggregateDay` после `mapEventsToCounters` делает `prisma.user.findMany`
  по distinct userIds бакета, выкидывает несуществующих, инкрементит
  локальный `droppedUsers`.
- `AggregateDayResult` теперь содержит `droppedUsers: number`.
- Logger emits `droppedUsers` в каждом `[daily-activity] day aggregated`.

`apps/api/src/scripts/backfill-daily-activity.ts`:
- Per-day строка показывает `droppedUsers=N` если N > 0.
- Финальный summary: `droppedUsers=<sum>` всегда.

`apps/api/test/integration/daily-activity-rollup.test.ts`:
- Новый тест "drops events whose userId no longer exists in User" с
  cuid-shaped ghost id (`'c' + 'z'.repeat(24)`), assertion на отсутствие
  throw + drop ghost-bucket + сохранение valid bucket.

---

## 2026-05-19 — Survey recipient dry-run падал на двух raw-SQL запросах

### Симптом
Первый dry-run `selectSurveyRecipients` на проде упал с
```
Raw query failed. Code: `42703`.
Message: `column r.reserverUserId does not exist`
```
из `querySegmentS5`. Параллельно второй раздел (`classifyS8` → guest engagement)
читал `ReservationMeta.ownerId`, которого тоже нет — но до него управление
не доходило, потому что S5 валилась первой.

Юнит-тесты по `stratifiedSample` (9 штук) проходили зелёным, а интеграционный
смок по `selectSurveyRecipients` я не написал — там были `RC-*` пункты в
плане, но реализован только `RC-9` (стратификация). Эти `prisma.$queryRaw`
шаблоны на реальной схеме ни разу не запускались до прода.

### Root cause
`apps/api/src/services/research-survey/recipients.ts` имел два склеенных
домысла на тему схемы:

1. `querySegmentS5` собирал «гостевых резерверов» из `ReservationEvent`. У
   `ReservationEvent` нет `reserverUserId` — там только `actorHash`.
   Колонка `reserverUserId` живёт на `ReservationMeta` (см.
   [schema.prisma:1698-1726](../packages/db/prisma/schema.prisma)).
2. `classifyS8` для guest engagement читал `ReservationMeta.ownerId` —
   такого столбца у `ReservationMeta` нет вообще. Owner лежит на
   `Wishlist.ownerId` и достижим только через join `Item → Wishlist`.

Корень обеих ошибок один: я предположил денормализацию там, где её нет.
В реальной схеме reserver-ownership резолвится через item, а не через
прямую ссылку на ReservationMeta.

### Урок
Прохожу глазами `schema.prisma` — это не то же самое, что прогнать
запрос. Raw SQL никогда не получает помощи от Prisma при типизации
полей; одна неверная буква = 500 в проде. Если query touches таблицы
которые я лично не писал в текущем PR, нужен интеграционный тест,
который этот SQL прогонит через реальную схему.

### Правило
Любой `prisma.$queryRaw` шаблон в новом сервисе должен сопровождаться
интеграционным тестом, который вызывает обёртку (а не SQL напрямую) и
ассертит `expect(rows.length).toBe(N)`. Тест должен ехать через CI
Postgres service. Unit-тесты по чистым функциям внутри того же файла
**не** покрывают raw-SQL — это разные слои.

### Лучший код
- `querySegmentS5` теперь джойнит `ReservationMeta → Item → Wishlist`,
  фильтрует `rm.active = true`, `w."ownerId" <> rm."reserverUserId"`.
- `classifyS8` guest-engagement подзапрос тоже идёт через джойн с
  `Item → Wishlist`, плюс явный `w."ownerId" <> rm."reserverUserId"`
  чтобы self-reservation не считалась за гостевое движение.
- Новый
  [`apps/api/test/integration/research-survey-recipients.test.ts`](../apps/api/test/integration/research-survey-recipients.test.ts):
  9 тестов на S5 happy/self-reserve/inactive-meta, S8
  activated_then_churned vs shared_no_guest_action, base-filter
  exclusions (godMode / notifyMarketing / new-user-7d) + read-only
  side-effect assertion. Auto-skip без `DATABASE_URL`, на CI едет на
  настоящем Postgres.
- При следующем dry-run эти ветки прогрелись бы локально, а не падали
  бы 500 в проде на read-only команде.

---

## 2026-05-19 — `AnalyticsEvent.userId` гетерогенное поле (cuid + telegramId)

### Симптом
При расчёте размеров пользовательских сегментов (см.
[docs/research/segment-sizes-2026-05.md](research/segment-sizes-2026-05.md))
наивный `JOIN "User" u ON u.id = ae."userId"` отдавал 0 для events,
которые на самом деле есть в базе. Конкретный кейс: `share.token_generated`
имеет 20+ строк в `AnalyticsEvent`, но `INNER JOIN` через `User.id` возвращал
ноль уникальных пользователей. Cohort/retention запросы, построенные по
этому полю, занижают N в 9 раз.

### Root cause
`AnalyticsEvent.userId` — обычный `String?` без FK. На него пишут два
независимых эмиттер-пути с **разными форматами** идентификатора:

1. **Server-side** (`services/analytics.ts`: `trackEvent` /
   `trackAnalyticsEvent` / `trackProductEvent`) — callsite'ы передают
   `user.id` (внутренний cuid после `getOrCreateTgUser`).
2. **Frontend** (`POST /tg/telemetry` →
   `apps/api/src/routes/telemetry.routes.ts:119`) и два эмиттера в боте
   (`apps/bot/src/index.ts:653, 780`) — писали
   `String(req.tgUser.id)` / `String(ctx.from.id)`, т.е. **Telegram numeric
   id**, не cuid.

На проде snapshot 2026-05-19: total 10 517 строк, из них 1 111 в формате
cuid, 9 249 — numeric, 157 NULL. ~88% событий не матчилось на `User.id`.

Дополнительные viral pattern'ы: 9 route-handler callsite'ов в API
(`reservation.succeeded`, `wish.edited`, `wishlist.deleted` и др.) копировали
тот же неправильный шаблон через `userId: String(req.tgUser!.id)`, даже когда
`user.id` уже был в scope тремя строками выше.

### Lesson
Когда у поля **нет foreign key** и нет статической типизации, контракт
держится только на дисциплине эмиттеров. **TypeScript-сигнатура** `userId?:
string` не отличает «строку User.id» от «строки telegramId» — оба
проходят typecheck. В отсутствие FK единственная защита — runtime test
или static grep guard.

### Rule

1. **`AnalyticsEvent.userId` всегда хранит `User.id` (cuid) или NULL.**
   Telegram numeric id никогда не попадает в эту колонку. Контракт описан
   в [docs/analytics-events.md § «AnalyticsEvent.userId contract»](analytics-events.md#analyticseventuserid-contract--internal-userid-only).
2. **В роуте, который уже вызывает `getOrCreateTgUser(req.tgUser!)`,
   используем `user.id`.** Никогда `String(req.tgUser!.id)` рядом с
   `userId:`.
3. **Если userId нужен без upsert** (telemetry, error tracker) — есть
   `resolveTgUserId(req.tgUser?.id)` в `services/telegram-auth.ts`:
   read-only `findUnique` по telegramId, на miss возвращает `null`, а
   не raw telegram id.
4. **В bot-handler'е, который уже `prisma.user.upsert(...)`-нул**, —
   `user?.id ?? null`. Никогда `String(ctx.from.id)` или `telegramId`
   (имя локальной переменной в боте).
5. **Static regression guard** —
   [`apps/api/src/analytics-event-userid-contract.test.ts`](../apps/api/src/analytics-event-userid-contract.test.ts) —
   грепает обе ловушки (`String(req.tgUser…)` и `userId: telegramId`)
   при каждом запуске CI. Падает раньше, чем регрессия доедет до прода.

### Better code

**Было** (`apps/api/src/routes/telemetry.routes.ts:119`):
```ts
const userId = req.tgUser?.id ? String(req.tgUser.id) : null; // ❌ telegramId
```

**Стало:**
```ts
// Canonical contract: AnalyticsEvent.userId is always internal User.id
// (cuid). Server resolves it from the authenticated initData; client-
// supplied userId is ignored.
const userId = await resolveTgUserId(req.tgUser?.id); // ✅ cuid or null
```

И helper в `services/telegram-auth.ts`:
```ts
export async function resolveTgUserId(
  telegramId: number | string | undefined | null,
): Promise<string | null> {
  if (telegramId == null) return null;
  const row = await prisma.user.findUnique({
    where: { telegramId: String(telegramId) },
    select: { id: true },
  });
  return row?.id ?? null;
}
```

Backfill исторических строк — миграция
[`20260519180000_normalize_analyticsevent_userid`](../packages/db/prisma/migrations/20260519180000_normalize_analyticsevent_userid/migration.sql).
Dry-run на проде:

```
BEFORE: total=10527 null=158 cuid=1111 numeric=9258
AFTER : total=10527 null=216 cuid=10311 numeric=0
```

9 200 строк нормализовалось через `User.telegramId` lookup; 58
осиротевших (удалённые юзеры) → NULL, чтобы не оставлять numeric-string
артефакты которые сломают будущие cohort-запросы повторно.

---

## 2026-05-18 — «Ошибка загрузки» тосты на экране Настроек (304 + `!res.ok`)

### Симптом
На экране «Настройки» Mini App стек из нескольких красных тостов
«Ошибка загрузки», сам экран ниже заголовка пустой. Воспроизводилось
у пользователей в Telegram desktop на macOS и в iOS Telegram, но не в
Chrome desktop. В прод-логах за день: `/tg/me/profile` 7× статус 304,
`/tg/me/subscriptions/meta` 6×, `/tg/me/showcase` 4×,
`/tg/me/dont-gift` 2×. API при этом возвращал `{"ok":true}` на
`/health`, миграции и контейнеры в порядке.

### Root cause
Цепочка из трёх независимых факторов, каждый по отдельности безвреден:

1. **Express по умолчанию генерит weak ETag** на каждый JSON-ответ
   (опция `etag: 'weak'`). Этот флаг нигде в репо не выставлялся явно,
   мы наследовали default.
2. **Браузер кэширует ETag и шлёт `If-None-Match`** на повторных
   запросах. Сервер через middleware `fresh()` сравнивает ETag и при
   совпадении возвращает `304 Not Modified` с пустым телом.
3. **Лоадеры в `MiniApp.tsx` проверяют `if (!res.ok) throw …`** —
   `loadProfile`, `loadShowcase`, `loadSettings`, `loadItems`, и ещё
   ~7 других. `res.ok` истинно только для статусов 200-299, для **304
   это `false`** (по спецификации Fetch API).
4. Дополнительный fuel: на WebKit (iOS Telegram, Telegram desktop на
   macOS) `fetch()` иногда передаёт 304 в JS с пустым телом вместо
   прозрачной подмены кэшированного тела (WebKit bug 171052). Даже
   если бы `res.ok` правильно обрабатывался, тело при таком 304 пусто
   и `res.json()` упал бы.

Итог: каждый GET, который ревалидировался как 304, превращался в
«Ошибка загрузки» тост. Тап «Профиль» в нижней навигации одновременно
зовёт `loadProfile` + `loadShowcase` — оба 304 — два тоста.

### Fix
Двухслойная защита, оба слоя в одном коммите:

- **Server-side** (`apps/api/src/index.ts`): `app.set('etag', false)`
  сразу после `trust proxy`. Express перестаёт ставить ETag, браузер
  перестаёт слать `If-None-Match`, 304 не возникает в принципе.
- **Client-side** (`apps/web/app/miniapp/MiniApp.tsx`, `tgFetch`):
  `cache: init?.cache ?? 'no-store'` в опциях `fetch()`. Это belt
  поверх server-side suspenders — даже если кто-то завтра поставит
  `res.set('ETag', ...)` точечно, или nginx начнёт ставить ETag,
  браузер не отправит `If-None-Match` и не получит 304.

Регресс-тест: `apps/api/src/etag.test.ts` — поднимает зеркало
bootstrap-конфига, делает запрос с `If-None-Match: W/"stale-value"`,
ожидает 200 без ETag-заголовка в ответе.

### Урок
- Default-настройки фреймворков опасны на стыке с custom-клиентом.
  Express ETag — это не «оптимизация которую мы включили», это «опция
  которую забыли проверить». Любая «магия по умолчанию» во внешнем
  фреймворке должна быть осознанно либо принята, либо отключена.
- `res.ok` — это лёгкий, но **узкий** контракт. Он не покрывает 3xx
  (304/301/302/etc), и если код полагается на «успех = `res.ok`», то
  любая редирект-логика или conditional-GET ломает его молча.
- WebKit/Safari + cache в WebView — отдельный класс quirks. То что в
  Chrome работает, в Telegram WebView может быть тонко сломано.
  Defense in depth (server + client) дешевле, чем диагностика после.

### Правило
1. **Любой новый GET-loader в Mini App** должен делать `if (res.status
   < 200 || res.status >= 300)` либо использовать узкий контракт
   `if (res.status !== 200)`. Никаких голых `!res.ok` для GET в новом
   коде. Старые места оставляем — `tgFetch` теперь шлёт
   `cache: 'no-store'` и 304 невозможен.
2. **API ставит явный `app.set('etag', false)`** — фиксированный
   контракт, не наследуем default. Если кому-то понадобится ETag
   точечно, это будет осознанное решение с тестом и записью в
   DESIGN_DECISIONS / API_SECURITY.
3. **Любой новый middleware/настройка в API bootstrap** требует
   проверки: «как это взаимодействует с Mini App fetch и его
   `if (!res.ok)` паттерном?» В CLAUDE.md API rules уже есть подобная
   чек-листина — этот пункт добавляется к defense-in-depth.

### Лучший код (паттерн)

```ts
// apps/api/src/index.ts — bootstrap config, явный контракт:
const app = express();
app.set('trust proxy', 1);
app.set('etag', false);  // см. docs/BUGFIX_LESSONS.md (2026-05-18)
```

```ts
// apps/web/app/miniapp/MiniApp.tsx — tgFetch chokepoint:
const res = await fetch(url, {
  ...init,
  cache: init?.cache ?? 'no-store',  // см. BUGFIX_LESSONS.md (2026-05-18)
  signal: controller.signal,
  // …
});
```

---

## 2026-05-17 — iOS «замораживание» горизонтальной полосы chips на SearchScreen

### Симптом
В Mini App на iOS: поиск работает, но после нажатия на любую chip-у в
горизонтальном scroll-контейнере (категория / фильтр / smart-chip) сам
контейнер перестаёт принимать касания — выглядит как «заморозка»: можно
тапать кнопку поиска, но провести пальцем по chips-row нельзя, ни одна
chip не нажимается. Помогает только полное закрытие WebView. Android и
Chrome desktop не воспроизводят.

### Root cause
Два независимых iOS WKWebView-quirks накладывались поверх друг друга на
горизонтально-скроллящемся flex-row с inline-styles:

1. **Отсутствие `-webkit-overflow-scrolling: touch`** на контейнерах
   `chipsRow` и `smartChipsRow`. Без него iOS использует синхронный
   scroll, который после первого touch-tap события на дочерней кнопке
   входит в неопределённое состояние и игнорирует последующие touchstart
   до scroll-reset.
2. **Шорт-форма `border`** на самих chip-кнопках. iOS Safari при
   `border: '1px solid X'` на focusable элементе внутри
   overflow-x-scroll контейнера может терять touch-target hitbox
   после первого re-render. Раскладка `borderWidth/Style/Color` в
   long-form исправляет это.

### Fix
В `apps/web/app/miniapp/screens/SearchScreen.tsx`:

- На `chipsRow` и `smartChipsRow`: добавили
  `WebkitOverflowScrolling: 'touch'` и `touchAction: 'pan-x'` (iOS
  знает, что row реагирует только на горизонтальный pan, всё остальное
  пропускает дочерним элементам).
- На `chip` и `smartChip` кнопках: добавили
  `touchAction: 'manipulation'` (явный фолбэк, чтобы кнопки не пытались
  претендовать на pan-y) и переписали `border` как `borderWidth /
  borderStyle / borderColor` longhand.

### Урок
Inline-styles на горизонтальных scroll-контейнерах внутри Telegram Mini
App нужно перепроверять под iOS WKWebView отдельно — Chrome devtools
никогда не воспроизводит эти баги. Минимальная защитная троица:
- контейнер: `WebkitOverflowScrolling: 'touch' + touchAction: 'pan-x'`
- ребёнок-кнопка: `touchAction: 'manipulation' + border longhand`
- желательно проверить на реальном iPhone в Telegram, не в Safari.

### Правило
Для любого нового горизонтального scroll-контейнера с тап-таргетами
внутри Mini App: applying these three style props is mandatory в первой
итерации, не «когда пользователь пожалуется». Эта тройка дешёвая, не
ломает Android/desktop и закрывает класс багов целиком. Если pattern
повторяется ещё раз — выносить в дизайн-токен/примитив.

### Лучший код (паттерн)
```tsx
const scrollRow: React.CSSProperties = {
  display: 'flex',
  overflowX: 'auto',
  WebkitOverflowScrolling: 'touch',
  touchAction: 'pan-x',
};
const tapChip: React.CSSProperties = {
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--wb-border)',
  touchAction: 'manipulation',
};
```

---

## 2026-05-17 (preventive) — Hardening watchdog после ложного алерта

### Контекст
Запись ниже («Ложный watchdog-алерт») закрыла root cause и три латентных
бага одним PR'ом. Но осталось несколько системных слабостей, которые сами
по себе ещё не выстрелили, но при следующем подобном инциденте могли бы
дать второй ложный алерт или потерять детекцию настоящего downtime. Этот
follow-up превентивно их закрывает — никаких новых багов в проде не было,
просто apriori более прочная конструкция.

### Что было слабым
1. **State в `/tmp`.** `WATCHDOG_STATE_FILE` дефолтился на `/tmp/watchdog-state.json`.
   `/tmp` чистится при reboot и иногда при background `tmpwatch` — то есть
   dedup и счётчик «2 consecutive DOWN» могли молча обнулиться между cron-тиками,
   и реальный outage сразу после reboot получил бы alert на первом же DOWN
   (что не криминально), а dedup recover-флага потерялся бы (что хуже —
   спам RECOVERY-алертов).
2. **Не-атомарная запись.** `fs.writeFileSync(path, JSON.stringify(state))`
   при crash посередине оставлял бы truncated JSON. На следующем тике
   `JSON.parse` молча падал в `catch` → defaults → состояние «всё с нуля»
   без предупреждения.
3. **Никакой защиты от наложений cron.** Если SQL-проба зависала и тик
   шёл > 5 минут, следующий cron стартовал бы поверх — два процесса
   читали бы и переписывали один файл без координации, race на
   `consecutiveDownChecks`.
4. **Нет тестов на state-машину.** Изменения в counter logic ловились
   только глазами и через ручной smoke-test после деплоя.
5. **Нет операционного сигнала на «exposureCount = 0 после 15min».**
   Latent bug `createDowntimeExposures` молча шёл месяц — если бы он
   повторился в любой форме, мы бы не увидели до следующего реального
   downtime.
6. **Telegram-доставка best-effort без проверки.** `fetch().then(...)`
   без чтения body, без `body.ok`, без обработки 429 retry_after.
   Возможный 429 терялся и алерт уходил в /dev/null.
7. **Нет `--check` режима в `setup-dns.sh`.** Operator не мог быстро
   проверить, остался ли prod-сервер в правильной DNS-конфигурации без
   риска что-то поменять.

### Что починили
- `ops/watchdog/state.mjs` — pure state machine + atomic `saveStateAtomic`
  (tmp в той же директории → `fsync` → `rename` → `fsync` родительского dir).
  `loadState` tolerant: missing → defaults, invalid JSON → defaults +
  backup `<path>.corrupt-<ts>` + warning на stderr.
- `health-watchdog.mjs` теперь импортирует transitions из state.mjs.
  Default state path → `/var/lib/wishlist/watchdog/state.json` (отдельная
  0700 dir, 0600 file). Dedicated subdir выбран специально, чтобы chmod
  0700 в `ensureStateDir` не накрывал shared parent `/var/lib/wishlist/`.
  One-time legacy fallback читает `/var/lib/wishlist/watchdog-state.json`
  и `/tmp/watchdog-state.json` (newest-first); следующий save пишет уже
  в новое место. Legacy файлы НЕ удаляются автоматически.
- `ops/watchdog/run-health-watchdog.sh` — flock-обёртка. `flock -n` на
  `/var/lock/wishlist-watchdog.lock`; если предыдущий тик не закончился,
  новый чисто выходит 0 с одной log-строкой. Cron-line в
  `ops/cron/root.crontab` обновлён.
- Pure-logic тесты — `ops/watchdog/state.test.mjs`, 26 кейсов через
  `node:test`. Запуск через `pnpm test:ops`. Покрытие: full lifecycle
  (blip → suspicion → promote → recover), state-file round-trip,
  corrupted-JSON → safe defaults + backup, zero-exposure dedup
  (alert once, prune on recovery, prune on back-fill).
- Zero-exposure детектор внутри watchdog'а: каждый тик SELECT по
  `MaintenanceIncident` со status active/recovering, age ≥ 15 min, и
  **живой** `COUNT(*)` из `MaintenanceExposure` (не cached column, потому
  что cached column — это и есть бажный сигнал). Один Telegram-алерт
  на incident, dedup в `state.zeroExposureAlertedIncidentIds`,
  автоматическое pruning при recovery / back-fill.
- `sendAlert` теперь проверяет HTTP status, `body.ok`, логирует
  `error_code` и `description`. На 429 — один retry, respecting
  `parameters.retry_after`. Никогда не throw'ит — иначе degraded
  Telegram скрыл бы реальную причину alert'а.
- `ops/vultr/setup-dns.sh` получил `--check` / `--apply` / interactive
  parity с `setup-nginx.sh`. `--check` ничего не меняет, выходит non-zero
  при дрейфе — годится для cron-мониторинга. Проверяет: симлинк, head-файл,
  и **порядок резолверов в живом** `/etc/resolv.conf` (Quad9/Cloudflare
  должны идти ДО `108.61.10.10`).

### Правила
- **State health-watchdog (и вообще любой dedup для алертов) живёт в
  `/var/lib/<service>/`, не в `/tmp`.** `/tmp` это для эфемерного.
- **Любая запись state-файла — атомарная через tmp + rename.** Никогда
  `writeFileSync` напрямую в финальный путь.
- **Любой cron-job чувствительный к state — запускается через
  `flock -n`.** Non-blocking, чтобы новый запуск не наслаивался на
  зависший предыдущий.
- **Pure state transitions выносятся в отдельный модуль с
  `node:test`-ами.** Refactor pre-fix → нельзя. State-машина без тестов
  — это «надеемся что smoke-test ничего не пропустил».
- **Любой alert-channel** (Telegram, Slack, email) проверяет HTTP status
  AND application-level `ok`/error поле. Лучше «доставка упала, но я
  залогировал в stderr» чем «отправил и забыл».
- **Кешированные `*Count` колонки на бизнес-таблицах — подозрительные
  по умолчанию.** Сверка с живым `COUNT(*)` должна быть в monitoring,
  не в production debug session после инцидента.

### Postdeploy
- Применить на prod (вне этого коммита):
  - `sudo /opt/wishlist/ops/vultr/setup-dns.sh --check` — должен пройти
  - `sudo crontab /opt/wishlist/ops/cron/root.crontab` — обновить cron на
    запуск через wrapper
  - Первый запуск `/opt/wishlist/ops/watchdog/run-health-watchdog.sh`
    создаст `/var/lib/wishlist/watchdog/state.json` и (если есть)
    подхватит legacy `/var/lib/wishlist/watchdog-state.json` либо
    `/tmp/watchdog-state.json` один раз. Старые файлы не удаляются —
    проверить и удалить вручную после успешного первого save.
- Локально: `pnpm test:ops` → 26 passed.

### Сознательно не сделано
- **SIGKILL race** между `sendAlert` и `saveStateAtomic` после промоушена
  — inherited issue, маленькое последствие (incidentId теряется для
  трекинга, recovery работает по status), не блокер.
- **Per-process backoff** в zero-exposure детекторе шире 5 минут (e.g.
  на час) — текущий dedup в state-файле уже не даёт спама.
- **Полная замена `docker compose exec psql` на `pg_isready`/прямое
  подключение** — отдельный рефакторинг, не относящийся к этой ветке.
- **Recovery `UPDATE … WHERE status IN ('active','recovering')` не
  фильтрует по `incidentId`** — это inherited поведение из старого кода
  и оно может за один тик "закрыть" чужой одновременный incident.
  В этом PR'е НЕ исправлено — это отдельный change, требующий аккуратно
  пройтись по `services/maintenance` / API на API-стороне. Закрытие этого
  follow-up'а должно идти отдельным diff'ом, не смешиваясь с watchdog
  hardening'ом.

### Поправки по результатам own-review pass перед PR
- `evaluateZeroExposureAlerts` больше не атомарно «пометил alerted».
  Pure-функция теперь возвращает только pruned-state + список `toAlert`,
  caller вызывает `markZeroExposureAlerted(state, ids)` ТОЛЬКО ПОСЛЕ
  успешной Telegram-доставки. Если канал лёг — следующий 5-мин тик
  ретраит. Иначе один сетевой блип терял alert навсегда (до recovery).
- `sendAlert` возвращает `boolean` — гранулярный per-chat успех
  агрегируется через "≥1 чат принял = доставлено", чтобы один забаненный
  бот в чате не валил alert для остальных.
- `fetchZeroExposureCandidates` теперь отбрасывает строки с непарсящимся
  `COUNT(*)` (через `Number.isFinite`), а не молча трактует как «0
  exposures» — иначе один поломанный psql-output дал бы fake-zero alert.
- `run-health-watchdog.sh` получил `WATCHDOG_REQUIRE_FLOCK=true` режим
  для prod fail-closed: если `flock(1)` отсутствует и переменная
  включена — wrapper выходит exit 2, а не запускается unguarded.

---

## 2026-05-17 — Ложный watchdog-алерт «Wishlistik DOWN» из-за флапа Vultr DNS

### Ошибка
В 02:25:01 UTC прилетело Telegram-уведомление от админ-watchdog'а:
```
🔴 Wishlistik DOWN at 2026-05-17T02:25:01.152Z
• web homepage → AbortError: This operation was aborted
```
К моменту инвестигации (6 часов спустя) приложение было полностью
здорово, web/api/bot контейнеры не перезагружались, OOM/высокой
нагрузки не было, в `docker logs wishlist-prod-web-1` за окно 02:00–02:40
тишина. В `/var/log/watchdog.log` цепочка алерта длилась 15 минут:
`02:25` DOWN → `02:30/02:35/02:40` recovery 1/2/3 → `02:40` RECOVERED.
Реальный «инцидент» — одиночное окно проверки шириной < 5 минут.

### Root cause
`/etc/resolv.conf` начинался с `nameserver 108.61.10.10` (Vultr
recursive resolver) — cloud-init пишет его в
`/etc/network/interfaces.d/50-cloud-init`. Этот резолвер в момент
инцидента (и до сих пор!) флапает: 10 подряд проб `host wishlistik.ru
108.61.10.10` дают 5 успешных за <50ms и 5 тайм-аутов по 5s. glibc
ждёт ответа 5s перед фолбэком на `9.9.9.9` (второй в списке).

Watchdog имеет `WATCHDOG_TIMEOUT_MS=8000` и делает три fetch параллельно
к `https://wishlistik.ru/...`. Если оба захода (первичный + один
автоматический retry через 5s) попали в «slow DNS» — 5s DNS-резолва съели
почти весь бюджет, `AbortError` срабатывает до того, как fetch успевает
получить ответ от nginx. В `access.log` видно: первая проверка получила
`GET / → 200 3223` за 5+s (под пределом), retry — `GET /` уже не дошёл
до nginx (запись отсутствует), а `health/deep` + `tg/bootstrap` retry
успели за <100ms потому что glibc DNS cache уже warm на `wishlistik.ru`.

Все остальные следы (Next.js stack traces, system load, mem) — отвлечения.
Никаких реальных проблем у приложения в это окно не было.

Заодно нашёл побочный баг — `createDowntimeExposures()` использовал
`INSERT … RETURNING id` через `psql -t -A -c`. psql добавляет к выводу
строку `INSERT 0 1` (CommandStatus), а `.trim()` снимает только трейлинг
newline. В результате incidentId получался как `"<uuid>\nINSERT 0 1"`,
FK-инсерт `MaintenanceExposure` падал на этом же шаге, и **никаких
exposure-записей не создавалось ни разу** с момента когда watchdog
поселился в кроне. 8 ghost-инцидентов в `MaintenanceIncident` с
`exposureCount=0, notificationsSent=0` подтверждают: если бы был
реальный downtime, recovery-уведомления никому бы не ушли.

### Урок
- **Watchdog с тайм-аутом 8s в HTTP-пробе считал DNS-резолв одного
  имени и сам HTTP-запрос одним и тем же бюджетом.** Один транзиентный
  5s DNS-hiccup → false positive. Никакой запас не был заложен.
- **«Первая неудача = инцидент» — слишком чувствительно.** Watchdog с
  крон-частотой 5 минут должен требовать как минимум 2 подряд DOWN до
  эскалации; запас в 10 минут детекции тут стоит дешевле, чем
  систематическая 3 утра тревога на ровном месте.
- **`psql -t -A -c "… RETURNING …"` НЕ возвращает только rows.** Он
  всегда дописывает `CommandStatus` (`INSERT 0 1`, `UPDATE 5` и т.п.).
  Это известное поведение psql, легко проглядеть при ручном парсинге.
  Лучше генерить идентификаторы на стороне приложения и не полагаться
  на RETURNING в shell-out скриптах.
- **«0 exposures, 0 notifications» в подряд идущих инцидентах — это
  не «инциденты были тривиальными».** Это бесшумный молчаливый баг,
  который надо ловить операционным алертом («если новый incident, а
  через 15 минут `exposureCount` всё ещё 0 — это баг»).

### Правила
- **Health probe budget ≥ `(worst-case DNS) + (worst-case TLS) + (worst-case
  app reply) + headroom`.** Для нашего стека и текущей DNS-практики это
  ≥ 15s. Жёстче — приглашаем регулярные false positives.
- **На облачных VPS с управляемым DNS — НЕ доверяем DNS провайдера
  один-на-один.** Ставим публичные резолверы (Quad9 / Cloudflare) первыми
  через `/etc/resolvconf/resolv.conf.d/head`, провайдерский остаётся
  фолбэком. Закрепляем через симлинк `/etc/resolv.conf →
  /run/resolvconf/resolv.conf`, иначе DHCP/cloud-init перезатрёт.
- **Любой watchdog, который шлёт алерт, требует ≥2 consecutive failed
  checks.** Один retry внутри одного запуска не считается — он попадает
  в то же DNS/network failure window.
- **Никакого parsing RETURNING через `psql -t -A -c` в shell-скриптах.**
  Либо генерим UUID на стороне Node/Python, либо отдельный `SELECT`
  после `INSERT`. Если очень надо — `psql --no-psqlrc -At -c "INSERT … RETURNING id" | head -1`.

### Лучший код
- `ops/watchdog/health-watchdog.mjs`: `WATCHDOG_TIMEOUT_MS` дефолт
  `8000 → 15000`; добавлено состояние `consecutiveDownChecks` +
  `firstDownSince`, алерт + создание `MaintenanceIncident` промоутятся
  только начиная со второго подряд DOWN; UUID для инцидента генерится
  через `randomUUID()` в Node, отдельный `SELECT COUNT(*)` вместо
  `INSERT … RETURNING`.
- `ops/vultr/setup-dns.sh`: новый идемпотентный скрипт — кладёт Quad9 +
  Cloudflare в `/etc/resolvconf/resolv.conf.d/head` и переключает
  `/etc/resolv.conf` на симлинк к runtime-файлу. Безопасно перезапускать
  при будущих переустановках сервера / миграциях.
- `ops/nginx/scanner-block.conf.snippet`: добавлен exact-match
  `location = /`, дропающий все методы кроме GET/HEAD. У нас нет
  Server Actions в `apps/web/`, поэтому POST к `/` — это всегда сканер;
  убирает 45+ Next.js стек-трейсов в день в `docker logs web`.
- `MaintenanceIncident`: 8 ghost-строк (exposureCount=0) удалены вручную
  на проде (см. § Postdeploy ниже).

### Postdeploy
- Vultr resolver (`108.61.10.10`) флапает прямо сейчас — после фикса
  `host wishlistik.ru` стабильно отвечает <0.7s (10/10 проб). До фикса
  было 5/10 timeout по 5s.
- Watchdog state file `/tmp/watchdog-state.json` после первого нового
  запуска подхватит дефолты для `consecutiveDownChecks`/`firstDownSince`
  через destructuring в `loadState()`, чистить не нужно.
- В кроне watchdog запускается каждые 5 минут — следующий запуск
  поднимет обновлённый скрипт автоматически (через git pull в
  `/opt/wishlist/`); nginx перечитывает конфиг вручную `nginx -s reload`.

---

## 2026-05-16 — Flaky CI: birthday-reminders test зависел от часа суток на момент запуска

### Ошибка
`src/schedulers/birthday-reminders.test.ts` блокировал деплой PRO-renewal
фикса. На CI с момента 2026-05-15 14:44 UTC (последний успешный деплой)
ничего не менялось в `birthday-reminders.{ts,test.ts}`, но запуск в
2026-05-16 19:53 UTC падал на 1–3 тестах из 5 (`runs on hourly cadence`,
`writes a ServiceHeartbeat row each tick`, `continues ticking after a
failed cycle`) — с разным набором падений на каждом ретрае. Локально
5/5 fail подряд (детерминистично в одно и то же время дня).

### Root cause
`scheduler birthday-reminders.ts:527` имеет early-exit guard:
```ts
if (todayMsk.hour < BIRTHDAY_SEND_HOUR_MSK_MIN  // 9
 || todayMsk.hour > BIRTHDAY_SEND_HOUR_MSK_MAX) // 22
{ return; }
```

В тестах `vi.useFakeTimers()` вызывается без `setSystemTime`, поэтому
fake-clock инициализируется текущим wall-clock временем (vitest 2.1.9).
В сценарии «advance HOURLY_MS», `new Date()` внутри scheduler возвращает
wall-clock + 1h. Если wall-clock в момент `beforeEach` находится в окне
22:00–08:59 MSK, после advance мы оказываемся в окне 23:00–09:59 — за
пределами `9–22` window → scheduler early-exits → `findMany` ни разу не
вызывается → heartbeat не апсёртится → assertions падают.

Это flake, но не «настоящий» race condition — он детерминистичен внутри
часа. Просто пилотный коммит `9946648` (test phase-3 batch 2) был
протестирован днём, прошёл CI днём, и никто не заметил time-of-day
зависимость. На следующий день CI трэйнула после 19 UTC (22 MSK) — там
22 ещё проходит (`>22` false), но при advance(+1h) hour становится 23.

### Урок
- **`vi.useFakeTimers()` без `vi.setSystemTime(...)` — это implicit
  зависимость от wall-clock на момент запуска.** Если код-under-test
  читает `new Date()` / `Date.now()` И принимает решения на основе
  HOURS / DAY-OF-WEEK / SEASON, fake-clock без pin **гарантированно**
  flake'нет в каком-то поясе / часе суток.
- **CI-flake с детерминистическим локальным воспроизведением —
  ВСЕГДА не flake.** Когда тест 5/5 fail локально, но «иногда»
  проходит CI — это time-of-day / TZ / env-var зависимость, а не
  гонка. Гонка дала бы случайные результаты локально тоже.
- **Поиск root cause: top-down от теста к коду.** Сначала проверил
  microtask draining (`await Promise.resolve()` × 100) — не помогло.
  Потом увидел early-exit guard в scheduler — там был ответ. Эта
  последовательность правильная: gauge сначала test-infra (vitest
  fake-timer semantics), потом тестируемый код.

### Правило
- **Каждый `vi.useFakeTimers()` в `beforeEach` обязан иметь
  `vi.setSystemTime(new Date('YYYY-MM-DDTHH:MM:SSZ'))` рядом** — если
  тестируемый код использует Date в логике (не только для логов).
- **При флейке CI на тесте с `useFakeTimers`: первое подозреваемое —
  time-of-day-dependent guard в коде**, а не race condition. Grep по
  `new Date()` / `getHours()` / `getDay()` в файле scheduler-а — это
  быстрый поиск.
- **Не сразу скипать flaky-тест с `it.skip`** (правило из CLAUDE.md).
  Сначала 5-10 минут на root-cause investigation — flake часто
  раскрывается тривиально, и тест восстановим с +5 строками.

### Лучший код
```ts
// birthday-reminders.test.ts — minimal fix
beforeEach(() => {
  vi.useFakeTimers();
  // Pin to mid-window MSK time so the scheduler's send-hour guard
  // (9–22 MSK at birthday-reminders.ts:527) doesn't early-exit.
  vi.setSystemTime(new Date('2026-05-16T09:00:00Z'));
  // ...
});
```

---

## 2026-05-16 — Bot reminder «PRO истекает» открывал главный экран вместо paywall

### Ошибка
Юзер с PRO-подпиской, не настроенной на авто-продление (yearly one-time
или monthly с `cancelAtPeriodEnd=true`), получал DM от бота за 7 и за 1
день до окончания периода:
> ⏰ Твой PRO истекает завтра (17 мая 2026 г.). Открой приложение и
> продли, чтобы сохранить доступ.

Под текстом — inline-кнопка «Открыть WishBoard ✨». Тап открывал мини-апп
**на главный экран `my-wishlists`**, а не на paywall. Пользователь не
видел продления, не понимал, где его купить, и просто закрывал апп. Тот
же баг затрагивал 7-day reminder (`bot_pro_renewal_7d`) и 1-day reminder
(`bot_pro_renewal_1d`) — оба отправлялись через
`schedulers/pro-renewal.ts`.

### Root cause
`schedulers/pro-renewal.ts:98` передавал в `sendLifecycleDM` голый
`MINI_APP_URL_FOR_DM` без query-параметра `?startapp=...`. Mini App
поддерживает deep-link `upgrade_pro` (`MiniApp.tsx:8948–8953`,
`bootSetScreen('my-wishlists'); setTimeout(() => showUpsell('pro_main'),
400)`), и `schedulers/lifecycle.ts:333` уже использует pattern
`${MINI_APP_URL_FOR_DM}?startapp=${touch.deepLinkPayload}` — но
PRO-renewal scheduler был написан **отдельно** от lifecycle scheduler и
не получил тот же handling.

Это не баг архитектуры — это упущенная консистентность между двумя
schedulers, которые отправляют одинаковые «открой апп»-кнопки. Каждый
из них самостоятельно решает, что подставить в URL.

### Урок
- **Inline-кнопка `web_app: { url }` в Telegram DM = всегда обязан
  иметь deep-link payload, если цель не «открыть домашний экран».**
  Голый URL допустим только для S0-сегмента (общий re-engagement),
  где `my-wishlists` — это и есть цель. Для любой более конкретной
  цели (paywall, item, calendar event) обязателен
  `?startapp=<token>` + соответствующий branch в `MiniApp.tsx` boot
  flow.
- **Между несколькими schedulers, отправляющими «открой WishBoard»
  кнопку, нужна общая мысленная модель: «что юзер увидит после
  тапа?»**. Все callsite'ы `sendLifecycleDM` теперь должны
  отвечать на этот вопрос явно — никаких «открою и разберусь».
- **Пропущенный deep-link не валится в логи и не падает в тестах**
  (DM всё равно «delivered», аналитика «reminder_sent_7d» всё равно
  пишется) — только конверсия в renewal страдает молча. Это худший
  класс багов: невидимый в метриках доставки, видимый только в
  funnel-метриках paywall.

### Правило
- **Каждый callsite `sendLifecycleDM(..., webAppUrl)` обязан явно
  определить deep-link payload или явно сослаться на причину его
  отсутствия в комментарии.** Голый `MINI_APP_URL_FOR_DM` без
  комментария — это red flag в code review.
- **Test для scheduler-а, отправляющего DM, обязан проверять
  итоговый webAppUrl** (4-й аргумент `sendLifecycleDM`), а не только
  факт вызова. Добавлено в `pro-renewal.test.ts` —
  `expect(webAppUrl).toBe('...?startapp=upgrade_pro')`.

### Лучший код
```ts
// schedulers/pro-renewal.ts — после фикса
const webAppUrl = `${MINI_APP_URL_FOR_DM}?startapp=upgrade_pro`;
const outcome = await sendLifecycleDM(sub.user.telegramChatId, text, locale, webAppUrl);
```

```ts
// MiniApp.tsx — already-existing handler, теперь действительно
// получает сигнал.
} else if (startParam === 'upgrade_pro') {
  bootSetScreen('my-wishlists');
  setTimeout(() => showUpsell('pro_main'), 400);
}
```

---

## 2026-05-15 — Календарь «СЕГОДНЯ»/«ЗАВТРА»: original fix пропустил третий callsite (detail-endpoint жил с багом ~2 недели после patch'а list-endpoint)

### Ошибка
В рамках Phase 1 testing-roadmap (extraction `daysUntilFromUtcMidnight` в
`services/calendar.ts` + unit-тесты) обнаружено, что fix `05df77f`
(2026-04-30) пропатчил только **один** из трёх callsite'ов в
`apps/api/src/routes/gift-notes.routes.ts`:

- `line 122` — `GET /gift-occasions` (list): ✅ исправлено в `05df77f`
- `line 241` — `GET /gift-occasions/:id` (detail): ❌ продолжало
  использовать старую формулу `(nextDate.getTime() - Date.now()) /
  (24 * 3600 * 1000)` ~2 недели после фикса
- `line 724` — soonest pick (calendar widget): ✅ исправлено в `05df77f`

Тот же баг, что был задокументирован в [BUGFIX_LESSONS 2026-04-30](#2026-04-30-—-календарь-бейдж-сегодня-вместо-завтра-вечером-накануне-события)
— просто на другом маршруте. Юзер, открывший detail-экран вечером накануне
события, видел «СЕГОДНЯ» вместо «ЗАВТРА», пока на listing-экране и в
soonest-карточке всё показывалось корректно. Это та самая «непоследовательность
внутри одной фичи», которую сложно отрепортить без специально подобранного
сценария.

### Root cause
Изначальный фикс делался поиском `Date.now()` в **одном** релевантном
файле + ручным правкой найденных мест. У `gift-notes.routes.ts` 3
callsite'а одной и той же формулы; найдены были 2 из 3 (визуально
пропущенный middle-callsite между ними).

Корень — **multi-callsite фикс без extraction**. Когда одна и та же
формула живёт в 3 местах файла, любой ручной фикс гарантирован пропустить
≥1. Lesson 2026-04-30 уже зафиксировал правило «daysUntil считается как
разница UTC-midnights», но не зафиксировал второе обязательное правило:
**если формула повторяется ≥3 раз, она выносится в helper в первом же
фиксе**, а не после второго инцидента.

### Урок
- **Multi-callsite фиксы без extraction почти всегда неполные.** Не
  «найди-и-замени» руками два-три раза подряд — extract в helper, замени все
  callsite'ы через import, тогда tsc + поиск unused имени гарантирует
  100% покрытие.
- **Test-driven discovery работает.** Этот баг проявил себя не в проде, а
  в момент написания regression-теста для уже-задокументированного класса.
  Если бы Phase 1 testing-roadmap не стартовал, баг прожил бы до
  следующего жалобу-репорта.
- **Когда формула повторяется ≥2 раза в одном файле или в ≥2 файлах
  одного app, останавливайся и выноси.** Это правило ровно про этот файл:
  `gift-notes.routes.ts` имел 3 копии identical-формулы — теперь все три
  зовут `daysUntilFromUtcMidnight(target, now)` из `services/calendar.ts`.

### Правило
- **Любая формула / магическое число, встречающаяся ≥2 раза в одном файле
  или в ≥2 файлах одного app, выносится в named helper при первом
  касании.** Не «когда будет рефакторинг» — в том же PR.
- **Bug-fix PR обязан включать grep-проверку.** Перед коммитом — `grep
  -rn` по симптомной формуле / магическому числу по всему apps/. Если
  результатов >1, фикс неполный, пока все не заменены на helper.
- **Regression-тесты для каждого lesson — обязательны** (правило из
  feedback_bugfix_lessons.md). Если бы тест существовал на L5 с
  2026-04-30, dormant-bug на line 241 проявился бы при первом запуске.

### Лучший код
```ts
// services/calendar.ts — единственный источник истины
export function daysUntilFromUtcMidnight(target: Date, now: Date): number {
  const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target.getTime() - todayUtcMs) / 86400_000);
}
```

```ts
// gift-notes.routes.ts — все 3 callsite'а импортируют ровно один helper
import { daysUntilFromUtcMidnight } from '../services/calendar';
// ...
const daysUntil = nextDate ? daysUntilFromUtcMidnight(nextDate, new Date()) : null;
```

### Discovery-метаданные
- Найдено: 2026-05-15 при extraction для Phase 1 testing-roadmap.
- Жил в проде: 2026-04-30 (после `05df77f`) → 2026-05-15 = ~15 дней.
- Симптом: detail-экран события показывает badge «СЕГОДНЯ» вечером
  накануне; список и soonest-карточка корректны.
- Тестов на момент исходного фикса: 0 (что и позволило dormant-bug
  прожить незамеченным).

---

## 2026-05-10 — Бот периодически говорит на английском с русскоязычным юзером (lifecycle / pro-renewal / events / birthday / subscriber notifications) — резолвер локали без персистентного фоллбэка + захардкоженный `'ru'` в части путей

### Ошибка
Юзер с Telegram RU + телефоном RU + `Язык = «Определяется автоматически»`
получает в боте странный коктейль: уведомления подписчику о новом
желании приходят по-русски, а lifecycle-сообщение «Add 2 more wishes
and your wishlist is ready to share… code WISHPRO» — внезапно по-английски.
Симптом наблюдался у `Dmitriy` 2026-05-10 в S3 lifecycle wave (touch 1,
key `wb_s3_t1_promo`). Воспроизводится у любого auto-mode юзера, который
никогда не открывал Mini App либо чьё `UserProfile.normalizedLocale` не
было прочитано на пути отправки.

### Root cause
**Архитектурный, а не точечный.** `resolveEffectiveLocale` в
`packages/shared/src/i18n.ts` поддерживал только два источника:

1. ручной `manualLanguage` (если `languageMode='manual'`)
2. live `telegramLanguageCode` из текущего HTTP-запроса (`req.tgUser.language_code`)

В **`auto`-режиме без живого запроса** (любой cron / proactive bot send)
второй источник был `undefined`, и резолвер фоллбэчил в
`normalizeLocale(undefined)` → возвращал `'en'`. То есть **все фоновые
отправки шли на английском всем auto-юзерам.**

При этом `UserProfile.normalizedLocale` уже писался middleware в
`apps/api/src/index.ts:355-377` на каждом аутентифицированном запросе
Mini App (через `persistResolvedBucket`) — но резолвер этих полей не
читал. Persisted источник существовал, но был отключён.

Дополнительные смежные дефекты, маскировавшие или усугублявшие баг:

- `apps/api/src/services/items.ts:84` — `const notifLocale: Locale = 'ru'`
  захардкожен → подписчики всегда получают сообщения по-русски,
  независимо от своей локали (английский подписчик видит «🎁 Dmitriy
  добавил(а) "X" в "Y"»). Это маскировало основной баг — RU-сообщения
  «работали», поэтому проблему долго не замечали.
- `apps/api/src/routes/items.routes.ts:846, 909, 974`,
  `apps/api/src/routes/reservations.routes.ts:954, 1239`,
  `apps/api/src/routes/comments.routes.ts:362`,
  `apps/api/src/notifications/commentNotificationQueue.ts:68` — тот же
  паттерн: `const notifLocale: Locale = 'ru'`, get-recipient → send.
- `apps/api/src/services/referral-hooks.ts:71-92` и
  `apps/bot/src/index.ts:857-870` — обходной маневр: на каждый proactive
  send звали `Telegram getChat` чтобы вытащить live `language_code` —
  лишний round-trip, который вообще не нужен, если уже есть persisted
  `normalizedLocale`. Запасной фоллбэк там же — `return 'ru'`.
- `apps/api/src/services/lifecycle.ts:54` — кнопка inline-keyboard
  `'Открыть WishBoard ✨'` захардкожена внутри `sendLifecycleDM`. Для
  не-русского сообщения шапка была локализована, кнопка — нет.

Структурно: cron-планировщики (`lifecycle`, `pro-renewal`, `events`,
`birthday-reminders`) все вызывали резолвер без второго аргумента —
байт-идентично, и все они теряли локаль одинаково. Это не одна
случайная ошибка в одной точке, а единый дизайн-промах в API
shared-резолвера, размноженный на 11+ callsite'ах.

### Урок
- **Резолвер локали обязан иметь persisted-фоллбэк.** Live request
  context — самый точный сигнал, но он есть только на синхронном пути
  (роуты Mini App). Любой cron / задержанный send / bot ticket reply /
  fanout по подписчикам резолвится **через persisted поля** профиля
  получателя, иначе вся пуш-коммуникация ломается для всех auto-юзеров.
- **Persisted-state должен быть в `LanguageSettings`-интерфейсе,
  а не в обходных хелперах.** Когда у каждого scheduler своя локальная
  логика выбора локали (referral-hooks: getChat, lifecycle: ничего,
  birthday: cast-as-LanguageSettings с игнорируемыми полями), баг
  становится 11-копий-один-и-тот-же. Единственный источник истины —
  shared `resolveLocaleWithSource(settings, telegramLanguageCode)`.
- **Захардкоженный `Locale = 'ru'` для notif-получателей — anti-pattern.**
  Каждое уведомление получает **другой** пользователь со своими
  настройками. Локаль автора запроса (`req.tgUser.language_code` инициатора)
  никак не релевантна локали получателя.
- **Логировать source локали, не только итог.** Без этого «почему бот
  заговорил на английском» — это перекапывание кода на час. С
  `localeSource: 'default_en' | 'persisted_normalized' | 'live_telegram'
  | 'manual' | 'legacy_language'` это grep на 30 секунд.

### Правило
- **Каждый новый proactive / cron / fanout send-сайт обязан**:
  1. селектить из БД `{ languageMode, manualLanguage, normalizedLocale,
     language }` для **получателя** (а не инициатора, если они разные);
  2. вызывать `resolveLocaleWithSource(settings, undefined)` (или с
     live `telegramLanguageCode` если он есть в bot ctx);
  3. логировать `{ locale, localeSource }` в строке отправки.
- **Никаких новых `const notifLocale: Locale = 'ru' | 'en'`** в
  кодовой базе. Любая такая строка — отказ от per-recipient resolution.
- **Никакого `getChat` для recovery языка.** Вся информация уже есть в
  `UserProfile` благодаря middleware, который пишет `normalizedLocale`
  на каждом аутентифицированном touch.
- **Любая inline-keyboard кнопка в bot-сообщении** должна быть в i18n,
  а её локаль — из того же резолвера, что и тело сообщения.
  Захардкоженная RU-кнопка под локализованным текстом = баг.

### Лучший код
- `packages/shared/src/i18n.ts` — `LanguageSettings` расширен полями
  `normalizedLocale?` / `legacyLanguage?`; новый
  `resolveLocaleWithSource(settings, telegramLanguageCode?) →
  { locale, source }` реализует chain manual → live → persisted_normalized
  → legacy_language → default_en. `resolveEffectiveLocale` стал тонкой
  обёрткой (обратно совместим: новые поля опциональны).
- `packages/shared/src/i18n.resolver.test.ts` — 16 unit-тестов на
  приоритеты + edge cases (manual-без-pick, unsupported normalizedLocale,
  unknown legacy code).
- Все 4 cron-планировщика (`lifecycle`, `pro-renewal`, `events`,
  `birthday-reminders`) теперь селектят полный набор полей и логируют
  `localeSource`.
- `services/items.ts` — per-recipient resolve, кнопка через i18n key
  `sub_notification_open_item_btn`.
- `services/lifecycle.ts` — `sendLifecycleDM` принимает `locale?`,
  кнопка через i18n key `lifecycle_dm_open_app_btn`.
- `services/referral-hooks.ts` — `resolveProactiveUserLocale` теперь
  тонкая обёртка над shared-резолвером, без `getChat`.
- `apps/bot/src/index.ts` — три точки в support-flow + inviter-arrival
  переведены на shared-резолвер; `getChat`-данс выкинут.
- `notifications/commentNotificationQueue.ts` — принимает
  `recipientLocale` и использует его для batch-summary, чтобы immediate
  и follow-up notif были на одном языке.
- `routes/items.routes.ts` (×3), `routes/reservations.routes.ts` (×2),
  `routes/comments.routes.ts` (×3 ветки + parent-author) — все
  переписаны на per-recipient resolve.

### Не сделано в этом фиксе (follow-ups)
Все три добитых **2026-05-11** в этой же ветке (см. дельту ниже):

- ✅ `apps/api/src/schedulers/reservations.ts` (lines 89-91, 194, 199,
  236) — добавлены 7 i18n-ключей (`notif_res_reminder_*`) × 6 локалей,
  все 4 хардкода переписаны на per-recipient resolve через
  `resolveLocaleWithSource`. Smart-res auto-release / reminder /
  reservation reminder теперь идут на языке получателя.
- ✅ `apps/api/src/services/locale.ts:20` — default-параметр `locale:
  Locale = 'ru'` удалён, параметр сделан обязательным. TS теперь
  поймает любой будущий вызов без явной локали. Все 6 callers в
  `routes/reservations.routes.ts` уже передают её — компилируется без
  правок.
- ✅ `apps/bot/src/index.ts:2477` — `deliverPendingWelcomes` теперь
  селектит полный набор полей и резолвит через
  `resolveLocaleWithSource`. Manual override уважается даже на
  welcome-пути (юзер мог открыть Mini App → выбрать manual EN, потом
  выйти и вернуться к welcome via /start).

### Дельта 2026-05-11 — закрытие 3 follow-ups
- `packages/shared/src/i18n.ts` — +7 ключей (`notif_res_reminder_header`,
  `_body`, `_body_with_price`, `_from`, `_note`, `_btn_open`,
  `_btn_purchased`) × 6 локалей.
- `apps/api/src/schedulers/reservations.ts` — все 4 send-сайта
  (reservation reminder, smart-res auto-release gifter+owner,
  smart-res reminder) теперь селектят `{ languageMode, manualLanguage,
  normalizedLocale, language }` для получателя и логируют `localeSource`.
- `apps/api/src/services/locale.ts` — `resolveUserFirstName(user,
  locale: Locale)` без default; контракт явный, ошибки контракта ловит TS.
- `apps/bot/src/index.ts` — `deliverPendingWelcomes` через
  `resolveLocaleWithSource`, лог содержит `localeSource`.

### Известные оставшиеся (другие классы багов, не закрыты в этой ветке)
- `apps/api/src/schedulers/reservations.ts:206` —
  `t('api_system_auto_released', 'ru')` пишется в `Comment.text`
  столбец БД. Это **stored** локализация, не ephemeral notification:
  одна запись показывается всем зрителям независимо от их локали.
  Чтобы починить — хранить `i18nKey + params` в Comment-row и
  переводить на render. Бóльший рефактор; вне scope.
- `apps/web/app/miniapp/MiniApp.tsx:210` — `fmtPrice` default
  'ru'. Frontend-форматтер, не часть пуш-коммуникации; Mini App
  держит локаль в React state и переопределяет на каждом вызове.
  Низкорисково, оставить как есть.
- `apps/bot/src/index.ts:2331-2333` — `setMyCommands` подаёт описание
  команд бота **только на одном языке**. Telegram поддерживает
  `setMyCommands` с `language_code` параметром (отдельные списки на
  ru / en / etc). Это feature-добавление, а не баг-фикс резолвера —
  отдельная задача.
- `apps/api/src/lib/locale.ts:10` — `getRequestLocale(req)` использует
  только `req.tgUser?.language_code` через `detectLocale`, не уважает
  manual override. Пользователь с `manual='en'` и Telegram `ru` получит
  RU на синхронных API-ответах вопреки своему явному выбору. На
  proactive путях (cron / fanout / bot proactive sends) это уже починено
  через `resolveLocaleWithSource`, но синхронный путь остаётся
  непоследовательным: `me.routes.ts:934/1137` использует полный chain,
  все остальные роуты — старый `getRequestLocale`. Чтобы починить —
  переписать `getRequestLocale` как обёртку, которая дотягивает
  профиль из БД (один extra query per request) или прокидывает
  middleware-собранный профиль в `req.tgUserProfile`. Отдельная задача;
  blast radius — все синхронные API-ответы.
- `apps/api/src/schedulers/events.ts:73-110` — title/body event-reminder
  строки остались inline в `switch (locale)` для 6 локалей (~36
  языко-зависимых литералов). Кнопка перенесена в `notif_res_reminder_btn_open`
  в Round 3, title/body — нет. Все 6 локалей покрыты функционально
  (никто не получает чужой язык), но архитектурно — anti-pattern
  относительно других proactive сайтов. Follow-up: 6 i18n-ключей с
  `{{title}}`/`{{days}}` плейсхолдерами × 6 локалей.

### Round 2 (2026-05-11) — закрытие code-review feedback (7.5 → 9+/10)
Code-review subagent дал 7.5/10 с пятью should-fix замечаниями + nits.
Закрыто в той же ветке:

- ✅ **Helper `profileToLanguageSettings` + `LocaleProfileSlice` type** в
  `packages/shared/src/i18n.ts`. Лифтит Prisma-`UserProfile` slice в
  `LanguageSettings`-shape. Re-exported из `apps/api/src/services/locale.ts`
  для consistency. Заменил 14 повторяющихся inline-объектов на
  `resolveLocaleWithSource(profileToLanguageSettings(X.profile))` —
  ~150 строк убрано, плюс `as any` cast'ы централизованы.
- ✅ **Defensive guard на manualLanguage**: добавлен `isSupportedLocale`
  check в manual-ветке резолвера. Если dirty data ('pt-BR' и т.п.)
  попадёт в `manualLanguage`, резолвер не упадёт в `t()` — провалится
  на следующий signal. Тест `falls through when manualLanguage is dirty`
  добавлен.
- ✅ **`apps/api/src/routes/group-gifts.routes.ts` × 3 hardcoded RU**:
  добавлены 3 i18n keys (`notif_group_gift_joined`, `_completed`,
  `_cancelled`) × 6 локалей; все 3 send-сайта (organizer-on-join,
  participants-on-complete, participants-on-cancel) переписаны на
  per-recipient resolve.
- ✅ **`apps/bot/src/index.ts:1812` hint fanout**: `Locale = 'en'` убран,
  recipient теперь резолвится через профиль, fallback `'en'` —
  legitimate cold-start.
- ✅ **`apps/api/src/routes/internal.routes.ts:343`** — recovery
  notification: priority = current resolver chain → snapshot
  `MaintenanceExposure.locale` → 'en'. Снапшот используется только когда
  юзер cold-start (default_en); иначе текущая локаль приоритетнее.
- ✅ **`sendLifecycleDM` локаль обязательна**: dropped optional default;
  параметр перемещён в `(chatId, text, locale, webAppUrl?)` чтобы
  required-required-required-optional порядок был естественный. TS
  поймает регрессии.
- ✅ **`commentNotificationQueue` плюрали → i18n**: 6 hardcoded
  `*_COMMENT_FORMS` массивов выкинуты, добавлены 3 keys
  (`notif_batch_comments_word_one/few/many`) × 6 локалей. Локализация
  теперь полностью в dict, никакой TS-side утечки.
- ✅ **`birthday-reminders` restructure**: `as LanguageSettings` cast
  с лишними полями убран; теперь идёт через канонический
  `profileToLanguageSettings(...)` — код читается одинаково с 13
  другими callsites.
- ✅ **Hindi reservation reminder header** заменён на безопасный
  loanword `आरक्षण रिमाइंडर` (от диалектной формы `याद दिलावन`).
- ✅ **Meta-test покрытия ключей**: новый блок в `i18n.resolver.test.ts`,
  который итерирует по 15 локали-фикс ключам × 6 локалям и проверяет,
  что `t()` возвращает не-пустую строку, отличную от raw key. Ловит
  drift при добавлении новой локали или удалении ключа.
- ✅ **`isSupportedLocale` exported** — теперь публичный, используется
  в `internal.routes.ts` для валидации snapshot-локали.

Не сделано (nit / out of scope):
- `apps/api/src/lib/locale.ts:10` `getRequestLocale` — добавлено в
  follow-up список выше.
- Hindi/Arabic переводы новых ключей — не верифицированы native speakers.
  Текущие — best-effort. При жалобе от пользователя — поправить.

### Round 3 (2026-05-15) — закрытие code-review iter 2 (8/10)
Свежий sub-agent ревью на ту же ветку нашёл один MAJOR + минорные.
Закрыто:

- ✅ **`apps/api/src/services/santa-season.ts:325-360`** — broadcast
  пайплайн перестал слать `textRu + textEn` блобом всем юзерам
  (zh-CN/hi/es/ar получали два чужих языка одновременно).
  Per-recipient resolve через
  `resolveLocaleWithSource(profileToLanguageSettings(...))`; добавлены
  ключи `santa_broadcast_promo` и `santa_broadcast_closing_soon` × 6
  локалей. Триггерится Nov 1 PROMO / Feb 1 CLOSING_SOON — не активен
  прямо сейчас (следующий запуск Nov 1, 2026), починен превентивно
  пока контекст свежий.
- ✅ **`apps/api/src/schedulers/events.ts:118`** — bilingual button
  `locale === 'ru' ? '📱 Открыть' : 'Open'` заменён на
  `t('notif_res_reminder_btn_open', locale)` (переиспользует
  существующий 6-локальный ключ). zh-CN/hi/es/ar теперь получают
  кнопку на своём языке. Inline title/body switches остались —
  scope-deferred, см. «Известные оставшиеся».
- ✅ **`apps/api/src/schedulers/birthday-reminders.ts:990-995`** —
  схлопнут dead `if (isOwner) { fetch X } else { fetch X }` с
  byte-identical selects на единичный fetch. Privacy / opt-out
  branching ниже не меняется.
- ✅ **`apps/api/src/schedulers/pro-renewal.ts:88-94`** — `dateFmtLocale`
  расширен с `ru | en-US` до маппинга все 6 локалей (`ru-RU | zh-CN |
  hi-IN | es-ES | ar | en-US`). Дата в pro-renewal reminder теперь в
  локали получателя.
- ✅ **Defensive test на empty-string `manualLanguage`** добавлен в
  `i18n.resolver.test.ts` — закрывает оставшийся dirty-data класс
  (раньше покрывался только `'pt-BR'` тестом).
- ✅ **`packages/shared/src/i18n.ts:166` cast-safety комментарий**
  переписан точнее: не "auto path", а «any non-'manual' value falls
  through identically» — отражает реальную семантику резолвера.
- ✅ **`apps/api/src/schedulers/reservations.ts:199-204` SYSTEM-комментарий**
  обновлён: убрана претензия на «project canonical persisted-text
  locale» (формальной политики нет) — заменено на «match existing
  SYSTEM comments in this table».

Отклонено (с обоснованием):
- ❌ **MINOR: `group-gifts.routes.ts` localeSource не логируется.** Все
  роуты (items / comments / reservations / internal / me) тоже не
  логируют `source` — это консистентный паттерн для роутов (request-id
  + trackEvent дают diagnostics). Source capture — паттерн scheduler'ов,
  где нет request-id. Group-gifts матчит роут-паттерн.
- ❌ **NIT: uppercase `manualLanguage` тест** — поведенчески уже
  покрыт `'pt-BR'` тестом (оба фейлят `isSupportedLocale`); добавлять
  второй тест с тем же эффектом — duplication.

### Acceptance — после деплоя
- Юзер с Telegram RU + auto-mode получает RU lifecycle / promo /
  reminder / pro-renewal / event / birthday сообщения.
- Юзер с manual=English получает EN даже при Telegram RU.
- Юзер с manual=Russian получает RU даже при Telegram EN.
- Подписчики получают уведомления на **своём** языке, не на языке
  владельца вишлиста.
- В логах видно `localeSource` для каждой proactive отправки.
- Если `localeSource` массово = `default_en` для существующих юзеров,
  это означает что middleware-захват `normalizedLocale` где-то отвалился —
  алерт.

---

## 2026-05-08 — Bulk-select bottom bar: «каша из кнопок» (translucent token на fixed-position баре + сетка не подогнана под кол-во кнопок)

### Ошибка
Пользователь жмёт «Выбрать несколько» в вишлисте → внизу появляется
панель с действиями (Удалить / В архив / Перенести / Копировать /
Выберите категорию / Часть вишлиста), но визуально это выглядит как
каша: кнопки разной ширины, прыгают на третью строку, наезжают на
карточки желаний и счётчик «N из M желаний», поверх ещё торчит
floating «+» FAB. Не понятно, что нажимать.

### Root cause
Два независимых дефекта в одной области:

1. **Сетка не была подогнана под актуальное количество кнопок.**
   `gridTemplateColumns` второй строки = `'1fr 1fr'`, но кнопок там 3
   (Copy / ChooseCategory / Curated) — третья сваливалась на третью
   строку и занимала ровно половину ширины. Без категорий первая
   строка `'1fr 1fr 1fr 1fr'` (4 колонки) принимала 5 кнопок — пятая
   тоже сваливалась вниз на 1/4 ширины. Когда добавляли кнопку
   `curated_bulk_btn` в коммите `f0c5dac` (апрель), сетку забыли
   обновить.

2. **Контейнер бара использовал `C.surface` как `background`.**
   `C.surface` = `var(--wb-surface, rgba(255,255,255,0.035))` — это
   elevation-токен, ~3.5–4% white поверх `bg`. Для карточек он
   создаёт subtle-lift, но для **fixed-position bottom bar** даёт
   почти прозрачный фон: items, FAB и счётчик «29 из 70 желаний»
   просвечивают сквозь панель. Соседний curated-selection bar
   использует `C.bg` (solid `#0F0F12`) — правильный паттерн уже
   существовал в файле, просто bulk-bar его не использовал.

3. **FAB не скрывался во время bulk/curated режимов.** Условия
   рендера FAB (`!itemReorderMode && !catReorderMode && !showItemForm
   && !keyboardOpen`) не включали selection-режимы. FAB при
   `zIndex: 50` и баре при `zIndex: 60` — формально был перекрыт, но
   из-за прозрачного фона бара виден. Семантически тоже неправильно:
   «добавить новое желание» в режиме выбора уже существующих не имеет
   смысла.

### Урок
- **Translucent токены — для elevation, не для occlusion.** Любой
  `position: fixed` контейнер, который должен скрывать прокручиваемый
  контент под собой, MUST использовать **solid** background-токен
  (`C.bg` / `C.card`), не `C.surface` / `C.surfaceHover`. Это видно
  сразу при тестировании на длинном списке — но если тестируешь на
  пустом, баг не проявляется.
- **Когда добавляешь кнопку в существующую grid — всегда проверяй
  `gridTemplateColumns`.** В CSS Grid лишняя кнопка молча wraps на
  следующую строку и занимает column-fraction ширины родителя, что
  визуально выглядит «как-то почти ок» в превью на десктопе.
- **Selection-режимы должны отключать FAB и любые add-actions.**
  Любой mode, где пользователь выбирает существующие сущности, скрывает
  CTA на создание новых: иначе click-conflict, потеря состояния выбора
  при переходе на форму, или просто визуальная каша.
- **Один скриншот может содержать два разных бага.** Первый раунд
  фикса исправил только сетку — пользователь прислал тот же скриншот:
  «баг на месте». Второй раунд нашёл прозрачность. Урок: при
  визуальных багах нужно перечислить все аномалии (overlap, размеры,
  прозрачность, z-order), а не лечить первое заметное.

### Правило
- **Любой fixed bottom bar / sheet header / persistent overlay** =
  solid фон. Грепать `position: 'fixed'` + `background: C.surface` в
  кодовой базе и заводить follow-up на каждое попадание (текущие
  кандидаты: Santa exit-request sheet at `MiniApp.tsx:28149` —
  смягчён затемняющим overlay, но pattern неправильный).
- **При добавлении новой кнопки в bulk/action bar** — проверить
  все ветки `gridTemplateColumns` в обоих case'ах (`hasUserCategories`
  true/false и любые другие условные ветки), что число колонок
  соответствует числу детей.
- **При вводе нового selection mode** (curated, bulk, multi-pick) —
  добавить флаг в условие рендера FAB и любых других CTA на создание.

### Лучший код
- `apps/web/app/miniapp/MiniApp.tsx` — bulk action bar:
  - `background: C.surface` → `background: C.bg` (precedent взят у
    curated-selection bar 95 строк ниже).
  - `gridTemplateColumns` второй строки: `'1fr 1fr'` → ternary
    `hasUserCategories ? '1fr 1fr 1fr' : '1fr 1fr'`. Сетка теперь
    автоматически совпадает с числом детей в каждой ветке.
  - Кнопка `ChooseCategory` рендерится между Copy и Curated через
    `{hasUserCategories && <button>...</button>}` — порядок Copy →
    ChooseCategory → Curated читается как «копия в другую вишку →
    тег в текущей → внешний share», логичная последовательность.
- `apps/web/app/miniapp/MiniApp.tsx` — Add-Wish FAB условие
  расширено: `!bulkSelectionMode && !curatedSelectionMode`.
  Старый z-order (FAB z:50, bar z:60) больше не load-bearing —
  семантически чище и устойчиво к будущим z-index изменениям.

```jsx
// ❌ До: 3 кнопки в 2-колоночную сетку → перенос на 3-ю строку 1/2 ширины
<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
  <Copy /> <ChooseCategory /> <Curated />
</div>

// ✅ После: число колонок матчит число детей в каждой ветке
<div style={{ display: 'grid',
  gridTemplateColumns: hasUserCategories ? '1fr 1fr 1fr' : '1fr 1fr' }}>
  <Copy />
  {hasUserCategories && <ChooseCategory />}
  <Curated />
</div>
```

```jsx
// ❌ До: translucent elevation token для fixed bottom bar
<div style={{
  position: 'fixed', bottom: '76px', zIndex: 60,
  background: C.surface, // rgba(255,255,255,0.035) — items видны сквозь
}}>...</div>

// ✅ После: solid bg-токен (соседний curated-bar так и делает)
<div style={{
  position: 'fixed', bottom: '76px', zIndex: 60,
  background: C.bg, // #0F0F12 solid — полностью перекрывает контент
}}>...</div>
```

```jsx
// ❌ До: FAB рендерится во время selection mode → перекрывает action bar
{!keyboardOpen && <FAB />}

// ✅ После: selection-режимы отключают add-actions
{!keyboardOpen && !bulkSelectionMode && !curatedSelectionMode && <FAB />}
```

**Commit:** `7cfc983` — fix(miniapp): opaque bulk action bar + hide FAB during selection modes
**Предыдущая попытка:** `f98c247` (только сетка, прозрачность не заметил — урок: визуальные баги требуют перечисления всех аномалий)

### Follow-up — последний item обрезан баром (не было «воздуха»)

После того как бар стал непрозрачным, выяснилось, что последний item
вишлиста наполовину прячется за ним: контейнер вишлист-детейла имел
`paddingBottom: 'calc(90px + safe-area)'` — этого достаточно только для
floating bottom-nav (~52 + 14 offset + 24 breathing). Bulk-bar на 76 px
выше нижнего края + ~115 px высоты = верхний край бара в ~190 px от
низа, и последний item «уезжал» под бар.

**Урок:** любой fixed-position бар, который показывается поверх
скроллируемого контента, должен **парно** с собой увеличивать
`padding-bottom` контента, чтобы последний элемент был доскроллим.
Иначе пользователь физически не может его увидеть, не выйдя из режима.
Проверка: бар активен → последний item в списке → между низом
карточки и верхом бара должно быть ≥16 px воздуха.

**Правило:** при добавлении нового persistent overlay (selection-bar,
sticky CTA, etc.) — закрепить пару (overlay-условие) ↔ (доп.
padding-bottom условие в скролл-контейнере) сразу же, не отдельным
коммитом.

**Лучший код:** `padding-bottom` на wishlist-detail контейнере стал
тернарным: `bulkSelectionMode ? 210px : curatedSelectionMode ? 110px :
90px` (всё + safe-area). 210 = 76 (offset бара) + 116 (высота 2-row
бара) + ~18 breathing. 110 = 70 (curated single-row) + ~40 breathing.

**Commit:** `<this commit>` — fix(miniapp): scroll padding when bulk/curated bar active

---

## 2026-05-08 — Item images: открытие вишлиста на 28 желаний грузит ~28 картинок параллельно по мегабайту с внешних CDN

### Ошибка
Пользователь открывает свой вишлист → карточки желаний рендерятся, но
вместо превью товаров в течение 5–15 секунд видны emoji-плейсхолдеры
(😍 / 🎁), потом постепенно начинают появляться картинки. На скриншотах
все 28 строк списка имели placeholder-emoji в момент captura. Эффект
особенно заметен на медленной мобильной сети.

### Root cause
Три фактора накладываются друг на друга, каждый по отдельности
терпимый, вместе — деградация:

1. **`imageUrl` хранится как сырой external CDN URL.** `url-import.ts`
   парсил marketplace-страницу через `parseUrl`, доставал `imageUrl`
   (типично `https://avatars.mds.yandex.net/get-mpic/.../orig`,
   `https://cdn-img.ozone.ru/...`, `https://images.wbstatic.net/...`)
   и сохранял **строкой как есть** в `Item.imageUrl`. Никакого
   download'а / sharp / локального кеша. Mini App ходит за каждой
   картинкой к чужому CDN.
2. **Тащим original-resolution для 88-px thumbnail'а.** Yandex `/orig`
   суффикс = полноразмерный JPG, типично 1–3 МБ. Карточка в списке —
   88×110 px. Перерасход трафика ~30×.
3. **`<img>` без lazy/decoding hints.** В `MiniApp.tsx` 19 мест с
   `<img src={item.imageUrl}>` — ни `loading="lazy"`, ни
   `decoding="async"`, ни `next/image`, ни IntersectionObserver. На
   списке из 28 желаний браузер открывает 28 параллельных fetch к
   внешним CDN при первой отрисовке, конкурируя за коннект и main
   thread (декодинг блокирует UI).

Geo-latency добавляет финальный гвоздь: API/Mini App теперь хостятся в
Амстердаме (Vultr, после переезда 2026-05-03), пользователи — в РФ.
Yandex/WB CDN отдают быстро для российского трафика, но через
европейский TLS-handshake в один поток на 28 хостов это секунды
ожидания.

В БД на момент аудита: 78 items с remote `http%` imageUrl против 31
local `/api/uploads/%`. 70 % товарных карточек ходили в чужой CDN.

### Урок
1. **External CDN — не source of truth для контента, который критичен
   для UX.** Картинка товара = главный визуальный якорь карточки. Если
   она грузится 5+ секунд, пользователь видит «приложение тормозит»,
   а не «Yandex медленно отдаёт». Переносим в свой `/uploads/`.
2. **Производительность списков — N-of-M проблема.** На каждом item —
   свой сетевой запрос. Любая мелкая медлительность (500 ms × 28 =
   14 секунд wall-clock'а с учётом конкуренции) превращается в
   ощущаемую деградацию. `loading="lazy"` — практически бесплатный
   instrument: браузер сам решает, что грузить, а что отложить до
   скролла.
3. **Уже существующая инфра должна переиспользоваться.** Sharp pipeline
   (`apps/api/src/uploads/imageProcessor.ts`) был написан для
   ручных загрузок 6 месяцев назад. URL-импорт о нём не знал и качал
   как мог. Цена «протянуть вызов в новый flow» — 30 строк кода;
   цена «не протянуть» — 6 месяцев деградации UX.
4. **SSRF guard уже написан и оттестирован** в `url-parser.ts`
   (`validateUrl` + `assertDnsIsSafe`, покрытие в
   `security-ssrf.test.ts`). Любой новый код, который дёргает remote
   URL по пользовательским данным, обязан переиспользовать этих двух
   helper'ов, а не выкатывать «пока без guard, потом починим».

### Правило
- **Списочные `<img>`** (всё, что выводится в списке/гриде, а не на
  отдельной странице товара) MUST иметь `loading="lazy"
  decoding="async"`. Без исключений.
- **Любой `imageUrl`, полученный из external источника** (URL parser,
  Telegram file API, scraper) MUST пройти через
  `downloadAndProcessImage` перед сохранением в `Item.imageUrl`.
  Failure ⇒ fall back на remote URL (лучше, чем потерять картинку
  совсем), но primary path = local.
- **Любой server-side `fetch(url)` по пользовательскому URL** MUST
  пройти `validateUrl` + `assertDnsIsSafe` перед запросом. Reject
  редиректы или revalidate их повторно (см. `fetchHtml` в
  `url-parser.ts` для эталонной реализации).

### Лучший код
- `apps/api/src/uploads/imageProcessor.ts` — добавлен
  `downloadAndProcessImage(url, opts)`: validateUrl → assertDnsIsSafe
  → fetch с 8 s timeout, manual redirect (reject 3xx), 15 MB cap,
  content-type guard `image/*` → существующий `processImage`
  (resize 1600 / mozjpeg q80, EXIF strip).
- `apps/api/src/services/url-import.ts` — после `parseUrl` и до
  `prisma.item.create` пытаемся скачать; ошибка логируется как
  `url_import.image_cache_failed` и не валит импорт (fall back на
  remote URL).
- `apps/web/app/miniapp/MiniApp.tsx` — 19 мест с `<img>` для item
  фотографий получили `loading="lazy" decoding="async"`. Для модальных
  full-screen viewer'ов — только `decoding="async"` (открываются по
  явному клику, lazy-load бессмыслен).
- `apps/api/src/scripts/backfill-item-images.ts` — one-shot
  бэкфилл для 78 legacy items. Concurrency 3 (вежливо к чужим CDN),
  поддержка `--dry-run` и `--limit N`. Прогон на проде:
  77 downloaded / 1 skipped (мёртвый t.me 404) / 0 failed.

После прогона: распределение `Item.imageUrl` сменилось с
31 local / 78 remote / 83 null / 39 other → 109 local / 1 remote / 83
null / 39 other. Объём `/data/uploads/` вырос с ~1 MB до 12 MB
(167 файлов) — приемлемо.

Commit: `f98c247`.

---

## 2026-05-03 — Hints: «Активный намёк не найден» при свежем клике (idempotency-window mismatch + сетевая стена маскировала логический баг недели)

### Ошибка
Пользователь жмёт «Намекнуть друзьям» в Mini App → бот получает клавиатуру выбора
контактов → пользователь выбирает контакт → бот отвечает «**Активный намёк не
найден. Создай новый в приложении.**» И так несколько попыток подряд, повторно
воспроизводимо.

В БД на момент попытки виден последний `Hint` с `status='SENT'` от **этого же
пользователя на тот же item**, но `createdAt` 10 часов назад. Свежего hint
после клика нет. API при этом отвечает Mini App'у `200 OK` с `hintId`.

### Root cause
**Расхождение «окон» между двумя сервисами**, читающими общий стейт через БД:

- **API** (`apps/api/src/index.ts`, idempotent fast-path в `POST /tg/items/:id/hint`)
  искал существующий hint по условию `status='SENT' AND expiresAt > now()`.
  `expiresAt` ставится `now() + 30 дней` при создании → effectively окно
  идемпотентности **30 дней**. На повторный клик API возвращал тот же 10-часовой
  `hintId` и заново слал клавиатуру.
- **Бот** (`apps/bot/src/index.ts`, обработчик `users_shared`) ищет hint по
  условию `senderUserId=X AND status='SENT' AND createdAt >= now() - 30 минут`,
  чтобы не подцепить случайный древний абандон. Окно — **30 минут**.

Когда юзер кликал, абандонив, и возвращался через несколько часов, API возвращал
старый зомби-hint, бот его не находил в своём окне → отвечал «Активный намёк не
найден». Контракт между двумя сервисами расходился на 3 порядка (30 мин vs 30
дней).

**Почему этот баг прожил недели в проде, прежде чем мы его опознали:**
параллельно работала **сетевая стена** Timeweb-VPS → Telegram (RKN-блок IPv4 +
deprecated upstream IPv6). Каждая попытка hint-flow в проде превращалась в
`fetch failed: Connect Timeout Error` либо на API-side (отправка клавиатуры),
либо на bot-side (recipient sendMessage). Все наши «фиксы» в течение нескольких
сессий — добавление retry с timeout, atomic-claim против дубликатов
`users_shared`, idempotent fast-path, fire-and-forget keyboard delivery,
структурные логи — били по симптомам, которые вызывал сетевой шум. Логический
баг с window-mismatch был **полностью замаскирован**: оба сервиса не доходили
до своих query настолько часто, что мы не различали «не нашёл из-за окна» от
«не дошёл из-за сети». Только после переезда инфры на Vultr Amsterdam (TG
reach ~30 ms) сетевая дисперсия исчезла и баг стал воспроизводиться 1-в-1.

### Урок
1. **Контракт «producer создаёт состояние / consumer ищет это состояние через
   БД-очередь» обязан явно совпадать по lookup-критериям с обеих сторон.** Если
   consumer ограничивает окно по `createdAt >= now() - X`, producer не имеет
   права через идемпотентность переиспользовать запись старше X. Несовпадение
   окон = race-условие, которое выглядит как «всё хорошо, кроме бага».
2. **Сетевая нестабильность маскирует логические баги.** Когда из 100 попыток
   30 % падает «по сети», у диагноста нет статистической базы отделить «упало
   потому что логика кривая» от «упало потому что сеть лежит». Любой код-фикс
   в этих условиях — догадка. Наши 5+ итераций hint-fixes (`491a2ba` /
   `6c4de80` / `dc5a0af` / `91a1c22` / `fa0b52d`) лечили реальные мелкие
   проблемы по дороге, но не корень — корень был не в коде, а в контракте,
   который сеть скрывала.
3. **`expiresAt` ≠ окно идемпотентности.** Поле «срок жизни» в БД — это
   garbage-collection / архивация, а не семантика «когда переиспользовать».
   Идемпотентность строится отдельным узким окном, согласованным с consumer'ом.
4. **Stale записи блокируют rate-limit slots.** Анти-спам hints (3/item за 30
   дней, 5/sender за 24 ч) считал `status IN ('SENT', 'DELIVERED')`. Каждый
   абандонный SENT, оставленный навсегда, занимал слот. На момент починки в
   проде висело 8 stale-SENT с марта-мая, реально блокирующих item-rate-limit
   для пользователя, который их даже не помнил.

### Правило
1. **Pair-test producer/consumer, если они синхронизируются через БД-очередь.**
   Минимум — `grep`-чек в обоих файлах при ревью PR'а, который меняет хотя бы
   одну сторону: lookup-where в consumer должен покрывать все записи, которые
   producer считает «свежими/активными».
2. **Любое окно идемпотентности дублируется константой с одинаковым именем в
   обоих файлах** (`HINT_LOOKUP_WINDOW_MS = 30 * 60 * 1000`), либо выносится
   в общий `packages/shared`. Магических чисел в `findFirst` запрещены — они
   незаметно расходятся.
3. **Stale-state cleanup должен быть proactive, не reactive.** Записи,
   выпавшие из «свежего окна», переводятся в `CANCELLED` при следующем
   клике/запросе того же пользователя — не «когда-нибудь по cron». Иначе они
   копятся и блокируют rate-limits.
4. **Перед мульти-сессионным циклом фиксов одной фичи в проде с сетевыми
   ошибками — стабилизировать сеть.** Если в логах доминирует
   `fetch failed: Connect Timeout`, любой код-фикс симптома будет угадыванием.
   Диагноз сначала, фикс потом.

### Лучший код
```ts
// apps/api/src/index.ts — POST /tg/items/:id/hint, fast-path:
const now = new Date();
// MUST stay in sync with apps/bot/src/index.ts users_shared handler.
const HINT_LOOKUP_WINDOW_MS = 30 * 60 * 1000;
const lookupWindowStart = new Date(now.getTime() - HINT_LOOKUP_WINDOW_MS);

// 1. Proactive stale cleanup: anything outside the consumer's window is dead.
const stale = await prisma.hint.updateMany({
  where: {
    senderUserId: user.id,
    itemId: id,
    status: 'SENT',
    createdAt: { lt: lookupWindowStart },
  },
  data: { status: 'CANCELLED' },
});
if (stale.count > 0) {
  logger.info({ userId: user.id, itemId: id, cancelledCount: stale.count },
    'hint_create_cancelled_stale_sent');
}

// 2. Idempotency over the SAME window the bot uses.
const existing = await prisma.hint.findFirst({
  where: {
    senderUserId: user.id,
    itemId: id,
    status: 'SENT',
    createdAt: { gte: lookupWindowStart },  // ← must match consumer
    expiresAt: { gt: now },                  // ← belt-and-braces
  },
  orderBy: { createdAt: 'desc' },
  select: { id: true, createdAt: true },
});
```

```ts
// apps/bot/src/index.ts — users_shared handler:
const HINT_LOOKUP_WINDOW_MS = 30 * 60 * 1000;
// MUST stay in sync with apps/api/src/index.ts hint create handler.
const thirtyMinAgo = new Date(Date.now() - HINT_LOOKUP_WINDOW_MS);

const hint = await prisma.hint.findFirst({
  where: {
    senderUserId: sender.id,
    status: 'SENT',
    createdAt: { gte: thirtyMinAgo },        // ← matches producer
  },
  orderBy: { createdAt: 'desc' },
  ...
});
```

**Commits:**
- `6574323` fix(hints): cancel stale SENT hints + match bot's 30-min lookup window
- (network unmasking) infra migration to Vultr Amsterdam — `0e7a9f6` and follow-ups

---

## 2026-04-30 — Календарь: бейдж «СЕГОДНЯ» вместо «ЗАВТРА» вечером накануне события

### Ошибка
В Mini App, экран события календаря (1 мая, повторение «каждый год»),
запрошенный 30 апреля около 18:14 по GMT+3, показывал бейдж **«СЕГОДНЯ»**
и подпись `1 Май · Пт`. При этом таймер обратного отсчёта работал
корректно: `08 ч 45 мин 42 сек` — то есть до события действительно
оставалось < 9 часов и оно было *завтра*, а не сегодня.

Тот же баг затронул выбор «ближайшего события» в hero-карточке —
завтрашнее событие могло отображаться как «сегодняшнее».

### Root cause
В двух местах `apps/api/src/index.ts` `daysUntil` считался как:

```ts
Math.round((nextDate.getTime() - Date.now()) / (24 * 3600 * 1000))
```

`nextDate` всегда нормализована к **полуночи UTC** (она строится через
`Date.UTC(y, m-1, d)` в `getNextOccurrenceDate`). Но `Date.now()` —
текущий timestamp, включающий время суток.

Сценарий: сейчас 30 апреля 15:14 UTC, событие — 1 мая 00:00 UTC.
Разница = ~8.75 часов = `0.365` дня. `Math.round(0.365) = 0` →
`daysUntil = 0` → клиент рендерит бейдж «СЕГОДНЯ».

Фронт корректен: он переводит `daysUntil === 0` → «сегодня`,
`daysUntil === 1` → «завтра». Источник кривой даты — сервер.

### Урок
- **Календарные дни — это разница ДАТ, а не разница миллисекунд / 86 400 000.**
  Когда одна сторона уже нормализована к полуночи, а вторая — нет,
  `Math.round`/`Math.floor`/`Math.ceil` дадут off-by-one в зависимости
  от времени суток. Любое из округлений будет неверно для какой-то
  части дня.
- **Таймер и бейдж разошлись, потому что считались по-разному.** Таймер
  работает в реальных миллисекундах (это правильно для countdown'а), а
  бейдж должен работать в календарных днях (а считал в миллисекундах).
  Расхождение в принципе расчёта = расхождение в выводе.

### Правило
- Для «через сколько дней» **обе стороны нормализуются к полуночи в
  одной и той же тайм-зоне** (UTC, раз сервер UTC), затем `(b - a) / 86400000`
  даёт целое число дней без округления.
- Если в одной фиче есть и countdown-таймер (часы/минуты/секунды), и
  «дни до» (бейдж/подпись) — это **два разных расчёта** с разной
  семантикой. Не пытаться вывести «дни» из того же значения, что и
  таймер.

### Лучший код
```ts
// apps/api/src/index.ts — везде, где считается daysUntil от nextDate
const now = new Date();
const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const daysUntil = Math.round((nextDate.getTime() - todayUtcMs) / (24 * 3600 * 1000));
```

`nextDate` уже на полуночи UTC → разница всегда кратна 86 400 000 →
`Math.round` тут страховочный, реально результат — целое число.

---

## 2026-04-30 — Фото идеи к событию календаря не загружается + каретка уезжает в поле цены

### Ошибка
1. **Фото исчезает.** В календаре, при добавлении идеи к событию с
   прикреплённым фото, серверная idea создавалась без `imageUrl`.
   Тост-ошибки нет, фронт молча пропускает. Корень — в
   `tgFetch` (`apps/web/app/miniapp/MiniApp.tsx`): он жёстко выставлял
   `'Content-Type': 'application/json'` для **всех** запросов, включая
   те, где `body` это `FormData`. Браузер не может выставить
   `multipart/form-data; boundary=...` поверх явно заданного Content-Type,
   поэтому multer на сервере получал тело как JSON и не видел поля
   `photo`. Запрос проходил с 200, фото никуда не сохранялось.

2. **Каретка уезжает (вертикально внутри инпута).** В форме «Добавить
   идею», при тапе на инпут «цена», мигающая каретка отрисовывалась
   значительно ниже видимой границы инпута (~50 px вниз, в зазоре между
   price-row и upload-кнопкой). Текст «70000» при этом был на своём
   месте.
   
   **Первая попытка фикса (мимо):** добавили `onFocus → scrollIntoView`,
   как у соседнего text-инпута. Это не помогло — пользователь
   подтвердил баг на проде после деплоя. Гипотеза «WebView не
   пересчитывает caret после открытия клавиатуры» была ошибочной:
   text-инпут работал не потому, что у него был scroll-handler, а
   потому что ему хватало intrinsic line-height. Эти две вещи мы
   связали по корреляции, не по причинно-следственной связи.
   
   **Настоящий root cause:** в WebKit (iOS WKWebView, Telegram) если у
   `<input>` **нет явного `line-height`**, движок вычисляет caret-rect
   из font ascent/descent и метрик контейнера. В `display: flex`
   контейнере с растянутым по высоте инпутом этот расчёт даёт
   смещённый вниз caret. Текст рисуется по `padding`, а каретка —
   по неправильно посчитанной baseline. Эффект: caret «вылезает»
   за нижнюю границу инпута.
   
   В коде MiniApp.tsx строка 797-798 уже есть комментарий **прямым
   текстом**: `"Explicit lineHeight is required — without it, ...
   WebKit caret to render displaced vertically in focused inputs"`.
   Каноничный `inputStyle` имеет `lineHeight: '22px'` именно по этой
   причине. Календарная форма была построена inline, без использования
   канона, и `lineHeight` не выставлен ни на одном из 4 инпутов.
   Проявилось только на цене из-за `flex: 2` контейнера.

**Root cause:**
- Bug 1 (фото): «глобальный default-header» в обёртке fetch без
  проверки типа body. Эта ошибка системная — каждый будущий
  multipart-загрузчик через `tgFetch` сломался бы тем же способом.
- Bug 2 (каретка): inline-стили инпутов вместо использования
  каноничного `inputStyle`. В каноне есть defensive свойства
  (`lineHeight`, `WebkitUserSelect`, `touchAction`), которые лечат
  набор iOS WKWebView квирков; их пропуск проявляется
  не-детерминированно — где-то работает «по случаю», где-то ломается.

### Урок
1. **Обёртки над fetch не должны жёстко задавать `Content-Type`** —
   браузер сам выставит правильный, если body это `FormData`, `Blob` или
   `URLSearchParams`. Default-заголовок имеет смысл только для JSON-body.
   Безопасный паттерн:
   ```ts
   headers: {
     ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
     ...
   }
   ```
2. **Любой `<input>` в Mini App обязан иметь явный `line-height`**
   (помимо font-size). Без него WebKit считает caret-rect из intrinsic
   метрик, что в flex-контейнерах ломается. Также обязательны
   `WebkitUserSelect: 'text'` и `touchAction: 'auto'` (комментарий в
   коде про native selection handles при ancestor touchmove handlers).
3. **Корреляция ≠ причина при отладке UI-багов.** Если после первого
   фикса баг сохраняется, это означает, что гипотеза о root cause
   неверна, а не «фикс не доехал до прода». Не повторять тот же фикс,
   а пересобирать гипотезу. Здесь корреляция была: text-инпут имел
   scroll-handler И работал → решили, что scroll-handler == фикс.
   Реальная причина — у text-инпута caret-displacement не
   проявлялся по другим случайным причинам.

### Правило
- Любая обёртка над `fetch` должна проверять `body instanceof FormData`
  (и желательно `Blob`/`URLSearchParams`) и **не** заполнять
  Content-Type в этих случаях.
- **Inline-стили на `<input>` без `lineHeight` запрещены.** Либо
  использовать каноничный `inputStyle` из MiniApp.tsx (через spread
  `...inputStyle`), либо явно прописать `lineHeight`,
  `WebkitUserSelect: 'text'`, `touchAction: 'auto'`.
- При фиксе UI-бага в Mini App **проверять на проде**, что симптом
  ушёл, прежде чем закрывать тикет. Локальная проверка через TS-check
  не покрывает iOS WKWebView quirks — нужен реальный тап.
- Если фикс №1 не помог — **новая гипотеза**, не «усилить тот же фикс».

### Лучший код
```tsx
// apps/web/app/miniapp/MiniApp.tsx — tgFetch
headers: {
  ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
  ...(initDataRef.current ? { 'X-TG-INIT-DATA': initDataRef.current } : {}),
  ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  ...(init?.headers as Record<string, string> | undefined),
},

// CalendarDetail.tsx — каждый <input> формы:
style={{
  ...,
  fontSize: 14, lineHeight: '20px',                    // ← lineHeight обязателен
  WebkitUserSelect: 'text', userSelect: 'text',        // ← iOS native selection
  touchAction: 'auto',                                 // ← iOS WKWebView quirk
}}
```

**Долгосрочно:** календарная форма должна быть переписана через
`...inputStyle` из канона. Inline-стили в новом коде — нарушение
design-system rules (CLAUDE.md: «No raw hex colors, no raw rgba, no
arbitrary Tailwind values in new code» — то же касается inline
inputs без primitive).

---

## 2026-04-30 — `getOrCreateProfile` race-condition 500 (повтор)

### Ошибка
GET `/tg/me/profile` периодически отвечает 500 для нового пользователя. В
логах — `PrismaClientKnownRequestError P2002` на `UserProfile.userId`,
вызов `prisma.userProfile.upsert()` внутри `getOrCreateProfile`. Mini-app
boot параллельно стреляет несколькими GET'ами от одного юзера, оба
запроса находят `findUnique == null`, оба делают `upsert`, второй падает
на unique-constraint.

Это **второе появление** того же бага. Первый фикс (`281379a`,
2026-04-19) заменил `create` на `upsert({ update: {} })` в надежде, что
Prisma переведёт это в атомарный `INSERT ... ON CONFLICT DO UPDATE`. На
проде 2026-04-30 оно опять упало — Prisma 5.18 при пустом `update: {}`
не использует native ON CONFLICT, а откатывается на тот же
check-then-create, который мы пытались исправить.

**Root cause:** ставка на «Prisma upsert магически атомарен» без проверки
поведения движка. Empty update — особый кейс, который ломает
оптимизацию. Гонка осталась.

### Урок
В Prisma `upsert` — **не безусловно атомарный** на уровне БД. При пустом
`update: {}` или некоторых других формах он деградирует до
find-then-create, и в условиях конкуренции от одного клиента выпадает в
P2002. Надёжный race-safe паттерн в Prisma — это `try { create }
catch (P2002) { findUnique }`. Это явный, тестируемый, не зависящий от
внутренних оптимизаций ORM код.

Отдельно: «фикс» race-condition нельзя считать закрытым, пока не
воспроизвели гонку искусственно (две параллельные create-операции в
тесте). Любая логика «оно теперь атомарное» без эмпирической проверки —
гипотеза, а не фикс.

### Правило
1. **Prisma upsert не равно ON CONFLICT.** Не полагайся на upsert как
   на race-safe primitive. Если нужна гарантия — пиши `create` + catch
   `Prisma.PrismaClientKnownRequestError` с `code === 'P2002'` и
   `meta.target.includes('<field>')`, потом re-fetch.
2. **Узкий catch.** Catch P2002 только для конкретного поля; остальные
   constraint violations (`username`, `supportId` и т.п.) пробрасывай —
   это другие баги, маскировать нельзя.
3. **Race-fixes требуют test-evidence.** Если фиксишь гонку без
   юнит-теста, который её воспроизводит — фикс гипотетический. Минимум:
   nightly e2e, который параллелит 5 одновременных вызовов проблемной
   функции и ждёт стабильного результата.
4. **Re-occurrence == уровень выше.** Если тот же баг с тем же symptom
   возвращается после «фикса» — менять стратегию, не подкручивать
   старый подход.

### Лучший код
```ts
// ❌ Первый фикс: upsert с пустым update — Prisma фолбэчит на
// check-then-create при некоторых конфигурациях
profile = await prisma.userProfile.upsert({
  where: { userId },
  create: { userId, defaultCurrency, supportId },
  update: {},
});

// ✅ Race-safe: явный create + узкий catch P2002 + re-fetch
try {
  profile = await prisma.userProfile.create({
    data: { userId, defaultCurrency, supportId },
  });
} catch (err) {
  const isUserIdConflict =
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    Array.isArray((err.meta as { target?: unknown } | undefined)?.target) &&
    ((err.meta as { target: string[] }).target.includes('userId'));
  if (!isUserIdConflict) throw err; // другие constraints — наверх
  const existing = await prisma.userProfile.findUnique({ where: { userId } });
  if (!existing) throw err;
  profile = existing;
}
```

**Commit:** see `git log --grep="fix(profile): replace fragile upsert"` (commit hash chases itself on amend; pick by date 2026-04-30)

---

## 2026-04-29 — Calendar idea cards: keyboard overlap + non-tappable cards

### Ошибка
В разделе «Идеи подарков» на детальной карточке события было два бага:
1. При тапе на «+ Добавить идею» открывалась клавиатура и перекрывала
   форму ввода — пользователь не видел поля.
2. Создав идею с фото/ссылкой/заметкой, нельзя было открыть её для
   просмотра. Карточка идеи была плоская (только чекбокс + удалить),
   фото отображалось маленьким превью, заметка/ссылка — мелким хвостом
   или не отображались вовсе. Поле `note` существовало в типе и API, но
   в форме создания его вообще не было.

**Root cause:** UI был построен под “write-only” модель — данные пишутся,
но reading-experience не спроектирован. Authoring (создание) и
consumption (просмотр) разошлись: API даёт богатую сущность (фото,
ссылка, заметка, цена), а UI рендерит только заголовок + чекбокс.
Плюс `autoFocus` без явного `scrollIntoView` — на iOS-keyboard форма
оказывалась за виртуальной клавиатурой.

### Урок
Каждая создаваемая сущность должна иметь parity между формой создания и
view-режимом. Если API принимает поле — форма должна его экспонировать.
Если форма принимает поле — view должен его показывать. Любое поле,
которое “тихо проваливается” (есть в API, нет в UI) — это потерянная
работа пользователя.

Отдельно: `autoFocus` на iOS/Telegram WebApp **не гарантирует** прокрутку
к полю. visualViewport ресайзится с задержкой, и `scrollIntoView` нужно
вызывать после стабилизации (или повторно по `onFocus` с `setTimeout`).

### Правило
1. **API field parity:** при review’е формы создания — пройтись по
   payload’у API и убедиться, что каждое поле имеет input. Если поле
   опциональное и редко используется — спрятать за «Дополнительно», но
   не выкидывать.
2. **View parity:** view-карточка должна уметь показать всё, что было
   введено. Если поле есть в типе — UI должен иметь явный путь к его
   отображению (inline или через раскрытие/детальный экран).
3. **Mobile keyboard scroll:** при появлении формы внутри скролл-страницы
   на мобильном — всегда вызывать `scrollIntoView` через ref, плюс
   повторный вызов на `onFocus` с задержкой 300ms (под анимацию
   visualViewport). `autoFocus` без скролла = баг на iOS.

### Лучший код
```tsx
// ❌ До: autoFocus без скролла, форма уходит под клавиатуру
<input autoFocus ... />

// ✅ После: ref + useEffect + onFocus retry
const formRef = useRef<HTMLDivElement>(null);
useEffect(() => {
  if (adding && formRef.current) {
    formRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}, [adding]);

<div ref={formRef}>
  <input
    autoFocus
    onFocus={() => {
      setTimeout(() => formRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
    }}
  />
</div>
```

```tsx
// ❌ До: карточка идеи — view-only, нельзя открыть фото/note/link
<div>
  <Checkbox /> <Thumbnail /> <Title /> <DeleteButton />
</div>

// ✅ После: tap-to-expand, парность с полями API
const hasDetails = !!(idea.imageUrl || idea.note || idea.link);
<div>
  <div onClick={() => hasDetails && setExpandedId(expanded ? null : idea.id)}>
    {idea.text} {hasDetails && !expanded && <span>›</span>}
  </div>
  {expanded && (
    <ExpandedView photo={idea.imageUrl} note={idea.note} link={idea.link} />
  )}
</div>
```

```tsx
// ❌ До: API принимает note, форма не отправляет
await api.createIdea(tg, occasionId, { text, link, price, currency });

// ✅ После: каждое поле API имеет input в форме
await api.createIdea(tg, occasionId, {
  text, link, price, currency,
  note: note.trim() || undefined,
});
```

**Commit:** `2ad5cb7` — fix(calendar): expandable idea cards + keyboard scroll + note field
