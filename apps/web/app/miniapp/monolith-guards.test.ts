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
    // Assert it appears as an `event:` property assignment, not merely the
    // bare string. Paired with the gating guard below (which a stray comment
    // alone cannot satisfy), this pins the real emitter.
    expect(MINI_APP_SRC).toMatch(/event:\s*'user\.session_started'/);
  });

  it('gates the user.session_started emission on miniapp.bootstrap_succeeded', () => {
    // The mirror must sit inside the `if (event === 'miniapp.bootstrap_succeeded')`
    // block — a bare emission elsewhere would not match the per-app-open
    // semantics the session-start event represents. Anchored on the `if (`
    // form, so comment edits before the block don't affect the match; the
    // 600-char window leaves room for statements added inside the block.
    const mirror = /if \(event === 'miniapp\.bootstrap_succeeded'[\s\S]{0,600}event: 'user\.session_started'/;
    expect(mirror.test(MINI_APP_SRC)).toBe(true);
  });
});

describe('MiniApp.tsx — F1 lazy-screen regression guard (2026-05-25)', () => {
  // F1 of REFACTOR_MINIAPP_TSX_PLAN wraps 4 already-extracted screens
  // in `next/dynamic({ ssr: false })` so they fetch as separate chunks
  // and don't bloat the initial `miniapp/page-*.js` bundle. Combined
  // saving: ~−84 KB brotli on initial.
  //
  // An "innocent" PR that converts any of these back to a static
  // `import { X } from './screens/...'` would silently destroy the
  // perf win — no test or type check would notice. These regex
  // guards make that revert visible in CI.

  const LAZY_SCREENS = [
    { name: 'AppearanceSettings',   path: './screens/AppearanceSettings' },
    { name: 'CalendarRoot',         path: './screens/calendar/CalendarRoot' },
    { name: 'SearchScreen',         path: './screens/SearchScreen' },
    { name: 'SurveyScreen',         path: './screens/survey/SurveyScreen' },
    // F4 Wave A — cold-path static screens reached only via Settings.
    { name: 'FAQScreen',            path: './screens/FAQScreen' },
    { name: 'ChangelogScreen',      path: './screens/ChangelogScreen' },
    { name: 'LegalMenuScreen',      path: './screens/LegalMenuScreen' },
    { name: 'LegalDocViewerScreen', path: './screens/LegalDocViewerScreen' },
    // F4 Wave A++ — Gift Notes onboarding flow.
    { name: 'GiftNotesOnboardingContent', path: './screens/GiftNotesOnboardingContent' },
    // F4 Wave B — Secret Santa cluster (9 screens, ~3.16k LOC).
    { name: 'SantaRoot', path: './screens/santa/SantaRoot' },
    // F4 Wave C — Gift Notes cluster (3 screens + 2 sheets, ~695 LOC).
    { name: 'GiftNotesRoot', path: './screens/gift-notes/GiftNotesRoot' },
    // F4 Wave D-1 — Settings screen (~746 LOC).
    { name: 'SettingsRoot', path: './screens/settings/SettingsRoot' },
    // F4 Wave D-2 — Showcase cluster (editor + preview, ~858 LOC).
    { name: 'ShowcaseRoot', path: './screens/showcase/ShowcaseRoot' },
    // F4 Wave D-3 — Group Gift cluster (5 screens, ~960 LOC).
    { name: 'GroupGiftRoot', path: './screens/group-gift/GroupGiftRoot' },
    // F4 Wave D-4 — Profile screen (~1771 LOC).
    { name: 'ProfileRoot', path: './screens/profile/ProfileRoot' },
    // F4 Wave A++ — Public-profile screen (~379 LOC).
    { name: 'PublicProfileRoot', path: './screens/public-profile/PublicProfileRoot' },
    // F4 Wave A++ — Referral cluster (referral + referral-history, ~568 LOC).
    { name: 'ReferralRoot', path: './screens/referral/ReferralRoot' },
    // F4 Wave E — Guest View cluster (guest-view + guest-item-detail
    // + filter sheet, ~1.15k LOC). Deep-link-only cold path.
    { name: 'GuestViewRoot', path: './screens/guest/GuestViewRoot' },
  ] as const;

  for (const { name, path } of LAZY_SCREENS) {
    it(`${name} is wrapped in next/dynamic with ssr:false`, () => {
      // Must match the canonical pattern:
      //   const Name = dynamic(
      //     () => import('./screens/...').then(m => ({ default: m.Name })),
      //     { ssr: false, loading: ... },
      //   );
      // Tolerant of whitespace / line-breaks; strict on the wrapper
      // and the ssr:false toggle.
      const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Tolerant of an optional importer wrapper (e.g. withChunkRetry(() => import(...)))
      // — the 2026-05-28 chunkRetry helper retries ChunkLoadError once before
      // surrendering to the boundary. The wrapper must NOT defeat dynamic()'s
      // chunk-split (separately asserted via the static-import guard below).
      const dynamicCall = new RegExp(
        `const\\s+${name}\\s*=\\s*dynamic\\(\\s*(?:\\w+\\(\\s*)?\\(\\)\\s*=>\\s*import\\(['"]${escapedPath}['"]\\)`,
      );
      expect(MINI_APP_SRC, `${name} must be dynamic()-wrapped`).toMatch(dynamicCall);
      // The ssr:false toggle is what keeps the chunk out of the server
      // bundle — verify it appears in the same `const Name = dynamic(...)`
      // statement. We anchor on `const Name` and stop at the next
      // `);` — that's the dynamic() statement terminator.
      const block = MINI_APP_SRC.match(
        new RegExp(`const\\s+${name}\\s*=\\s*dynamic\\([\\s\\S]*?\\);`),
      );
      expect(block, `dynamic() block for ${name} not found`).not.toBeNull();
      expect(block![0], `${name} dynamic() block missing ssr:false`).toMatch(/ssr:\s*false/);
    });

    it(`${name} is NOT also statically imported (would defeat dynamic())`, () => {
      // A residual `import { Name } from '...'` line would force the
      // bundler to include the chunk eagerly, no matter what dynamic()
      // says about it.
      //
      // KNOWN GAP: this regex anchors on a path ending in the symbol name
      // (`./screens/.../Name`). If `screens/` ever grows a barrel
      // `index.ts` that re-exports the screen, a future
      // `import { CalendarRoot } from './screens/calendar'` would slip
      // through. Tighten this guard if `screens/index.ts` ever lands —
      // for now no barrel exists.
      const staticImport = new RegExp(
        `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"][^'"]*${name}['"]`,
      );
      expect(MINI_APP_SRC, `${name} must not also be statically imported`).not.toMatch(staticImport);
    });
  }

  it('Skeleton loading fallback uses @wishlist/ui primitive (not feature-local clone)', () => {
    // Per design-system rule: feature-local skeleton clones are banned.
    // The 4 dynamic() blocks must use the `Skeleton` from @wishlist/ui.
    expect(MINI_APP_SRC).toMatch(/import\s*\{[^}]*\bSkeleton\b[^}]*\}\s*from\s*['"]@wishlist\/ui['"]/);
    // Each dynamic() block has a loading: () => <Skeleton ...
    const loadingCount = (MINI_APP_SRC.match(/loading:\s*\(\)\s*=>\s*<Skeleton\b/g) ?? []).length;
    expect(loadingCount).toBeGreaterThanOrEqual(4);
  });
});

