// Regression tests for the Mini App image-proxy helper.
//
// Covers the routing decisions: which URLs go through the CF Worker
// proxy, which stay direct, and which are rejected entirely. The
// kill-switch path is exercised by reading `NEXT_PUBLIC_IMAGE_PROXY`
// at module-eval time — the env var is set before the dynamic
// import in the kill-switch suite.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { proxyImageUrl } from './proxyImage';

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.NEXT_PUBLIC_IMAGE_PROXY;
  // Activate the proxy for the helper-routing tests. The default is
  // OFF so a Mini App build can land before the Worker is deployed
  // without breaking image loads; these tests assert the "enabled"
  // path explicitly. The kill-switch path is asserted in
  // proxyImage.killswitch.test.ts.
  process.env.NEXT_PUBLIC_IMAGE_PROXY = 'enabled';
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.NEXT_PUBLIC_IMAGE_PROXY;
  else process.env.NEXT_PUBLIC_IMAGE_PROXY = savedEnv;
});

describe('proxyImageUrl', () => {
  describe('routes external http(s) URLs through the proxy', () => {
    it('wildberries-style CDN', () => {
      const out = proxyImageUrl('https://cdn.wildberries.ru/big/3220000/3221234-1.jpg');
      expect(out).toBe(
        '/cdn-img/?url=https%3A%2F%2Fcdn.wildberries.ru%2Fbig%2F3220000%2F3221234-1.jpg',
      );
    });

    it('ozon-style CDN', () => {
      const out = proxyImageUrl('https://ir.ozone.ru/s3/multimedia-x/wc1500/123.jpg');
      expect(out?.startsWith('/cdn-img/?url=')).toBe(true);
      expect(out).toContain(encodeURIComponent('https://ir.ozone.ru/s3/multimedia-x/wc1500/123.jpg'));
    });

    it('http (not https) — still proxied, the Worker handles the upgrade', () => {
      const out = proxyImageUrl('http://insecure.example/pic.png');
      expect(out?.startsWith('/cdn-img/?url=')).toBe(true);
    });

    it('attacker-controlled tracker URL — proxied (the point of the fix)', () => {
      const out = proxyImageUrl('https://attacker.example/track.gif?uid=12345');
      expect(out?.startsWith('/cdn-img/?url=')).toBe(true);
      // The raw URL must survive encoding for the Worker to reproduce
      // it exactly upstream.
      expect(out).toContain(encodeURIComponent('https://attacker.example/track.gif?uid=12345'));
    });
  });

  describe('passes through URLs that are already safe / same-origin', () => {
    it('/api/uploads/<uuid>.jpg (server-side avatar/photo)', () => {
      expect(proxyImageUrl('/api/uploads/abc-full.jpg')).toBe('/api/uploads/abc-full.jpg');
    });

    it('/uploads/<...>', () => {
      expect(proxyImageUrl('/uploads/x.png')).toBe('/uploads/x.png');
    });

    it('data: URIs (already inline)', () => {
      const dataUrl = 'data:image/svg+xml;base64,PHN2Zy8+';
      expect(proxyImageUrl(dataUrl)).toBe(dataUrl);
    });

    it('https://wishlistik.ru/... (same-origin)', () => {
      expect(proxyImageUrl('https://wishlistik.ru/uploads/x.jpg')).toBe(
        'https://wishlistik.ru/uploads/x.jpg',
      );
      expect(proxyImageUrl('https://www.wishlistik.ru/uploads/x.jpg')).toBe(
        'https://www.wishlistik.ru/uploads/x.jpg',
      );
    });
  });

  describe('rejects', () => {
    it('null / undefined / empty / whitespace', () => {
      expect(proxyImageUrl(null)).toBeUndefined();
      expect(proxyImageUrl(undefined)).toBeUndefined();
      expect(proxyImageUrl('')).toBeUndefined();
      expect(proxyImageUrl('   ')).toBeUndefined();
    });

    it('non-http(s) external schemes', () => {
      expect(proxyImageUrl('javascript:alert(1)')).toBeUndefined();
      expect(proxyImageUrl('file:///etc/passwd')).toBeUndefined();
      expect(proxyImageUrl('vbscript:msgbox(1)')).toBeUndefined();
    });

    it('completely malformed input', () => {
      // The URL parser accepts a lot, so this picks an explicitly-broken
      // shape (control char in the scheme) that the parser rejects.
      expect(proxyImageUrl('\x00://bad.example/x')).toBeUndefined();
    });
  });

  it('trims surrounding whitespace before deciding', () => {
    expect(proxyImageUrl('  https://cdn.example/a.jpg  ')?.startsWith('/cdn-img/')).toBe(true);
    expect(proxyImageUrl('  /uploads/x.jpg  ')).toBe('/uploads/x.jpg');
  });
});
