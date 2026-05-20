/**
 * Tests for extractFromHtml — the universal legacy-path extractor that
 * handles every marketplace outside the RU orchestrator (US / India / China /
 * Spain and any unknown shop).
 *
 * Covers: Amazon DOM adapter, AliExpress runParams adapter, JSON-LD,
 * microdata, embedded __NEXT_DATA__, anti-bot rejection, and the kill switch.
 */
import { describe, it, expect } from 'vitest';
import { extractFromHtml } from './url-parser.js';

/** Anti-bot guard rejects pages < 800 bytes; pad synthetic fixtures past it. */
const FILLER = `<!-- ${'x'.repeat(1000)} -->`;

function page(head: string, body: string): string {
  return `<!doctype html><html><head>${head}</head><body>${body}${FILLER}</body></html>`;
}

// ─── Amazon — DOM adapter (no JSON-LD, no og:price) ──────────────────────────

describe('extractFromHtml — Amazon', () => {
  it('extracts title/price/image via the DOM adapter and prefers it over og:title', () => {
    const html = page(
      `<meta property="og:title" content="Amazon.com: Sony WH-1000XM5 : Electronics" />
       <meta property="og:image" content="https://m.media-amazon.com/og.jpg" />`,
      `<span id="productTitle">  Sony WH-1000XM5 Wireless Headphones  </span>
       <div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">$348.00</span></span></div>
       <img id="landingImage" src="https://m.media-amazon.com/main.jpg"
            data-old-hires="https://m.media-amazon.com/hires.jpg" />`,
    );
    const r = extractFromHtml(html, 'https://www.amazon.com/dp/B09XS7JWHH', 'amazon.com', 'generic_html');

    expect(r.title).toBe('Sony WH-1000XM5 Wireless Headphones');
    expect(r.priceText).toBe('$348');
    expect(r.imageUrl).toBe('https://m.media-amazon.com/hires.jpg');
    expect(r.confidence).toBe('high');
  });

  it('formats an amazon.es price in euros', () => {
    const html = page(
      '',
      `<span id="productTitle">Cafetera Express</span>
       <span class="a-price"><span class="a-offscreen">89,99 €</span></span>`,
    );
    const r = extractFromHtml(html, 'https://www.amazon.es/dp/X', 'amazon.es', 'generic_html');
    expect(r.title).toBe('Cafetera Express');
    expect(r.priceText).toBe('€89,99');
  });
});

// ─── JSON-LD — generic foreign shop ──────────────────────────────────────────

describe('extractFromHtml — JSON-LD', () => {
  it('extracts a product from JSON-LD with EUR currency', () => {
    const html = page(
      `<script type="application/ld+json">
        {"@type":"Product","name":"Zapatillas Running",
         "image":"https://cdn.shop.es/z.jpg",
         "offers":{"@type":"Offer","price":"79.95","priceCurrency":"EUR"}}
       </script>`,
      '<h1>Zapatillas Running</h1>',
    );
    const r = extractFromHtml(html, 'https://shop.es/p/123', 'shop.es', 'generic_html');
    expect(r.title).toBe('Zapatillas Running');
    expect(r.priceText).toBe('€79,95');
    expect(r.imageUrl).toBe('https://cdn.shop.es/z.jpg');
    expect(r.confidence).toBe('high');
  });
});

// ─── Microdata — schema.org Product ──────────────────────────────────────────

describe('extractFromHtml — microdata', () => {
  it('extracts a product from microdata with explicit priceCurrency', () => {
    const html = page(
      '',
      `<div itemscope itemtype="https://schema.org/Product">
        <h1 itemprop="name">Bluetooth Speaker</h1>
        <img itemprop="image" src="https://cdn.shop.in/sp.jpg" />
        <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
          <meta itemprop="price" content="1299" />
          <meta itemprop="priceCurrency" content="INR" />
        </div>
       </div>`,
    );
    const r = extractFromHtml(html, 'https://newshop.in/p/9', 'newshop.in', 'generic_html');
    expect(r.title).toBe('Bluetooth Speaker');
    expect(r.priceText).toContain('₹');
    expect(r.priceText).toContain('1,299');
    expect(r.imageUrl).toBe('https://cdn.shop.in/sp.jpg');
  });
});

// ─── Embedded __NEXT_DATA__ — works on the cheap HTTP path ───────────────────

describe('extractFromHtml — embedded hydration JSON', () => {
  it('extracts a product from __NEXT_DATA__ without a browser', () => {
    const html = page(
      '<title>Flipkart</title>',
      `<script id="__NEXT_DATA__" type="application/json">
        {"props":{"pageProps":{"product":{"name":"Wireless Mouse","price":1499,
         "currency":"INR","image":"https://cdn.flip.com/m.jpg"}}}}
       </script>`,
    );
    const r = extractFromHtml(html, 'https://flipkart.com/wireless-mouse/p/x', 'flipkart.com', 'generic_html');
    expect(r.title).toBe('Wireless Mouse');
    expect(r.priceText).toContain('₹');
    expect(r.imageUrl).toBe('https://cdn.flip.com/m.jpg');
  });
});

// ─── AliExpress — window.runParams adapter ───────────────────────────────────

describe('extractFromHtml — AliExpress', () => {
  it('extracts price/title/image from window.runParams', () => {
    const html = page(
      `<meta property="og:title" content="Smart Watch" />`,
      `<script>window.runParams = {"data":{
         "titleModule":{"subject":"Smart Watch X8 Pro"},
         "priceModule":{"minActivityAmount":{"value":29.99,"currency":"USD"},
                        "formatedActivityPrice":"US $29.99"},
         "imageModule":{"imagePathList":["//ae01.alicdn.com/kf/main.jpg"]}}};</script>`,
    );
    const r = extractFromHtml(html, 'https://aliexpress.com/item/100500.html', 'aliexpress.com', 'generic_html');
    expect(r.title).toBe('Smart Watch X8 Pro');
    expect(r.priceText).toBe('$29.99');
    expect(r.imageUrl).toBe('https://ae01.alicdn.com/kf/main.jpg');
  });
});

// ─── Anti-bot rejection ──────────────────────────────────────────────────────

describe('extractFromHtml — anti-bot', () => {
  it('returns an empty result for a challenge page', () => {
    const html = page(
      '<title>Just a moment...</title>',
      '<div class="cf-challenge-running">Checking your browser</div>',
    );
    const r = extractFromHtml(html, 'https://walmart.com/ip/x', 'walmart.com', 'generic_html');
    expect(r.title).toBeNull();
    expect(r.confidence).toBe('none');
  });
});

// ─── Kill switch ─────────────────────────────────────────────────────────────

describe('extractFromHtml — PARSER_UNIVERSAL_EXTRACT_DISABLED', () => {
  it('skips embedded-JSON extraction when the kill switch is set', () => {
    const html = page(
      '<title>Some Shop</title>',
      `<script id="__NEXT_DATA__" type="application/json">
        {"props":{"pageProps":{"product":{"name":"Hidden Item","price":999,
         "currency":"USD","image":"https://cdn.x.com/i.jpg"}}}}
       </script>`,
    );
    process.env.PARSER_UNIVERSAL_EXTRACT_DISABLED = '1';
    try {
      const r = extractFromHtml(html, 'https://someshop.com/p', 'someshop.com', 'generic_html');
      // Embedded JSON is the only product source — with the switch on it is skipped.
      expect(r.priceText).toBeNull();
      expect(r.title).not.toBe('Hidden Item');
    } finally {
      delete process.env.PARSER_UNIVERSAL_EXTRACT_DISABLED;
    }
  });
});
