// Regression tests for the «Близкие» (Circles) Mini App screen.
//
// Locks the three behaviors fixed in PR #38 (commit 367d6dc):
//   • fix #5 — JoinView own-link redirect: an existing member / the owner who
//     taps their own invite link is sent straight into the circle (onJoined)
//     and never sees the join-preview onboarding. New invitees DO see it.
//   • fix #2 — MemberView tap-opens-detail: tapping an item row opens the
//     in-app detail Sheet, NOT the store. The store opens only via the explicit
//     «Открыть в магазине» button inside the sheet.
//   • fix #3 — surprise invariant in the detail sheet: the owner-self view shows
//     no reserve control / no "taken" chip; co-members see a neutral chip or the
//     reserve button, never a reserver identity.
//
// JoinView/MemberView sit several navigation levels deep, so they're mounted in
// isolation (they're exported for exactly this). One CirclesRoot-level test
// exercises the real deep-link wiring end-to-end.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { t } from '@wishlist/shared';
import { CirclesRoot, JoinView, MemberView, DetailView } from './CirclesRoot';

// Minimal Response stand-in — the component only touches `.ok`, `.status`,
// `.json()`. Cast through `unknown` so we don't have to satisfy the full DOM type.
function makeRes(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  const ok = init?.ok ?? true;
  const status = init?.status ?? (ok ? 200 : 400);
  return { ok, status, json: async () => body } as unknown as Response;
}

// Wire-shape builders (mirror the interfaces at the top of CirclesRoot.tsx).
function invitePreview(over?: Record<string, unknown>) {
  return {
    circleId: 'circle-1',
    name: 'Семья',
    type: 'FAMILY',
    emoji: null,
    memberCount: 3,
    members: [{ name: 'Аня', avatarUrl: null }],
    invitedBy: 'Аня',
    alreadyMember: false,
    ...over,
  };
}

function item(over?: Record<string, unknown>) {
  return {
    id: 'item-1',
    title: 'Подарок',
    url: 'https://shop.example/p/1',
    priceText: '1 990',
    currency: '₽',
    imageUrl: null,
    priority: null,
    description: 'Описание подарка',
    categoryId: null,
    reserved: false,
    reservedByMe: false,
    ...over,
  };
}

function memberWishlists(items: Array<Record<string, unknown>>, over?: Record<string, unknown>) {
  return {
    member: { name: 'Аня', avatarUrl: null },
    wishlists: [{ id: 'wl-1', title: 'Список', emoji: null, categories: [], items }],
    ...over,
  };
}

function circleDetail(over?: Record<string, unknown>) {
  return {
    id: 'c1', name: 'Семья', type: 'FAMILY', emoji: null,
    myRole: 'OWNER', memberCount: 1, capacity: 8, members: [],
    ...over,
  };
}

// tgFetch router for DetailView: the load GET returns the circle; the
// destructive mutations (DELETE group / POST leave) just resolve ok.
function detailFetch(detail: Record<string, unknown>) {
  return vi.fn((url: string, init?: { method?: string }) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url === '/tg/circles/c1' && method === 'GET') return Promise.resolve(makeRes({ circle: detail }));
    return Promise.resolve(makeRes({}));
  });
}

function renderDetail(tgFetch: ReturnType<typeof vi.fn>, onLeft = vi.fn()) {
  render(
    <DetailView
      tgFetch={tgFetch} locale="ru" circleId="c1"
      onBack={vi.fn()} onOpenMember={vi.fn()} onPrivacy={vi.fn()} onUpsell={vi.fn()}
      onLeft={onLeft} pushToast={vi.fn()}
    />,
  );
  return { onLeft };
}

const deleteCall = () => expect.objectContaining({ method: 'DELETE' });
const leavePost = () => expect.objectContaining({ method: 'POST' });

// ── fix #5 — JoinView own-link redirect ───────────────────────────────────────

