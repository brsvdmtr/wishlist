/**
 * marketplace/orchestrator.ts — Main entry point for the new parser pipeline
 *
 * Replaces the old `parseUrl()` flow with a marketplace-aware orchestrator:
 *   1. Normalize URL → detect marketplace + extract product ID
 *   2. Check cache (by canonical URL or product key)
 *   3. Execute strategies in priority order, stopping early when confidence is high
 *   4. Merge strategy results at the field level
 *   5. Apply guards (anti-bot, garbage)
 *   6. Cache and return
 *
 * The old `parseUrl()` in url-parser.ts delegates to this for known marketplaces,
 * and keeps the generic fallback for unknown domains.
 */

import type {
  ParseContext,
  ParsedProduct,
  StrategyResult,
  MarketplaceId,
  ParseStrategy,
  PriceData,
} from './types.js';
import type { ParsedUrlData } from '../url-parser.js';
import { normalizeUrl, stripHostPrefix } from './normalizers.js';
import { mergeStrategyResults } from './scoring.js';
import { parseLog } from './logger.js';
import { isAntiBotPage, isGarbageTitle, isSuspiciousPrice, isValidImageUrl } from './guards.js';

// ─── Strategy Registry ───────────────────────────────────────────────────────

/**
 * Strategy pipeline per marketplace, ordered by priority (highest first).
 * Each marketplace defines its own strategies; the orchestrator runs them
 * in order and stops early when confidence is sufficient.
 */
const strategyRegistry = new Map<MarketplaceId, ParseStrategy[]>();

/**
 * Register strategies for a marketplace. Called by individual strategy modules.
 */
export function registerStrategies(marketplace: MarketplaceId, strategies: ParseStrategy[]): void {
  strategyRegistry.set(marketplace, strategies);
}

/**
 * Get registered strategies for a marketplace (or empty array).
 */
export function getStrategies(marketplace: MarketplaceId): ParseStrategy[] {
  return strategyRegistry.get(marketplace) ?? [];
}

// ─── Cache with reason-aware TTL ─────────────────────────────────────────────

/** Strong result (high confidence): cache 24h — reliable, no point re-fetching */
const CACHE_TTL_HIGH_MS    = 24 * 60 * 60 * 1_000;
/** Medium result: cache 4h — decent but might improve on retry */
const CACHE_TTL_MEDIUM_MS  = 4  * 60 * 60 * 1_000;
/** Low/weak result: cache 30min — likely garbage, retry sooner */
const CACHE_TTL_LOW_MS     = 30 * 60 * 1_000;
/** Negative cache (anti-bot, total failure): 5min */
const NEGATIVE_CACHE_TTL   = 5  * 60 * 1_000;
const MAX_CACHE_ENTRIES    = 1_000;

interface CacheEntry { product: ParsedProduct; expiresAt: number; }
const productCache  = new Map<string, CacheEntry>();
const negativeCache = new Map<string, number>();

function cacheGet(key: string): ParsedProduct | null {
  const e = productCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { productCache.delete(key); return null; }
  return e.product;
}

/**
 * Cache with TTL based on result quality.
 * High confidence → long TTL (24h). Low confidence → short TTL (30min).
 * This prevents garbage from becoming "golden standard" for too long.
 */
function cacheSet(key: string, product: ParsedProduct): void {
  if (productCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = productCache.keys().next().value;
    if (oldest) productCache.delete(oldest);
  }
  const ttl = product.confidenceLevel === 'high'   ? CACHE_TTL_HIGH_MS
            : product.confidenceLevel === 'medium'  ? CACHE_TTL_MEDIUM_MS
            :                                         CACHE_TTL_LOW_MS;
  productCache.set(key, { product, expiresAt: Date.now() + ttl });
}

function isNegativelyCached(key: string): boolean {
  const t = negativeCache.get(key);
  if (t === undefined) return false;
  if (Date.now() > t) { negativeCache.delete(key); return false; }
  return true;
}

function setNegative(key: string): void {
  negativeCache.set(key, Date.now() + NEGATIVE_CACHE_TTL);
}

// ─── Kill Switch ─────────────────────────────────────────────────────────────

/**
 * Environment-based kill switch for the new pipeline.
 * Set MARKETPLACE_PARSER_DISABLED=1 to instantly route ALL marketplace URLs
 * through the legacy flow. No restart needed if using docker env reload.
 */
