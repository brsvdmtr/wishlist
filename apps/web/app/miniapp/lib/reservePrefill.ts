// Display-name prefill helper for the public-reserve BottomSheet (E15).
//
// Priority chain, top→bottom:
//   1. profile.displayName  — user's custom WishBoard handle (already an
//                             explicit personalization signal).
//   2. tg first + last      — full Telegram name when both are present.
//   3. tg first              — fallback to the legacy single-field prefill.
//   4. none                  — no identity available; leave the input empty.
//
// The 64-char cap matches the API contract on POST /tg/items/:id/reserve
// (`z.string().min(1).max(64)` in reservations.routes.ts).

export type ReservePrefillSource = 'profile' | 'tg_full' | 'tg_first' | 'none';

export interface ReservePrefillResult {
  value: string;
  source: ReservePrefillSource;
}

const MAX_DISPLAY_NAME_LEN = 64;

export function resolveReservePrefill(
  tgUser: { first_name?: string | null; last_name?: string | null } | null | undefined,
  profile: { displayName?: string | null } | null | undefined,
): ReservePrefillResult {
  const profileName = profile?.displayName?.trim();
  if (profileName) return { value: profileName.slice(0, MAX_DISPLAY_NAME_LEN), source: 'profile' };

  const first = tgUser?.first_name?.trim() ?? '';
  const last = tgUser?.last_name?.trim() ?? '';
  if (first && last) {
    return { value: `${first} ${last}`.slice(0, MAX_DISPLAY_NAME_LEN), source: 'tg_full' };
  }
  if (first) return { value: first.slice(0, MAX_DISPLAY_NAME_LEN), source: 'tg_first' };

  return { value: '', source: 'none' };
}
