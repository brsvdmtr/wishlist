// Mounts the static /uploads route. Identical to the previous inline call:
//   app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));
//
// In production, nginx forwards /api/* to api:3001, so a request for
// GET /api/uploads/<filename> arrives here as GET /uploads/<filename>.
// Cache headers (30-day immutable) are unchanged.

import type { Express } from 'express';
import express from 'express';
import { UPLOAD_DIR } from './upload.config';

export function registerUploads(app: Express): void {
  app.use(
    '/uploads',
    express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }),
  );
}
