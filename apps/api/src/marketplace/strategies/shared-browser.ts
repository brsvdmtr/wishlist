/**
 * marketplace/strategies/shared-browser.ts
 *
 * Shared browser extraction logic that wraps the existing
 * browser-network-extractor.ts infrastructure.
 *
 * Individual marketplace strategies call into this to get:
 *   - Network-intercepted JSON responses
 *   - Hydration state (__NEXT_DATA__, window.__INITIAL_STATE__, etc.)
 *   - Rendered HTML for DOM extraction
 *
 * This module does NOT manage the browser lifecycle — that stays
 * in url-parser.ts (getBrowser/closeBrowser singleton).
 */

import type { ParseContext, StrategyResult, FieldValue, PriceData } from '../types.js';
import {
  titleField,
  priceField,
  imageField,
  descriptionField,
  fieldValue,
  baseConfidence,
} from '../scoring.js';
import { isGarbageTitle, isValidImageUrl } from '../guards.js';

// ─── Types for Network-Extracted Data ────────────────────────────────────────

export interface NetworkProduct {
  title:       string | null;
  description: string | null;
  price:       number | null;
  currency:    string | null;
  imageUrl:    string | null;
  source:      'network_response' | 'next_data' | 'hydration_state' | 'script_json';
  score:       number;
}

/**
 * Convert an ExtractedProduct from browser-network-extractor.ts
 * into FieldValue-based StrategyResult.
 */
export function networkProductToResult(
  product: NetworkProduct | null,
  html: string | null,
  strategyName: string,
  startTime: number,
): StrategyResult {
  if (!product || product.score < 20) {
    return {
      title: null, description: null, price: null, image: null,
      strategyName, durationMs: Date.now() - startTime,
    };
  }

  // Map browser-extractor source to our FieldSource
  const sourceMap = {
    network_response: 'network_intercept' as const,
    next_data:        'hydration_state' as const,
    hydration_state:  'hydration_state' as const,
    script_json:      'hydration_state' as const,
  };
  const fieldSource = sourceMap[product.source];

  let title: FieldValue<string> | null = null;
  if (product.title && !isGarbageTitle(product.title)) {
    title = titleField(product.title, fieldSource);
  }

  let price: FieldValue<PriceData> | null = null;
  if (product.price && product.price > 0) {
    price = priceField(product.price, product.currency ?? 'RUB', fieldSource);
  }

  let image: FieldValue<string> | null = null;
  if (product.imageUrl && isValidImageUrl(product.imageUrl)) {
    image = imageField(product.imageUrl, fieldSource);
  }

  let description: FieldValue<string> | null = null;
  if (product.description) {
    description = descriptionField(product.description, fieldSource);
  }

  return {
    title,
    description,
    price,
    image,
    strategyName,
    durationMs: Date.now() - startTime,
  };
}
