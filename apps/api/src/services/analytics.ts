// Analytics layer (P5s-5 — extracted from apps/api/src/index.ts).
//
// Two pure stateless helpers that wrap `prisma.analyticsEvent.create(...)`:
//
//   - `trackEvent(event, userId?, props?)` — logs every call (`logger.info`)
//     and conditionally persists to `AnalyticsEvent` for events whose
//     name matches the in-body prefix allowlist (feature_gate_hit_,
//     onboarding_, demo_item_, gift_, first_share_prompt_,
//     ready_share_prompt_, group_gift_, secret_res., showcase.,
//     public_profile., error:). Persistence requires `userId`.
//
//   - `trackAnalyticsEvent({ event, userId?, props? })` — checks the
//     `ANALYTICS_EVENTS` allowlist from `@wishlist/shared`, applies
//     per-string truncation to props (300 chars) plus a 1024-byte total
//     cap (replaces with `{ _truncated: true }` if exceeded), then
//     persists. Silently drops events not in the allowlist.
//
// Both are fire-and-forget: Prisma write errors are swallowed via
// `.catch(...)` and logged at debug level. There is **no in-memory
// buffer, no flush timer, no shutdown drain** — every call is an
// independent atomic Prisma promise. This is intentional: each event
// is either persisted or lost in isolation, and the catch-handler
// downgrades any DB hiccup to a debug-log line so request paths never
// fail because of analytics back-pressure.
//
// Bodies are byte-identical to their previous in-place definitions in
// index.ts (lines 301–323 + 331 + 333–352).
//
// Strategy A: source moves here; routes/schedulers/services continue
// receiving these via existing factory deps — signatures unchanged.
// Index.ts imports both functions and continues threading them through
// the 21 register*Router/start*Scheduler factory call-sites.

import { prisma } from '@wishlist/db';
import { ANALYTICS_EVENTS } from '@wishlist/shared';
import logger from '../logger';

// Allowlist sourced from @wishlist/shared so API + frontend + any other
// consumer stay in sync. Adding a new event: add it to packages/shared/src/
// analyticsEvents.ts and rebuild shared. Events not in this set are silently
// dropped — gate intentionally keeps the AnalyticsEvent table schemaful.
const ANALYTICS_EVENTS_SET = new Set<string>(ANALYTICS_EVENTS);

export function trackEvent(event: string, userId?: string, props?: Record<string, unknown>) {
  logger.info({ event, userId, props }, 'analytics event');
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
      .create({ data: { event, userId, props: props ? (props as any) : undefined } })
      .catch((e) => logger.debug({ err: e, event }, 'analytics write failed'));
  }
}

export function trackAnalyticsEvent(params: {
  event: string;
  userId?: string;
  props?: Record<string, unknown>;
}): void {
  if (!ANALYTICS_EVENTS_SET.has(params.event)) return;
  let props = params.props;
  if (props) {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      cleaned[k] = typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '...' : v;
    }
    const ser = JSON.stringify(cleaned);
    props = ser.length > 1024 ? { _truncated: true } : cleaned;
  }
  prisma.analyticsEvent.create({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { event: params.event, userId: params.userId ?? null, props: props ? (props as any) : undefined },
  }).catch((e) => logger.debug({ err: e, event: params.event }, 'analytics write failed'));
}
