// Upload runtime config: storage directory, allowed MIME types, multer instance.
// Side-effect: creates UPLOAD_DIR (mkdir -p) at module load. This matches the
// previous inline behaviour in index.ts and keeps the directory ready before
// any handler tries to write into it.
//
// `upload` uses memory storage so sharp can process the buffer directly, with
// no temp files on disk. The 30 MB limit is the hard upper bound; route-level
// constraints (full vs thumb sizes, etc.) live in the image processor.

import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';

export const UPLOAD_DIR =
  (process.env.UPLOAD_DIR ?? '').trim() || path.join(process.cwd(), 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error('Unsupported file type. Use JPEG, PNG, WebP, or GIF.'));
    }
    cb(null, true);
  },
});
