/**
 * marketplace/fetch-util.ts — shared response-body helpers
 */

/**
 * Read a fetch Response body as UTF-8 text, hard-capped at `maxBytes`. Streams
 * chunk by chunk and stops — cancelling the body — once the cap is reached, so
 * a malicious or misbehaving endpoint cannot OOM the process with a huge (or
 * unbounded) response. Plain `await res.text()` would buffer the whole body
 * into memory before any size check could run.
 *
 * Accepts the Response `body` stream directly so it works for both Node's
 * global fetch and undici's fetch.
 */
export async function readCappedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      // Trim the chunk that would cross the cap, so the buffered total is
      // provably ≤ maxBytes even if a server streams one oversized chunk.
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // Release the connection; harmless if the stream already ended.
    await reader.cancel().catch(() => { /* body already closed */ });
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}
