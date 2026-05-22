/**
 * marketplace/index.ts — Barrel exports for the marketplace parser module
 */

// Core types
export type {
  MarketplaceId,
  FieldValue,
  FieldSource,
  PriceData,
  ParsedProduct,
  StrategyResult,
  ParseStrategy,
  ParseContext,
  MarketplaceConfig,
  NormalizedUrl,
} from './types.js';

// Orchestrator
export {
  parseMarketplaceUrl,
  toOldFormat,
  emptyProduct,
  registerStrategies,
  getStrategies,
  shouldFallbackToLegacy,
  isOrchestratorEnabled,
} from './orchestrator.js';
export type { ParseOptions } from './orchestrator.js';

// Scoring
export {
  baseConfidence,
  fieldValue,
  titleField,
  priceField,
  imageField,
  descriptionField,
  mergeStrategyResults,
  formatPrice,
} from './scoring.js';

// Normalizers
export {
  normalizeUrl,
  detectMarketplace,
  isKnownMarketplace,
  getMarketplaceId,
  stripHostPrefix,
  buildWbCardApiUrl,
  buildWbCanonicalUrl,
  buildOzonCanonicalUrl,
  buildYmCanonicalUrl,
} from './normalizers.js';

// Guards
export {
  isAntiBotPage,
  isGarbageTitle,
  isSuspiciousPrice,
  isValidImageUrl,
} from './guards.js';

// Universal structured-data extraction
export {
  extractJsonLd,
  extractMicrodata,
  extractOpenGraph,
  extractTwitterCard,
  parseAmount,
  detectCurrency,
} from './structured-data.js';
export type { ExtractedFields } from './structured-data.js';

// Marketplace site registry
export { lookupSite, fallbackCurrency } from './site-registry.js';
export type { SiteInfo } from './site-registry.js';

// Scraping-API fetch fallback (beats datacenter-IP blocks)
export {
  isScraperApiEnabled,
  fetchViaScraperApi,
  buildScraperApiUrl,
  isScraperHopeless,
  scraperMaxAttempts,
  noteScraperCall,
  scraperBudgetLeft,
} from './scraper-api.js';

// Realistic browser request headers (thin Node headers get flagged as bots)
export { browserHeaders, acceptLanguageFor, pickUaProfile } from './http-headers.js';
export type { UaProfile } from './http-headers.js';

// Shopify / WooCommerce product-JSON endpoints (anti-bot-free structured data)
export {
  detectStorePlatform,
  isWooProductPage,
  buildShopifyJsonUrl,
  parseShopifyJson,
  buildWooStoreApiUrls,
  wooSlugFromUrl,
  parseWooJson,
  detectShopifyCurrency,
  sameProductUrl,
} from './product-json.js';
export type { StorePlatform, ProductJsonResult } from './product-json.js';

// Jina Reader free fallback tier (renders from Jina's own infrastructure)
export { isJinaReaderEnabled, fetchViaJinaReader, buildJinaReaderUrl } from './reader-api.js';

// curl-impersonate — real-Chrome TLS fingerprint (beats Cloudflare/DataDome)
export {
  isCurlImpersonateAvailable,
  fetchViaCurlImpersonate,
  buildCurlImpersonateArgs,
  curlImpersonateBin,
} from './curl-impersonate.js';

// Shared response-body helpers
export { readCappedText } from './fetch-util.js';

// Logger
export { parseLog } from './logger.js';

// Browser provider
export {
  registerBrowserProvider,
  registerFetchHtmlProvider,
} from './browser-provider.js';
