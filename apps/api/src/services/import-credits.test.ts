// Unit tests for the pure layer of services/import-credits.ts — the monthly
// free URL-import quota math. The DB-backed paths (getImportAllowance for a
// FREE user, consumeImportCredit) are covered by the real-Postgres suite in
// apps/api/test/integration/import-credits.test.ts.

import { describe, it, expect, vi } from 'vitest';

// Pure helpers never touch the client; the PRO branch of getImportAllowance
// short-circuits before any query. A bare stub keeps the module loadable.
vi.mock('@wishlist/db', () => ({ prisma: {} }));

import {
  FREE_IMPORT_QUOTA_PER_MONTH,
  currentImportPeriod,
  resolveFreeImports,
  getImportAllowance,
} from './import-credits';

describe('currentImportPeriod', () => {
  it('formats a zero-padded UTC year-month bucket', () => {
    expect(currentImportPeriod(new Date('2026-05-15T12:00:00Z'))).toBe('2026-05');
    expect(currentImportPeriod(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
    expect(currentImportPeriod(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
  });

  it('buckets by UTC regardless of the runner timezone', () => {
    expect(currentImportPeriod(new Date('2026-06-01T00:30:00Z'))).toBe('2026-06');
  });
});

describe('resolveFreeImports', () => {
  const now = new Date('2026-05-15T00:00:00Z'); // period "2026-05"

  it('treats a missing UserCredits row as a fresh full allowance', () => {
    const r = resolveFreeImports(null, now);
    expect(r.freeLimit).toBe(FREE_IMPORT_QUOTA_PER_MONTH);
    expect(r.freeUsed).toBe(0);
    expect(r.freeRemaining).toBe(FREE_IMPORT_QUOTA_PER_MONTH);
  });

  it('counts usage when the stored period is the current month', () => {
    const r = resolveFreeImports({ freeImportsUsed: 2, freeImportsPeriod: '2026-05' }, now);
    expect(r.freeUsed).toBe(2);
    expect(r.freeRemaining).toBe(FREE_IMPORT_QUOTA_PER_MONTH - 2);
  });

  it('lazily resets a stale month to zero used', () => {
    const r = resolveFreeImports({ freeImportsUsed: 5, freeImportsPeriod: '2026-04' }, now);
    expect(r.freeUsed).toBe(0);
    expect(r.freeRemaining).toBe(FREE_IMPORT_QUOTA_PER_MONTH);
  });

  it('treats a null period as stale (never consumed)', () => {
    const r = resolveFreeImports({ freeImportsUsed: 3, freeImportsPeriod: null }, now);
    expect(r.freeUsed).toBe(0);
    expect(r.freeRemaining).toBe(FREE_IMPORT_QUOTA_PER_MONTH);
  });

  it('clamps an over-quota counter so remaining never goes negative', () => {
    const r = resolveFreeImports({ freeImportsUsed: 99, freeImportsPeriod: '2026-05' }, now);
    expect(r.freeUsed).toBe(FREE_IMPORT_QUOTA_PER_MONTH);
    expect(r.freeRemaining).toBe(0);
  });
});

describe('getImportAllowance — PRO short-circuit (no DB access)', () => {
  it('always allows a PRO user with source=pro', async () => {
    const a = await getImportAllowance('pro-user', true);
    expect(a.allowed).toBe(true);
    expect(a.isPro).toBe(true);
    expect(a.source).toBe('pro');
    expect(a.freeRemaining).toBe(FREE_IMPORT_QUOTA_PER_MONTH);
  });
});

describe('FREE_IMPORT_QUOTA_PER_MONTH', () => {
  it('defaults to 5 imports per month when the env var is unset', () => {
    expect(FREE_IMPORT_QUOTA_PER_MONTH).toBe(5);
  });
});
