import { describe, it, expect, vi } from 'vitest';

import { fireAttributionBeacon } from './attribution';

describe('fireAttributionBeacon', () => {
  it('POSTs to /tg/analytics/attribution with source + medium + ref', () => {
    const tgFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    fireAttributionBeacon(tgFetch, 'share_link', 'abc123');

    expect(tgFetch).toHaveBeenCalledTimes(1);
    const [url, init] = tgFetch.mock.calls[0]!;
    expect(url).toBe('/tg/analytics/attribution');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      source: 'share_link',
      medium: 'miniapp',
      ref: 'abc123',
    });
  });

  it('omits ref from body when not provided', () => {
    const tgFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    fireAttributionBeacon(tgFetch, 'public_profile');

    const body = JSON.parse(tgFetch.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({ source: 'public_profile', medium: 'miniapp' });
    expect('ref' in body).toBe(false);
  });

  it('omits ref from body when explicitly null', () => {
    const tgFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    fireAttributionBeacon(tgFetch, 'curated_selection', null);

    const body = JSON.parse(tgFetch.mock.calls[0]![1]!.body as string);
    expect('ref' in body).toBe(false);
  });

  it('swallows network errors silently (fire-and-forget)', async () => {
    const tgFetch = vi.fn().mockRejectedValue(new Error('network'));
    // Capture unhandled rejections — should be none
    const unhandled: unknown[] = [];
    const handler = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', handler);

    fireAttributionBeacon(tgFetch, 'share_link', 'abc');

    // Let the rejected promise settle through .catch
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off('unhandledRejection', handler);

    expect(unhandled).toEqual([]);
  });

  it('accepts all three SharedAcquisitionSource union values', () => {
    const tgFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    fireAttributionBeacon(tgFetch, 'share_link');
    fireAttributionBeacon(tgFetch, 'curated_selection');
    fireAttributionBeacon(tgFetch, 'public_profile');

    expect(tgFetch).toHaveBeenCalledTimes(3);
    const sources = tgFetch.mock.calls.map((call) => JSON.parse(call[1]!.body as string).source);
    expect(sources).toEqual(['share_link', 'curated_selection', 'public_profile']);
  });
});
