/**
 * marketplace/structured-data.ts — Universal product metadata extraction
 *
 * Domain-agnostic extractors for the four structured-data formats that
 * marketplaces emit. Each reads one format and returns a normalized
 * ExtractedFields partial; the caller merges them field-by-field with
 * source-aware confidence.
 *
 * Formats:
 *   - JSON-LD       <script type="application/ld+json"> schema.org/Product
 *   - Microdata     itemscope / itemtype / itemprop attributes
 *   - Open Graph    <meta property="og:*"> + product:price:*
 *   - Twitter Card  <meta name="twitter:*">
 *
 * Pure functions: no network, no base-URL resolution (the caller resolves
 * relative image URLs). Shared by the legacy HTTP path (url-parser.ts) and
 * marketplace strategies, so JSON-LD parsing lives in exactly one place.
 */

import * as cheerio from 'cheerio';

/** Normalized product fields produced by every extractor. */
export interface ExtractedFields {
  title:       string | null;
  description: string | null;
  /** Numeric amount, no currency symbol, no grouping separators */
  price:       number | null;
  /** ISO 4217 code if known (e.g. from priceCurrency), else null */
  currency:    string | null;
  image:       string | null;
}

// ─── Shared price helpers ────────────────────────────────────────────────────

/**
 * Parse a price into a plain number, tolerating grouping/decimal separators
 * from any locale ("1,299.00", "1.299,00", "1 299", "₹1,29,900").
 *
 * Only the first contiguous number-like run is read, so junk around the price
 * ("from 10-20", "USD 1 299") does not glue extra digits on.
 *
 * Decimal heuristic: the decimal separator is whichever of `.`/`,` appears
 * last AND is followed by exactly 1–2 digits; every other separator is
 * grouping. A separator followed by 3+ digits is therefore always grouping —
 * retail prices carry 0 or 2 decimals, so "1.500" is read as 1500, not 1.5.
 */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw === 'number') return isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string') return null;

  // Optional leading separator handles sub-unit prices like "$.99".
  const run = raw.match(/[.,]?\d[\d.,\s]*/);
  if (!run) return null;
  const s = run[0]!.replace(/\s/g, '');
  if (!s) return null;

  const lastDot   = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  let normalized: string;
  if (lastDot >= 0 && lastDot > lastComma && /^\d{1,2}$/.test(s.slice(lastDot + 1))) {
    // '.' is the decimal separator → strip ',' grouping
    normalized = s.replace(/,/g, '');
  } else if (lastComma >= 0 && lastComma > lastDot && /^\d{1,2}$/.test(s.slice(lastComma + 1))) {
    // ',' is the decimal separator → strip '.' grouping, swap ',' → '.'
    normalized = s.replace(/\./g, '').replace(',', '.');
  } else {
    // No decimal part — every separator is grouping
    normalized = s.replace(/[.,]/g, '');
  }

  const n = parseFloat(normalized);
  return isFinite(n) && n > 0 ? n : null;
}

/**
 * Detect an ISO 4217 currency from a price string — explicit code first,
 * then symbol. Returns null when no signal is present.
 */
export function detectCurrency(text: string | null | undefined): string | null {
  if (!text) return null;
  const code = text.toUpperCase().match(/\b(RUB|RUR|USD|EUR|GBP|INR|CNY|RMB|JPY|UAH|KZT|AED|TRY|BRL|MXN)\b/);
  if (code) return code[1] === 'RUR' ? 'RUB' : code[1] === 'RMB' ? 'CNY' : code[1]!;
  if (/[₽]|руб/i.test(text))               return 'RUB';
  if (/₹|\brs\.?\b/i.test(text))            return 'INR';
  if (/€/.test(text))                       return 'EUR';
  if (/£/.test(text))                       return 'GBP';
  if (/[¥￥]|元/.test(text))                 return 'CNY';
  if (/\$/.test(text))                      return 'USD';
  return null;
}

// ─── JSON-LD ─────────────────────────────────────────────────────────────────

/**
 * Extract product fields from JSON-LD (<script type="application/ld+json">).
 * Handles @graph, arrays, mainEntity nesting, and Offer / AggregateOffer /
 * priceSpecification price shapes.
 */
