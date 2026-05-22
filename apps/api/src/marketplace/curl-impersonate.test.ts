/**
 * Tests for the curl-impersonate availability gate + argv builder.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isCurlImpersonateAvailable, buildCurlImpersonateArgs, curlImpersonateBin,
  fetchViaCurlImpersonate,
} from './curl-impersonate.js';

afterEach(() => {
  delete process.env.PARSER_CURL_IMPERSONATE_DISABLED;
  delete process.env.CURL_IMPERSONATE_BIN;
});

describe('curlImpersonateBin', () => {
  it('defaults to the Docker-image path', () => {
    expect(curlImpersonateBin()).toBe('/opt/curl-impersonate/curl-impersonate-wrapper');
  });
  it('honours the env override', () => {
    process.env.CURL_IMPERSONATE_BIN = '/usr/local/bin/curl_chrome131';
    expect(curlImpersonateBin()).toBe('/usr/local/bin/curl_chrome131');
  });
});

describe('isCurlImpersonateAvailable', () => {
  it('is off when the kill switch is set', () => {
    process.env.PARSER_CURL_IMPERSONATE_DISABLED = '1';
    expect(isCurlImpersonateAvailable()).toBe(false);
  });
  it('is off when the binary path does not exist', () => {
    process.env.CURL_IMPERSONATE_BIN = '/nonexistent/curl_chrome';
    expect(isCurlImpersonateAvailable()).toBe(false);
  });
});

describe('buildCurlImpersonateArgs', () => {
  it('refuses redirects (SSRF guard) and never passes -L', () => {
    const args = buildCurlImpersonateArgs('https://shop.com/p?a=1');
    expect(args).toContain('--max-redirs');
    expect(args[args.indexOf('--max-redirs') + 1]).toBe('0');
    expect(args).not.toContain('-L');
    expect(args).not.toContain('--location');
  });
  it('decodes compression and puts the URL last', () => {
    const args = buildCurlImpersonateArgs('https://shop.com/p');
    expect(args).toContain('--compressed');
    expect(args).toContain('--fail');
    expect(args[args.length - 1]).toBe('https://shop.com/p');
  });
  it('pins DNS with --resolve when a pin is supplied (SSRF guard)', () => {
    const args = buildCurlImpersonateArgs('https://shop.com/p', {
      pin: { host: 'shop.com', port: '443', ip: '93.184.216.34' },
    });
    expect(args).toContain('--resolve');
    expect(args[args.indexOf('--resolve') + 1]).toBe('shop.com:443:93.184.216.34');
    expect(args[args.length - 1]).toBe('https://shop.com/p');
  });
  it('brackets an IPv6 pin address', () => {
    const args = buildCurlImpersonateArgs('https://shop.com/p', {
      pin: { host: 'shop.com', port: '443', ip: '2606:2800:220:1:248:1893:25c8:1946' },
    });
    expect(args[args.indexOf('--resolve') + 1])
      .toBe('shop.com:443:[2606:2800:220:1:248:1893:25c8:1946]');
  });
  it('omits --resolve when no pin is supplied', () => {
    expect(buildCurlImpersonateArgs('https://shop.com/p')).not.toContain('--resolve');
  });
});

describe('fetchViaCurlImpersonate', () => {
  it('rejects with curl_impersonate_unavailable when the binary is absent', async () => {
    process.env.CURL_IMPERSONATE_BIN = '/nonexistent/curl_chrome';
    await expect(fetchViaCurlImpersonate('https://shop.com/p'))
      .rejects.toThrow('curl_impersonate_unavailable');
  });
});

describe('fetchViaCurlImpersonate (stub binary)', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'curl-imp-')); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  /** Write an executable /bin/sh stub and point CURL_IMPERSONATE_BIN at it. */
  function stub(script: string): void {
    const bin = join(dir, 'curl-stub.sh');
    writeFileSync(bin, `#!/bin/sh\n${script}\n`);
    chmodSync(bin, 0o755);
    process.env.CURL_IMPERSONATE_BIN = bin;
  }

  it('resolves with the binary stdout on success', async () => {
    const body = `<html>${'a'.repeat(600)}</html>`;
    stub(`printf '%s' '${body}'`);
    expect(await fetchViaCurlImpersonate('https://shop.com/p')).toBe(body);
  });

  it('rejects (curl_impersonate_empty) when the output is too small', async () => {
    stub(`printf 'tiny'`);
    await expect(fetchViaCurlImpersonate('https://shop.com/p'))
      .rejects.toThrow('curl_impersonate_empty');
  });

  it('rejects (curl_impersonate_failed) when the binary exits non-zero', async () => {
    stub('exit 22');
    await expect(fetchViaCurlImpersonate('https://shop.com/p'))
      .rejects.toThrow('curl_impersonate_failed');
  });
});
