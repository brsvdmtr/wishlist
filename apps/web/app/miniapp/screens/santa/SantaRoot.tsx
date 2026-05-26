// SantaRoot — F4 Wave B cluster file (REFACTOR_MINIAPP_TSX_PLAN).
//
// Bundles all 9 Secret Santa screens (~3.1k LOC of JSX) into a single
// lazy-loaded module. Loaded via `next/dynamic({ ssr: false })` from
// `apps/web/app/miniapp/MiniApp.tsx`, so the chunk doesn't ship with
// the initial Mini App page bundle — santa code only downloads when a
// user navigates to a santa-* screen (cold path: deep link, settings
// tile, post-onboarding nudge).
//
// State source: `useSantaState` is invoked exactly once in MiniAppInner
// and the ~70 returned fields are forwarded through `ctx`. The setters
// flow back into the same React state tree — no duplicate state.
//
// Sub-screens (selected by `ctx.screen`):
//   1. santa-hub               — campaign list, owned/joined
//   2. santa-create            — create new campaign form
//   3. santa-campaign          — campaign detail (the biggest screen, ~1.6k LOC)
//   4. santa-polls             — polls list + creator
//   5. santa-receiver-wishlist — Santa-safe wishlist view for giver
//   6. santa-chat              — campaign chat
//   7. santa-exclusions        — owner-only exclusions/groups editor
//   8. santa-organizer         — organizer panel (exit requests, gift progress)
//   9. santa-join              — deep-link join preview/accept
//
// Implementation discipline:
// - JSX is copied verbatim from MiniApp.tsx — DO NOT migrate styles or
//   refactor logic in this PR. Bundle savings only; cosmetic changes
//   ride future on-touch PRs.
// - `ctx` is `SantaState & {...}` — the F3 hook's return shape intersected
//   with remaining closure refs. The follow-up tightening pass already
//   replaced the original `Record<string, any>` ctx with named slots.
// - `renderSantaAlias` (the locale-aware alias formatter) is now
//   imported directly from `lib/santa-alias` (F5) — it used to flow
//   through `ctx`. Importing means the SANTA_ADJ / SANTA_ANIMAL
//   corpus (4 KB of locale strings) lives in this lazy chunk
//   instead of the main chunk.

'use client';

import React from 'react';
import {
  Banner, Button, Card, Chip, PageTitle,
  Sheet as BottomSheet,
} from '@wishlist/ui';
import { SantaAvatar } from '../../components/SantaAvatar';
import { SnowflakeOverlay } from '../../components/SnowflakeOverlay';
import { t, type Locale } from '@wishlist/shared';
import { parsePaywallError, paywallContextFromError } from '../../lib/paywall';
import { renderSantaAlias } from '../../lib/santa-alias';
import type { Dispatch, SetStateAction } from 'react';
import type {
  SantaCampaignDetail, SantaCampaignSummary, GuestItem,
  Item, PlanInfo, Wishlist,
} from '../../MiniApp';
import type {
  ChatMessage, Poll, OrganizerSummary,
  ExclusionPair, ExclusionGroup,
  SantaState,
} from '../../hooks/useSantaState';
import type {
  LegacyColorBag, NavBack, PushToast, SetScreen,
  ShowUpsell, TgFetch,
} from '../../_shared/closure-types';

/**
 * SantaRootCtx — closure refs forwarded from MiniAppInner.
 *
 * Intersection of the full `SantaState` (all setters keep their inferred
 * `Dispatch<SetStateAction<T>>` signatures, so `setSantaPolls(prev => ...)`
 * still type-checks) plus the helpers / primitives bag. Helpers carry
 * real signatures from `_shared/closure-types`; the few remaining `any`s
 * cover anonymous useState shapes in MiniApp.tsx that aren't worth
 * extracting just for the Root edge.
 */
export type SantaRootCtx = SantaState & {
  // module-level constants
  C: LegacyColorBag;
  font: string;
  locale: Locale;
  // hot-path helpers — real signatures from _shared/closure-types.
  tgFetch: TgFetch;
  setScreen: SetScreen;
  navBack: NavBack;
  pushToast: PushToast;
  showUpsell: ShowUpsell;
  setViewingItem: Dispatch<SetStateAction<(Item | GuestItem) | null>>;
  myActorHashRef: { current: string };
  botUsername: string;
  planInfo: PlanInfo;
  wishlists: Wishlist[];
  handleSantaReceiverReserve: (itemId: string) => void | Promise<void>;
  handleSantaReceiverUnreserve: (itemId: string) => void | Promise<void>;
};

export interface SantaRootProps {
  /** Active santa-* screen name; controls which sub-block renders. */
  screen: string;
  /** Bag of closure refs forwarded from MiniAppInner. See `SantaRootCtx`. */
  ctx: SantaRootCtx;
}

/**
 * Lazy-loaded Santa cluster root.
 *
 * Destructures everything the JSX needs from `ctx` at the top, then
 * returns a fragment containing the 9 inline screen blocks. Each
 * block is guarded by a `screen === '<name>'` check exactly as in
 * the original MiniApp.tsx — that keeps the JSX byte-identical.
 */
