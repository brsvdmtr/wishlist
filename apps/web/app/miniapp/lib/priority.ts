// Priority constants + emoji helper extracted from MiniApp.tsx — F5.
// Pure module-level data + one trivial getter; consumed by wish-card
// primitives (WishCardCompact, WishCardShowcase, ReservationCard, etc.)
// and by SantaRoot's receiver wishlist view.
//
// Three priority levels are surfaced by the API:
//   1 — LOW    (blue-violet)
//   2 — MEDIUM (amber)
//   3 — HIGH   (coral-rose)
// Anything outside 1/2/3 falls back to LOW for safety.

/** Per-priority emoji used inside the priority chip on every wish card. */
export const PRIO_EMOJI: Record<number, string> = {
  1: '🙂',
  2: '😊',
  3: '😍',
};

/** Per-priority accent color (chip text, mini badge). */
export const PRIO_COLOR: Record<number, string> = {
  1: '#6B7FD4',
  2: '#E8930A',
  3: '#F04E6E',
};

/** Per-priority background tint (chip bg). */
export const PRIO_BG: Record<number, string> = {
  1: 'rgba(107,127,212,0.13)',
  2: 'rgba(232,147,10,0.13)',
  3: 'rgba(240,78,110,0.13)',
};

/** Per-priority top-strip gradient on wish cards. */
export const PRIO_GRADIENT: Record<number, string> = {
  1: 'linear-gradient(90deg, #6B7FD4, #818cf8)',
  2: 'linear-gradient(90deg, #E8930A, var(--wb-warning, #FBBF24))',
  3: 'linear-gradient(90deg, #F04E6E, #ff6b9d)',
};

/** Per-priority glow color used on showcase cards. */
export const PRIO_GLOW: Record<number, string> = {
  1: 'rgba(107,127,212,0.25)',
  2: 'rgba(232,147,10,0.3)',
  3: 'rgba(240,78,110,0.35)',
};

/** Get the priority emoji safely (defaults to LOW). */
export const prioEmoji = (p: number): string => PRIO_EMOJI[p] ?? '🙂';