describe('MiniApp.tsx — file shape sanity', () => {
  it('is the expected monolith size (~24k LOC, post-F4/F5/F7/Wave E extraction)', () => {
    // When this drops below 5 000 LOC an extraction wave landed and the
    // lint-style guards above can be replaced by proper component tests.
    // The 20 000 floor is the kill-switch — when MiniApp.tsx drops below
    // it, revisit these regex guards and migrate to per-Root component
    // tests instead.
    const lines = MINI_APP_SRC.split('\n').length;
    expect(lines).toBeGreaterThan(20_000); // current ~23 650
  });
});

describe('MiniApp.tsx — F3 cluster-state hook drift guard', () => {
  // F3 hooks extract per-cluster state out of inline `useState` declarations
  // and into a named hook. An "innocent" PR that re-introduces an inline
  // `useState` for one of these names would silently undo the F3 setup AND
  // create two competing sources of truth for the same state.

  const F3_HOOKS = [
    {
      hook: 'useGiftNotesState',
      // Sample of names returned — if any of these appear in an inline
      // `useState` again, the drift guard fires.
      drift: ['gnAccess', 'gnOccasions', 'gnViewingOccasion'],
    },
    {
      hook: 'useSantaState',
      drift: ['santaSeason', 'santaCampaigns', 'currentSantaCampaign', 'santaChatMessages'],
    },
    {
      hook: 'useShowcaseState',
      drift: ['showcaseData', 'showcaseAvailableWishlists', 'showcaseLoading', 'showcaseBrandInput'],
    },
    {
      hook: 'useGroupGiftState',
      drift: ['groupGiftData', 'groupGiftMessages', 'ggTargetAmt', 'ggChatMsg', 'ggAccess'],
    },
    {
      hook: 'useGuestViewState',
      drift: ['guestWl', 'guestItems', 'guestBudgetMax', 'guestSort', 'guestFilterOpen', 'draftBudget'],
    },
    // F7 — extracted from MiniApp.tsx after the matching Root file already
    // existed. Hook returns the same inline names; MiniApp.tsx destructures
    // once and forwards via the Root's ctx (intersected with `SettingsState`).
    {
      hook: 'useSettingsState',
      drift: ['settingsData', 'settingsLoading', 'cardDisplayMode'],
    },
    {
      hook: 'usePublicProfileState',
      drift: ['publicProfileData', 'publicProfileLoading', 'publicProfileError', 'publicProfileSubscribed'],
    },
    {
      hook: 'useReferralState',
      drift: ['referralMe', 'referralHistory', 'referralRulesConfig', 'referralShareSheet'],
    },
    {
      hook: 'useProfileState',
      drift: ['profileData', 'profileStats', 'editingProfile', 'showAvatarSheet'],
    },
  ] as const;

  for (const { hook, drift } of F3_HOOKS) {
    it(`${hook} is invoked exactly once in MiniApp.tsx`, () => {
      // Match `= useHookName(` — the only legitimate call form (destructure
      // assignment from a hook). Comments containing the hook name are excluded
      // because they lack the `=` prefix.
      const callRe = new RegExp(`=\\s*${hook}\\s*\\(`, 'g');
      const count = (MINI_APP_SRC.match(callRe) ?? []).length;
      expect(count, `${hook}() expected exactly 1 invocation, found ${count}`).toBe(1);
    });

    for (const name of drift) {
      it(`${name} is NOT re-declared inline as useState after ${hook} extraction`, () => {
        // Match patterns like `const [gnAccess, setGnAccess] = useState`.
        const inlineDecl = new RegExp(
          `const\\s*\\[\\s*${name}\\b[^\\]]*\\]\\s*=\\s*useState`,
        );
        expect(
          MINI_APP_SRC,
          `${name} was re-declared inline — ${hook} hook is now bypassed`,
        ).not.toMatch(inlineDecl);
      });
    }
  }
});

