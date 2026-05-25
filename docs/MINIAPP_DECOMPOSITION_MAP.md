# MiniApp.tsx decomposition map (F2 deliverable)

**Status:** F2 complete, 2026-05-25. Pure analysis — no code change.
**Source:** [`apps/web/app/miniapp/MiniApp.tsx`](../apps/web/app/miniapp/MiniApp.tsx)
(34,257 LOC, 145 inline `screen === '…'` render blocks).
**Plan parent:** [`REFACTOR_MINIAPP_TSX_PLAN.md`](./REFACTOR_MINIAPP_TSX_PLAN.md).

The table below maps **53 sections covering ~20,637 LOC** (60% of the file).
Remaining ~13,600 LOC = hooks, state declarations, helpers, JSX-utility
functions that don't render screens directly — those land in
**F3 (Extract leaf state hooks)** and **F5 (Lift pure helpers to `lib/`)**.

---

## Summary stats

| Metric | Value |
|---|---|
| Total file LOC | 34,257 |
| Sections mapped | 53 |
| LOC covered by sections | 20,637 (60 %) |
| Biggest single section | **Gift Notes Detail — 4,604 LOC** |
| Sections > 1000 LOC | 4 (Gift Notes Detail, Profile, My Wishlists, Santa Detail) |
| Sections > 500 LOC | 8 |
| Risk H (careful extraction) | 12 |
| Risk M (moderate) | 26 |
| Risk L (trivial lazy-load) | 15 |

