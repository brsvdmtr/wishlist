// Circles (Близкие) — P0.1 Mini App screen cluster.
//
// Self-contained lazy chunk (mirrors CalendarRoot): receives `tgFetch`,
// `locale` and a few host callbacks, owns its internal view state machine
// (list · create · detail · member · privacy · join). All UI is built from
// @wishlist/ui primitives + @wishlist/ui-tokens — no raw hex, no feature-local
// clones. The surprise invariant is enforced server-side; the owner-self view
// simply renders the reassurance banner and never receives reservation data.

import React, { useCallback, useEffect, useState } from 'react';

import { t, type Locale } from '@wishlist/shared';
import { Button, Card, Sheet, SectionHeader, ListRow, Banner, Chip, AvatarStack, HeroCard, SettingsSection, SettingsToggle, TextField } from '@wishlist/ui';
import { colors as c, radius as r, spacing as sp, fontSize as fs, fontWeight as fw } from '@wishlist/ui-tokens';

import { UserAvatar } from '../../components/UserAvatar';

// ── Host contract ─────────────────────────────────────────────────────────────

type TgFetchInit = {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  idempotency?: string | { action: string };
};
export type TgFetchFn = (url: string, init?: TgFetchInit) => Promise<Response>;

export interface CirclesRootProps {
  tgFetch: TgFetchFn;
  locale: Locale;
  /** Deep-link entry: when present, open the join preview for this token. */
  initial?: { view: 'join'; token: string } | null;
  /** Leave the Circles section (back from the list → host home tab). */
  onExit: () => void;
  /** Show the host paywall sheet (e.g. 'participant_limit'). */
  onUpsell: (context: string) => void;
  pushToast: (message: string, kind: 'success' | 'error' | 'info') => void;
}

// ── Wire shapes (mirror services/circles.service.ts) ──────────────────────────

type CircleType = 'FAMILY' | 'FRIENDS' | 'COLLEAGUES' | 'COUPLE';
interface MemberMini { name: string; avatarUrl: string | null }
interface NextEvent { name?: string; daysUntil: number }
interface CircleListEntry {
  id: string; name: string; type: CircleType; emoji: string | null;
  role: 'OWNER' | 'MEMBER'; memberCount: number; members: MemberMini[];
  nextEvent: NextEvent | null;
}
interface MemberView {
  userId: string; name: string; avatarUrl: string | null; role: 'OWNER' | 'MEMBER';
  isMe: boolean; sharedListCount: number; nextEvent: { daysUntil: number } | null;
}
interface CircleDetail {
  id: string; name: string; type: CircleType; emoji: string | null;
  myRole: 'OWNER' | 'MEMBER'; memberCount: number; capacity: number; members: MemberView[];
}
interface ItemView {
  id: string; title: string; url: string | null; priceText: string | null;
  currency: string | null; imageUrl: string | null; priority: string | null;
  reserved: boolean; reservedByMe: boolean;
}
interface MemberWishlists {
  member: { name: string; avatarUrl: string | null };
  wishlists: Array<{ id: string; title: string; emoji: string | null; items: ItemView[] }>;
}
interface ShareOption { wishlistId: string; title: string; emoji: string | null; itemCount: number; shared: boolean }
interface InvitePreview {
  circleId: string; name: string; type: CircleType; emoji: string | null;
  memberCount: number; members: MemberMini[]; invitedBy: string | null; alreadyMember: boolean;
}

const TYPE_META: Record<CircleType, { emoji: string; labelKey: string }> = {
  FAMILY: { emoji: '🏡', labelKey: 'circle_type_family' },
  FRIENDS: { emoji: '🎉', labelKey: 'circle_type_friends' },
  COLLEAGUES: { emoji: '💼', labelKey: 'circle_type_colleagues' },
  COUPLE: { emoji: '💞', labelKey: 'circle_type_couple' },
};
const TYPE_ORDER: CircleType[] = ['FAMILY', 'FRIENDS', 'COLLEAGUES', 'COUPLE'];

function coverEmoji(type: CircleType, emoji: string | null): string {
  return (emoji && emoji.trim()) || TYPE_META[type].emoji;
}

// Countdown chip: <7d = warning urgency, else accent.
function EventChip({ days, locale }: { days: number; locale: Locale }) {
  const tone = days <= 7 ? 'warning' : 'accent';
  const label = days <= 0 ? t('circle_event_today', locale) : t('circle_event_in_days', locale, { n: days });
  return <Chip tone={tone}>🎂 {label}</Chip>;
}

