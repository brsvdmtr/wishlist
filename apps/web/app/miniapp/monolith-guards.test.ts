// Lint-style regression guards for apps/web/app/miniapp/MiniApp.tsx.
//
// MiniApp.tsx is a 33k-LOC monolith; full unit testing waits on extraction.
// In the meantime, the L2/L3/L6/L8 lessons in BUGFIX_LESSONS still need
// SOME regression signal — this file grep-checks the source for known
// anti-patterns and missing-attribute classes the lessons cataloged.
//
// Treat each assertion as "the next reviewer can copy this regex if they
// re-introduce the bug" — not as exhaustive UI testing.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MINI_APP_SRC = readFileSync(resolve(__dirname, 'MiniApp.tsx'), 'utf-8');

describe('MiniApp.tsx — L3 regression (item-image lazy-load attribute)', () => {
  // L3 (2026-05-08) was specifically about item / wishlist-card / linked-item
  // thumbnails rendered in scrollable lists — a wishlist with 28 items loaded
  // 28 CDN thumbnails in parallel. Single-shot preview <img> tags
  // (photoPreviewSrc, upload-preview, etc.) are user-triggered single-image
  // renders and don't suffer the same regression class, so the guard narrows
  // to imageUrl-bound <img> tags that drive list rendering.
  function itemImgTags(): string[] {
    // Multi-line tag match via [\s\S]
    const tags = MINI_APP_SRC.match(/<img\b[\s\S]*?\/?>/g) ?? [];
    return tags.filter((tag) => {
      // Imageurl-bound list rendering, but skip single-shot fullscreen
      // viewers (viewingItem, photoPreviewSrc) where lazy loading doesn't
      // help — they fire on user tap, not on list scroll.
      if (!/\b(src|srcSet)=\{[^}]*\bimageUrl\b/.test(tag)) return false;
      if (/\bviewingItem\.imageUrl\b/.test(tag)) return false;
      if (/\bonboardingDemoItem\.imageUrl\b/.test(tag)) return false;
      return true;
    });
  }

  it('every item-thumbnail <img> uses loading="lazy"', () => {
    const offenders = itemImgTags().filter((tag) => !/\bloading=["']lazy["']/.test(tag));
    if (offenders.length > 0) {
      const preview = offenders.slice(0, 3).map((t) => t.slice(0, 120)).join('\n---\n');
      throw new Error(`Found ${offenders.length} item-thumbnail <img> tag(s) without loading="lazy":\n${preview}`);
    }
    expect(offenders).toHaveLength(0);
  });

  it('every item-thumbnail <img> uses decoding="async"', () => {
    const offenders = itemImgTags().filter((tag) => !/\bdecoding=["']async["']/.test(tag));
    if (offenders.length > 0) {
      const preview = offenders.slice(0, 3).map((t) => t.slice(0, 120)).join('\n---\n');
      throw new Error(`Found ${offenders.length} item-thumbnail <img> tag(s) without decoding="async":\n${preview}`);
    }
    expect(offenders).toHaveLength(0);
  });

  it('finds at least one item-thumbnail <img> in the monolith (sanity)', () => {
    // If the regex misses every imageUrl-bound <img>, the above guards
    // would silently vacuously pass. Pin the lower bound so refactors
    // that break the regex itself become visible.
    expect(itemImgTags().length).toBeGreaterThan(5);
  });
});

describe('MiniApp.tsx — hardcoded-locale regression guard (L1 anti-pattern)', () => {
  it('does NOT hardcode `Locale = ru` in notification-recipient contexts', () => {
    // L1 (2026-05-10): hardcoded `const notifLocale: Locale = 'ru'` in
    // 7+ API-side callsites meant every subscriber got Russian text
    // regardless of their actual locale. Frontend equivalent would be a
    // const-style locale pin in notification rendering code.
    const offenders = MINI_APP_SRC.match(/notifLocale\s*[:=]\s*['"](ru|en)['"]/g) ?? [];
    expect(offenders).toHaveLength(0);
  });
});

describe('MiniApp.tsx — user.session_started emitter guard (2026-05-20 regression)', () => {
  // 2026-05-20: `user.session_started` was a declared PRODUCT_EVENT
  // (analyticsEvents.ts, sources: ['client']) consumed by the daily-activity
  // rollup (services/daily-activity.service.ts → EVENT_TO_FIELD →
  // UserDailyActivity.sessionStarted) and allowed through telemetry ingest —
  // but NO client callsite emitted it. Taxonomy + consumer + ingest all
  // green; the emitter never existed, so every rollup row had
  // sessionStarted=0. The Mini App must mirror each successful bootstrap to
  // `user.session_started`.
  it('emits user.session_started somewhere in the monolith', () => {
    expect(MINI_APP_SRC).toContain("'user.session_started'");
  });

  it('gates the user.session_started emission on miniapp.bootstrap_succeeded', () => {
    // The mirror must be tied to the successful-bootstrap path — a bare
    // emission elsewhere would not match the "user opened the app today"
    // semantics the rollup assumes.
    const mirror = /event === 'miniapp\.bootstrap_succeeded'[\s\S]{0,400}'user\.session_started'/;
    expect(mirror.test(MINI_APP_SRC)).toBe(true);
  });
});

describe('MiniApp.tsx — file shape sanity', () => {
  it('is the expected monolith size (~33k LOC, well above the extraction threshold)', () => {
    // When this drops below 5 000 LOC an extraction wave landed and the
    // lint-style guards above can be replaced by proper component tests.
    const lines = MINI_APP_SRC.split('\n').length;
    expect(lines).toBeGreaterThan(20_000); // current ~33 246
  });
});