export function extractJsonLd($: cheerio.CheerioAPI): ExtractedFields | null {
  const scripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    const raw = $(scripts[i]).html()?.trim();
    if (!raw) continue;
    try {
      const product = findJsonLdProduct(JSON.parse(raw), 0);
      if (product) return product;
    } catch { /* malformed JSON — skip this block */ }
  }
  return null;
}

/**
 * Depth-first search for the first schema.org Product node. JSON-LD convention
 * places the page's main product first (top-level or first in @graph), so the
 * first match is taken — related-item lists usually come after it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findJsonLdProduct(data: any, depth: number): ExtractedFields | null {
  if (!data || typeof data !== 'object' || depth > 8) return null;

  if (Array.isArray(data)) {
    for (const item of data) {
      const r = findJsonLdProduct(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (Array.isArray(data['@graph'])) {
    for (const item of data['@graph']) {
      const r = findJsonLdProduct(item, depth + 1);
      if (r) return r;
    }
  }

  const type = data['@type'];
  const types = (Array.isArray(type) ? type : [type]).map((t) => String(t ?? '').toLowerCase());
  if (types.some((t) => t.includes('product'))) {
    return jsonLdProductFields(data);
  }

  // Product is sometimes nested under WebPage.mainEntity
  if (data.mainEntity) return findJsonLdProduct(data.mainEntity, depth + 1);
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonLdProductFields(node: any): ExtractedFields | null {
  const name = typeof node.name === 'string' ? node.name.trim()
             : Array.isArray(node.name) ? String(node.name[0] ?? '').trim()
             : null;
  const description = typeof node.description === 'string' ? node.description.trim() : null;
  const image = jsonLdImage(node.image);
  const { amount, currency } = jsonLdOfferPrice(node.offers);

  if (!name && amount === null && !image) return null;
  return {
    title:       name && name.length >= 2 ? name : null,
    description: description ? description.slice(0, 500) : null,
    price:       amount,
    currency,
    image,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonLdOfferPrice(offers: any): { amount: number | null; currency: string | null } {
  if (!offers) return { amount: null, currency: null };
  const list = Array.isArray(offers) ? offers : [offers];

  let fallbackCurrency: string | null = null;
  for (const offer of list) {
    if (!offer || typeof offer !== 'object') continue;

    let rawPrice = offer.price ?? offer.lowPrice ?? offer.highPrice;
    let currency = typeof offer.priceCurrency === 'string' ? offer.priceCurrency : null;

    if (rawPrice == null && offer.priceSpecification) {
      const ps = Array.isArray(offer.priceSpecification)
        ? offer.priceSpecification[0]
        : offer.priceSpecification;
      if (ps && typeof ps === 'object') {
        rawPrice = ps.price;
        currency = currency ?? (typeof ps.priceCurrency === 'string' ? ps.priceCurrency : null);
      }
    }
    if (currency && !fallbackCurrency) fallbackCurrency = currency.toUpperCase();

    const amount = parseAmount(rawPrice);
    if (amount !== null) return { amount, currency: currency ? currency.toUpperCase() : null };
  }
  return { amount: null, currency: fallbackCurrency };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonLdImage(img: any): string | null {
  if (!img) return null;
  if (typeof img === 'string') return img;
  if (Array.isArray(img)) {
    for (const it of img) {
      const r = jsonLdImage(it);
      if (r) return r;
    }
    return null;
  }
  if (typeof img === 'object') {
    if (typeof img.url === 'string') return img.url;
    if (typeof img.contentUrl === 'string') return img.contentUrl;
  }
  return null;
}

// ─── Microdata ───────────────────────────────────────────────────────────────

/**
 * Extract product fields from HTML5 microdata — the first element whose
 * itemtype is a schema.org Product, reading its itemprop descendants.
 */