describe('MiniApp.tsx — Pro-upsell content guards (2026-05-22 monetization audit)', () => {
  // Source: docs/research/03-monetization-paywall-audit.md §8.7–8.8.
  // Extraction of getUpsellContent from the monolith is still deferred, so
  // these stay grep-style guards on the source text — same approach as the
  // L3 / user.session_started guards above.

  it('the appearance upsell builds copy via t(), with no hardcoded Russian', () => {
    // §8.8: getUpsellContent.appearance shipped hardcoded Cyrillic
    // title/subtitle/benefits while every other context resolved copy via
    // t(). A re-hardcode (or a dropped key) regresses non-RU users to
    // Russian on the theme/accent paywall.
    const block = MINI_APP_SRC.match(/\n {2}appearance: \{[\s\S]*?\n {2}\},/);
    if (!block) throw new Error('getUpsellContent.appearance entry not found');
    const src = block[0];
    for (const call of [
      "t('upsell_appearance_title', locale)",
      "t('upsell_appearance_subtitle', locale)",
      "t('upsell_appearance_b1', locale)",
      "t('upsell_appearance_b2', locale)",
      "t('upsell_appearance_b3', locale)",
    ]) {
      expect(src.includes(call), `appearance upsell missing ${call}`).toBe(true);
    }
    expect(/[А-Яа-яЁё]/.test(src), 'appearance upsell still contains hardcoded Cyrillic').toBe(false);
  });

  it('the dead bot_import upsell context is fully removed', () => {
    // §8.7: bot_import was a UpsellContext union member with a
    // getUpsellContent entry duplicating url_import, but had zero triggers —
    // the bot's import-limit→upgrade path deep-links to the 'pro_main'
    // context instead. Removed 2026-05-22.
    expect(MINI_APP_SRC).not.toMatch(/bot_import/);
  });
});

