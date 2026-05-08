// processImage — sharp-based image pipeline shared by item photos, profile
// avatars, gift-occasion-idea photos, and showcase covers.
//
// Behaviour kept identical to the previous inline version in index.ts:
//   - auto-rotate from EXIF
//   - strip all EXIF/metadata (privacy)
//   - resize to fit within maxDim x maxDim (no enlargement)
//   - convert to JPEG with mozjpeg encoder, default quality 80
//   - filename format: <uuid>-<suffix>.jpg

import sharp from 'sharp';
import crypto from 'node:crypto';
import path from 'node:path';
import { UPLOAD_DIR } from './upload.config';
import { validateUrl, assertDnsIsSafe } from '../url-parser.js';

// Cap input pixel area before sharp decodes — guards against decompression
// bombs (a small WebP/PNG can pack a huge canvas, which expands to gigabytes
// of RGBA in libvips). 50 M pixels = ~7 k × 7 k, comfortably above any real
// product photo, well below the libvips default of 268 M.
const SHARP_INPUT_PIXEL_LIMIT = 50_000_000;

export async function processImage(
  buffer: Buffer,
  opts: { maxDim: number; quality?: number; suffix?: string },
): Promise<{ filename: string; filepath: string; sizeBytes: number; width: number; height: number }> {
  const id = crypto.randomUUID();
  const suffix = opts.suffix ?? 'full';
  const filename = `${id}-${suffix}.jpg`;
  const filepath = path.join(UPLOAD_DIR, filename);

  const result = await sharp(buffer, { limitInputPixels: SHARP_INPUT_PIXEL_LIMIT })
    .rotate() // auto-rotate from EXIF
    .resize(opts.maxDim, opts.maxDim, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: opts.quality ?? 80, mozjpeg: true })
    .toFile(filepath);

  return {
    filename,
    filepath,
    sizeBytes: result.size,
    width: result.width,
    height: result.height,
  };
}

// downloadAndProcessImage — fetch a remote image and pipe through processImage.
// Used by URL-import flow to cache marketplace product photos on our own
// uploads dir, so the Mini App stops loading 1-3 MB originals from external
// CDNs (Yandex / WB / Ozon) for 88px thumbnails.
//
// SSRF defence reuses the same validateUrl + assertDnsIsSafe helpers that
// guard the HTML fetch in url-parser.
//
// NOTE on TOCTOU: assertDnsIsSafe resolves DNS, then fetch() resolves it
// again — a DNS-rebinding attacker can flip the answer between the two
// calls. Same window the existing fetchHtml has; closing it requires
// resolving once and passing the IP via undici's `lookup` option, which
// is out of scope here. Documented so future readers don't assume the
// SSRF check is bulletproof.
//
// Redirects are not followed (manual mode + reject 3xx) — marketplace
// image CDNs serve direct URLs.
//
// Failure is non-fatal for the caller: the function throws and the caller
// is expected to fall back to storing the remote URL as-is.

const DEFAULT_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 15 * 1024 * 1024; // 15 MB hard cap before sharp
const FETCH_USER_AGENT =
  'Mozilla/5.0 (compatible; WishBot-ImageFetcher/1.0; +https://t.me/WishBot)';

// Strict content-type allowlist. Mirrors ALLOWED_MIME_TYPES in upload.config.ts.
// Excludes image/svg+xml deliberately: SVG can carry XML external entities,
// scripts, and javascript: URLs, and sharp will rasterise it without any of
// those being stripped at the Express layer.
const ALLOWED_REMOTE_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

export async function downloadAndProcessImage(
  imageUrl: string,
  opts: {
    maxDim: number;
    quality?: number;
    suffix?: string;
    timeoutMs?: number;
    maxBytes?: number;
  },
): Promise<{ filename: string; filepath: string; sizeBytes: number; width: number; height: number }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const url = validateUrl(imageUrl);
  await assertDnsIsSafe(url);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url.href, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': FETCH_USER_AGENT,
        'Accept': 'image/jpeg,image/png,image/webp,image/gif,image/*;q=0.8',
      },
      redirect: 'manual',
    });

    if (res.status >= 300 && res.status < 400) {
      throw new Error(`Redirect not followed (${res.status})`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Strict content-type guard. Strip any `; charset=...` parameter before
    // matching against the allowlist.
    const ctRaw = (res.headers.get('content-type') || '').toLowerCase();
    const ct = ctRaw.split(';')[0]!.trim();
    if (!ALLOWED_REMOTE_IMAGE_MIMES.has(ct)) {
      throw new Error(`Not an allowed image type: ${ct || 'no content-type'}`);
    }

    // Pre-flight Content-Length check — informational, may lie or be missing.
    const cl = Number(res.headers.get('content-length') || 0);
    if (cl > maxBytes) throw new Error(`Image too large: ${cl} bytes`);

    // Stream-and-cap: don't buffer the whole body via arrayBuffer() — a
    // chunked-encoding response with no Content-Length (or one that lies)
    // would otherwise let an attacker push unbounded bytes into RAM before
    // the post-buffer size check fires. Same pattern as fetchHtml in
    // url-parser.ts.
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No body');
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          throw new Error(`Image too large: ${total}+ bytes`);
        }
        chunks.push(value);
      }
    } finally {
      // Release the underlying connection on every exit path. cancel() may
      // be a no-op for a fully-consumed reader (natural EOF) or unblock the
      // body stream for an early throw (cap exceeded); either way swallow
      // the resulting Promise — we don't want a stray rejection masking the
      // real error.
      reader.cancel().catch(() => { /* ignore */ });
    }

    return processImage(Buffer.concat(chunks, total), opts);
  } finally {
    clearTimeout(timer);
  }
}
