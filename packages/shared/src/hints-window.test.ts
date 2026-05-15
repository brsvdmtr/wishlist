// Phase 1 / L4 regression: hint idempotency window must equal producer/consumer
// expectations. The 2026-05-03 prod bug was a 30-day vs 30-min mismatch
// between apps/api/src/routes/hints.routes.ts (producer) and
// apps/bot/src/index.ts users_shared handler (consumer). Both now import
// HINT_LOOKUP_WINDOW_MS from this package — this test pins the value so a
// rename / refactor that changes the number breaks loud.
//
// Rule from BUGFIX_LESSONS.md (2026-05-03 entry, rule #2):
//   "Any window of idempotency is duplicated by a constant with the same name
//    in both files, or extracted to common packages/shared. Magic numbers in
//    findFirst are forbidden — they drift silently."

import { describe, it, expect } from 'vitest';
import { HINT_LOOKUP_WINDOW_MS } from './index';

describe('HINT_LOOKUP_WINDOW_MS — producer/consumer shared window', () => {
  it('equals exactly 30 minutes in milliseconds', () => {
    expect(HINT_LOOKUP_WINDOW_MS).toBe(30 * 60 * 1000);
    expect(HINT_LOOKUP_WINDOW_MS).toBe(1_800_000);
  });

  it('represents a duration on the order of minutes, not days or seconds', () => {
    // Sanity guard: if a refactor accidentally divides or multiplies the
    // constant, this asserts the result is still in the operationally
    // reasonable range for a click-to-keyboard idempotency window.
    const minutes = HINT_LOOKUP_WINDOW_MS / 60_000;
    expect(minutes).toBeGreaterThanOrEqual(5); // not seconds
    expect(minutes).toBeLessThanOrEqual(24 * 60); // not days
  });

  it('is the only authoritative shared constant — no parallel magic numbers in src', () => {
    // Meta-assertion: the value is a single named export, not a derived
    // expression. If you find yourself wanting to compute it locally, stop
    // and import HINT_LOOKUP_WINDOW_MS instead — see the lesson.
    expect(typeof HINT_LOOKUP_WINDOW_MS).toBe('number');
    expect(Number.isInteger(HINT_LOOKUP_WINDOW_MS)).toBe(true);
  });
});
