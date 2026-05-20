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

// Logger
export { parseLog } from './logger.js';

// Browser provider
export {
  registerBrowserProvider,
  registerFetchHtmlProvider,
} from './browser-provider.js';
