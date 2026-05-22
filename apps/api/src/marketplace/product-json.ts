/**
 * marketplace/product-json.ts — Shopify & WooCommerce product-JSON extraction
 *
 * Both platforms expose an unauthenticated, anti-bot-free JSON endpoint for a
 * product page:
 *   - Shopify:     <product-url>.json                       → { product: {…} }
 *   - WooCommerce: /wp-json/wc/store/v1/products?slug=<slug> → [ {…} ]
 *
 * Together they power millions of independent storefronts (heavy in the US/ES
 * long tail) whose themes often ship no JSON-LD / Open Graph at all. This
 * module is pure: platform detection, endpoint-URL building, and JSON parsing
 * only — the actual fetch lives in url-parser.ts so these stay unit-testable.
 */

export type StorePlatform = 'shopify' | 'woocommerce';

/** Normalised product fields lifted from a platform JSON endpoint. */
export interface ProductJsonResult {
  title:    string | null;
  /** Numeric price in major units (e.g. 29.99) — null when absent */
  price:    number | null;
  /** ISO 4217 currency when the endpoint carries it (WooCommerce does) */
  currency: string | null;
  image:    string | null;
  /**
   * Canonical product URL the JSON itself claims (WooCommerce `permalink`);
   * null when the endpoint carries none. Lets the caller reject a Store-API
   * hit whose `?slug=` guess landed on a different product.
   */
  sourceUrl: string | null;
}

/**
 * Detect the e-commerce platform from page HTML. Shopify markers are checked
 * first — they're unambiguous; WooCommerce shares generic WordPress markup, so
 * its check requires a WooCommerce-specific asset path or body class.
 */
export function detectStorePlatform(html: string): StorePlatform | null {
  // High-precision Shopify markers only — `Shopify.theme` (the `.` matches any
  // char) and a bare `shopify-` substring false-positive on prose / markup.
  if (/cdn\.shopify\.com|window\.Shopify|shopify-section/i.test(html)) {
    return 'shopify';
  }
  if (/wp-content\/plugins\/woocommerce|woocommerce-page|woocommerce-js|content="WooCommerce/i
        .test(html)) {
    return 'woocommerce';
  }
  return null;
}

// Match /products/<handle> ONLY as the final path segment (handle = no slash),
// so a mid-path "/products/" in a non-product URL doesn't yield a bogus probe.
/**
 * Whether page HTML is a WooCommerce *single product* page (as opposed to a
 * cart, account, shop/category listing, or blog post). `single-product` is a
 * WooCommerce-core `<body>` class — added regardless of theme — so it is a
 * reliable product-page marker. Used to skip the Store-API probe on the
 * non-product WooCommerce pages that would otherwise waste two HTTP round-trips.
 */
export function isWooProductPage(html: string): boolean {
  return /\bsingle-product\b/.test(html);
}

