/**
 * marketplace/browser-provider.ts
 *
 * Dependency injection for the browser singleton.
 * url-parser.ts registers its getBrowser/runBrowserExtract functions here,
 * and marketplace strategies consume them without circular imports.
 */

import type { Browser } from 'puppeteer-core';
import type { ExtractedProduct } from '../browser-network-extractor.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type GetBrowserFn = () => Promise<Browser>;
export type RunBrowserExtractFn = (url: string, hostname: string) => Promise<{
  html: string;
  product: ExtractedProduct | null;
  confidence: string;
  parseMethod: string;
  title: string | null;
  description: string | null;
  priceText: string | null;
  imageUrl: string | null;
}>;

export type FetchHtmlFn = (url: string) => Promise<string>;

// ─── Provider State ──────────────────────────────────────────────────────────

let _getBrowser: GetBrowserFn | null = null;
let _fetchHtml: FetchHtmlFn | null = null;

/**
 * Register the browser provider. Called once from url-parser.ts at import time.
 */
export function registerBrowserProvider(getBrowser: GetBrowserFn): void {
  _getBrowser = getBrowser;
}

/**
 * Register the fetchHtml provider. Called once from url-parser.ts.
 */
export function registerFetchHtmlProvider(fetchHtml: FetchHtmlFn): void {
  _fetchHtml = fetchHtml;
}

/**
 * Get the browser singleton. Throws if not registered.
 */
export function getBrowser(): Promise<Browser> {
  if (!_getBrowser) throw new Error('Browser provider not registered');
  return _getBrowser();
}

/**
 * Fetch HTML via HTTP (with SSRF-safe redirect following).
 */
export function fetchHtml(url: string): Promise<string> {
  if (!_fetchHtml) throw new Error('FetchHtml provider not registered');
  return _fetchHtml(url);
}
