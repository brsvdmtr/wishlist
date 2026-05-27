// First-touch source attribution beacon for the Mini App bootstrap.
//
// Wraps POST /tg/analytics/attribution into a fire-and-forget call that
// records UserProfile.firstAcquisitionSource on the very first share-link
// open. The backend handler is first-touch-only (atomic updateMany WHERE
// firstAcquisitionSource IS NULL), so repeat calls for the same user are
// safe no-ops.
//
// This signal feeds `evaluateGuestConversion` in services/wishlists.ts —
// users who arrived via shared content and then create their first regular
// wishlist trigger the `guest.converted_to_user` product event.
//
// `tgFetch` is passed in rather than imported because it lives as a
// closure inside MiniApp.tsx (see :4898) and is not exported — extracted
// screen modules (CalendarRoot, SurveyScreen, …) follow the same pattern.

export type SharedAcquisitionSource =
  | 'share_link'
  | 'curated_selection'
  | 'public_profile';

type TgFetch = (url: string, init?: RequestInit) => Promise<Response>;

export function fireAttributionBeacon(
  tgFetch: TgFetch,
  source: SharedAcquisitionSource,
  ref?: string | null,
): void {
  tgFetch('/tg/analytics/attribution', {
    method: 'POST',
    body: JSON.stringify({
      source,
      medium: 'miniapp',
      ref: ref ?? undefined,
    }),
  }).catch(() => {});
}
