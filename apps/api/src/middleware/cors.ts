// CORS middleware. Identical to the previous inline cors() call in index.ts:
//   - allow same-origin / non-browser (no Origin header)
//   - allow exactly WEB_ORIGIN
//   - reject everything else cleanly (cb(null, false)) — never throw, so this
//     never bubbles into the express error handler as a fake "unhandled" alert
//   - log rejections at warn level, once per reject, so we can identify probes
//
// Allowed headers MUST include Idempotency-Key — without it the browser strips
// the header on preflight and the security layer never sees it.
//
// WEB_ORIGIN is read at module-load time. This module must be imported AFTER
// ./bootstrap/env so dotenv has populated process.env.

import cors from 'cors';
import logger from '../logger';

const WEB_ORIGIN = (process.env.WEB_ORIGIN ?? '').trim() || 'http://localhost:3000';

export const corsMiddleware = cors({
  origin: (origin, cb) => {
    // Allow non-browser requests (curl, server-to-server).
    if (!origin) return cb(null, true);
    if (origin === WEB_ORIGIN) return cb(null, true);
    logger.warn({ rejectedOrigin: origin }, 'CORS reject');
    return cb(null, false);
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-ADMIN-KEY', 'X-TG-INIT-DATA', 'X-TG-DEV', 'X-INTERNAL-KEY', 'Idempotency-Key', 'X-Browser-Language', 'X-Browser-Timezone'],
});
