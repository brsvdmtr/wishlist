// Display-name prefill helper for the public-reserve BottomSheet (E15).
//
// Priority chain, top→bottom:
//   1. profile.displayName  — user's custom WishBoard handle (already an
//                             explicit personalization signal). NOTE:
//                             loadProfile() is invoked fire-and-forget
//                             during bootstrap (MiniApp.tsx:9702), so
//                             by the time most guests open a reserve
//                             sheet the profile usually exists — but
//                             a guest who taps Reserve faster than the
//                             /tg/me/profile round-trip will see
//                             profileData=null. The race window is
//                             real for deeplink-then-tap flows, so the
//                             profile source is best-effort and prod
//                             analytics will skew toward
//                             tg_full / tg_first in practice.
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

// Matches the Zod `displayName: z.string().min(1).max(64)` cap on the API
// (apps/api/src/routes/reservations.routes.ts). Exported so the Mini App
// input can client-side `maxLength` to the same number — otherwise a long
// paste hits a 400 with a generic toast.
export const MAX_DISPLAY_NAME_LEN = 64;

// Code-point-safe slice. `String#slice` operates on UTF-16 code units, so a
// raw `.slice(0, 64)` on a string that ends mid-surrogate-pair produces an
// orphaned high surrogate and a visible "?" in the rendered name. Using
// `Array.from` splits at code-point boundaries (full surrogate pairs stay
// intact), which is the right cap for emoji-bearing names. This is not
// fully grapheme-cluster-aware (combining marks can still be split), but
// the user-visible artifact is negligible compared to a broken surrogate.
function capByCodePoints(s: string, max: number): string {
  const codePoints = Array.from(s);
  if (codePoints.length <= max) return s;
  return codePoints.slice(0, max).join('');
}

export function resolveReservePrefill(
  tgUser: { first_name?: string | null; last_name?: string | null } | null | undefined,
  profile: { displayName?: string | null } | null | undefined,
): ReservePrefillResult {
  const profileName = profile?.displayName?.trim();
  if (profileName) return { value: capByCodePoints(profileName, MAX_DISPLAY_NAME_LEN), source: 'profile' };

  const first = tgUser?.first_name?.trim() ?? '';
  const last = tgUser?.last_name?.trim() ?? '';
  if (first && last) {
    return { value: capByCodePoints(`${first} ${last}`, MAX_DISPLAY_NAME_LEN), source: 'tg_full' };
  }
  if (first) return { value: capByCodePoints(first, MAX_DISPLAY_NAME_LEN), source: 'tg_first' };

  return { value: '', source: 'none' };
}