describe('CirclesRoot › JoinView own-link redirect (fix #5)', () => {
  it('redirects an existing member straight into the circle and never shows the join preview', async () => {
    const tgFetch = vi.fn().mockResolvedValue(
      makeRes({ preview: invitePreview({ circleId: 'circle-9', alreadyMember: true }) }),
    );
    const onJoined = vi.fn();

    render(
      <JoinView tgFetch={tgFetch} locale="ru" token="tok-1" onJoined={onJoined} onDecline={vi.fn()} pushToast={vi.fn()} />,
    );

    // onJoined fires with the previewed circleId, exactly once.
    await vi.waitFor(() => expect(onJoined).toHaveBeenCalledWith('circle-9'));
    expect(onJoined).toHaveBeenCalledTimes(1);

    // None of the join-preview onboarding UI rendered.
    expect(screen.queryByRole('button', { name: t('circle_join_cta', 'ru') })).toBeNull();
    expect(screen.queryByText(t('circle_join_kicker', 'ru'))).toBeNull();
  });

  it('shows the join preview + CTA for a new invitee and does NOT auto-join', async () => {
    const tgFetch = vi.fn().mockResolvedValue(
      makeRes({ preview: invitePreview({ name: 'Друзья', alreadyMember: false }) }),
    );
    const onJoined = vi.fn();

    render(
      <JoinView tgFetch={tgFetch} locale="ru" token="tok-2" onJoined={onJoined} onDecline={vi.fn()} pushToast={vi.fn()} />,
    );

    // Preview UI is present: kicker, circle name, join CTA.
    expect(await screen.findByText('Друзья')).toBeInTheDocument();
    expect(screen.getByText(t('circle_join_kicker', 'ru'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('circle_join_cta', 'ru') })).toBeInTheDocument();
    expect(onJoined).not.toHaveBeenCalled();
  });

  it('shows the invalid-link state and never calls onJoined when the preview fetch fails', async () => {
    const tgFetch = vi.fn().mockResolvedValue(makeRes({}, { ok: false, status: 404 }));
    const onJoined = vi.fn();

    render(
      <JoinView tgFetch={tgFetch} locale="ru" token="bad" onJoined={onJoined} onDecline={vi.fn()} pushToast={vi.fn()} />,
    );

    expect(await screen.findByText(t('circle_invite_invalid', 'ru'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('circle_join_cta', 'ru') })).toBeNull();
    expect(onJoined).not.toHaveBeenCalled();
  });
});

describe('CirclesRoot › join deep-link wiring (fix #5, through the root)', () => {
  it('an existing member entering via their own invite link lands in the circle detail, not the preview', async () => {
    const tgFetch = vi.fn((url: string) => {
      if (url === '/tg/circles/invite/tok') {
        return Promise.resolve(makeRes({ preview: invitePreview({ circleId: 'c1', name: 'Семья', alreadyMember: true }) }));
      }
      if (url === '/tg/circles/c1') {
        return Promise.resolve(
          makeRes({ circle: { id: 'c1', name: 'Семья', type: 'FAMILY', emoji: null, myRole: 'OWNER', memberCount: 1, capacity: 8, members: [] } }),
        );
      }
      return Promise.resolve(makeRes({}, { ok: false, status: 404 }));
    });

    render(
      <CirclesRoot tgFetch={tgFetch} locale="ru" initial={{ view: 'join', token: 'tok' }} onExit={vi.fn()} onUpsell={vi.fn()} pushToast={vi.fn()} />,
    );

    // Redirect resolved into the DetailView (header shows the circle name)…
    expect(await screen.findByText(/Семья/)).toBeInTheDocument();
    // …which means the detail endpoint was fetched (onJoined → setView('detail')).
    expect(tgFetch).toHaveBeenCalledWith('/tg/circles/c1');
    // The join preview CTA never appeared.
    expect(screen.queryByRole('button', { name: t('circle_join_cta', 'ru') })).toBeNull();
  });
});

