// Best-effort delete of a local upload file by URL.
//
// Behaviour kept identical to the previous inline version in index.ts:
//   - silently ignores null / empty URLs
//   - never touches external URLs (http:// or https://) — those aren't ours
//   - guards against path traversal: rejects basenames containing '..' or '/'
//   - also tries to delete the matching '-thumb.jpg' variant when the URL
//     points at a '-full.jpg' file (item photos and avatars)
//
// Unlink itself is fire-and-forget (no Promise returned) so callers can use
// it on hot paths without awaiting. Non-ENOENT errors are logged so an
// operator can spot a real storage leak (permissions, EBUSY, FS full); a
// missing file is the expected case after manual cleanup or volume reset.

import fs from 'node:fs';
import path from 'node:path';
import logger from '../logger';
import { UPLOAD_DIR } from './upload.config';

function unlinkAndLog(filepath: string): void {
  fs.unlink(filepath, (err) => {
    if (err && err.code !== 'ENOENT') {
      logger.warn(
        { event: 'upload.unlink_failed', filepath, code: err.code, err: err.message },
        'failed to delete upload file',
      );
    }
  });
}

export function deleteUploadFile(imageUrl: string | null): void {
  if (!imageUrl) return;
  // Only delete files we own (relative /api/uploads/ paths or bare filenames).
  // External URLs (http/https) are left untouched.
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) return;
  const filename = path.basename(imageUrl); // strips any leading /api/uploads/ etc.
  if (!filename || filename.includes('..') || filename.includes('/')) return;
  unlinkAndLog(path.join(UPLOAD_DIR, filename));
  // Also try to delete the thumbnail variant
  const thumbName = filename.replace('-full.jpg', '-thumb.jpg');
  if (thumbName !== filename) {
    unlinkAndLog(path.join(UPLOAD_DIR, thumbName));
  }
}
