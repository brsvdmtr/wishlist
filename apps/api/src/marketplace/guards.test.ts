/**
 * Tests for anti-bot/garbage guard functions.
 */
import { describe, it, expect } from 'vitest';
import { isAntiBotPage, isGarbageTitle, isSuspiciousPrice, isValidImageUrl } from './guards.js';

// ─── isAntiBotPage ───────────────────────────────────────────────────────────

describe('isAntiBotPage', () => {
  it('detects very short HTML as bot page', () => {
    expect(isAntiBotPage('<html><body>Short</body></html>', null)).toBe(true);
  });

  it('detects captcha title', () => {
    const html = '<html>' + 'x'.repeat(1000) + '</html>';
    expect(isAntiBotPage(html, 'Captcha Required')).toBe(true);
  });

  it('detects Cloudflare challenge', () => {
    const html = '<html>' + 'x'.repeat(1000) + '<div class="cf-challenge-running">Please wait</div></html>';
    expect(isAntiBotPage(html, 'Just a moment...')).toBe(true);
  });

  it('detects g-recaptcha in HTML', () => {
    const html = '<html>' + 'x'.repeat(1000) + '<div class="g-recaptcha"></div></html>';
    expect(isAntiBotPage(html, 'Normal Title')).toBe(true);
  });

  it('detects Yandex SmartCaptcha', () => {
    const html = '<html>' + 'x'.repeat(1000) + '<div class="yandex-smartcaptcha"></div></html>';
    expect(isAntiBotPage(html, null)).toBe(true);
  });

  it('detects DDoS-Guard', () => {
    const html = '<html>' + 'x'.repeat(1000) + 'DDoS-Guard</html>';
    expect(isAntiBotPage(html, null)).toBe(true);
  });

  it('passes normal product page', () => {
    const html = '<html>' + 'x'.repeat(5000) + '<h1>iPhone 15 Pro</h1></html>';
    expect(isAntiBotPage(html, 'iPhone 15 Pro - купить')).toBe(false);
  });
});

// ─── isGarbageTitle ──────────────────────────────────────────────────────────

describe('isGarbageTitle', () => {
  it('rejects empty string', () => expect(isGarbageTitle('')).toBe(true));
  it('rejects single char', () => expect(isGarbageTitle('A')).toBe(true));
  it('rejects slug', () => expect(isGarbageTitle('iphone-15-pro-max')).toBe(true));
  it('rejects numeric ID', () => expect(isGarbageTitle('123456')).toBe(true));
  it('rejects JSON', () => expect(isGarbageTitle('{title: "foo"}')).toBe(true));
  it('rejects "loading"', () => expect(isGarbageTitle('Loading')).toBe(true));
  it('rejects "undefined"', () => expect(isGarbageTitle('undefined')).toBe(true));
  it('rejects "not found"', () => expect(isGarbageTitle('Not Found')).toBe(true));
  it('accepts normal title', () => expect(isGarbageTitle('iPhone 15 Pro Max 256GB')).toBe(false));
  it('accepts Cyrillic title', () => expect(isGarbageTitle('Наушники беспроводные Sony')).toBe(false));
});

// ─── isSuspiciousPrice ───────────────────────────────────────────────────────

describe('isSuspiciousPrice', () => {
  it('flags zero', () => expect(isSuspiciousPrice(0)).toBe(true));
  it('flags negative', () => expect(isSuspiciousPrice(-1)).toBe(true));
  it('flags too high', () => expect(isSuspiciousPrice(99_999_999)).toBe(true));
  it('flags placeholder 9999', () => expect(isSuspiciousPrice(9999)).toBe(true));
  it('accepts normal price', () => expect(isSuspiciousPrice(1999)).toBe(false));
  it('accepts low price', () => expect(isSuspiciousPrice(50)).toBe(false));
});

// ─── isValidImageUrl ─────────────────────────────────────────────────────────

describe('isValidImageUrl', () => {
  it('accepts https URL', () => expect(isValidImageUrl('https://img.com/pic.jpg')).toBe(true));
  it('accepts http URL', () => expect(isValidImageUrl('http://img.com/pic.jpg')).toBe(true));
  it('accepts protocol-relative', () => expect(isValidImageUrl('//img.com/pic.jpg')).toBe(true));
  it('rejects empty', () => expect(isValidImageUrl('')).toBe(false));
  it('rejects data URI', () => expect(isValidImageUrl('data:image/png;base64,abc')).toBe(false));
  it('rejects pixel.gif', () => expect(isValidImageUrl('https://example.com/pixel.gif')).toBe(false));
  it('rejects placeholder', () => expect(isValidImageUrl('https://example.com/placeholder.png')).toBe(false));
  it('rejects no-image', () => expect(isValidImageUrl('https://example.com/no-image.png')).toBe(false));
});
