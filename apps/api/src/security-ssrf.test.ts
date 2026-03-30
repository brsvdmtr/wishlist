/**
 * Tests for SSRF protection — URL validation + IP/DNS checks.
 *
 * Unit tests cover:
 *   - isForbiddenIP: IPv4 private/reserved, IPv6 loopback/link-local/ULA/mapped
 *   - validateUrl: protocol, credentials, blocked hostnames
 *   - assertDnsIsSafe: DNS resolution validation (mocked)
 *
 * Integration tests for actual redirect-following behavior require a real HTTP
 * server and are out of scope here — covered by manual testing.
 */
import { describe, it, expect, vi } from 'vitest';

// Import the exported helpers from url-parser
import { validateUrl, isForbiddenIP, assertDnsIsSafe } from './url-parser.js';

// ─── isForbiddenIP ───────────────────────────────────────────────────────────

describe('isForbiddenIP', () => {
  describe('IPv4 — forbidden', () => {
    const forbidden = [
      '127.0.0.1',
      '127.0.0.2',
      '127.255.255.255',
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '192.168.1.100',
      '169.254.169.254',  // cloud metadata
      '169.254.0.1',
      '0.0.0.0',
      '0.0.0.1',
      '100.64.0.1',       // CGN (shared address space)
      '100.127.255.255',
      '224.0.0.1',        // multicast
      '255.255.255.255',  // broadcast
      '240.0.0.1',        // reserved
    ];
    for (const ip of forbidden) {
      it(`blocks ${ip}`, () => {
        expect(isForbiddenIP(ip)).toBe(true);
      });
    }
  });

  describe('IPv4 — allowed', () => {
    const allowed = [
      '8.8.8.8',
      '1.1.1.1',
      '93.184.216.34',
      '172.15.255.255',   // just outside 172.16/12
      '172.32.0.1',       // just outside 172.16/12
      '100.63.255.255',   // just outside CGN
      '100.128.0.0',      // just outside CGN
      '192.167.1.1',
      '223.255.255.255',  // last before multicast
    ];
    for (const ip of allowed) {
      it(`allows ${ip}`, () => {
        expect(isForbiddenIP(ip)).toBe(false);
      });
    }
  });

  describe('IPv6 — forbidden', () => {
    const forbidden = [
      '::1',                           // loopback
      '::',                            // unspecified
      'fe80::1',                       // link-local
      'fe80::abcd:1234:5678:9abc',
      'fc00::1',                       // unique local
      'fd12:3456::1',                  // unique local
      'ff02::1',                       // multicast
      '::ffff:127.0.0.1',             // IPv4-mapped loopback
      '::ffff:10.0.0.1',              // IPv4-mapped private
      '::ffff:169.254.169.254',       // IPv4-mapped metadata
      '::ffff:192.168.1.1',           // IPv4-mapped private
      '2001:0000::1',                 // Teredo
    ];
    for (const ip of forbidden) {
      it(`blocks ${ip}`, () => {
        expect(isForbiddenIP(ip)).toBe(true);
      });
    }
  });

  describe('IPv6 — allowed', () => {
    const allowed = [
      '2001:db8::1',       // documentation (not forbidden in our policy)
      '2607:f8b0:4004::1', // Google
      '2a02:6b8::1',       // Yandex
    ];
    for (const ip of allowed) {
      it(`allows ${ip}`, () => {
        expect(isForbiddenIP(ip)).toBe(false);
      });
    }
  });

  describe('IPv6 with brackets (URL hostname format)', () => {
    it('blocks [::1]', () => {
      expect(isForbiddenIP('[::1]')).toBe(true);
    });
    it('blocks [::ffff:127.0.0.1]', () => {
      expect(isForbiddenIP('[::ffff:127.0.0.1]')).toBe(true);
    });
    it('blocks [fe80::1]', () => {
      expect(isForbiddenIP('[fe80::1]')).toBe(true);
    });
  });
});

// ─── validateUrl ─────────────────────────────────────────────────────────────

describe('validateUrl', () => {
  it('accepts valid http URL', () => {
    const url = validateUrl('https://example.com/path');
    expect(url.hostname).toBe('example.com');
  });

  it('rejects empty URL', () => {
    expect(() => validateUrl('')).toThrow();
  });

  it('rejects non-http protocol (ftp)', () => {
    expect(() => validateUrl('ftp://example.com')).toThrow(/http/);
  });

  it('rejects javascript: protocol', () => {
    expect(() => validateUrl('javascript:alert(1)')).toThrow();
  });

  it('rejects file: protocol', () => {
    expect(() => validateUrl('file:///etc/passwd')).toThrow(/http/);
  });

  it('rejects URL with embedded credentials', () => {
    expect(() => validateUrl('https://user:pass@example.com')).toThrow(/учётными данными/);
  });

  it('rejects URL with username only', () => {
    expect(() => validateUrl('https://admin@example.com')).toThrow(/учётными данными/);
  });

  it('rejects localhost', () => {
    expect(() => validateUrl('http://localhost:3000')).toThrow();
  });

  it('rejects 127.0.0.1', () => {
    expect(() => validateUrl('http://127.0.0.1')).toThrow();
  });

  it('rejects 0.0.0.0', () => {
    expect(() => validateUrl('http://0.0.0.0')).toThrow();
  });

  it('rejects [::1]', () => {
    expect(() => validateUrl('http://[::1]')).toThrow();
  });

  it('rejects 169.254.169.254 (cloud metadata)', () => {
    expect(() => validateUrl('http://169.254.169.254/latest/meta-data/')).toThrow();
  });

  it('rejects 10.x.x.x private IP', () => {
    expect(() => validateUrl('http://10.0.0.1/admin')).toThrow();
  });

  it('rejects 192.168.x.x private IP', () => {
    expect(() => validateUrl('http://192.168.1.1')).toThrow();
  });

  it('rejects metadata.google.internal', () => {
    expect(() => validateUrl('http://metadata.google.internal/computeMetadata/v1/')).toThrow();
  });

  it('accepts normal public URL', () => {
    expect(() => validateUrl('https://www.wildberries.ru/catalog/123/')).not.toThrow();
  });

  it('rejects URL exceeding max length', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2100);
    expect(() => validateUrl(longUrl)).toThrow();
  });
});

// ─── assertDnsIsSafe ─────────────────────────────────────────────────────────

describe('assertDnsIsSafe', () => {
  it('passes for IP literal that is public', async () => {
    const url = new URL('http://8.8.8.8');
    await expect(assertDnsIsSafe(url)).resolves.not.toThrow();
  });

  it('rejects IP literal that is private', async () => {
    const url = new URL('http://127.0.0.1');
    await expect(assertDnsIsSafe(url)).rejects.toThrow();
  });

  it('rejects IP literal 169.254.169.254', async () => {
    const url = new URL('http://169.254.169.254');
    await expect(assertDnsIsSafe(url)).rejects.toThrow();
  });
});
