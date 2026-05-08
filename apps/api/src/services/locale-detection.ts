// Multi-signal market bucket detection for the godmode "Сегменты" dashboard.
//
// The single-signal `deriveMarketBucket(language_code)` path leaves up to
// 77% of users in the 'unknown' bucket because Telegram doesn't always
// populate `language_code` (some clients, some platforms, older versions).
// This service collects every signal we can cheaply observe on an inbound
// HTTPS request — Telegram language_code, browser-supplied
// X-Browser-Language / X-Browser-Timezone headers, server-side IP
// geolocation, and Unicode-script analysis of the user's first_name —
// and asks the shared resolver for the strongest match.
//
// Layering: shared/i18n owns the priority chain + map data; this service
// owns the IP→country translation and the request-shape glue. Bot-side
// reuses the shared resolver directly (no IP available).

import type { Request } from 'express';
import {
  resolveMarketBucket,
  type MarketBucketResolution,
  type MarketBucketSignals,
} from '@wishlist/shared';
import { getClientIp } from '../security/ipHash';

// geoip-lite is loaded lazily so that boot doesn't slow down or fail when
// the kill switch is off. Its 100+ MB binary database loads into memory
// on first lookup; once loaded, lookups are sub-millisecond.
let _geoipModule: typeof import('geoip-lite') | null = null;
let _geoipLoadFailed = false;

function getGeoip(): typeof import('geoip-lite') | null {
  if (_geoipModule) return _geoipModule;
  if (_geoipLoadFailed) return null;
  try {
    // Synchronous require — geoip-lite preloads its binary database here.
    // Wrapping in try/catch so a missing/corrupt DB never breaks the auth path.
    _geoipModule = require('geoip-lite') as typeof import('geoip-lite');
    return _geoipModule;
  } catch {
    _geoipLoadFailed = true;
    return null;
  }
}

/** Look up ISO 3166-1 alpha-2 country code for an IP, or null on miss. */
export function lookupCountryByIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const geoip = getGeoip();
  if (!geoip) return null;
  try {
    const result = geoip.lookup(ip);
    return result?.country ?? null;
  } catch {
    return null;
  }
}

/** Read X-Browser-Language header (sent by Mini App `tgFetch`). */
function readBrowserLanguage(req: Request): string | null {
  const raw = req.get('X-Browser-Language');
  if (!raw) return null;
  // Header is `navigator.language`, e.g. 'ru-RU' or 'en-US'. Cap length to
  // protect against malformed clients sending a 1 KB blob.
  return raw.length <= 35 ? raw : null;
}

/** Read X-Browser-Timezone header (IANA zone, e.g. 'Europe/Moscow'). */
function readBrowserTimezone(req: Request): string | null {
  const raw = req.get('X-Browser-Timezone');
  if (!raw) return null;
  // IANA timezone names are at most ~40 chars. Reject anything longer.
  return raw.length <= 64 ? raw : null;
}

export interface RequestBucketContext {
  /** Optional first_name for the script-analysis fallback. Not on req. */
  firstName?: string | null;
}

/**
 * Resolve the user's market bucket from every signal observable on the
 * current Express request, plus the optional persisted first_name.
 *
 * Returns `{ bucket: 'unknown', source: 'unknown' }` when no signal yields
 * a recognised bucket; the caller persists this so the dashboard correctly
 * reflects genuinely-undetectable users.
 */
export function resolveBucketFromRequest(
  req: Request,
  ctx: RequestBucketContext = {},
): MarketBucketResolution {
  const languageCode = req.tgUser?.language_code ?? null;
  const browserLanguage = readBrowserLanguage(req);
  const timezone = readBrowserTimezone(req);
  const countryCode = lookupCountryByIp(getClientIp(req));

  const signals: MarketBucketSignals = {
    languageCode,
    browserLanguage,
    timezone,
    countryCode,
    firstName: ctx.firstName ?? null,
  };

  return resolveMarketBucket(signals);
}
