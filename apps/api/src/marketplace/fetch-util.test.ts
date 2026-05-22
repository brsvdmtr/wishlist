/**
 * Tests for the streaming, byte-capped response-body reader.
 */
import { describe, it, expect } from 'vitest';
import { readCappedText } from './fetch-util.js';

/** A ReadableStream that emits the given string parts as UTF-8 chunks. */
function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
}

describe('readCappedText', () => {
  it('returns the full body when it is under the cap', async () => {
    expect(await readCappedText(streamOf('hello ', 'world'), 1024)).toBe('hello world');
  });
  it('hard-caps an over-size body at maxBytes — never buffers it whole', async () => {
    const r = await readCappedText(streamOf('a'.repeat(100), 'b'.repeat(100)), 50);
    expect(r.length).toBe(50);
    expect(r).toBe('a'.repeat(50));
  });
  it('trims a single chunk that alone exceeds the cap', async () => {
    const r = await readCappedText(streamOf('x'.repeat(5000)), 64);
    expect(r.length).toBe(64);
  });
  it('returns an empty string for a null body', async () => {
    expect(await readCappedText(null, 1024)).toBe('');
  });
});
