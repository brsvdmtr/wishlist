import { describe, it, expect, vi } from 'vitest';
import { withChunkRetry } from './chunkRetry';

function chunkError(message = 'Loading chunk 1234 failed.'): Error {
  const err = new Error(message);
  err.name = 'ChunkLoadError';
  return err;
}

describe('withChunkRetry', () => {
  it('returns the value when first attempt succeeds (no retry)', async () => {
    const importer = vi.fn(async () => ({ default: 'mod' }));
    const wrapped = withChunkRetry(importer);

    const result = await wrapped();

    expect(result).toEqual({ default: 'mod' });
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('retries once on ChunkLoadError (by name) and returns the second result', async () => {
    let calls = 0;
    const wrapped = withChunkRetry(async () => {
      calls++;
      if (calls === 1) throw chunkError();
      return { default: 'mod' };
    });

    const result = await wrapped();

    expect(result).toEqual({ default: 'mod' });
    expect(calls).toBe(2);
  });

  it('retries on "Loading chunk N failed" message even without ChunkLoadError name', async () => {
    let calls = 0;
    const wrapped = withChunkRetry(async () => {
      calls++;
      if (calls === 1) throw new Error('Loading chunk 7679 failed.\n(error: https://x.example/chunks/7679.js)');
      return { default: 'mod' };
    });

    await wrapped();
    expect(calls).toBe(2);
  });

  it('propagates non-chunk errors immediately (no retry on real bugs)', async () => {
    const importer = vi.fn(async () => { throw new TypeError('Cannot read property X'); });
    const wrapped = withChunkRetry(importer);

    await expect(wrapped()).rejects.toThrow('Cannot read property X');
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('propagates ChunkLoadError if both attempts fail (boundary takes over)', async () => {
    const importer = vi.fn(async () => { throw chunkError('Loading chunk 99 failed.'); });
    const wrapped = withChunkRetry(importer);

    await expect(wrapped()).rejects.toThrow(/Loading chunk 99 failed/);
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it('waits ~500ms between attempts', async () => {
    let calls = 0;
    const wrapped = withChunkRetry(async () => {
      calls++;
      if (calls === 1) throw chunkError();
      return { default: 'mod' };
    });

    const start = Date.now();
    await wrapped();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(1500);
  });
});