// ── fix #2 — MemberView tap opens the in-app detail, not the store ─────────────

describe('CirclesRoot › MemberView tap-opens-detail (fix #2)', () => {
  let openLink: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openLink = vi.fn();
    vi.stubGlobal('Telegram', { WebApp: { openLink } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('tapping an item row opens the in-app detail sheet and does NOT open the store', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const tgFetch = vi.fn().mockResolvedValue(makeRes(memberWishlists([item()])));

    render(<MemberView tgFetch={tgFetch} locale="ru" circleId="c1" memberId="m1" onBack={vi.fn()} onConfigureShares={vi.fn()} pushToast={vi.fn()} />);

    const row = await screen.findByText('Подарок');
    // Sheet is closed before the tap.
    expect(screen.queryByRole('button', { name: t('circle_close', 'ru') })).toBeNull();

    fireEvent.click(row);

    // The in-app detail sheet opened…
    expect(await screen.findByRole('button', { name: t('circle_close', 'ru') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('circle_open_in_store', 'ru') })).toBeInTheDocument();
    // …and nothing navigated to the store.
    expect(openLink).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('opens the store only via the explicit «Открыть в магазине» button inside the sheet', async () => {
    const tgFetch = vi.fn().mockResolvedValue(makeRes(memberWishlists([item({ url: 'https://shop.example/p/42' })])));

    render(<MemberView tgFetch={tgFetch} locale="ru" circleId="c1" memberId="m1" onBack={vi.fn()} onConfigureShares={vi.fn()} pushToast={vi.fn()} />);

    fireEvent.click(await screen.findByText('Подарок'));
    const storeBtn = await screen.findByRole('button', { name: t('circle_open_in_store', 'ru') });
    fireEvent.click(storeBtn);

    expect(openLink).toHaveBeenCalledTimes(1);
    expect(openLink).toHaveBeenCalledWith('https://shop.example/p/42');
  });
});

// ── fix #3 — surprise invariant inside the detail sheet ────────────────────────

describe('CirclesRoot › MemberView surprise invariant in the detail sheet (fix #3)', () => {
  beforeEach(() => {
    vi.stubGlobal('Telegram', { WebApp: { openLink: vi.fn() } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('owner self-view: the detail sheet shows no reserve control and no "taken" chip', async () => {
    // Server marks the list as the viewer's own (isSelf) and strips reservation state.
    const tgFetch = vi.fn().mockResolvedValue(
      makeRes(memberWishlists([item({ title: 'Личный подарок', reserved: false, reservedByMe: false })], { isSelf: true })),
    );

    render(<MemberView tgFetch={tgFetch} locale="ru" circleId="c1" memberId="me" onBack={vi.fn()} onConfigureShares={vi.fn()} pushToast={vi.fn()} />);

    const row = await screen.findByText('Личный подарок');
    // The surprise-safe reassurance banner is shown for the owner-self view.
    expect(screen.getByText(/Сюрприз в безопасности/)).toBeInTheDocument();
    // The row exposes no reserve control either.
    expect(screen.queryByRole('button', { name: /заброн/i })).toBeNull();

    fireEvent.click(row);

    // Sheet opened — but carries only the neutral controls.
    expect(await screen.findByRole('button', { name: t('circle_close', 'ru') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('circle_open_in_store', 'ru') })).toBeInTheDocument();
    // No reserve / unreserve button and no "taken" chip anywhere.
    expect(screen.queryByRole('button', { name: /заброн/i })).toBeNull();
    expect(screen.queryByText(t('circle_reserved_taken', 'ru'))).toBeNull();
  });

  it('co-member: an item reserved by someone else shows a neutral "taken" chip, never a reserver identity', async () => {
    const tgFetch = vi.fn().mockResolvedValue(
      makeRes(memberWishlists([item({ reserved: true, reservedByMe: false })], { isSelf: false })),
    );

    render(<MemberView tgFetch={tgFetch} locale="ru" circleId="c1" memberId="m1" onBack={vi.fn()} onConfigureShares={vi.fn()} pushToast={vi.fn()} />);

    fireEvent.click(await screen.findByText('Подарок'));
    await screen.findByRole('button', { name: t('circle_close', 'ru') });

    // The only reservation indicator is the neutral chip with the exact text
    // «занято» — never a personalised "reserved by <name>" string. The wire
    // shape (ItemView) carries no reserver field, so identity can't leak; the
    // chip text staying exactly neutral is what we assert here.
    const takenChips = screen.getAllByText(t('circle_reserved_taken', 'ru'));
    expect(takenChips.length).toBeGreaterThan(0);
    takenChips.forEach((chip) => expect(chip.textContent).toBe(t('circle_reserved_taken', 'ru')));
    // No reserve / unreserve control (covers both «Забронировать» and «✓ ты забронировал»).
    expect(screen.queryByRole('button', { name: /заброн/i })).toBeNull();
  });

  it('co-member: an available item shows the reserve button', async () => {
    const tgFetch = vi.fn().mockResolvedValue(
      makeRes(memberWishlists([item({ reserved: false, reservedByMe: false })], { isSelf: false })),
    );

    render(<MemberView tgFetch={tgFetch} locale="ru" circleId="c1" memberId="m1" onBack={vi.fn()} onConfigureShares={vi.fn()} pushToast={vi.fn()} />);

    await screen.findByText('Подарок');
    expect(screen.getByRole('button', { name: t('circle_reserve', 'ru') })).toBeInTheDocument();
  });
});

// ── owner self-view empty state offers a "choose lists" CTA ───────────────────

describe('CirclesRoot › MemberView owner-self empty state CTA', () => {
  it('owner with nothing shared sees a CTA that opens the share picker (not a dead-end)', async () => {
    const tgFetch = vi.fn().mockResolvedValue(makeRes(memberWishlists([], { isSelf: true, wishlists: [] })));
    const onConfigureShares = vi.fn();

    render(<MemberView tgFetch={tgFetch} locale="ru" circleId="c1" memberId="me" onBack={vi.fn()} onConfigureShares={onConfigureShares} pushToast={vi.fn()} />);

    const cta = await screen.findByRole('button', { name: t('circle_self_empty_cta', 'ru') });
    expect(screen.getByText(t('circle_self_empty_title', 'ru'))).toBeInTheDocument();
    // The plain dead-end empty text is NOT used for the owner-self view.
    expect(screen.queryByText(t('circle_member_empty', 'ru'))).toBeNull();

    fireEvent.click(cta);
    expect(onConfigureShares).toHaveBeenCalledTimes(1);
  });

  it('a co-member viewing an empty list sees the plain empty text and no CTA', async () => {
    const tgFetch = vi.fn().mockResolvedValue(makeRes(memberWishlists([], { isSelf: false, wishlists: [] })));
    const onConfigureShares = vi.fn();

    render(<MemberView tgFetch={tgFetch} locale="ru" circleId="c1" memberId="m1" onBack={vi.fn()} onConfigureShares={onConfigureShares} pushToast={vi.fn()} />);

    expect(await screen.findByText(t('circle_member_empty', 'ru'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('circle_self_empty_cta', 'ru') })).toBeNull();
    expect(onConfigureShares).not.toHaveBeenCalled();
  });
});

// ── bug 1 — destructive group actions require confirmation ─────────────────────

describe('CirclesRoot › DetailView delete/leave confirmation (bug 1)', () => {
  it('owner: tapping «Удалить группу» opens a confirmation and does NOT delete yet', async () => {
    const tgFetch = detailFetch(circleDetail({ myRole: 'OWNER', name: 'Семья' }));
    const { onLeft } = renderDetail(tgFetch);

    await screen.findByText(/Семья/);
    fireEvent.click(screen.getByRole('button', { name: /Настроить/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Удалить группу/ }));

    // A confirmation question naming the group is shown…
    expect(await screen.findByText(/Удалить группу «Семья»\?/)).toBeInTheDocument();
    // …and the menu tap alone deleted nothing.
    expect(tgFetch).not.toHaveBeenCalledWith('/tg/circles/c1', deleteCall());
    expect(onLeft).not.toHaveBeenCalled();
  });

  it('owner: confirming deletes the group and exits', async () => {
    const tgFetch = detailFetch(circleDetail({ myRole: 'OWNER', name: 'Семья' }));
    const { onLeft } = renderDetail(tgFetch);

    await screen.findByText(/Семья/);
    fireEvent.click(screen.getByRole('button', { name: /Настроить/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Удалить группу/ }));
    // Confirm via the sheet's plain «Удалить группу» button (the menu's
    // emoji-prefixed one is unmounted once the confirm sheet opens).
    fireEvent.click(await screen.findByRole('button', { name: 'Удалить группу' }));

    await waitFor(() => expect(tgFetch).toHaveBeenCalledWith('/tg/circles/c1', deleteCall()));
    await waitFor(() => expect(onLeft).toHaveBeenCalledTimes(1));
  });

  it('owner: cancelling keeps the group', async () => {
    const tgFetch = detailFetch(circleDetail({ myRole: 'OWNER', name: 'Семья' }));
    const { onLeft } = renderDetail(tgFetch);

    await screen.findByText(/Семья/);
    fireEvent.click(screen.getByRole('button', { name: /Настроить/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Удалить группу/ }));
    fireEvent.click(await screen.findByRole('button', { name: t('circle_cancel', 'ru') }));

    expect(tgFetch).not.toHaveBeenCalledWith('/tg/circles/c1', deleteCall());
    expect(onLeft).not.toHaveBeenCalled();
    expect(screen.queryByText(/Удалить группу «Семья»\?/)).toBeNull();
  });

  it('member: leaving also requires confirmation before it fires', async () => {
    const tgFetch = detailFetch(circleDetail({ myRole: 'MEMBER', name: 'Друзья' }));
    const { onLeft } = renderDetail(tgFetch);

    await screen.findByText(/Друзья/);
    fireEvent.click(screen.getByRole('button', { name: /Настроить/ }));
    // A member sees «Выйти из группы» (leave), not delete.
    fireEvent.click(await screen.findByRole('button', { name: t('circle_leave', 'ru') }));

    expect(await screen.findByText(/Выйти из группы «Друзья»\?/)).toBeInTheDocument();
    expect(tgFetch).not.toHaveBeenCalledWith('/tg/circles/c1/leave', leavePost());

    fireEvent.click(screen.getByRole('button', { name: t('circle_leave', 'ru') }));
    await waitFor(() => expect(tgFetch).toHaveBeenCalledWith('/tg/circles/c1/leave', leavePost()));
    await waitFor(() => expect(onLeft).toHaveBeenCalledTimes(1));
  });
});

// ── MemberView error state — no dead loader on a stale deep-link / 404 ─────────
// A P0.2 feed CTA (and a P0.3 event push) can deep-link to a member who has
// since left (404). The view must NOT hang on CenteredLoader forever — it
// bounces back to the previous screen with a toast.

describe('CirclesRoot › MemberView error state (stale deep-link / 404)', () => {
  it('bounces back with a toast instead of hanging when the member load 404s', async () => {
    const onBack = vi.fn();
    const pushToast = vi.fn();
    const tgFetch = vi.fn().mockResolvedValue(makeRes({}, { ok: false, status: 404 }));

    render(<MemberView tgFetch={tgFetch} locale="ru" circleId="c1" memberId="m1" onBack={onBack} onConfigureShares={vi.fn()} pushToast={pushToast} />);

    // 404 → bounce out (onBack) + an error toast — never an endless loader.
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
    expect(pushToast).toHaveBeenCalledWith(t('circle_err_generic', 'ru'), 'error');
  });
});
