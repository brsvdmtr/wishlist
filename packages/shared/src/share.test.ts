import { describe, it, expect } from 'vitest';
import { buildTgDeepLink, buildTgShareUrl } from './index';

describe('buildTgDeepLink', () => {
  it('returns null when botUsername is empty', () => {
    expect(buildTgDeepLink('')).toBeNull();
    expect(buildTgDeepLink('', 'some-slug')).toBeNull();
  });

  it('returns base URL when no payload', () => {
    expect(buildTgDeepLink('WishHub_bot')).toBe('https://t.me/WishHub_bot');
  });

  it('builds ?startapp= link with payload', () => {
    expect(buildTgDeepLink('WishHub_bot', 'my-list-abc123')).toBe(
      'https://t.me/WishHub_bot?startapp=my-list-abc123',
    );
  });

  it('encodes special characters in payload', () => {
    const result = buildTgDeepLink('WishHub_bot', 'hello world+foo');
    expect(result).toBe('https://t.me/WishHub_bot?startapp=hello%20world%2Bfoo');
  });

  it('handles payload with Cyrillic characters', () => {
    const result = buildTgDeepLink('WishHub_bot', 'список-желаний');
    expect(result).toContain('?startapp=');
    expect(result).not.toContain('список'); // should be encoded
  });
});

describe('buildTgShareUrl', () => {
  it('builds correct share URL', () => {
    const url = 'https://t.me/WishHub_bot?startapp=my-list';
    const text = '🎁 My Wishlist';
    const result = buildTgShareUrl(url, text);

    expect(result).toContain('https://t.me/share/url?url=');
    expect(result).toContain('&text=');
    // Verify URL is properly encoded
    expect(result).toContain(encodeURIComponent(url));
    expect(result).toContain(encodeURIComponent(text));
  });

  it('encodes multiline text', () => {
    const result = buildTgShareUrl('https://example.com', 'Line 1\nLine 2');
    expect(result).toContain(encodeURIComponent('Line 1\nLine 2'));
  });
});