// ── Root ──────────────────────────────────────────────────────────────────────

type View =
  | { name: 'list' }
  | { name: 'create' }
  | { name: 'detail'; circleId: string }
  | { name: 'member'; circleId: string; memberId: string }
  | { name: 'privacy'; circleId: string }
  | { name: 'join'; token: string };

export function CirclesRoot({ tgFetch, locale, initial, onExit, onUpsell, pushToast }: CirclesRootProps) {
  const [view, setView] = useState<View>(initial ? { name: 'join', token: initial.token } : { name: 'list' });

  return (
    <div
      style={{
        position: 'absolute', inset: 0, overflowY: 'auto',
        padding: `${sp[4]}px ${sp[4]}px 120px`,
        background: c.bg,
      }}
    >
      {view.name === 'list' && (
        <ListView tgFetch={tgFetch} locale={locale} onOpen={(id) => setView({ name: 'detail', circleId: id })} onCreate={() => setView({ name: 'create' })} onExit={onExit} />
      )}
      {view.name === 'create' && (
        <CreateView tgFetch={tgFetch} locale={locale} pushToast={pushToast}
          onCreated={(id) => setView({ name: 'detail', circleId: id })}
          onBack={() => setView({ name: 'list' })} />
      )}
      {view.name === 'detail' && (
        <DetailView tgFetch={tgFetch} locale={locale} circleId={view.circleId} onUpsell={onUpsell} pushToast={pushToast}
          onBack={() => setView({ name: 'list' })}
          onOpenMember={(memberId) => setView({ name: 'member', circleId: view.circleId, memberId })}
          onPrivacy={() => setView({ name: 'privacy', circleId: view.circleId })}
          onLeft={() => setView({ name: 'list' })} />
      )}
      {view.name === 'member' && (
        <MemberView tgFetch={tgFetch} locale={locale} circleId={view.circleId} memberId={view.memberId} pushToast={pushToast}
          onBack={() => setView({ name: 'detail', circleId: view.circleId })} />
      )}
      {view.name === 'privacy' && (
        <PrivacyView tgFetch={tgFetch} locale={locale} circleId={view.circleId} pushToast={pushToast}
          onBack={() => setView({ name: 'detail', circleId: view.circleId })} />
      )}
      {view.name === 'join' && (
        <JoinView tgFetch={tgFetch} locale={locale} token={view.token} pushToast={pushToast}
          onJoined={(id) => setView({ name: 'detail', circleId: id })}
          onDecline={onExit} />
      )}
    </div>
  );
}

// ── Shared bits ────────────────────────────────────────────────────────────────

function ScreenHeader({ title, subtitle, onBack }: { title: string; subtitle?: string; onBack: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: sp[2], marginBottom: sp[4] }}>
      <button
        type="button" onClick={onBack} aria-label="Назад"
        style={{
          width: 40, height: 40, minWidth: 40, borderRadius: r.lg, border: `1px solid ${c.border}`,
          background: c.surface, color: c.text, fontSize: fs.lg, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >←</button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: fs.xxl, fontWeight: fw.strong, color: c.text, letterSpacing: '-0.018em' }}>{title}</div>
        {subtitle && <div style={{ fontSize: fs.xs, color: c.textMuted, marginTop: 1 }}>{subtitle}</div>}
      </div>
    </div>
  );
}

function CenteredLoader() {
  return <div style={{ textAlign: 'center', color: c.textMuted, padding: `${sp[8]}px 0`, fontSize: fs.sm }}>…</div>;
}

function avatarsFor(members: MemberMini[]) {
  return members.map((m) => ({ label: (m.name.trim() || '?')[0]!.toUpperCase() }));
}

// ── List ─────────────────────────────────────────────────────────────────────

