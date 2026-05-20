/**
 * Tests for the universal structured-data extractors.
 */
import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import {
  parseAmount,
  detectCurrency,
  extractJsonLd,
  extractMicrodata,
  extractOpenGraph,
  extractTwitterCard,
} from './structured-data.js';

// ─── parseAmount ─────────────────────────────────────────────────────────────

describe('parseAmount', () => {
  it('passes plain numbers through', () => {
    expect(parseAmount(1299)).toBe(1299);
    expect(parseAmount(19.99)).toBe(19.99);
  });
  it('parses US grouping with decimal point', () => {
    expect(parseAmount('1,299.00')).toBe(1299);
    expect(parseAmount('$1,234.56')).toBe(1234.56);
  });
  it('parses EU grouping with decimal comma', () => {
    expect(parseAmount('1.299,00')).toBe(1299);
    expect(parseAmount('29,99 €')).toBe(29.99);
  });
  it('parses space grouping', () => {
    expect(parseAmount('1 299 ₽')).toBe(1299);
  });
  it('parses Indian lakh grouping', () => {
    expect(parseAmount('₹1,29,900')).toBe(129900);
  });
  it('treats a bare comma with 2 trailing digits as decimal', () => {
    expect(parseAmount('19,99')).toBe(19.99);
  });
  it('treats a bare comma with 3 trailing digits as grouping', () => {
    expect(parseAmount('1,299')).toBe(1299);
  });
  it('returns null for non-numeric / empty input', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('Out of stock')).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount(0)).toBeNull();
  });
});

// ─── detectCurrency ──────────────────────────────────────────────────────────

describe('detectCurrency', () => {
  it('detects from symbols', () => {
    expect(detectCurrency('$19.99')).toBe('USD');
    expect(detectCurrency('1 299 ₽')).toBe('RUB');
    expect(detectCurrency('29,99 €')).toBe('EUR');
    expect(detectCurrency('₹1,299')).toBe('INR');
    expect(detectCurrency('¥199')).toBe('CNY');
    expect(detectCurrency('£49.50')).toBe('GBP');
  });
  it('detects from ISO codes and aliases', () => {
    expect(detectCurrency('USD 19')).toBe('USD');
    expect(detectCurrency('Rs. 499')).toBe('INR');
    expect(detectCurrency('199 RMB')).toBe('CNY');
  });
  it('returns null when no signal', () => {
    expect(detectCurrency('1299')).toBeNull();
    expect(detectCurrency('')).toBeNull();
  });
});

// ─── extractJsonLd ───────────────────────────────────────────────────────────

describe('extractJsonLd', () => {
  it('extracts a top-level Product node', () => {
    const html = `<html><head><script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Product","name":"Wireless Headphones",
       "image":"https://cdn.example.com/h.jpg","description":"Great sound",
       "offers":{"@type":"Offer","price":"129.99","priceCurrency":"USD"}}
    </script></head><body></body></html>`;
    const r = extractJsonLd(cheerio.load(html));
    expect(r?.title).toBe('Wireless Headphones');
    expect(r?.price).toBe(129.99);
    expect(r?.currency).toBe('USD');
    expect(r?.image).toBe('https://cdn.example.com/h.jpg');
  });

  it('finds a Product inside @graph', () => {
    const html = `<script type="application/ld+json">
      {"@graph":[{"@type":"BreadcrumbList"},
       {"@type":"Product","name":"Camiseta Azul",
        "offers":{"@type":"Offer","price":"24.95","priceCurrency":"EUR"}}]}
    </script>`;
    const r = extractJsonLd(cheerio.load(html));
    expect(r?.title).toBe('Camiseta Azul');
    expect(r?.price).toBe(24.95);
    expect(r?.currency).toBe('EUR');
  });

  it('reads AggregateOffer lowPrice', () => {
    const html = `<script type="application/ld+json">
      {"@type":"Product","name":"Saree","offers":{"@type":"AggregateOffer",
       "lowPrice":"1499","highPrice":"2999","priceCurrency":"INR"}}
    </script>`;
    const r = extractJsonLd(cheerio.load(html));
    expect(r?.price).toBe(1499);
    expect(r?.currency).toBe('INR');
  });

  it('returns null when there is no Product JSON-LD', () => {
    const html = `<script type="application/ld+json">{"@type":"WebSite","name":"x"}</script>`;
    expect(extractJsonLd(cheerio.load(html))).toBeNull();
  });

  it('skips malformed JSON without throwing', () => {
    const html = `<script type="application/ld+json">{ this is not json </script>`;
    expect(extractJsonLd(cheerio.load(html))).toBeNull();
  });
});

// ─── extractMicrodata ────────────────────────────────────────────────────────

describe('extractMicrodata', () => {
  it('extracts a schema.org Product with nested offer', () => {
    const html = `<div itemscope itemtype="https://schema.org/Product">
      <h1 itemprop="name">Coffee Grinder</h1>
      <img itemprop="image" src="https://cdn.example.com/g.jpg" />
      <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
        <meta itemprop="price" content="3499" />
        <meta itemprop="priceCurrency" content="CNY" />
      </div>
    </div>`;
    const r = extractMicrodata(cheerio.load(html));
    expect(r?.title).toBe('Coffee Grinder');
    expect(r?.price).toBe(3499);
    expect(r?.currency).toBe('CNY');
    expect(r?.image).toBe('https://cdn.example.com/g.jpg');
  });

  it('returns null when no Product itemscope is present', () => {
    const html = `<div itemscope itemtype="https://schema.org/Organization">
      <span itemprop="name">Acme</span></div>`;
    expect(extractMicrodata(cheerio.load(html))).toBeNull();
  });
});

// ─── extractOpenGraph ────────────────────────────────────────────────────────

describe('extractOpenGraph', () => {
  it('extracts og + product:price meta', () => {
    const html = `<head>
      <meta property="og:title" content="Running Shoes" />
      <meta property="og:image" content="https://cdn.example.com/s.jpg" />
      <meta property="og:description" content="Lightweight" />
      <meta property="product:price:amount" content="89.90" />
      <meta property="product:price:currency" content="GBP" />
    </head>`;
    const r = extractOpenGraph(cheerio.load(html));
    expect(r?.title).toBe('Running Shoes');
    expect(r?.price).toBe(89.9);
    expect(r?.currency).toBe('GBP');
    expect(r?.image).toBe('https://cdn.example.com/s.jpg');
  });

  it('returns null with no og tags', () => {
    expect(extractOpenGraph(cheerio.load('<head><title>x</title></head>'))).toBeNull();
  });
});

// ─── extractTwitterCard ──────────────────────────────────────────────────────

describe('extractTwitterCard', () => {
  it('extracts twitter title/image and labelled price', () => {
    const html = `<head>
      <meta name="twitter:title" content="Desk Lamp" />
      <meta name="twitter:image" content="https://cdn.example.com/l.jpg" />
      <meta name="twitter:label1" content="Price" />
      <meta name="twitter:data1" content="$45.00" />
    </head>`;
    const r = extractTwitterCard(cheerio.load(html));
    expect(r?.title).toBe('Desk Lamp');
    expect(r?.image).toBe('https://cdn.example.com/l.jpg');
    expect(r?.price).toBe(45);
    expect(r?.currency).toBe('USD');
  });

  it('returns null with no twitter tags', () => {
    expect(extractTwitterCard(cheerio.load('<head></head>'))).toBeNull();
  });
});