export function extractMicrodata($: cheerio.CheerioAPI): ExtractedFields | null {
  const product = $('[itemscope][itemtype]')
    .filter((_, el) => {
      const t = ($(el).attr('itemtype') ?? '').toLowerCase();
      return t.includes('schema.org') && t.includes('product');
    })
    .first();
  if (product.length === 0) return null;

  // Microdata model: a property's owner is its nearest ancestor itemscope.
  //  - name / description / image must be DIRECT properties of `product`
  //    (nearest itemscope === product) → rejects e.g. a nested Brand's name.
  //  - price / priceCurrency legitimately sit inside a nested `offers` item,
  //    so their nearest *Product-typed* scope must be product → still rejects
  //    a related-Product's offer price.
  // `image` is URL-valued (read href/src); the rest are text-valued — on an
  // <a>/<link> their value is the text content, not the href.
  const prop = (propName: string): string | null => {
    const urlValued = propName === 'image';
    const ownerSel = (propName === 'price' || propName === 'priceCurrency')
      ? '[itemscope][itemtype*="roduct"]'
      : '[itemscope]';
    const candidates = product.find(`[itemprop="${propName}"]`);
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates.eq(i);
      const owner = el.closest(ownerSel);
      if (owner.length > 0 && !owner.is(product)) continue;
      const tag = String(el.prop('tagName') ?? '').toLowerCase();
      let v: string | undefined;
      if (tag === 'meta')                                                  v = el.attr('content');
      else if (['img', 'source', 'video', 'audio', 'embed', 'iframe'].includes(tag)) v = el.attr('src');
      else if (['a', 'area', 'link'].includes(tag))                        v = urlValued ? el.attr('href') : (el.text().trim() || el.attr('href'));
      else if (tag === 'object')                                           v = el.attr('data');
      else if (['data', 'meter'].includes(tag))                            v = el.attr('value');
      else if (tag === 'time')                                             v = el.attr('datetime');
      else                                                                 v = el.attr('content') ?? el.text();
      const t = v?.trim();
      if (t && t.length > 0) return t;
    }
    return null;
  };

  const title = prop('name');
  const description = prop('description');
  const image = prop('image');
  const price = parseAmount(prop('price'));
  const currency = prop('priceCurrency');

  if (!title && price === null && !image) return null;
  return {
    title:       title && title.length >= 2 ? title : null,
    description: description ? description.slice(0, 500) : null,
    price,
    currency:    currency ? currency.toUpperCase() : null,
    image,
  };
}

// ─── Open Graph ──────────────────────────────────────────────────────────────

/** Extract product fields from Open Graph + product:price:* meta tags. */
export function extractOpenGraph($: cheerio.CheerioAPI): ExtractedFields | null {
  const meta = (prop: string): string | null =>
    $(`meta[property="${prop}"]`).first().attr('content')?.trim() || null;

  const title = meta('og:title');
  const description = meta('og:description');
  const image = meta('og:image') ?? meta('og:image:secure_url') ?? meta('og:image:url');
  const priceRaw = meta('product:price:amount') ?? meta('og:price:amount') ?? meta('product:price');
  const currencyRaw = meta('product:price:currency') ?? meta('og:price:currency');

  const price = parseAmount(priceRaw);
  if (!title && !image && price === null && !description) return null;
  return {
    title,
    description: description ? description.slice(0, 500) : null,
    price,
    currency:    currencyRaw ? currencyRaw.toUpperCase() : null,
    image,
  };
}

// ─── Twitter Card ────────────────────────────────────────────────────────────

/**
 * Extract product fields from Twitter Card meta tags. Price is opportunistic:
 * some shops expose it via a twitter:labelN / twitter:dataN pair.
 */
export function extractTwitterCard($: cheerio.CheerioAPI): ExtractedFields | null {
  const meta = (name: string): string | null =>
    ($(`meta[name="${name}"]`).first().attr('content')
      ?? $(`meta[property="${name}"]`).first().attr('content'))?.trim() || null;

  const title = meta('twitter:title');
  const description = meta('twitter:description');
  const image = meta('twitter:image') ?? meta('twitter:image:src');

  let price: number | null = null;
  let currency: string | null = null;
  for (const i of [1, 2, 3, 4]) {
    const label = (meta(`twitter:label${i}`) ?? '').toLowerCase();
    if (/price|precio|цен|कीमत|价格|售价/.test(label)) {
      const data = meta(`twitter:data${i}`);
      price = parseAmount(data);
      currency = detectCurrency(data);
      break;
    }
  }

  if (!title && !image && price === null && !description) return null;
  return {
    title,
    description: description ? description.slice(0, 500) : null,
    price,
    currency,
    image,
  };
}
