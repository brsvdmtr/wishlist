// Cross-user reservation predicate — the gate every owner-side notification
// must pass before firing. Returns `true` only when the reserver and the
// owner are distinct users.
//
// Self-reservation is allowed by the public reserve route (used as a
// bookmark flow in practice) but pushing "X reserved your wish" + a deep
// link to navigate to it is noise when X = the recipient. Per CLAUDE.md
// feedback_notification_explicit_relations: bot notifications fire only
// for genuine cross-user relationships.
//
// Four call sites depend on this exact equality:
//   - routes/reservations.routes.ts (public reserve)
//   - routes/reservations.routes.ts (secret→public promotion)
//   - schedulers/reservations.ts    (smart-res auto-release: owner + gifter)
//   - schedulers/reservations.ts    (smart-res reminder: gifter)
// Extracted per CLAUDE.md testing iron rule (≥2× duplication → named
// function with unit test). Keeping the predicate pure and id-typed forces
// every caller to acknowledge the comparison rather than inlining a
// `!==` against a string they happened to have in scope.

export function isCrossUserReservation(reserverUserId: string, wishlistOwnerId: string): boolean {
  return reserverUserId !== wishlistOwnerId;
}
