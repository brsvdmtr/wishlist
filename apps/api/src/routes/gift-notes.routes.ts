// Telegram-auth router for the "Gift Notes" / "Events Calendar v2.1" Pro
// feature — 26 handlers across 3 path groups:
//   /tg/gift-occasions/*       (11 handlers — occasion CRUD + reminders)
//   /tg/gift-occasion-ideas/*  ( 5 handlers — idea CRUD + photo upload)
//   /tg/calendar/*             (10 handlers — holidays, friends-bdays,
//                                inbox, today-context, year-recap,
//                                onboarding-seen)
//
// All 26 share the same Pro-gate (`requireGiftNotes`), the same Prisma
// tables (GiftOccasion / GiftOccasionIdea / GiftOccasionReminder /
// CalendarInboxEntry + reads of Holiday / UserProfile / Wishlist / Item),
// and the same closure deps. Combined into a single file because they're
// one logical feature with three UI surfaces (P5g audit recommendation).
//
// Mounted via `tgRouter.use(giftNotesRouter)` in apps/api/src/index.ts
// alongside meRouter / refRouter / supportRouter near the top — all
// closure deps are hoisted function declarations, so no TDZ-relocation
// is needed (unlike P5c / P5e / P5f).
//
// Helpers `requireGiftNotes` intentionally do
// NOT migrate — they are shared with the scheduler/cron logic in
// index.ts (gift-occasion reminder send loop at ~line 12760+ uses all
// three reminder helpers). They flow through this router via deps.
// `zUrl` likewise stays in index.ts (used by item/wishlist handlers
// and adminRouter deps).
//
// Same factory pattern as P4/P5a-f. Handler bodies byte-identical to
// their previous in-place definitions (only `tgRouter.` ->
// `giftNotesRouter.` + indent +2).

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '@wishlist/db';

import { asyncHandler } from '../lib/asyncHandler';
import { zodError } from '../lib/http';
import { upload } from '../uploads/upload.config';
import { processImage } from '../uploads/imageProcessor';
import { deleteUploadFile } from '../uploads/uploadCleanup';
import {
  getNextOccurrenceDate,
  computeReminderSchedule,
  buildReminderEpisodeKey,
} from '../services/calendar';

type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

// Minimal structural shape of the User row read by these handlers.
type GiftNotesUser = {
  id: string;
  godMode: boolean;
};

// Structural shape of getEffectiveEntitlements return that's actually
// read inside the 26 handlers. Beyond `hasGiftNotes` (consumed by
// requireGiftNotes) the cluster only reads `isPro` (one place) and
// `giftNotes` (one place — passed through to JSON unchanged), so we
// keep the dep type minimal and let the runtime payload's extra 15+
// fields ride through the index signature.
type GiftNotesEntitlements = {
  hasGiftNotes: boolean;
  isPro: boolean;
  giftNotes: unknown;
  [key: string]: unknown;
};

export type GiftNotesRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<GiftNotesUser>;
  getEffectiveEntitlements: (userId: string, godMode?: boolean) => Promise<GiftNotesEntitlements>;
  trackEvent: (event: string, userId?: string, props?: Record<string, unknown>) => void;
  // Pro-gate. Returns false (and writes 403 to res) when the user lacks
  // the Gift Notes entitlement; otherwise returns true and the handler
  // proceeds. Used in all 26 handlers.
  //
  // `ent` is typed `any` here intentionally: the actual function in
  // index.ts is signed `(ent: Awaited<ReturnType<typeof
  // getEffectiveEntitlements>>, res: any) => boolean` — i.e. it expects
  // the FULL 18-field entitlement payload as parameter. Mirroring that
  // structurally would force this dep contract to enumerate (and stay
  // in sync with) every field of the runtime payload. `any` here lets
  // the actual implementation satisfy the contract via TS bivariance
  // without forcing this file to track unrelated entitlement fields.
  requireGiftNotes: (ent: any, res: unknown) => boolean; // eslint-disable-line @typescript-eslint/no-explicit-any
  // URL validator factory — shared closure with adminRouter and
  // item/wishlist handlers in index.ts.
  zUrl: () => z.ZodTypeAny;
};