describe('MiniApp.tsx — extracted-Root render-site guard (extraction-drift class)', () => {
  // An F4 extraction lands three coupled things: the `dynamic()` import,
  // the `<Name>RootCtx` bag, and the JSX render site that swaps the inline
  // `{screen === '<x>' && (() => {...})()}` IIFE for `<Name .../>`. When
  // the render-site half is dropped (made on a worktree branch that never
  // merges), the import + the orphaned file reach main while the inline
  // IIFE keeps rendering — and the two copies silently diverge.
  //
  // This bit both SettingsRoot (a formatBirthday fix had to be applied to
  // BOTH copies before it took effect in prod) and PublicProfileRoot (its
  // publicProfileRootCtx was built but consumed nowhere). Both fixed
  // 2026-05-30.
  //
  // The F1 guard above only checks each Root is *imported* (dynamic + not
  // statically imported) — never that it's *rendered*. A dead lazy chunk
  // is invisible to type-check AND to the F1 guard. This block closes that
  // gap: every ctx-bag Root that owns a screen must have a render site,
  // its inline IIFE must be gone, and its ctx bag must be consumed. Add a
  // row here whenever a new single-screen Root is extracted.
  const RENDER_GUARDED_ROOTS = [
    { root: 'SettingsRoot',      ctx: 'settingsRootCtx',      screen: 'settings' },
    { root: 'PublicProfileRoot', ctx: 'publicProfileRootCtx', screen: 'public-profile' },
  ] as const;

  for (const { root, ctx, screen } of RENDER_GUARDED_ROOTS) {
    it(`${root} is rendered, not just imported`, () => {
      // Tolerant of prop-order / line-break reformatting: anchor on the
      // opening tag + the ctx bag it must receive.
      const rendered = new RegExp(`<${root}\\b[\\s\\S]{0,80}?ctx=\\{${ctx}\\}`);
      expect(MINI_APP_SRC, `${root} must have a JSX render site`).toMatch(rendered);
    });

    it(`the inline ${screen} IIFE is gone (single source of truth)`, () => {
      // The dead inline copy was `{screen === '<x>' && (() => {`. The
      // finished extraction renders `{screen === '<x>' && (` then
      // `<Name .../>` — no IIFE. A re-introduced inline block recreates
      // the two-copies-drift hazard.
      const iife = new RegExp(`screen === '${screen}' && \\(\\(\\) =>`);
      expect(
        MINI_APP_SRC,
        `inline ${screen} IIFE re-introduced — ${root} would drift again`,
      ).not.toMatch(iife);
    });

    it(`${ctx} is consumed by a render site, not a dead bag`, () => {
      const defined = new RegExp(`const ${ctx} = \\{`).test(MINI_APP_SRC);
      const consumed = new RegExp(`ctx=\\{${ctx}\\}`).test(MINI_APP_SRC);
      expect(defined, `${ctx} bag must still be built`).toBe(true);
      expect(consumed, `${ctx} must be passed to <${root}/>`).toBe(true);
    });
  }

  it('every *RootCtx bag built in MiniAppInner is consumed by a render site', () => {
    // Generic, self-maintaining superset of the per-Root table above:
    // enumerate every `const <name>RootCtx = {` bag and require a matching
    // `ctx={<name>RootCtx}` render-site consumer. The RENDER_GUARDED_ROOTS
    // table must be extended by hand per Root; this assertion needs no
    // maintenance — a FUTURE extraction that lands a bag without a render
    // site (the exact SettingsRoot / PublicProfileRoot drift class) goes red
    // here on its own, even if nobody remembers to add a table row.
    const declared = [...MINI_APP_SRC.matchAll(/const\s+(\w+RootCtx)\s*=\s*\{/g)].map((m) => m[1]!);
    const consumed = new Set(
      [...MINI_APP_SRC.matchAll(/\bctx=\{(\w+RootCtx)\}/g)].map((m) => m[1]!),
    );
    // Sanity: enumeration must find the known bags, else the regex rotted and
    // the assertion would vacuously pass. 9 ctx-bag Roots today; the bound
    // matches that count so a rot dropping even one bag goes red.
    expect(declared.length, 'no *RootCtx bags found — enumeration regex rotted').toBeGreaterThanOrEqual(9);

    // KNOWN_UNWIRED: bags intentionally built but not yet rendered. Empty
    // today — every ctx-bag Root is wired. Add a name here ONLY alongside a
    // tracking reference if an extraction is deliberately landed half-wired.
    const KNOWN_UNWIRED = new Set<string>();

    const deadBags = declared.filter((name) => !consumed.has(name) && !KNOWN_UNWIRED.has(name));
    expect(
      deadBags,
      `dead ctx bag(s) built but never passed to a Root render site: ${deadBags.join(', ') || '(none)'}. ` +
        'Render <DomainRoot screen={screen} ctx={...} /> or delete the bag.',
    ).toEqual([]);
  });
});

describe('MiniApp.tsx — E17 paywall.viewed yearlyVariant field-name guard (2026-05-30)', () => {
  // The GET /tg/wishlists bootstrap sends the bucket-aware yearly price as
  //   proYearly: { priceXtr, priceVariant }     (server field name, mirrors E24)
  // and the client stores json.proYearly VERBATIM via setProYearlyPricing. The
  // paywall.viewed impression then tags the experiment arm from that state.
  //
  // Bug (caught in the E17 WIP, before ship): the state type + the effect read
  // used `.variant` while the stored object only ever carries `.priceVariant`,
  // so `yearlyVariant` was always `undefined` whenever the experiment was
  // active — a silently-dead telemetry tag. The price tile/CTA were fine: they
  // read `.priceXtr`, whose name matched. Shown==charged was never affected.
  //
  // The emit lives in a useEffect deep in the un-mountable monolith, so a
  // behavioural RTL test isn't possible without extraction — we grep the source
  // exactly like the user.session_started / L3 guards above. Fail-before /
  // pass-after: at the buggy revision assertion #1 fails (source read `.variant`)
  // and assertion #2 fires on any reintroduction of the `.variant` read.

  it('tags yearlyVariant from proYearlyPricing.priceVariant (the stored server field)', () => {
    expect(MINI_APP_SRC).toMatch(/yearlyVariant:\s*proYearlyPricing\.priceVariant\b/);
  });

  it('never reads the never-set proYearlyPricing.variant field', () => {
    // The negative lookahead matches a real `.variant` access but NOT the
    // longer, correct `.priceVariant` — so this fails only on the buggy read.
    expect(MINI_APP_SRC).not.toMatch(/proYearlyPricing\.variant(?![A-Za-z0-9_])/);
  });

  it('types proYearlyPricing state with priceVariant (mirrors the verbatim-stored payload)', () => {
    // The ingest does setProYearlyPricing(json.proYearly) with the raw server
    // shape, so the state field name MUST equal the server field name. A
    // `variant`-typed state is exactly what let the dead read type-check.
    expect(MINI_APP_SRC).toMatch(
      /const\s*\[\s*proYearlyPricing\s*,\s*setProYearlyPricing\s*\]\s*=\s*useState<\{[^}]*priceVariant:\s*string[^}]*\}\s*\|\s*null>/,
    );
  });
});

