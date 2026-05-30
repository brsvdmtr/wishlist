export const ANALYTICS_EVENTS = [
  'bot.start_received',
  'miniapp.open_attempt',
  'miniapp.tg_context_detected',
  'miniapp.initdata_present',
  'miniapp.bootstrap_started',
  'miniapp.bootstrap_succeeded',
  'miniapp.bootstrap_failed',
  'miniapp.first_rendered',
  'miniapp.boot_timeout',
  'miniapp.fatal_render_error',
  'wishlist.created',
  'wishlist.deleted',
  'wish.created',
  'wish.edited',
  'wish.deleted',
  'wish.completed',
  'import.started',
  'import.succeeded',
  'import.failed',
  'import.bot_started',
  'import.bot_succeeded',
  'import.bot_failed',
  // Credit-based URL import — FREE monthly quota, paid-pack fallback, upsell.
  'import.free_quota_used',
  'import.free_quota_exhausted',
  'import.credit_pack_suggested',
  'guest.view_opened',
  'reservation.succeeded',
  'reservation.cancelled',
  'share.token_generated',
  'subscription.cancelled',
  'payment.pre_checkout_rejected',
  'showcase.editor_opened',
  'showcase.cover_uploaded',
  'showcase.cover_removed',
  'showcase.saved',
  'showcase.published',
  'showcase.preview_opened',
  'showcase.share_clicked',
  'showcase.paywall_viewed',
  'showcase.upgrade_clicked',
  'public_profile.viewed',
  'public_profile.wishlist_opened',

  // ===== Referral program =====
  // See /mockups/referral-program.html S11 for the full spec.
  // Inviter entry points
  'referral.entry_point_impression',
  'referral.entry_point_clicked',
  'referral.home_banner_dismissed',
  'referral.screen_opened',
  'referral.rules_opened',
  'referral.history_opened',
  // Share flow
  'referral.share_action_sheet_opened',
  'referral.link_copied',
  'referral.share_intent',
  'referral.share_completed',
  'referral.share_failed',
  'referral.reminder_drafted',
  // Pre-attribution (bot /start)
  'referral.start_command_received',
  'referral.code_resolved',
  'referral.code_invalid',
  'referral.payload_missing',
  'referral.landing_viewed',
  // Invitee funnel
  'referral.onboarding_started',
  'referral.onboarding_step_viewed',
  'referral.first_wishlist_created',
  'referral.first_item_created',
  'referral.qualification_criteria_met',
  // Attribution lifecycle
  'referral.attributed',
  'referral.attribution_rejected_on_write',
  'referral.pending_activation',
  'referral.qualified',
  'referral.qualification_timeout',
  'referral.rewarded',
  'referral.reward_grant_failed',
  'referral.rejected',
  // Fraud signals (per-signal events)
  'referral.fraud_signal_ip_cluster',
  'referral.fraud_signal_device_fingerprint',
  'referral.fraud_signal_velocity',
  'referral.fraud_signal_inactive_invitee',
  'referral.fraud_signal_same_tz_cluster',
  'referral.fraud_signal_self_referral',
  'referral.fraud_signal_suspicious_onboarding',
  'referral.fraud_signal_account_age_delta',
  'referral.fraud_score_calculated',
  'referral.fraud_review_queued',
  'referral.fraud_resolved',
  'referral.fraud_cluster_created',
  'referral.fraud_cluster_grew',
  'referral.fraud_false_positive_confirmed',
  'referral.fraud_false_negative_confirmed',
  'referral.reward_revoked',
  // Silent failures & UI errors
  'referral.code_generation_failed',
  'referral.screen_load_failed',
  'referral.history_load_failed',
  'referral.deeplink_open_failed',
  'referral.landing_render_blocked',
  'referral.banner_impression_but_no_click_session',
  'referral.client_js_error',
  // Race conditions & edge
  'referral.concurrent_attribution_blocked',
  'referral.qualification_fired_after_timeout',
  'referral.reward_granted_after_revoke',
  'referral.duplicate_start_command',
  'referral.attribution_invariant_violation',
  'referral.invitee_deleted_account_before_qualify',
  'referral.inviter_deleted_account_after_qualify',
  'referral.clock_skew_detected',
  // Reward grant mechanics
  'referral.cap_check_performed',
  'referral.pro_subscription_extended',
  'referral.pro_subscription_extend_failed',
  'referral.idempotency_hit',
  'referral.admin_manual_grant',
  // Bot notification health
  'referral.bot_notification_sent',
  'referral.bot_notification_delivery_failed',
  'referral.bot_notification_rate_limit_applied',
  'referral.bot_notification_dropped',
  'referral.bot_notification_opened',
  // Config & reproducibility
  'referral.config_changed',
  'referral.config_fetch_failed',
  'referral.experiment_assigned',
  'referral.experiment_exposure',
  'referral.feature_flag_evaluated',
  // Monetization impact (delayed attribution)
  'referral.inviter_converted_to_paid_after_bonus',
  'referral.invitee_converted_to_paid',
  'referral.invitee_retained_d7',
  'referral.invitee_retained_d30',
  // Celebration UI
  'referral.celebration_viewed',
  'referral.celebration_cta_clicked',

  // ===== Admin / ops =====
  // Emitted by GET /admin/billing/reconcile (counts only, no PII) so an
  // operator running a reconciliation leaves an audit trail.
  'admin.billing_reconcile_viewed',

  // ===== Birthday Reminders =====
  // Settings (writes from Mini App)
  'birthday.settings_opened',
  'birthday.friend_reminders_enabled',
  'birthday.friend_reminders_disabled',
  'birthday.owner_reminders_enabled',
  'birthday.owner_reminders_disabled',
  'birthday.audience_changed',
  'birthday.advanced_windows_enabled',
  'birthday.advanced_windows_disabled',
  'birthday.primary_wishlist_set',
  'birthday.primary_wishlist_cleared',
  'birthday.custom_message_saved',
  'birthday.custom_message_cleared',
  'birthday.receiving_enabled',
  'birthday.receiving_disabled',
  // Opt-in flow (after first save of birthday)
  'birthday.optin_shown',
  'birthday.optin_accepted',
  'birthday.optin_dismissed',
  // Mute / unmute
  'birthday.mute_added',
  'birthday.mute_removed',
  // Pro paywall
  'birthday.paywall_shown',
  'birthday.paywall_converted',
  'birthday.pro_required_hit',
  // Scheduler (server-side)
  'birthday.scheduler_run_started',
  'birthday.scheduler_run_completed',
  'birthday.scheduler_run_failed',
  'birthday.candidate_found',
  'birthday.delivery_created',
  'birthday.delivery_sent',
  'birthday.delivery_skipped',
  'birthday.delivery_deferred',
  'birthday.delivery_failed',
  'birthday.delivery_retry',
  // Bot side
  'birthday.bot_message_sent',
  'birthday.bot_message_failed',
  'birthday.bot_cta_clicked',
  'birthday.bot_mute_clicked',
  // Mini App attribution (deep-link → in-app)
  'birthday.deeplink_opened',
  'birthday.deeplink_resolve_failed',
  'birthday.banner_seen',
  'birthday.banner_dismissed',
  'birthday.banner_cta_clicked',
  'birthday.public_wishlist_opened',
  'birthday.public_profile_opened',
  'birthday.item_opened',
  'birthday.item_reserved',
  'birthday.secret_reservation_clicked',
  'birthday.gift_completed',
  'birthday.subscribe_clicked',
  // Owner attribution (post-owner-reminder behavior)
  'birthday.owner_update_wishlist_opened',
  'birthday.owner_item_added',
  'birthday.owner_wishlist_made_public',

  // ===== Global search =====
  // See docs/design-system/mockups/proposed/global-search.html for the visual
  // spec + privacy notes. RAW QUERY IS NEVER LOGGED — only queryLength and a
  // SHA-1 hash of the normalized query for god-mode debugging.
  'search.opened',
  'search.query_started',
  'search.query_completed',
  'search.query_failed',
  'search.result_clicked',
  'search.filter_changed',
  'search.empty_shown',
  'search.recent_clicked',
  'search.suggestion_clicked',
  'search.paywall_shown',
  'search.paywall_cta_clicked',
  'search.clear_clicked',
  'search.closed',
  'search.access_recorded',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCT EVENT TAXONOMY (typed registry, foundation for new events)
//
// `ANALYTICS_EVENTS` above is the LEGACY allowlist — kept untouched so existing
// dashboards and `trackAnalyticsEvent`/`trackEvent` call-sites keep working.
//
// `PRODUCT_EVENTS` below is the NEW source-of-truth for product events going
// forward. Every new event MUST land here with a descriptor declaring:
//   • domain.action name
//   • description
//   • sources — `'server'` / `'client'` / `'bot'`. Drives the allowlist on
//     `/tg/telemetry`: `serverOnly` events are HARD-DENIED on ingest, even if
//     their legacy domain prefix would otherwise accept them. This is the
//     core security invariant — clients must not be able to spoof revenue,
//     entitlement, or PRO-status events.
//   • pii — `'none'` (safe), `'hashed'` (only hashed identifiers in props),
//     or `'userId-only'` (props reference the canonical user row, no raw PII).
//
// See `docs/analytics-events.md` for naming rules and adoption checklist.
// ─────────────────────────────────────────────────────────────────────────────

export type ProductEventSource = 'server' | 'client' | 'bot';

export interface ProductEventDescriptor {
  readonly name: string;
  readonly domain: string;
  readonly action: string;
  readonly description: string;
  readonly sources: readonly ProductEventSource[];
  readonly pii: 'none' | 'hashed' | 'userId-only';
}

// IMPORTANT — invariant maintained by `analyticsEvents.test.ts`:
//   1. Every name matches `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$` (domain.action,
//      lowercase, single dot, snake_case allowed in segments).
//   2. `domain` and `action` always match the parsed segments of `name`.
//   3. No duplicate names across PRODUCT_EVENTS or vs. ANALYTICS_EVENTS legacy.
//   4. `sources` is non-empty.
// Breaking any of these fails CI at the snapshot test in `analyticsEvents.test.ts`.
export const PRODUCT_EVENTS = [
  // ── Revenue / entitlement (server-authoritative) ──
  {
    name: 'payment.completed',
    domain: 'payment',
    action: 'completed',
    description:
      'Successful Telegram Stars payment confirmed by the server. Authoritative input for revenue dashboards. NEVER trust a client-side mirror of this. props: amountStars, currency, billingPeriod (monthly|yearly|lifetime|addon), chargeId, source, planCode?, skuCode?, priceBucket? (E17 yearly-price arm control|a|b — present only for yearly purchases made while the experiment was live).',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'pro.activated',
    domain: 'pro',
    action: 'activated',
    description:
      'Pro entitlement granted (paid purchase, lifetime, referral reward, or admin grant). Server emits at the moment the entitlement row is written. props: planCode, billingPeriod, source, amountStars, currency, priceBucket? (E17 yearly-price arm — present only for yearly activations made while the experiment was live).',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'subscription.renewed',
    domain: 'subscription',
    action: 'renewed',
    description:
      'Auto-renewal of a recurring Pro subscription via Telegram Stars. Server-only — client cannot observe the renewal cycle.',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'subscription.expired',
    domain: 'subscription',
    action: 'expired',
    description:
      'Subscription crossed its currentPeriodEnd without renewal. Emitted by the expiry-sweep scheduler.',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'user.signup',
    domain: 'user',
    action: 'signup',
    description:
      'First-ever User row created from a Telegram auth payload. Server-side truth for cohort/funnel counts.',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'guest.converted_to_user',
    domain: 'guest',
    action: 'converted_to_user',
    description:
      'A previously anonymous guest session became an authenticated user. Server-only conversion signal.',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'wishlist.default_created',
    domain: 'wishlist',
    action: 'default_created',
    description:
      'Auto-created REGULAR wishlist (E04 activation) materialised for a user with zero existing REGULAR wishlists. Fires from the bootstrap path (/tg/me/profile) when isDefault=true row is freshly inserted. Idempotent — repeat bootstraps for the same user do NOT re-emit. Distinct from wishlist.created (manual / onboarding create).',
    sources: ['server'],
    pii: 'userId-only',
  },
  // ── Paywall UI (client-allowed) ──
  {
    name: 'paywall.viewed',
    domain: 'paywall',
    action: 'viewed',
    description:
      'Paywall sheet rendered to the user. UI impression — emitted from the Mini App. props: context, surface (pro_upsell_sheet|screen), trigger, wishlistId?, yearlyVariant? + yearlyPriceXtr? (E17 — the Pro upsell sheet always shows the yearly tile, so a pro_upsell_sheet impression IS the yearly-price experiment denominator; present only while the experiment is active).',
    sources: ['client'],
    pii: 'none',
  },
  {
    name: 'paywall.cta_clicked',
    domain: 'paywall',
    action: 'cta_clicked',
    description:
      'User tapped the primary CTA on a paywall (purchase/upgrade). Intent signal — does NOT prove payment.',
    sources: ['client'],
    pii: 'none',
  },
  // ── Other client-side product signals ──
  {
    name: 'wishlist.shared',
    domain: 'wishlist',
    action: 'shared',
    description:
      'Client-side native share completed (Telegram share sheet, copy-link success). Server emits a separate event for token generation.',
    sources: ['client'],
    pii: 'none',
  },
  {
    name: 'user.session_started',
    domain: 'user',
    action: 'session_started',
    description:
      'Mini App opened and bootstrapped for a known user. Used to compute DAU / session-length.',
    sources: ['client'],
    pii: 'none',
  },
  // ── Research surveys (all server-emitted; client never proxies these) ──
  {
    name: 'survey.invite_sent',
    domain: 'survey',
    action: 'invite_sent',
    description:
      'Bot DM with survey CTA delivered. Emitted by scheduler after successful sendTgBotMessage; failures emit survey.invite_failed instead.',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'survey.opened',
    domain: 'survey',
    action: 'opened',
    description:
      'User followed survey deep link and Mini App fetched the invite. State transition SENT/PENDING → OPENED.',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'survey.started',
    domain: 'survey',
    action: 'started',
    description:
      'User answered the first question. State transition OPENED → STARTED; ResearchSurveyResponse row created.',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'survey.question_answered',
    domain: 'survey',
    action: 'question_answered',
    description:
      'Single question answered (single/multi/nps/open). Props: questionId, optionIds[], hasText. One event per answer write; multi-choice ships all selected optionIds in one event.',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'survey.completed',
    domain: 'survey',
    action: 'completed',
    description:
      'All required questions answered and reward bookkeeping committed. Props: rewardKind (pro_30d | pro_30d_lifetime_noop), segmentId, segmentSubtype.',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'survey.dismissed',
    domain: 'survey',
    action: 'dismissed',
    description:
      'User explicitly closed the survey via "not now" CTA. Distinct from passive abandonment (which leaves status=OPENED/STARTED with completedAt=null).',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'survey.invite_failed',
    domain: 'survey',
    action: 'invite_failed',
    description:
      'Bot DM delivery failed terminally (403 / bot_blocked / other Telegram 4xx). State transition to FAILED; never retried.',
    sources: ['server'],
    pii: 'userId-only',
  },
  // ── Hint free-quota (server-authoritative) ──
  // "Hint friends" is a FREE monthly quota (default 3/mo), not a hard PRO
  // gate. The quota is charged on DELIVERY, never on hint-wave creation —
  // see services/hint-credits.ts.
  {
    name: 'hint.free_quota_charged',
    domain: 'hint',
    action: 'free_quota_charged',
    description:
      'A delivered hint consumed one unit of the FREE monthly hint quota. Emitted by consumeHintCharge() after the bot reports the hint DELIVERED — never on hint-wave creation.',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'hint.free_quota_charge_skipped',
    domain: 'hint',
    action: 'free_quota_charge_skipped',
    description:
      "A delivered hint did NOT consume a FREE quota unit. props.reason: 'pro' (unlimited plan), 'paid_pack' (a paid hints_pack credit was spent instead), or 'grace' (free quota ran out between wave creation and delivery — delivered anyway, uncharged).",
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'hint.free_quota_exhausted',
    domain: 'hint',
    action: 'free_quota_exhausted',
    description:
      'The hint charge that drained the last FREE monthly credit. Fires at most once per user per month, in the same consumeHintCharge() call as the final hint.free_quota_charged.',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'hint.pack_suggested',
    domain: 'hint',
    action: 'pack_suggested',
    description:
      'A FREE user with no remaining free quota and no paid hint credits hit the hint gate on POST /tg/items/:id/hint; the 402 upsell (buy a hints pack / upgrade to PRO) was returned.',
    sources: ['server'],
    pii: 'userId-only',
  },
  // ── Secret Santa PRO gates ──
  // Three PRO-gated Secret Santa features: campaign type MULTI_WAVE,
  // individual exclusion pairs, and exclusion groups. The API enforces each
  // with a 402 pro_required; the Mini App discloses them before submit and
  // opens a context-aware upsell. See docs/MONETIZATION.md § 16b.
  {
    name: 'santa.gate_hit',
    domain: 'santa',
    action: 'gate_hit',
    description:
      'A FREE user hit a Secret Santa PRO gate — the API returned 402 pro_required. props.feature: santa_multi_wave | santa_exclusions | santa_exclusion_groups | santa_hint. For santa_hint the FREE allowance is quota-based (1/campaign) — props also include limit, previousCount, plan, campaignId. Server-authoritative — emitted by the route handler, never trusted from a client.',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'santa.paywall_viewed',
    domain: 'santa',
    action: 'paywall_viewed',
    description:
      'The Secret Santa PRO upsell sheet was rendered to a FREE user. UI impression emitted from the Mini App. props.context: santa_multi_wave | santa_exclusions | santa_exclusion_groups.',
    sources: ['client'],
    pii: 'none',
  },
  {
    name: 'santa.paywall_cta_clicked',
    domain: 'santa',
    action: 'paywall_cta_clicked',
    description:
      'A FREE user tapped the upgrade CTA on a Secret Santa PRO upsell. Intent signal — does NOT prove payment. props.context, props.plan.',
    sources: ['client'],
    pii: 'none',
  },
  // ── Secret Santa funnel (server-emitted) ──
  // Five-stage seasonal funnel for the Secret Santa flow, complementing the
  // PRO-gate (santa.gate_hit) and paywall (santa.paywall_*) events above.
  // All five are server-authoritative — emitted by the route handlers in
  // apps/api/src/routes/santa.routes.ts, never trusted from a client: the
  // `santa.` domain is NOT in ANALYTICS_EVENT_PREFIXES, and sources:['server']
  // hard-denies them at /tg/telemetry (isServerOnlyProductEvent). props carry
  // ONLY campaign/round-scoped ids, counts, and booleans — NEVER giver↔receiver
  // assignment identity, so the anonymity guarantee of the draw is preserved
  // in the (unencrypted, ad-hoc-queried) AnalyticsEvent table. Funnel readout
  // SQL + privacy notes: docs/research/santa-funnel-sql.md.
  {
    name: 'santa.campaign_created',
    domain: 'santa',
    action: 'campaign_created',
    description:
      'Organizer created a Secret Santa campaign (status DRAFT). Top of the organizer funnel. Emitted by POST /tg/santa/campaigns after the SantaCampaign row is written. props: campaignId, type (CLASSIC | MULTI_WAVE), seasonYear.',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'santa.invite_clicked',
    domain: 'santa',
    action: 'invite_clicked',
    description:
      'A user opened a Secret Santa invite link and the campaign preview resolved successfully. Top of the invitee funnel. Emitted by GET /tg/santa/invite/:token — only on a valid, joinable resolution (200), never on a dead / cancelled / closed invite. props: campaignId, alreadyJoined.',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'santa.joined',
    domain: 'santa',
    action: 'joined',
    description:
      'A participant joined a campaign — a real transition to status JOINED (fresh join or rejoin after leaving). Emitted by POST /tg/santa/campaigns/:id/join. The idempotent already-JOINED re-POST does NOT re-emit. props: campaignId, rejoin (true for a left→JOINED transition).',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'santa.draw_completed',
    domain: 'santa',
    action: 'draw_completed',
    description:
      'The organizer ran the draw and assignments were persisted (campaign → ACTIVE). Emitted by POST /tg/santa/campaigns/:id/draw inside the success path, AFTER the assignment transaction commits. props: campaignId, roundId, roundNumber, participantCount, assignmentCount — AGGREGATE COUNTS ONLY. The giver→receiver pairs are NEVER included; leaking them would break draw anonymity.',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'santa.reveal_opened',
    domain: 'santa',
    action: 'reveal_opened',
    description:
      'A receiver opened their post-gift reveal (their own giftStatus is RECEIVED) on GET /tg/santa/campaigns/:id/reveal. Bottom of the funnel. props: campaignId, isFirstReveal (true on the first-ever open, tracked via SantaAssignment.revealedAt). userId is the receiver, acting on their own assignment — the giver identity (even the anonymised alias) is NEVER put in props, so the reveal event cannot reconstruct a pairing.',
    sources: ['server'],
    pii: 'userId-only',
  },
  // ── PRO cancel anti-churn sheet (client-side funnel) ──
  // Three events form the cancel-flow funnel: sheet impression → explicit
  // "Keep PRO" tap → confirmed cancel. Distinct from the legacy
  // `subscription_cancelled` (prefix-allowed, fires alongside `confirmed`)
  // and the server-authoritative `subscription.cancelled` (server-only,
  // emitted by the API after `cancelAtPeriodEnd` is written).
  //
  // Domain choice (`pro_cancel.*` not `subscription.cancel_*`): keeps the
  // server-authoritative `subscription.*` lifecycle namespace clean of
  // client UI funnel events — the new typed taxonomy was created precisely
  // to avoid that mixing. A `subscription_*` prefix would also be silently
  // auto-accepted by the legacy ANALYTICS_EVENT_PREFIXES, defeating the
  // explicit-allowlist goal.
  //
  // Backdrop / drag-dismiss is intentionally NOT tracked here.
  // Anti-churn measurement derives the dismissed cohort as
  // `sheet_viewed - keep_clicked - confirmed`. Adding a separate
  // `pro_cancel.dismissed` would require the BottomSheet primitive to
  // distinguish user-driven close from programmatic / session-end close
  // (otherwise it conflates "actively walked away" with "tab backgrounded"),
  // and that distinction is not present today. If the dismissed cohort
  // becomes load-bearing, add the source-tagged event THEN — don't
  // pre-emit garbage data.
  //
  // Caveat: the derived "dismissed" cohort also absorbs cancel-tap +
  // backend-failure paths (409 lifetime-guard from a stale client, network
  // error) — handleCancelSub's `finally` closes the sheet without firing
  // keep_clicked OR confirmed in those branches. Acceptable today because
  // cancel-failure rate is empirically negligible (lifetime users don't
  // see the button; network failures are rare). If failure rate exceeds
  // ~1% of sheet opens, introduce `pro_cancel.failed` rather than try to
  // bisect the dismissed bucket post-hoc.
  {
    name: 'pro_cancel.sheet_viewed',
    domain: 'pro_cancel',
    action: 'sheet_viewed',
    description:
      'Anti-churn cancel sheet rendered to a paid PRO user who tapped "Cancel renewal" in Settings. Top of the cancel funnel. Fires once per open transition.',
    sources: ['client'],
    pii: 'none',
  },
  {
    name: 'pro_cancel.keep_clicked',
    domain: 'pro_cancel',
    action: 'keep_clicked',
    description:
      'User explicitly tapped "Keep PRO" on the anti-churn sheet. Funnel save signal — distinct from passive backdrop / drag dismiss (which is not tracked).',
    sources: ['client'],
    pii: 'none',
  },
  {
    name: 'pro_cancel.confirmed',
    domain: 'pro_cancel',
    action: 'confirmed',
    description:
      'User tapped "Cancel renewal" on the anti-churn sheet and the backend acknowledged with cancelAtPeriodEnd=true. Mirrors the legacy `subscription_cancelled` client event for the new pro_cancel.* funnel; the server-authoritative `subscription.cancelled` remains the source of truth for revenue dashboards.',
    sources: ['client'],
    pii: 'none',
  },
  // ── Guest → Owner conversion funnel (E11 post-reservation account-claim CTA) ──
  {
    name: 'guest_owner_cta.shown',
    domain: 'guest_owner_cta',
    action: 'shown',
    description:
      'Post-reservation account-claim Sheet rendered to a guest with zero own wishlists (E11 — see docs/research/06-experiment-backlog.md). Top of the G→O conversion funnel. Fires at most once per session per user and respects a 30-day cooldown.',
    sources: ['client'],
    pii: 'none',
  },
  {
    name: 'guest_owner_cta.clicked',
    domain: 'guest_owner_cta',
    action: 'clicked',
    description:
      'Guest tapped the primary "Create my wishlist" CTA on the E11 Sheet. Intent signal — actual wishlist creation arrives later as wishlist.created with source=post_reservation_claim; final conversion is the server-emitted guest.converted_to_user.',
    sources: ['client'],
    pii: 'none',
  },
  {
    name: 'guest_owner_cta.dismissed',
    domain: 'guest_owner_cta',
    action: 'dismissed',
    description:
      'Guest closed the E11 Sheet without converting — via "Позже" tap, swipe-down, or backdrop tap (carried in the `method` prop). Funnel drop-off signal.',
    sources: ['client'],
    pii: 'none',
  },
  // ── Guest → Owner conversion funnel (E13 passive guest-view banner) ──
  {
    name: 'guest_banner.shown',
    domain: 'guest_banner',
    action: 'shown',
    description:
      'Passive "create your own wishlist" banner scrolled into view at the end of a guest-view, for a guest with zero own wishlists (E13 — see docs/research/06-experiment-backlog.md). Fires once per session when it enters the viewport; capped at N impressions / 7 days. props: wishlistId, experimentKey, variant, shownCountInWindow, godModeForce.',
    sources: ['client'],
    pii: 'none',
  },
  {
    name: 'guest_banner.clicked',
    domain: 'guest_banner',
    action: 'clicked',
    description:
      'Guest tapped the E13 banner CTA ("Create my wishlist"). props: wishlistId, destination ("onboarding-entry"), experimentKey, variant, godModeForce. Intent signal — the CTA launches onboarding, so the downstream join key is onboarding_started.entry_point="guest_view_banner" (NOT wishlist.created.source, which is always "miniapp"); final guest→owner conversion is the server-emitted guest.converted_to_user.',
    sources: ['client'],
    pii: 'none',
  },
  {
    name: 'guest_banner.dismissed',
    domain: 'guest_banner',
    action: 'dismissed',
    description:
      'Guest closed the E13 banner via the × button (carried in the `method` prop). Mutes the banner for the rest of the 7-day window. Funnel drop-off signal.',
    sources: ['client'],
    pii: 'none',
  },
  // ── Experiments (A/B infrastructure — server-assigned sticky buckets) ──
  {
    name: 'experiment.assigned',
    domain: 'experiment',
    action: 'assigned',
    description:
      'A user was bucketed into an experiment. Emitted server-side exactly once per (user, experiment) on first exposure — the unique ExperimentAssignment row is the dedup guard. props: key (experiment id), variant (control | treatment), holdout (true for the global 5% holdout cohort).',
    sources: ['server'],
    pii: 'userId-only',
  },
  // ── Group Gift price elasticity (E24 — `group-gift-price` experiment) ──
  // The unlock price is bucket-aware: control = GROUP_GIFT_PRICE_XTR (79),
  // treatment = GROUP_GIFT_PRICE_TEST_XTR (39). The sticky variant is assigned
  // server-side (experiment.assigned, above); this event is the UI IMPRESSION
  // and the denominator for the primary metric (revenue per paywall impression).
  // Variant attribution for revenue/guardrail readouts comes from the
  // ExperimentAssignment table, not from this client event — see
  // docs/research/experiments/group-gift-price-e24.md.
  {
    name: 'group_gift.unlock_paywall_variant',
    domain: 'group_gift',
    action: 'unlock_paywall_variant',
    description:
      'The Group Gift unlock paywall screen was shown to a non-entitled user. UI impression emitted from the Mini App when the group-gift-paywall screen opens. props.variant (control | treatment) and props.priceXtr (the Stars price actually shown for this bucket). Denominator for the E24 revenue-per-group-gift-paywall-impression primary metric.',
    sources: ['client'],
    pii: 'none',
  },
  // ── E23 Santa pre-season teaser DM (santa-preseason-dm experiment) ──
  // One DM near Nov 1 to past-Santa / active-owner / social-active users,
  // priming Santa campaign creation once the season opens (Nov 15). The success
  // metric santa.campaign_created already lives in the Santa funnel block above
  // (added by the Secret Santa funnel PR); E23 only adds the DM lifecycle events.
  // See docs/research/experiments/santa-preseason-dm-e23.md.
  {
    name: 'santa_preseason.dm_sent',
    domain: 'santa_preseason',
    action: 'dm_sent',
    description:
      'Pre-season teaser DM delivered to a TREATMENT user by the phased broadcast wave. Server-authoritative — emitted by runPreseasonWave only after Telegram acknowledges delivery (never on a control row, never on a send failure). props: seasonYear, segment (past_santa | social | active_owner).',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'santa_preseason.dm_clicked',
    domain: 'santa_preseason',
    action: 'dm_clicked',
    description:
      'User tapped the teaser DM CTA and the Mini App opened on the spsn_<seasonYear> deep link. Client UI signal — emitted from the Mini App telemetry buffer. Click-through is derived by joining this against santa_preseason.dm_sent on userId+seasonYear. props: seasonYear.',
    sources: ['client'],
    pii: 'none',
  },
  {
    name: 'santa_preseason.muted',
    domain: 'santa_preseason',
    action: 'muted',
    description:
      'User tapped the "🔕 mute" button on the teaser DM. Emitted by the bot callback (sps:<touchId>) via direct AnalyticsEvent write. Drives the >15%-mute kill-switch (the wave stops sending when the settled-cohort mute rate crosses the threshold). props: seasonYear.',
    sources: ['bot'],
    pii: 'userId-only',
  },
] as const satisfies readonly ProductEventDescriptor[];

export type ProductEventName = (typeof PRODUCT_EVENTS)[number]['name'];

const PRODUCT_EVENT_BY_NAME: ReadonlyMap<string, ProductEventDescriptor> = new Map(
  PRODUCT_EVENTS.map((e) => [e.name, e]),
);

const ANALYTICS_EVENTS_SET: ReadonlySet<string> = new Set(ANALYTICS_EVENTS);

/** Typed input for `trackProductEvent`. Compile-time guarantees the name is in
 *  `PRODUCT_EVENTS`. Props remain free-form for now; per-event prop typings can
 *  be added later via TS module augmentation without breaking call-sites. */
export interface ProductEventInput<E extends ProductEventName = ProductEventName> {
  event: E;
  userId?: string;
  props?: Record<string, unknown>;
}

/** True if the name is in either the new PRODUCT_EVENTS registry or the legacy
 *  ANALYTICS_EVENTS allowlist. Use this for read paths that don't care about
 *  source-permissions (e.g. validation in admin dashboards). */
export function isKnownAnalyticsEvent(name: string): boolean {
  return PRODUCT_EVENT_BY_NAME.has(name) || ANALYTICS_EVENTS_SET.has(name);
}

/** True if the name belongs to PRODUCT_EVENTS (new typed taxonomy). */
export function isProductEvent(name: string): name is ProductEventName {
  return PRODUCT_EVENT_BY_NAME.has(name);
}

/** Lookup the descriptor for a PRODUCT_EVENTS entry — used by helpers/tests. */
export function getProductEvent(name: string): ProductEventDescriptor | undefined {
  return PRODUCT_EVENT_BY_NAME.get(name);
}

/** True if `name` is a PRODUCT_EVENTS entry that lists `'client'` among
 *  allowed sources. This is the ONLY check `/tg/telemetry` uses to grant
 *  exact-match acceptance for the new taxonomy. Legacy prefix/exact lists
 *  remain in place for old events. */
export function isClientTelemetryAllowedEvent(name: string): boolean {
  const d = PRODUCT_EVENT_BY_NAME.get(name);
  return !!d && d.sources.includes('client');
}

/** True if `name` is a PRODUCT_EVENTS entry that lists `'server'` among
 *  allowed sources. The backend product-event helper uses this to gate
 *  `trackProductEvent` writes. */
export function isServerProductEvent(name: string): boolean {
  const d = PRODUCT_EVENT_BY_NAME.get(name);
  return !!d && d.sources.includes('server');
}

/** True if `name` is a PRODUCT_EVENTS entry whose `sources` is EXACTLY
 *  `['server']` — no client, no bot. `/tg/telemetry` hard-denies these
 *  before consulting any prefix list, so a serverOnly event in a legacy
 *  prefix-accepted domain (e.g. `payment.`) is still blocked at ingest.
 *  This is the spoof-prevention invariant. */
export function isServerOnlyProductEvent(name: string): boolean {
  const d = PRODUCT_EVENT_BY_NAME.get(name);
  return !!d && d.sources.length === 1 && d.sources[0] === 'server';
}

/** True if `name` is a PRODUCT_EVENTS entry that lists `'bot'` among allowed
 *  sources. Used by the Telegram bot codepath when persisting handler-level
 *  events (start command, callback queries). */
export function isBotProductEvent(name: string): boolean {
  const d = PRODUCT_EVENT_BY_NAME.get(name);
  return !!d && d.sources.includes('bot');
}
