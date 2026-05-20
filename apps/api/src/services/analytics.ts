// Analytics layer (P5s-5 — extracted from apps/api/src/index.ts).
//
// Three pure stateless helpers that wrap `prisma.analyticsEvent.create(...)`.
// Every one runs props through `sanitizeAnalyticsProps` (from `@wishlist/shared`)
// before persisting — that helper drops user-content keys (item titles,
// descriptions, comment / hint bodies, search text, freeform notes) and
// truncates oversized values. See docs/research/analytics-pii-audit.md.
//
//   - `trackEvent(event, userId?, props?)` — LEGACY. Logs every call
//     (`logger.info`, with already-sanitized props) and conditionally
//     persists to `AnalyticsEvent` for events whose name matches the in-body
//     prefix allowlist (feature_gate_hit_, onboarding_, demo_item_, gift_,
//     first_share_prompt_, ready_share_prompt_, group_gift_, secret_res.,
//     showcase., public_profile., error:). Persistence requires `userId`.
//
//   - `trackAnalyticsEvent({ event, userId?, props? })` — LEGACY. Checks the
//     `ANALYTICS_EVENTS` allowlist from `@wishlist/shared`, sanitizes props,
//     then persists. Silently drops events not in the allowlist.
//
//   - `trackProductEvent({ event, userId?, props? })` — NEW typed entry point
//     for the unified `domain.action` taxonomy in `PRODUCT_EVENTS`. The
//     `event` parameter is statically constrained to `ProductEventName`, so
//     a typo or undeclared event name fails the build. Use this for any new
//     product event going forward; see `docs/analytics-events.md` for the
//     adoption rules. Server-authoritative events (`payment.completed`,
//     `pro.activated`, `subscription.*`, `user.signup`, `guest.converted_to_user`)
//     MUST be written via this helper from backend code — `/tg/telemetry`
//     hard-denies them on ingest, so a client cannot spoof them.
//
// All three are fire-and-forget: Prisma write errors are swallowed via
// `.catch(...)` and logged at debug level. There is **no in-memory
// buffer, no flush timer, no shutdown drain** — every call is an
// independent atomic Prisma promise. This is intentional: each event
// is either persisted or lost in isolation, and the catch-handler
// downgrades any DB hiccup to a debug-log line so request paths never
// fail because of analytics back-pressure.

import { prisma } from '@wishlist/db';
import {
  ANALYTICS_EVENTS,
  isProductEvent,
  sanitizeAnalyticsProps,
  type ProductEventInput,
  type ProductEventName,
} from '@wishlist/shared';
import logger from '../logger';

// Allowlist sourced from @wishlist/shared so API + frontend + any other
// consumer stay in sync. Adding a new event: add it to packages/shared/src/
// analyticsEvents.ts and rebuild shared. Events not in this set are silently
// dropped — gate intentionally keeps the AnalyticsEvent table schemaful.
const ANALYTICS_EVENTS_SET = new Set<string>(ANALYTICS_EVENTS);

export function trackEvent(event: string, userId?: string, props?: Record<string, unknown>) {
  // Sanitize once — the log line and the DB write must never carry user content.
  const sanitized = sanitizeAnalyticsProps(props);
  logger.info({ event, userId, props: sanitized }, 'analytics event');
  // Persist to DB for god-mode analytics: feature gate hits, onboarding, demo item, and error events.
  // Fire-and-forget — never blocks the request path.
  const shouldPersist =
    event.startsWith('feature_gate_hit_') ||
    event.startsWith('onboarding_') ||
    event.startsWith('demo_item_') ||
    event.startsWith('gift_') ||
    event.startsWith('first_share_prompt_') ||
    event.startsWith('ready_share_prompt_') ||
    event.startsWith('group_gift_') ||
    event.startsWith('secret_res.') ||
    event.startsWith('showcase.') ||
    event.startsWith('public_profile.') ||
    event.startsWith('error:');
  if (shouldPersist && userId) {
    prisma.analyticsEvent
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .create({ data: { event, userId, props: sanitized ? (sanitized as any) : undefined } })
      .catch((e) => logger.debug({ err: e, event }, 'analytics write failed'));
  }
}

export function trackAnalyticsEvent(params: {
  event: string;
  userId?: string;
  props?: Record<string, unknown>;
}): void {
  if (!ANALYTICS_EVENTS_SET.has(params.event)) return;
  const props = sanitizeAnalyticsProps(params.props);
  prisma.analyticsEvent.create({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { event: params.event, userId: params.userId ?? null, props: props ? (props as any) : undefined },
  }).catch((e) => logger.debug({ err: e, event: params.event }, 'analytics write failed'));
}

// Typed entry point for the new PRODUCT_EVENTS taxonomy. The event name is
// constrained at compile time, so undeclared names fail typecheck — this is
// the foundation referenced in CLAUDE.md's analytics rule "new events must be
// typed". Runtime allowlist check is a defense-in-depth pass for callers that
// reach this through `any`-typed dispatch.
//
// IMPORTANT — server-authoritative events: this helper accepts ANY product
// event regardless of source classification, because backend code is the
// trusted producer for server/bot events. The HARD-DENY for client-spoofed
// server events lives in `/tg/telemetry` (see telemetry.routes.ts) — that's
// the network boundary, not this helper.
export function trackProductEvent<E extends ProductEventName>(
  input: ProductEventInput<E>,
): void {
  if (!isProductEvent(input.event)) return;
  const props = sanitizeAnalyticsProps(input.props);
  prisma.analyticsEvent
    .create({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { event: input.event, userId: input.userId ?? null, props: props ? (props as any) : undefined },
    })
    .catch((e) => logger.debug({ err: e, event: input.event }, 'analytics write failed'));
}
