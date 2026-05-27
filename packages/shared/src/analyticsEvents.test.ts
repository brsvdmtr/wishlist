// Unit tests + invariants for the analytics event registry.
//
// Two registries live in `analyticsEvents.ts`:
//   1. `ANALYTICS_EVENTS` — frozen legacy allowlist. Dashboards reference these
//      exact strings; do not modify. We assert the array remains non-empty and
//      contains a couple of canary names.
//   2. `PRODUCT_EVENTS` — new typed taxonomy in `domain.action` form with
//      source permissions. We enforce name shape, segment alignment, source
//      validity, and the no-duplicates invariant via these tests.
//
// The taxonomy snapshot (last block) is a stable fixture: any change to the
// list of new product events must touch the snapshot, making review explicit.

import { describe, it, expect } from 'vitest';
import {
  ANALYTICS_EVENTS,
  PRODUCT_EVENTS,
  getProductEvent,
  isBotProductEvent,
  isClientTelemetryAllowedEvent,
  isKnownAnalyticsEvent,
  isProductEvent,
  isServerOnlyProductEvent,
  isServerProductEvent,
  type ProductEventDescriptor,
  type ProductEventSource,
} from './analyticsEvents';

const NAME_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const VALID_SOURCES: ReadonlySet<ProductEventSource> = new Set(['server', 'client', 'bot']);
const VALID_PII: ReadonlySet<ProductEventDescriptor['pii']> = new Set([
  'none',
  'hashed',
  'userId-only',
]);

describe('ANALYTICS_EVENTS (legacy, frozen)', () => {
  it('remains non-empty', () => {
    expect(ANALYTICS_EVENTS.length).toBeGreaterThan(0);
  });

  it('keeps the canary events that production dashboards depend on', () => {
    // If any of these get removed, downstream dashboards silently break.
    const canaries = [
      'wishlist.created',
      'wish.created',
      'reservation.succeeded',
      'subscription.cancelled',
      'payment.pre_checkout_rejected',
      'bot.start_received',
    ];
    for (const c of canaries) {
      expect(ANALYTICS_EVENTS).toContain(c);
    }
  });
});

