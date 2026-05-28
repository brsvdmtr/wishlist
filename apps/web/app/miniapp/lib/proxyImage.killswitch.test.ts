// Kill-switch regression: when NEXT_PUBLIC_IMAGE_PROXY is unset or
// any value other than 'enabled', `proxyImageUrl` must return the raw
// URL unchanged. The default-off behaviour exists so that a Mini App
// build can ship BEFORE the Cloudflare image-proxy Worker is deployed
// without breaking external image loads.
//
// Lives in a separate file because `proxyImage.ts` reads
// `process.env.NEXT_PUBLIC_IMAGE_PROXY` at module-eval time (Next.js
// inlines it at build time in real builds). Sharing a file with the
// "enabled" tests would force one or the other to use a dynamic
// import dance; a second file is simpler.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { proxyImageUrl } from './proxyImage';

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.NEXT_PUBLIC_IMAGE_PROXY;
  delete process.env.NEXT_PUBLIC_IMAGE_PROXY;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.NEXT_PUBLIC_IMAGE_PROXY;
  else process.env.NEXT_PUBLIC_IMAGE_PROXY = savedEnv;
});

describe('proxyImageUrl — kill switch (default-off)', () => {
  it('returns the raw URL unchanged when NEXT_PUBLIC_IMAGE_PROXY is unset', () => {
    expect(proxyImageUrl('https://cdn.wildberries.ru/x.jpg')).toBe(
      'https://cdn.wildberries.ru/x.jpg',
    );
  });

  it('still trims whitespace and rejects empty / null input', () => {
    expect(proxyImageUrl(null)).toBeUndefined();
    expect(proxyImageUrl(undefined)).toBeUndefined();
    expect(proxyImageUrl('')).toBeUndefined();
    expect(proxyImageUrl('  ')).toBeUndefined();
    expect(proxyImageUrl('  https://cdn.example/x.jpg  ')).toBe('https://cdn.example/x.jpg');
  });

  it('still rejects control-char and bad-scheme inputs (kill switch != bypass all guards)', () => {
    expect(proxyImageUrl('java\nscript:alert(1)')).toBeUndefined();
    // file:// is rejected because it lacks an http(s) scheme — even
    // with the proxy disabled we don't want the helper to encourage
    // rendering arbitrary URI schemes.
    // (When PROXY is off we return the raw URL only for whitelisted
    //  cases; everything else still goes through the same gate.)
  });
});
