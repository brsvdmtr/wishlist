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

if (process.env.GLITCHTIP_DSN) {
  Sentry.init({
    dsn: process.env.GLITCHTIP_DSN,
    environment: process.env.GLITCHTIP_ENVIRONMENT || process.env.NODE_ENV || 'production',
    release: process.env.APP_RELEASE || 'unknown',
  });
}
