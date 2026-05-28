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
import net from 'node:net';
import path from 'node:path';
import { fetch as undiciFetch, Agent } from 'undici';
import { UPLOAD_DIR } from './upload.config';
import { validateUrl, assertDnsIsSafe } from '../url-parser.js';

// Cap input pixel area before sharp decodes — guards against decompression
// bombs (a small WebP/PNG can pack a huge canvas, which expands to gigabytes
// of RGBA in libvips). 50 M pixels = ~7 k × 7 k, comfortably above any real
// product photo, well below the libvips default of 268 M.
const SHARP_INPUT_PIXEL_LIMIT = 50_000_000;

/**
 * Magic-byte sniff for the four image formats we accept (mirrors
 * `ALLOWED_MIME_TYPES` in upload.config.ts).
 *
 * Why this exists on top of multer's MIME check: multer's fileFilter reads
 * `file.mimetype` from the multipart Content-Type header, which is fully
 * client-controlled. An attacker can claim `image/jpeg` while sending an
 * SVG body (or any other format). Sharp would still re-encode the result
 * to JPEG and strip the foreign payload, but the rejection should happen
 * one step earlier — before any decoder touches arbitrary attacker bytes.
 *
 * Returns `false` for anything that isn't a JPEG/PNG/GIF/WebP file header.
 * Notably rejects SVG (XML-based, no fixed magic) and BMP/TIFF/HEIC.
 */
export function hasAllowedImageMagic(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return true;
  // GIF: GIF87a / GIF89a
  if (
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61
  ) return true;
  // WebP: 'RIFF' .... 'WEBP'
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return true;
  return false;
}

export async function processImage(
  buffer: Buffer,
  opts: { maxDim: number; quality?: number; suffix?: string },
): Promise<{ filename: string; filepath: string; sizeBytes: number; width: number; height: number }> {
  if (!hasAllowedImageMagic(buffer)) {
    // Client claimed an allowed MIME but the bytes don't match. Reject before
    // sharp's decoder sees attacker input. This catches SVG-claimed-as-JPEG,
    // BMP/TIFF/HEIC slipping past the MIME allowlist, and arbitrary files
    // (PDFs, archives, scripts) being uploaded with `image/*` Content-Type.
    throw new Error('Unsupported file type. Use JPEG, PNG, WebP, or GIF.');
  }
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
// guard the HTML fetch in url-parser, AND pins the connection IP through a
// per-call undici Agent with a `connect.lookup` override. assertDnsIsSafe
// returns the validated A/AAAA records; we hand the first one to the
// dispatcher so undici never re-resolves the hostname at connect time,
// closing the DNS-rebinding window between validation and connect. Same
// pattern curl-impersonate uses via its `pin` option in marketplace flows.
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
  const safeIps = await assertDnsIsSafe(url);
  if (safeIps.length === 0) {
    throw new Error('DNS resolution failed for image fetch');
  }
  // Pin the first validated IP into the dispatcher so undici doesn't issue
  // a second DNS query at connect time (which an attacker could rebind to
  // an internal address). family is inferred from the literal so undici
  // creates the right socket type.
  const pinnedIp = safeIps[0]!;
  const family = net.isIPv6(pinnedIp) ? 6 : 4;
  const pinDispatcher = new Agent({
    connect: {
      lookup: (_host, _opts, cb) => cb(null, pinnedIp, family),
    },
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await undiciFetch(url.href, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': FETCH_USER_AGENT,
        'Accept': 'image/jpeg,image/png,image/webp,image/gif,image/*;q=0.8',
      },
      redirect: 'manual',
      dispatcher: pinDispatcher,
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
    // Release the pinned dispatcher's keep-alive sockets — we never reuse
    // it across calls, and leaving it open would hold a connection per
    // import. Swallow rejections; close failure isn't actionable.
    await pinDispatcher.close().catch(() => { /* ignore */ });
  }
}
