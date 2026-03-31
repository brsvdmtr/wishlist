/**
 * marketplace/scoring.ts — Field-level confidence scoring and product merging
 *
 * Each extraction strategy produces independent field scores (0–100).
 * The merger picks the highest-confidence value for each field,
 * then computes an overall product confidence.
 */

import type {
  FieldValue,
  FieldSource,
  PriceData,
  ParsedProduct,
  StrategyResult,
} from './types.js';

// ─── Field Weights for Overall Score ─────────────────────────────────────────

const FIELD_WEIGHTS = {
  title:       0.35,
  price:       0.30,
  image:       0.25,
  description: 0.10,
} as const;

// ─── Source Base Confidence ──────────────────────────────────────────────────

/**
 * Base confidence per source type. Individual strategies may adjust
 * up or down based on data quality, but this sets the floor.
 */
const SOURCE_BASE_CONFIDENCE: Record<FieldSource, number> = {
  card_api:          90,
  basket_cdn:        90,
  network_intercept: 85,
  hydration_state:   80,
  jsonld:            75,
  og_meta:           60,
  dom_selector:      55,
  html_regex:        40,
  inferred:          30,
};

/**
 * Get a base confidence for a field from a given source.
 * Strategies should use this as a starting point, then adjust.
 */
export function baseConfidence(source: FieldSource): number {
  return SOURCE_BASE_CONFIDENCE[source];
}

// ─── Field Factories ─────────────────────────────────────────────────────────

export function fieldValue<T>(value: T, confidence: number, source: FieldSource): FieldValue<T> {
  return { value, confidence: clamp(confidence, 0, 100), source };
}

export function titleField(value: string, source: FieldSource, boost = 0): FieldValue<string> | null {
  if (!value || value.length < 2) return null;
  let conf = baseConfidence(source) + boost;
  // Penalize very short titles
  if (value.length < 10) conf -= 15;
  // Penalize titles that look like slugs or IDs
  if (/^[a-z0-9_-]+$/.test(value)) conf -= 40;
  if (/^\d+$/.test(value)) return null;
  return fieldValue(value, conf, source);
}

export function priceField(
  amount: number,
  currency: string,
  source: FieldSource,
  boost = 0,
): FieldValue<PriceData> | null {
  if (!amount || amount <= 0 || amount > 10_000_000) return null;
  const formatted = formatPrice(amount, currency);
  return fieldValue({ amount, currency, formatted }, baseConfidence(source) + boost, source);
}

export function imageField(url: string, source: FieldSource, boost = 0): FieldValue<string> | null {
  if (!url) return null;
  if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('//')) return null;
  return fieldValue(url, baseConfidence(source) + boost, source);
}

export function descriptionField(value: string, source: FieldSource, boost = 0): FieldValue<string> | null {
  if (!value || value.length < 5) return null;
  const trimmed = value.slice(0, 500);
  return fieldValue(trimmed, baseConfidence(source) + boost, source);
}

// ─── Strategy Result Merger ──────────────────────────────────────────────────

/**
 * Merge multiple strategy results into a single ParsedProduct.
 * For each field, picks the value with the highest confidence.
 */
export function mergeStrategyResults(results: StrategyResult[]): ParsedProduct {
  const validResults = results.filter(r => !r.error);

  const title       = pickBestField(validResults.map(r => r.title));
  const description = pickBestField(validResults.map(r => r.description));
  const price       = pickBestField(validResults.map(r => r.price));
  const image       = pickBestField(validResults.map(r => r.image));

  const overallConfidence = computeOverallConfidence({ title, description, price, image });
  const confidenceLevel   = confidenceBucket(overallConfidence);

  return { title, description, price, image, overallConfidence, confidenceLevel };
}

/**
 * Pick the highest-confidence field value from an array of nullable candidates.
 */
function pickBestField<T>(candidates: Array<FieldValue<T> | null>): FieldValue<T> | null {
  let best: FieldValue<T> | null = null;
  for (const c of candidates) {
    if (!c) continue;
    if (!best || c.confidence > best.confidence) best = c;
  }
  return best;
}

/**
 * Compute weighted overall confidence from individual field scores.
 * Missing fields contribute 0 to their weight portion.
 */
function computeOverallConfidence(fields: {
  title:       FieldValue<unknown> | null;
  description: FieldValue<unknown> | null;
  price:       FieldValue<unknown> | null;
  image:       FieldValue<unknown> | null;
}): number {
  let score = 0;
  let totalWeight = 0;

  if (fields.title) {
    score += fields.title.confidence * FIELD_WEIGHTS.title;
    totalWeight += FIELD_WEIGHTS.title;
  }
  if (fields.price) {
    score += fields.price.confidence * FIELD_WEIGHTS.price;
    totalWeight += FIELD_WEIGHTS.price;
  }
  if (fields.image) {
    score += fields.image.confidence * FIELD_WEIGHTS.image;
    totalWeight += FIELD_WEIGHTS.image;
  }
  if (fields.description) {
    score += fields.description.confidence * FIELD_WEIGHTS.description;
    totalWeight += FIELD_WEIGHTS.description;
  }

  // If no fields at all, overall is 0
  if (totalWeight === 0) return 0;

  // Normalize to 0–100, but penalize missing fields
  const raw = score / totalWeight;
  // Presence penalty: missing title = heavy penalty, missing price = moderate
  const presencePenalty =
    (!fields.title ? 30 : 0) +
    (!fields.price ? 15 : 0) +
    (!fields.image ? 10 : 0);

  return clamp(Math.round(raw - presencePenalty), 0, 100);
}

function confidenceBucket(score: number): ParsedProduct['confidenceLevel'] {
  if (score >= 65) return 'high';
  if (score >= 40) return 'medium';
  if (score > 0)   return 'low';
  return 'none';
}

// ─── Price Formatting ────────────────────────────────────────────────────────

export function formatPrice(amount: number, currency: string): string {
  const formatted = amount.toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const cur = currency.toUpperCase();
  if (!cur || cur === 'RUB' || cur === 'RUR') return `${formatted} \u20BD`;
  if (cur === 'USD') return `$${formatted}`;
  if (cur === 'EUR') return `\u20AC${formatted}`;
  return `${formatted} ${cur}`;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
