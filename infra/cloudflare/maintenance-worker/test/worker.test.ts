// Worker fetch handler integration tests.
// Mocks: KV namespace (in-memory Map), origin fetch (vi.fn).

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/index';
import { validateInitData } from '../src/initdata'; // unused but exercises path
import { MAINTENANCE_HTML } from '../src/maintenance-html.generated';

const TEST_BOT_TOKEN = '12345:AAFakeBotTokenForTestingOnly_DoNotUse';
const TEST_DRAIN_SECRET = 'drain-secret-xyz-1234567890';

// ── KV mock ───────────────────────────────────────────────────────────────
class MockKV {
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const expiresAt = options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null;
    this.store.set(key, { value, expiresAt });
  }

  async get(key: string): Promise<string | null> {
    const rec = this.store.get(key);
    if (!rec) return null;
    if (rec.expiresAt && Date.now() > rec.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return rec.value;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; limit?: number }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
  }> {
    const prefix = options?.prefix ?? '';
    const limit = options?.limit ?? 1000;
    const matching = Array.from(this.store.keys()).filter((k) => k.startsWith(prefix));
    const slice = matching.slice(0, limit);
    return {
      keys: slice.map((name) => ({ name })),
      list_complete: slice.length === matching.length,
    };
  }

  size(): number {
    return this.store.size;
  }
  rawKeys(): string[] {
    return Array.from(this.store.keys());
  }
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    MAINTENANCE_EXPOSURES: new MockKV() as unknown as KVNamespace,
    ORIGIN_HOST: 'wishlistik.ru',
    MAINTENANCE_WORKER_DISABLED: '0',
    BOT_TOKEN: TEST_BOT_TOKEN,
    CF_DRAIN_SECRET: TEST_DRAIN_SECRET,
    ...overrides,
  };
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

