// Typed wrappers around the parent MiniApp's tgFetch helper.
//
// We don't import tgFetch directly — it's a closure inside MiniApp.tsx with
// access to initData/apiBase. CalendarRoot receives it as a prop and forwards
// here. Each function returns the parsed JSON or throws.

import type {
  OccasionListItem, OccasionDetail, OccasionReminder,
  HolidayItem, FriendBdayItem, CalendarInboxItem, YearRecapData, TodayContext,
  EventType, EventRecurrence,
} from './types';

export type TgFetch = (path: string, init?: RequestInit & { timeoutMs?: number }) => Promise<Response>;

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ─── Occasions CRUD ────────────────────────────────────────────────────────

export async function listOccasions(tg: TgFetch): Promise<{ occasions: OccasionListItem[] }> {
  const r = await tg('/tg/gift-occasions');
  return jsonOrThrow(r);
}

export async function getOccasion(tg: TgFetch, id: string): Promise<{ occasion: OccasionDetail }> {
  const r = await tg(`/tg/gift-occasions/${id}`);
  return jsonOrThrow(r);
}

export interface CreateOccasionPayload {
  title: string;
  type?: EventType;
  personName?: string;
  eventDate?: string;
  recurrence?: EventRecurrence;
  note?: string;
  emoji?: string;
  eventTime?: string;
  location?: string;
  budgetMin?: number;
  budgetMax?: number;
  budgetCurrency?: string;
  linkedUserId?: string;
  linkedWishlistId?: string;
  linkedSantaId?: string;
  defaultReminders?: boolean;
}

export async function createOccasion(tg: TgFetch, data: CreateOccasionPayload): Promise<{ occasion: OccasionListItem }> {
  const r = await tg('/tg/gift-occasions', { method: 'POST', body: JSON.stringify(data) });
  return jsonOrThrow(r);
}

export type UpdateOccasionPayload = Partial<CreateOccasionPayload> & {
  actualGiftText?: string | null;
  actualGiftAmount?: number | null;
  actualGiftCurrency?: string | null;
  thankYouNote?: string | null;
};

export async function updateOccasion(tg: TgFetch, id: string, data: UpdateOccasionPayload): Promise<{ occasion: OccasionListItem }> {
  const r = await tg(`/tg/gift-occasions/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
  return jsonOrThrow(r);
}

export async function deleteOccasion(tg: TgFetch, id: string): Promise<{ ok: true }> {
  const r = await tg(`/tg/gift-occasions/${id}`, { method: 'DELETE' });
  return jsonOrThrow(r);
}

export async function archiveOccasion(tg: TgFetch, id: string): Promise<{ ok: true }> {
  const r = await tg(`/tg/gift-occasions/${id}/archive`, { method: 'POST' });
  return jsonOrThrow(r);
}

export async function completeOccasion(tg: TgFetch, id: string): Promise<{ ok: true }> {
  const r = await tg(`/tg/gift-occasions/${id}/complete`, { method: 'POST' });
  return jsonOrThrow(r);
}

// ─── Reminders CRUD ────────────────────────────────────────────────────────

export async function createReminder(tg: TgFetch, occasionId: string, data: { offsetDays: number; timeOfDay?: string; enabled?: boolean }): Promise<{ reminder: OccasionReminder }> {
  const r = await tg(`/tg/gift-occasions/${occasionId}/reminders`, { method: 'POST', body: JSON.stringify(data) });
  return jsonOrThrow(r);
}

export async function updateReminder(tg: TgFetch, occasionId: string, rid: string, data: Partial<{ offsetDays: number; timeOfDay: string; enabled: boolean }>): Promise<{ reminder: OccasionReminder }> {
  const r = await tg(`/tg/gift-occasions/${occasionId}/reminders/${rid}`, { method: 'PATCH', body: JSON.stringify(data) });
  return jsonOrThrow(r);
}

export async function deleteReminder(tg: TgFetch, occasionId: string, rid: string): Promise<{ ok: true }> {
  const r = await tg(`/tg/gift-occasions/${occasionId}/reminders/${rid}`, { method: 'DELETE' });
  return jsonOrThrow(r);
}

// ─── Holidays + friends imports ─────────────────────────────────────────────

export async function listHolidays(tg: TgFetch, country: string): Promise<{ country: string; holidays: HolidayItem[] }> {
  const r = await tg(`/tg/calendar/holidays?country=${encodeURIComponent(country)}`);
  return jsonOrThrow(r);
}

export async function importHolidays(tg: TgFetch, keys: string[], locale: string): Promise<{ imported: number }> {
  const r = await tg('/tg/calendar/import-holidays', { method: 'POST', body: JSON.stringify({ keys, locale }) });
  return jsonOrThrow(r);
}

export async function listFriendsBdays(tg: TgFetch): Promise<{ friends: FriendBdayItem[] }> {
  const r = await tg('/tg/calendar/friends-bdays');
  return jsonOrThrow(r);
}

export async function importFriendsBdays(tg: TgFetch, userIds: string[]): Promise<{ imported: number }> {
  const r = await tg('/tg/calendar/import-friends-bdays', { method: 'POST', body: JSON.stringify({ userIds }) });
  return jsonOrThrow(r);
}

// ─── Inbox ─────────────────────────────────────────────────────────────────

export async function getInbox(tg: TgFetch): Promise<{ entries: CalendarInboxItem[]; unread: number }> {
  const r = await tg('/tg/calendar/inbox');
  return jsonOrThrow(r);
}

export async function markInboxRead(tg: TgFetch, id: string): Promise<{ ok: true }> {
  const r = await tg(`/tg/calendar/inbox/${id}/read`, { method: 'POST' });
  return jsonOrThrow(r);
}

export async function markInboxAllRead(tg: TgFetch): Promise<{ ok: true }> {
  const r = await tg('/tg/calendar/inbox/read-all', { method: 'POST' });
  return jsonOrThrow(r);
}

// ─── Today + recap ─────────────────────────────────────────────────────────

export async function getTodayContext(tg: TgFetch): Promise<TodayContext> {
  const r = await tg('/tg/calendar/today-context');
  return jsonOrThrow(r);
}

export async function getYearRecap(tg: TgFetch, year: number): Promise<YearRecapData> {
  const r = await tg(`/tg/calendar/year-recap?year=${year}`);
  return jsonOrThrow(r);
}

// ─── Stars checkout (paywall) ──────────────────────────────────────────────

export interface CheckoutResult {
  ok: boolean;
  alreadyUnlocked?: boolean;
  invoiceUrl?: string;
  error?: string;
}

export async function checkoutGiftNotes(tg: TgFetch): Promise<CheckoutResult> {
  const r = await tg('/tg/billing/gift-notes/checkout', { method: 'POST', body: JSON.stringify({}) });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    return { ok: false, error: `${r.status}: ${body.slice(0, 200)}` };
  }
  const data = await r.json() as { invoiceUrl?: string; alreadyUnlocked?: boolean };
  if (data.alreadyUnlocked) return { ok: true, alreadyUnlocked: true };
  return { ok: !!data.invoiceUrl, invoiceUrl: data.invoiceUrl };
}

export interface SyncResult { giftNotes: { unlocked: boolean; unlockType: 'PRO' | 'ONE_TIME' | 'GOD' | null; priceXtr: number } }

export async function syncGiftNotes(tg: TgFetch): Promise<SyncResult> {
  const r = await tg('/tg/billing/gift-notes/sync', { method: 'POST' });
  return jsonOrThrow(r);
}
