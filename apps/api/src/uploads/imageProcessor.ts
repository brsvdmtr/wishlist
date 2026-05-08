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

export async function processImage(
  buffer: Buffer,
  opts: { maxDim: number; quality?: number; suffix?: string },
): Promise<{ filename: string; filepath: string; sizeBytes: number; width: number; height: number }> {
  const id = crypto.randomUUID();
  const suffix = opts.suffix ?? 'full';
  const filename = `${id}-${suffix}.jpg`;
  const filepath = path.join(UPLOAD_DIR, filename);

  const result = await sharp(buffer)
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
// guard the HTML fetch in url-parser. Redirects are not followed
// (manual mode + reject 3xx) — marketplace image CDNs serve direct URLs.
//
// Failure is non-fatal for the caller: the function throws and the caller
// is expected to fall back to storing the remote URL as-is.

const DEFAULT_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 15 * 1024 * 1024; // 15 MB hard cap before sharp
const FETCH_USER_AGENT =
  'Mozilla/5.0 (compatible; WishBot-ImageFetcher/1.0; +https://t.me/WishBot)';

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
        'Accept': 'image/*,*/*;q=0.8',
      },
      redirect: 'manual',
    });

    if (res.status >= 300 && res.status < 400) {
      throw new Error(`Redirect not followed (${res.status})`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('image/')) {
      throw new Error(`Not an image: ${ct || 'no content-type'}`);
    }

    const cl = Number(res.headers.get('content-length') || 0);
    if (cl > maxBytes) throw new Error(`Image too large: ${cl} bytes`);

    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      throw new Error(`Image too large: ${ab.byteLength} bytes`);
    }

    return processImage(Buffer.from(ab), opts);
  } finally {
    clearTimeout(timer);
  }
}