async function makeSignedInitData(
  payload: Record<string, string>,
  botToken: string,
): Promise<string> {
  const sorted = Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : 1));
  const dataCheckString = sorted.map(([k, v]) => `${k}=${v}`).join('\n');
  const enc = new TextEncoder();
  const wak = await crypto.subtle.importKey(
    'raw',
    enc.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sBytes = await crypto.subtle.sign('HMAC', wak, enc.encode(botToken));
  const sKey = await crypto.subtle.importKey(
    'raw',
    sBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const hBytes = await crypto.subtle.sign('HMAC', sKey, enc.encode(dataCheckString));
  const hash = Array.from(new Uint8Array(hBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const params = new URLSearchParams();
  for (const [k, v] of sorted) params.set(k, v);
  params.set('hash', hash);
  return params.toString();
}

const nowSec = () => Math.floor(Date.now() / 1000);

// ── Global fetch mock ─────────────────────────────────────────────────────
let originResponse: () => Response | Promise<Response>;
const originFetchSpy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  // Health probes and worker-owned endpoints never reach here.
  return originResponse();
});

beforeEach(() => {
  vi.stubGlobal('fetch', originFetchSpy);
  originResponse = () => new Response('origin ok', { status: 200 });
  originFetchSpy.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('health endpoint', () => {
  it('returns 200 ok regardless of origin', async () => {
    originResponse = () => {
      throw new Error('origin should not be hit');
    };
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://wishlistik.ru/__cf-maintenance-health'),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(originFetchSpy).not.toHaveBeenCalled();
  });
});

describe('pass-through', () => {
  it('returns origin response when origin is healthy (200)', async () => {
    originResponse = () => new Response('hello', { status: 200 });
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://wishlistik.ru/miniapp'),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
  });

  it('passes through non-HTML 5xx (e.g. API caller) as origin response', async () => {
    originResponse = () => new Response('{"err":"x"}', {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://wishlistik.ru/api/tg/something', {
        headers: { accept: 'application/json' },
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(502);
  });

  it('translates HTML 5xx (CF default on L1 unreachable) to JSON envelope for fetch caller', async () => {
    // L1 outage: CF can't reach origin → returns its synthesised 522 HTML
    // page. A JSON caller (Mini App fetch with Accept: */*) would receive
    // HTML and fall into "Нет связи" instead of the proper L3 maintenance
    // screen. Worker rewraps as JSON {code:MAINTENANCE} so the Mini App
    // detects maintenance correctly.
    originResponse = () => new Response('<html>...CF 522 origin unreachable...</html>', {
      status: 522,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://wishlistik.ru/api/tg/bootstrap', {
        method: 'POST',
        headers: { accept: '*/*', 'content-type': 'application/json' },
        body: '{}',
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('MAINTENANCE');
  });

  it('passes through API JSON 503 (L3 MAINTENANCE_MODE) untouched so Mini App reads its own code:MAINTENANCE', async () => {
    // L3: API itself returns 503 + JSON {code:MAINTENANCE}. Worker must
    // pass that through verbatim — re-wrapping would discard fields the
    // API may add (e.g. retry_after, support_url) and lose source-of-truth.
    originResponse = () => new Response('{"error":"Service temporarily unavailable","code":"MAINTENANCE"}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://wishlistik.ru/api/tg/bootstrap', {
        method: 'POST',
        headers: { accept: '*/*', 'content-type': 'application/json' },
        body: '{}',
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('MAINTENANCE');
  });

  it('serves maintenance HTML on origin 502 for browser request', async () => {
    originResponse = () => new Response('bad gateway', { status: 502 });
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://wishlistik.ru/miniapp', {
        headers: { accept: 'text/html,application/xhtml+xml' },
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toBe(MAINTENANCE_HTML);
  });

  it('serves maintenance HTML on CF 522 (origin timeout) for browser request', async () => {
    originResponse = () => new Response('timeout', { status: 522 });
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://wishlistik.ru/', {
        headers: { accept: 'text/html' },
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(MAINTENANCE_HTML);
  });

  it('serves maintenance HTML when fetch throws (network failure)', async () => {
    originResponse = () => {
      throw new TypeError('network');
    };
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://wishlistik.ru/miniapp', {
        headers: { accept: 'text/html' },
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(MAINTENANCE_HTML);
  });

  it('returns JSON error to non-HTML caller when fetch throws', async () => {
    originResponse = () => {
      throw new TypeError('network');
    };
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://wishlistik.ru/api/foo', {
        headers: { accept: 'application/json' },
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('origin_unreachable');
  });
});

describe('kill switch', () => {
  it('passes through everything when MAINTENANCE_WORKER_DISABLED=1', async () => {
    originResponse = () => new Response('bad gateway', { status: 502 });
    const env = makeEnv({ MAINTENANCE_WORKER_DISABLED: '1' });
    const res = await worker.fetch(
      new Request('https://wishlistik.ru/miniapp', {
        headers: { accept: 'text/html' },
      }),
      env,
      makeCtx(),
    );
    // No maintenance HTML — passes through origin's 502.
    expect(res.status).toBe(502);
  });
});

describe('exposure POST', () => {
  it('writes a KV record for a valid initData payload', async () => {
    const initData = await makeSignedInitData(
      {
        user: JSON.stringify({ id: 42, first_name: 'A', language_code: 'ru' }),
        auth_date: String(nowSec()),
      },
      TEST_BOT_TOKEN,
    );

    const kv = new MockKV();
    const env = makeEnv({ MAINTENANCE_EXPOSURES: kv as unknown as KVNamespace });

    const res = await worker.fetch(
      new Request('https://wishlistik.ru/__cf-maintenance-exposure', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `initData=${encodeURIComponent(initData)}&surface=static&locale=ru`,
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
    expect(kv.size()).toBe(1);
    expect(kv.rawKeys()[0]).toMatch(/^exposure:\d{4}-\d{2}-\d{2}:42$/);
  });

  it('coalesces multiple POSTs from the same user on the same day', async () => {
    const initData = await makeSignedInitData(
      {
        user: JSON.stringify({ id: 7, first_name: 'B' }),
        auth_date: String(nowSec()),
      },
      TEST_BOT_TOKEN,
    );

    const kv = new MockKV();
    const env = makeEnv({ MAINTENANCE_EXPOSURES: kv as unknown as KVNamespace });

    for (let i = 0; i < 3; i++) {
      await worker.fetch(
        new Request('https://wishlistik.ru/__cf-maintenance-exposure', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: `initData=${encodeURIComponent(initData)}&surface=static&locale=ru`,
        }),
        env,
        makeCtx(),
      );
    }
    expect(kv.size()).toBe(1);
  });

  it('rejects invalid initData with 401', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://wishlistik.ru/__cf-maintenance-exposure', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'initData=garbage&surface=static&locale=ru',
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(401);
  });

  it('rejects missing initData with 400', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://wishlistik.ru/__cf-maintenance-exposure', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'surface=static&locale=ru',
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(400);
  });

  it('rejects non-POST methods with 405', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://wishlistik.ru/__cf-maintenance-exposure', { method: 'GET' }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(405);
  });

  it('returns 503 when BOT_TOKEN is not configured', async () => {
    const env = makeEnv({ BOT_TOKEN: '' });
    const res = await worker.fetch(
      new Request('https://wishlistik.ru/__cf-maintenance-exposure', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'initData=x',
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(503);
  });
});

describe('drain GET', () => {
  it('returns 403 without the drain secret', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://wishlistik.ru/__cf-maintenance-drain'),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(403);
  });

  it('returns records when secret matches (via header)', async () => {
    const kv = new MockKV();
    await kv.put('exposure:2026-05-25:42', JSON.stringify({ tg_user_id: 42, locale: 'ru' }));
    await kv.put('exposure:2026-05-25:43', JSON.stringify({ tg_user_id: 43, locale: 'en' }));
    const env = makeEnv({ MAINTENANCE_EXPOSURES: kv as unknown as KVNamespace });

    const res = await worker.fetch(
      new Request('https://wishlistik.ru/__cf-maintenance-drain', {
        headers: { 'x-drain-secret': TEST_DRAIN_SECRET },
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; count: number; records: { tg_user_id: number; _key: string }[] };
    expect(body.ok).toBe(true);
    expect(body.count).toBe(2);
    expect(body.records.map((r) => r.tg_user_id).sort()).toEqual([42, 43]);
    expect(body.records[0]!._key).toMatch(/^exposure:/);
  });

  it('returns records when secret matches (via ?secret=)', async () => {
    const kv = new MockKV();
    await kv.put('exposure:x:1', JSON.stringify({ tg_user_id: 1 }));
    const env = makeEnv({ MAINTENANCE_EXPOSURES: kv as unknown as KVNamespace });

    const res = await worker.fetch(
      new Request(`https://wishlistik.ru/__cf-maintenance-drain?secret=${TEST_DRAIN_SECRET}`),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(200);
  });

  it('does NOT delete records during drain (separate DELETE call required)', async () => {
    const kv = new MockKV();
    await kv.put('exposure:x:1', JSON.stringify({ tg_user_id: 1 }));
    const env = makeEnv({ MAINTENANCE_EXPOSURES: kv as unknown as KVNamespace });

    await worker.fetch(
      new Request(`https://wishlistik.ru/__cf-maintenance-drain?secret=${TEST_DRAIN_SECRET}`),
      env,
      makeCtx(),
    );
    expect(kv.size()).toBe(1); // still there
  });
});

describe('drain DELETE', () => {
  it('deletes only the specified keys', async () => {
    const kv = new MockKV();
    await kv.put('exposure:x:1', '{}');
    await kv.put('exposure:x:2', '{}');
    await kv.put('exposure:x:3', '{}');
    const env = makeEnv({ MAINTENANCE_EXPOSURES: kv as unknown as KVNamespace });

    const res = await worker.fetch(
      new Request('https://wishlistik.ru/__cf-maintenance-drain', {
        method: 'DELETE',
        headers: { 'x-drain-secret': TEST_DRAIN_SECRET, 'content-type': 'application/json' },
        body: JSON.stringify({ keys: ['exposure:x:1', 'exposure:x:3'] }),
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(200);
    expect((await res.json() as { deleted: number }).deleted).toBe(2);
    expect(kv.size()).toBe(1);
    expect(kv.rawKeys()[0]).toBe('exposure:x:2');
  });

  it('ignores keys outside the exposure: prefix', async () => {
    const kv = new MockKV();
    await kv.put('exposure:x:1', '{}');
    await kv.put('other:secret', 'leak');
    const env = makeEnv({ MAINTENANCE_EXPOSURES: kv as unknown as KVNamespace });

    await worker.fetch(
      new Request('https://wishlistik.ru/__cf-maintenance-drain', {
        method: 'DELETE',
        headers: { 'x-drain-secret': TEST_DRAIN_SECRET, 'content-type': 'application/json' },
        body: JSON.stringify({ keys: ['exposure:x:1', 'other:secret'] }),
      }),
      env,
      makeCtx(),
    );
    expect(kv.size()).toBe(1);
    expect(kv.rawKeys()[0]).toBe('other:secret');
  });

  it('requires the drain secret', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://wishlistik.ru/__cf-maintenance-drain', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keys: ['exposure:x:1'] }),
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(403);
  });
});
