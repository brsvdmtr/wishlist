import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

// Regression test for 2026-05-18 bugfix — see docs/BUGFIX_LESSONS.md.
//
// Bug: Express auto-generates weak ETags on JSON responses. The Mini App's
// `tgFetch` callers (`loadProfile`, `loadShowcase`, `loadSettings`, etc.) check
// `if (!res.ok) throw new Error()`. `res.ok` is `false` for status 304 (true
// only for 200-299), so every conditional GET that revalidated as 304 raised a
// "Ошибка загрузки" toast. On WebKit (iOS Telegram, Telegram desktop on macOS)
// fetch() also sometimes passes the 304 through to JS with empty body instead
// of substituting the cached body, compounding the failure.
//
// Fix: `app.set('etag', false)` in apps/api/src/index.ts removes the trigger
// server-side; the Mini App's `tgFetch` adds `cache: 'no-store'` as a
// belt-and-suspenders client-side defense.
//
// This test mirrors the bootstrap config and locks in the contract: the API
// must NEVER return 304 on a `If-None-Match` revalidation request, because
// some clients can't handle it.

describe('Express ETag disable (regression for 2026-05-18 "Ошибка загрузки" bug)', () => {
  function buildApp() {
    const app = express();
    // Mirror the bootstrap config exactly — same flags, same order.
    app.set('trust proxy', 1);
    app.set('etag', false);
    app.get('/sample', (_req, res) => {
      res.json({ ok: true, payload: 'hello' });
    });
    return app;
  }

  it('does not emit an ETag header on JSON responses', async () => {
    const res = await request(buildApp()).get('/sample');
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeUndefined();
  });

  it('returns 200 (not 304) when the client sends a specific stale If-None-Match', async () => {
    // This is the realistic case: a browser cache replays a previously-seen
    // ETag. Pre-fix: server matched the ETag → 304 with empty body. Post-fix:
    // no ETag is generated, so fresh() never converts the response, and the
    // client always gets a 200 with a full body — which is what every Mini App
    // loader expects.
    //
    // Note: HTTP also allows `If-None-Match: *` as a wildcard, which the
    // express `fresh()` middleware honors unconditionally regardless of
    // `app.set('etag', false)`. We don't test that case because real browser
    // caches never send `*` for GET revalidation — they send the specific
    // ETag value from the cached response, and with the disable in place
    // there is no such value to send.
    const res = await request(buildApp())
      .get('/sample')
      .set('If-None-Match', 'W/"stale-etag-value"');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, payload: 'hello' });
  });
});