function ListView({ tgFetch, locale, onOpen, onCreate, onExit }: {
  tgFetch: TgFetchFn; locale: Locale; onOpen: (id: string) => void; onCreate: () => void; onExit: () => void;
}) {
  const [circles, setCircles] = useState<CircleListEntry[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await tgFetch('/tg/circles');
        if (!res.ok) throw new Error('load');
        const json = (await res.json()) as { circles: CircleListEntry[] };
        if (alive) setCircles(json.circles);
      } catch {
        if (alive) setCircles([]);
      }
    })();
    return () => { alive = false; };
  }, [tgFetch]);

  if (circles === null) return <CenteredLoader />;

  if (circles.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', minHeight: '70vh', padding: `0 ${sp[5]}px` }}>
        <div style={{ fontSize: 60, marginBottom: sp[2] }}>👥</div>
        <div style={{ fontSize: fs.displaySm, fontWeight: fw.bold, color: c.text, letterSpacing: '-0.02em' }}>{t('circle_empty_title', locale)}</div>
        <div style={{ fontSize: fs.lg, color: c.textSecondary, margin: `${sp[3]}px 0 ${sp[6]}px`, lineHeight: 1.5 }}>{t('circle_empty_sub', locale)}</div>
        <Button variant="primary" fullWidth onClick={onCreate}>{t('circle_empty_cta', locale)}</Button>
        <Button variant="ghost" fullWidth onClick={onExit} style={{ marginTop: sp[2] }}>{t('circle_empty_have_link', locale)}</Button>
      </div>
    );
  }

  return (
    <>
      <SectionHeader>{t('circle_my_groups', locale, { n: circles.length })}</SectionHeader>
      {circles.map((circle) => (
        <Card key={circle.id} variant="interactive" onClick={() => onOpen(circle.id)} style={{ marginBottom: sp[2.5] }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: sp[3] }}>
            <div style={{
              width: 52, height: 52, minWidth: 52, borderRadius: r.xl, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 27, background: c.accentSoftStrong,
            }}>{coverEmoji(circle.type, circle.emoji)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: fs.xxl, fontWeight: fw.strong, color: c.text, letterSpacing: '-0.018em' }}>{circle.name}</div>
              <div style={{ fontSize: fs.sm, color: c.textMuted, marginTop: 2 }}>
                {t('circle_members_count', locale, { n: circle.memberCount })}
                {circle.role === 'OWNER' ? ` · ${t('circle_you_owner', locale)}` : ''}
              </div>
            </div>
            <div style={{ fontSize: 20, color: c.textMuted, alignSelf: 'center' }}>›</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: sp[3], paddingTop: sp[3], borderTop: `1px solid ${c.hairline}` }}>
            <AvatarStack avatars={avatarsFor(circle.members)} max={5} />
            {circle.nextEvent ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: sp[2] }}>
                <EventChip days={circle.nextEvent.daysUntil} locale={locale} />
                {circle.nextEvent.name && <span style={{ fontSize: fs.sm, color: c.textMuted }}>{circle.nextEvent.name}</span>}
              </div>
            ) : (
              <span style={{ fontSize: fs.sm, color: c.textMuted }}>{t('circle_no_events', locale)}</span>
            )}
          </div>
        </Card>
      ))}
      <Button variant="secondary" fullWidth onClick={onCreate} style={{ marginTop: sp[2] }}>＋ {t('circle_create_cta', locale)}</Button>
    </>
  );
}

// ── Create ──────────────────────────────────────────────────────────────────

