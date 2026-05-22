/**
 * Tests for Shopify / WooCommerce product-JSON detection + parsing.
 */
import { describe, it, expect } from 'vitest';
import {
  detectStorePlatform, isWooProductPage, buildShopifyJsonUrl, parseShopifyJson,
  buildWooStoreApiUrls, wooSlugFromUrl, parseWooJson, detectShopifyCurrency,
  sameProductUrl,
} from './product-json.js';

describe('detectStorePlatform', () => {
  it('detects Shopify from its CDN / global markers', () => {
    expect(detectStorePlatform('<script src="https://cdn.shopify.com/x.js">')).toBe('shopify');
    expect(detectStorePlatform('<script>window.Shopify = {};</script>')).toBe('shopify');
    expect(detectStorePlatform('<div class="shopify-section">')).toBe('shopify');
  });
  it('does not false-positive on prose mentioning shopify', () => {
    expect(detectStorePlatform('<p>We migrated off Shopify last year.</p>')).toBe(null);
  });
  it('detects WooCommerce from its asset path', () => {
    expect(detectStorePlatform('<link href="/wp-content/plugins/woocommerce/a.css">'))
      .toBe('woocommerce');
  });
  it('returns null for a plain page', () => {
    expect(detectStorePlatform('<html><body>hello world</body></html>')).toBe(null);
  });
});

describe('isWooProductPage', () => {
  it('detects a WooCommerce single-product page from the body class', () => {
    expect(isWooProductPage('<body class="product-template-default single-product">'))
      .toBe(true);
  });
  it('rejects WooCommerce cart / category / account pages', () => {
    expect(isWooProductPage('<body class="woocommerce-cart woocommerce-page">')).toBe(false);
    expect(isWooProductPage('<body class="post-type-archive-product">')).toBe(false);
    expect(isWooProductPage('<body class="woocommerce-account">')).toBe(false);
  });
});

describe('buildShopifyJsonUrl', () => {
  it('appends .json to a product path', () => {
    expect(buildShopifyJsonUrl(new URL('https://shop.com/products/cool-hat')))
      .toBe('https://shop.com/products/cool-hat.json');
  });
  it('reduces a collection / locale-prefixed URL to the canonical root .json', () => {
    expect(buildShopifyJsonUrl(new URL('https://shop.com/en/collections/x/products/hat?v=1#z')))
      .toBe('https://shop.com/products/hat.json');
  });
  it('returns null when /products/ is not the final path segment', () => {
    expect(buildShopifyJsonUrl(new URL('https://shop.com/pages/about'))).toBe(null);
    expect(buildShopifyJsonUrl(new URL('https://shop.com/products/hat/reviews'))).toBe(null);
  });
});

describe('parseShopifyJson', () => {
  const fixture = JSON.stringify({
    product: {
      title: 'Cool Hat',
      images: [{ src: 'https://cdn/img1.jpg' }, { src: 'https://cdn/img2.jpg' }],
      variants: [
        { price: '0.00', available: false },
        { price: '29.99', available: true },
      ],
    },
  });
  it('extracts title, first image, and the first available variant price', () => {
    const r = parseShopifyJson(fixture);
    expect(r?.title).toBe('Cool Hat');
    expect(r?.image).toBe('https://cdn/img1.jpg');
    expect(r?.price).toBe(29.99);
    expect(r?.currency).toBe(null);    // not in the Shopify endpoint
    expect(r?.sourceUrl).toBe(null);   // Shopify is exact-by-construction
  });
  it('returns null on malformed or empty JSON', () => {
    expect(parseShopifyJson('{not json')).toBe(null);
    expect(parseShopifyJson('{"foo":1}')).toBe(null);
  });
});

describe('WooCommerce Store API', () => {
  it('builds the versioned + legacy endpoint URLs', () => {
    const urls = buildWooStoreApiUrls('https://shop.com', 'red shoe');
    expect(urls[0]).toBe('https://shop.com/wp-json/wc/store/v1/products?slug=red%20shoe');
    expect(urls[1]).toBe('https://shop.com/wp-json/wc/store/products?slug=red%20shoe');
  });
  it('takes the slug from the last path segment', () => {
    expect(wooSlugFromUrl(new URL('https://shop.com/product/red-shoe/'))).toBe('red-shoe');
    expect(wooSlugFromUrl(new URL('https://shop.com/'))).toBe(null);
  });
  it('parses the product shape incl. minor-unit price, currency, permalink', () => {
    const fixture = JSON.stringify([{
      name: 'Red Shoe',
      permalink: 'https://shop.com/product/red-shoe/',
      images: [{ src: 'https://cdn/shoe.jpg' }],
      prices: { price: '2999', currency_code: 'eur', currency_minor_unit: 2 },
    }]);
    const r = parseWooJson(fixture);
    expect(r?.title).toBe('Red Shoe');
    expect(r?.price).toBe(29.99);
    expect(r?.currency).toBe('EUR');   // upper-cased
    expect(r?.image).toBe('https://cdn/shoe.jpg');
    expect(r?.sourceUrl).toBe('https://shop.com/product/red-shoe/');
  });
  it('handles a zero-minor-unit currency (e.g. JPY)', () => {
    const fixture = JSON.stringify([{
      name: 'Item', prices: { price: '500', currency_code: 'JPY', currency_minor_unit: 0 },
    }]);
    expect(parseWooJson(fixture)?.price).toBe(500);
  });
});

describe('sameProductUrl', () => {
  it('matches the same product regardless of query, hash, www, trailing slash', () => {
    expect(sameProductUrl(
      'https://shop.com/product/red-shoe/',
      'https://www.shop.com/product/red-shoe?utm_source=x#reviews',
    )).toBe(true);
  });
  it('rejects a different product path (wrong-slug Store-API hit)', () => {
    expect(sameProductUrl(
      'https://shop.com/product/red-shoe/',
      'https://shop.com/product/blue-hat/',
    )).toBe(false);
  });
  it('rejects a different host and garbage input', () => {
    expect(sameProductUrl('https://a.com/p/x', 'https://b.com/p/x')).toBe(false);
    expect(sameProductUrl('not a url', 'https://shop.com/p')).toBe(false);
  });
});

describe('detectShopifyCurrency', () => {
  it('reads the active Shopify currency', () => {
    expect(detectShopifyCurrency('Shopify.currency = {"active":"USD","rate":"1.0"};'))
      .toBe('USD');
  });
  it('reads og:price:currency', () => {
    expect(detectShopifyCurrency('<meta property="og:price:currency" content="EUR">'))
      .toBe('EUR');
  });
  it('upper-cases a lower-case currency code', () => {
    expect(detectShopifyCurrency('var x = {"currency":"gbp"};')).toBe('GBP');
  });
  it('returns null when no currency marker is present', () => {
    expect(detectShopifyCurrency('<html><body>x</body></html>')).toBe(null);
  });
});
