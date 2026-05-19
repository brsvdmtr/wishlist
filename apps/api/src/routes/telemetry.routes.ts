// Telegram-auth router for POST /tg/telemetry (1 handler).
// Mounted via `tgRouter.use(telemetryRouter)` in apps/api/src/index.ts.
//
// Stateless ingestion endpoint — accepts batched analytics events from the
// Mini App, filters by allowlist (prefix + exact), drops unknown events
// per-event (never 400s the whole batch — see header comment below).
//
// Self-contained: zero closure deps. The handler reads `req.tgUser?.id`
// directly via the global Express.Request augmentation declared in
// index.ts. Six helpers (ANALYTICS_EVENT_PREFIXES, ANALYTICS_EVENT_EXACT,
// isAllowedAnalyticsEvent, telemetryEventSchema, telemetryBodySchema,
// telemetryLimiter) live at module scope here — all are
// telemetry-only (verified by grep), so they migrate WITH this file.

import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '@wishlist/db';
import {
  isClientTelemetryAllowedEvent,
  isServerOnlyProductEvent,
} from '@wishlist/shared';

import logger from '../logger';
import { asyncHandler } from '../lib/asyncHandler';

// ── Telemetry ingestion ─────────────────────────────────
// Accept events matching known product-area prefixes + a small exact-match list.
// This keeps a defensive boundary (rejects random junk) while staying resilient to
// frontend additions: a new event with a known prefix flows through without a backend
// deploy. Unknown events are dropped per-event — we never reject the whole batch,
// because Zod all-or-nothing rejection masked ~40 telemetry 400s/day after 2026-04-13.
//
// Server-authoritative events (anything `isServerOnlyProductEvent` in the
// PRODUCT_EVENTS taxonomy — `payment.completed`, `pro.activated`,
// `subscription.renewed`, etc.) are HARD-DENIED first, BEFORE the prefix list
// is consulted. This is the spoof-prevention invariant: even though
// `payment.` is in the legacy prefix list, a client trying to send
// `payment.completed` over `/tg/telemetry` will be silently dropped here. The
// only legitimate writer of those events is the backend itself, via
// `trackProductEvent` in services/analytics.ts.
const ANALYTICS_EVENT_PREFIXES = [
  'miniapp.', 'miniapp_',
  'showcase.', 'public_profile.',
  'onboarding.', 'onboarding_',
  'feature_gate_hit_', 'demo_item_',
  'gift_notes_', 'gift_occasion_',
  'first_share_prompt_', 'ready_share_prompt_',
  'group_gift_', 'addon_', 'category_', 'checkout_',
  'comment_reply_', 'dont_gift_', 'item_',
  'profile_', 'promo_winback_', 'selection_',
  'settings_support_', 'subscription_', 'banner_',
  'wishlist_', 'share_token_',
  'wish.', 'wishlist.', 'import.', 'reservation.',
  'guest.', 'bot.', 'payment.', 'share.',
  'lifecycle_',
];
const ANALYTICS_EVENT_EXACT = new Set<string>([
  'api_server_error', 'pro_cta_clicked', 'error_boundary_triggered',
]);
// Legacy server-authoritative events that live in ANALYTICS_EVENTS (not yet
// migrated to PRODUCT_EVENTS). They MUST be hard-denied at ingest. Today these
// are de-facto blocked because their domain prefix (`referral.`) isn't in
// ANALYTICS_EVENT_PREFIXES — but a future prefix expansion would silently
// re-open the door. Listing them here makes the guarantee explicit and
// independent of prefix-list state.
//
// Migration path: when a legacy event moves into PRODUCT_EVENTS with
// `sources: ['server']`, remove its entry from this set — the typed hard-deny
// (isServerOnlyProductEvent) then takes over.
const LEGACY_SERVER_ONLY_EVENTS = new Set<string>([
  'referral.invitee_converted_to_paid',
]);
export function isAllowedAnalyticsEvent(event: string): boolean {
  if (event.length === 0 || event.length > 80) return false;
  // Hard-deny #1: server-authoritative events from PRODUCT_EVENTS must never
  // enter via `/tg/telemetry`, even if their domain prefix would accept the
  // string. Order matters — this runs BEFORE the prefix and exact lists.
  if (isServerOnlyProductEvent(event)) return false;
  // Hard-deny #2: legacy server-authoritative events not yet in PRODUCT_EVENTS.
  if (LEGACY_SERVER_ONLY_EVENTS.has(event)) return false;
  // Allow: new typed taxonomy events whose `sources` includes `'client'`.
  // This is the only path a NEW domain.action event can pass — no prefix
  // expansion required when adding to PRODUCT_EVENTS.
  if (isClientTelemetryAllowedEvent(event)) return true;
  // Legacy paths — unchanged. Existing frontends keep sending the same names.
  if (ANALYTICS_EVENT_EXACT.has(event)) return true;
  return ANALYTICS_EVENT_PREFIXES.some(p => event.startsWith(p));
}

const telemetryEventSchema = z.object({
  event: z.string().min(1).max(80),
  ts: z.number(),
  props: z.record(z.unknown()).optional(),
});

const telemetryBodySchema = z.object({
  events: z.array(telemetryEventSchema).max(20),
});

const telemetryLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  keyGenerator: (req) => (req as Request & { tgUser?: { id?: number } }).tgUser?.id?.toString() || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
});

export function registerTelemetryRouter(): Router {
  const telemetryRouter = Router();

  telemetryRouter.post('/telemetry', telemetryLimiter, asyncHandler(async (req, res) => {
    const parsed = telemetryBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid telemetry payload', issues: parsed.error.issues });
    }
  
    const userId = req.tgUser?.id ? String(req.tgUser.id) : null;
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
  
    // Per-event filter: drop events that don't match the allowlist rather than
    // rejecting the whole batch. One unknown event used to 400 the entire request
    // and caused silent analytics loss on the frontend (catch {} in flushTelemetry).
    const accepted: typeof parsed.data.events = [];
    const droppedNames: string[] = [];
    for (const ev of parsed.data.events) {
      if (isAllowedAnalyticsEvent(ev.event)) accepted.push(ev);
      else droppedNames.push(ev.event);
    }
    if (droppedNames.length > 0) {
      logger.debug({ dropped: droppedNames, userId }, 'telemetry: dropped unknown events');
    }
  
    const records = accepted.map(ev => {
      // Clamp timestamp to last hour
      const ts = Math.max(oneHourAgo, Math.min(now, ev.ts));
      // Truncate props
      let props: Record<string, unknown> = ev.props || {};
      for (const [key, val] of Object.entries(props)) {
        if (typeof val === 'string' && val.length > 300) {
          props[key] = val.slice(0, 300) + '...';
        }
      }
      const serialized = JSON.stringify(props);
      if (serialized.length > 1024) {
        props = { _truncated: true, event: ev.event };
      }
      return {
        event: ev.event,
        userId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        props: props as any,
        createdAt: new Date(ts),
      };
    });
  
    // Batch insert
    if (records.length > 0) {
      await prisma.analyticsEvent.createMany({ data: records });
    }
  
    return res.json({ ok: true, accepted: records.length, dropped: droppedNames.length });
  }));

  return telemetryRouter;
}
