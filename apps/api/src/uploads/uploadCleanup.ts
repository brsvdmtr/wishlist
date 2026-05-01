// Best-effort delete of a local upload file by URL.
//
// Behaviour kept identical to the previous inline version in index.ts:
//   - silently ignores null / empty URLs
//   - never touches external URLs (http:// or https://) — those aren't ours
//   - guards against path traversal: rejects basenames containing '..' or '/'
//   - also tries to delete the matching '-thumb.jpg' variant when the URL
//     points at a '-full.jpg' file (item photos and avatars)

import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR } from './upload.config';

export function deleteUploadFile(imageUrl: string | null): void {
  if (!imageUrl) return;
  // Only delete files we own (relative /api/uploads/ paths or bare filenames).
  // External URLs (http/https) are left untouched.
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) return;
  const filename = path.basename(imageUrl); // strips any leading /api/uploads/ etc.
  if (!filename || filename.includes('..') || filename.includes('/')) return;
  const filepath = path.join(UPLOAD_DIR, filename);
  fs.unlink(filepath, () => {}); // best-effort
  // Also try to delete the thumbnail variant
  const thumbName = filename.replace('-full.jpg', '-thumb.jpg');
  if (thumbName !== filename) {
    fs.unlink(path.join(UPLOAD_DIR, thumbName), () => {});
  }
}
