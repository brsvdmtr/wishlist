// HMAC validator unit tests — runs in Node (vitest) using native Web Crypto.

import { describe, it, expect } from 'vitest';
import { validateInitData } from '../src/initdata';

const TEST_BOT_TOKEN = '12345:AAFakeBotTokenForTestingOnly_DoNotUse';

/**
 * Build a valid Telegram initData query string for a given payload.
 * Mirrors the Bot API signing algorithm so we can exercise validateInitData.
 */
async function makeSignedInitData(
  payload: Record<string, string>,
  botToken: string,
): Promise<string> {
  const sorted = Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = sorted.map(([k, v]) => `${k}=${v}`).join('\n');

  const enc = new TextEncoder();
  const webAppKey = await crypto.subtle.importKey(
    'raw',
    enc.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const secretKeyBytes = await crypto.subtle.sign('HMAC', webAppKey, enc.encode(botToken));
  const secretKey = await crypto.subtle.importKey(
    'raw',
    secretKeyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const hashBytes = await crypto.subtle.sign('HMAC', secretKey, enc.encode(dataCheckString));
  const hashHex = Array.from(new Uint8Array(hashBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const params = new URLSearchParams();
  for (const [k, v] of sorted) params.set(k, v);
  params.set('hash', hashHex);
  return params.toString();
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

describe('validateInitData', () => {
  it('accepts a freshly signed payload and returns parsed user', async () => {
    const initData = await makeSignedInitData(
      {
        user: JSON.stringify({ id: 123, first_name: 'Alice', language_code: 'ru' }),
        auth_date: String(nowSec()),
        chat_instance: 'abc-123',
      },
      TEST_BOT_TOKEN,
    );

    const result = await validateInitData(initData, TEST_BOT_TOKEN);
    expect(result).not.toBeNull();
    expect(result!.user.id).toBe(123);
    expect(result!.user.first_name).toBe('Alice');
    expect(result!.user.language_code).toBe('ru');
    expect(result!.authDate).toBeGreaterThan(0);
  });

  it('rejects a tampered user payload', async () => {
    const initData = await makeSignedInitData(
      {
        user: JSON.stringify({ id: 123, first_name: 'Alice' }),
        auth_date: String(nowSec()),
      },
      TEST_BOT_TOKEN,
    );
    // Swap user after signing
    const params = new URLSearchParams(initData);
    params.set('user', JSON.stringify({ id: 999, first_name: 'Mallory' }));

    const result = await validateInitData(params.toString(), TEST_BOT_TOKEN);
    expect(result).toBeNull();
  });

  it('rejects payload signed with a different bot token', async () => {
    const initData = await makeSignedInitData(
      { user: JSON.stringify({ id: 1, first_name: 'A' }), auth_date: String(nowSec()) },
      'other-bot-token',
    );
    const result = await validateInitData(initData, TEST_BOT_TOKEN);
    expect(result).toBeNull();
  });

  it('rejects expired auth_date (older than maxAgeSec)', async () => {
    const initData = await makeSignedInitData(
      {
        user: JSON.stringify({ id: 1, first_name: 'A' }),
        auth_date: String(nowSec() - 25 * 3600), // 25 hours ago
      },
      TEST_BOT_TOKEN,
    );
    const result = await validateInitData(initData, TEST_BOT_TOKEN, 24 * 3600);
    expect(result).toBeNull();
  });

  it('accepts auth_date within tolerance window for slight future clock skew', async () => {
    const initData = await makeSignedInitData(
      {
        user: JSON.stringify({ id: 1, first_name: 'A' }),
        auth_date: String(nowSec() + 30), // 30s in the future (clock skew)
      },
      TEST_BOT_TOKEN,
    );
    const result = await validateInitData(initData, TEST_BOT_TOKEN);
    expect(result).not.toBeNull();
  });

  it('rejects auth_date far in the future (likely tampered)', async () => {
    const initData = await makeSignedInitData(
      {
        user: JSON.stringify({ id: 1, first_name: 'A' }),
        auth_date: String(nowSec() + 3600), // 1 hour in the future
      },
      TEST_BOT_TOKEN,
    );
    const result = await validateInitData(initData, TEST_BOT_TOKEN);
    expect(result).toBeNull();
  });

  it('returns null when hash field is missing', async () => {
    const initData =
      'user=' +
      encodeURIComponent('{"id":1,"first_name":"A"}') +
      '&auth_date=' +
      String(nowSec());
    const result = await validateInitData(initData, TEST_BOT_TOKEN);
    expect(result).toBeNull();
  });

  it('returns null for empty initData', async () => {
    expect(await validateInitData('', TEST_BOT_TOKEN)).toBeNull();
  });

  it('returns null for empty bot token', async () => {
    const initData = await makeSignedInitData(
      { user: JSON.stringify({ id: 1, first_name: 'A' }), auth_date: String(nowSec()) },
      TEST_BOT_TOKEN,
    );
    expect(await validateInitData(initData, '')).toBeNull();
  });

  it('returns null for malformed user JSON', async () => {
    const initData = await makeSignedInitData(
      { user: 'not-json', auth_date: String(nowSec()) },
      TEST_BOT_TOKEN,
    );
    expect(await validateInitData(initData, TEST_BOT_TOKEN)).toBeNull();
  });

  it('returns null when user is missing required fields', async () => {
    const initData = await makeSignedInitData(
      { user: JSON.stringify({ id: 'not-a-number' }), auth_date: String(nowSec()) },
      TEST_BOT_TOKEN,
    );
    expect(await validateInitData(initData, TEST_BOT_TOKEN)).toBeNull();
  });

  it('returns null when auth_date is missing', async () => {
    const initData = await makeSignedInitData(
      { user: JSON.stringify({ id: 1, first_name: 'A' }) },
      TEST_BOT_TOKEN,
    );
    expect(await validateInitData(initData, TEST_BOT_TOKEN)).toBeNull();
  });

  it('returns null when auth_date is non-numeric', async () => {
    const initData = await makeSignedInitData(
      { user: JSON.stringify({ id: 1, first_name: 'A' }), auth_date: 'banana' },
      TEST_BOT_TOKEN,
    );
    expect(await validateInitData(initData, TEST_BOT_TOKEN)).toBeNull();
  });

  it('handles uppercase hex in hash field (case-insensitive comparison)', async () => {
    const initData = await makeSignedInitData(
      { user: JSON.stringify({ id: 1, first_name: 'A' }), auth_date: String(nowSec()) },
      TEST_BOT_TOKEN,
    );
    // Force hash to uppercase
    const params = new URLSearchParams(initData);
    const lowerHash = params.get('hash')!;
    params.set('hash', lowerHash.toUpperCase());
    const result = await validateInitData(params.toString(), TEST_BOT_TOKEN);
    expect(result).not.toBeNull();
  });
});
