import { PrismaClient } from '@wishlist/db';
import { ANALYTICS_EVENTS, type AnalyticsEventName } from '@wishlist/shared';
import logger from './logger';

// Truncation limits for specific props fields
const TRUNCATE_LIMITS: Record<string, number> = {
  errorSummary: 200,
  userAgent: 120,
};
const DEFAULT_STRING_LIMIT = 300;
const MAX_PROPS_BYTES = 1024;

function truncateProps(props: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!props) return undefined;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'string') {
      const limit = TRUNCATE_LIMITS[key] ?? DEFAULT_STRING_LIMIT;
      cleaned[key] = value.length > limit ? value.slice(0, limit) + '...' : value;
    } else {
      cleaned[key] = value;
    }
  }
  // Check total serialized size
  if (JSON.stringify(cleaned).length > MAX_PROPS_BYTES) {
    // Drop least important fields until under limit
    const keys = Object.keys(cleaned);
    for (let i = keys.length - 1; i >= 0 && JSON.stringify(cleaned).length > MAX_PROPS_BYTES; i--) {
      const k = keys[i];
      if (k !== undefined) delete cleaned[k];
    }
  }
  return cleaned;
}

const analyticsEventSet = new Set<string>(ANALYTICS_EVENTS);

export function trackAnalyticsEvent(
  prisma: PrismaClient,
  params: {
    event: AnalyticsEventName;
    userId?: string;
    props?: Record<string, unknown>;
  }
): void {
  if (!analyticsEventSet.has(params.event)) {
    logger.warn({ event: params.event }, 'Unknown analytics event name, skipping');
    return;
  }
  const cleanedProps = truncateProps(params.props);
  prisma.analyticsEvent.create({
    data: {
      event: params.event,
      userId: params.userId ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props: cleanedProps ? (cleanedProps as any) : undefined,
    },
  }).catch((err: unknown) => {
    logger.error({ err, event: params.event }, 'Failed to write analytics event');
  });
}
