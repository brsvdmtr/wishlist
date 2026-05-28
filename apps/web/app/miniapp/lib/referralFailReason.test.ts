import { describe, it, expect } from 'vitest';
import { inferReferralLoadFailReason } from './referralFailReason';

describe('inferReferralLoadFailReason', () => {
  it('undefined status (network/parse throw) → fetch_error', () => {
    expect(inferReferralLoadFailReason(undefined)).toBe('fetch_error');
  });

  it('401 → unauthorized (initData expired / not yet ready)', () => {
    expect(inferReferralLoadFailReason(401)).toBe('unauthorized');
  });

  it('403 → forbidden (rate limit / blocked)', () => {
    expect(inferReferralLoadFailReason(403)).toBe('forbidden');
  });

  it('500 → server_error', () => {
    expect(inferReferralLoadFailReason(500)).toBe('server_error');
  });

  it('502 → server_error (covers any 5xx)', () => {
    expect(inferReferralLoadFailReason(502)).toBe('server_error');
  });

  it('429 → client_error (rate-limit not at 403)', () => {
    expect(inferReferralLoadFailReason(429)).toBe('client_error');
  });

  it('400 → client_error', () => {
    expect(inferReferralLoadFailReason(400)).toBe('client_error');
  });

  it('200 (defensive — caller shouldn\'t invoke on ok) → fetch_error fallback', () => {
    expect(inferReferralLoadFailReason(200)).toBe('fetch_error');
  });
});
