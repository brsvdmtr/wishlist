// Telegram Mini App initData HMAC validator.
// Spec: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// Workers runtime exposes Web Crypto (crypto.subtle); Node 20+ has it too,
// so the same code runs in vitest without polyfills.

export interface TgUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export interface ValidatedInitData {
  user: TgUser;
  authDate: number;
  hash: string;
  raw: string;
}

/**
 * Validate a Telegram Mini App `initData` payload.
 *
 * Returns the parsed `user` + auth metadata when the HMAC matches and the
 * payload is within `maxAgeSec`. Returns `null` for any failure (invalid
 * signature, expired, missing fields, malformed JSON, etc.) — callers should
 * treat null as "untrusted".
 */
export async function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSec: number = 24 * 60 * 60,
): Promise<ValidatedInitData | null> {
  if (!initData || !botToken) return null;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  // Build data-check-string: sort by key, join "key=value" with \n.
  const entries: [string, string][] = [];
  params.forEach((value, key) => entries.push([key, value]));
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  // secretKey = HMAC_SHA256("WebAppData", botToken)
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
  const calculatedBytes = await crypto.subtle.sign(
    'HMAC',
    secretKey,
    enc.encode(dataCheckString),
  );
  const calculatedHex = bytesToHex(new Uint8Array(calculatedBytes));

  if (!constantTimeEqual(calculatedHex, hash.toLowerCase())) return null;

  // HMAC matched — now parse user + freshness.
  const userRaw = params.get('user');
  if (!userRaw) return null;
  let user: TgUser;
  try {
    const parsed: unknown = JSON.parse(userRaw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as TgUser).id !== 'number' ||
      typeof (parsed as TgUser).first_name !== 'string'
    ) {
      return null;
    }
    user = parsed as TgUser;
  } catch {
    return null;
  }

  const authDateRaw = params.get('auth_date');
  if (!authDateRaw) return null;
  const authDate = Number(authDateRaw);
  if (!Number.isFinite(authDate) || authDate <= 0) return null;
  const ageSec = Math.floor(Date.now() / 1000) - authDate;
  if (ageSec < -60 || ageSec > maxAgeSec) return null; // -60s tolerance for clock skew

  return { user, authDate, hash, raw: initData };
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    const byte = b[i]!;
    s += byte.toString(16).padStart(2, '0');
  }
  return s;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
