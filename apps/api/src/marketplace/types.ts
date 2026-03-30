/**
 * marketplace/types.ts — Shared types for the marketplace parser system
 *
 * Defines the core data structures used across all marketplace strategies,
 * the orchestrator, and the scoring system.
 */

// ─── Marketplace Identifiers ─────────────────────────────────────────────────

export type MarketplaceId =
  | 'wildberries'
  | 'ozon'
  | 'yandex_market'
  | 'goldapple'
  | 'lamoda'
  | 'tehnopark'
  | 'bork'
  | 'unknown';

// ─── Field-Level Confidence ──────────────────────────────────────────────────

/**
 * Each extracted field carries its own confidence score (0–100) and source.
 * This allows the orchestrator to merge results from multiple strategies
 * at the field level rather than picking a single "winner".
 */
export interface FieldValue<T> {
  value: T;
  confidence: number;       // 0–100
  source: FieldSource;
}

export type FieldSource =
  | 'card_api'          // Direct marketplace JSON API (WB card.wb.ru, etc.)
  | 'network_intercept' // Browser network response interception
  | 'hydration_state'   // __NEXT_DATA__, window.__INITIAL_STATE__, etc.
  | 'jsonld'            // JSON-LD structured data
  | 'og_meta'           // Open Graph meta tags
  | 'dom_selector'      // Domain-specific CSS selectors
  | 'html_regex'        // Regex extraction from raw HTML
  | 'inferred';         // Computed/inferred (e.g. CDN image URL from product ID)

// ─── Parsed Product ──────────────────────────────────────────────────────────

/**
 * The fully resolved product after merging all strategies.
 * Each field is independently scored and sourced.
 */
export interface ParsedProduct {
  title:       FieldValue<string> | null;
  description: FieldValue<string> | null;
  price:       FieldValue<PriceData> | null;
  image:       FieldValue<string> | null;

  /** Overall confidence = weighted average of field confidences */
  overallConfidence: number;     // 0–100
  /** Qualitative confidence bucket derived from overallConfidence */
  confidenceLevel: 'high' | 'medium' | 'low' | 'none';
}

export interface PriceData {
  amount:   number;          // numeric price (e.g. 1999)
  currency: string;          // ISO 4217 (e.g. "RUB")
  formatted: string;         // display string (e.g. "1 999 ₽")
}

// ─── Strategy Result ─────────────────────────────────────────────────────────

/**
 * Returned by each individual extraction strategy (API, browser, DOM, etc.).
 * Fields may be null if the strategy couldn't extract them.
 */
export interface StrategyResult {
  title:       FieldValue<string> | null;
  description: FieldValue<string> | null;
  price:       FieldValue<PriceData> | null;
  image:       FieldValue<string> | null;

  /** Which strategy produced this result */
  strategyName: string;
  /** Execution time in ms */
  durationMs: number;
  /** If the strategy encountered errors */
  error?: string;
}

// ─── Strategy Interface ──────────────────────────────────────────────────────

export interface ParseStrategy {
  /** Human-readable strategy name for logging */
  name: string;
  /**
   * Execute the strategy and return extracted fields.
   * May return null to indicate "skip — not applicable".
   */
  execute(ctx: ParseContext): Promise<StrategyResult | null>;
}

// ─── Parse Context ───────────────────────────────────────────────────────────

/**
 * Shared context passed to all strategies for a single parse request.
 * Strategies can read from it and populate shared fields (e.g. HTML).
 */
export interface ParseContext {
  /** Original validated URL */
  url: URL;
  /** Normalized hostname (no www/m prefix) */
  hostname: string;
  /** Detected marketplace */
  marketplace: MarketplaceId;
  /** Extracted product ID from URL (marketplace-specific), if any */
  productId: string | null;
  /** Canonical URL (tracking params stripped) */
  canonicalUrl: string;

  /**
   * Shared HTML cache — first strategy to fetch HTML stores it here
   * so subsequent strategies don't re-fetch.
   */
  html: string | null;

  /** Abort signal for timeout */
  signal?: AbortSignal;
}

// ─── Marketplace Config ──────────────────────────────────────────────────────

export interface MarketplaceConfig {
  id: MarketplaceId;
  /** Hostnames that identify this marketplace */
  hosts: string[];
  /** Ordered list of strategies to try */
  strategies: ParseStrategy[];
  /** Whether to always use browser (vs HTTP-first) */
  browserFirst: boolean;
}

// ─── Normalized URL Result ───────────────────────────────────────────────────

export interface NormalizedUrl {
  marketplace: MarketplaceId;
  productId: string | null;
  canonicalUrl: string;
  url: URL;
}
