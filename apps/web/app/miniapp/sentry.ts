let sentryInitialized = false;

export function initSentry(): void {
  const dsn = process.env.NEXT_PUBLIC_GLITCHTIP_DSN;
  if (!dsn || sentryInitialized) return;

  import('@sentry/browser').then((Sentry) => {
    Sentry.init({
      dsn,
      environment: process.env.NEXT_PUBLIC_GLITCHTIP_ENVIRONMENT || process.env.NODE_ENV || 'production',
      release: process.env.NEXT_PUBLIC_APP_RELEASE || 'unknown',
      sampleRate: 1.0,
      // Don't capture breadcrumbs — too verbose for Mini App
      integrations: [],
    });
    sentryInitialized = true;
  }).catch(() => {
    // Silent — error tracking itself must not throw
  });
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!sentryInitialized) return;
  import('@sentry/browser').then((Sentry) => {
    Sentry.captureException(error, context ? { extra: context } : undefined);
  }).catch(() => {});
}
