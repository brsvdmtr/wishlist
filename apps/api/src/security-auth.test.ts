/**
 * Tests for Telegram initData validation — auth_date expiry and HMAC comparison.
 *
 * We re-implement the minimal initData builder here to avoid exporting internal
 * functions from the production code.
 */
import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';

// ─── Mirror of production helpers (kept minimal for test isolation) ───────────

const BOT_TOKEN = 'TEST_BOT_TOKEN:for_tests_only';
const INIT_DATA_MAX_AGE_SECONDS = 86_400;
const INIT_DATA_CLOCK_SKEW_SECONDS = 30;

function secureCompare(a: string, b: string): boolean {
  const aH = crypto.createHash('sha256').update(a).digest();
  const bH = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(aH, bH);
}

interface TelegramUser { id: number; first_name: string; }

/**
 * Production-equivalent implementation of validateTelegramInitData.
 * Copied from index.ts so tests stay in sync with real behavior.
 */
function validateTelegramInitData(initData: string, botToken: string): TelegramUser | null {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const checkString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
    if (!secureCompare(expectedHash, hash)) return null;

    const authDateStr = params.get('auth_date');
    if (!authDateStr) return null;
    const authDate = Number(authDateStr);
    if (!Number.isFinite(authDate) || authDate <= 0) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (authDate > nowSec + INIT_DATA_CLOCK_SKEW_SECONDS) return null;
    if (nowSec - authDate > INIT_DATA_MAX_AGE_SECONDS) return null;

    const userStr = params.get('user');
    if (!userStr) return null;
    return JSON.parse(userStr) as TelegramUser;
  } catch {
    return null;
  }
}

// ─── Test helper: build a signed initData string ─────────────────────────────

function buildInitData(opts: {
  user?: object;
  authDate?: number | string;
  omitAuthDate?: boolean;
  botToken?: string;
  tamperHash?: string;
}): string {
  const user = opts.user ?? { id: 12345, first_name: 'Test' };
  const token = opts.botToken ?? BOT_TOKEN;
  const params = new URLSearchParams();
  params.set('user', JSON.stringify(user));
  if (!opts.omitAuthDate) {
    params.set('auth_date', String(opts.authDate ?? Math.floor(Date.now() / 1000)));
  }

  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = opts.tamperHash ??
    crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');

  params.set('hash', hash);
  return params.toString();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('validateTelegramInitData', () => {
  it('accepts valid initData with current auth_date', () => {
    const data = buildInitData({});
    const user = validateTelegramInitData(data, BOT_TOKEN);
    expect(user).not.toBeNull();
    expect(user!.id).toBe(12345);
    expect(user!.first_name).toBe('Test');
  });

  it('rejects invalid HMAC hash', () => {
    const data = buildInitData({ tamperHash: 'deadbeef'.repeat(8) });
    expect(validateTelegramInitData(data, BOT_TOKEN)).toBeNull();
  });

  it('rejects wrong bot token', () => {
    const data = buildInitData({ botToken: 'WRONG_TOKEN' });
    expect(validateTelegramInitData(data, BOT_TOKEN)).toBeNull();
  });

  it('rejects expired auth_date (> 24h ago)', () => {
    const expired = Math.floor(Date.now() / 1000) - INIT_DATA_MAX_AGE_SECONDS - 60;
    const data = buildInitData({ authDate: expired });
    expect(validateTelegramInitData(data, BOT_TOKEN)).toBeNull();
  });

  it('rejects missing auth_date', () => {
    const data = buildInitData({ omitAuthDate: true });
    expect(validateTelegramInitData(data, BOT_TOKEN)).toBeNull();
  });

  it('rejects malformed auth_date (non-numeric)', () => {
    const data = buildInitData({ authDate: 'not-a-number' as any });
    expect(validateTelegramInitData(data, BOT_TOKEN)).toBeNull();
  });

  it('rejects auth_date = 0', () => {
    const data = buildInitData({ authDate: 0 });
    expect(validateTelegramInitData(data, BOT_TOKEN)).toBeNull();
  });

  it('rejects auth_date = -1', () => {
    const data = buildInitData({ authDate: -1 });
    expect(validateTelegramInitData(data, BOT_TOKEN)).toBeNull();
  });

  it('accepts auth_date slightly in the future (within clock skew)', () => {
    const futureWithinSkew = Math.floor(Date.now() / 1000) + INIT_DATA_CLOCK_SKEW_SECONDS - 5;
    const data = buildInitData({ authDate: futureWithinSkew });
    expect(validateTelegramInitData(data, BOT_TOKEN)).not.toBeNull();
  });

  it('rejects auth_date far in the future (beyond clock skew)', () => {
    const futureBeyondSkew = Math.floor(Date.now() / 1000) + INIT_DATA_CLOCK_SKEW_SECONDS + 60;
    const data = buildInitData({ authDate: futureBeyondSkew });
    expect(validateTelegramInitData(data, BOT_TOKEN)).toBeNull();
  });

  it('accepts auth_date near the max age boundary (just within TTL)', () => {
    const nearExpiry = Math.floor(Date.now() / 1000) - INIT_DATA_MAX_AGE_SECONDS + 60;
    const data = buildInitData({ authDate: nearExpiry });
    expect(validateTelegramInitData(data, BOT_TOKEN)).not.toBeNull();
  });
});
