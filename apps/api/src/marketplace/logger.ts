/**
 * marketplace/logger.ts — Structured logging for the parser pipeline
 *
 * Provides a consistent, parseable log format for:
 *   - Strategy execution (start, success, failure, duration)
 *   - Field extraction results (source, confidence)
 *   - Merge decisions (which strategy won per field)
 *   - Cache hits/misses
 *   - Error reporting
 */

import type { MarketplaceId, StrategyResult, ParsedProduct, FieldValue } from './types.js';

// ─── Log Levels ──────────────────────────────────────────────────────────────

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info:  1,
  warn:  2,
  error: 3,
};

const currentLogLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) ?? 'info';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLogLevel];
}

// ─── Structured Logger ───────────────────────────────────────────────────────

export interface ParseLogEntry {
  ts: string;
  level: LogLevel;
  module: 'parser';
  event: string;
  marketplace?: MarketplaceId;
  hostname?: string;
  productId?: string | null;
  strategy?: string;
  durationMs?: number;
  confidence?: number;
  fields?: Record<string, { confidence: number; source: string } | null>;
  error?: string;
  [key: string]: unknown;
}

function emit(entry: ParseLogEntry): void {
  if (!shouldLog(entry.level)) return;

  // In production, emit JSON for log aggregation
  if (process.env.NODE_ENV === 'production') {
    const fn = entry.level === 'error' ? console.error
             : entry.level === 'warn'  ? console.warn
             : console.log;
    fn(JSON.stringify(entry));
    return;
  }

  // In development, emit human-readable format
  const prefix = `[parser]`;
  const parts: string[] = [prefix];

  if (entry.marketplace && entry.marketplace !== 'unknown') {
    parts.push(`[${entry.marketplace}]`);
  }
  if (entry.hostname) {
    parts.push(entry.hostname);
  }

  parts.push(entry.event);

  if (entry.strategy) {
    parts.push(`strategy=${entry.strategy}`);
  }
  if (entry.durationMs !== undefined) {
    parts.push(`${entry.durationMs}ms`);
  }
  if (entry.confidence !== undefined) {
    parts.push(`confidence=${entry.confidence}`);
  }
  if (entry.error) {
    parts.push(`error="${entry.error}"`);
  }

  const msg = parts.join(' ');
  const fn = entry.level === 'error' ? console.error
           : entry.level === 'warn'  ? console.warn
           : console.log;
  fn(msg);
}

// ─── Logger API ──────────────────────────────────────────────────────────────

export const parseLog = {
  /** Log the start of a parse request */
  parseStart(hostname: string, marketplace: MarketplaceId, productId: string | null): void {
    emit({
      ts: new Date().toISOString(),
      level: 'info',
      module: 'parser',
      event: 'parse_start',
      hostname,
      marketplace,
      productId,
    });
  },

  /** Log a cache hit */
  cacheHit(hostname: string, cacheType: 'positive' | 'negative'): void {
    emit({
      ts: new Date().toISOString(),
      level: 'debug',
      module: 'parser',
      event: `cache_${cacheType}`,
      hostname,
    });
  },

  /** Log strategy execution start */
  strategyStart(strategy: string, marketplace: MarketplaceId): void {
    emit({
      ts: new Date().toISOString(),
      level: 'debug',
      module: 'parser',
      event: 'strategy_start',
      strategy,
      marketplace,
    });
  },

  /** Log strategy result */
  strategyResult(result: StrategyResult, marketplace: MarketplaceId): void {
    const fields: ParseLogEntry['fields'] = {};
    if (result.title)       fields['title']       = { confidence: result.title.confidence, source: result.title.source };
    if (result.description) fields['description'] = { confidence: result.description.confidence, source: result.description.source };
    if (result.price)       fields['price']       = { confidence: result.price.confidence, source: result.price.source };
    if (result.image)       fields['image']       = { confidence: result.image.confidence, source: result.image.source };

    emit({
      ts: new Date().toISOString(),
      level: result.error ? 'warn' : 'info',
      module: 'parser',
      event: result.error ? 'strategy_error' : 'strategy_done',
      strategy: result.strategyName,
      marketplace,
      durationMs: result.durationMs,
      fields,
      error: result.error,
    });
  },

  /** Log final merged product result */
  parseResult(
    hostname: string,
    marketplace: MarketplaceId,
    product: ParsedProduct,
    totalDurationMs: number,
  ): void {
    const fieldSummary = (f: FieldValue<unknown> | null) =>
      f ? { confidence: f.confidence, source: f.source } : null;

    emit({
      ts: new Date().toISOString(),
      level: 'info',
      module: 'parser',
      event: 'parse_done',
      hostname,
      marketplace,
      confidence: product.overallConfidence,
      durationMs: totalDurationMs,
      fields: {
        title:       fieldSummary(product.title),
        description: fieldSummary(product.description),
        price:       fieldSummary(product.price),
        image:       fieldSummary(product.image),
      },
      titlePreview: product.title?.value.slice(0, 50) ?? null,
      pricePreview: product.price?.value.formatted ?? null,
    });
  },

  /** Log parse failure */
  parseError(hostname: string, marketplace: MarketplaceId, error: string): void {
    emit({
      ts: new Date().toISOString(),
      level: 'error',
      module: 'parser',
      event: 'parse_error',
      hostname,
      marketplace,
      error,
    });
  },

  /** Log anti-bot detection */
  antiBotDetected(hostname: string, marketplace: MarketplaceId): void {
    emit({
      ts: new Date().toISOString(),
      level: 'warn',
      module: 'parser',
      event: 'antibot_detected',
      hostname,
      marketplace,
    });
  },

  /** Log browser diagnostic trail (navigation status, intercepted responses, HTML indicators) */
  browserDiag(
    hostname: string,
    marketplace: MarketplaceId,
    diag: {
      navigationStatus?: string;
      interceptedJsonCount?: number;
      htmlLength?: number;
      hasOgTitle?: boolean;
      hasJsonLd?: boolean;
      isCheckPage?: boolean;
      firstJsonUrls?: string[];
    },
  ): void {
    emit({
      ts: new Date().toISOString(),
      level: 'info',
      module: 'parser',
      event: 'browser_diag',
      hostname,
      marketplace,
      ...diag,
    });
  },
};
