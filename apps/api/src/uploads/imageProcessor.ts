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