describe('MiniApp.tsx — circ_ deep-link must eager-load owner wishlists (empty-home regression)', () => {
  // Live-test bug (2026-06-02): opening a circle invite deep link (circ_<token>)
  // and then exiting to "Главная" — including the invalid/expired-link
  // "На главную" path — showed an empty "Пока пусто" home, because the circ_
  // boot branch never loaded the user's OWN wishlists, while every other
  // deep-link branch (guest, srvy_, br_, item_, …) does. The home renders its
  // empty state on `wishlists.length === 0`, so a never-loaded list is
  // indistinguishable from a genuinely empty one.
  //
  // The monolith can't be mounted, so we grep the source exactly like the
  // guards above: the circ_ branch body — from `startsWith('circ_')` up to the
  // next branch `startsWith('br_')` — must contain a loadWishlists() call.
  // Fail-before / pass-after: at the buggy revision the branch had no
  // loadWishlists call and this assertion fails.
  it('the circ_ deep-link branch calls loadWishlists()', () => {
    const start = MINI_APP_SRC.indexOf("startsWith('circ_')");
    const end = MINI_APP_SRC.indexOf("startsWith('br_')", start);
    expect(start, 'could not find the circ_ deep-link branch').toBeGreaterThan(-1);
    expect(end, 'could not find the br_ branch that follows circ_').toBeGreaterThan(start);
    const branch = MINI_APP_SRC.slice(start, end);
    // Require the actual call `loadWishlists(` — not a mere mention in a comment
    // — so the guard can't be satisfied by prose that references it.
    expect(branch).toMatch(/loadWishlists\s*\(/);
  });
});