const SHOPIFY_PRODUCT_RE = /\/products\/([^/?#]+)\/?$/;

/**
 * Build the `.json` endpoint URL for a Shopify product page, or null when the
 * path's final segment is not `/products/<handle>`. The canonical root form
 * (`/products/<handle>.json`) is used — Shopify resolves it regardless of any
 * `/collections/…` or locale prefix on the original URL; query + hash dropped.
 *
 * A Shopify product handle is unique per store, so the handle taken from the
 * page's own path identifies exactly the product on that page — there is no
 * ambiguity to guard against (unlike the WooCommerce `?slug=` guess).
 */
export function buildShopifyJsonUrl(url: URL): string | null {
  const m = url.pathname.match(SHOPIFY_PRODUCT_RE);
  if (!m || !m[1]) return null;
  return `${url.origin}/products/${m[1]}.json`;
}

/**
 * WooCommerce Store-API URLs for a product slug — the versioned path first,
 * the legacy un-versioned path as a fallback for older WooCommerce installs.
 */
export function buildWooStoreApiUrls(origin: string, slug: string): string[] {
  const s = encodeURIComponent(slug);
  return [
    `${origin}/wp-json/wc/store/v1/products?slug=${s}`,
    `${origin}/wp-json/wc/store/products?slug=${s}`,
  ];
}

/** The WooCommerce product slug — the last non-empty path segment. */
export function wooSlugFromUrl(url: URL): string | null {
  const segs = url.pathname.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  if (!last) return null;
  try { return decodeURIComponent(last); } catch { return last; }
}

/** A Shopify variant's price as a positive number in major units, or null. */
function shopifyVariantPrice(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const n = typeof raw === 'number' ? raw : parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse the Shopify `<product>.json` body. Currency is NOT in this endpoint. */
export function parseShopifyJson(raw: string): ProductJsonResult | null {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  const product = (data as { product?: Record<string, unknown> } | null)?.product;
  if (!product || typeof product !== 'object') return null;

  const title = typeof product.title === 'string' ? product.title.trim() || null : null;

  let image: string | null = null;
  const images = product.images;
  if (Array.isArray(images) && images.length > 0) {
    const first = images[0] as { src?: unknown };
    if (typeof first?.src === 'string') image = first.src;
  }
  if (!image) {
    const img = product.image as { src?: unknown } | undefined;
    if (img && typeof img.src === 'string') image = img.src;
  }

  // First available variant (else first variant).
  let price: number | null = null;
  const variants = product.variants;
  if (Array.isArray(variants) && variants.length > 0) {
    const vs = variants as Array<{ price?: unknown; available?: unknown }>;
    const chosen = vs.find((v) => v.available === true) ?? vs[0];
    price = shopifyVariantPrice(chosen?.price);
  }

  if (!title && price === null && !image) return null;
  // The Shopify <handle>.json endpoint is derived from the page's own
  // /products/<handle> path — it is the same product by construction, so no
  // separate URL check is needed (sourceUrl stays null).
  return { title, price, currency: null, image, sourceUrl: null };
}

/** Parse the WooCommerce Store-API `products` body (an array of products). */
export function parseWooJson(raw: string): ProductJsonResult | null {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  const arr = Array.isArray(data) ? data : (data ? [data] : []);
  const p = arr[0] as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object') return null;

  const title = typeof p.name === 'string' ? p.name.trim() || null : null;
  const sourceUrl = typeof p.permalink === 'string' ? p.permalink : null;

  let image: string | null = null;
  const images = p.images;
  if (Array.isArray(images) && images.length > 0) {
    const first = images[0] as { src?: unknown };
    if (typeof first?.src === 'string') image = first.src;
  }

  // Store-API prices are integer minor units scaled by currency_minor_unit.
  let price: number | null = null;
  let currency: string | null = null;
  const prices = p.prices as Record<string, unknown> | undefined;
  if (prices && typeof prices === 'object') {
    const rawPrice = prices.price;
    const minorUnit = typeof prices.currency_minor_unit === 'number'
      ? prices.currency_minor_unit : 2;
    if (typeof rawPrice === 'string' || typeof rawPrice === 'number') {
      const intVal = typeof rawPrice === 'number' ? rawPrice : parseInt(rawPrice, 10);
      if (Number.isFinite(intVal)) {
        const n = intVal / Math.pow(10, minorUnit);
        if (n > 0) price = n;
      }
    }
    if (typeof prices.currency_code === 'string') {
      currency = prices.currency_code.toUpperCase();
    }
  }

  if (!title && price === null && !image) return null;
  return { title, price, currency, image, sourceUrl };
}

/** Best-effort ISO 4217 currency from a Shopify storefront's HTML. */
export function detectShopifyCurrency(html: string): string | null {
  const m = html.match(/Shopify\.currency\s*=\s*\{[^}]*"active"\s*:\s*"([A-Za-z]{3})"/)
        ?? html.match(/"(?:shop_currency|currency)"\s*:\s*"([A-Za-z]{3})"/)
        ?? html.match(
             /<meta[^>]+property=["']og:price:currency["'][^>]+content=["']([A-Za-z]{3})["']/i,
           );
  return m?.[1]?.toUpperCase() ?? null;
}

/**
 * Whether two URLs point at the same product — host (sans `www.`) + path
 * (trailing slash ignored), with protocol / query / hash disregarded. Used to
 * reject a WooCommerce Store-API hit whose `?slug=` guess landed on a
 * different product than the page being imported.
 */
export function sameProductUrl(a: string, b: string): boolean {
  try {
    const norm = (raw: string): string => {
      const u = new URL(raw);
      return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '');
    };
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}