export function SantaRoot(props: SantaRootProps) {
  const { ctx, screen } = props;

  // ── Module-level constants forwarded from MiniApp.tsx ────────────────
  const { C, font, locale } = ctx;

  // ── Local helpers forwarded from MiniAppInner closure ────────────────
  // `renderSantaAlias` is imported above (./../../lib/santa-alias) — no
  // longer a ctx field, so the corpus stays out of the main chunk.
  const {
    tgFetch, setScreen, navBack, pushToast, showUpsell,
    setViewingItem, myActorHashRef, botUsername,
    planInfo, wishlists,
  } = ctx;

  // ── Santa state (from useSantaState — destructured here for legibility) ──
  const {
    santaSeason,
    santaCampaigns, setSantaCampaigns,
    santaCampaignsLoading, setSantaCampaignsLoading,
    currentSantaCampaign, setCurrentSantaCampaign,
    santaCreateLoading, setSantaCreateLoading,
    santaCreateTitle, setSantaCreateTitle,
    santaCreateDesc, setSantaCreateDesc,
    santaCreateMinBudget, setSantaCreateMinBudget,
    santaCreateMaxBudget, setSantaCreateMaxBudget,
    santaCreateCurrency, setSantaCreateCurrency,
    santaCreateType, setSantaCreateType,
    santaJoinToken,
    santaJoinPreview,
    santaJoinLoading, setSantaJoinLoading,
    santaJoinDone, setSantaJoinDone,
    showSantaWishlistPicker, setShowSantaWishlistPicker,
    santaWishlistPickerLoading, setSantaWishlistPickerLoading,
    setSantaWishlistPickerReturnId,
    santaReceiverWishlist, setSantaReceiverWishlist,
    santaReceiverWishlistLoading, setSantaReceiverWishlistLoading,
    santaWishlistReservingId, setSantaWishlistReservingId,
    santaSwitchModalOpen, setSantaSwitchModalOpen,
    santaInboundStatus, setSantaInboundStatus,
    santaInboundLoading, setSantaInboundLoading,
    santaDrawLoading, setSantaDrawLoading,
    santaDrawValidation, setSantaDrawValidation,
    santaDrawValidationLoading, setSantaDrawValidationLoading,
    santaReveal, setSantaReveal,
    santaRevealLoading, setSantaRevealLoading,
    santaHintRequest, setSantaHintRequest,
    santaHintRequestLoading, setSantaHintRequestLoading,
    santaHintInbound, setSantaHintInbound,
    santaHintInboundLoading, setSantaHintInboundLoading,
    santaHintPickerOpen, setSantaHintPickerOpen,
    santaHintPickerItems, setSantaHintPickerItems,
    santaHintPickerSelectedIds, setSantaHintPickerSelectedIds,
    santaHintFulfillLoading, setSantaHintFulfillLoading,
    santaChatMessages, setSantaChatMessages,
    santaChatHasMore, setSantaChatHasMore,
    santaChatLoading, setSantaChatLoading,
    santaChatInput, setSantaChatInput,
    santaChatSending, setSantaChatSending,
    santaChatIsMuted, setSantaChatIsMuted,
    santaChatSendNonceRef,
    santaPolls, setSantaPolls,
    santaPollsLoading, setSantaPollsLoading,
    santaPollCreateOpen, setSantaPollCreateOpen,
    santaPollCreateQuestion, setSantaPollCreateQuestion,
    santaPollCreateOptions, setSantaPollCreateOptions,
    santaPollCreateAnonymous, setSantaPollCreateAnonymous,
    santaPollCreateSubmitting, setSantaPollCreateSubmitting,
    santaOrganizerSummary, setSantaOrganizerSummary,
    santaOrganizerLoading, setSantaOrganizerLoading,
    santaExitRequestSheetOpen, setSantaExitRequestSheetOpen,
    santaExitRequestReason, setSantaExitRequestReason,
    santaExitRequestSubmitting, setSantaExitRequestSubmitting,
    santaExclPairs, setSantaExclPairs,
    santaExclGroups, setSantaExclGroups,
    santaExclLoading, setSantaExclLoading,
    santaExclAddPairOpen, setSantaExclAddPairOpen,
    santaExclPairA, setSantaExclPairA,
    santaExclPairB, setSantaExclPairB,
    santaExclPairSaving, setSantaExclPairSaving,
    santaExclGroupSheetOpen, setSantaExclGroupSheetOpen,
    santaExclGroupLabel, setSantaExclGroupLabel,
    santaExclGroupSaving, setSantaExclGroupSaving,
    santaExclAddMemberGroupId, setSantaExclAddMemberGroupId,
    santaExclAddMemberUserId, setSantaExclAddMemberUserId,
    santaExclAddMemberSaving, setSantaExclAddMemberSaving,
    setSantaDetailContext,
  } = ctx;

  // ── handleSantaReceiverReserve / handleSantaReceiverUnreserve ────────
  // are useCallback memos in MiniAppInner — passed straight through.
  const { handleSantaReceiverReserve, handleSantaReceiverUnreserve } = ctx;

  return (
    <>
      {/* ══════════════════════════════════════════════
          SECRET SANTA — HUB
          ══════════════════════════════════════════════ */}
      {screen === 'santa-hub' && (() => {
        // ── Campaign grouping: active vs finished ──────────────────────────
        const FINISHED_STATUSES = new Set<string>(['COMPLETED', 'CANCELLED']);
        type HubCampaign = (typeof santaCampaigns.owned)[number];
        const withRole = (arr: HubCampaign[], role: 'organizer' | 'participant') =>
          arr.map(c => ({ ...c, _role: role }));

        const owned  = withRole(santaCampaigns.owned,  'organizer');
        const joined = withRole(santaCampaigns.joined, 'participant');
        const all    = [...owned, ...joined];

        const activeCamps   = all.filter(c => !FINISHED_STATUSES.has(c.status));
        const finishedCamps = all.filter(c =>  FINISHED_STATUSES.has(c.status));

        const openCampaign = async (id: string) => {
          const res = await tgFetch(`/tg/santa/campaigns/${id}`);
          if (res.ok) {
            const json = await res.json() as SantaCampaignDetail;
            setCurrentSantaCampaign(json);
            setScreen('santa-campaign');
          }
        };

        const CampaignCard = ({ c, dimmed = false }: { c: HubCampaign & { _role: 'organizer' | 'participant' }; dimmed?: boolean }) => (
          <button
            key={c.id}
            onClick={() => void openCampaign(c.id)}
            className="wb-card-pressed"
            style={{
              background: 'var(--wb-card)',
              border: '1px solid var(--wb-border)',
              borderRadius: 18,
              padding: '14px 16px', cursor: 'pointer', textAlign: 'start',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              opacity: dimmed ? 0.65 : 1,
              transition: 'all 0.15s cubic-bezier(0.4, 0, 0.2, 1)',
              WebkitBackdropFilter: 'blur(14px)' as never,
              backdropFilter: 'blur(14px)' as never,
              fontFamily: 'inherit',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginBottom: 3 }}>
                <span style={{ fontSize: 15, fontWeight: 650, color: 'var(--wb-text)', letterSpacing: '-0.015em' }}>{c.title}</span>
                {/* Role pill — canonical Chip primitive (v2-santa-campaign). */}
                <Chip tone={c._role === 'organizer' ? 'accent' : 'surface'} size="sm">
                  {c._role === 'organizer'
                    ? t('santa_role_organizer', locale)
                    : t('santa_role_member', locale)}
                </Chip>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--wb-text-secondary)', letterSpacing: '-0.005em' }}>
                {t('santa_campaign_participants', locale, { count: c.participantCount })}
                {' · '}
                <span style={dimmed ? { fontWeight: 650 } : {}}>
                  {t(`santa_campaign_status_${c.status.toLowerCase()}` as never, locale) || c.status}
                </span>
              </div>
            </div>
            <div style={{ color: 'var(--wb-text-muted)', fontSize: 18, flexShrink: 0, paddingLeft: 8 }}>›</div>
          </button>
        );

        return (
          <div style={{ padding: '16px 20px 120px' }}>
            {/* ── Header with optional snowflakes ── */}
            <div style={{ position: 'relative', marginBottom: 24 }}>
              {santaSeason?.inSeason && <SnowflakeOverlay height={60} />}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'relative', zIndex: 1 }}>
                <h1 style={{
                  fontSize: 26, fontWeight: 700, fontFamily: font,
                  color: 'var(--wb-text)', margin: 0,
                  letterSpacing: '-0.035em', lineHeight: 1.05,
                }}>🎅 {t('santa_hub_title', locale)}</h1>
                {santaSeason?.canCreate && (
                  <Button
                    variant="primary-gradient"
                    size="sm"
                    fullWidth={false}
                    onClick={() => {
                      setSantaCreateTitle(''); setSantaCreateDesc('');
                      setSantaCreateMinBudget(''); setSantaCreateMaxBudget('');
                      setScreen('santa-create');
                    }}
                  >
                    {t('santa_home_create_btn', locale)}
                  </Button>
                )}
              </div>
            </div>

            {/* ── Loading ── */}
            {santaCampaignsLoading && (
              <div style={{ color: 'var(--wb-text-muted)', fontSize: 14, textAlign: 'center', padding: 40 }}>{t('loading', locale)}</div>
            )}

            {/* ── Empty state ── */}
            {!santaCampaignsLoading && all.length === 0 && (
              <div style={{
                background: 'var(--wb-card)',
                border: '1px solid var(--wb-border)',
                borderRadius: 22,
                padding: 24, textAlign: 'center',
                WebkitBackdropFilter: 'blur(16px)' as never,
                backdropFilter: 'blur(16px)' as never,
              }}>
                <div style={{ fontSize: 48, marginBottom: 12, filter: 'drop-shadow(0 12px 24px var(--wb-accent-shadow-soft))' }}>🎁</div>
                <div style={{ color: 'var(--wb-text-secondary)', fontSize: 14, lineHeight: 1.5, letterSpacing: '-0.005em' }}>{t('santa_home_empty', locale)}</div>
                {santaSeason?.canCreate && (
                  <div style={{ marginTop: 16 }}>
                    <Button
                      variant="primary-gradient"
                      fullWidth={false}
                      onClick={() => setScreen('santa-create')}
                    >
                      {t('santa_home_create_btn', locale)}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* ── Active campaigns ── */}
            {!santaCampaignsLoading && activeCamps.length > 0 && (
              <div style={{ marginBottom: finishedCamps.length > 0 ? 28 : 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  {t('santa_tab_active', locale)}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {activeCamps.map(c => <CampaignCard key={c.id} c={c} />)}
                </div>
              </div>
            )}

            {/* ── Finished campaigns ── */}
            {!santaCampaignsLoading && finishedCamps.length > 0 && (
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  {t('santa_tab_finished', locale)}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {finishedCamps.map(c => <CampaignCard key={c.id} c={c} dimmed />)}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          SECRET SANTA — CREATE
          ══════════════════════════════════════════════ */}
      {screen === 'santa-create' && (
        <div style={{ padding: '16px 20px 120px' }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, fontFamily: font, color: 'var(--wb-text)', letterSpacing: '-0.035em', lineHeight: 1.05, marginTop: 8, marginBottom: 24 }}>
            {t('santa_create_title', locale)}
          </h1>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, display: 'block', marginBottom: 6 }}>{t('santa_create_name_label', locale)}</label>
              <input
                value={santaCreateTitle}
                onChange={e => setSantaCreateTitle(e.target.value)}
                placeholder={t('santa_create_name_placeholder', locale)}
                maxLength={80}
                style={{ width: '100%', background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: '12px 16px', fontSize: 15, color: C.text, fontFamily: font, boxSizing: 'border-box' }}
              />
            </div>
            {/* Campaign type — Classic is free; Multi-wave is PRO. Disclosed
                here so a FREE user sees the gate before submit, not as a 402. */}
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, display: 'block', marginBottom: 6 }}>{t('santa_create_type_label', locale)}</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['CLASSIC', 'MULTI_WAVE'] as const).map(ct => (
                  <button
                    key={ct}
                    onClick={() => setSantaCreateType(ct)}
                    style={{
                      flex: 1, padding: '10px 0', borderRadius: 12, border: `2px solid ${santaCreateType === ct ? C.accent : C.border}`,
                      background: santaCreateType === ct ? `rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.125)` : C.card,
                      color: santaCreateType === ct ? C.accent : C.textMuted,
                      fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: font,
                    }}
                  >
                    {ct === 'CLASSIC'
                      ? t('santa_create_type_classic', locale)
                      : `${planInfo.code === 'PRO' ? '' : '🔒 '}${t('santa_create_type_multi', locale)}`}
                  </button>
                ))}
              </div>
              {santaCreateType === 'MULTI_WAVE' && planInfo.code !== 'PRO' && (
                <button
                  onClick={() => showUpsell('santa_multi_wave')}
                  style={{ display: 'block', width: '100%', textAlign: 'left', background: `rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.063)`, border: 'none', borderRadius: 12, padding: '10px 14px', fontSize: 13, color: C.accent, marginTop: 8, cursor: 'pointer', fontFamily: font }}
                >
                  🔒 {t('santa_create_type_pro_hint', locale)}
                </button>
              )}
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, display: 'block', marginBottom: 6 }}>{t('santa_create_desc_label', locale)}</label>
              <textarea
                value={santaCreateDesc}
                onChange={e => setSantaCreateDesc(e.target.value)}
                placeholder={t('santa_create_desc_placeholder', locale)}
                maxLength={500}
                rows={3}
                style={{ width: '100%', background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: '12px 16px', fontSize: 14, color: C.text, fontFamily: font, boxSizing: 'border-box', resize: 'none' }}
              />
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, display: 'block', marginBottom: 6 }}>{t('santa_create_budget_min', locale)}</label>
                <input
                  type="number"
                  value={santaCreateMinBudget}
                  onChange={e => setSantaCreateMinBudget(e.target.value)}
                  placeholder="0"
                  min={0}
                  style={{ width: '100%', background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: '12px 16px', fontSize: 15, color: C.text, fontFamily: font, boxSizing: 'border-box' }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, display: 'block', marginBottom: 6 }}>{t('santa_create_budget_max', locale)}</label>
                <input
                  type="number"
                  value={santaCreateMaxBudget}
                  onChange={e => setSantaCreateMaxBudget(e.target.value)}
                  placeholder="0"
                  min={0}
                  style={{ width: '100%', background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: '12px 16px', fontSize: 15, color: C.text, fontFamily: font, boxSizing: 'border-box' }}
                />
              </div>
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, display: 'block', marginBottom: 6 }}>{t('santa_create_currency_label', locale)}</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['RUB', 'USD'] as const).map(cur => (
                  <button
                    key={cur}
                    onClick={() => setSantaCreateCurrency(cur)}
                    style={{
                      flex: 1, padding: '10px 0', borderRadius: 12, border: `2px solid ${santaCreateCurrency === cur ? C.accent : C.border}`,
                      background: santaCreateCurrency === cur ? `rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.125)` : C.card,
                      color: santaCreateCurrency === cur ? C.accent : C.textMuted,
                      fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: font,
                    }}
                  >
                    {cur === 'RUB' ? '₽ RUB' : '$ USD'}
                  </button>
                ))}
              </div>
            </div>
            <Button
              variant="primary-gradient"
              size="lg"
              disabled={!santaCreateTitle.trim() || santaCreateLoading}
              loading={santaCreateLoading}
              onClick={async () => {
                if (!santaCreateTitle.trim()) return;
                setSantaCreateLoading(true);
                try {
                  const body: Record<string, unknown> = { title: santaCreateTitle.trim(), type: santaCreateType, currency: santaCreateCurrency };
                  if (santaCreateDesc.trim()) body.description = santaCreateDesc.trim();
                  if (santaCreateMinBudget) body.minBudget = parseInt(santaCreateMinBudget, 10);
                  if (santaCreateMaxBudget) body.maxBudget = parseInt(santaCreateMaxBudget, 10);
                  const res = await tgFetch('/tg/santa/campaigns', {
                    method: 'POST',
                    body: JSON.stringify(body),
                    idempotency: { action: 'santa.campaign.create' },
                  });
                  if (res.ok) {
                    const json = await res.json() as { campaign: SantaCampaignSummary };
                    // Open the campaign immediately
                    const detailRes = await tgFetch(`/tg/santa/campaigns/${json.campaign.id}`);
                    if (detailRes.ok) {
                      const detail = await detailRes.json() as SantaCampaignDetail;
                      setCurrentSantaCampaign(detail);
                    }
                    setSantaCampaigns(prev => ({ ...prev, owned: [{ ...json.campaign, participantCount: 0 }, ...prev.owned] }));
                    pushToast(t('done', locale), 'success');
                    setScreen('santa-campaign');
                  } else if (res.status === 402) {
                    // PRO gate (multi-wave) — open the upsell instead of a toast.
                    showUpsell('santa_multi_wave');
                  } else {
                    pushToast(t('error_generic', locale), 'error');
                  }
                } catch {
                  pushToast(t('error_network', locale), 'error');
                } finally {
                  setSantaCreateLoading(false);
                }
              }}
            >
              {santaCreateLoading ? t('loading', locale) : t('santa_create_submit', locale)}
            </Button>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════
          SECRET SANTA — CAMPAIGN DETAIL
          ══════════════════════════════════════════════ */}
      {screen === 'santa-campaign' && currentSantaCampaign && (() => {
        const camp = currentSantaCampaign.campaign;
        const participants = currentSantaCampaign.participants;
        const myAssignment = currentSantaCampaign.myAssignment;
        const myAlias = currentSantaCampaign.myAlias;
        const isOwner = camp.isOwner;
        const isOrg = camp.isOrganizer;
        const myRole = currentSantaCampaign.myRole;
        const pendingExitRequestId = currentSantaCampaign.pendingExitRequestId;
        const pendingExitRequestCount = currentSantaCampaign.pendingExitRequestCount ?? 0;
        const { currentRoundNumber, totalRounds } = currentSantaCampaign;
        const showRoundBadge = (currentRoundNumber ?? 0) > 1 || totalRounds > 1;
        // canStartNextRound: all ownerProgress assignments are in terminal states (RECEIVED | MISSED_DEADLINE | ORPHANED)
        const ownerProgress = currentSantaCampaign.ownerProgress?.progress;
        const totalAssignments = ownerProgress
          ? ownerProgress.pending + ownerProgress.buying + ownerProgress.selectedFromWishlist +
            ownerProgress.selectedOutside + ownerProgress.declinedToSay +
            ownerProgress.sent + ownerProgress.received + ownerProgress.missedDeadline + (ownerProgress.orphaned ?? 0)
          : 0;
        const terminalCount = ownerProgress
          ? ownerProgress.received + ownerProgress.missedDeadline + (ownerProgress.orphaned ?? 0)
          : 0;
        const isRoundComplete = totalAssignments > 0 && terminalCount === totalAssignments;
        const canStartNextRound = isOwner && isRoundComplete && camp.status === 'ACTIVE';
        const statusKey = `santa_campaign_status_${camp.status.toLowerCase().replace('_', '_')}` as string;

        const copyInviteLink = () => {
          const botLink = `https://t.me/${botUsername}?start=santa_${camp.inviteToken}`;
          void navigator.clipboard.writeText(botLink).then(() => pushToast(t('santa_campaign_invite_copied', locale), 'success'));
        };

        return (
          <div style={{ padding: '16px 20px 120px' }}>
            <div style={{ marginBottom: 20 }}>
              <PageTitle marginTop={8} marginBottom={4}>{camp.title}</PageTitle>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Chip
                  tone={camp.status === 'ACTIVE' ? 'success' : camp.status === 'CANCELLED' ? 'danger' : 'accent'}
                  size="md"
                >
                  {t(statusKey, locale) || camp.status}
                </Chip>
                {isOwner && <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--wb-text-muted)', letterSpacing: '-0.005em' }}>👑 {t('santa_role_owner', locale)}</span>}
                {!isOwner && myRole === 'ADMIN' && <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--wb-accent-strong)', letterSpacing: '-0.005em' }}>{t('santa_organizer_badge', locale)}</span>}
                {showRoundBadge && currentRoundNumber && (
                  <Chip tone="accent" size="md">
                    {totalRounds > 1
                      ? t('santa_round_of', locale, { current: String(currentRoundNumber), total: String(totalRounds) })
                      : t('santa_round_label', locale, { n: String(currentRoundNumber) })}
                  </Chip>
                )}
              </div>
              {camp.description && (
                <p style={{
                  fontSize: 14, color: 'var(--wb-text-secondary)',
                  marginTop: 8, lineHeight: 1.5, letterSpacing: '-0.005em',
                }}>{camp.description}</p>
              )}
              {(camp.minBudget || camp.maxBudget) && (
                <div style={{
                  fontSize: 13, color: 'var(--wb-text-muted)',
                  marginTop: 6, fontFeatureSettings: '"tnum"',
                }}>
                  {camp.minBudget && camp.maxBudget
                    ? t('santa_campaign_budget', locale, { min: camp.minBudget, max: camp.maxBudget, currency: camp.currency })
                    : camp.minBudget
                      ? t('santa_campaign_budget_from', locale, { min: camp.minBudget, currency: camp.currency })
                      : t('santa_campaign_budget_to', locale, { max: camp.maxBudget!, currency: camp.currency })}
                </div>
              )}
            </div>

            {/* Pending exit request banner (for participant who submitted a request) */}
            {pendingExitRequestId && (
              <div style={{ marginBottom: 12 }}>
                <Banner tone="info" icon={<span>⏳</span>}>
                  {t('santa_exit_request_pending_banner', locale)}
                </Banner>
              </div>
            )}

            {/* Organizer controls */}
            {isOrg && camp.status !== 'COMPLETED' && camp.status !== 'CANCELLED' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
                {camp.status === 'DRAFT' && (
                  <Button
                    variant="primary-gradient"
                    fullWidth
                    onClick={async () => {
                      const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/open`, {
                        method: 'POST',
                        idempotency: { action: `santa.campaign.open:${camp.id}` },
                      });
                      if (res.ok) {
                        const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                        if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                        pushToast(t('done', locale), 'success');
                      } else pushToast(t('error_generic', locale), 'error');
                    }}
                  >
                    {t('santa_campaign_open_btn', locale)}
                  </Button>
                )}
                {camp.status === 'OPEN' && participants.filter(p => p.status === 'JOINED').length >= 2 && (
                  <Button
                    variant="surface"
                    fullWidth
                    onClick={async () => {
                      const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/lock`, {
                        method: 'POST',
                        idempotency: { action: `santa.campaign.lock:${camp.id}` },
                      });
                      if (res.ok) {
                        const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                        if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                        pushToast(t('done', locale), 'success');
                      } else pushToast(t('error_generic', locale), 'error');
                    }}
                  >
                    {t('santa_campaign_lock_btn', locale)}
                  </Button>
                )}

                {/* v2.1 Draw controls — owner-only when LOCKED, glass card */}
                {isOwner && camp.status === 'LOCKED' && (
                  <div style={{
                    background: 'var(--wb-card)',
                    border: '1px solid var(--wb-border)',
                    borderRadius: 18, padding: 16,
                    WebkitBackdropFilter: 'blur(14px)' as never,
                    backdropFilter: 'blur(14px)' as never,
                  }}>
                    <div style={{
                      fontSize: 12, fontWeight: 600,
                      color: 'var(--wb-text-muted)',
                      marginBottom: 10,
                      textTransform: 'uppercase' as const, letterSpacing: '0.7px',
                    }}>
                      {t('santa_draw_section_title', locale)}
                    </div>

                    {/* Validate button */}
                    {!santaDrawValidation && (
                      <button
                        disabled={santaDrawValidationLoading}
                        onClick={async () => {
                          setSantaDrawValidationLoading(true);
                          const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/draw/validate`);
                          if (res.ok) setSantaDrawValidation(await res.json() as typeof santaDrawValidation);
                          else pushToast(t('error_generic', locale), 'error');
                          setSantaDrawValidationLoading(false);
                        }}
                        style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, fontSize: 13, fontWeight: 600, padding: '10px 0', cursor: santaDrawValidationLoading ? 'wait' : 'pointer', width: '100%', fontFamily: font }}
                      >
                        {santaDrawValidationLoading ? t('loading', locale) : t('santa_draw_validate_btn', locale)}
                      </button>
                    )}

                    {/* Validation result */}
                    {santaDrawValidation && (
                      <div style={{ marginBottom: 10 }}>
                        {santaDrawValidation.feasible ? (
                          <div style={{ fontSize: 13, color: C.green, marginBottom: 8 }}>
                            ✓ {t('santa_draw_feasible', locale, { count: santaDrawValidation.participantCount ?? 0 })}
                          </div>
                        ) : (
                          <div style={{ fontSize: 13, color: C.red, marginBottom: 8 }}>
                            ✗ {t('santa_draw_infeasible', locale)}
                            {santaDrawValidation.problematicExclusions && santaDrawValidation.problematicExclusions.length > 0 && (
                              <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
                                {t('santa_draw_infeasible_hint', locale, {
                                  names: santaDrawValidation.problematicExclusions.map(e => {
                                    const base = `${e.name1} & ${e.name2}`;
                                    return e.groupLabel ? `${base} (${t('santa_draw_infeasible_group', locale, { label: e.groupLabel })})` : base;
                                  }).join(', '),
                                })}
                              </div>
                            )}
                          </div>
                        )}
                        <button
                          onClick={() => setSantaDrawValidation(null)}
                          style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: 12, cursor: 'pointer', padding: 0 }}
                        >
                          {t('santa_draw_recheck', locale)}
                        </button>
                      </div>
                    )}

                    {/* Run draw button — enabled only if validated feasible */}
                    <button
                      disabled={santaDrawLoading || (santaDrawValidation !== null && !santaDrawValidation.feasible)}
                      onClick={async () => {
                        if (!confirm(t('santa_draw_confirm_msg', locale, { count: participants.filter(p => p.status === 'JOINED').length }))) return;
                        setSantaDrawLoading(true);
                        const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/draw`, {
                          method: 'POST',
                          idempotency: { action: `santa.draw:${camp.id}` },
                        });
                        setSantaDrawLoading(false);
                        if (res.ok) {
                          const json = await res.json() as { assignmentCount: number };
                          setSantaDrawValidation(null);
                          pushToast(t('santa_draw_success', locale, { count: json.assignmentCount }), 'success');
                          const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                          if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                        } else {
                          const err = await res.json() as { error: string; reason?: string; problematicExclusions?: { userId1: string; name1: string; userId2: string; name2: string }[] };
                          if (err.error === 'draw_already_running') pushToast(t('santa_draw_already_running', locale), 'error');
                          else if (err.error === 'draw_infeasible') {
                            setSantaDrawValidation({ feasible: false, reason: err.reason, problematicExclusions: err.problematicExclusions });
                            pushToast(t('santa_draw_infeasible', locale), 'error');
                          } else pushToast(t('santa_draw_failed', locale), 'error');
                        }
                      }}
                      style={{
                        background: santaDrawLoading || (santaDrawValidation !== null && !santaDrawValidation.feasible)
                          ? C.textMuted : C.accent,
                        border: 'none', borderRadius: 10, color: '#fff', fontSize: 14, fontWeight: 700,
                        padding: '12px 0', cursor: santaDrawLoading ? 'wait' : 'pointer', width: '100%', fontFamily: font, marginTop: 4,
                      }}
                    >
                      {santaDrawLoading ? t('santa_draw_in_progress', locale) : t('santa_draw_btn', locale)}
                    </button>
                  </div>
                )}

                {camp.status === 'DRAW_IN_PROGRESS' && (
                  <div style={{
                    background: 'var(--wb-accent-soft)',
                    border: '1px solid var(--wb-accent-soft-strong)',
                    borderRadius: 14, padding: '12px 16px',
                    fontSize: 13, color: 'var(--wb-accent-strong)',
                    fontWeight: 650, textAlign: 'center',
                    letterSpacing: '-0.005em',
                    WebkitBackdropFilter: 'blur(14px)' as never,
                    backdropFilter: 'blur(14px)' as never,
                  }}>
                    ⏳ {t('santa_draw_in_progress', locale)}
                  </div>
                )}
              </div>
            )}

            {/* v2.1 Invite link card (owner only, OPEN campaigns) */}
            {isOwner && camp.inviteToken && ['DRAFT', 'OPEN'].includes(camp.status) && (
              <div style={{
                background: 'var(--wb-card)',
                border: '1px solid var(--wb-border)',
                borderRadius: 18, padding: '14px 16px', marginBottom: 16,
                WebkitBackdropFilter: 'blur(14px)' as never,
                backdropFilter: 'blur(14px)' as never,
              }}>
                <div style={{
                  fontSize: 12, fontWeight: 600,
                  color: 'var(--wb-text-muted)',
                  marginBottom: 8,
                  textTransform: 'uppercase' as const, letterSpacing: '0.7px',
                }}>{t('santa_campaign_invite_link', locale)}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    fontSize: 13, color: 'var(--wb-text-secondary)',
                    flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    fontFeatureSettings: '"tnum"',
                  }}>
                    {`t.me/${botUsername}?start=santa_${camp.inviteToken}`}
                  </span>
                  <button onClick={copyInviteLink} style={{
                    background: 'var(--wb-accent-soft)',
                    color: 'var(--wb-accent-strong)',
                    border: '1px solid var(--wb-accent-soft-strong)',
                    borderRadius: 11, fontSize: 12, fontWeight: 650,
                    padding: '7px 12px', cursor: 'pointer', flexShrink: 0,
                    letterSpacing: '-0.005em', fontFamily: font,
                  }}>
                    {t('copy', locale)}
                  </button>
                </div>
              </div>
            )}

            {/* v2.1 My alias card */}
            {myAlias && (
              <div style={{
                background: 'linear-gradient(135deg, var(--wb-card-strong), var(--wb-accent-soft))',
                borderRadius: 18, padding: '14px 16px', marginBottom: 16,
                border: '1px solid var(--wb-accent-soft-strong)',
                WebkitBackdropFilter: 'blur(14px)' as never,
                backdropFilter: 'blur(14px)' as never,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <SantaAvatar alias={myAlias.alias} emoji={myAlias.emoji} size={44} hat={santaSeason?.inSeason} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 11, fontWeight: 600,
                      color: 'var(--wb-text-muted)',
                      textTransform: 'uppercase' as const, letterSpacing: '0.7px',
                      marginBottom: 2,
                    }}>
                      {t('santa_your_name_label', locale)}
                    </div>
                    <div style={{
                      fontSize: 16, fontWeight: 700,
                      color: 'var(--wb-text)',
                      letterSpacing: '-0.02em',
                    }}>
                      {renderSantaAlias(myAlias.adjectiveKey, myAlias.animalKey, locale) || myAlias.alias}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--wb-text-secondary)', marginTop: 3, letterSpacing: '-0.003em' }}>
                      {t('santa_alias_changes_hint', locale)}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* v2.1 Participants list — glass card with hairline separators */}
            <div style={{ marginBottom: 16 }}>
              <div style={{
                fontSize: 12, fontWeight: 600,
                color: 'var(--wb-text-muted)',
                marginBottom: 10,
                textTransform: 'uppercase' as const,
                letterSpacing: '0.7px',
              }}>
                {t('santa_campaign_participants', locale, { count: participants.filter(p => p.status === 'JOINED').length })}
              </div>
              <div style={{
                background: 'var(--wb-card)',
                border: '1px solid var(--wb-border)',
                borderRadius: 18, overflow: 'hidden',
                WebkitBackdropFilter: 'blur(14px)' as never,
                backdropFilter: 'blur(14px)' as never,
              }}>
                {participants.filter(p => p.status === 'JOINED').map((p, idx) => (
                  <div
                    key={p.id}
                    style={{
                      padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12,
                      borderTop: idx > 0 ? '1px solid var(--wb-hairline)' : 'none',
                    }}
                  >
                    <SantaAvatar alias={p.displayName || p.id} emoji={p.emoji || '🎅'} size={36} hat={santaSeason?.inSeason} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' as const }}>
                        <span style={{
                          fontSize: 15, fontWeight: 600,
                          color: 'var(--wb-text)',
                          letterSpacing: '-0.012em',
                        }}>
                          {renderSantaAlias(p.adjectiveKey, p.animalKey, locale) || p.displayName || t('santa_participant_default', locale)}
                          {p.isMe && <span style={{ fontSize: 11, color: 'var(--wb-text-muted)', marginLeft: 4, fontWeight: 500 }}>({t('me_label', locale)})</span>}
                        </span>
                        {p.role === 'ADMIN' && (
                          <Chip tone="accent" size="sm">
                            {t('santa_role_admin', locale)}
                          </Chip>
                        )}
                      </div>
                      {p.hasLinkedWishlist && (
                        <div style={{ fontSize: 12, color: 'var(--wb-success)', marginTop: 2, fontWeight: 600, letterSpacing: '-0.005em' }}>
                          🎁 {t('santa_wishlist_linked_label', locale)}
                        </div>
                      )}
                    </div>
                    {/* Role management (owner only) */}
                    {isOwner && !p.isMe && (
                      <button
                        onClick={async () => {
                          const newRole = p.role === 'ADMIN' ? 'PARTICIPANT' : 'ADMIN';
                          const aliasName = renderSantaAlias(p.adjectiveKey, p.animalKey, locale) || p.displayName || p.id;
                          const confirmMsg = newRole === 'ADMIN'
                            ? t('santa_role_promote_confirm', locale, { name: aliasName })
                            : t('santa_role_demote_confirm', locale, { name: aliasName });
                          if (!confirm(confirmMsg)) return;
                          const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/participants/${p.userId}/role`, {
                            method: 'PATCH',
                            body: JSON.stringify({ role: newRole }),
                            idempotency: { action: `santa.participant.role:${camp.id}:${p.userId}` },
                          });
                          if (res.ok) {
                            const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                            if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                            pushToast(t('done', locale), 'success');
                          } else pushToast(t('error_generic', locale), 'error');
                        }}
                        style={{
                          background: 'var(--wb-surface)',
                          border: '1px solid var(--wb-border)',
                          borderRadius: 10, padding: '5px 10px',
                          fontSize: 11, color: 'var(--wb-text-secondary)',
                          fontWeight: 600, cursor: 'pointer', fontFamily: font, flexShrink: 0,
                          WebkitBackdropFilter: 'blur(14px)' as never,
                          backdropFilter: 'blur(14px)' as never,
                        }}
                        title={p.role === 'ADMIN' ? t('santa_role_demote', locale) : t('santa_role_promote', locale)}
                      >
                        {p.role === 'ADMIN' ? '🛡✕' : '🛡+'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* v2.1 Organizer progress view (post-draw) — glass card with uppercase micro-label */}
            {isOrg && currentSantaCampaign.ownerProgress && ['ACTIVE', 'COMPLETED'].includes(camp.status) && (
              <div style={{
                background: 'var(--wb-card)',
                border: '1px solid var(--wb-border)',
                borderRadius: 18, padding: 16, marginBottom: 16,
                WebkitBackdropFilter: 'blur(14px)' as never,
                backdropFilter: 'blur(14px)' as never,
              }}>
                <div style={{
                  fontSize: 12, fontWeight: 600,
                  color: 'var(--wb-text-muted)',
                  marginBottom: 12,
                  textTransform: 'uppercase' as const, letterSpacing: '0.7px',
                }}>
                  {t('santa_gift_status_title', locale)}
                </div>
                {(() => {
                  const p = currentSantaCampaign.ownerProgress!.progress;
                  const total = p.pending + p.buying + p.selectedFromWishlist + p.selectedOutside
                    + p.declinedToSay + p.missedDeadline + p.sent + p.received + (p.orphaned ?? 0);
                  const allTerminal = total > 0 && p.pending === 0 && p.buying === 0 && p.selectedFromWishlist === 0
                    && p.selectedOutside === 0 && p.declinedToSay === 0 && p.sent === 0;
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {allTerminal && (
                        <div style={{
                          fontSize: 14, fontWeight: 700,
                          color: 'var(--wb-success)',
                          marginBottom: 4, letterSpacing: '-0.01em',
                        }}>
                          ✓ {t('santa_gift_all_received', locale)}
                        </div>
                      )}
                      {[
                        { key: 'pending', count: p.pending, label: t('santa_gift_progress_pending', locale, { count: p.pending, total }), color: 'var(--wb-text-secondary)' },
                        { key: 'missed', count: p.missedDeadline, label: t('santa_gift_progress_missed_deadline', locale, { count: p.missedDeadline }), color: 'var(--wb-danger)' },
                        { key: 'orphaned', count: p.orphaned ?? 0, label: t('santa_gift_status_orphaned', locale), color: 'var(--wb-text-muted)' },
                        { key: 'buying', count: p.buying, label: t('santa_gift_progress_buying', locale, { count: p.buying }), color: 'var(--wb-text-secondary)' },
                        { key: 'wishlist', count: p.selectedFromWishlist, label: t('santa_gift_progress_selected_wishlist', locale, { count: p.selectedFromWishlist }), color: 'var(--wb-accent-strong)' },
                        { key: 'outside', count: p.selectedOutside, label: t('santa_gift_progress_selected_outside', locale, { count: p.selectedOutside }), color: 'var(--wb-accent-strong)' },
                        { key: 'declined', count: p.declinedToSay, label: t('santa_gift_progress_declined', locale, { count: p.declinedToSay }), color: 'var(--wb-text-secondary)' },
                        { key: 'sent', count: p.sent, label: t('santa_gift_progress_sent', locale, { count: p.sent }), color: 'var(--wb-accent-strong)' },
                        { key: 'received', count: p.received, label: t('santa_gift_progress_received', locale, { count: p.received }), color: 'var(--wb-success)' },
                        { key: 'noWishlist', count: p.withoutWishlist, label: t('santa_gift_progress_without_wishlist', locale, { count: p.withoutWishlist }), color: 'var(--wb-text-muted)' },
                      ].filter(row => row.count > 0).map(row => (
                        <div key={row.key} style={{ fontSize: 13, fontWeight: 500, color: row.color, letterSpacing: '-0.005em' }}>{row.label}</div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* ══ v2.1 MY WISHLIST — Prominent block, visible to all JOINED participants ══ */}
            {(() => {
              const me = participants.find(p => p.isMe);
              if (!me || me.status !== 'JOINED') return null;
              const isReadOnly = ['COMPLETED', 'CANCELLED'].includes(camp.status);
              return (
                <div style={{
                  background: 'var(--wb-card)',
                  border: '1px solid var(--wb-border)',
                  borderRadius: 18, padding: 16, marginBottom: 16,
                  WebkitBackdropFilter: 'blur(14px)' as never,
                  backdropFilter: 'blur(14px)' as never,
                }}>
                  <div style={{
                    fontSize: 12, fontWeight: 600,
                    color: 'var(--wb-text-muted)',
                    marginBottom: 10,
                    textTransform: 'uppercase' as const, letterSpacing: '0.7px',
                  }}>
                    🎁 {t('santa_my_wishlist_section', locale)}
                  </div>
                  {me.linkedWishlist ? (
                    <div>
                      <div style={{
                        fontSize: 13, fontWeight: 650,
                        color: 'var(--wb-success)',
                        marginBottom: 8, letterSpacing: '-0.005em',
                      }}>
                        ✓ {t('santa_wishlist_linked_label', locale)}
                      </div>
                      {isReadOnly ? null : (
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <Button
                            variant="surface"
                            size="sm"
                            fullWidth={false}
                            onClick={() => { setSantaWishlistPickerReturnId(camp.id); setScreen('my-wishlists'); }}
                          >
                            {t('santa_wishlist_open', locale)}
                          </Button>
                          <button
                            onClick={() => setShowSantaWishlistPicker(true)}
                            style={{
                              background: 'none', border: 'none',
                              color: 'var(--wb-accent-strong)',
                              fontSize: 13, fontWeight: 650, cursor: 'pointer',
                              padding: '8px 0', fontFamily: font,
                              letterSpacing: '-0.005em',
                            }}
                          >
                            {t('santa_wishlist_change', locale)}
                          </button>
                        </div>
                      )}
                    </div>
                  ) : isReadOnly ? (
                    <div style={{ fontSize: 13, color: 'var(--wb-text-muted)', letterSpacing: '-0.005em' }}>
                      {t('santa_campaign_wishlist_not_linked_active', locale)}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{
                        fontSize: 13, color: 'var(--wb-text-secondary)',
                        letterSpacing: '-0.005em', lineHeight: 1.4,
                      }}>
                        {t('santa_wishlist_not_linked', locale)}
                      </div>
                      <Button
                        variant="primary-gradient"
                        fullWidth
                        onClick={() => setShowSantaWishlistPicker(true)}
                      >
                        {t('santa_wishlist_select_from_mine', locale)}
                      </Button>
                      <Button
                        variant="surface"
                        fullWidth
                        onClick={() => { setSantaWishlistPickerReturnId(camp.id); setShowSantaWishlistPicker(false); setScreen('my-wishlists'); }}
                      >
                        {t('santa_wishlist_picker_create_new', locale)}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* v2.1 Giver view — glass card with uppercase micro-label */}
            {myAssignment && myAssignment.role === 'giver' && ['ACTIVE', 'COMPLETED'].includes(camp.status) && (
              <div style={{
                background: 'var(--wb-card)',
                border: '1px solid var(--wb-border)',
                borderRadius: 18, padding: 16, marginBottom: 16,
                WebkitBackdropFilter: 'blur(14px)' as never,
                backdropFilter: 'blur(14px)' as never,
              }}>
                <div style={{
                  fontSize: 12, fontWeight: 600,
                  color: 'var(--wb-text-muted)',
                  marginBottom: 10,
                  textTransform: 'uppercase' as const, letterSpacing: '0.7px',
                }}>
                  {t('santa_gift_my_recipient', locale)}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                  <SantaAvatar alias={myAssignment.receiver.displayName} emoji={myAssignment.receiver.emoji || '🎅'} size={40} hat={santaSeason?.inSeason} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 15, fontWeight: 650,
                      color: 'var(--wb-text)',
                      letterSpacing: '-0.012em',
                    }}>
                      {renderSantaAlias(myAssignment.receiver.adjectiveKey, myAssignment.receiver.animalKey, locale) || myAssignment.receiver.displayName}
                    </div>
                    <div style={{
                      fontSize: 12, color: 'var(--wb-text-secondary)',
                      marginTop: 2, letterSpacing: '-0.005em',
                    }}>
                      {t(`santa_gift_status_${myAssignment.giftStatus.toLowerCase()}` as never, locale) || myAssignment.giftStatus}
                    </div>
                  </div>
                </div>

                {/* Gift status controls — Batch 3: 3-choice giver flow */}
                {myAssignment.giftStatus !== 'RECEIVED' && (() => {
                  const gs = myAssignment.giftStatus;
                  const canChoose = ['PENDING', 'BUYING', 'MISSED_DEADLINE'].includes(gs);
                  const hasChosen = ['SELECTED_FROM_WISHLIST', 'SELECTED_OUTSIDE', 'DECLINED_TO_SAY'].includes(gs);
                  const isSent = gs === 'SENT';

                  const updateStatus = async (status: string) => {
                    if (status === gs) return; // M2: no-op on self-transition — avoids 409 on tapping active button
                    const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/gift-status`, {
                      method: 'PATCH',
                      body: JSON.stringify({ status }),
                      idempotency: { action: `santa.gift-status:${camp.id}` },
                    });
                    if (res.ok) {
                      const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                      if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                    }
                  };

                  const btnStyle = (accent?: boolean) => ({
                    background: accent
                      ? 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))'
                      : 'var(--wb-surface)',
                    border: accent ? 'none' : '1px solid var(--wb-border)',
                    borderRadius: 12,
                    color: accent ? '#fff' : 'var(--wb-text)',
                    fontSize: 13,
                    fontWeight: 650,
                    padding: '9px 14px',
                    cursor: 'pointer',
                    fontFamily: font,
                    letterSpacing: '-0.005em',
                    boxShadow: accent
                      ? '0 6px 16px var(--wb-accent-shadow-soft), inset 0 1px 0 rgba(255,255,255,0.18)'
                      : undefined,
                    WebkitBackdropFilter: accent ? undefined : ('blur(14px)' as never),
                    backdropFilter: accent ? undefined : ('blur(14px)' as never),
                  } as React.CSSProperties);

                  // Helper: handle switch-away from wishlist with confirm modal if reservations exist
                  const handleSwitchFromWishlist = async (newStatus: string) => {
                    const hasReservations = (myAssignment.reservedItems?.length ?? 0) > 0;
                    if (hasReservations && gs === 'SELECTED_FROM_WISHLIST') {
                      setSantaSwitchModalOpen(true);
                      return;
                    }
                    await updateStatus(newStatus);
                  };

                  return (
                    <div style={{ marginBottom: 12 }}>
                      {/* Current status label */}
                      <div style={{
                        fontSize: 12, fontWeight: 500,
                        color: gs === 'MISSED_DEADLINE' ? 'var(--wb-danger)' : 'var(--wb-text-muted)',
                        marginBottom: 8, letterSpacing: '-0.003em',
                      }}>
                        {t('santa_gift_status_title', locale)}: <b style={{ fontWeight: 650 }}>{t(`santa_gift_status_${gs.toLowerCase()}` as never, locale) || gs}</b>
                      </div>

                      {/* Reserved items summary badge */}
                      {(myAssignment.reservedItems?.length ?? 0) > 0 && (
                        <div style={{
                          fontSize: 12, fontWeight: 600,
                          color: 'var(--wb-accent-strong)',
                          background: 'var(--wb-accent-soft)',
                          border: '1px solid var(--wb-accent-soft-strong)',
                          borderRadius: 10, padding: '5px 11px',
                          marginBottom: 10, display: 'inline-block',
                          letterSpacing: '-0.005em',
                        }}>
                          {myAssignment.reservedItems.length === 1
                            ? t('santa_wishlist_my_reservations_one', locale).replace('{{title}}', myAssignment.reservedItems[0]?.title ?? '')
                            : t('santa_wishlist_my_reservations_many', locale).replace('{{n}}', String(myAssignment.reservedItems.length))}
                        </div>
                      )}

                      {/* 3-choice buttons when undecided or coming from legacy BUYING / missed deadline */}
                      {(canChoose || hasChosen) && !isSent && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {(canChoose || hasChosen) && (
                            <>
                              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 2 }}>
                                {t('santa_gift_choose_title', locale)}
                              </div>
                              {/* P0.3: show note if receiver has no wishlist */}
                              {!myAssignment.receiver.hasLinkedWishlist && (
                                <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4 }}>
                                  ⚠️ {t('santa_campaign_receiver_no_wishlist_yet', locale)}
                                </div>
                              )}
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                {/* Wishlist button: opens Santa-safe wishlist screen */}
                                <button
                                  onClick={async () => {
                                    if (!myAssignment.receiver.hasLinkedWishlist) return;
                                    setSantaReceiverWishlistLoading(true);
                                    const r = await tgFetch(`/tg/santa/campaigns/${camp.id}/inbound/wishlist`);
                                    if (r.ok) setSantaReceiverWishlist(await r.json() as typeof santaReceiverWishlist);
                                    setSantaReceiverWishlistLoading(false);
                                    setScreen('santa-receiver-wishlist');
                                  }}
                                  disabled={!myAssignment.receiver.hasLinkedWishlist || santaReceiverWishlistLoading}
                                  style={{ ...btnStyle(gs === 'SELECTED_FROM_WISHLIST'), fontSize: 12, opacity: myAssignment.receiver.hasLinkedWishlist ? 1 : 0.4, cursor: myAssignment.receiver.hasLinkedWishlist ? 'pointer' : 'not-allowed' }}
                                >
                                  📋 {santaReceiverWishlistLoading ? t('loading', locale) : t('santa_gift_mark_selected_from_wishlist', locale)}
                                </button>
                                <button
                                  onClick={() => handleSwitchFromWishlist('SELECTED_OUTSIDE')}
                                  style={{ ...btnStyle(gs === 'SELECTED_OUTSIDE'), fontSize: 12 }}
                                >
                                  🛍 {t('santa_gift_mark_selected_outside', locale)}
                                </button>
                                <button
                                  onClick={() => handleSwitchFromWishlist('DECLINED_TO_SAY')}
                                  style={{ ...btnStyle(gs === 'DECLINED_TO_SAY'), fontSize: 12 }}
                                >
                                  🎁 {t('santa_gift_mark_declined_to_say', locale)}
                                </button>
                              </div>
                            </>
                          )}
                          {/* Mark sent — available from any non-terminal state except PENDING/MISSED_DEADLINE */}
                          {(hasChosen || gs === 'BUYING') && (
                            <button
                              onClick={async () => {
                                if (!window.confirm(t('santa_gift_mark_sent_confirm', locale))) return;
                                await updateStatus('SENT');
                              }}
                              style={{ ...btnStyle(true), marginTop: 4 }}
                            >
                              📦 {t('santa_gift_mark_sent', locale)}
                            </button>
                          )}
                        </div>
                      )}

                      {/* Sent confirmation state */}
                      {isSent && (
                        <div style={{
                          fontSize: 14, color: 'var(--wb-success)',
                          fontWeight: 650, letterSpacing: '-0.005em',
                        }}>
                          ✓ {t('santa_campaign_gift_status_sent', locale)}
                        </div>
                      )}

                      {/* Confirm modal: switch away from wishlist reservations */}
                      {santaSwitchModalOpen && (
                        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
                          onClick={() => setSantaSwitchModalOpen(false)}>
                          <div style={{ background: C.card, borderRadius: '16px 16px 0 0', padding: '24px 20px 32px', width: '100%', maxWidth: 480 }}
                            onClick={e => e.stopPropagation()}>
                            <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>
                              {t('santa_wishlist_switch_modal_title', locale)}
                            </div>
                            <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 20 }}>
                              {t('santa_wishlist_switch_modal_body', locale)}
                            </div>
                            <Button
                              variant="danger-solid"
                              style={{ marginBottom: 10 }}
                              onClick={async () => {
                                setSantaSwitchModalOpen(false);
                                await updateStatus('SELECTED_OUTSIDE');
                              }}
                            >
                              {t('santa_wishlist_switch_confirm', locale)}
                            </Button>
                            <Button variant="secondary" onClick={() => setSantaSwitchModalOpen(false)}>
                              {t('cancel', locale)}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* View receiver's wishlist — opens dedicated Santa-safe wishlist screen */}
                {currentSantaCampaign.myAssignment?.receiver.hasLinkedWishlist ? (
                  <button
                    disabled={santaReceiverWishlistLoading}
                    onClick={async () => {
                      setSantaReceiverWishlistLoading(true);
                      const r = await tgFetch(`/tg/santa/campaigns/${camp.id}/inbound/wishlist`);
                      if (r.ok) setSantaReceiverWishlist(await r.json() as typeof santaReceiverWishlist);
                      setSantaReceiverWishlistLoading(false);
                      setScreen('santa-receiver-wishlist');
                    }}
                    style={{ background: 'none', border: `1px solid ${C.accent}`, borderRadius: 10, color: C.accent, fontSize: 13, fontWeight: 600, padding: '8px 16px', cursor: santaReceiverWishlistLoading ? 'wait' : 'pointer', width: '100%', fontFamily: font }}
                  >
                    {santaReceiverWishlistLoading ? t('loading', locale) : `📋 ${t('santa_campaign_receiver_wishlist', locale)}`}
                  </button>
                ) : (
                  <div style={{ fontSize: 13, color: C.textMuted, textAlign: 'center', padding: '8px 0' }}>
                    {t('santa_campaign_receiver_no_wishlist_yet', locale)}
                  </div>
                )}

                {/* ── Hint section (Batch 2.5) — giver requests anonymous wishlist hint ── */}
                {camp.status === 'ACTIVE' && (
                  <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
                    {/* No hint yet — show request button */}
                    {!santaHintRequest && (
                      <button
                        disabled={santaHintRequestLoading}
                        onClick={async () => {
                          setSantaHintRequestLoading(true);
                          const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/hints`, {
                            method: 'POST',
                            idempotency: { action: `santa.hint.request:${camp.id}` },
                          });
                          if (res.ok) {
                            const data = await res.json() as typeof santaHintRequest;
                            setSantaHintRequest(data);
                          } else {
                            const err = await res.json() as { error?: string };
                            if (err.error === 'pro_required') pushToast(t('santa_hint_pro_required', locale), 'error');
                            else if (err.error === 'receiver_no_wishlist') pushToast(t('santa_hint_no_wishlist', locale), 'error');
                            else pushToast(t('error_generic', locale), 'error');
                          }
                          setSantaHintRequestLoading(false);
                        }}
                        style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 10, color: C.textSec, fontSize: 13, padding: '8px 16px', cursor: santaHintRequestLoading ? 'wait' : 'pointer', width: '100%', fontFamily: font }}
                      >
                        {santaHintRequestLoading ? t('loading', locale) : `💡 ${t('santa_hint_request_btn', locale)}`}
                      </button>
                    )}

                    {/* Hint exists — show status */}
                    {santaHintRequest && (
                      <div>
                        <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 6 }}>💡</div>
                        {santaHintRequest.status === 'PENDING' && (
                          <div style={{ fontSize: 13, color: C.textSec }}>{t('santa_hint_pending', locale)}</div>
                        )}
                        {santaHintRequest.status === 'FULFILLED' && (
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: C.green, marginBottom: 8 }}>✓ {t('santa_hint_fulfilled', locale)}</div>
                            {santaHintRequest.selectedItems && santaHintRequest.selectedItems.length > 0 && (
                              <div>
                                <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4 }}>{t('santa_hint_selected_items_title', locale)}</div>
                                {santaHintRequest.selectedItems.map(item => (
                                  <div key={item.id} style={{ background: C.surface, borderRadius: 8, padding: '8px 10px', marginBottom: 4 }}>
                                    <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{item.title}</div>
                                    {item.priceText && <div style={{ fontSize: 12, color: C.textMuted }}>{item.priceText}</div>}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        {santaHintRequest.status === 'EXPIRED' && (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                            <div style={{ fontSize: 13, color: C.textMuted }}>{t('santa_hint_expired', locale)}</div>
                            <button
                              disabled={santaHintRequestLoading}
                              onClick={async () => {
                                setSantaHintRequest(null);
                                setSantaHintRequestLoading(true);
                                const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/hints`, {
                                  method: 'POST',
                                  idempotency: { action: `santa.hint.request:${camp.id}` },
                                });
                                if (res.ok) setSantaHintRequest(await res.json() as typeof santaHintRequest);
                                else pushToast(t('error_generic', locale), 'error');
                                setSantaHintRequestLoading(false);
                              }}
                              style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 8, color: C.textSec, fontSize: 12, padding: '6px 12px', cursor: 'pointer', fontFamily: font }}
                            >
                              {santaHintRequestLoading ? t('loading', locale) : t('santa_hint_request_btn', locale)}
                            </button>
                          </div>
                        )}
                        {santaHintRequest.status === 'CANCELLED' && (
                          <div style={{ fontSize: 13, color: C.textMuted }}>{t('santa_hint_cancelled', locale)}</div>
                        )}

                        {/* Poll for updates — refresh hint status */}
                        {santaHintRequest.status === 'PENDING' && (
                          <button
                            disabled={santaHintRequestLoading}
                            onClick={async () => {
                              setSantaHintRequestLoading(true);
                              const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/hints`);
                              if (res.ok) {
                                const data = await res.json() as { hint: typeof santaHintRequest };
                                if (data.hint) setSantaHintRequest(data.hint);
                              }
                              setSantaHintRequestLoading(false);
                            }}
                            style={{ marginTop: 8, background: 'none', border: 'none', color: C.textMuted, fontSize: 12, padding: '4px 0', cursor: 'pointer', fontFamily: font }}
                          >
                            {santaHintRequestLoading ? t('loading', locale) : t('santa_hint_refresh', locale)}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Receiver inbound view (post-draw) — role: receiver, no giver identity */}
            {!isOwner && ['ACTIVE', 'COMPLETED'].includes(camp.status) && (() => {
              const myParticipant = participants.find(p => p.isMe);
              if (!myParticipant) return null;
              return (
                <div style={{ background: C.card, borderRadius: 14, padding: 16, marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, marginBottom: 8 }}>
                    {t('santa_my_gift_label', locale)}
                  </div>

                  {/* Load inbound status on demand */}
                  {!santaInboundStatus && (
                    <button
                      disabled={santaInboundLoading}
                      onClick={async () => {
                        setSantaInboundLoading(true);
                        const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/inbound/status`);
                        if (res.ok) setSantaInboundStatus(await res.json() as typeof santaInboundStatus);
                        setSantaInboundLoading(false);
                      }}
                      style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, fontSize: 13, padding: '8px 16px', cursor: 'pointer', width: '100%' }}
                    >
                      {santaInboundLoading ? t('loading', locale) : t('santa_check_status_btn', locale)}
                    </button>
                  )}

                  {santaInboundStatus && (
                    <div>
                      {/* Batch 3: semantic signal display — never exposes raw giftStatus */}
                      {santaInboundStatus.signal === 'waiting' && (
                        <div style={{ fontSize: 13, color: C.textSec }}>{t('santa_inbound_signal_waiting', locale)}</div>
                      )}
                      {santaInboundStatus.signal === 'in_progress' && (
                        <div style={{ fontSize: 13, color: C.accent, fontWeight: 600 }}>🎁 {t('santa_inbound_signal_in_progress', locale)}</div>
                      )}
                      {santaInboundStatus.signal === 'ready' && (
                        <div style={{ fontSize: 13, color: C.accent, fontWeight: 700 }}>📦 {t('santa_inbound_signal_ready', locale)}</div>
                      )}
                      {santaInboundStatus.signal === 'received' && (
                        <div style={{ fontSize: 13, color: C.green, fontWeight: 700 }}>✓ {t('santa_inbound_signal_received', locale)}</div>
                      )}

                      {/* Confirm received — only when signal === 'ready' (giftStatus SENT on backend) */}
                      {santaInboundStatus.canConfirmReceived && (
                        <button
                          onClick={async () => {
                            if (!window.confirm(t('santa_inbound_confirm_received_confirm', locale))) return;
                            const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/confirm-received`, {
                              method: 'POST',
                              idempotency: { action: `santa.confirm-received:${camp.id}` },
                            });
                            if (res.ok) {
                              const json = await res.json() as { campaignCompleted: boolean; canReveal: boolean };
                              setSantaInboundStatus(prev => prev ? {
                                ...prev,
                                signal: 'received',
                                canConfirmReceived: false,
                                canReveal: json.canReveal,
                              } : prev);
                              pushToast(json.campaignCompleted ? t('santa_gift_all_received', locale) : t('done', locale), 'success');
                              const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                              if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                            }
                          }}
                          style={{ marginTop: 12, background: C.green, border: 'none', borderRadius: 10, color: '#000', fontSize: 13, fontWeight: 700, padding: '10px 0', cursor: 'pointer', width: '100%', fontFamily: font }}
                        >
                          {t('santa_inbound_confirm_received_btn', locale)}
                        </button>
                      )}

                      {/* Reveal button — visible immediately after RECEIVED (canReveal: true) */}
                      {santaInboundStatus.canReveal && !santaReveal && (
                        <button
                          disabled={santaRevealLoading}
                          onClick={async () => {
                            setSantaRevealLoading(true);
                            const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/reveal`);
                            if (res.ok) setSantaReveal(await res.json() as typeof santaReveal);
                            else pushToast(t('error_generic', locale), 'error');
                            setSantaRevealLoading(false);
                          }}
                          style={{ marginTop: 8, background: C.accent, border: 'none', borderRadius: 10, color: '#fff', fontSize: 13, fontWeight: 700, padding: '10px 0', cursor: santaRevealLoading ? 'wait' : 'pointer', width: '100%', fontFamily: font }}
                        >
                          🎅 {santaRevealLoading ? t('loading', locale) : t('santa_inbound_reveal_btn', locale)}
                        </button>
                      )}

                      {/* Reveal result — alias-only, forever */}
                      {santaInboundStatus.canReveal && santaReveal?.revealed && santaReveal.giver && (
                        <div style={{ marginTop: 12, background: `rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.071)`, borderRadius: 12, padding: 14, border: `1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.188)` }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 10 }}>
                            🎅 {t('santa_revealed_title', locale)}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                            <SantaAvatar alias={santaReveal.giver.displayName} emoji={santaReveal.giver.emoji || '🎅'} size={44} hat={santaSeason?.inSeason} />
                            <div>
                              <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
                                {renderSantaAlias(santaReveal.giver.adjectiveKey ?? '', santaReveal.giver.animalKey ?? '', locale) || santaReveal.giver.displayName}
                              </div>
                              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                                {t('santa_reveal_subtitle', locale)}
                              </div>
                            </div>
                          </div>
                          {santaReveal.giftNote ? (
                            <div style={{ fontSize: 13, color: C.textSec, marginTop: 6 }}>
                              <span style={{ color: C.textMuted }}>{t('santa_reveal_note_label', locale)}</span>{' '}
                              {santaReveal.giftNote}
                            </div>
                          ) : (
                            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>{t('santa_reveal_no_note', locale)}</div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Receiver inbound hint card (Batch 2.5) — shown when receiver has a PENDING hint request */}
            {!isOwner && camp.status === 'ACTIVE' && (() => {
              const myParticipant = participants.find(p => p.isMe);
              if (!myParticipant) return null;
              return (
                <div>
                  {/* Load hint on demand (lazy — don't auto-poll to preserve anonymity perception) */}
                  {!santaHintInbound && (
                    <button
                      disabled={santaHintInboundLoading}
                      onClick={async () => {
                        setSantaHintInboundLoading(true);
                        const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/inbound/hint`);
                        if (res.ok) setSantaHintInbound(await res.json() as typeof santaHintInbound);
                        setSantaHintInboundLoading(false);
                      }}
                      style={{ display: 'none' }} // Trigger is the card below; this is just a mount-guard
                    />
                  )}

                  {/* Only render the hint card when there's an active PENDING hint */}
                  {santaHintInbound?.hasPendingHint && santaHintInbound.hint && (
                    <div style={{ background: `rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.082)`, borderRadius: 14, padding: 16, marginBottom: 16, border: `1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.188)` }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 6 }}>
                        💡 {t('santa_hint_inbound_title', locale)}
                      </div>
                      <div style={{ fontSize: 13, color: C.textSec, marginBottom: 12 }}>
                        {t('santa_hint_inbound_desc', locale)}
                      </div>
                      <button
                        onClick={async () => {
                          // Load receiver's own linked wishlist items for selection
                          if (!myParticipant.linkedWishlist?.id) {
                            pushToast(t('santa_hint_inbound_no_items', locale), 'error');
                            return;
                          }
                          setSantaHintInboundLoading(true);
                          const res = await tgFetch(`/tg/wishlists/${myParticipant.linkedWishlist.id}/items`);
                          if (res.ok) {
                            const data = await res.json() as { items?: { id: string; title: string; priceText: string | null; status: string }[] };
                            const available = (data.items ?? []).filter(i => i.status === 'AVAILABLE');
                            if (available.length === 0) {
                              pushToast(t('santa_hint_inbound_no_items', locale), 'error');
                            } else {
                              setSantaHintPickerItems(available);
                              setSantaHintPickerSelectedIds([]);
                              setSantaHintPickerOpen(true);
                            }
                          } else {
                            pushToast(t('error_generic', locale), 'error');
                          }
                          setSantaHintInboundLoading(false);
                        }}
                        disabled={santaHintInboundLoading}
                        style={{ background: C.accent, border: 'none', borderRadius: 10, color: '#fff', fontSize: 13, fontWeight: 600, padding: '10px 0', cursor: santaHintInboundLoading ? 'wait' : 'pointer', width: '100%', fontFamily: font }}
                      >
                        {santaHintInboundLoading ? t('loading', locale) : t('santa_hint_inbound_select_items', locale)}
                      </button>
                    </div>
                  )}

                  {/* Lazy-load trigger: check for pending hint when component first mounts */}
                  {santaHintInbound === null && !santaHintInboundLoading && camp.status === 'ACTIVE' && (
                    <div
                      ref={(el) => {
                        if (el && santaHintInbound === null && !santaHintInboundLoading) {
                          void (async () => {
                            setSantaHintInboundLoading(true);
                            const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/inbound/hint`);
                            if (res.ok) setSantaHintInbound(await res.json() as typeof santaHintInbound);
                            setSantaHintInboundLoading(false);
                          })();
                        }
                      }}
                    />
                  )}
                </div>
              );
            })()}

            {/* Reveal section — Batch 3: standalone reveal card for campaign-COMPLETED state
                when inbound status wasn't already loaded (e.g. user navigates back).
                Primary reveal UX lives inside the inbound status card above.         */}
            {camp.status === 'COMPLETED' && !santaInboundStatus && (() => {
              const myParticipant = participants.find(p => p.isMe);
              if (!myParticipant || isOwner) return null;
              return (
                <div style={{ background: `rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.063)`, borderRadius: 14, padding: 16, marginBottom: 16, border: `1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.188)` }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 8 }}>
                    🎅 {t('santa_reveal_title', locale)}
                  </div>
                  {!santaReveal ? (
                    <button
                      disabled={santaRevealLoading}
                      onClick={async () => {
                        setSantaRevealLoading(true);
                        const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/reveal`);
                        if (res.ok) {
                          const data = await res.json() as typeof santaReveal;
                          setSantaReveal(data);
                        } else {
                          const err = await res.json().catch(() => ({})) as { error?: string };
                          if (err.error === 'reveal_not_available') {
                            pushToast(t('santa_reveal_not_received_yet', locale), 'error');
                          } else {
                            pushToast(t('error_generic', locale), 'error');
                          }
                        }
                        setSantaRevealLoading(false);
                      }}
                      style={{ background: C.accent, border: 'none', borderRadius: 10, color: '#fff', fontSize: 13, fontWeight: 600, padding: '10px 0', cursor: santaRevealLoading ? 'wait' : 'pointer', width: '100%', fontFamily: font }}
                    >
                      {santaRevealLoading ? t('loading', locale) : t('santa_reveal_btn', locale)}
                    </button>
                  ) : santaReveal?.revealed && santaReveal.giver ? (
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                        <SantaAvatar alias={santaReveal.giver.displayName} emoji={santaReveal.giver.emoji || '🎅'} size={44} hat={santaSeason?.inSeason} />
                        <div>
                          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
                            {renderSantaAlias(santaReveal.giver.adjectiveKey ?? '', santaReveal.giver.animalKey ?? '', locale) || santaReveal.giver.displayName}
                          </div>
                          <div style={{ fontSize: 11, color: C.textMuted }}>
                            {t('santa_my_santa_label', locale)}
                          </div>
                        </div>
                      </div>
                      {santaReveal.giftNote ? (
                        <div style={{ fontSize: 13, color: C.textSec }}>
                          <span style={{ color: C.textMuted }}>{t('santa_reveal_note_label', locale)}</span>{' '}
                          {santaReveal.giftNote}
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, color: C.textMuted }}>{t('santa_reveal_no_note', locale)}</div>
                      )}
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: C.textMuted }}>{t('santa_reveal_not_ready', locale)}</div>
                  )}
                </div>
              );
            })()}

            {/* Leave campaign (non-owner, pre-draw) */}
            {!isOwner && ['OPEN', 'DRAFT'].includes(camp.status) && (
              <button
                onClick={async () => {
                  if (!confirm(t('santa_leave_confirm', locale, { title: camp.title }))) return;
                  const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/leave`, {
                    method: 'POST',
                    idempotency: { action: `santa.participant.leave:${camp.id}` },
                  });
                  if (res.ok) {
                    setCurrentSantaCampaign(null);
                    setSantaCampaigns(prev => ({
                      ...prev,
                      joined: prev.joined.filter(c => c.id !== camp.id),
                    }));
                    setScreen('santa-hub');
                  }
                }}
                style={{ background: 'none', border: `1px solid rgba(251, 113, 133, 0.251)`, borderRadius: 12, color: C.red, fontSize: 13, fontWeight: 600, padding: '10px 0', cursor: 'pointer', fontFamily: font, width: '100%', marginTop: 8 }}
              >
                {t('santa_leave_btn', locale)}
              </button>
            )}

            {/* Exit request for LOCKED/ACTIVE campaigns (non-owner, no pending request) */}
            {!isOwner && ['LOCKED', 'ACTIVE'].includes(camp.status) && !pendingExitRequestId && (() => {
              const myP = participants.find(p => p.isMe);
              if (!myP || myP.status !== 'JOINED') return null;
              return (
                <button
                  onClick={() => setSantaExitRequestSheetOpen(true)}
                  style={{ background: 'none', border: `1px solid rgba(251, 113, 133, 0.251)`, borderRadius: 12, color: C.red, fontSize: 13, fontWeight: 600, padding: '10px 0', cursor: 'pointer', fontFamily: font, width: '100%', marginTop: 8 }}
                >
                  {t('santa_exit_request_submit', locale)}
                </button>
              );
            })()}

            {/* Exit request bottom sheet */}
            {santaExitRequestSheetOpen && (
              <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: C.surface, borderTop: `1px solid ${C.border}`, borderRadius: '20px 20px 0 0', padding: '20px 20px 40px', zIndex: 1000 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 12 }}>{t('santa_exit_request_title', locale)}</div>
                <textarea
                  value={santaExitRequestReason}
                  onChange={e => setSantaExitRequestReason(e.target.value)}
                  placeholder={t('santa_exit_request_reason_placeholder', locale)}
                  rows={3}
                  maxLength={300}
                  style={{ width: '100%', borderRadius: 10, border: `1px solid ${C.border}`, padding: '10px 12px', fontSize: 14, fontFamily: font, color: C.text, background: C.card, resize: 'none', boxSizing: 'border-box' }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button
                    onClick={() => { setSantaExitRequestSheetOpen(false); setSantaExitRequestReason(''); }}
                    style={{ flex: 1, background: 'none', border: `1px solid ${C.border}`, borderRadius: 10, color: C.textSec, fontSize: 14, fontWeight: 600, padding: '10px 0', cursor: 'pointer', fontFamily: font }}
                  >
                    {t('cancel', locale)}
                  </button>
                  <button
                    disabled={santaExitRequestSubmitting}
                    onClick={async () => {
                      setSantaExitRequestSubmitting(true);
                      const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/exit-request`, {
                        method: 'POST',
                        body: JSON.stringify({ reason: santaExitRequestReason.trim() || undefined }),
                        idempotency: { action: `santa.exit-request.create:${camp.id}` },
                      });
                      if (res.ok) {
                        setSantaExitRequestSheetOpen(false);
                        setSantaExitRequestReason('');
                        // Re-fetch campaign to get pendingExitRequestId
                        const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                        if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                        pushToast(t('santa_exit_request_submitted', locale), 'success');
                      } else {
                        const err = await res.json().catch(() => ({})) as { error?: string };
                        if (err.error === 'exit_request_already_pending') pushToast(t('santa_exit_request_pending_banner', locale), 'info');
                        else pushToast(t('error_generic', locale), 'error');
                      }
                      setSantaExitRequestSubmitting(false);
                    }}
                    style={{ flex: 2, background: C.red, border: 'none', borderRadius: 10, color: '#fff', fontSize: 14, fontWeight: 700, padding: '10px 0', cursor: santaExitRequestSubmitting ? 'wait' : 'pointer', fontFamily: font, opacity: santaExitRequestSubmitting ? 0.6 : 1 }}
                  >
                    {santaExitRequestSubmitting ? '…' : t('santa_exit_request_submit', locale)}
                  </button>
                </div>
              </div>
            )}

            {/* Cancel campaign (owner only) */}
            {isOwner && !['COMPLETED', 'CANCELLED'].includes(camp.status) && (
              <button
                onClick={async () => {
                  if (!confirm(t('santa_campaign_cancel_confirm', locale))) return;
                  const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/cancel`, {
                    method: 'POST',
                    idempotency: { action: `santa.campaign.cancel:${camp.id}` },
                  });
                  if (res.ok) {
                    const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                    if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                    pushToast(t('done', locale), 'success');
                  }
                }}
                style={{ background: 'none', border: `1px solid rgba(251, 113, 133, 0.251)`, borderRadius: 12, color: C.red, fontSize: 13, fontWeight: 600, padding: '10px 0', cursor: 'pointer', fontFamily: font, width: '100%', marginTop: 8 }}
              >
                {t('santa_campaign_cancel_btn', locale)}
              </button>
            )}

            {/* Multi-round controls — owner-only lifecycle actions */}
            {isOwner && camp.status === 'ACTIVE' && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* Start next round — only when current round is complete */}
                {canStartNextRound && (
                  <button
                    onClick={async () => {
                      const nextN = (currentRoundNumber ?? 1) + 1;
                      if (!confirm(t('santa_round_start_confirm', locale, { n: String(nextN) }))) return;
                      const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/rounds`, {
                        method: 'POST',
                        idempotency: { action: `santa.round.create:${camp.id}` },
                      });
                      if (res.ok) {
                        const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                        if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                        pushToast(t('done', locale), 'success');
                      } else {
                        const err = await res.json() as { error?: string };
                        if (err.error === 'round_not_complete') pushToast(t('santa_round_not_terminal', locale), 'error');
                        else pushToast(t('error_generic', locale), 'error');
                      }
                    }}
                    style={{ background: C.accent, border: 'none', borderRadius: 12, color: '#fff', fontSize: 13, fontWeight: 700, padding: '12px 0', cursor: 'pointer', fontFamily: font, width: '100%' }}
                  >
                    {t('santa_round_start_next', locale, { n: String((currentRoundNumber ?? 1) + 1) })}
                  </button>
                )}

                {/* Force-complete campaign — always visible to owner when ACTIVE */}
                <button
                  onClick={async () => {
                    if (!confirm(t('santa_round_complete_confirm', locale))) return;
                    const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/complete`, {
                      method: 'POST',
                      idempotency: { action: `santa.complete:${camp.id}` },
                    });
                    if (res.ok) {
                      const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                      if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                      pushToast(t('done', locale), 'success');
                    } else pushToast(t('error_generic', locale), 'error');
                  }}
                  style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 12, color: C.textSec, fontSize: 13, fontWeight: 600, padding: '10px 0', cursor: 'pointer', fontFamily: font, width: '100%' }}
                >
                  {t('santa_round_complete_btn', locale)}
                </button>
              </div>
            )}

            {/* (wishlist section moved above — see below giver block) */}

            {/* Chat button + unread badge (Batch 4.1) */}
            {['OPEN', 'LOCKED', 'ACTIVE', 'COMPLETED', 'CANCELLED'].includes(camp.status) && (
              <button
                onClick={async () => {
                  setSantaChatLoading(true);
                  setSantaChatMessages([]);
                  setSantaChatHasMore(false);
                  setSantaChatInput('');
                  setSantaChatIsMuted(currentSantaCampaign.isMuted);
                  setScreen('santa-chat');
                  try {
                    const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/chat?limit=50`);
                    if (res.ok) {
                      const data = await res.json() as { messages: ChatMessage[]; hasMore: boolean; totalUnread: number; isMuted: boolean };
                      // API returns DESC; reverse to show oldest-first
                      setSantaChatMessages([...data.messages].reverse());
                      setSantaChatHasMore(data.hasMore);
                      setSantaChatIsMuted(data.isMuted);
                      // Mark as read if we have messages
                      if (data.messages.length > 0) {
                        const newestId = data.messages[0]!.id;
                        void tgFetch(`/tg/santa/campaigns/${camp.id}/chat/read`, { method: 'POST', body: JSON.stringify({ lastReadMessageId: newestId }) });
                      }
                    }
                  } finally {
                    setSantaChatLoading(false);
                  }
                }}
                style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: '12px 16px', cursor: 'pointer', width: '100%', fontFamily: font, marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 18 }}>💬</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{t('santa_chat_open_btn', locale)}</span>
                </div>
                {currentSantaCampaign.chatUnreadCount > 0 && (
                  <span style={{ minWidth: 20, height: 20, borderRadius: 10, background: C.orange, color: '#000', fontSize: 11, fontWeight: 700, padding: '0 6px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {currentSantaCampaign.chatUnreadCount}
                  </span>
                )}
              </button>
            )}

            {/* Organizer panel button (Batch 5.3) — organizer only */}
            {isOrg && !['DRAFT'].includes(camp.status) && (
              <button
                onClick={async () => {
                  setSantaOrganizerSummary(null);
                  setSantaOrganizerLoading(true);
                  setScreen('santa-organizer');
                  try {
                    const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/organizer/summary`);
                    if (res.ok) setSantaOrganizerSummary(await res.json() as OrganizerSummary);
                  } finally {
                    setSantaOrganizerLoading(false);
                  }
                }}
                style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: '12px 16px', cursor: 'pointer', width: '100%', fontFamily: font, marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 18 }}>🛡</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{t('santa_organizer_open_btn', locale)}</span>
                </div>
                {pendingExitRequestCount > 0 && (
                  <span style={{ minWidth: 20, height: 20, borderRadius: 10, background: C.orange, color: '#000', fontSize: 11, fontWeight: 700, padding: '0 6px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {pendingExitRequestCount}
                  </span>
                )}
              </button>
            )}

            {/* Exclusions button (Batch 5.1) — organizer only, pre-draw statuses */}
            {isOrg && ['DRAFT', 'OPEN', 'LOCKED'].includes(camp.status) && (
              <button
                onClick={async () => {
                  setSantaExclPairs([]);
                  setSantaExclGroups([]);
                  setSantaExclLoading(true);
                  setScreen('santa-exclusions');
                  try {
                    const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/exclusions`);
                    if (res.ok) {
                      const data = await res.json() as { exclusions: ExclusionPair[]; groups: ExclusionGroup[] };
                      setSantaExclPairs(data.exclusions);
                      setSantaExclGroups(data.groups);
                    }
                  } finally {
                    setSantaExclLoading(false);
                  }
                }}
                style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: '12px 16px', cursor: 'pointer', width: '100%', fontFamily: font, marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <span style={{ fontSize: 18 }}>🚫</span>
                <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{t('santa_excl_open_btn', locale)}</span>
                {(santaExclPairs.length + santaExclGroups.length) > 0 && (
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: C.textMuted }}>{santaExclPairs.length + santaExclGroups.length}</span>
                )}
              </button>
            )}

            {/* Polls button (Batch 4.2) — visible for ACTIVE campaigns */}
            {camp.status === 'ACTIVE' && (
              <button
                onClick={async () => {
                  setSantaPolls([]);
                  setSantaPollsLoading(true);
                  setScreen('santa-polls');
                  try {
                    const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/polls`);
                    if (res.ok) {
                      const data = await res.json() as { polls: Poll[] };
                      setSantaPolls(data.polls);
                    }
                  } finally {
                    setSantaPollsLoading(false);
                  }
                }}
                style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: '12px 16px', cursor: 'pointer', width: '100%', fontFamily: font, marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 18 }}>📊</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{t('santa_polls_open_btn', locale)}</span>
                </div>
              </button>
            )}

            {/* Hint item picker sheet (Batch 2.5) — receiver selects 1–3 items for their giver */}
            <BottomSheet
              isOpen={santaHintPickerOpen}
              onClose={() => {
                setSantaHintPickerOpen(false);
                setSantaHintPickerSelectedIds([]);
              }}
              title={t('santa_hint_inbound_select_items', locale)}
            >
              <div>
                <div style={{ fontSize: 13, color: C.textSec, marginBottom: 12 }}>
                  {t('santa_hint_inbound_desc', locale)}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                  {santaHintPickerItems.map(item => {
                    const selected = santaHintPickerSelectedIds.includes(item.id);
                    const maxReached = santaHintPickerSelectedIds.length >= 3 && !selected;
                    return (
                      <button
                        key={item.id}
                        disabled={maxReached}
                        onClick={() => {
                          setSantaHintPickerSelectedIds(prev =>
                            selected ? prev.filter(id => id !== item.id) : [...prev, item.id]
                          );
                        }}
                        style={{
                          background: selected ? `rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.125)` : C.surface,
                          border: `1.5px solid ${selected ? C.accent : C.border}`,
                          borderRadius: 12, padding: '10px 14px', cursor: maxReached ? 'not-allowed' : 'pointer',
                          textAlign: 'start', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          opacity: maxReached ? 0.4 : 1,
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{item.title}</div>
                          {item.priceText && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{item.priceText}</div>}
                        </div>
                        {selected && <span style={{ color: C.accent, fontSize: 18, fontWeight: 700 }}>✓</span>}
                      </button>
                    );
                  })}
                </div>
                <button
                  disabled={santaHintPickerSelectedIds.length === 0 || santaHintFulfillLoading}
                  onClick={async () => {
                    if (!santaHintInbound?.hint) return;
                    setSantaHintFulfillLoading(true);
                    const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/inbound/hint/fulfill`, {
                      method: 'POST',
                      body: JSON.stringify({ hintId: santaHintInbound.hint.id, selectedItemIds: santaHintPickerSelectedIds }),
                      idempotency: { action: `santa.hint.fulfill:${camp.id}:${santaHintInbound.hint.id}` },
                    });
                    if (res.ok) {
                      pushToast(t('santa_hint_inbound_submitted', locale), 'success');
                      setSantaHintInbound({ hasPendingHint: false, hint: { ...santaHintInbound.hint, status: 'FULFILLED' } });
                      setSantaHintPickerOpen(false);
                      setSantaHintPickerSelectedIds([]);
                    } else {
                      const err = await res.json() as { error?: string };
                      if (err.error === 'invalid_items') pushToast(t('santa_items_unavailable', locale), 'error');
                      else pushToast(t('error_generic', locale), 'error');
                    }
                    setSantaHintFulfillLoading(false);
                  }}
                  style={{
                    background: santaHintPickerSelectedIds.length === 0 ? C.border : C.accent,
                    border: 'none', borderRadius: 12, color: '#fff', fontSize: 14, fontWeight: 700,
                    padding: '12px 0', cursor: santaHintPickerSelectedIds.length === 0 ? 'not-allowed' : 'pointer',
                    width: '100%', fontFamily: font,
                  }}
                >
                  {santaHintFulfillLoading
                    ? t('loading', locale)
                    : `${t('santa_hint_inbound_submit', locale)} (${santaHintPickerSelectedIds.length}/3)`}
                </button>
              </div>
            </BottomSheet>

            {/* Wishlist picker sheet */}
            <BottomSheet isOpen={showSantaWishlistPicker} onClose={() => setShowSantaWishlistPicker(false)} title={t('santa_campaign_link_wishlist', locale)}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {wishlists.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '24px 0' }}>
                    <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 16 }}>
                      {t('santa_wishlist_picker_empty', locale)}
                    </div>
                    <button
                      onClick={() => {
                        setSantaWishlistPickerReturnId(camp.id);
                        setShowSantaWishlistPicker(false);
                        setScreen('my-wishlists');
                      }}
                      style={{ background: C.accent, border: 'none', borderRadius: 12, color: '#fff', fontSize: 14, fontWeight: 600, padding: '12px 24px', cursor: 'pointer', fontFamily: font }}
                    >
                      {t('santa_wishlist_picker_create_new', locale)}
                    </button>
                  </div>
                ) : (
                  wishlists.map(wl => (
                    <button
                      key={wl.id}
                      onClick={async () => {
                        setSantaWishlistPickerLoading(true);
                        const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/wishlist`, {
                          method: 'PATCH',
                          body: JSON.stringify({ wishlistId: wl.id }),
                          idempotency: { action: `santa.participant.wishlist:${camp.id}` },
                        });
                        if (res.ok) {
                          const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                          if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                          setShowSantaWishlistPicker(false);
                        } else pushToast(t('error_generic', locale), 'error');
                        setSantaWishlistPickerLoading(false);
                      }}
                      disabled={santaWishlistPickerLoading}
                      style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: '12px 16px', cursor: 'pointer', textAlign: 'start', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                    >
                      <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{wl.title}</span>
                      <span style={{ color: C.textMuted, fontSize: 18 }}>›</span>
                    </button>
                  ))
                )}
              </div>
            </BottomSheet>
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          SECRET SANTA — POLLS (Batch 4.2)
          ══════════════════════════════════════════════ */}
      {screen === 'santa-polls' && currentSantaCampaign && (() => {
        const camp = currentSantaCampaign.campaign;
        const campId = camp.id;
        const isOwner = camp.isOwner;

        const vote = async (pollId: string, optionIndex: number) => {
          const res = await tgFetch(`/tg/santa/campaigns/${campId}/polls/${pollId}/vote`, {
            method: 'POST',
            body: JSON.stringify({ optionIndex }),
            idempotency: { action: `santa.poll.vote:${campId}:${pollId}` },
          });
          if (res.ok) {
            const data = await res.json() as { poll: Poll };
            setSantaPolls(prev => prev.map(p => p.id === pollId ? data.poll : p));
          } else {
            const err = await res.json().catch(() => ({})) as { error?: string };
            if (err.error === 'already_voted') pushToast(t('santa_polls_already_voted', locale), 'info');
          }
        };

        const closePoll = async (pollId: string) => {
          const res = await tgFetch(`/tg/santa/campaigns/${campId}/polls/${pollId}/close`, {
            method: 'POST',
            idempotency: { action: `santa.poll.close:${campId}:${pollId}` },
          });
          if (res.ok) {
            const data = await res.json() as { poll: Poll };
            setSantaPolls(prev => prev.map(p => p.id === pollId ? data.poll : p));
          }
        };

        const createPoll = async () => {
          const opts = santaPollCreateOptions.filter(o => o.trim());
          if (opts.length < 2) { pushToast(t('santa_polls_min_options', locale), 'error'); return; }
          if (!santaPollCreateQuestion.trim()) return;
          setSantaPollCreateSubmitting(true);
          try {
            const res = await tgFetch(`/tg/santa/campaigns/${campId}/polls`, {
              method: 'POST',
              body: JSON.stringify({ question: santaPollCreateQuestion.trim(), options: opts, isAnonymous: santaPollCreateAnonymous }),
              idempotency: { action: `santa.poll.create:${campId}` },
            });
            if (res.ok) {
              const data = await res.json() as { poll: Poll };
              setSantaPolls(prev => [data.poll, ...prev]);
              setSantaPollCreateOpen(false);
              setSantaPollCreateQuestion('');
              setSantaPollCreateOptions(['', '']);
              setSantaPollCreateAnonymous(false);
              pushToast(t('done', locale), 'success');
            }
          } finally {
            setSantaPollCreateSubmitting(false);
          }
        };

        return (
          <div style={{ padding: '16px 20px 120px' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
              <button onClick={navBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: C.accent, fontSize: 22 }}>←</button>
              <h1 style={{ fontSize: 20, fontWeight: 800, fontFamily: font, color: C.text, margin: 0, flex: 1 }}>
                📊 {t('santa_polls_title', locale)}
              </h1>
              {isOwner && (
                <Button
                  variant="primary-gradient"
                  size="sm"
                  fullWidth={false}
                  style={{ padding: '8px 14px', fontSize: 13, minHeight: 0 }}
                  onClick={() => setSantaPollCreateOpen(true)}
                >
                  {t('santa_polls_new', locale)}
                </Button>
              )}
            </div>

            {/* Empty */}
            {!santaPollsLoading && santaPolls.length === 0 && (
              <div style={{ textAlign: 'center', color: C.textSec, fontSize: 14, padding: '40px 0' }}>
                {t('santa_polls_empty', locale)}
              </div>
            )}

            {/* Loading */}
            {santaPollsLoading && (
              <div style={{ textAlign: 'center', color: C.textSec, padding: '40px 0' }}>{t('loading', locale)}</div>
            )}

            {/* Poll list */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {santaPolls.map(poll => {
                const totalVotes = poll.results.reduce((s, r) => s + r.count, 0);
                return (
                  <Card key={poll.id} variant="default" padding="md" style={{ borderRadius: 16 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, flex: 1 }}>{poll.question}</div>
                      <Chip tone={poll.isOpen ? 'success' : 'surface'} size="sm">
                        {poll.isOpen ? t('santa_polls_active', locale) : t('santa_polls_closed', locale)}
                      </Chip>
                    </div>

                    {/* Options */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {poll.options.map((opt, idx) => {
                        const result = poll.results[idx];
                        const isMyVote = poll.myVote === idx;
                        const pct = result?.percentage ?? 0;
                        return (
                          <div key={idx}>
                            <div
                              onClick={() => { if (poll.isOpen && poll.myVote === null) void vote(poll.id, idx); }}
                              style={{ cursor: poll.isOpen && poll.myVote === null ? 'pointer' : 'default', borderRadius: 10, border: `1px solid ${isMyVote ? C.accent : C.border}`, padding: '8px 12px', position: 'relative', overflow: 'hidden', background: C.bg }}
                            >
                              {/* Progress bar */}
                              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, background: isMyVote ? `rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.125)` : `rgba(199, 202, 209, 0.063)`, borderRadius: 10 }} />
                              <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  {isMyVote && <span style={{ color: C.accent, fontSize: 14 }}>✓</span>}
                                  <span style={{ fontSize: 14, color: C.text }}>{opt}</span>
                                </div>
                                <span style={{ fontSize: 12, color: C.textSec, fontWeight: 600 }}>{pct}%</span>
                              </div>
                            </div>
                            {/* Voters (public only) */}
                            {!poll.isAnonymous && result?.voters && result.voters.length > 0 && (
                              <div style={{ fontSize: 11, color: C.textSec, marginTop: 2, paddingLeft: 4 }}>
                                {result.voters.map(v => v.displayName).join(', ')}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Footer */}
                    <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: C.textSec }}>
                        {t('santa_polls_votes_count', locale, { n: String(totalVotes) })}
                        {poll.isAnonymous && <span style={{ marginLeft: 6 }}>· {t('santa_polls_voters_hidden', locale)}</span>}
                      </span>
                      {isOwner && poll.isOpen && (
                        <Button
                          variant="ghost"
                          size="sm"
                          fullWidth={false}
                          onClick={() => void closePoll(poll.id)}
                          style={{ padding: '4px 10px', fontSize: 12, minHeight: 0, color: C.red, border: '1px solid rgba(251,113,133,0.25)' }}
                        >
                          {t('santa_polls_close', locale)}
                        </Button>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>

            {/* Create poll sheet */}
            <BottomSheet isOpen={santaPollCreateOpen} onClose={() => setSantaPollCreateOpen(false)} title={t('santa_polls_new', locale)}>
              <div>
                <div style={{ fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('santa_polls_question', locale)}</div>
                <input
                  value={santaPollCreateQuestion}
                  onChange={e => setSantaPollCreateQuestion(e.target.value)}
                  placeholder={t('santa_polls_question_placeholder', locale)}
                  maxLength={300}
                  style={{ width: '100%', background: `rgba(199, 202, 209, 0.063)`, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', fontSize: 14, color: C.text, fontFamily: font, outline: 'none', boxSizing: 'border-box' }}
                />

                <div style={{ marginTop: 16, marginBottom: 6, fontSize: 13, color: C.textSec }}>Варианты ответов</div>
                {santaPollCreateOptions.map((opt, idx) => (
                  <div key={idx} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <input
                      value={opt}
                      onChange={e => { const arr = [...santaPollCreateOptions]; arr[idx] = e.target.value; setSantaPollCreateOptions(arr); }}
                      placeholder={t('santa_polls_option_placeholder', locale, { n: String(idx + 1) })}
                      maxLength={100}
                      style={{ flex: 1, background: `rgba(199, 202, 209, 0.063)`, border: `1px solid ${C.border}`, borderRadius: 10, padding: '8px 12px', fontSize: 14, color: C.text, fontFamily: font, outline: 'none' }}
                    />
                    {santaPollCreateOptions.length > 2 && (
                      <button onClick={() => setSantaPollCreateOptions(prev => prev.filter((_, i) => i !== idx))} style={{ background: 'none', border: 'none', color: C.red, cursor: 'pointer', fontSize: 18, padding: '0 4px' }}>×</button>
                    )}
                  </div>
                ))}
                {santaPollCreateOptions.length < 10 && (
                  <button onClick={() => setSantaPollCreateOptions(prev => [...prev, ''])} style={{ background: 'none', border: 'none', color: C.accent, fontSize: 13, cursor: 'pointer', padding: '4px 0', fontFamily: font }}>
                    {t('santa_polls_add_option', locale)}
                  </button>
                )}

                <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <input type="checkbox" checked={santaPollCreateAnonymous} onChange={e => setSantaPollCreateAnonymous(e.target.checked)} id="anon-toggle" />
                  <label htmlFor="anon-toggle" style={{ fontSize: 14, color: C.text, cursor: 'pointer' }}>{t('santa_polls_anonymous', locale)}</label>
                </div>

                <button
                  onClick={() => void createPoll()}
                  disabled={santaPollCreateSubmitting}
                  style={{ marginTop: 20, background: C.accent, border: 'none', borderRadius: 12, padding: '13px 0', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', width: '100%', fontFamily: font, opacity: santaPollCreateSubmitting ? 0.6 : 1 }}
                >
                  {santaPollCreateSubmitting ? t('loading', locale) : t('santa_polls_create', locale)}
                </button>
              </div>
            </BottomSheet>
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          SECRET SANTA — RECEIVER WISHLIST SCREEN
          (Santa-safe, giver can reserve/unreserve items,
           no receiver identity exposed)
          ══════════════════════════════════════════════ */}
      {screen === 'santa-receiver-wishlist' && currentSantaCampaign && (() => {
        const camp = currentSantaCampaign.campaign;
        const wl = santaReceiverWishlist;
        const giftStatusTerminal = ['SENT', 'RECEIVED'].includes(wl?.giftStatus ?? '');
        const isReadOnly = camp.status !== 'ACTIVE' || giftStatusTerminal;

        const handleReserve = async (itemId: string) => {
          if (isReadOnly) return;
          setSantaWishlistReservingId(itemId);
          try {
            const r = await tgFetch(`/tg/santa/campaigns/${camp.id}/inbound/reserve`, {
              method: 'POST',
              body: JSON.stringify({ itemId }),
              idempotency: { action: `santa.inbound.reserve:${camp.id}:${itemId}` },
            });
            if (r.ok) {
              const data = await r.json() as { myReservations: { id: string; title: string }[] };
              setSantaReceiverWishlist(prev => prev ? {
                ...prev,
                myReservations: data.myReservations,
                items: prev.items.map(it => ({ ...it, reservedByMe: data.myReservations.some(rv => rv.id === it.id) })),
              } : prev);
              // Update parent campaign detail reservedItems
              setCurrentSantaCampaign(prev => prev && prev.myAssignment ? {
                ...prev,
                myAssignment: { ...prev.myAssignment, reservedItems: data.myReservations, giftStatus: 'SELECTED_FROM_WISHLIST' },
              } : prev);
            } else {
              const errBody = await r.json().catch(() => ({})) as { error?: string; message?: string };
              console.error('[reserve] failed', r.status, errBody);
              pushToast(errBody.message || errBody.error || t('toast_error_generic', locale), 'error');
            }
          } catch (err) {
            console.error('[reserve] fetch error', err);
            pushToast(t('toast_error_generic', locale), 'error');
          } finally {
            setSantaWishlistReservingId(null);
          }
        };

        const handleUnreserve = async (itemId: string) => {
          if (isReadOnly) return;
          setSantaWishlistReservingId(itemId);
          try {
            const r = await tgFetch(`/tg/santa/campaigns/${camp.id}/inbound/reserve/${itemId}`, {
              method: 'DELETE',
              idempotency: { action: `santa.inbound.unreserve:${camp.id}:${itemId}` },
            });
            if (r.ok) {
              const data = await r.json() as { myReservations: { id: string; title: string }[] };
              setSantaReceiverWishlist(prev => prev ? {
                ...prev,
                myReservations: data.myReservations,
                items: prev.items.map(it => ({ ...it, reservedByMe: data.myReservations.some(rv => rv.id === it.id) })),
              } : prev);
              // Update parent campaign detail
              setCurrentSantaCampaign(prev => prev && prev.myAssignment ? {
                ...prev,
                myAssignment: {
                  ...prev.myAssignment,
                  reservedItems: data.myReservations,
                  giftStatus: data.myReservations.length === 0 ? 'PENDING' : prev.myAssignment.giftStatus,
                },
              } : prev);
            } else {
              const errBody = await r.json().catch(() => ({})) as { error?: string; message?: string };
              console.error('[unreserve] failed', r.status, errBody);
              pushToast(errBody.message || errBody.error || t('toast_error_generic', locale), 'error');
            }
          } catch (err) {
            console.error('[unreserve] fetch error', err);
            pushToast(t('toast_error_generic', locale), 'error');
          } finally {
            setSantaWishlistReservingId(null);
          }
        };

        return (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg }}>
            {/* Header */}
            <div style={{ padding: '16px 20px 8px', borderBottom: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: C.text }}>
                {t('santa_wishlist_screen_title', locale)}
              </div>
              {wl?.wishlist?.title && (
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>{wl.wishlist.title}</div>
              )}
            </div>

            {/* Reserved summary banner */}
            {(wl?.myReservations?.length ?? 0) > 0 && (
              <div style={{ background: C.accentSoft, padding: '10px 20px', borderBottom: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 13, color: C.accent, fontWeight: 600 }}>
                  {(wl!.myReservations.length === 1)
                    ? t('santa_wishlist_my_reservations_one', locale).replace('{{title}}', wl!.myReservations[0]?.title ?? '')
                    : t('santa_wishlist_my_reservations_many', locale).replace('{{n}}', String(wl!.myReservations.length))}
                </div>
              </div>
            )}

            {/* Read-only banner for terminal gift status */}
            {giftStatusTerminal && (
              <div style={{ background: C.surface, padding: '10px 20px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 15 }}>🔒</span>
                <div style={{ fontSize: 13, color: C.textMuted }}>
                  {t('santa_wishlist_read_only_sent', locale)}
                </div>
              </div>
            )}

            {/* Items list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
              {!wl || wl.items.length === 0 ? (
                <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 14, marginTop: 40 }}>
                  {t('santa_wishlist_empty', locale)}
                </div>
              ) : (
                wl.items.map(item => {
                  const reservedByMe = item.reservedByMe;
                  const reservedByOther = item.status === 'RESERVED' && !reservedByMe;
                  const isReserving = santaWishlistReservingId === item.id;

                  return (
                    <div key={item.id}
                      style={{
                        background: C.card, borderRadius: 12, padding: '12px 14px', marginBottom: 10,
                        border: reservedByMe ? `2px solid ${C.accent}` : `1px solid ${C.border}`,
                        opacity: reservedByOther ? 0.6 : 1,
                        cursor: 'pointer',
                      }}
                      onClick={() => {
                        setSantaDetailContext({
                          source: 'receiver-wishlist',
                          campaignId: camp.id,
                          campaignTitle: camp.title,
                          campaignStatus: camp.status,
                          giftStatus: wl?.giftStatus ?? '',
                        });
                        setViewingItem({
                          id: item.id,
                          title: item.title,
                          description: null,
                          url: item.url,
                          price: null,
                          imageUrl: item.imageUrl,
                          priority: (item.priority as 1 | 2 | 3) ?? 2,
                          position: 0,
                          // Santa reservations live in SantaItemReservation, not Item.status.
                          // Force 'reserved' when reservedByMe so getSantaItemReservationState
                          // correctly returns 'reserved-by-me' instead of 'available'.
                          status: reservedByMe ? 'reserved' : item.status.toLowerCase() as GuestItem['status'],
                          currency: (item.currency as GuestItem['currency']) ?? 'RUB',
                          reservedByDisplayName: null,
                          reservedByActorHash: reservedByMe ? myActorHashRef.current : null,
                        } as GuestItem);
                        setScreen('guest-item-detail');
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                        {/* Item image */}
                        {item.imageUrl && (
                          <img src={item.imageUrl} alt="" loading="lazy" decoding="async" style={{ width: 52, height: 52, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 2 }}>{item.title}</div>
                          {item.priceText && (
                            <div style={{ fontSize: 12, color: C.textMuted }}>{item.priceText}</div>
                          )}
                          {reservedByMe && (
                            <div style={{ fontSize: 11, color: C.accent, fontWeight: 600, marginTop: 4 }}>
                              ✓ {t('santa_wishlist_reserved_by_me', locale)}
                            </div>
                          )}
                          {reservedByOther && (
                            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
                              🔒 {t('santa_wishlist_reserved_by_other', locale)}
                            </div>
                          )}
                        </div>
                        {/* Action button */}
                        {!isReadOnly && !reservedByOther && (
                          <button
                            disabled={isReserving}
                            onClick={(e) => { e.stopPropagation(); void (reservedByMe ? handleSantaReceiverUnreserve(item.id) : handleSantaReceiverReserve(item.id)); }}
                            style={{
                              flexShrink: 0,
                              background: reservedByMe ? C.surface : C.accent,
                              color: reservedByMe ? C.textSec : '#fff',
                              border: reservedByMe ? `1px solid ${C.border}` : 'none',
                              borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600,
                              cursor: isReserving ? 'wait' : 'pointer', fontFamily: font,
                              opacity: isReserving ? 0.6 : 1,
                            }}
                          >
                            {isReserving ? '…' : reservedByMe ? t('santa_wishlist_unreserve', locale) : t('santa_wishlist_reserve', locale)}
                          </button>
                        )}
                        {/* Open link */}
                        {item.url && (
                          <a
                            href={item.url} target="_blank" rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            style={{ flexShrink: 0, fontSize: 11, color: C.accent, textDecoration: 'none', padding: '6px 0' }}
                          >
                            🔗
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          SECRET SANTA — CHAT (Batch 4.1)
          ══════════════════════════════════════════════ */}
      {screen === 'santa-chat' && currentSantaCampaign && (() => {
        const camp = currentSantaCampaign.campaign;
        const campId = camp.id;
        const isReadOnly = ['COMPLETED', 'CANCELLED'].includes(camp.status);

        // Render system message body from systemEvent + payload
        const renderSystemMsg = (msg: { systemEvent: string | null; payload: Record<string, string> | null }): string => {
          const name = msg.payload?.displayName ?? '';
          switch (msg.systemEvent) {
            case 'participant_joined': return t('santa_chat_system_joined', locale, { name });
            case 'participant_left': return t('santa_chat_system_left', locale, { name });
            case 'participant_removed': return t('santa_chat_system_removed', locale, { name });
            case 'draw_done': return t('santa_chat_system_draw_done', locale);
            case 'campaign_cancelled': return t('santa_chat_system_cancelled', locale);
            case 'campaign_completed': return t('santa_chat_system_completed', locale);
            default: return msg.systemEvent ?? '';
          }
        };

        const loadEarlier = async () => {
          if (!santaChatHasMore || santaChatLoading) return;
          const oldest = santaChatMessages[0];
          if (!oldest) return;
          setSantaChatLoading(true);
          try {
            const res = await tgFetch(`/tg/santa/campaigns/${campId}/chat?limit=50&before=${oldest.id}`);
            if (res.ok) {
              const data = await res.json() as { messages: ChatMessage[]; hasMore: boolean };
              const reversed = [...data.messages].reverse();
              setSantaChatMessages(prev => [...reversed, ...prev]);
              setSantaChatHasMore(data.hasMore);
            }
          } finally {
            setSantaChatLoading(false);
          }
        };

        const sendMessage = async () => {
          if (!santaChatInput.trim() || santaChatSending || isReadOnly) return;
          if (santaChatInput.length > 1000) { pushToast(t('santa_chat_message_too_long', locale), 'error'); return; }
          const body = santaChatInput.trim();
          setSantaChatInput('');
          setSantaChatSending(true);
          // Mint a per-message nonce on the first attempt; reuse it across
          // retries of the same message so the server can replay instead of
          // double-posting. Cleared after a successful send so the next
          // message mints a fresh nonce.
          if (!santaChatSendNonceRef.current) {
            santaChatSendNonceRef.current = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          }
          const sendNonce = santaChatSendNonceRef.current;
          try {
            const res = await tgFetch(`/tg/santa/campaigns/${campId}/chat`, {
              method: 'POST',
              body: JSON.stringify({ body }),
              idempotency: { action: `santa.chat.send:${campId}:${sendNonce}` },
            });
            if (res.ok) {
              santaChatSendNonceRef.current = '';
              const data = await res.json() as { message: ChatMessage };
              setSantaChatMessages(prev => [...prev, data.message]);
              // Mark self as read
              void tgFetch(`/tg/santa/campaigns/${campId}/chat/read`, { method: 'POST', body: JSON.stringify({ lastReadMessageId: data.message.id }) });
            } else {
              pushToast(t('santa_chat_send_error', locale), 'error');
              setSantaChatInput(body); // restore input on failure
            }
          } catch {
            pushToast(t('santa_chat_send_error', locale), 'error');
            setSantaChatInput(body);
          } finally {
            setSantaChatSending(false);
          }
        };

        const toggleMute = async () => {
          const method = santaChatIsMuted ? 'DELETE' : 'POST';
          const action = santaChatIsMuted ? `santa.unmute:${campId}` : `santa.mute:${campId}`;
          const res = await tgFetch(`/tg/santa/campaigns/${campId}/mute`, {
            method,
            idempotency: { action },
          });
          if (res.ok) {
            setSantaChatIsMuted(!santaChatIsMuted);
            // update campaign detail isMuted
            setCurrentSantaCampaign(prev => prev ? { ...prev, isMuted: !santaChatIsMuted } : prev);
          }
        };

        return (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: C.bg }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: C.card, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
              <button onClick={navBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: C.accent, fontSize: 22 }}>←</button>
              <div style={{ flex: 1, fontSize: 15, fontWeight: 700, color: C.text, fontFamily: font, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {camp.title}
              </div>
              <button
                onClick={toggleMute}
                title={santaChatIsMuted ? t('santa_chat_unmute', locale) : t('santa_chat_mute', locale)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, opacity: isReadOnly ? 0.4 : 1 }}
              >
                {santaChatIsMuted ? '🔕' : '🔔'}
              </button>
            </div>

            {/* Messages area */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* Load earlier */}
              {santaChatHasMore && (
                <button
                  onClick={loadEarlier}
                  disabled={santaChatLoading}
                  style={{ background: 'none', border: 'none', color: C.accent, fontSize: 13, cursor: 'pointer', padding: '4px 0', alignSelf: 'center', fontFamily: font }}
                >
                  {santaChatLoading ? t('loading', locale) : t('santa_chat_load_earlier', locale)}
                </button>
              )}

              {/* Empty state */}
              {santaChatMessages.length === 0 && !santaChatLoading && (
                <div style={{ textAlign: 'center', color: C.textSec, fontSize: 14, padding: '40px 0' }}>
                  {t('santa_chat_empty', locale)}
                </div>
              )}

              {/* Messages */}
              {santaChatMessages.map(msg => {
                if (msg.messageType === 'SYSTEM') {
                  return (
                    <div key={msg.id} style={{ display: 'flex', justifyContent: 'center', margin: '4px 0' }}>
                      <div style={{ background: `rgba(199, 202, 209, 0.125)`, borderRadius: 12, padding: '4px 12px', fontSize: 12, color: C.textSec, textAlign: 'center', maxWidth: '80%' }}>
                        {renderSystemMsg(msg)}
                      </div>
                    </div>
                  );
                }
                const isMe = msg.sender?.isMe ?? false;
                return (
                  <div key={msg.id} style={{ display: 'flex', flexDirection: isMe ? 'row-reverse' : 'row', gap: 8, alignItems: 'flex-end' }}>
                    {/* Avatar (only for others) */}
                    {!isMe && (
                      <SantaAvatar
                        alias={msg.sender?.displayName ?? '?'}
                        emoji={msg.sender?.emoji ?? '🎅'}
                        size={28}
                        hat={santaSeason?.inSeason}
                      />
                    )}
                    <div style={{ maxWidth: '70%' }}>
                      {!isMe && (
                        <div style={{ fontSize: 11, color: C.textSec, marginBottom: 2, fontWeight: 600 }}>
                          {msg.sender?.adjectiveKey && msg.sender?.animalKey
                            ? renderSantaAlias(msg.sender.adjectiveKey, msg.sender.animalKey, locale)
                            : msg.sender?.displayName}
                        </div>
                      )}
                      <div style={{ background: isMe ? C.accent : C.card, color: isMe ? '#fff' : C.text, borderRadius: isMe ? '16px 16px 4px 16px' : '16px 16px 16px 4px', padding: '8px 12px', fontSize: 14, lineHeight: 1.4, wordBreak: 'break-word' }}>
                        {msg.body}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Read-only notice */}
            {isReadOnly && (
              <div style={{ background: `rgba(199, 202, 209, 0.082)`, padding: '8px 16px', textAlign: 'center', fontSize: 12, color: C.textSec, flexShrink: 0 }}>
                {camp.status === 'COMPLETED' ? t('santa_chat_read_only_completed', locale) : t('santa_chat_read_only_cancelled', locale)}
              </div>
            )}

            {/* Input bar */}
            {!isReadOnly && (
              <div style={{ display: 'flex', gap: 8, padding: '10px 16px', background: C.card, borderTop: `1px solid ${C.border}`, flexShrink: 0 }}>
                <input
                  value={santaChatInput}
                  onChange={e => setSantaChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(); } }}
                  placeholder={t('santa_chat_input_placeholder', locale)}
                  maxLength={1000}
                  style={{ flex: 1, background: `rgba(199, 202, 209, 0.063)`, border: `1px solid ${C.border}`, borderRadius: 20, padding: '8px 14px', fontSize: 14, color: C.text, fontFamily: font, outline: 'none' }}
                />
                <button
                  onClick={() => void sendMessage()}
                  disabled={!santaChatInput.trim() || santaChatSending}
                  style={{ background: C.accent, border: 'none', borderRadius: 20, padding: '8px 16px', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: font, opacity: (!santaChatInput.trim() || santaChatSending) ? 0.5 : 1, flexShrink: 0 }}
                >
                  {santaChatSending ? '…' : t('santa_chat_send', locale)}
                </button>
              </div>
            )}
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          SECRET SANTA — EXCLUSIONS (Batch 5.1)
          ══════════════════════════════════════════════ */}
      {screen === 'santa-exclusions' && currentSantaCampaign && (() => {
        const camp = currentSantaCampaign.campaign;
        const campId = camp.id;
        const joinedParticipants = currentSantaCampaign.participants.filter(p => p.status === 'JOINED');
        const isPro = planInfo.code === 'PRO';

        const reloadExclusions = async () => {
          const res = await tgFetch(`/tg/santa/campaigns/${campId}/exclusions`);
          if (res.ok) {
            const data = await res.json() as { exclusions: ExclusionPair[]; groups: ExclusionGroup[] };
            setSantaExclPairs(data.exclusions);
            setSantaExclGroups(data.groups);
          }
        };

        const addPair = async () => {
          if (!santaExclPairA || !santaExclPairB || santaExclPairA === santaExclPairB) return;
          setSantaExclPairSaving(true);
          try {
            const res = await tgFetch(`/tg/santa/campaigns/${campId}/exclusions`, {
              method: 'POST',
              body: JSON.stringify({ userId1: santaExclPairA, userId2: santaExclPairB }),
              idempotency: { action: `santa.exclusion.create:${campId}` },
            });
            if (res.ok) {
              setSantaExclAddPairOpen(false);
              setSantaExclPairA('');
              setSantaExclPairB('');
              await reloadExclusions();
              pushToast(t('done', locale), 'success');
            } else {
              // santa_exclusions is PRO-gated → 402. Route to upsell when
              // the envelope matches; otherwise show a localized message.
              const body = await res.json().catch(() => null);
              const parsed = parsePaywallError(res.status, body);
              const ctx = paywallContextFromError(parsed);
              if (ctx) {
                setSantaExclAddPairOpen(false);
                showUpsell(ctx, { auto: true });
                return;
              }
              pushToast(parsed?.message ?? t('error_generic', locale), 'error');
            }
          } finally {
            setSantaExclPairSaving(false);
          }
        };

        const deletePair = async (id: string) => {
          const res = await tgFetch(`/tg/santa/campaigns/${campId}/exclusions/${id}`, {
            method: 'DELETE',
            idempotency: { action: `santa.exclusion.delete:${campId}:${id}` },
          });
          if (res.ok) {
            setSantaExclPairs(prev => prev.filter(p => p.id !== id));
          } else pushToast(t('error_generic', locale), 'error');
        };

        const createGroup = async () => {
          if (!santaExclGroupLabel.trim()) return;
          setSantaExclGroupSaving(true);
          try {
            const res = await tgFetch(`/tg/santa/campaigns/${campId}/exclusions/groups`, {
              method: 'POST',
              body: JSON.stringify({ label: santaExclGroupLabel.trim() }),
              idempotency: { action: `santa.exclusion.group.create:${campId}` },
            });
            if (res.ok) {
              setSantaExclGroupSheetOpen(false);
              setSantaExclGroupLabel('');
              await reloadExclusions();
              pushToast(t('done', locale), 'success');
            } else pushToast(t('error_generic', locale), 'error');
          } finally {
            setSantaExclGroupSaving(false);
          }
        };

        const deleteGroup = async (groupId: string, label: string) => {
          if (!confirm(t('santa_excl_delete_group_confirm', locale, { label }))) return;
          const res = await tgFetch(`/tg/santa/campaigns/${campId}/exclusions/groups/${groupId}`, {
            method: 'DELETE',
            idempotency: { action: `santa.exclusion.group.delete:${campId}:${groupId}` },
          });
          if (res.ok) {
            setSantaExclGroups(prev => prev.filter(g => g.id !== groupId));
          } else pushToast(t('error_generic', locale), 'error');
        };

        const addMember = async () => {
          if (!santaExclAddMemberGroupId || !santaExclAddMemberUserId) return;
          setSantaExclAddMemberSaving(true);
          try {
            const res = await tgFetch(`/tg/santa/campaigns/${campId}/exclusions/groups/${santaExclAddMemberGroupId}/members`, {
              method: 'POST',
              body: JSON.stringify({ userId: santaExclAddMemberUserId }),
              idempotency: { action: `santa.exclusion.group.member.add:${campId}:${santaExclAddMemberGroupId}:${santaExclAddMemberUserId}` },
            });
            if (res.ok) {
              setSantaExclAddMemberGroupId(null);
              setSantaExclAddMemberUserId('');
              await reloadExclusions();
              pushToast(t('done', locale), 'success');
            } else {
              const err = await res.json() as { error?: string };
              pushToast(err.error ?? t('error_generic', locale), 'error');
            }
          } finally {
            setSantaExclAddMemberSaving(false);
          }
        };

        const removeMember = async (groupId: string, userId: string) => {
          const res = await tgFetch(`/tg/santa/campaigns/${campId}/exclusions/groups/${groupId}/members/${userId}`, {
            method: 'DELETE',
            idempotency: { action: `santa.exclusion.group.member.remove:${campId}:${groupId}:${userId}` },
          });
          if (res.ok) {
            setSantaExclGroups(prev => prev.map(g => g.id === groupId
              ? { ...g, members: g.members.filter(m => m.userId !== userId) }
              : g
            ));
          } else pushToast(t('error_generic', locale), 'error');
        };

        return (
          <div style={{ padding: '16px 20px 120px' }}>
            <h1 style={{ fontSize: 26, fontWeight: 700, fontFamily: font, color: 'var(--wb-text)', letterSpacing: '-0.035em', lineHeight: 1.05, margin: '8px 0 20px' }}>
              🚫 {t('santa_excl_title', locale)}
            </h1>

            {santaExclLoading && (
              <div style={{ color: C.textMuted, fontSize: 14, textAlign: 'center', padding: 40 }}>{t('loading', locale)}</div>
            )}

            {!santaExclLoading && (
              <>
                {/* Individual pairs section */}
                <div style={{ marginBottom: 24 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
                    {t('santa_excl_pairs_section', locale)}
                  </div>

                  {santaExclPairs.length === 0 && (
                    <div style={{ fontSize: 13, color: C.textMuted, padding: '12px 0' }}>{t('santa_excl_empty', locale)}</div>
                  )}

                  {santaExclPairs.map(pair => (
                    <div key={pair.id} style={{ background: C.card, borderRadius: 12, padding: '10px 14px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 14, color: C.text }}>
                        {pair.name1} — {pair.name2}
                      </span>
                      <button
                        onClick={() => void deletePair(pair.id)}
                        style={{ background: 'none', border: 'none', color: C.red, fontSize: 18, cursor: 'pointer', padding: '0 4px', lineHeight: 1 }}
                      >×</button>
                    </div>
                  ))}

                  {isPro ? (
                    <button
                      onClick={() => setSantaExclAddPairOpen(true)}
                      style={{ background: 'none', border: `1px dashed ${C.accent}`, borderRadius: 12, color: C.accent, fontSize: 13, fontWeight: 600, padding: '10px 14px', cursor: 'pointer', width: '100%', fontFamily: font, marginTop: 4 }}
                    >
                      {t('santa_excl_add_pair', locale)}
                    </button>
                  ) : (
                    <button
                      onClick={() => showUpsell('santa_exclusions')}
                      style={{ display: 'block', width: '100%', textAlign: 'left', background: `rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.063)`, border: 'none', borderRadius: 12, padding: '10px 14px', fontSize: 13, color: C.accent, marginTop: 4, cursor: 'pointer', fontFamily: font }}
                    >
                      🔒 {t('santa_excl_pairs_pro_hint', locale)}
                    </button>
                  )}
                </div>

                {/* Groups section */}
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
                    {t('santa_excl_groups_section', locale)}
                  </div>

                  {santaExclGroups.length === 0 && (
                    <div style={{ fontSize: 13, color: C.textMuted, padding: '12px 0' }}>{t('santa_excl_groups_empty', locale)}</div>
                  )}

                  {santaExclGroups.map(group => (
                    <div key={group.id} style={{ background: C.card, borderRadius: 12, padding: '12px 14px', marginBottom: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{group.label}</span>
                        <button
                          onClick={() => void deleteGroup(group.id, group.label)}
                          style={{ background: 'none', border: 'none', color: C.red, fontSize: 13, cursor: 'pointer', padding: '0 4px' }}
                        >
                          {t('delete', locale)}
                        </button>
                      </div>

                      {/* Warn if fewer than 2 active members — group has no draw effect */}
                      {group.activeCount < 2 && (
                        <div style={{ fontSize: 11, color: C.orange ?? C.textMuted, marginBottom: 6 }}>
                          ⚠️ {t('santa_group_min_warning', locale)}
                        </div>
                      )}

                      {group.members.map(member => {
                        const name = member.adjectiveKey && member.animalKey
                          ? renderSantaAlias(member.adjectiveKey, member.animalKey, locale)
                          : member.displayName || member.userId;
                        return (
                          <div key={member.userId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', opacity: member.isStale ? 0.45 : 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <SantaAvatar alias={name} emoji={member.emoji ?? '🎅'} size={24} hat={santaSeason?.inSeason} />
                              <span style={{ fontSize: 13, color: member.isStale ? C.textMuted : C.textSec }}>
                                {name}{member.isStale ? t('member_status_left', locale) : ''}
                              </span>
                            </div>
                            <button
                              onClick={() => void removeMember(group.id, member.userId)}
                              style={{ background: 'none', border: 'none', color: C.red, fontSize: 16, cursor: 'pointer', padding: '0 4px' }}
                            >×</button>
                          </div>
                        );
                      })}

                      {isPro && (
                        <button
                          onClick={() => { setSantaExclAddMemberGroupId(group.id); setSantaExclAddMemberUserId(''); }}
                          style={{ background: 'none', border: 'none', color: C.accent, fontSize: 13, cursor: 'pointer', padding: '6px 0 0', fontFamily: font }}
                        >
                          + {t('santa_excl_member_add', locale)}
                        </button>
                      )}
                    </div>
                  ))}

                  {isPro ? (
                    <button
                      onClick={() => { setSantaExclGroupLabel(''); setSantaExclGroupSheetOpen(true); }}
                      style={{ background: 'none', border: `1px dashed ${C.accent}`, borderRadius: 12, color: C.accent, fontSize: 13, fontWeight: 600, padding: '10px 14px', cursor: 'pointer', width: '100%', fontFamily: font, marginTop: 4 }}
                    >
                      {t('santa_excl_add_group', locale)}
                    </button>
                  ) : (
                    santaExclGroups.length === 0 && (
                      <button
                        onClick={() => showUpsell('santa_exclusion_groups')}
                        style={{ display: 'block', width: '100%', textAlign: 'left', background: `rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.063)`, border: 'none', borderRadius: 12, padding: '10px 14px', fontSize: 13, color: C.accent, marginTop: 4, cursor: 'pointer', fontFamily: font }}
                      >
                        🔒 {t('santa_excl_groups_pro_hint', locale)}
                      </button>
                    )
                  )}
                </div>
              </>
            )}

            {/* Add pair sheet */}
            <BottomSheet isOpen={santaExclAddPairOpen} onClose={() => setSantaExclAddPairOpen(false)} title={t('santa_excl_add_pair', locale)}>
              <div>
                <div style={{ fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('santa_excl_select_a', locale)}</div>
                <select
                  value={santaExclPairA}
                  onChange={e => setSantaExclPairA(e.target.value)}
                  style={{ width: '100%', background: `rgba(199, 202, 209, 0.063)`, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', fontSize: 14, color: C.text, fontFamily: font, outline: 'none', boxSizing: 'border-box', marginBottom: 12 }}
                >
                  <option value="">—</option>
                  {joinedParticipants.map(p => (
                    <option key={p.userId} value={p.userId}>{p.displayName || p.userId}</option>
                  ))}
                </select>

                <div style={{ fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('santa_excl_select_b', locale)}</div>
                <select
                  value={santaExclPairB}
                  onChange={e => setSantaExclPairB(e.target.value)}
                  style={{ width: '100%', background: `rgba(199, 202, 209, 0.063)`, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', fontSize: 14, color: C.text, fontFamily: font, outline: 'none', boxSizing: 'border-box', marginBottom: 16 }}
                >
                  <option value="">—</option>
                  {joinedParticipants.filter(p => p.userId !== santaExclPairA).map(p => (
                    <option key={p.userId} value={p.userId}>{p.displayName || p.userId}</option>
                  ))}
                </select>

                {santaExclPairA && santaExclPairB && (
                  <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 12 }}>
                    {t('santa_excl_pair_conflict', locale, {
                      name1: joinedParticipants.find(p => p.userId === santaExclPairA)?.displayName ?? santaExclPairA,
                      name2: joinedParticipants.find(p => p.userId === santaExclPairB)?.displayName ?? santaExclPairB,
                    })}
                  </div>
                )}

                <button
                  onClick={() => void addPair()}
                  disabled={!santaExclPairA || !santaExclPairB || santaExclPairA === santaExclPairB || santaExclPairSaving}
                  style={{ background: C.accent, border: 'none', borderRadius: 12, padding: '13px 0', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', width: '100%', fontFamily: font, opacity: (!santaExclPairA || !santaExclPairB || santaExclPairA === santaExclPairB || santaExclPairSaving) ? 0.5 : 1 }}
                >
                  {santaExclPairSaving ? t('loading', locale) : t('santa_excl_confirm_add', locale)}
                </button>
              </div>
            </BottomSheet>

            {/* Create group sheet */}
            <BottomSheet isOpen={santaExclGroupSheetOpen} onClose={() => setSantaExclGroupSheetOpen(false)} title={t('santa_excl_add_group', locale)}>
              <div>
                <div style={{ fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('santa_excl_group_label', locale)}</div>
                <input
                  value={santaExclGroupLabel}
                  onChange={e => setSantaExclGroupLabel(e.target.value)}
                  placeholder={t('santa_excl_group_label_placeholder', locale)}
                  maxLength={80}
                  style={{ width: '100%', background: `rgba(199, 202, 209, 0.063)`, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', fontSize: 14, color: C.text, fontFamily: font, outline: 'none', boxSizing: 'border-box', marginBottom: 16 }}
                />
                <button
                  onClick={() => void createGroup()}
                  disabled={!santaExclGroupLabel.trim() || santaExclGroupSaving}
                  style={{ background: C.accent, border: 'none', borderRadius: 12, padding: '13px 0', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', width: '100%', fontFamily: font, opacity: (!santaExclGroupLabel.trim() || santaExclGroupSaving) ? 0.5 : 1 }}
                >
                  {santaExclGroupSaving ? t('loading', locale) : t('santa_excl_confirm_add', locale)}
                </button>
              </div>
            </BottomSheet>

            {/* Add member to group sheet */}
            <BottomSheet isOpen={santaExclAddMemberGroupId !== null} onClose={() => { setSantaExclAddMemberGroupId(null); setSantaExclAddMemberUserId(''); }} title={t('santa_excl_add_members', locale)}>
              {santaExclAddMemberGroupId && (() => {
                const group = santaExclGroups.find(g => g.id === santaExclAddMemberGroupId);
                const alreadyInGroup = new Set(group?.members.map(m => m.userId) ?? []);
                const available = joinedParticipants.filter(p => !alreadyInGroup.has(p.userId));
                return (
                  <div>
                    {available.length === 0 ? (
                      <div style={{ fontSize: 14, color: C.textMuted, textAlign: 'center', padding: '20px 0' }}>
                        {t('santa_all_participants_in_group', locale)}
                      </div>
                    ) : (
                      <>
                        <select
                          value={santaExclAddMemberUserId}
                          onChange={e => setSantaExclAddMemberUserId(e.target.value)}
                          style={{ width: '100%', background: `rgba(199, 202, 209, 0.063)`, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', fontSize: 14, color: C.text, fontFamily: font, outline: 'none', boxSizing: 'border-box', marginBottom: 16 }}
                        >
                          <option value="">—</option>
                          {available.map(p => (
                            <option key={p.userId} value={p.userId}>{p.displayName || p.userId}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => void addMember()}
                          disabled={!santaExclAddMemberUserId || santaExclAddMemberSaving}
                          style={{ background: C.accent, border: 'none', borderRadius: 12, padding: '13px 0', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', width: '100%', fontFamily: font, opacity: (!santaExclAddMemberUserId || santaExclAddMemberSaving) ? 0.5 : 1 }}
                        >
                          {santaExclAddMemberSaving ? t('loading', locale) : t('santa_excl_member_add', locale)}
                        </button>
                      </>
                    )}
                  </div>
                );
              })()}
            </BottomSheet>
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          SECRET SANTA — ORGANIZER PANEL (Batch 5.3)
          ══════════════════════════════════════════════ */}
      {screen === 'santa-organizer' && currentSantaCampaign && (() => {
        const camp = currentSantaCampaign.campaign;
        const campId = camp.id;
        const campIsOwner = camp.isOwner;   // approve/deny are owner-only even in organizer screen
        const summary = santaOrganizerSummary;

        return (
          <div style={{ padding: '16px 20px 120px' }}>
            <h1 style={{ fontSize: 20, fontWeight: 800, fontFamily: font, color: C.text, margin: '8px 0 4px' }}>
              🛡 {t('santa_organizer_title', locale)}
            </h1>
            <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 20 }}>{camp.title}</div>

            {santaOrganizerLoading && (
              <div style={{ fontSize: 14, color: C.textMuted, textAlign: 'center', marginTop: 40 }}>{t('loading', locale)}</div>
            )}

            {summary && !santaOrganizerLoading && (
              <>
                {/* Pending exit requests */}
                {summary.pendingExitRequests.length > 0 && (
                  <div style={{ background: C.card, borderRadius: 14, padding: 16, marginBottom: 16 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, marginBottom: 10 }}>
                      {t('santa_organizer_exit_requests', locale, { n: String(summary.pendingExitRequests.length) })}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {summary.pendingExitRequests.map(req => {
                        const reqAlias = req.adjectiveKey && req.animalKey
                          ? renderSantaAlias(req.adjectiveKey, req.animalKey, locale)
                          : req.displayName;
                        return (
                        <div key={req.id} style={{ background: C.surface, borderRadius: 10, padding: '10px 12px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                            <SantaAvatar alias={reqAlias} emoji={req.emoji ?? '🎅'} size={28} hat={santaSeason?.inSeason} />
                            <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{reqAlias}</span>
                          </div>
                          {req.reason && <div style={{ fontSize: 12, color: C.textSec, marginBottom: 8 }}>{req.reason}</div>}
                          {/* Approve/deny are owner-only; admins can see the request but cannot act on it */}
                          {campIsOwner && (
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button
                              onClick={async () => {
                                if (!confirm(`${t('santa_exit_request_approve', locale)} ${reqAlias}?`)) return;
                                const res = await tgFetch(`/tg/santa/campaigns/${campId}/exit-requests/${req.id}/approve`, {
                                  method: 'POST',
                                  idempotency: { action: `santa.exit-request.approve:${campId}:${req.id}` },
                                });
                                if (res.ok) {
                                  // Reload summary
                                  const refreshRes = await tgFetch(`/tg/santa/campaigns/${campId}/organizer/summary`);
                                  if (refreshRes.ok) setSantaOrganizerSummary(await refreshRes.json() as OrganizerSummary);
                                  pushToast(t('done', locale), 'success');
                                } else pushToast(t('error_generic', locale), 'error');
                              }}
                              style={{ flex: 1, background: C.green, border: 'none', borderRadius: 8, color: '#fff', fontSize: 12, fontWeight: 700, padding: '7px 0', cursor: 'pointer', fontFamily: font }}
                            >
                              {t('santa_exit_request_approve', locale)}
                            </button>
                            <button
                              onClick={async () => {
                                const res = await tgFetch(`/tg/santa/campaigns/${campId}/exit-requests/${req.id}/deny`, {
                                  method: 'POST',
                                  idempotency: { action: `santa.exit-request.deny:${campId}:${req.id}` },
                                });
                                if (res.ok) {
                                  const refreshRes = await tgFetch(`/tg/santa/campaigns/${campId}/organizer/summary`);
                                  if (refreshRes.ok) setSantaOrganizerSummary(await refreshRes.json() as OrganizerSummary);
                                  pushToast(t('done', locale), 'success');
                                } else pushToast(t('error_generic', locale), 'error');
                              }}
                              style={{ flex: 1, background: 'none', border: `1px solid ${C.red}`, borderRadius: 8, color: C.red, fontSize: 12, fontWeight: 700, padding: '7px 0', cursor: 'pointer', fontFamily: font }}
                            >
                              {t('santa_exit_request_deny', locale)}
                            </button>
                          </div>
                          )}
                        </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Gift progress */}
                {summary.giftProgress && (
                  <div style={{ background: C.card, borderRadius: 14, padding: 16, marginBottom: 16 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, marginBottom: 10 }}>
                      {t('santa_organizer_progress', locale)}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {[
                        { key: 'pending', v: summary.giftProgress.pending, label: t('santa_gift_progress_pending', locale, { count: summary.giftProgress.pending, total: 0 }), color: C.textSec },
                        { key: 'buying', v: summary.giftProgress.buying, label: t('santa_gift_progress_buying', locale, { count: summary.giftProgress.buying }), color: C.textSec },
                        { key: 'selectedFromWishlist', v: summary.giftProgress.selectedFromWishlist, label: t('santa_gift_progress_selected_wishlist', locale, { count: summary.giftProgress.selectedFromWishlist }), color: C.accent },
                        { key: 'selectedOutside', v: summary.giftProgress.selectedOutside, label: t('santa_gift_progress_selected_outside', locale, { count: summary.giftProgress.selectedOutside }), color: C.accent },
                        { key: 'declinedToSay', v: summary.giftProgress.declinedToSay, label: t('santa_gift_progress_declined', locale, { count: summary.giftProgress.declinedToSay }), color: C.textSec },
                        { key: 'sent', v: summary.giftProgress.sent, label: t('santa_gift_progress_sent', locale, { count: summary.giftProgress.sent }), color: C.accent },
                        { key: 'received', v: summary.giftProgress.received, label: t('santa_gift_progress_received', locale, { count: summary.giftProgress.received }), color: C.green },
                        { key: 'missedDeadline', v: summary.giftProgress.missedDeadline, label: t('santa_gift_progress_missed_deadline', locale, { count: summary.giftProgress.missedDeadline }), color: '#e05' },
                        { key: 'orphaned', v: summary.giftProgress.orphaned, label: t('santa_gift_status_orphaned', locale), color: C.textMuted },
                      ].filter(r => r.v > 0).map(r => (
                        <div key={r.key} style={{ fontSize: 13, color: r.color }}>{r.label}</div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Participants list with role badges */}
                <div style={{ background: C.card, borderRadius: 14, overflow: 'hidden', marginBottom: 16 }}>
                  <div style={{ padding: '12px 16px 8px', fontSize: 13, fontWeight: 600, color: C.textMuted }}>
                    {t('santa_organizer_participants', locale, { n: String(summary.participants.filter(p => p.status === 'JOINED').length) })}
                  </div>
                  {summary.participants.filter(p => p.status === 'JOINED').map((p, idx, arr) => {
                    const pAlias = p.adjectiveKey && p.animalKey
                      ? renderSantaAlias(p.adjectiveKey, p.animalKey, locale)
                      : p.displayName;
                    return (
                    <div key={p.id} style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: idx < arr.length - 1 ? `1px solid ${C.border}` : 'none' }}>
                      <SantaAvatar alias={pAlias} emoji={p.emoji ?? '🎅'} size={30} hat={santaSeason?.inSeason} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{pAlias}</span>
                          {p.role === 'ADMIN' && (
                            <span style={{ fontSize: 10, fontWeight: 700, color: C.accent, background: `rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.082)`, padding: '1px 5px', borderRadius: 5 }}>
                              {t('santa_role_admin', locale)}
                            </span>
                          )}
                        </div>
                        {p.hasLinkedWishlist ? (
                          <div style={{ fontSize: 11, color: C.green, marginTop: 2 }}>🎁 {t('santa_wishlist_linked_label', locale)}</div>
                        ) : (
                          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>⚠️ {t('santa_campaign_wishlist_not_linked_active', locale)}</div>
                        )}
                      </div>
                    </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          SECRET SANTA — JOIN
          ══════════════════════════════════════════════ */}
      {screen === 'santa-join' && (
        <div style={{ padding: '16px 20px 120px' }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, fontFamily: font, color: 'var(--wb-text)', letterSpacing: '-0.035em', lineHeight: 1.05, margin: '8px 0 24px' }}>
            🎅 {t('santa_join_title', locale)}
          </h1>

          {santaJoinLoading && (
            <div style={{ color: C.textMuted, fontSize: 14, textAlign: 'center', padding: 40 }}>{t('loading', locale)}</div>
          )}

          {/* P0-B: fallback when invite resolves to no preview (e.g. campaign not open, unknown error) */}
          {!santaJoinLoading && !santaJoinPreview && (
            <div style={{ background: C.card, borderRadius: 16, padding: 24, textAlign: 'center' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🔒</div>
              <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 16 }}>
                {t('santa_campaign_unavailable', locale)}
              </div>
              <button
                onClick={() => setScreen('my-wishlists')}
                style={{ background: C.accent, border: 'none', borderRadius: 12, color: '#fff', fontSize: 14, fontWeight: 600, padding: '12px 24px', cursor: 'pointer', fontFamily: font }}
              >
                {t('go_home', locale)}
              </button>
            </div>
          )}

          {!santaJoinLoading && santaJoinPreview && santaJoinPreview.status === 'CANCELLED' && (
            <div style={{ background: C.redSoft, borderRadius: 16, padding: 24, textAlign: 'center' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>❌</div>
              <div style={{ color: C.red, fontSize: 14, fontWeight: 600 }}>{t('santa_join_cancelled', locale)}</div>
            </div>
          )}

          {!santaJoinLoading && santaJoinPreview && santaJoinPreview.status !== 'CANCELLED' && (
            <div>
              <div style={{ background: C.card, borderRadius: 16, padding: 20, marginBottom: 20 }}>
                <h2 style={{ fontSize: 20, fontWeight: 800, color: C.text, margin: '0 0 8px' }}>{santaJoinPreview.title}</h2>
                {santaJoinPreview.ownerName && (
                  <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 4 }}>
                    {t('santa_join_organizer', locale, { name: santaJoinPreview.ownerName })}
                  </div>
                )}
                <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 4 }}>
                  {t('santa_join_participants', locale, { count: santaJoinPreview.participantCount })}
                </div>
                {santaJoinPreview.minBudget && santaJoinPreview.maxBudget && (
                  <div style={{ fontSize: 13, color: C.textMuted }}>
                    {t('santa_join_budget', locale, { min: santaJoinPreview.minBudget, max: santaJoinPreview.maxBudget, currency: santaJoinPreview.currency })}
                  </div>
                )}
                {santaJoinPreview.description && (
                  <p style={{ fontSize: 13, color: C.textSec, marginTop: 8, lineHeight: 1.5 }}>{santaJoinPreview.description}</p>
                )}
              </div>

              {santaJoinDone ? (
                <div style={{ background: C.greenSoft, borderRadius: 16, padding: 20, textAlign: 'center' }}>
                  <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
                  <div style={{ color: C.green, fontSize: 15, fontWeight: 700 }}>
                    {t('santa_join_success', locale, { title: santaJoinPreview.title })}
                  </div>
                  <button
                    onClick={async () => {
                      setSantaCampaignsLoading(true);
                      const res = await tgFetch('/tg/santa/campaigns');
                      if (res.ok) setSantaCampaigns(await res.json() as typeof santaCampaigns);
                      setSantaCampaignsLoading(false);
                      setScreen('santa-hub');
                    }}
                    style={{ marginTop: 16, background: C.accent, border: 'none', borderRadius: 12, color: '#fff', fontSize: 15, fontWeight: 600, padding: '12px 24px', cursor: 'pointer' }}
                  >
                    {t('santa_home_my_campaigns', locale)}
                  </button>
                </div>
              ) : (
                <button
                  disabled={santaJoinLoading || !['OPEN', 'DRAFT'].includes(santaJoinPreview.status)}
                  onClick={async () => {
                    if (!santaJoinToken) return;
                    setSantaJoinLoading(true);
                    try {
                      const res = await tgFetch(`/tg/santa/campaigns/${santaJoinPreview.id}/join`, {
                        method: 'POST',
                        idempotency: { action: `santa.participant.join:${santaJoinPreview.id}` },
                      });
                      if (res.ok) {
                        setSantaJoinDone(true);
                      } else {
                        const json = await res.json() as { error?: string };
                        pushToast(json.error === 'Not accepting' ? t('santa_join_closed', locale) : t('error_generic', locale), 'error');
                      }
                    } catch {
                      pushToast(t('error_network', locale), 'error');
                    } finally {
                      setSantaJoinLoading(false);
                    }
                  }}
                  style={{
                    background: !['OPEN', 'DRAFT'].includes(santaJoinPreview.status) ? C.textMuted : C.accent,
                    border: 'none', borderRadius: 14, color: '#fff', fontSize: 15, fontWeight: 700,
                    padding: '14px 0', cursor: !['OPEN', 'DRAFT'].includes(santaJoinPreview.status) ? 'not-allowed' : 'pointer',
                    fontFamily: font, width: '100%',
                  }}
                >
                  {!['OPEN', 'DRAFT'].includes(santaJoinPreview.status) ? t('santa_join_closed', locale) : t('santa_join_btn', locale)}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
