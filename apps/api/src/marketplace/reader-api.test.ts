/**
 * Tests for the Jina Reader free fallback config + URL builder.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isJinaReaderEnabled, buildJinaReaderUrl } from './reader-api.js';

afterEach(() => {
  delete process.env.PARSER_JINA_DISABLED;
  delete process.env.JINA_READER_URL;
});

describe('isJinaReaderEnabled', () => {
  it('is on by default — the tier is free and keyless', () => {
    expect(isJinaReaderEnabled()).toBe(true);
  });
  it('honours the kill switch', () => {
    process.env.PARSER_JINA_DISABLED = '1';
    expect(isJinaReaderEnabled()).toBe(false);
  });
});

describe('buildJinaReaderUrl', () => {
  it('prefixes the target URL with the reader endpoint', () => {
    expect(buildJinaReaderUrl('https://shop.com/p/1'))
      .toBe('https://r.jina.ai/https://shop.com/p/1');
  });
  it('honours the JINA_READER_URL override and normalises the trailing slash', () => {
    process.env.JINA_READER_URL = 'https://reader.example.com';
    expect(buildJinaReaderUrl('https://x.com'))
      .toBe('https://reader.example.com/https://x.com');
  });
});