export function isOrchestratorEnabled(): boolean {
  return process.env.MARKETPLACE_PARSER_DISABLED !== '1';
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

/** Confidence threshold to stop executing further strategies */
const EARLY_STOP_CONFIDENCE = 70;

/**
 * Threshold below which the orchestrator result is considered "formally partial
 * but actually garbage" and should trigger fallback to legacy.
 *
 * This covers the class of cases where:
 *   - title exists but from a weak source (og_meta with low confidence)
 *   - image exists but suspicious
 *   - price exists but from html_regex with low reliability
 *   - overall score is technically not 'none' but practically useless
 */
const FALLBACK_CONFIDENCE_THRESHOLD = 25;

/**
 * Main orchestrator: parse a marketplace URL through the strategy pipeline.
 *
 * @param url - Validated URL object (must already be validated + DNS-safe)
 * @returns ParsedProduct with field-level confidence
 */
export async function parseMarketplaceUrl(url: URL): Promise<ParsedProduct> {
  const startTime = Date.now();
  const { marketplace, productId, canonicalUrl } = normalizeUrl(url);
  const hostname = stripHostPrefix(url.hostname);

  parseLog.parseStart(hostname, marketplace, productId);

  // ── Cache check ────────────────────────────────────────────────────────
  const cached = cacheGet(canonicalUrl);
  if (cached) {
    parseLog.cacheHit(hostname, 'positive');
    return cached;
  }
  if (isNegativelyCached(canonicalUrl)) {
    parseLog.cacheHit(hostname, 'negative');
    return emptyProduct();
  }

  // ── Build context ──────────────────────────────────────────────────────
  const ctx: ParseContext = {
    url,
    hostname,
    marketplace,
    productId,
    canonicalUrl,
    html: null,
  };

  // ── Execute strategies ─────────────────────────────────────────────────
  const strategies = getStrategies(marketplace);
  const results: StrategyResult[] = [];

  for (const strategy of strategies) {
    parseLog.strategyStart(strategy.name, marketplace);

    try {
      const result = await strategy.execute(ctx);
      if (result) {
        results.push(result);
        parseLog.strategyResult(result, marketplace);

        // Early stop: if we have high confidence already, skip remaining strategies
        const interim = mergeStrategyResults(results);
        if (interim.overallConfidence >= EARLY_STOP_CONFIDENCE) {
          break;
        }
      }
    } catch (err) {
      const errorResult: StrategyResult = {
        title: null,
        description: null,
        price: null,
        image: null,
        strategyName: strategy.name,
        durationMs: Date.now() - startTime,
        error: (err as Error).message,
      };
      results.push(errorResult);
      parseLog.strategyResult(errorResult, marketplace);
    }
  }

  // ── Merge results ──────────────────────────────────────────────────────
  let product = mergeStrategyResults(results);

  // ── Anti-bot guard (check shared HTML if available) ────────────────────
  if (ctx.html && isAntiBotPage(ctx.html, product.title?.value ?? null)) {
    parseLog.antiBotDetected(hostname, marketplace);
    setNegative(canonicalUrl);
    return emptyProduct();
  }

  // ── Post-merge guard enforcement ───────────────────────────────────────
  // Guards don't just sit in a folder — they actively downgrade or reject
  // fields that passed scoring but fail quality checks.
  product = enforceGuards(product);

  // ── Cache result ───────────────────────────────────────────────────────
  const totalDurationMs = Date.now() - startTime;
  parseLog.parseResult(hostname, marketplace, product, totalDurationMs);

  if (product.confidenceLevel === 'none') {
    setNegative(canonicalUrl);
  } else {
    cacheSet(canonicalUrl, product);
  }

  return product;
}

/**
 * Determine if the orchestrator result is too weak and should trigger
 * fallback to the legacy parser.
 *
 * Returns a reason string if fallback is needed, or null if result is good enough.
 */
export function shouldFallbackToLegacy(product: ParsedProduct): string | null {
  // Obvious: no data at all
  if (product.confidenceLevel === 'none') {
    return 'confidence_none';
  }

  // Below the "formally partial, actually garbage" threshold
  if (product.overallConfidence < FALLBACK_CONFIDENCE_THRESHOLD) {
    return `confidence_too_low_${product.overallConfidence}`;
  }

  // No title AND no price — we have nothing useful even if image exists
  if (!product.title && !product.price) {
    return 'no_title_no_price';
  }

  // Title exists but is garbage (passed scoring somehow)
  if (product.title && isGarbageTitle(product.title.value)) {
    return 'garbage_title';
  }

  // Title only from weak source AND no price — not reliable enough
  if (product.title && !product.price) {
    const weakSources = new Set(['html_regex', 'inferred']);
    if (weakSources.has(product.title.source)) {
      return 'title_only_from_weak_source';
    }
  }

  return null; // Good enough, no fallback needed
}

// ─── Post-Merge Guard Enforcement ────────────────────────────────────────────

/**
 * Apply guards to the merged product. Guards can:
 *   - Null out fields that fail quality checks
 *   - Recalculate overall confidence after field removal
 *
 * This runs AFTER merge so guards have the final say.
 */
function enforceGuards(product: ParsedProduct): ParsedProduct {
  let changed = false;

  // Guard: garbage title → reject
  if (product.title && isGarbageTitle(product.title.value)) {
    product = { ...product, title: null };
    changed = true;
  }

  // Guard: suspicious price → reject
  if (product.price && isSuspiciousPrice(product.price.value.amount)) {
    product = { ...product, price: null };
    changed = true;
  }

  // Guard: invalid image URL → reject
  if (product.image && !isValidImageUrl(product.image.value)) {
    product = { ...product, image: null };
    changed = true;
  }

  // Recalculate overall confidence if any field was rejected
  if (changed) {
    const { overallConfidence, confidenceLevel } = recalcConfidence(product);
    product = { ...product, overallConfidence, confidenceLevel };
  }

  return product;
}

/**
 * Recalculate overall confidence after guard-based field removal.
 */
function recalcConfidence(product: ParsedProduct): { overallConfidence: number; confidenceLevel: ParsedProduct['confidenceLevel'] } {
  // Reuse the same logic as mergeStrategyResults but on already-merged fields
  const WEIGHTS = { title: 0.35, price: 0.30, image: 0.25, description: 0.10 };

  let score = 0;
  let totalWeight = 0;

  if (product.title)       { score += product.title.confidence * WEIGHTS.title;       totalWeight += WEIGHTS.title; }
  if (product.price)       { score += product.price.confidence * WEIGHTS.price;       totalWeight += WEIGHTS.price; }
  if (product.image)       { score += product.image.confidence * WEIGHTS.image;       totalWeight += WEIGHTS.image; }
  if (product.description) { score += product.description.confidence * WEIGHTS.description; totalWeight += WEIGHTS.description; }

  if (totalWeight === 0) return { overallConfidence: 0, confidenceLevel: 'none' };

  const raw = score / totalWeight;
  const presencePenalty = (!product.title ? 30 : 0) + (!product.price ? 15 : 0) + (!product.image ? 10 : 0);
  const overall = Math.max(0, Math.min(100, Math.round(raw - presencePenalty)));

  const level: ParsedProduct['confidenceLevel'] =
    overall >= 65 ? 'high' :
    overall >= 40 ? 'medium' :
    overall > 0   ? 'low' :
    'none';

  return { overallConfidence: overall, confidenceLevel: level };
}

// ─── Conversion: ParsedProduct → ParsedUrlData (backward compat) ─────────────

/**
 * Convert the new ParsedProduct format to the old ParsedUrlData format
 * used by existing API endpoints.
 */
export function toOldFormat(product: ParsedProduct, sourceDomain: string, canonicalUrl: string): ParsedUrlData {
  const parseMethodMap: Record<string, ParsedUrlData['parseMethod']> = {
    card_api:          'domain_api',
    network_intercept: 'domain_api',
    hydration_state:   'generic_jsonld',
    jsonld:            'generic_jsonld',
    og_meta:           'generic_html',
    dom_selector:      'domain_adapter',
    html_regex:        'generic_html',
    inferred:          'generic_html',
  };

  // Determine parseMethod from the best field's source
  const bestSource = product.title?.source
    ?? product.price?.source
    ?? product.image?.source
    ?? 'og_meta';
  const parseMethod = parseMethodMap[bestSource] ?? 'generic_html';

  return {
    title:        product.title?.value ?? null,
    description:  product.description?.value ?? null,
    priceText:    product.price?.value.formatted ?? null,
    imageUrl:     product.image?.value ?? null,
    sourceDomain,
    canonicalUrl,
    confidence:   product.confidenceLevel,
    parseMethod,
  };
}

// ─── Empty Product ───────────────────────────────────────────────────────────

export function emptyProduct(): ParsedProduct {
  return {
    title: null,
    description: null,
    price: null,
    image: null,
    overallConfidence: 0,
    confidenceLevel: 'none',
  };
}
