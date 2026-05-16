// Sentry / GlitchTip init. Side-effect-only module.
//
// Must be imported AFTER ./env so GLITCHTIP_DSN and friends are populated
// from .env in dev. No-ops when GLITCHTIP_DSN is not set, exactly like the
// previous inline init.
//
// Other modules that need to capture errors (index.ts error handler,
// uncaughtException / unhandledRejection handlers) should still import
// `* as Sentry from '@sentry/node'` and call Sentry.captureException directly
// — Node's module cache makes this a singleton, so init done here is visible
// everywhere.

import * as Sentry from '@sentry/node';
import { sanitizeUrlForLog } from '../lib/logSafety';

if (process.env.GLITCHTIP_DSN) {
  Sentry.init({
    dsn: process.env.GLITCHTIP_DSN,
    environment: process.env.GLITCHTIP_ENVIRONMENT || process.env.NODE_ENV || 'production',
    release: process.env.APP_RELEASE || 'unknown',
    // Strip privacy-sensitive query params (raw search query `q`) from the
    // request context before the event leaves the process. Mirrors the
    // pino-http req.url redaction in middleware/requestLogger.ts so the
    // "raw query never logged" invariant from docs/GLOBAL_SEARCH.md holds
    // across both transports.
    beforeSend(event) {
      const req = event.request;
      if (req?.url) {
        const cleaned = sanitizeUrlForLog(req.url);
        if (cleaned) req.url = cleaned;
      }
      if (req?.query_string && typeof req.query_string === 'string' && req.query_string.includes('q=')) {
        req.query_string = req.query_string.replace(/(^|&)q=[^&]*/g, '$1q=[REDACTED]');
      }
      return event;
    },
  });
}
