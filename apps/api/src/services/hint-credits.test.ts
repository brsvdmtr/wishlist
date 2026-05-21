// Unit tests for the pure layer of services/hint-credits.ts — the monthly
// free-hint quota math. The DB-backed paths (consumeHintCharge, the FREE
// branch of getHintAllowance) are covered by the real-Postgres suite in
// apps/api/test/integration/hint-credits.test.ts.

import { describe, it, expect, vi } from 'vitest';

// Pure helpers never touch the client; the PRO branch of getHintAllowance
// short-circuits before any query. A bare stub keeps the module loadable.
vi.mock('@wishlist/db', () => ({ prisma: {} }));

import {
  FREE_HINT_QUOTA_PER_MONTH,
  currentHintPeriod,
  resolveFreeHints,
  getHintAllowance,
} from './hint-credits';

describe('FREE_HINT_QUOTA_PER_MONTH', () => {
  it('defaults to 3 hints per month when the env var is unset', () => {
    expect(FREE_HINT_QUOTA_PER_MONTH).toBe(3);
  });
});

describe('currentHintPeriod', () => {
  it('formats a zero-padded UTC year-month bucket', () => {
    expect(currentHintPeriod(new Date('2026-05-21T12:00:00Z'))).toBe('2026-05');
    expect(currentHintPeriod(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
    expect(currentHintPeriod(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
  });
});

describe('resolveFreeHints', () => {
  it('a zero count is a full allowance', () => {
    const r = resolveFreeHints(0);
    expect(r.freeLimit).toBe(FREE_HINT_QUOTA_PER_MONTH);
    expect(r.freeUsed).toBe(0);
    expect(r.freeRemaining).toBe(FREE_HINT_QUOTA_PER_MONTH);
  });

  it('counts partial usage', () => {
    const r = resolveFreeHints(2);
    expect(r.freeUsed).toBe(2);
    expect(r.freeRemaining).toBe(FREE_HINT_QUOTA_PER_MONTH - 2);
  });

  it('clamps an over-quota count so remaining never goes negative', () => {
    const r = resolveFreeHints(99);
    expect(r.freeUsed).toBe(FREE_HINT_QUOTA_PER_MONTH);
    expect(r.freeRemaining).toBe(0);
  });

  it('clamps a negative count to zero used', () => {
    const r = resolveFreeHints(-5);
    expect(r.freeUsed).toBe(0);
    expect(r.freeRemaining).toBe(FREE_HINT_QUOTA_PER_MONTH);
  });
});

describe('getHintAllowance — PRO short-circuit (no DB access)', () => {
  it('always allows a PRO user with source=pro', async () => {
    const a = await getHintAllowance('pro-user', true);
    expect(a.allowed).toBe(true);
    expect(a.isPro).toBe(true);
    expect(a.source).toBe('pro');
    expect(a.freeRemaining).toBe(FREE_HINT_QUOTA_PER_MONTH);
    expect(a.paidCredits).toBe(0);
  });
});

describe('FREE_HINT_QUOTA_PER_MONTH = 0 — free tier disabled', () => {
  it('a zero env quota collapses the free allowance to nothing', async () => {
    // The quota constant is read once at module load, so exercise the kill
    // switch by re-importing the module under a stubbed env.
    vi.resetModules();
    vi.stubEnv('FREE_HINT_QUOTA_PER_MONTH', '0');
    const mod = await import('./hint-credits');

    expect(mod.FREE_HINT_QUOTA_PER_MONTH).toBe(0);
    // resolveFreeHints can never report remaining quota when the tier is off.
    expect(mod.resolveFreeHints(0)).toEqual({ freeLimit: 0, freeUsed: 0, freeRemaining: 0 });
    expect(mod.resolveFreeHints(5)).toEqual({ freeLimit: 0, freeUsed: 0, freeRemaining: 0 });
    // PRO stays unlimited regardless of the free tier being disabled.
    const pro = await mod.getHintAllowance('pro-user', true);
    expect(pro.allowed).toBe(true);
    expect(pro.source).toBe('pro');

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
