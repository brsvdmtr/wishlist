// Shared types for the Events Calendar feature.
//
// Shapes mirror what /tg/gift-occasions* and /tg/calendar/* endpoints return.

import type { Locale } from '@wishlist/shared';

export type EventType = 'BIRTHDAY' | 'ANNIVERSARY' | 'HOLIDAY' | 'OTHER';
export type EventRecurrence = 'NONE' | 'YEARLY' | 'MONTHLY';
export type EventStatus = 'ACTIVE' | 'DONE' | 'ARCHIVED';
export type EventSource = 'USER' | 'IMPORTED_FRIEND' | 'IMPORTED_HOLIDAY';
export type CalendarView = 'month' | 'week' | 'list' | 'year';

export interface LinkedUserSummary {
  id: string;
  firstName: string | null;
  profile?: {
    displayName: string | null;
    username: string | null;
    avatarThumbUrl: string | null;
    avatarUrl: string | null;
    birthday?: string | null;
    hideYear?: boolean;
  } | null;
}

export interface LinkedWishlistSummary {
  id: string;
  slug: string;
  title: string;
  emoji: string | null;
  ownerId?: string;
}

export interface LinkedSantaSummary {
  id: string;
  title: string;
  status: string;
  drawAt: string | null;
  _count: { participants: number };
}

export interface OccasionListItem {
  id: string;
  title: string;
  type: EventType;
  personName: string | null;
  eventDate: string | null;
  recurrence: EventRecurrence;
  note: string | null;
  status: EventStatus;
  emoji: string | null;
  eventTime: string | null;
  location: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  budgetCurrency: string | null;
  source: EventSource;
  holidayKey: string | null;
  country: string | null;
  linkedUserId: string | null;
  linkedWishlistId: string | null;
  linkedSantaId: string | null;
  actualGiftText: string | null;
  actualGiftAmount: number | null;
  actualGiftCurrency: string | null;
  thankYouNote: string | null;
  thankYouAt: string | null;
  archivedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Server-derived
  nextDate: string | null;
  daysUntil: number | null;
  ideasCount: number;
  remindersCount: number;
  // Linked
  linkedUser: LinkedUserSummary | null;
  linkedWishlist: LinkedWishlistSummary | null;
}

export interface OccasionReminder {
  id: string;
  occasionId: string;
  ownerUserId: string;
  offsetDays: number;
  timeOfDay: string;
  enabled: boolean;
  scheduledFor: string | null;
  sentAt: string | null;
  delivered: boolean;
  episodeKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface OccasionIdea {
  id: string;
  occasionId: string;
  text: string;
  link: string | null;
  price: number | null;
  currency: string | null;
  note: string | null;
  imageUrl: string | null;
  status: EventStatus;
  createdAt: string;
}

export interface WishlistItemPreview {
  id: string;
  title: string;
  priceText: string | null;
  imageUrl: string | null;
  sourceDomain: string | null;
}

export interface OccasionDetail extends OccasionListItem {
  ideas: OccasionIdea[];
  reminders: OccasionReminder[];
  linkedSanta: LinkedSantaSummary | null;
  linkedWishlistItems: WishlistItemPreview[];
}

export interface HolidayItem {
  id: string;
  country: string;
  month: number;
  day: number;
  key: string;
  emoji: string;
  category: string;
  ordinal: number;
  nameRu: string | null;
  nameEn: string | null;
  nameZhCn: string | null;
  nameHi: string | null;
  nameEs: string | null;
  nameAr: string | null;
  alreadyImported: boolean;
}

export interface FriendBdayItem {
  userId: string;
  displayName: string | null;
  username: string | null;
  avatarThumbUrl: string | null;
  birthday: string | null;
  hideYear: boolean;
  alreadyImported: boolean;
}

export interface CalendarInboxItem {
  id: string;
  ownerUserId: string;
  occasionId: string | null;
  type: 'REMINDER' | 'EVENT_TODAY' | 'IDEAS_READY' | 'RESERVATION_CONFIRMED' | 'RECAP_READY' | 'THANKS_RECEIVED';
  emoji: string;
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
  occasion: { id: string; title: string; type: EventType; emoji: string | null } | null;
}

export interface YearRecapData {
  year: number;
  totals: {
    events: number;
    completed: number;
    birthdays: number;
    onTimePct: number;
    giftsGiven: number;
  };
  spend: { byCurrency: Record<string, number> };
  topRecipient: {
    userId: string;
    name: string;
    count: number;
    avatarUrl: string | null;
  } | null;
  perMonthGifts: number[]; // length=12
}

export interface TodayContext {
  soonest: {
    id: string;
    title: string;
    emoji: string | null;
    type: EventType;
    daysUntil: number;
    nextDate: string;
    ideasCount: number;
  } | null;
  /** ISO timestamp when the user finished/dismissed the calendar onboarding,
   * `null` if they haven't yet. Replaces a localStorage-only flag so the
   * onboarding doesn't repeat across devices. */
  onboardingSeenAt?: string | null;
}

/** Paywall entitlement state from /tg/me */
export interface CalendarEntitlement {
  unlocked: boolean;
  /** 'PRO' | 'ONE_TIME' | 'GOD' | 'addon' | null — narrowing intentionally loose
   * to accept the existing gnAccess state shape from MiniApp.tsx without coercion. */
  unlockType: string | null;
  priceXtr: number;
}

// Mapping from country code → preferred locale for default holiday list.
// User explicitly chooses, but this is the suggested default.
export const COUNTRY_FOR_LOCALE: Record<Locale, string> = {
  ru: 'RU',
  en: 'US',
  'zh-CN': 'CN',
  hi: 'IN',
  ar: 'SA',
  es: 'ES',
};

// Theme inference helper used across views.
export type EventTheme = 'bday' | 'anniversary' | 'holiday' | 'today' | 'custom';

export function inferTheme(occasion: Pick<OccasionListItem, 'type' | 'daysUntil'>): EventTheme {
  if (occasion.daysUntil === 0) return 'today';
  if (occasion.type === 'BIRTHDAY') return 'bday';
  if (occasion.type === 'ANNIVERSARY') return 'anniversary';
  if (occasion.type === 'HOLIDAY') return 'holiday';
  return 'custom';
}

export function defaultEmojiForType(type: EventType): string {
  switch (type) {
    case 'BIRTHDAY': return '🎂';
    case 'ANNIVERSARY': return '💍';
    case 'HOLIDAY': return '🎉';
    default: return '📅';
  }
}