**Projected brotli impact** if everything below is extracted + lazy-loaded
(applying the plan's 60 %-of-projection discount):

| Wave | Sections extracted | LOC removed from main chunk | Projected brotli saving |
|---|---|---|---|
| Quick-win (Santa cluster) | 9 santa-* | ~3,310 | ~60-90 KB |
| Big-3 (Gift Notes + Profile + Settings) | 3 | ~7,127 | ~140-200 KB |
| Cleanup (FAQ/Legal/Changelog + Onboarding + Group Gift cluster) | 12 | ~2,500 | ~40-70 KB |
| **Realistic total after F3-F6** | ~24 | ~12,937 | **−240-360 KB brotli** (out of 522 KB today) |

Closure target from the parent plan (~180 KB initial JS brotli) is
reachable if F7 also lifts hooks and helpers — those add another
~150 KB once the screen consumers don't drag them into the main chunk.

---

## The map

Sorted by LOC descending. **Star (★)** marks sections **strongly recommended
for the first lazy-load wave** — high LOC, low first-paint priority, contained
state.

| Screen / section | First line | Last line | LOC | State owned | State read (key vars) | Target file | Risk | Notes |
|---|---|---|---|---|---|---|---|---|
| ★ Gift Notes Detail (occasion) | 23283 | 27886 | 4604 | Yes | gnViewingOccasion, gnIdeas, gnCreatingIdea | `screens/GiftNoteOccasionDetail.tsx` | H | Single biggest extraction available. Includes idea picker + inline render helpers. Worth splitting into 2-3 sub-files. |
| Profile (owner) | 19117 | 20891 | 1775 | Yes | profileData, profileStats, subscription, planInfo, birthdaySettings | `screens/ProfileScreen.tsx` | H | Avatar upload + birthday reminders + edit modal. Upload-touched. |
| My Wishlists (tab 1) | 13259 | 14880 | 1622 | Yes | wishlists, homeTab, reorderMode, itemReorderMode | `screens/HomeScreen.tsx` | H | **First-paint tab — DO NOT lazy-load.** Extract to its own file for maintainability but keep in main chunk. |
| ★ Santa: Campaign Detail | 28191 | 29759 | 1569 | Yes | currentSantaCampaign, santaParticipants, santaMyAssignment | `screens/santa/SantaCampaignDetail.tsx` | H | State machine + 6 sub-screens inline. Seasonal use (Nov-Jan). |
| Settings | 21468 | 22215 | 748 | Local | planInfo, locale, subscription, birthdaySettings, appearance | `screens/SettingsScreen.tsx` | M | Already partially extracted (AppearanceSettings is F1). |
| ★ Guest View (wishlist preview) | 18174 | 18804 | 631 | Local | guestWl, guestItems, guestCategories, guestReservations | `screens/GuestWishlistView.tsx` | H | Public wishlist view; reached via deep link `/w/*`. Lazy-loadable if home doesn't share its render path. |
| Wishlist Detail (edit) | 15985 | 16614 | 630 | Yes | currentWl, items, categories, dontGiftData, itemReorderMode | `screens/WishlistDetailEditor.tsx` | H | Owner edit flow. Often reached from home — may be on hot path. |
| ★ Showcase Editor | 32423 | 33040 | 618 | Yes | showcaseData, showcaseItems, showcaseEditing | `screens/ShowcaseEditor.tsx` | H | Drag & visual editor. Niche feature. |
| ★ Guest Item Detail | 17293 | 17818 | 526 | Local | viewingItem, guestWl, guestReservations | `screens/GuestItemDetail.tsx` | M | Guest variant; cold path. |
| ★ Public Profile | 33282 | 33689 | 408 | Local | publicProfileData, publicWishlists | `screens/PublicProfile.tsx` | L | Cold path; public user card + wishlist list. |
| ★ Referral Program | 20892 | 21296 | 405 | Local | referralData, referralStats | `screens/ReferralScreen.tsx` | M | Settings-side feature; not on first paint. |
| ★ Secret Reservation Detail | 15428 | 15829 | 402 | Local | viewingSecretReservation, secretResolutions | `screens/SecretReservationDetail.tsx` | M | Reservation deep link only. |
| Item Detail (legacy) | 16923 | 17292 | 370 | Local | viewingItem, currentWl, planInfo | `screens/ItemDetailLegacy.tsx` | H | **Candidate to DELETE.** Confirm rollout of new variant first. |
| ★ Santa: Exclusions | 30394 | 30761 | 368 | Local | currentSantaCampaign, santaExclusions | `screens/santa/SantaExclusions.tsx` | M | Multi-wave gating (402). Seasonal. |
| Wishlist Detail (modal overlay) | 22550 | 22909 | 360 | Local | currentWl, items | `sheets/WishlistModalOverlay.tsx` | M | Duplicates edit code — investigate consolidation. |
| ★ Group Gift Detail | 31622 | 31941 | 320 | Local | groupGiftData, groupGiftParticipants, groupGiftMessages | `screens/GroupGiftDetail.tsx` | M | Group flow; not on first paint. |
| Item Detail (redesign) | 16615 | 16922 | 308 | Local | viewingItem, currentWl, planInfo | `screens/ItemDetailV3.tsx` | H | New item detail; on hot path. |
| My Reservations (tab 3) | 15125 | 15427 | 303 | Local | reservations, santaReservationItems, homeTab | `screens/ReservationsScreen.tsx` | M | Tab 3 — lazy-loadable when user switches off Tab 1. |
| ★ Group Gift Chat | 32141 | 32422 | 282 | Local | groupGiftData, groupGiftMessages | `screens/GroupGiftChat.tsx` | M | |
| Drafts | 14881 | 15124 | 244 | Local | draftWishlist, items, categories | `screens/DraftsScreen.tsx` | M | |
| ★ Showcase Preview | 33041 | 33281 | 241 | Local | showcaseData | `screens/ShowcasePreview.tsx` | M | |
| ★ Archive | 18897 | 19116 | 220 | Local | archiveMode, archivedItems, currentWl | `screens/ArchiveScreen.tsx` | M | Cold path. |
| ★ Santa: Receiver Wishlist | 29974 | 30193 | 220 | Local | currentSantaCampaign, santaReceiverWishlist | `screens/santa/SantaReceiverWishlist.tsx` | M | |
| ★ Santa: Polls | 29760 | 29973 | 214 | Local | currentSantaCampaign, santaPollData | `screens/santa/SantaPolls.tsx` | M | |
| ★ Santa: Chat | 30194 | 30393 | 200 | Local | currentSantaCampaign, santaChatMessages | `screens/santa/SantaChat.tsx` | M | |
| ★ Group Gift Join | 31942 | 32140 | 199 | Local | groupGiftData, groupGiftJoining | `screens/GroupGiftJoin.tsx` | M | |
| Gift Notes Paywall | 22910 | 23094 | 185 | No | gnViewingOccasion | `sheets/GiftNotesPaywall.tsx` | M | Pro gate (402); usually flashes once. |
| ★ Curated Selection View | 17819 | 17993 | 175 | Local | curatedViewData, curatedViewExpired | `screens/CuratedSelectionView.tsx` | L | Cold deep-link path. |
| ★ Referral History | 21297 | 21467 | 171 | Local | referralHistory, referralHistoryPagination | `screens/ReferralHistory.tsx` | L | |
| ★ Gift Notes (hub) | 23112 | 23282 | 171 | Local | gnOccasions, gnViewingOccasion | `screens/GiftNotesHub.tsx` | M | Goes with Gift Notes Detail extraction. |
| ★ Group Gift Create | 31455 | 31621 | 167 | Local | groupGiftCreateItem, groupGiftCreating | `sheets/GroupGiftCreate.tsx` | M | |
| Secret Reservation Paywall | 15830 | 15984 | 155 | No | viewingSecretReservation | `sheets/SecretReservationPaywall.tsx` | M | |
| ★ Santa: Hub | 27887 | 28038 | 152 | Local | santaCampaigns, santaJoinCode | `screens/santa/SantaHub.tsx` | M | |
| ★ Santa: Create | 28039 | 28190 | 152 | Local | santaCreateForm, santaCreating | `screens/santa/SantaCreate.tsx` | M | |
| ★ Santa: Organizer | 30762 | 30908 | 147 | Local | currentSantaCampaign, santaOrganizerStats | `screens/santa/SantaOrganizer.tsx` | M | |
| ★ Santa: Join | 30909 | 31049 | 141 | Local | santaJoinCode, santaJoining | `screens/santa/SantaJoin.tsx` | M | |
| Onboarding: Entry | 31083 | 31204 | 122 | Local | onboardingState, onboardingVariant | `screens/onboarding/OnboardingEntry.tsx` | H | Side effects; need careful extraction. |
| ★ Link Management | 17994 | 18115 | 122 | Local | linkMgmtData, linkMgmtDetailItem | `screens/LinkManagement.tsx` | L | |
| ★ FAQ | 22216 | 22332 | 117 | No | — | `screens/FAQScreen.tsx` | L | Pure static. Cheapest extraction. |
| ★ Legal Doc viewer | 22439 | 22549 | 111 | No | — | `screens/LegalDocViewer.tsx` | L | Pure static. |
| Group Gift Paywall | 31360 | 31454 | 95 | No | viewingItem, groupGiftData | `sheets/GroupGiftPaywall.tsx` | M | |
| Search Screen | 18805 | 18896 | 92 | Local | searchResults, searchQuery, currentWl | `screens/SearchScreen.tsx` (already F1) | M | ✅ Already extracted in F1. |
| Maintenance | 13169 | 13258 | 90 | No | — | — | L | Keep inline; bundle-cheap and first-paint critical. |
| Loading | 12966 | 13052 | 87 | No | — | — | L | Keep inline; first-paint critical. |
| ★ Changelog | 22333 | 22401 | 69 | No | — | `screens/ChangelogScreen.tsx` | L | Pure static. |
| Error | 13053 | 13120 | 68 | No | — | — | L | Keep inline; bundle-cheap. |
| Onboarding: Complete | 31256 | 31319 | 64 | Local | onboardingState | `screens/onboarding/OnboardingComplete.tsx` | L | |
| ★ Share sheet | 18116 | 18173 | 58 | No | currentWl, proSource | `sheets/ShareSheet.tsx` | L | |
| Onboarding: Demo | 31205 | 31255 | 51 | Local | onboardingDemoItem, onboardingState | `screens/onboarding/OnboardingDemo.tsx` | M | |
| ★ Legal menu | 22402 | 22438 | 37 | No | — | `screens/LegalMenu.tsx` | L | Pure static. |
| First Share Prompt | 31342 | 31359 | 18 | Local | firstSharePromptData | `sheets/FirstSharePrompt.tsx` | L | |
| Gift Notes Onboarding | 23095 | 23111 | 17 | No | gnOccasions | `sheets/GiftNotesOnboarding.tsx` | L | |
| Onboarding v2: Share | 31326 | 31341 | 16 | Local | onboardingVariant, onboardingCreatedWl | `screens/onboarding/OnboardingShare.tsx` | M | |

---

## Recommended F4 sequencing (after F3 hooks extraction)

The plan's F4 says "extract ~3 big screens". The realistic ordering by
**(LOC saved) / (risk × testing burden)** is:

### Wave A — Cold paths, single-file extractions (lowest risk)

These have no shared state and aren't on first paint. Each can ship as
its own commit.

1. **FAQ** (117 LOC, L) — pure static, smallest possible PR. Use as
   the template-PR for everything below.
2. **Legal menu + Legal Doc viewer + Changelog** (37 + 111 + 69 = 217 LOC, L)
   — combine into one commit since they share zero state.
3. **Public Profile + Curated Selection** (408 + 175 = 583 LOC, L) —
   cold deep-link paths.
4. **Referral Program + Referral History** (405 + 171 = 576 LOC, M) —
   settings-side feature, no first-paint.

**Wave A total: ~1,376 LOC removed. Expected brotli saving: ~25-40 KB.**

### Wave B — Santa cluster (seasonal — biggest seasonal win)

Santa is used Nov-Jan, the rest of the year it's dead weight. Extracting
**all 9 santa-\* screens** into one chunk so they share helpers is correct.

5. Santa: Hub + Create + Join + Organizer + Polls + Chat + Exclusions +
   Receiver Wishlist + **Campaign Detail (1569 LOC)** = 3,310 LOC, mostly M.

**Wave B total: ~3,310 LOC. Expected brotli saving: ~60-90 KB.**
**Constraint:** ship before Nov so seasonal users don't pay cold-load
penalty on first open of the season.

### Wave C — Gift Notes (single biggest win)

6. **Gift Notes Detail (4604 LOC) + Hub (171) + Paywall (185) + Onboarding (17)** =
   4,977 LOC, mixed M/H. The Detail alone is 14 % of the whole file.

**Wave C total: ~4,977 LOC. Expected brotli saving: ~100-140 KB.**
This single wave is bigger than F0+F1 combined.

### Wave D — Settings + Profile + medium screens

7. **Settings** (748 LOC, M)
8. **Profile** (1775 LOC, H — upload-touched, do after solid integration tests)
9. **Showcase Editor + Preview** (618 + 241 = 859 LOC, H/M)
10. **Group Gift cluster** (320 + 282 + 199 + 167 + 95 = 1063 LOC, M)

**Wave D total: ~4,445 LOC. Expected brotli saving: ~80-120 KB.**

### Wave E — Tabs + first-paint-adjacent

Extracted but **kept eager-imported** in the main chunk (extraction here
is for maintainability, not bundle size).

11. **My Wishlists** (1622 LOC) — tab 1, first paint.
12. **My Reservations** (303 LOC) — tab 3, but commonly visited.
13. **Wishlist Detail editor** (630 LOC) — hot path from home.
14. **Item Detail V3** (308 LOC) — hot path from any wishlist.
15. **Guest View + Guest Item Detail** (631 + 526 = 1,157 LOC) — public-link
    entrypoint; can be lazy because Telegram deep links cold-start anyway.

---

## Constraints + sequencing rules

1. **F3 hooks extraction must precede F4 screens.** Many screens share
   state via in-file closures (e.g. `tgFetch`, `setUpsellSheet`,
   `setScreen`). Until those are lifted to hooks the extracted screen
   files become props-bloat (50+ props per screen).
2. **One wave per PR.** Bundle each wave as a single commit so a
   regression can be reverted cleanly.
3. **Regression guard in `monolith-guards.test.ts`** — for every
   newly-dynamic screen, add a `screens-must-be-dynamic` entry so a
   future inline re-import is caught at CI.
4. **Skeleton for every dynamic screen.** Reuse the new `Skeleton`
   primitive (added in 85bd2a8). Match the visual shape so the
   lazy-load doesn't flash a blank.
5. **Wave A is the on-ramp.** Use FAQ as the smallest possible
   template-PR so reviewer cadence and CI setup are locked in before
   tackling Gift Notes / Profile.

---

## Out of scope of this map

- Internal hooks defined inside `MiniApp.tsx` (state setters, fetch
  helpers, formatters). Those land in **F3**.
- Pure utility functions (date math, price formatting, locale picks).
  Those land in **F5 — Lift pure helpers to `lib/`**.
- Bundle-analyzer deep-dive on the 145 unmapped `screen === '...'`
  references (mostly small flag-style branches and modal toggles, not
  extractable screens).

---

## What's next

Pick a wave above and start. Recommended order: **Wave A (smallest PR
as template) → F3 (hooks) → Wave B (Santa, seasonal) → Wave C (Gift
Notes, biggest single win) → Wave D → Wave E**.

Each wave's PR description should cite **the row in this table** for
the section being extracted, so reviewers can verify the LOC range and
risk classification didn't drift.

If a section's actual state coupling turns out higher than this map
predicts (i.e. extraction balloons into props-soup), **stop, file an
issue, and re-evaluate** — don't force-push a half-extracted screen.
The map is a **hypothesis, not a contract**.
