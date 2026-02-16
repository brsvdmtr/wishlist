/**
 * SITE_URL for WebApp: must be HTTPS in production.
 * If env gives http, replace with https and log warning.
 */
function getSiteUrl(): string {
  const raw =
    (process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(
      /\/+$/,
      '',
    );
  if (raw.startsWith('http://') && !raw.includes('localhost')) {
    const https = raw.replace(/^http:\/\//i, 'https://');
    // eslint-disable-next-line no-console
    console.warn('[bot] SITE_URL was http, using https for menu button:', https);
    return https;
  }
  return raw;
}

export const SITE_URL = getSiteUrl();

/** Base URL for menu button when no deep-link: open /app (WebApp entry). */
export function getMenuButtonBaseUrl(): string {
  return `${SITE_URL}/app`;
}

export function getMenuButtonUrlForSlug(slug: string): string {
  return `${SITE_URL}/w/${slug}`;
}
