// Reason taxonomy for `referral.screen_load_failed` and
// `referral.history_load_failed` analytics events.
//
// Without a tagged reason, the dashboard can't tell expected failures
// (e.g. 401 because initData expired right before the request) from real
// breakage (5xx upstream). Pre-launch we saw 3 events in prod with an
// empty `reason` prop — useless for triage. This helper maps the response
// status (or the absence of a response, i.e. network throw) to one of
// five buckets so launch metrics can sort signal from noise.
//
// Note: program-disabled is NOT a failure reason here — the /tg/referral/me
// route returns 200 OK with `enabled: false` when the program is off, so
// the UI renders a placeholder rather than firing screen_load_failed.

export type ReferralLoadFailReason =
  | 'unauthorized'   // HTTP 401 — initData expired / not yet ready
  | 'forbidden'      // HTTP 403 — rate-limited / blocked
  | 'server_error'   // HTTP 5xx — upstream down or bug
  | 'client_error'   // other 4xx — protocol mismatch, validation
  | 'fetch_error';   // network / timeout / parse — no HTTP status

/**
 * Map an HTTP status (or `undefined` if the request never produced one) to
 * a stable analytics-event `reason` tag. Keep this pure — it runs inside
 * a `catch` block and must not throw or allocate beyond the return value.
 */
export function inferReferralLoadFailReason(httpStatus: number | undefined): ReferralLoadFailReason {
  if (httpStatus === undefined) return 'fetch_error';
  if (httpStatus === 401) return 'unauthorized';
  if (httpStatus === 403) return 'forbidden';
  if (httpStatus >= 500) return 'server_error';
  if (httpStatus >= 400) return 'client_error';
  // 2xx/3xx shouldn't reach here — caller only invokes on !res.ok or thrown
  // catch — but if it does, treat as fetch_error to avoid mislabelling.
  return 'fetch_error';
}