describe('PRODUCT_EVENTS — descriptor invariants', () => {
  it('is non-empty', () => {
    expect(PRODUCT_EVENTS.length).toBeGreaterThan(0);
  });

  it.each(PRODUCT_EVENTS.map((e) => [e.name, e] as const))(
    '[%s] descriptor shape is valid',
    (_name, ev) => {
      expect(NAME_PATTERN.test(ev.name)).toBe(true);
      const [domainSeg, actionSeg] = ev.name.split('.');
      expect(ev.domain).toBe(domainSeg);
      expect(ev.action).toBe(actionSeg);
      expect(ev.description.length).toBeGreaterThan(10);
      expect(ev.sources.length).toBeGreaterThan(0);
      for (const s of ev.sources) {
        expect(VALID_SOURCES.has(s)).toBe(true);
      }
      expect(VALID_PII.has(ev.pii)).toBe(true);
    },
  );

  it('has no duplicate names within PRODUCT_EVENTS', () => {
    const names = PRODUCT_EVENTS.map((e) => e.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('shares no names with the legacy ANALYTICS_EVENTS allowlist', () => {
    const legacy = new Set<string>(ANALYTICS_EVENTS);
    const overlap = PRODUCT_EVENTS.filter((e) => legacy.has(e.name)).map((e) => e.name);
    expect(overlap).toEqual([]);
  });
});

describe('PRODUCT_EVENTS — required P0 taxonomy entries', () => {
  // These are the events called out in docs/analytics-events.md as the
  // foundation. If any of them disappears, the foundation is broken — fail
  // loudly rather than silently lose a security-critical descriptor.
  const requiredServerOnly = [
    'payment.completed',
    'pro.activated',
    'subscription.renewed',
    'subscription.expired',
    'user.signup',
    'guest.converted_to_user',
  ];
  const requiredClientAllowed = [
    'paywall.viewed',
    'paywall.cta_clicked',
    'wishlist.shared',
    'user.session_started',
  ];

  it.each(requiredServerOnly)('%s exists and is serverOnly', (name) => {
    const d = getProductEvent(name);
    expect(d).toBeDefined();
    expect(d!.sources).toEqual(['server']);
    expect(isServerOnlyProductEvent(name)).toBe(true);
    expect(isClientTelemetryAllowedEvent(name)).toBe(false);
  });

  it.each(requiredClientAllowed)('%s exists and is clientAllowed', (name) => {
    const d = getProductEvent(name);
    expect(d).toBeDefined();
    expect(d!.sources).toContain('client');
    expect(isClientTelemetryAllowedEvent(name)).toBe(true);
    expect(isServerOnlyProductEvent(name)).toBe(false);
  });
});

describe('helper functions — happy + edge cases', () => {
  it('isProductEvent: true for product events, false for legacy or random', () => {
    expect(isProductEvent('paywall.viewed')).toBe(true);
    expect(isProductEvent('payment.completed')).toBe(true);
    expect(isProductEvent('wishlist.created')).toBe(false); // legacy
    expect(isProductEvent('definitely_not_real_xyz')).toBe(false);
  });

  it('isKnownAnalyticsEvent: true for both PRODUCT_EVENTS and ANALYTICS_EVENTS', () => {
    expect(isKnownAnalyticsEvent('paywall.viewed')).toBe(true); // new
    expect(isKnownAnalyticsEvent('wishlist.created')).toBe(true); // legacy
    expect(isKnownAnalyticsEvent('not_in_any_list_xyz')).toBe(false);
  });

  it('isClientTelemetryAllowedEvent: only true for events with `client` in sources', () => {
    expect(isClientTelemetryAllowedEvent('paywall.viewed')).toBe(true);
    expect(isClientTelemetryAllowedEvent('payment.completed')).toBe(false);
    expect(isClientTelemetryAllowedEvent('wishlist.created')).toBe(false); // legacy, not in PRODUCT_EVENTS
    expect(isClientTelemetryAllowedEvent('unknown_xyz')).toBe(false);
  });

  // Pins the contract for the `pro_cancel.*` anti-churn funnel. The `pro_cancel.`
  // prefix is NOT in ANALYTICS_EVENT_PREFIXES (apps/api/src/routes/telemetry.routes.ts),
  // so these events reach AnalyticsEvent ONLY via `isClientTelemetryAllowedEvent`.
  // If a future PR tightens the allowlist or drops these from PRODUCT_EVENTS,
  // /tg/telemetry will silently start dropping the entire cancel funnel — this
  // test forces a visible failure first.
  it('pro_cancel.* funnel events are client-telemetry allowed', () => {
    expect(isClientTelemetryAllowedEvent('pro_cancel.sheet_viewed')).toBe(true);
    expect(isClientTelemetryAllowedEvent('pro_cancel.keep_clicked')).toBe(true);
    expect(isClientTelemetryAllowedEvent('pro_cancel.confirmed')).toBe(true);
  });

  it('isServerProductEvent: true if `server` is among sources (incl. multi-source)', () => {
    expect(isServerProductEvent('payment.completed')).toBe(true);
    expect(isServerProductEvent('paywall.viewed')).toBe(false);
    expect(isServerProductEvent('unknown_xyz')).toBe(false);
  });

  it('isServerOnlyProductEvent: true ONLY when sources is exactly [`server`]', () => {
    expect(isServerOnlyProductEvent('payment.completed')).toBe(true);
    expect(isServerOnlyProductEvent('pro.activated')).toBe(true);
    expect(isServerOnlyProductEvent('paywall.viewed')).toBe(false);
    expect(isServerOnlyProductEvent('unknown_xyz')).toBe(false);
  });

  it('isBotProductEvent: false for current taxonomy (no bot-only entries yet)', () => {
    // No PRODUCT_EVENTS entry currently lists `bot` as a source — the bot
    // signal `bot.start_received` lives in legacy ANALYTICS_EVENTS.
    expect(isBotProductEvent('bot.start_received')).toBe(false);
    expect(isBotProductEvent('paywall.viewed')).toBe(false);
  });

  it('getProductEvent: returns undefined for unknown, descriptor for known', () => {
    expect(getProductEvent('definitely_not_real')).toBeUndefined();
    const d = getProductEvent('paywall.viewed');
    expect(d?.name).toBe('paywall.viewed');
    expect(d?.domain).toBe('paywall');
    expect(d?.action).toBe('viewed');
  });
});

describe('PRODUCT_EVENTS — fixture snapshot', () => {
  // Stable shape snapshot. Any change to the new-event registry should be a
  // deliberate descriptor edit visible in diff. The snapshot keys are sorted
  // by name to make diffs minimal when an event is added between siblings.
  it('matches the known taxonomy fixture (sorted by name)', () => {
    const fixture = PRODUCT_EVENTS.map((e) => ({
      name: e.name,
      domain: e.domain,
      action: e.action,
      sources: [...e.sources].sort(),
      pii: e.pii,
    })).sort((a, b) => a.name.localeCompare(b.name));

    expect(fixture).toMatchInlineSnapshot(`
      [
        {
          "action": "assigned",
          "domain": "experiment",
          "name": "experiment.assigned",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "clicked",
          "domain": "guest_owner_cta",
          "name": "guest_owner_cta.clicked",
          "pii": "none",
          "sources": [
            "client",
          ],
        },
        {
          "action": "dismissed",
          "domain": "guest_owner_cta",
          "name": "guest_owner_cta.dismissed",
          "pii": "none",
          "sources": [
            "client",
          ],
        },
        {
          "action": "shown",
          "domain": "guest_owner_cta",
          "name": "guest_owner_cta.shown",
          "pii": "none",
          "sources": [
            "client",
          ],
        },
        {
          "action": "converted_to_user",
          "domain": "guest",
          "name": "guest.converted_to_user",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "free_quota_charge_skipped",
          "domain": "hint",
          "name": "hint.free_quota_charge_skipped",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "free_quota_charged",
          "domain": "hint",
          "name": "hint.free_quota_charged",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "free_quota_exhausted",
          "domain": "hint",
          "name": "hint.free_quota_exhausted",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "pack_suggested",
          "domain": "hint",
          "name": "hint.pack_suggested",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "completed",
          "domain": "payment",
          "name": "payment.completed",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "cta_clicked",
          "domain": "paywall",
          "name": "paywall.cta_clicked",
          "pii": "none",
          "sources": [
            "client",
          ],
        },
        {
          "action": "viewed",
          "domain": "paywall",
          "name": "paywall.viewed",
          "pii": "none",
          "sources": [
            "client",
          ],
        },
        {
          "action": "confirmed",
          "domain": "pro_cancel",
          "name": "pro_cancel.confirmed",
          "pii": "none",
          "sources": [
            "client",
          ],
        },
        {
          "action": "keep_clicked",
          "domain": "pro_cancel",
          "name": "pro_cancel.keep_clicked",
          "pii": "none",
          "sources": [
            "client",
          ],
        },
        {
          "action": "sheet_viewed",
          "domain": "pro_cancel",
          "name": "pro_cancel.sheet_viewed",
          "pii": "none",
          "sources": [
            "client",
          ],
        },
        {
          "action": "activated",
          "domain": "pro",
          "name": "pro.activated",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "gate_hit",
          "domain": "santa",
          "name": "santa.gate_hit",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "paywall_cta_clicked",
          "domain": "santa",
          "name": "santa.paywall_cta_clicked",
          "pii": "none",
          "sources": [
            "client",
          ],
        },
        {
          "action": "paywall_viewed",
          "domain": "santa",
          "name": "santa.paywall_viewed",
          "pii": "none",
          "sources": [
            "client",
          ],
        },
        {
          "action": "expired",
          "domain": "subscription",
          "name": "subscription.expired",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "renewed",
          "domain": "subscription",
          "name": "subscription.renewed",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "completed",
          "domain": "survey",
          "name": "survey.completed",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "dismissed",
          "domain": "survey",
          "name": "survey.dismissed",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "invite_failed",
          "domain": "survey",
          "name": "survey.invite_failed",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "invite_sent",
          "domain": "survey",
          "name": "survey.invite_sent",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "opened",
          "domain": "survey",
          "name": "survey.opened",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "question_answered",
          "domain": "survey",
          "name": "survey.question_answered",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "started",
          "domain": "survey",
          "name": "survey.started",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "session_started",
          "domain": "user",
          "name": "user.session_started",
          "pii": "none",
          "sources": [
            "client",
          ],
        },
        {
          "action": "signup",
          "domain": "user",
          "name": "user.signup",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "default_created",
          "domain": "wishlist",
          "name": "wishlist.default_created",
          "pii": "userId-only",
          "sources": [
            "server",
          ],
        },
        {
          "action": "shared",
          "domain": "wishlist",
          "name": "wishlist.shared",
          "pii": "none",
          "sources": [
            "client",
          ],
        },
      ]
    `);
  });
});