function CreateView({ tgFetch, locale, onCreated, onBack, pushToast }: {
  tgFetch: TgFetchFn; locale: Locale; onCreated: (id: string) => void; onBack: () => void; pushToast: CirclesRootProps['pushToast'];
}) {
  const [type, setType] = useState<CircleType>('FAMILY');
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string>(TYPE_META.FAMILY.emoji);
  const [busy, setBusy] = useState(false);
  // Prefill the name from the type label until the user edits it.
  const [nameEdited, setNameEdited] = useState(false);

  const pickType = (next: CircleType) => {
    setType(next);
    setEmoji(TYPE_META[next].emoji);
    if (!nameEdited) setName(t(TYPE_META[next].labelKey, locale));
  };

  const submit = async () => {
    const trimmed = name.trim() || t(TYPE_META[type].labelKey, locale);
    setBusy(true);
    try {
      const res = await tgFetch('/tg/circles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, type, emoji }),
        idempotency: { action: 'circle.create' },
      });
      if (!res.ok) throw new Error('create');
      const json = (await res.json()) as { circle: { id: string } };
      onCreated(json.circle.id);
    } catch {
      pushToast(t('circle_err_generic', locale), 'error');
    } finally {
      setBusy(false);
    }
  };

  const EMOJI_CHOICES = ['🏡', '🎉', '💼', '💞', '❤️', '🌳', '🎂', '⭐'];

  return (
    <>
      <ScreenHeader title={t('circle_create_title', locale)} onBack={onBack} />

      <div style={{ marginBottom: sp[4] }}>
        <Label locale={locale} text={t('circle_field_type', locale)} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: sp[2] }}>
          {TYPE_ORDER.map((tp) => {
            const sel = tp === type;
            return (
              <button
                key={tp} type="button" onClick={() => pickType(tp)}
                style={{
                  background: sel ? c.cardStrong : c.card,
                  border: `1px solid ${sel ? c.accentSoftStrong : c.border}`,
                  borderRadius: r.input, padding: `${sp[3]}px ${sp[3]}px`, textAlign: 'center', cursor: 'pointer',
                  boxShadow: sel ? `inset 0 0 0 1px ${c.accentSoftStrong}` : 'none',
                }}
              >
                <div style={{ fontSize: 26 }}>{TYPE_META[tp].emoji}</div>
                <div style={{ fontSize: fs.sm, fontWeight: fw.semibold, marginTop: 4, color: sel ? c.accentStrong : c.text }}>{t(TYPE_META[tp].labelKey, locale)}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ marginBottom: sp[4] }}>
        <TextField
          label={t('circle_field_name', locale)}
          value={name}
          onChange={(e) => { setName(e.target.value); setNameEdited(true); }}
          placeholder={t(TYPE_META[type].labelKey, locale)}
          maxLength={60}
        />
      </div>

      <div style={{ marginBottom: sp[4] }}>
        <Label locale={locale} text={t('circle_field_cover', locale)} />
        <div style={{ display: 'flex', gap: sp[2], flexWrap: 'wrap' }}>
          {EMOJI_CHOICES.map((em) => {
            const sel = em === emoji;
            return (
              <button
                key={em} type="button" onClick={() => setEmoji(em)}
                style={{
                  width: 44, height: 44, borderRadius: r.lg, fontSize: 22, cursor: 'pointer',
                  background: sel ? c.accentSoft : c.card, border: `1px solid ${sel ? c.accentSoftStrong : c.border}`,
                }}
              >{em}</button>
            );
          })}
        </div>
      </div>

      <Banner tone="success">
        <span>🤫 {t('circle_surprise_note', locale)}</span>
      </Banner>

      <div style={{ marginTop: sp[5] }}>
        <Button variant="primary" fullWidth disabled={busy} loading={busy} onClick={() => void submit()}>
          {t('circle_create_submit', locale)}
        </Button>
      </div>
    </>
  );
}

function Label({ text }: { locale: Locale; text: string }) {
  return (
    <div style={{ fontSize: fs.xs, fontWeight: fw.semibold, color: c.textMuted, textTransform: 'uppercase', letterSpacing: '0.7px', margin: `0 0 ${sp[2]}px 2px` }}>{text}</div>
  );
}

// ── Detail (members) ──────────────────────────────────────────────────────────

