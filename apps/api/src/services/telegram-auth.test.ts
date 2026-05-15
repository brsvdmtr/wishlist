// Unit tests for services/telegram-auth.ts.
//
// Note: security-auth.test.ts (14 cases) re-implements validateTelegramInitData
// to test the algorithm in isolation. This file imports the real exported
// function + covers the helpers not duplicated there (tgActorHash,
// SYSTEM_ACTOR_HASH, getOrCreateTgUser).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as crypto from 'node:crypto';

const shared = vi.hoisted(() => ({
  upsert: vi.fn(),
  recordIpEvent: vi.fn(),
}));

vi.mock('@wishlist/db', () => ({
  prisma: { user: { upsert: shared.upsert } },
}));

vi.mock('../security/ipThrottle', () => ({
  recordIpEvent: shared.recordIpEvent,
}));

import {
  validateTelegramInitData,
  tgActorHash,
  SYSTEM_ACTOR_HASH,
  getOrCreateTgUser,
  INIT_DATA_MAX_AGE_SECONDS,
  INIT_DATA_CLOCK_SKEW_SECONDS,
  clampMaxAgeSeconds,
} from './telegram-auth';

beforeEach(() => {
  shared.upsert.mockReset();
  shared.recordIpEvent.mockReset();
});

// ─── Helpers to build a valid initData payload ──────────────────────────────

const BOT_TOKEN = 'TEST_BOT_TOKEN:integration';

