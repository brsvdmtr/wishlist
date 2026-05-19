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
      'Successful Telegram Stars payment confirmed by the server. Authoritative input for revenue dashboards. NEVER trust a client-side mirror of this.',
    sources: ['server'],
    pii: 'userId-only',
  },
  {
    name: 'pro.activated',
    domain: 'pro',
    action: 'activated',
    description:
      'Pro entitlement granted (paid purchase, lifetime, referral reward, or admin grant). Server emits at the moment the entitlement row is written.',
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
  // ── Paywall UI (client-allowed) ──
  {
    name: 'paywall.viewed',
    domain: 'paywall',
    action: 'viewed',
    description:
      'Paywall sheet rendered to the user. UI impression — emitted from the Mini App.',
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
