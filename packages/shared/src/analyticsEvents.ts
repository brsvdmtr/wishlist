export const ANALYTICS_EVENTS = [
  'bot.start_received',
  'miniapp.open_attempt',
  'miniapp.tg_context_detected',
  'miniapp.initdata_present',
  'miniapp.bootstrap_started',
  'miniapp.bootstrap_succeeded',
  'miniapp.bootstrap_failed',
  'miniapp.first_rendered',
  'miniapp.boot_timeout',
  'miniapp.fatal_render_error',
  'wishlist.created',
  'wish.created',
  'import.started',
  'import.succeeded',
  'import.failed',
  'guest.view_opened',
  'reservation.succeeded',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];