export function registerGiftNotesRouter(deps: GiftNotesRouterDeps): Router {
  const {
    getOrCreateTgUser,
    getEffectiveEntitlements,
    trackEvent,
    requireGiftNotes,
    zUrl,
  } = deps;

  const giftNotesRouter = Router();

  // ─── Gift Notes: Occasions CRUD + Ideas ──────────────────────────────
  giftNotesRouter.get('/gift-occasions', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const occasions = await prisma.giftOccasion.findMany({
      where: { ownerUserId: user.id },
      include: {
        _count: { select: { ideas: { where: { status: 'ACTIVE' } }, reminders: { where: { enabled: true } } } },
        linkedUser: { select: { id: true, firstName: true, profile: { select: { displayName: true, username: true, avatarThumbUrl: true, avatarUrl: true } } } },
        linkedWishlist: { select: { id: true, slug: true, title: true, emoji: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const mapped = occasions.map(o => {
      const nextDate = o.eventDate ? getNextOccurrenceDate(o.eventDate, o.recurrence) : null;
      const daysUntil = nextDate ? Math.round((nextDate.getTime() - Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())) / (24 * 3600 * 1000)) : null;
      return {
        ...o,
        eventDate: o.eventDate?.toISOString() ?? null,
        nextDate: nextDate?.toISOString() ?? null,
        daysUntil,
        ideasCount: o._count.ideas,
        remindersCount: o._count.reminders,
      };
    });
    // Sort: upcoming first (by daysUntil asc), no-date after, archived last
    mapped.sort((a, b) => {
      if (a.status === 'ARCHIVED' && b.status !== 'ARCHIVED') return 1;
      if (a.status !== 'ARCHIVED' && b.status === 'ARCHIVED') return -1;
      if (a.daysUntil != null && b.daysUntil != null) return a.daysUntil - b.daysUntil;
      if (a.daysUntil != null) return -1;
      if (b.daysUntil != null) return 1;
      return 0;
    });
    trackEvent('gift_notes_entry_opened', user.id);
    return res.json({ occasions: mapped });
  }));
  
  giftNotesRouter.post('/gift-occasions', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const parsed = z.object({
      title: z.string().min(1).max(150),
      type: z.enum(['BIRTHDAY', 'ANNIVERSARY', 'HOLIDAY', 'OTHER']).optional(),
      personName: z.string().max(50).optional(),
      eventDate: z.string().optional(),
      recurrence: z.enum(['NONE', 'YEARLY', 'MONTHLY']).optional(),
      note: z.string().max(300).optional(),
      emoji: z.string().max(8).optional(),
      eventTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      location: z.string().max(200).optional(),
      budgetMin: z.number().int().nonnegative().optional(),
      budgetMax: z.number().int().nonnegative().optional(),
      budgetCurrency: z.enum(['RUB', 'USD', 'EUR', 'GBP', 'CNY', 'INR', 'AED', 'SAR']).optional(),
      linkedUserId: z.string().cuid().optional(),
      linkedWishlistId: z.string().cuid().optional(),
      linkedSantaId: z.string().cuid().optional(),
      source: z.enum(['USER', 'IMPORTED_FRIEND', 'IMPORTED_HOLIDAY']).optional(),
      holidayKey: z.string().max(80).optional(),
      country: z.string().length(2).optional(),
      defaultReminders: z.boolean().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    let eventDateVal: Date | null = null;
    if (parsed.data.eventDate) {
      let iso = parsed.data.eventDate;
      const dot = iso.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (dot) iso = `${dot[3]}-${dot[2]!.padStart(2, '0')}-${dot[1]!.padStart(2, '0')}`;
      if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) eventDateVal = new Date(iso + 'T00:00:00Z');
    }
    if (parsed.data.linkedWishlistId) {
      const w = await prisma.wishlist.findUnique({ where: { id: parsed.data.linkedWishlistId }, select: { ownerId: true, visibility: true } });
      if (!w) return res.status(400).json({ error: 'linkedWishlist_not_found' });
      if (w.ownerId !== user.id && w.visibility === 'PRIVATE') return res.status(403).json({ error: 'linkedWishlist_forbidden' });
    }
    if (parsed.data.linkedSantaId) {
      const s = await prisma.santaCampaign.findUnique({ where: { id: parsed.data.linkedSantaId }, select: { ownerId: true, participants: { where: { userId: user.id }, select: { id: true } } } });
      if (!s) return res.status(400).json({ error: 'linkedSanta_not_found' });
      if (s.ownerId !== user.id && s.participants.length === 0) return res.status(403).json({ error: 'linkedSanta_forbidden' });
    }
    const occasion = await prisma.giftOccasion.create({
      data: {
        ownerUserId: user.id,
        title: parsed.data.title,
        type: parsed.data.type ?? 'OTHER',
        personName: parsed.data.personName ?? null,
        eventDate: eventDateVal,
        recurrence: eventDateVal ? (parsed.data.recurrence ?? 'NONE') : 'NONE',
        note: parsed.data.note ?? null,
        emoji: parsed.data.emoji ?? null,
        eventTime: parsed.data.eventTime ?? null,
        location: parsed.data.location ?? null,
        budgetMin: parsed.data.budgetMin ?? null,
        budgetMax: parsed.data.budgetMax ?? null,
        budgetCurrency: parsed.data.budgetCurrency ?? null,
        linkedUserId: parsed.data.linkedUserId ?? null,
        linkedWishlistId: parsed.data.linkedWishlistId ?? null,
        linkedSantaId: parsed.data.linkedSantaId ?? null,
        source: parsed.data.source ?? 'USER',
        holidayKey: parsed.data.holidayKey ?? null,
        country: parsed.data.country ?? null,
      },
    });
    if (parsed.data.defaultReminders !== false && eventDateVal) {
      const seeds = [{ off: -7, t: '10:00' }, { off: -1, t: '18:00' }, { off: 0, t: '09:00' }];
      for (const s of seeds) {
        const sched = computeReminderSchedule(eventDateVal, occasion.recurrence, s.off, s.t);
        const ek = buildReminderEpisodeKey(occasion.id, s.off, sched);
        await prisma.giftOccasionReminder.create({
          data: { occasionId: occasion.id, ownerUserId: user.id, offsetDays: s.off, timeOfDay: s.t, scheduledFor: sched, episodeKey: ek },
        });
      }
    }
    trackEvent('gift_occasion_created', user.id, { type: occasion.type, source: occasion.source });
    return res.status(201).json({ occasion });
  }));
  
  giftNotesRouter.get('/gift-occasions/:id', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const occasion = await prisma.giftOccasion.findUnique({
      where: { id: req.params.id },
      include: {
        ideas: { where: { status: { not: 'ARCHIVED' } }, orderBy: { createdAt: 'desc' } },
        reminders: { orderBy: { offsetDays: 'desc' } },
        linkedUser: { select: { id: true, firstName: true, profile: { select: { displayName: true, username: true, avatarThumbUrl: true, avatarUrl: true, birthday: true, hideYear: true } } } },
        linkedWishlist: { select: { id: true, slug: true, title: true, emoji: true, ownerId: true } },
        linkedSanta: { select: { id: true, title: true, status: true, drawAt: true, _count: { select: { participants: true } } } },
      },
    });
    if (!occasion || occasion.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
    const nextDate = occasion.eventDate ? getNextOccurrenceDate(occasion.eventDate, occasion.recurrence) : null;
    const daysUntil = nextDate ? Math.round((nextDate.getTime() - Date.now()) / (24 * 3600 * 1000)) : null;
    let linkedWishlistItems: Array<{ id: string; title: string; priceText: string | null; imageUrl: string | null; sourceDomain: string | null }> = [];
    if (occasion.linkedWishlistId) {
      const items = await prisma.item.findMany({
        where: { wishlistId: occasion.linkedWishlistId, status: 'AVAILABLE', archivedAt: null },
        orderBy: [{ priority: 'desc' }, { position: 'asc' }],
        take: 6,
        select: { id: true, title: true, priceText: true, imageUrl: true, sourceDomain: true },
      });
      linkedWishlistItems = items;
    }
    return res.json({
      occasion: {
        ...occasion,
        eventDate: occasion.eventDate?.toISOString() ?? null,
        nextDate: nextDate?.toISOString() ?? null,
        daysUntil,
        linkedWishlistItems,
      },
    });
  }));
  
  giftNotesRouter.patch('/gift-occasions/:id', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const occasion = await prisma.giftOccasion.findUnique({ where: { id: req.params.id } });
    if (!occasion || occasion.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
    const parsed = z.object({
      title: z.string().min(1).max(150).optional(),
      type: z.enum(['BIRTHDAY', 'ANNIVERSARY', 'HOLIDAY', 'OTHER']).optional(),
      personName: z.string().max(50).nullable().optional(),
      eventDate: z.string().nullable().optional(),
      recurrence: z.enum(['NONE', 'YEARLY', 'MONTHLY']).optional(),
      note: z.string().max(300).nullable().optional(),
      emoji: z.string().max(8).nullable().optional(),
      eventTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
      location: z.string().max(200).nullable().optional(),
      budgetMin: z.number().int().nonnegative().nullable().optional(),
      budgetMax: z.number().int().nonnegative().nullable().optional(),
      budgetCurrency: z.enum(['RUB', 'USD', 'EUR', 'GBP', 'CNY', 'INR', 'AED', 'SAR']).nullable().optional(),
      linkedUserId: z.string().cuid().nullable().optional(),
      linkedWishlistId: z.string().cuid().nullable().optional(),
      linkedSantaId: z.string().cuid().nullable().optional(),
      actualGiftText: z.string().max(300).nullable().optional(),
      actualGiftAmount: z.number().int().nonnegative().nullable().optional(),
      actualGiftCurrency: z.enum(['RUB', 'USD', 'EUR', 'GBP', 'CNY', 'INR', 'AED', 'SAR']).nullable().optional(),
      thankYouNote: z.string().max(500).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const data: any = { ...parsed.data };
    if (data.eventDate !== undefined) {
      if (!data.eventDate) { data.eventDate = null; } else {
        let iso = data.eventDate;
        const dot = iso.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
        if (dot) iso = `${dot[3]}-${dot[2]!.padStart(2, '0')}-${dot[1]!.padStart(2, '0')}`;
        data.eventDate = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T00:00:00Z') : null;
      }
    }
    if (data.thankYouNote !== undefined && data.thankYouNote) {
      data.thankYouAt = new Date();
    }
    const updated = await prisma.giftOccasion.update({ where: { id: req.params.id }, data });
    if (data.eventDate !== undefined || data.recurrence !== undefined) {
      const newDate = updated.eventDate;
      if (newDate) {
        const reminders = await prisma.giftOccasionReminder.findMany({ where: { occasionId: updated.id } });
        for (const r of reminders) {
          const sched = computeReminderSchedule(newDate, updated.recurrence, r.offsetDays, r.timeOfDay);
          const ek = buildReminderEpisodeKey(updated.id, r.offsetDays, sched);
          await prisma.giftOccasionReminder.update({
            where: { id: r.id },
            data: { scheduledFor: sched, episodeKey: ek, sentAt: null, delivered: false },
          });
        }
      }
    }
    trackEvent('gift_occasion_updated', user.id);
    return res.json({ occasion: updated });
  }));
  
  giftNotesRouter.delete('/gift-occasions/:id', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const occasion = await prisma.giftOccasion.findUnique({ where: { id: req.params.id } });
    if (!occasion || occasion.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
    // Hard delete — cascades to ideas via FK onDelete: Cascade
    await prisma.giftOccasion.delete({ where: { id: req.params.id } });
    trackEvent('gift_occasion_deleted', user.id);
    return res.json({ ok: true });
  }));
  
  giftNotesRouter.post('/gift-occasions/:id/archive', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const occasion = await prisma.giftOccasion.findUnique({ where: { id: req.params.id } });
    if (!occasion || occasion.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
    await prisma.giftOccasion.update({ where: { id: req.params.id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
    trackEvent('gift_occasion_archived', user.id);
    return res.json({ ok: true });
  }));
  
  giftNotesRouter.post('/gift-occasions/:id/complete', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const occasion = await prisma.giftOccasion.findUnique({ where: { id: req.params.id } });
    if (!occasion || occasion.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
    await prisma.giftOccasion.update({ where: { id: req.params.id }, data: { status: 'DONE', completedAt: new Date() } });
    trackEvent('gift_occasion_completed', user.id);
    return res.json({ ok: true });
  }));
  
  // ─── Gift Notes: Ideas CRUD ─────────────────────────────────────────────────
  
  giftNotesRouter.post('/gift-occasions/:id/ideas', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const occasion = await prisma.giftOccasion.findUnique({ where: { id: req.params.id } });
    if (!occasion || occasion.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
    const parsed = z.object({
      text: z.string().min(1).max(500),
      link: zUrl().nullable().optional(),
      price: z.number().int().nonnegative().nullable().optional(),
      currency: z.enum(['RUB', 'USD', 'EUR', 'GBP']).optional(),
      note: z.string().max(500).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const idea = await prisma.giftOccasionIdea.create({
      data: { occasionId: occasion.id, ownerUserId: user.id, text: parsed.data.text, link: parsed.data.link ?? null, price: parsed.data.price ?? null, currency: parsed.data.currency ?? null, note: parsed.data.note ?? null },
    });
    trackEvent('gift_idea_created', user.id, { occasionId: occasion.id });
    return res.status(201).json({ idea });
  }));
  
  giftNotesRouter.patch('/gift-occasion-ideas/:ideaId', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const idea = await prisma.giftOccasionIdea.findUnique({ where: { id: req.params.ideaId } });
    if (!idea || idea.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
    const parsed = z.object({
      text: z.string().min(1).max(500).optional(),
      link: z.string().nullable().optional(),
      price: z.number().int().nonnegative().nullable().optional(),
      currency: z.enum(['RUB', 'USD', 'EUR', 'GBP']).nullable().optional(),
      note: z.string().max(500).nullable().optional(),
      imageUrl: z.string().nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const updated = await prisma.giftOccasionIdea.update({ where: { id: req.params.ideaId }, data: parsed.data });
    trackEvent('gift_idea_updated', user.id);
    return res.json({ idea: updated });
  }));
  
  // POST /tg/gift-occasion-ideas/:ideaId/photo — upload or replace idea photo.
  // Mirrors the /items/:id/photo handler (sharp processing, /api/uploads, EXIF
  // stripping). Image lives at imageUrl; thumb is returned but not persisted —
  // idea cards use the same URL at smaller render sizes.
  giftNotesRouter.post('/gift-occasion-ideas/:ideaId/photo', upload.single('photo'), asyncHandler(async (req, res) => {
    const ideaId = req.params.ideaId ?? '';
    if (!ideaId) return res.status(400).json({ error: 'Missing idea id' });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
  
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const idea = await prisma.giftOccasionIdea.findUnique({ where: { id: ideaId }, select: { id: true, imageUrl: true, ownerUserId: true } });
    if (!idea || idea.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
  
    const [full, thumb] = await Promise.all([
      processImage(req.file.buffer, { maxDim: 1600, quality: 80, suffix: 'full' }),
      processImage(req.file.buffer, { maxDim: 480, quality: 70, suffix: 'thumb' }),
    ]);
    deleteUploadFile(idea.imageUrl);
    const photoUrl = `/api/uploads/${full.filename}`;
    await prisma.giftOccasionIdea.update({ where: { id: ideaId }, data: { imageUrl: photoUrl } });
    trackEvent('gift_idea_photo_uploaded', user.id);
    return res.json({ photoUrl, thumbUrl: `/api/uploads/${thumb.filename}`, width: full.width, height: full.height, sizeBytes: full.sizeBytes });
  }));
  
  giftNotesRouter.delete('/gift-occasion-ideas/:ideaId/photo', asyncHandler(async (req, res) => {
    const ideaId = req.params.ideaId ?? '';
    if (!ideaId) return res.status(400).json({ error: 'Missing idea id' });
  
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const idea = await prisma.giftOccasionIdea.findUnique({ where: { id: ideaId }, select: { id: true, imageUrl: true, ownerUserId: true } });
    if (!idea || idea.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
  
    deleteUploadFile(idea.imageUrl);
    await prisma.giftOccasionIdea.update({ where: { id: ideaId }, data: { imageUrl: null } });
    return res.json({ ok: true });
  }));
  
  giftNotesRouter.delete('/gift-occasion-ideas/:ideaId', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const idea = await prisma.giftOccasionIdea.findUnique({ where: { id: req.params.ideaId } });
    if (!idea || idea.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
    await prisma.giftOccasionIdea.update({ where: { id: req.params.ideaId }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
    trackEvent('gift_idea_archived', user.id);
    return res.json({ ok: true });
  }));
  
  giftNotesRouter.post('/gift-occasion-ideas/:ideaId/complete', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const idea = await prisma.giftOccasionIdea.findUnique({ where: { id: req.params.ideaId } });
    if (!idea || idea.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
    await prisma.giftOccasionIdea.update({ where: { id: req.params.ideaId }, data: { status: 'DONE', completedAt: new Date() } });
    trackEvent('gift_idea_completed', user.id);
    return res.json({ ok: true });
  }));

  // ─── Events Calendar v2.1: reminders, holidays, friends-bdays, inbox ──
  giftNotesRouter.post('/gift-occasions/:id/reminders', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const occasion = await prisma.giftOccasion.findUnique({ where: { id: req.params.id } });
    if (!occasion || occasion.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
    const parsed = z.object({
      offsetDays: z.number().int().min(-30).max(30),
      timeOfDay: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      enabled: z.boolean().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const sched = occasion.eventDate ? computeReminderSchedule(occasion.eventDate, occasion.recurrence, parsed.data.offsetDays, parsed.data.timeOfDay ?? '10:00') : null;
    const ek = sched ? buildReminderEpisodeKey(occasion.id, parsed.data.offsetDays, sched) : `occ_${occasion.id}_off${parsed.data.offsetDays}_unscheduled_${Date.now()}`;
    const reminder = await prisma.giftOccasionReminder.create({
      data: {
        occasionId: occasion.id,
        ownerUserId: user.id,
        offsetDays: parsed.data.offsetDays,
        timeOfDay: parsed.data.timeOfDay ?? '10:00',
        enabled: parsed.data.enabled ?? true,
        scheduledFor: sched,
        episodeKey: ek,
      },
    });
    trackEvent('gift_reminder_created', user.id, { occasionId: occasion.id, offsetDays: parsed.data.offsetDays });
    return res.status(201).json({ reminder });
  }));
  
  giftNotesRouter.patch('/gift-occasions/:id/reminders/:rid', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const reminder = await prisma.giftOccasionReminder.findUnique({ where: { id: req.params.rid }, include: { occasion: true } });
    if (!reminder || reminder.ownerUserId !== user.id || reminder.occasionId !== req.params.id) return res.status(404).json({ error: 'Not found' });
    const parsed = z.object({
      offsetDays: z.number().int().min(-30).max(30).optional(),
      timeOfDay: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      enabled: z.boolean().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const data: any = { ...parsed.data };
    if ((parsed.data.offsetDays !== undefined || parsed.data.timeOfDay !== undefined) && reminder.occasion.eventDate) {
      const offset = parsed.data.offsetDays ?? reminder.offsetDays;
      const time = parsed.data.timeOfDay ?? reminder.timeOfDay;
      const sched = computeReminderSchedule(reminder.occasion.eventDate, reminder.occasion.recurrence, offset, time);
      data.scheduledFor = sched;
      data.episodeKey = buildReminderEpisodeKey(reminder.occasionId, offset, sched);
      data.sentAt = null;
      data.delivered = false;
    }
    const updated = await prisma.giftOccasionReminder.update({ where: { id: reminder.id }, data });
    return res.json({ reminder: updated });
  }));
  
  giftNotesRouter.delete('/gift-occasions/:id/reminders/:rid', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const reminder = await prisma.giftOccasionReminder.findUnique({ where: { id: req.params.rid } });
    if (!reminder || reminder.ownerUserId !== user.id || reminder.occasionId !== req.params.id) return res.status(404).json({ error: 'Not found' });
    await prisma.giftOccasionReminder.delete({ where: { id: reminder.id } });
    return res.json({ ok: true });
  }));
  
  giftNotesRouter.get('/calendar/holidays', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const country = z.string().length(2).safeParse(req.query.country).success
      ? String(req.query.country).toUpperCase()
      : null;
    if (!country) return res.status(400).json({ error: 'country_required' });
    const holidays = await prisma.holiday.findMany({
      where: { country },
      orderBy: [{ ordinal: 'asc' }, { month: 'asc' }, { day: 'asc' }],
    });
    const imported = await prisma.giftOccasion.findMany({
      where: { ownerUserId: user.id, source: 'IMPORTED_HOLIDAY', country },
      select: { holidayKey: true },
    });
    const importedSet = new Set(imported.map(i => i.holidayKey).filter((k): k is string => !!k));
    return res.json({
      country,
      holidays: holidays.map(h => ({ ...h, alreadyImported: h.key ? importedSet.has(h.key) : false })),
    });
  }));
  
  giftNotesRouter.post('/calendar/import-holidays', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const parsed = z.object({
      keys: z.array(z.string().min(1).max(80)).min(1).max(50),
      locale: z.enum(['ru', 'en', 'zh-CN', 'hi', 'es', 'ar']).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const holidays = await prisma.holiday.findMany({ where: { key: { in: parsed.data.keys } } });
    const locale = parsed.data.locale ?? 'ru';
    const nameByLocale = (h: typeof holidays[number]): string => {
      switch (locale) {
        case 'en': return h.nameEn ?? h.nameRu ?? h.key;
        case 'zh-CN': return h.nameZhCn ?? h.nameEn ?? h.key;
        case 'hi': return h.nameHi ?? h.nameEn ?? h.key;
        case 'es': return h.nameEs ?? h.nameEn ?? h.key;
        case 'ar': return h.nameAr ?? h.nameEn ?? h.key;
        default: return h.nameRu ?? h.nameEn ?? h.key;
      }
    };
    const thisYear = new Date().getUTCFullYear();
    let created = 0;
    for (const h of holidays) {
      const eventDate = new Date(Date.UTC(thisYear, h.month - 1, h.day));
      try {
        await prisma.giftOccasion.create({
          data: {
            ownerUserId: user.id,
            title: nameByLocale(h),
            type: 'HOLIDAY',
            eventDate,
            recurrence: 'YEARLY',
            emoji: h.emoji,
            source: 'IMPORTED_HOLIDAY',
            holidayKey: h.key,
            country: h.country,
          },
        });
        created++;
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e.code !== 'P2002') throw err;
      }
    }
    trackEvent('calendar_holidays_imported', user.id, { count: created, locale });
    return res.json({ imported: created });
  }));
  
  giftNotesRouter.get('/calendar/friends-bdays', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const subs = await prisma.profileSubscription.findMany({
      where: { subscriberId: user.id },
      select: { targetUserId: true },
    });
    const targetIds = subs.map(s => s.targetUserId);
    if (targetIds.length === 0) return res.json({ friends: [] });
    const profiles = await prisma.userProfile.findMany({
      where: { userId: { in: targetIds }, birthday: { not: null } },
      select: { userId: true, displayName: true, username: true, avatarThumbUrl: true, avatarUrl: true, birthday: true, hideYear: true },
    });
    const imported = await prisma.giftOccasion.findMany({
      where: { ownerUserId: user.id, source: 'IMPORTED_FRIEND', linkedUserId: { in: profiles.map(p => p.userId) } },
      select: { linkedUserId: true },
    });
    const importedSet = new Set(imported.map(i => i.linkedUserId).filter((id): id is string => !!id));
    return res.json({
      friends: profiles.map(p => ({
        userId: p.userId,
        displayName: p.displayName,
        username: p.username,
        avatarThumbUrl: p.avatarThumbUrl ?? p.avatarUrl ?? null,
        birthday: p.birthday?.toISOString() ?? null,
        hideYear: p.hideYear,
        alreadyImported: importedSet.has(p.userId),
      })),
    });
  }));
  
  giftNotesRouter.post('/calendar/import-friends-bdays', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const parsed = z.object({
      userIds: z.array(z.string().cuid()).min(1).max(50),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const profiles = await prisma.userProfile.findMany({
      where: { userId: { in: parsed.data.userIds }, birthday: { not: null } },
      include: { user: { select: { id: true, firstName: true } } },
    });
    let created = 0;
    for (const p of profiles) {
      if (!p.birthday) continue;
      const existing = await prisma.giftOccasion.findFirst({
        where: { ownerUserId: user.id, linkedUserId: p.userId, source: 'IMPORTED_FRIEND', type: 'BIRTHDAY' },
        select: { id: true },
      });
      if (existing) continue;
      const name = p.displayName ?? p.user?.firstName ?? p.username ?? 'Friend';
      await prisma.giftOccasion.create({
        data: {
          ownerUserId: user.id,
          title: name,
          type: 'BIRTHDAY',
          personName: name,
          eventDate: p.birthday,
          recurrence: 'YEARLY',
          emoji: '🎂',
          source: 'IMPORTED_FRIEND',
          linkedUserId: p.userId,
        },
      });
      created++;
    }
    trackEvent('calendar_friends_imported', user.id, { count: created });
    return res.json({ imported: created });
  }));
  
  giftNotesRouter.get('/calendar/inbox', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const entries = await prisma.calendarInboxEntry.findMany({
      where: { ownerUserId: user.id, archivedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { occasion: { select: { id: true, title: true, type: true, emoji: true } } },
    });
    const unread = await prisma.calendarInboxEntry.count({ where: { ownerUserId: user.id, archivedAt: null, readAt: null } });
    return res.json({ entries, unread });
  }));
  
  giftNotesRouter.post('/calendar/inbox/read-all', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    await prisma.calendarInboxEntry.updateMany({
      where: { ownerUserId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return res.json({ ok: true });
  }));
  
  giftNotesRouter.post('/calendar/inbox/:id/read', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const entry = await prisma.calendarInboxEntry.findUnique({ where: { id: req.params.id } });
    if (!entry || entry.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
    await prisma.calendarInboxEntry.update({ where: { id: entry.id }, data: { readAt: entry.readAt ?? new Date() } });
    return res.json({ ok: true });
  }));
  
  giftNotesRouter.get('/calendar/today-context', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const [userRow, occasions] = await Promise.all([
      prisma.user.findUnique({ where: { id: user.id }, select: { calendarOnboardingSeenAt: true } }),
      prisma.giftOccasion.findMany({
        where: { ownerUserId: user.id, status: 'ACTIVE', eventDate: { not: null } },
        include: { _count: { select: { ideas: { where: { status: 'ACTIVE' } } } } },
      }),
    ]);
    type Pick = { id: string; title: string; emoji: string | null; type: string; daysUntil: number; nextDate: string; ideasCount: number };
    let soonest: Pick | null = null;
    for (const o of occasions) {
      if (!o.eventDate) continue;
      const next = getNextOccurrenceDate(o.eventDate, o.recurrence);
      if (!next) continue;
      const days = Math.round((next.getTime() - Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())) / (24 * 3600 * 1000));
      if (days < 0 || days > 30) continue;
      if (!soonest || days < soonest.daysUntil) {
        soonest = { id: o.id, title: o.title, emoji: o.emoji, type: o.type, daysUntil: days, nextDate: next.toISOString(), ideasCount: o._count.ideas };
      }
    }
    return res.json({
      soonest,
      // Server-side onboarding flag — replaces the previous localStorage-only
      // approach so a user who already saw onboarding on iPhone doesn't get
      // it again when opening the Mini App on macOS / web.
      onboardingSeenAt: userRow?.calendarOnboardingSeenAt?.toISOString() ?? null,
    });
  }));
  
  // POST /tg/calendar/onboarding-seen — idempotently mark the calendar
  // onboarding as completed for this user. Called when the 4-step flow is
  // dismissed or finished. Safe to call multiple times.
  giftNotesRouter.post('/calendar/onboarding-seen', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const existing = await prisma.user.findUnique({ where: { id: user.id }, select: { calendarOnboardingSeenAt: true } });
    if (existing?.calendarOnboardingSeenAt) {
      return res.json({ seenAt: existing.calendarOnboardingSeenAt.toISOString() });
    }
    const now = new Date();
    await prisma.user.update({ where: { id: user.id }, data: { calendarOnboardingSeenAt: now } });
    trackEvent('calendar_onboarding_seen', user.id);
    return res.json({ seenAt: now.toISOString() });
  }));
  
  giftNotesRouter.get('/calendar/year-recap', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireGiftNotes(ent, res)) return;
    const yearParam = z.coerce.number().int().min(2020).max(2100).safeParse(req.query.year);
    const year = yearParam.success ? yearParam.data : new Date().getUTCFullYear() - 1;
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year + 1, 0, 1));
    const occasions = await prisma.giftOccasion.findMany({
      where: {
        ownerUserId: user.id,
        eventDate: { gte: start, lt: end },
      },
      include: {
        linkedUser: { select: { id: true, firstName: true, profile: { select: { displayName: true, username: true, avatarThumbUrl: true } } } },
      },
    });
    const total = occasions.length;
    const completed = occasions.filter(o => o.status === 'DONE').length;
    const birthdays = occasions.filter(o => o.type === 'BIRTHDAY').length;
    const onTimePct = total > 0 ? Math.round((completed / total) * 100) : 0;
    type Spend = Record<string, number>;
    const spendByCurrency: Spend = {};
    let totalGifts = 0;
    for (const o of occasions) {
      if (o.actualGiftAmount && o.actualGiftAmount > 0) {
        const cur = o.actualGiftCurrency ?? 'RUB';
        spendByCurrency[cur] = (spendByCurrency[cur] ?? 0) + o.actualGiftAmount;
        totalGifts++;
      }
    }
    const counts = new Map<string, { userId: string; name: string; count: number; avatarUrl: string | null }>();
    for (const o of occasions) {
      if (!o.linkedUser) continue;
      const name = o.linkedUser.profile?.displayName ?? o.linkedUser.firstName ?? o.linkedUser.profile?.username ?? 'Friend';
      const cur = counts.get(o.linkedUser.id);
      if (cur) cur.count++;
      else counts.set(o.linkedUser.id, { userId: o.linkedUser.id, name, count: 1, avatarUrl: o.linkedUser.profile?.avatarThumbUrl ?? null });
    }
    const topRecipient = [...counts.values()].sort((a, b) => b.count - a.count)[0] ?? null;
    const perMonth = Array.from({ length: 12 }, () => 0);
    for (const o of occasions) {
      if (!o.actualGiftAmount || !o.eventDate) continue;
      const m = o.eventDate.getUTCMonth();
      perMonth[m] = (perMonth[m] ?? 0) + 1;
    }
    trackEvent('calendar_recap_viewed', user.id, { year });
    return res.json({
      year,
      totals: { events: total, completed, birthdays, onTimePct, giftsGiven: totalGifts },
      spend: { byCurrency: spendByCurrency },
      topRecipient,
      perMonthGifts: perMonth,
    });
    }),
  );

  return giftNotesRouter;
}