function DetailView({ tgFetch, locale, circleId, onBack, onOpenMember, onPrivacy, onUpsell, onLeft, pushToast }: {
  tgFetch: TgFetchFn; locale: Locale; circleId: string; onBack: () => void;
  onOpenMember: (memberId: string) => void; onPrivacy: () => void; onUpsell: (ctx: string) => void; onLeft: () => void;
  pushToast: CirclesRootProps['pushToast'];
}) {
  const [detail, setDetail] = useState<CircleDetail | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInvite] = useState<{ link: string; memberCount: number; capacity: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<MemberView | null>(null);

  const load = useCallback(async () => {
    const res = await tgFetch(`/tg/circles/${circleId}`);
    if (res.ok) setDetail(((await res.json()) as { circle: CircleDetail }).circle);
  }, [tgFetch, circleId]);

  useEffect(() => { void load(); }, [load]);

  const openInvite = async () => {
    try {
      const res = await tgFetch(`/tg/circles/${circleId}/invite`, { method: 'POST', idempotency: { action: `circle.invite:${circleId}` } });
      if (res.status === 402) { onUpsell('participant_limit'); return; }
      if (!res.ok) throw new Error('invite');
      const json = (await res.json()) as { link: string; memberCount: number; capacity: number };
      setInvite(json);
      setInviteOpen(true);
    } catch {
      pushToast(t('circle_err_generic', locale), 'error');
    }
  };

  const share = () => {
    if (!invite) return;
    const tg = (window as unknown as { Telegram?: { WebApp?: { openTelegramLink?: (u: string) => void } } }).Telegram?.WebApp;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(invite.link)}&text=${encodeURIComponent(t('circle_invite_share_text', locale))}`;
    if (tg?.openTelegramLink) tg.openTelegramLink(shareUrl);
    else window.open(shareUrl, '_blank');
  };

  const leave = async () => {
    try {
      await tgFetch(`/tg/circles/${circleId}/leave`, { method: 'POST', idempotency: { action: `circle.leave:${circleId}` } });
      pushToast(t('circle_left_toast', locale), 'info');
      onLeft();
    } catch { pushToast(t('circle_err_generic', locale), 'error'); }
  };

  const remove = async () => {
    try {
      await tgFetch(`/tg/circles/${circleId}`, { method: 'DELETE', idempotency: { action: `circle.delete:${circleId}` } });
      pushToast(t('circle_deleted_toast', locale), 'info');
      onLeft();
    } catch { pushToast(t('circle_err_generic', locale), 'error'); }
  };

  const doRemove = async (userId: string) => {
    try {
      await tgFetch(`/tg/circles/${circleId}/members/${userId}`, {
        method: 'DELETE', idempotency: { action: `circle.member_removed:${circleId}:${userId}` },
      });
      await load(); // the member vanishing from the list is the confirmation
    } catch { pushToast(t('circle_err_generic', locale), 'error'); }
  };

  if (!detail) return <><ScreenHeader title="" onBack={onBack} /><CenteredLoader /></>;

  const soon = detail.members.filter((m) => m.nextEvent);
  const rest = detail.members.filter((m) => !m.nextEvent);
  const isOwner = detail.myRole === 'OWNER';

  const memberRow = (m: MemberView) => (
    <ListRow
      key={m.userId}
      variant="card"
      interactive={!m.isMe || m.sharedListCount > 0}
      onClick={() => onOpenMember(m.userId)}
      leading={<UserAvatar name={m.name} avatarUrl={m.avatarUrl} size={44} accent={c.accent} />}
      title={m.isMe ? `${m.name} · ${t('circle_you', locale)}` : m.name}
      subtitle={
        m.nextEvent
          ? `${t('circle_birthday', locale)} · ${m.nextEvent.daysUntil <= 0 ? t('circle_event_today', locale) : t('circle_event_in_days', locale, { n: m.nextEvent.daysUntil })}`
          : m.sharedListCount > 0
            ? t('circle_shared_lists', locale, { n: m.sharedListCount })
            : t('circle_no_shared', locale)
      }
      trailing={
        <div style={{ display: 'flex', alignItems: 'center', gap: sp[2] }}>
          {isOwner && !m.isMe && (
            <button
              type="button" aria-label={t('circle_remove_member', locale)}
              onClick={(e) => { e.stopPropagation(); setRemoveTarget(m); }}
              style={{ width: 30, height: 30, minWidth: 30, borderRadius: r.full, border: `1px solid ${c.border}`, background: c.surface, color: c.textMuted, fontSize: fs.sm, lineHeight: 1, cursor: 'pointer' }}
            >✕</button>
          )}
          <span style={{ fontSize: fs.sm, color: c.accentStrong, fontWeight: fw.strong }}>{t('circle_open', locale)} ›</span>
        </div>
      }
    />
  );

  return (
    <>
      <ScreenHeader
        title={`${coverEmoji(detail.type, detail.emoji)} ${detail.name}`}
        subtitle={t('circle_members_count', locale, { n: detail.memberCount })}
        onBack={onBack}
      />

      <div style={{ display: 'flex', gap: sp[2], marginBottom: sp[4] }}>
        <Button variant="secondary" fullWidth onClick={() => void openInvite()}>＋ {t('circle_invite_cta', locale)}</Button>
        <Button variant="surface" onClick={() => setMenuOpen(true)} aria-label={t('circle_settings', locale)}>⚙</Button>
      </div>

      {soon.length > 0 && <SectionHeader>{t('circle_soon', locale)}</SectionHeader>}
      {soon.map(memberRow)}
      {rest.length > 0 && <SectionHeader>{t('circle_others', locale)}</SectionHeader>}
      {rest.map(memberRow)}

      {/* Invite sheet */}
      <Sheet open={inviteOpen} onClose={() => setInviteOpen(false)} title={t('circle_invite_title', locale)}>
        <div style={{ fontSize: fs.sm, color: c.textSecondary, textAlign: 'center', margin: `0 ${sp[3]}px ${sp[4]}px`, lineHeight: 1.5 }}>{t('circle_invite_sub', locale)}</div>
        {invite && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: sp[2], background: c.card, border: `1px dashed ${c.borderStrong}`, borderRadius: r.input, padding: `${sp[3]}px ${sp[3]}px` }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: fs.sm, color: c.textSecondary, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{invite.link}</div>
              <button
                type="button"
                onClick={() => { void navigator.clipboard?.writeText(invite.link); pushToast(t('circle_copied', locale), 'success'); }}
                style={{ background: c.accentSoft, color: c.accentStrong, border: 'none', borderRadius: r.md, padding: `${sp[2]}px ${sp[3]}px`, fontSize: fs.sm, fontWeight: fw.strong, cursor: 'pointer' }}
              >{t('circle_copy', locale)}</button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: fs.sm, color: c.textMuted, margin: `${sp[3]}px 0 0` }}>
              <span>{t('circle_capacity_meter', locale, { current: invite.memberCount, max: invite.capacity })}</span>
            </div>
          </>
        )}
        <div style={{ marginTop: sp[4] }}>
          <Button variant="primary" fullWidth onClick={share}>{t('circle_invite_share', locale)}</Button>
        </div>
        <Button variant="ghost" fullWidth onClick={() => setInviteOpen(false)} style={{ marginTop: sp[1] }}>{t('circle_done', locale)}</Button>
      </Sheet>

      {/* Owner/member menu sheet */}
      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title={detail.name}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: sp[2] }}>
          <Button variant="surface" fullWidth onClick={() => { setMenuOpen(false); onPrivacy(); }}>👁 {t('circle_manage_visibility', locale)}</Button>
          {isOwner ? (
            <Button variant="surface" fullWidth onClick={() => { setMenuOpen(false); void remove(); }} style={{ color: c.danger }}>🗑 {t('circle_delete', locale)}</Button>
          ) : (
            <Button variant="surface" fullWidth onClick={() => { setMenuOpen(false); void leave(); }} style={{ color: c.danger }}>{t('circle_leave', locale)}</Button>
          )}
          <Button variant="ghost" fullWidth onClick={() => setMenuOpen(false)}>{t('circle_done', locale)}</Button>
        </div>
      </Sheet>

      {/* Remove-member confirm (owner only) */}
      <Sheet open={!!removeTarget} onClose={() => setRemoveTarget(null)} title={t('circle_remove_member', locale)}>
        <div style={{ fontSize: fs.sm, color: c.textSecondary, textAlign: 'center', margin: `0 ${sp[3]}px ${sp[4]}px`, lineHeight: 1.5 }}>
          {removeTarget ? t('circle_remove_member_q', locale, { name: removeTarget.name }) : ''}
        </div>
        <Button
          variant="surface" fullWidth style={{ color: c.danger }}
          onClick={() => { const target = removeTarget; setRemoveTarget(null); if (target) void doRemove(target.userId); }}
        >{t('circle_remove_member', locale)}</Button>
        <Button variant="ghost" fullWidth onClick={() => setRemoveTarget(null)} style={{ marginTop: sp[1] }}>{t('circle_cancel', locale)}</Button>
      </Sheet>
    </>
  );
}

// ── Member's shared lists (surprise invariant applies server-side) ─────────────

function MemberView({ tgFetch, locale, circleId, memberId, onBack, pushToast }: {
  tgFetch: TgFetchFn; locale: Locale; circleId: string; memberId: string; onBack: () => void; pushToast: CirclesRootProps['pushToast'];
}) {
  const [data, setData] = useState<MemberWishlists | null>(null);
  const [isSelf, setIsSelf] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await tgFetch(`/tg/circles/${circleId}/members/${memberId}/wishlists`);
    if (res.ok) {
      const json = (await res.json()) as MemberWishlists & { isSelf?: boolean };
      setData(json);
      setIsSelf(json.isSelf ?? false);
    }
  }, [tgFetch, circleId, memberId]);

  useEffect(() => { void load(); }, [load]);

  // Circle reservations go through the surprise-preserving circle endpoint —
  // NOT POST /tg/items/:id/reserve (which sets status + DMs the owner). The
  // owner is never notified; co-members see a neutral "taken".
  const reserve = async (itemId: string) => {
    setBusyId(itemId);
    try {
      const res = await tgFetch(`/tg/circles/${circleId}/items/${itemId}/reserve`, {
        method: 'POST', idempotency: { action: `circle.reserve:${circleId}:${itemId}` },
      });
      if (!res.ok) throw new Error('reserve');
      pushToast(t('circle_reserved_toast', locale), 'success');
      await load();
    } catch {
      pushToast(t('circle_err_generic', locale), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const unreserve = async (itemId: string) => {
    setBusyId(itemId);
    try {
      await tgFetch(`/tg/circles/${circleId}/items/${itemId}/reserve`, {
        method: 'DELETE', idempotency: { action: `circle.unreserve:${circleId}:${itemId}` },
      });
      await load();
    } catch {
      pushToast(t('circle_err_generic', locale), 'error');
    } finally {
      setBusyId(null);
    }
  };

  if (!data) return <><ScreenHeader title="" onBack={onBack} /><CenteredLoader /></>;

  const allItems = data.wishlists.flatMap((w) => w.items);
  // Owner self-view: the server stripped all reservation state. Show reassurance.
  const ownerSelf = isSelf;

  return (
    <>
      <ScreenHeader title={data.member.name} subtitle={t('circle_in_group', locale)} onBack={onBack} />
      {ownerSelf && (
        <Banner tone="success" style={{ marginBottom: sp[3] }}>
          <span><b>🤫 {t('circle_surprise_safe_title', locale)}</b> {t('circle_surprise_safe_sub', locale)}</span>
        </Banner>
      )}
      {allItems.length === 0 && (
        <div style={{ textAlign: 'center', color: c.textMuted, padding: `${sp[8]}px 0`, fontSize: fs.lg }}>{t('circle_member_empty', locale)}</div>
      )}
      {data.wishlists.map((wl) => (
        <div key={wl.id} style={{ marginBottom: sp[4] }}>
          {data.wishlists.length > 1 && (
            <SectionHeader>{coverEmoji('FAMILY', wl.emoji)} {wl.title}</SectionHeader>
          )}
          {wl.items.map((it) => (
            <ListRow
              key={it.id}
              variant="card"
              leading={<div style={{ width: 46, height: 46, borderRadius: r.lg, background: it.reservedByMe ? c.successSoft : c.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>{it.imageUrl ? '' : '🎁'}</div>}
              title={it.title}
              subtitle={it.priceText ?? undefined}
              trailing={
                // Surprise invariant: the owner's own list shows NO reservation
                // control or status at all — no reserve button (which would leak
                // the reserved fact via a 409), no chips. Just the reassurance
                // banner above. Reservation data is already stripped server-side.
                ownerSelf ? undefined
                  : it.reservedByMe ? <Button variant="ghost" size="sm" disabled={busyId === it.id} loading={busyId === it.id} onClick={() => void unreserve(it.id)}>✓ {t('circle_reserved_by_you', locale)}</Button>
                    : it.reserved ? <Chip tone="surface">{t('circle_reserved_taken', locale)}</Chip>
                      : <Button variant="secondary" size="sm" disabled={busyId === it.id} loading={busyId === it.id} onClick={() => void reserve(it.id)}>{t('circle_reserve', locale)}</Button>
              }
            />
          ))}
        </div>
      ))}
    </>
  );
}

// ── Privacy (per-circle list visibility) ───────────────────────────────────────

function PrivacyView({ tgFetch, locale, circleId, onBack, pushToast }: {
  tgFetch: TgFetchFn; locale: Locale; circleId: string; onBack: () => void; pushToast: CirclesRootProps['pushToast'];
}) {
  const [options, setOptions] = useState<ShareOption[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await tgFetch(`/tg/circles/${circleId}/shares`);
      if (res.ok && alive) setOptions(((await res.json()) as { wishlists: ShareOption[] }).wishlists);
    })();
    return () => { alive = false; };
  }, [tgFetch, circleId]);

  const toggle = async (wishlistId: string) => {
    if (!options) return;
    const next = options.map((o) => (o.wishlistId === wishlistId ? { ...o, shared: !o.shared } : o));
    setOptions(next);
    setSaving(true);
    try {
      const ids = next.filter((o) => o.shared).map((o) => o.wishlistId);
      const res = await tgFetch(`/tg/circles/${circleId}/shares`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wishlistIds: ids }), idempotency: { action: `circle.shares:${circleId}` },
      });
      if (!res.ok) throw new Error('save');
    } catch {
      pushToast(t('circle_err_generic', locale), 'error');
      // revert
      setOptions(options);
    } finally { setSaving(false); }
  };

  if (!options) return <><ScreenHeader title={t('circle_privacy_title', locale)} onBack={onBack} /><CenteredLoader /></>;

  return (
    <>
      <ScreenHeader title={t('circle_privacy_title', locale)} onBack={onBack} />
      <Banner tone="info" style={{ marginBottom: sp[3] }}>
        <span>👁 {t('circle_privacy_note', locale)}</span>
      </Banner>
      {options.length === 0 ? (
        <div style={{ textAlign: 'center', color: c.textMuted, padding: `${sp[6]}px 0`, fontSize: fs.lg }}>{t('circle_privacy_no_lists', locale)}</div>
      ) : (
        <SettingsSection title={t('circle_privacy_title', locale)} first>
          {options.map((o) => (
            <SettingsToggle
              key={o.wishlistId}
              icon={coverEmoji('FAMILY', o.emoji)}
              label={o.title}
              value={o.shared}
              disabled={saving}
              onChange={() => void toggle(o.wishlistId)}
            />
          ))}
        </SettingsSection>
      )}
    </>
  );
}

// ── Join (invitee, deep-link entry) ─────────────────────────────────────────

function JoinView({ tgFetch, locale, token, onJoined, onDecline, pushToast }: {
  tgFetch: TgFetchFn; locale: Locale; token: string; onJoined: (id: string) => void; onDecline: () => void; pushToast: CirclesRootProps['pushToast'];
}) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await tgFetch(`/tg/circles/invite/${encodeURIComponent(token)}`);
        if (!res.ok) throw new Error('preview');
        const json = (await res.json()) as { preview: InvitePreview };
        if (alive) setPreview(json.preview);
      } catch { if (alive) setError(true); }
    })();
    return () => { alive = false; };
  }, [tgFetch, token]);

  const join = async () => {
    setBusy(true);
    try {
      const res = await tgFetch('/tg/circles/join', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }), idempotency: { action: `circle.join:${token}` },
      });
      if (res.status === 409) { pushToast(t('circle_full_toast', locale), 'error'); return; }
      if (!res.ok) throw new Error('join');
      const json = (await res.json()) as { circle: { id: string } };
      onJoined(json.circle.id);
    } catch {
      pushToast(t('circle_err_generic', locale), 'error');
    } finally { setBusy(false); }
  };

  if (error) {
    return (
      <div style={{ textAlign: 'center', paddingTop: '20vh' }}>
        <div style={{ fontSize: 48, marginBottom: sp[3] }}>🔗</div>
        <div style={{ fontSize: fs.xxl, fontWeight: fw.strong, color: c.text }}>{t('circle_invite_invalid', locale)}</div>
        <Button variant="ghost" onClick={onDecline} style={{ marginTop: sp[4] }}>{t('circle_back_home', locale)}</Button>
      </div>
    );
  }
  if (!preview) return <CenteredLoader />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '85vh' }}>
      <div style={{ flex: 1 }}>
        <HeroCard tone="accent" style={{ marginTop: sp[4] }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 56, marginBottom: sp[2] }}>{coverEmoji(preview.type, preview.emoji)}</div>
            <div style={{ fontSize: fs.xs, fontWeight: fw.strong, textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.85 }}>{t('circle_join_kicker', locale)}</div>
            <div style={{ fontSize: fs.displaySm, fontWeight: fw.bold, letterSpacing: '-0.03em', margin: '4px 0' }}>{preview.name}</div>
            <div style={{ display: 'flex', justifyContent: 'center', margin: `${sp[3]}px 0 ${sp[1]}px` }}>
              <AvatarStack avatars={avatarsFor(preview.members)} max={5} size="md" borderColor={c.accentDeep} />
            </div>
            <div style={{ fontSize: fs.sm, opacity: 0.9 }}>
              {t('circle_members_count', locale, { n: preview.memberCount })}
              {preview.invitedBy ? ` · ${t('circle_invited_by', locale, { name: preview.invitedBy })}` : ''}
            </div>
          </div>
        </HeroCard>
        <Banner tone="success" style={{ marginTop: sp[3] }}>
          <span>🤫 {t('circle_join_surprise', locale)}</span>
        </Banner>
      </div>
      <div style={{ paddingTop: sp[4] }}>
        {preview.alreadyMember ? (
          <Button variant="primary" fullWidth onClick={() => onJoined(preview.circleId)}>{t('circle_open_group', locale)}</Button>
        ) : (
          <Button variant="primary" fullWidth disabled={busy} loading={busy} onClick={() => void join()}>{t('circle_join_cta', locale)}</Button>
        )}
        <Button variant="ghost" fullWidth onClick={onDecline} style={{ marginTop: sp[1] }}>{t('circle_not_now', locale)}</Button>
      </div>
    </div>
  );
}
