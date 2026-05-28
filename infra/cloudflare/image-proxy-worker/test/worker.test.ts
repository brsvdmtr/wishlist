// Unit tests for the image proxy Worker.
//
// We exercise the routing / validation / cache decision logic by calling
// the default export's `fetch` directly. Upstream `fetch` is stubbed so
// we never make real network calls in CI.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import worker, { isLikelyPrivateHost, type Env } from '../src/index';

const baseEnv: Env = {
  IMAGE_PROXY_DISABLED: '0',
};

const mockCtx: ExecutionContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: undefined as unknown as Record<string, unknown>,
};

// `caches.default` isn't available in the Node test runtime; provide a
// no-op shim so the Worker's `cache.match` / `cache.put` calls don't
// throw. Each test gets a fresh in-memory store.
function installCachesShim(): Map<string, Response> {
  const store = new Map<string, Response>();
  (globalThis as unknown as { caches: CacheStorage }).caches = {
    default: {
      async match(req: Request | string) {
        const key = typeof req === 'string' ? req : req.url;
        const r = store.get(key);
        if (!r) return undefined;
        // Return a clone so callers can read the body.
        return r.clone();
      },
      async put(req: Request | string, res: Response) {
        const key = typeof req === 'string' ? req : req.url;
        store.set(key, res);
      },
      async delete() { return true; },
    } as unknown as Cache,
  } as unknown as CacheStorage;
  return store;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  installCachesShim();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('isLikelyPrivateHost', () => {
  it('blocks loopback / localhost variants', () => {
    expect(isLikelyPrivateHost('127.0.0.1')).toBe(true);
    expect(isLikelyPrivateHost('127.255.0.1')).toBe(true);
    expect(isLikelyPrivateHost('localhost')).toBe(true);
    expect(isLikelyPrivateHost('something.localhost')).toBe(true);
    expect(isLikelyPrivateHost('::1')).toBe(true);
    expect(isLikelyPrivateHost('[::1]')).toBe(true);
  });

  it('blocks RFC1918 / CGN / link-local / cloud-metadata ranges', () => {
    expect(isLikelyPrivateHost('10.0.0.1')).toBe(true);
    expect(isLikelyPrivateHost('172.16.0.1')).toBe(true);
    expect(isLikelyPrivateHost('172.31.255.255')).toBe(true);
    expect(isLikelyPrivateHost('192.168.1.1')).toBe(true);
    expect(isLikelyPrivateHost('169.254.169.254')).toBe(true); // AWS metadata
    expect(isLikelyPrivateHost('100.64.0.1')).toBe(true); // CGN
    expect(isLikelyPrivateHost('0.0.0.0')).toBe(true);
  });

  it('blocks IPv6 ULA / link-local', () => {
    expect(isLikelyPrivateHost('fc00::1')).toBe(true);
    expect(isLikelyPrivateHost('fd12::1')).toBe(true);
    expect(isLikelyPrivateHost('fe80::1')).toBe(true);
  });

  it('blocks decimal / hex encodings of 127.x', () => {
    expect(isLikelyPrivateHost('2130706433')).toBe(true);
    expect(isLikelyPrivateHost('0x7f000001')).toBe(true);
  });

  it('does NOT block public hostnames or IPs', () => {
    expect(isLikelyPrivateHost('cdn.wildberries.ru')).toBe(false);
    expect(isLikelyPrivateHost('attacker.example')).toBe(false);
    expect(isLikelyPrivateHost('8.8.8.8')).toBe(false);
    expect(isLikelyPrivateHost('1.1.1.1')).toBe(false);
  });

  it('rejects empty hostname (defensive)', () => {
    expect(isLikelyPrivateHost('')).toBe(true);
  });
});

describe('worker.fetch — request routing', () => {
  it('returns 405 on non-GET/HEAD', async () => {
    const req = new Request('https://wishlistik.ru/cdn-img/?url=https://x.example/a.jpg', {
      method: 'POST',
    });
    const res = await worker.fetch(req, baseEnv, mockCtx);
    expect(res.status).toBe(405);
  });

  it('returns 400 when ?url= is missing', async () => {
    const req = new Request('https://wishlistik.ru/cdn-img/');
    const res = await worker.fetch(req, baseEnv, mockCtx);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('missing_url');
  });

  it('returns 400 when ?url= is unparseable', async () => {
    const req = new Request('https://wishlistik.ru/cdn-img/?url=not-a-url');
    const res = await worker.fetch(req, baseEnv, mockCtx);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('invalid_url');
  });

  it('rejects javascript: / data: / file: schemes', async () => {
    for (const scheme of ['javascript', 'data', 'file', 'ftp']) {
      const req = new Request(
        `https://wishlistik.ru/cdn-img/?url=${encodeURIComponent(`${scheme}://x`)}`,
      );
      const res = await worker.fetch(req, baseEnv, mockCtx);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('forbidden_scheme');
    }
  });

  it('rejects private-host targets (SSRF guard)', async () => {
    const req = new Request(
      `https://wishlistik.ru/cdn-img/?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`,
    );
    const res = await worker.fetch(req, baseEnv, mockCtx);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('forbidden_host');
  });

  it('falls through (pass-through fetch) for non-/cdn-img/ paths', async () => {
    const passthrough = vi
      .fn()
      .mockResolvedValueOnce(new Response('origin', { status: 200 }));
    globalThis.fetch = passthrough as unknown as typeof fetch;
    const req = new Request('https://wishlistik.ru/api/health');
    const res = await worker.fetch(req, baseEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('origin');
  });

  it('kill switch: IMAGE_PROXY_DISABLED=1 → pure pass-through even on /cdn-img/', async () => {
    const passthrough = vi
      .fn()
      .mockResolvedValueOnce(new Response('origin', { status: 200 }));
    globalThis.fetch = passthrough as unknown as typeof fetch;
    const req = new Request('https://wishlistik.ru/cdn-img/?url=https://x.example/a.jpg');
    const res = await worker.fetch(req, { ...baseEnv, IMAGE_PROXY_DISABLED: '1' }, mockCtx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('origin');
  });
});

describe('worker.fetch — upstream contract', () => {
  it('returns 502 when upstream is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('AbortError')) as unknown as typeof fetch;
    const req = new Request(
      `https://wishlistik.ru/cdn-img/?url=${encodeURIComponent('https://cdn.example/missing.jpg')}`,
    );
    const res = await worker.fetch(req, baseEnv, mockCtx);
    expect(res.status).toBe(502);
  });

  it('returns 404 when upstream returns 404', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('not found', { status: 404 })) as unknown as typeof fetch;
    const req = new Request(
      `https://wishlistik.ru/cdn-img/?url=${encodeURIComponent('https://cdn.example/missing.jpg')}`,
    );
    const res = await worker.fetch(req, baseEnv, mockCtx);
    expect(res.status).toBe(404);
  });

  it('returns 415 when upstream Content-Type is not in the image allowlist', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('<!doctype html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      ) as unknown as typeof fetch;
    const req = new Request(
      `https://wishlistik.ru/cdn-img/?url=${encodeURIComponent('https://attacker.example/track.gif')}`,
    );
    const res = await worker.fetch(req, baseEnv, mockCtx);
    expect(res.status).toBe(415);
  });

  it('returns 413 when Content-Length exceeds the cap', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array(8), {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': String(50 * 1024 * 1024), // 50 MB
          },
        }),
      ) as unknown as typeof fetch;
    const req = new Request(
      `https://wishlistik.ru/cdn-img/?url=${encodeURIComponent('https://cdn.example/huge.jpg')}`,
    );
    const res = await worker.fetch(req, baseEnv, mockCtx);
    expect(res.status).toBe(413);
  });

  it('returns 200 with sanitised headers on a happy-path image fetch', async () => {
    const body = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG SOI
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(body, {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': String(body.byteLength),
            'set-cookie': 'evil=1', // upstream tries to set a cookie
            server: 'Apache/2.4',
            'x-powered-by': 'PHP/7.4',
          },
        }),
      ) as unknown as typeof fetch;
    const req = new Request(
      `https://wishlistik.ru/cdn-img/?url=${encodeURIComponent('https://cdn.example/photo.jpg')}`,
    );
    const res = await worker.fetch(req, baseEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toMatch(/^public, max-age=\d+, immutable$/);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    // Inherited tracking-style headers MUST be stripped (we set our own
    // headers via `new Headers()`, so these never appear).
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('server')).toBeNull();
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('serves the cached response on the second identical request', async () => {
    const body = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const upstreamFetch = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(body.byteLength) },
      }),
    );
    globalThis.fetch = upstreamFetch as unknown as typeof fetch;
    const url = `https://wishlistik.ru/cdn-img/?url=${encodeURIComponent('https://cdn.example/cached.jpg')}`;

    // First request: cache miss, calls upstream.
    const first = await worker.fetch(new Request(url), baseEnv, mockCtx);
    expect(first.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledOnce();

    // Drain the waitUntil callback (the cache.put runs in the background).
    await Promise.all((mockCtx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]));

    // Second request: cache hit, upstream NOT called again.
    const second = await worker.fetch(new Request(url), baseEnv, mockCtx);
    expect(second.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledOnce();
  });
});