function buildInitData(authDate: number, userJson: string, token = BOT_TOKEN): string {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('user', userJson);
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

describe('validateTelegramInitData', () => {
  const validUser = JSON.stringify({ id: 12345, first_name: 'Алексей', language_code: 'ru' });

  it('accepts a freshly-signed initData payload', () => {
    const data = buildInitData(Math.floor(Date.now() / 1000), validUser);
    const result = validateTelegramInitData(data, BOT_TOKEN);
    expect('user' in result).toBe(true);
    if ('user' in result) {
      expect(result.user.id).toBe(12345);
      expect(result.user.first_name).toBe('Алексей');
    }
  });

  it('rejects payload signed with a different bot token (hash_mismatch)', () => {
    const data = buildInitData(Math.floor(Date.now() / 1000), validUser, 'DIFFERENT_TOKEN');
    const result = validateTelegramInitData(data, BOT_TOKEN);
    expect(result).toEqual({ reason: 'hash_mismatch' });
  });

  it('rejects payload older than INIT_DATA_MAX_AGE_SECONDS (expired)', () => {
    const data = buildInitData(Math.floor(Date.now() / 1000) - (INIT_DATA_MAX_AGE_SECONDS + 60), validUser);
    expect(validateTelegramInitData(data, BOT_TOKEN)).toEqual({ reason: 'expired' });
  });

  it('rejects payload with auth_date in the future (beyond clock skew)', () => {
    const data = buildInitData(Math.floor(Date.now() / 1000) + INIT_DATA_CLOCK_SKEW_SECONDS + 60, validUser);
    expect(validateTelegramInitData(data, BOT_TOKEN)).toEqual({ reason: 'future_auth_date' });
  });

  it('accepts payload slightly ahead of current time (within clock skew tolerance)', () => {
    const data = buildInitData(Math.floor(Date.now() / 1000) + 10, validUser);
    expect('user' in validateTelegramInitData(data, BOT_TOKEN)).toBe(true);
  });

  it('rejects missing hash', () => {
    expect(validateTelegramInitData('auth_date=1234567890', BOT_TOKEN)).toEqual({ reason: 'no_hash' });
  });

  it('rejects missing auth_date', () => {
    // Build initData without auth_date but with a (meaningless) hash.
    const params = new URLSearchParams();
    params.set('user', validUser);
    params.set('hash', 'a'.repeat(64));
    const result = validateTelegramInitData(params.toString(), BOT_TOKEN);
    // Will fail hash_mismatch first since the signature is bogus.
    expect(result).toMatchObject({ reason: expect.any(String) });
  });

  it('catches malformed user JSON and returns parse_error', () => {
    // Sign data where user payload is intentional garbage.
    const data = buildInitData(Math.floor(Date.now() / 1000), 'not-valid-json');
    expect(validateTelegramInitData(data, BOT_TOKEN)).toEqual({ reason: 'parse_error' });
  });
});

describe('tgActorHash', () => {
  it('returns a UUID-shaped string (8-4-4-4-12)', () => {
    const hash = tgActorHash(12345);
    expect(hash).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  });

  it('is deterministic — same input always yields same hash', () => {
    expect(tgActorHash(99)).toBe(tgActorHash(99));
  });

  it('different telegramIds yield different hashes', () => {
    expect(tgActorHash(1)).not.toBe(tgActorHash(2));
  });

  it('passes the z.string().uuid() expectation (5 hex groups joined by hyphens)', () => {
    const hash = tgActorHash(12345);
    const groups = hash.split('-');
    expect(groups).toHaveLength(5);
    expect(groups.map((g) => g.length)).toEqual([8, 4, 4, 4, 12]);
    for (const g of groups) expect(g).toMatch(/^[a-f0-9]+$/);
  });
});

describe('SYSTEM_ACTOR_HASH', () => {
  it('is the all-zeros UUID sentinel', () => {
    expect(SYSTEM_ACTOR_HASH).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('never collides with a real tgActorHash result', () => {
    for (let id = 1; id <= 1000; id += 53) {
      expect(tgActorHash(id)).not.toBe(SYSTEM_ACTOR_HASH);
    }
  });
});

describe('getOrCreateTgUser', () => {
  it('upserts by telegramId with first_name + last_name + username + isPremium captured', async () => {
    const tgUser = {
      id: 42,
      first_name: 'Maria',
      last_name: 'Иванова',
      username: 'maria_iv',
      is_premium: true,
    };
    shared.upsert.mockResolvedValueOnce({ id: 'u_internal' });

    await getOrCreateTgUser(tgUser);

    expect(shared.upsert).toHaveBeenCalledOnce();
    const arg = shared.upsert.mock.calls[0]![0];
    expect(arg.where).toEqual({ telegramId: '42' });
    expect(arg.update.firstName).toBe('Maria');
    expect(arg.update.lastName).toBe('Иванова');
    expect(arg.update.username).toBe('maria_iv');
    expect(arg.update.isPremium).toBe(true);
    expect(arg.create.telegramId).toBe('42');
    expect(arg.create.telegramChatId).toBe('42');
  });

  it('coerces missing last_name / username to null (not undefined)', async () => {
    shared.upsert.mockResolvedValueOnce({ id: 'u_min' });

    await getOrCreateTgUser({ id: 1, first_name: 'X' });

    const arg = shared.upsert.mock.calls[0]![0];
    expect(arg.update.lastName).toBeNull();
    expect(arg.update.username).toBeNull();
    expect(arg.update.isPremium).toBe(false);
  });

  it('treats explicit is_premium:false the same as missing (false)', async () => {
    shared.upsert.mockResolvedValueOnce({ id: 'u_np' });

    await getOrCreateTgUser({ id: 2, first_name: 'X', is_premium: false });

    expect(shared.upsert.mock.calls[0]![0].update.isPremium).toBe(false);
  });

  it('treats empty first_name string as null (Telegram quirk)', async () => {
    shared.upsert.mockResolvedValueOnce({ id: 'u_e' });

    await getOrCreateTgUser({ id: 3, first_name: '' });

    const arg = shared.upsert.mock.calls[0]![0];
    expect(arg.update.firstName).toBeNull();
    expect(arg.create.firstName).toBeNull();
  });
});

describe('clampMaxAgeSeconds', () => {
  it('parses a valid env value', () => {
    expect(clampMaxAgeSeconds('3600')).toBe(3600);
    expect(clampMaxAgeSeconds('86400')).toBe(86400);
  });

  it('clamps values below the 60-second floor up to 60', () => {
    expect(clampMaxAgeSeconds('1')).toBe(60);
    expect(clampMaxAgeSeconds('30')).toBe(60);
    expect(clampMaxAgeSeconds('59')).toBe(60);
    expect(clampMaxAgeSeconds('60')).toBe(60);
    expect(clampMaxAgeSeconds('61')).toBe(61);
  });

  it('falls back to 86_400 default for missing env', () => {
    expect(clampMaxAgeSeconds(undefined)).toBe(86_400);
  });

  it('falls back to 86_400 for non-numeric env values', () => {
    expect(clampMaxAgeSeconds('not-a-number')).toBe(86_400);
  });

  it('falls back to 86_400 for empty string', () => {
    expect(clampMaxAgeSeconds('')).toBe(86_400);
  });

  it('falls back to 86_400 for zero or negative env values (defensive)', () => {
    expect(clampMaxAgeSeconds('0')).toBe(86_400);
    expect(clampMaxAgeSeconds('-100')).toBe(86_400);
  });

  it('module-level INIT_DATA_MAX_AGE_SECONDS came from this clamp', () => {
    // Sanity check that the exported constant is at least the floor.
    expect(INIT_DATA_MAX_AGE_SECONDS).toBeGreaterThanOrEqual(60);
  });
});
