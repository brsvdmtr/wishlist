import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@wishlist/db';
import { parseUrl, validateUrl } from './url-parser.js';
import { t, detectLocale, pluralize, type Locale } from '@wishlist/shared';

// Prefer app-local .env when running from repo root (pnpm dev),
// but also support running from within apps/api (pnpm -C apps/api dev).
const envCandidates = [
  path.resolve(__dirname, '../.env'),
  path.resolve(__dirname, '../../..', '.env'),
];
for (const p of envCandidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
}

const PORT = Number(process.env.PORT ?? 3001);
const WEB_ORIGIN = (process.env.WEB_ORIGIN ?? '').trim() || 'http://localhost:3000';

const app = express();

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow non-browser requests (curl, server-to-server).
      if (!origin) return cb(null, true);
      if (origin === WEB_ORIGIN) return cb(null, true);
      return cb(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-ADMIN-KEY', 'X-TG-INIT-DATA', 'X-TG-DEV', 'X-INTERNAL-KEY'],
  }),
);
app.use(express.json());

// ─── File uploads ─────────────────────────────────────────────────────────────
const UPLOAD_DIR = (process.env.UPLOAD_DIR ?? '').trim() || path.join(process.cwd(), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// Use memory storage so sharp can process buffer directly (no temp files).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error('Unsupported file type. Use JPEG, PNG, WebP, or GIF.'));
    }
    cb(null, true);
  },
});

/**
 * Process uploaded image with sharp:
 * - Auto-rotate based on EXIF orientation
 * - Strip all EXIF/metadata (privacy)
 * - Resize to fit within maxDim (preserving aspect ratio)
 * - Convert to JPEG (best browser + Telegram compatibility)
 * - Quality 80 → targets 100-300KB for typical photos
 *
 * Returns: { filename, filepath, sizeBytes, width, height }
 */
async function processImage(
  buffer: Buffer,
  opts: { maxDim: number; quality?: number; suffix?: string },
): Promise<{ filename: string; filepath: string; sizeBytes: number; width: number; height: number }> {
  const id = crypto.randomUUID();
  const suffix = opts.suffix ?? 'full';
  const filename = `${id}-${suffix}.jpg`;
  const filepath = path.join(UPLOAD_DIR, filename);

  const result = await sharp(buffer)
    .rotate() // auto-rotate from EXIF
    .resize(opts.maxDim, opts.maxDim, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: opts.quality ?? 80, mozjpeg: true })
    .toFile(filepath);

  return {
    filename,
    filepath,
    sizeBytes: result.size,
    width: result.width,
    height: result.height,
  };
}

/** Delete a local upload file. Silently ignores missing files and non-local URLs. */
function deleteUploadFile(imageUrl: string | null): void {
  if (!imageUrl) return;
  // Only delete files we own (relative /api/uploads/ paths or bare filenames).
  // External URLs (http/https) are left untouched.
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) return;
  const filename = path.basename(imageUrl); // strips any leading /api/uploads/ etc.
  if (!filename || filename.includes('..') || filename.includes('/')) return;
  const filepath = path.join(UPLOAD_DIR, filename);
  fs.unlink(filepath, () => {}); // best-effort
  // Also try to delete the thumbnail variant
  const thumbName = filename.replace('-full.jpg', '-thumb.jpg');
  if (thumbName !== filename) {
    fs.unlink(path.join(UPLOAD_DIR, thumbName), () => {});
  }
}

// Serve uploaded files as static assets at /uploads/*
// In production: nginx /api/* → port 3001, so GET /api/uploads/x → /uploads/x here.
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));
// ──────────────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

// ─── Deep health check ────────────────────────────────────────────────────────
app.get('/health/deep', asyncHandler(async (_req, res) => {
  const checks: Record<string, unknown> = {};
  let ok = true;

  // DB check
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = 'ok';
  } catch (err) {
    checks.db = { error: String(err) };
    ok = false;
  }

  // Bot heartbeat check (stale if > 120 s)
  try {
    const hb = await prisma.serviceHeartbeat.findUnique({ where: { serviceName: 'bot' } });
    if (!hb) {
      checks.bot = 'no_heartbeat';
      ok = false;
    } else {
      const ageSec = (Date.now() - hb.updatedAt.getTime()) / 1000;
      if (ageSec > 120) {
        checks.bot = { stale: true, ageSec: Math.round(ageSec) };
        ok = false;
      } else {
        checks.bot = { ok: true, ageSec: Math.round(ageSec) };
      }
    }
  } catch (err) {
    checks.bot = { error: String(err) };
    ok = false;
  }

  checks.version = process.env.npm_package_version ?? 'unknown';

  return res.status(ok ? 200 : 503).json({ ok, checks });
}));

const publicRouter = express.Router();
const privateRouter = express.Router();
const tgRouter = express.Router();

// --- Rate limiters
const publicReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const publicActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// --- Shared helpers
const ItemStatusSchema = z.enum(['AVAILABLE', 'RESERVED', 'PURCHASED', 'COMPLETED', 'DELETED']);
const ACTIVE_STATUSES = ['AVAILABLE', 'RESERVED', 'PURCHASED'] as const;
const PrioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);

// Sort logic lives in sort.ts (no external deps → easy to unit-test)
import { ITEM_ORDER_BY, sortItemsJs, type SortableItem } from './sort.js';
export { ITEM_ORDER_BY, sortItemsJs, type SortableItem };

const actorBodySchema = z.object({
  actorHash: z.string().uuid(),
});

/** Timing-safe string comparison via SHA-256 digests to prevent timing attacks. */
function secureCompare(a: string, b: string): boolean {
  const aHash = crypto.createHash('sha256').update(a).digest();
  const bHash = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(aHash, bHash);
}

/** Best-effort: resolve user's first_name from Telegram Bot API, cache in DB. */
async function resolveUserFirstName(user: { id: string; firstName: string | null; telegramChatId: string | null }, locale: Locale = 'ru'): Promise<string> {
  if (user.firstName) return user.firstName;
  const fallback = t('api_user_fallback', locale);
  const token = process.env.BOT_TOKEN;
  if (!token || !user.telegramChatId) return fallback;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: user.telegramChatId }),
    });
    if (!resp.ok) return fallback;
    const json = await resp.json() as { ok: boolean; result?: { first_name?: string } };
    const name = json.result?.first_name;
    if (name) {
      // Cache in DB for future calls
      await prisma.user.update({ where: { id: user.id }, data: { firstName: name } }).catch(() => {});
      return name;
    }
  } catch { /* best-effort */ }
  return fallback;
}

/** Detect locale from Telegram user's language_code on the request. */
function getRequestLocale(req: Request): Locale {
  const langCode = req.tgUser?.language_code;
  return detectLocale(langCode);
}

/** Cancel all active hints for an item (called when item leaves AVAILABLE state). */
async function cancelItemHints(itemId: string): Promise<void> {
  try {
    await prisma.hint.updateMany({
      where: { itemId, status: { in: ['SENT', 'DELIVERED'] } },
      data: { status: 'CANCELLED' },
    });
  } catch { /* best-effort */ }
}

/** Best-effort Telegram notification. Fire-and-forget – never throws. */
async function sendTgNotification(chatId: string, text: string): Promise<void> {
  const token = process.env.BOT_TOKEN;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch {
    // best-effort, don't fail the main operation
  }
}

/** Send a Telegram message with optional reply markup. Returns true on success. */
async function sendTgBotMessage(chatId: string, text: string, replyMarkup?: Record<string, unknown>): Promise<boolean> {
  const token = process.env.BOT_TOKEN;
  if (!token || !chatId) return false;
  try {
    const payload: Record<string, unknown> = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json() as { ok: boolean; description?: string };
    if (!data.ok) console.error('[sendTgBotMessage] Telegram API error:', data.description, 'chat_id:', chatId);
    return data.ok;
  } catch (err) {
    console.error('[sendTgBotMessage] exception:', err);
    return false;
  }
}


/** Send alert to all ADMIN_ALERT_CHAT_IDS. Best-effort, never throws. */
async function sendAdminAlert(text: string): Promise<void> {
  const token = process.env.BOT_TOKEN;
  const chatIds = (process.env.ADMIN_ALERT_CHAT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!token || chatIds.length === 0) return;
  await Promise.allSettled(
    chatIds.map((chatId) =>
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      }),
    ),
  );
}

// Notification batching (30s debounce per item+recipient)
const pendingNotifications = new Map<string, { chatId: string; itemTitle: string; count: number; timer: ReturnType<typeof setTimeout> }>();

function queueCommentNotification(key: string, chatId: string, itemTitle: string, text: string) {
  const existing = pendingNotifications.get(key);
  if (existing) {
    existing.count++;
    return;
  }

  // Send first notification immediately
  void sendTgNotification(chatId, text);

  const entry = {
    chatId,
    itemTitle,
    count: 0,
    timer: setTimeout(() => {
      const e = pendingNotifications.get(key);
      pendingNotifications.delete(key);
      if (!e || e.count === 0) return;
      const notifLocale: Locale = 'ru'; // notifications use Russian as default
      const word = pluralize(e.count, 'новый комментарий', 'новых комментария', 'новых комментариев', notifLocale);
      void sendTgNotification(e.chatId, t('notif_batch_comments', notifLocale, { count: e.count, word, title: e.itemTitle }));
    }, 30_000),
  };
  pendingNotifications.set(key, entry);
}

/**
 * Record unread changes for subscribers of a wishlist and send Telegram notifications.
 * Fire-and-forget — never throws.
 */
async function notifySubscribersOfChange(
  wishlistId: string,
  entityId: string,
  changedFields: string[],
  eventType: 'item_added' | 'item_updated' | 'wishlist_updated',
  meta: { itemTitle?: string; wishlistTitle?: string; ownerName?: string },
): Promise<void> {
  try {
    const subs = await prisma.wishlistSubscription.findMany({
      where: { wishlistId },
      select: { id: true, subscriber: { select: { id: true, telegramChatId: true } } },
    });
    if (subs.length === 0) return;

    const notifLocale: Locale = 'ru';
    await Promise.all(
      subs.map(async (sub) => {
        // Upsert unread markers
        await Promise.all(
          changedFields.map((field) =>
            prisma.subscriptionUnread.upsert({
              where: { subId_entityId_fieldName: { subId: sub.id, entityId, fieldName: field } },
              update: {},
              create: { subId: sub.id, entityId, fieldName: field },
            }),
          ),
        );

        // Send Telegram notification
        const chatId = sub.subscriber.telegramChatId;
        if (!chatId) return;

        let text = '';
        if (eventType === 'item_added') {
          text = t('sub_notification_new_item', notifLocale, {
            owner: meta.ownerName ?? '…',
            title: meta.itemTitle ?? '…',
            wishlist: meta.wishlistTitle ?? '…',
          });
        } else if (eventType === 'item_updated') {
          text = t('sub_notification_updated', notifLocale, {
            title: meta.itemTitle ?? '…',
            wishlist: meta.wishlistTitle ?? '…',
          });
        } else {
          text = t('sub_notification_wishlist_updated', notifLocale, {
            title: meta.wishlistTitle ?? '…',
          });
        }
        void sendTgNotification(chatId, text);
      }),
    );
  } catch (err) {
    console.error('[notifySubscribersOfChange] error:', err);
  }
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    return res.status(500).json({ error: 'ADMIN_KEY is not configured' });
  }

  const provided = req.get('X-ADMIN-KEY');
  if (!provided || !secureCompare(provided, adminKey)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function zodError(res: Response, error: z.ZodError) {
  return res.status(400).json({ error: 'Validation error', issues: error.issues });
}

function slugify(input: string) {
  const base = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'list';
}

function randomSuffix(len = 6) {
  return crypto.randomBytes(Math.ceil(len)).toString('base64url').slice(0, len);
}

async function generateUniqueSlug(title: string) {
  const base = slugify(title).slice(0, 24);
  for (let i = 0; i < 10; i++) {
    const candidate = `${base}-${randomSuffix(6)}`;
    const existing = await prisma.wishlist.findUnique({ where: { slug: candidate } });
    if (!existing) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

async function generateUniqueShareToken(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const token = crypto.randomBytes(9).toString('base64url'); // 12-char URL-safe token
    const existing = await prisma.wishlist.findUnique({ where: { shareToken: token } });
    if (!existing) return token;
  }
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

/** Generate a cryptographically random, opaque, collision-safe Support ID.
 *  Format: 16-char lowercase hex (e.g. "8c7f0c2e9a4b1d63").
 *  Not derived from Telegram ID or any user-identifying data. */
async function generateUniqueSupportId(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const id = crypto.randomBytes(8).toString('hex'); // 16-char lowercase hex
    const existing = await prisma.userProfile.findUnique({ where: { supportId: id } });
    if (!existing) return id;
  }
  // Ultra-safe fallback: 32 hex chars — probability of collision is negligible
  return crypto.randomBytes(16).toString('hex');
}

async function getSystemUser() {
  const email = (process.env.SYSTEM_USER_EMAIL ?? 'owner@local').trim() || 'owner@local';
  return prisma.user.upsert({ where: { email }, update: {}, create: { email } });
}

function mapItemForPublic(item: {
  id: string;
  title: string;
  description: string | null;
  url: string;
  priceText: string | null;
  commentOwner: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  deadline: Date | null;
  imageUrl: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  itemTags: { tag: { id: string; name: string } }[];
  reservationEvents?: { comment: string | null; actorHash: string }[];
}) {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    url: item.url,
    priceText: item.priceText,
    commentOwner: item.commentOwner,
    priority: item.priority,
    deadline: item.deadline,
    imageUrl: item.imageUrl,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    tags: item.itemTags.map((it) => it.tag),
    // Name of the guest who reserved (visible to other guests, hidden from owner by design).
    reservedByDisplayName:
      item.status === 'RESERVED' && item.reservationEvents?.length
        ? (item.reservationEvents[0]?.comment ?? null)
        : null,
    // Hash of the reserver's identity — used by frontend to detect "reserved by me".
    reservedByActorHash:
      item.status === 'RESERVED' && item.reservationEvents?.length
        ? (item.reservationEvents[0]?.actorHash ?? null)
        : null,
  };
}

// --- Public endpoints (no auth)
publicRouter.get(
  '/wishlists/:slug/items',
  publicReadLimiter,
  asyncHandler(async (req, res) => {
    const slug = req.params.slug ?? '';
    if (!slug) return res.status(400).json({ error: 'Missing slug' });

    const queryParsed = z
      .object({
        status: z.enum(['AVAILABLE', 'RESERVED', 'PURCHASED']).optional(),
        tag: z.string().min(1).optional(),
      })
      .safeParse(req.query);
    if (!queryParsed.success) return zodError(res, queryParsed.error);

    const wishlist = await prisma.wishlist.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: Record<string, any> = { wishlistId: wishlist.id, status: { in: [...ACTIVE_STATUSES] } };

    if (queryParsed.data.status) where.status = queryParsed.data.status;
    if (queryParsed.data.tag) where.itemTags = { some: { tagId: queryParsed.data.tag } };

    const items = await prisma.item.findMany({
      where,
      orderBy: ITEM_ORDER_BY,
      include: {
        itemTags: { include: { tag: { select: { id: true, name: true } } } },
        reservationEvents: {
          where: { type: 'RESERVED' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { comment: true, actorHash: true },
        },
      },
    });

    return res.json({ items: items.map(mapItemForPublic) });
  }),
);

publicRouter.get(
  '/wishlists/:slug',
  publicReadLimiter,
  asyncHandler(async (req, res) => {
    const slug = req.params.slug ?? '';
    if (!slug) return res.status(400).json({ error: 'Missing slug' });

    const wishlist = await prisma.wishlist.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        deadline: true,
        visibility: true,
        ownerId: true,
        owner: {
          select: {
            firstName: true,
            profile: { select: { displayName: true, username: true, avatarUrl: true, avatarPublic: true } },
          },
        },
        items: {
          where: { status: { in: [...ACTIVE_STATUSES] } },
          orderBy: ITEM_ORDER_BY,
          include: {
            itemTags: { include: { tag: { select: { id: true, name: true } } } },
            reservationEvents: {
              where: { type: 'RESERVED' },
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { comment: true, actorHash: true },
            },
          },
        },
        tags: { select: { id: true, name: true } },
      },
    });

    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });

    // PRIVATE wishlists: only subscribers can access
    if (wishlist.visibility === 'PRIVATE') {
      // Check if authenticated TG user is a subscriber
      let isSubscriber = false;
      const tgUser = req.tgUser;
      if (tgUser) {
        const user = await prisma.user.findUnique({
          where: { telegramId: String(tgUser.id) },
          select: { id: true },
        }).catch(() => null);
        if (user) {
          const sub = await prisma.wishlistSubscription.findFirst({
            where: { wishlistId: wishlist.id, subscriberId: user.id },
            select: { id: true },
          });
          isSubscriber = !!sub;
          // Also allow owner
          if (user.id === wishlist.ownerId) isSubscriber = true;
        }
      }
      if (!isSubscriber) {
        // Neutral mask: show a generic "archived" facade so origin is not revealed
        return res.status(403).json({ error: 'wishlist_private', message: 'This wishlist is not publicly accessible' });
      }
    }

    const ownerName =
      wishlist.owner?.profile?.displayName?.trim() ||
      wishlist.owner?.profile?.username?.trim() ||
      wishlist.owner?.firstName?.trim() ||
      null;

    // Respect avatarPublic — only expose photo if owner allows it
    const ownerProfile = wishlist.owner?.profile;
    const ownerAvatarUrl = (ownerProfile?.avatarPublic !== false && ownerProfile?.avatarUrl)
      ? ownerProfile.avatarUrl
      : null;

    return res.json({
      wishlist: {
        id: wishlist.id,
        slug: wishlist.slug,
        title: wishlist.title,
        description: wishlist.description,
        deadline: wishlist.deadline,
        visibility: (wishlist.visibility as string).toLowerCase(),
        ownerName,
        ownerAvatarUrl,
      },
      items: wishlist.items.map(mapItemForPublic),
      tags: wishlist.tags,
    });
  }),
);

// GET /public/share/:token — resolve share token → wishlist (same shape as /public/wishlists/:slug)
// Wrapped in try-catch: if shareToken column doesn't exist (migration not applied), returns 404
// instead of crashing with 500, so the client can fall back to the slug endpoint gracefully.
publicRouter.get(
  '/share/:token',
  publicReadLimiter,
  asyncHandler(async (req, res) => {
    const token = req.params.token ?? '';
    if (!token) return res.status(400).json({ error: 'Missing token' });

    let wishlist;
    try {
      wishlist = await prisma.wishlist.findUnique({
        where: { shareToken: token },
        select: {
          id: true,
          slug: true,
          title: true,
          description: true,
          deadline: true,
          owner: {
            select: {
              firstName: true,
              profile: { select: { displayName: true, username: true } },
            },
          },
          items: {
            where: { status: { in: [...ACTIVE_STATUSES] } },
            orderBy: ITEM_ORDER_BY,
            include: {
              itemTags: { include: { tag: { select: { id: true, name: true } } } },
              reservationEvents: {
                where: { type: 'RESERVED' },
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { comment: true, actorHash: true },
              },
            },
          },
          tags: { select: { id: true, name: true } },
        },
      });
    } catch {
      // shareToken column may not exist if migration hasn't been applied yet
      return res.status(404).json({ error: 'Wishlist not found' });
    }

    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });

    // Track link open — fire-and-forget, never blocks response
    prisma.wishlist.update({
      where: { shareToken: token },
      data: { shareOpenCount: { increment: 1 } },
    }).catch(() => { /* non-critical — ignore DB errors */ });

    const ownerNameToken =
      wishlist.owner?.profile?.displayName?.trim() ||
      wishlist.owner?.profile?.username?.trim() ||
      wishlist.owner?.firstName?.trim() ||
      null;

    return res.json({
      wishlist: {
        id: wishlist.id,
        slug: wishlist.slug,
        title: wishlist.title,
        description: wishlist.description,
        deadline: wishlist.deadline,
        ownerName: ownerNameToken,
      },
      items: wishlist.items.map(mapItemForPublic),
      tags: wishlist.tags,
    });
  }),
);

// GET /public/profiles/:username — public user profile + public wishlists
publicRouter.get(
  '/profiles/:username',
  publicReadLimiter,
  asyncHandler(async (req, res) => {
    const username = req.params.username ?? '';
    if (!username) return res.status(400).json({ error: 'Missing username' });

    const profile = await prisma.userProfile.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
      select: {
        userId: true,
        displayName: true,
        username: true,
        bio: true,
        avatarUrl: true,
        avatarThumbUrl: true,
        avatarUpdatedAt: true,
        avatarPublic: true,
        profileVisibility: true,
      },
    });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    // Respect profileVisibility
    if (profile.profileVisibility === 'NOBODY') {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // For non-ALL visibility, return profile info only (no wishlist list)
    const isPublic = profile.profileVisibility === 'ALL';

    let publicWishlists: Array<{ id: string; slug: string; title: string; deadline: string | null; itemCount: number }> = [];
    if (isPublic) {
      const wls = await prisma.wishlist.findMany({
        where: {
          ownerId: profile.userId,
          type: 'REGULAR',
          archivedAt: null,
          visibility: 'PUBLIC_PROFILE',
        },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true, slug: true, title: true, deadline: true,
          items: { where: { status: { in: [...ACTIVE_STATUSES] } }, select: { id: true } },
        },
      });
      publicWishlists = wls.map((wl) => ({
        id: wl.id,
        slug: wl.slug,
        title: wl.title,
        deadline: wl.deadline?.toISOString() ?? null,
        itemCount: wl.items.length,
      }));
    }

    // Respect avatarPublic — hide avatar URL in public contexts if user set photo to private
    const publicAvatarUrl = profile.avatarPublic ? profile.avatarUrl : null;
    const publicAvatarThumbUrl = profile.avatarPublic ? profile.avatarThumbUrl : null;

    return res.json({
      profile: {
        displayName: profile.displayName,
        username: profile.username,
        bio: profile.bio,
        avatarUrl: publicAvatarUrl,
        avatarThumbUrl: publicAvatarThumbUrl,
        avatarUpdatedAt: profile.avatarUpdatedAt?.toISOString() ?? null,
        isPublic,
      },
      wishlists: publicWishlists,
    });
  }),
);

publicRouter.post(
  '/items/:id/reserve',
  publicActionLimiter,
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });
    const parsed = actorBodySchema
      .extend({ comment: z.string().max(2000).optional() })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.item.findUnique({ where: { id }, select: { status: true } });
      if (!item) return { kind: 'not_found' as const };
      if (item.status !== 'AVAILABLE') return { kind: 'conflict' as const };

      const updated = await tx.item.update({
        where: { id },
        data: { status: 'RESERVED' },
        include: {
          itemTags: { include: { tag: { select: { id: true, name: true } } } },
          reservationEvents: {
            where: { type: 'RESERVED' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { comment: true, actorHash: true },
          },
        },
      });

      await tx.reservationEvent.create({
        data: {
          itemId: id,
          type: 'RESERVED',
          actorHash: parsed.data.actorHash,
          comment: parsed.data.comment ?? null,
        },
      });

      return { kind: 'ok' as const, item: updated };
    });

    if (result.kind === 'not_found') return res.status(404).json({ error: 'Item not found' });
    if (result.kind === 'conflict')
      return res.status(409).json({ error: 'Item is not available' });

    return res.json({ item: mapItemForPublic(result.item) });
  }),
);

publicRouter.post(
  '/items/:id/unreserve',
  publicActionLimiter,
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });
    const parsed = actorBodySchema.safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.item.findUnique({ where: { id }, select: { status: true } });
      if (!item) return { kind: 'not_found' as const };
      if (item.status !== 'RESERVED') return { kind: 'conflict' as const };

      const lastEvent = await tx.reservationEvent.findFirst({
        where: { itemId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { type: true, actorHash: true },
      });
      if (!lastEvent) return { kind: 'conflict' as const };
      if (lastEvent.type !== 'RESERVED') return { kind: 'conflict' as const };
      if (!secureCompare(lastEvent.actorHash, parsed.data.actorHash))
        return { kind: 'forbidden' as const };

      const updated = await tx.item.update({
        where: { id },
        data: { status: 'AVAILABLE' },
        include: {
          itemTags: { include: { tag: { select: { id: true, name: true } } } },
          reservationEvents: {
            where: { type: 'RESERVED' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { comment: true, actorHash: true },
          },
        },
      });

      await tx.reservationEvent.create({
        data: { itemId: id, type: 'UNRESERVED', actorHash: parsed.data.actorHash, comment: null },
      });

      return { kind: 'ok' as const, item: updated };
    });

    if (result.kind === 'not_found') return res.status(404).json({ error: 'Item not found' });
    if (result.kind === 'conflict') return res.status(409).json({ error: 'Cannot unreserve' });
    if (result.kind === 'forbidden') return res.status(403).json({ error: 'Forbidden' });

    return res.json({ item: mapItemForPublic(result.item) });
  }),
);

publicRouter.post(
  '/items/:id/purchase',
  publicActionLimiter,
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });
    const parsed = actorBodySchema
      .extend({ comment: z.string().max(2000).optional() })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.item.findUnique({ where: { id }, select: { status: true } });
      if (!item) return { kind: 'not_found' as const };
      if (item.status === 'PURCHASED') return { kind: 'conflict' as const };

      const updated = await tx.item.update({
        where: { id },
        data: { status: 'PURCHASED' },
        include: {
          itemTags: { include: { tag: { select: { id: true, name: true } } } },
          reservationEvents: {
            where: { type: 'RESERVED' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { comment: true, actorHash: true },
          },
        },
      });

      await tx.reservationEvent.create({
        data: {
          itemId: id,
          type: 'PURCHASED',
          actorHash: parsed.data.actorHash,
          comment: parsed.data.comment ?? null,
        },
      });

      return { kind: 'ok' as const, item: updated };
    });

    if (result.kind === 'not_found') return res.status(404).json({ error: 'Item not found' });
    if (result.kind === 'conflict') return res.status(409).json({ error: 'Item is purchased' });

    return res.json({ item: mapItemForPublic(result.item) });
  }),
);

// --- Private endpoints (admin auth)
privateRouter.use(requireAdmin);

privateRouter.post(
  '/wishlists',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        title: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const owner = await getSystemUser();
    const slug = await generateUniqueSlug(parsed.data.title);

    const wishlist = await prisma.wishlist.create({
      data: {
        slug,
        ownerId: owner.id,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
      },
      select: { id: true, slug: true, title: true, description: true, deadline: true },
    });

    return res.status(201).json({ wishlist });
  }),
);

privateRouter.patch(
  '/wishlists/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });
    const parsed = z
      .object({
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
      })
      .refine((v) => v.title !== undefined || v.description !== undefined, {
        message: 'At least one field is required',
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    try {
      const wishlist = await prisma.wishlist.update({
        where: { id },
        data: {
          ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
          ...(parsed.data.description !== undefined
            ? { description: parsed.data.description }
            : {}),
        },
        select: { id: true, slug: true, title: true, description: true, deadline: true },
      });
      return res.json({ wishlist });
    } catch {
      return res.status(404).json({ error: 'Wishlist not found' });
    }
  }),
);

privateRouter.delete(
  '/wishlists/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });
    try {
      await prisma.wishlist.delete({ where: { id } });
      return res.json({ ok: true });
    } catch {
      return res.status(404).json({ error: 'Wishlist not found' });
    }
  }),
);

privateRouter.post(
  '/wishlists/:id/items',
  asyncHandler(async (req, res) => {
    const wishlistId = req.params.id ?? '';
    if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });
    const parsed = z
      .object({
        title: z.string().min(1).max(200),
        url: z.string().url(),
        priceText: z.string().max(200).optional(),
        commentOwner: z.string().max(2000).optional(),
        priority: PrioritySchema.optional(),
        deadline: z.string().datetime().optional(),
        imageUrl: z.string().url().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const wishlist = await prisma.wishlist.findUnique({
      where: { id: wishlistId },
      select: { id: true },
    });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });

    const item = await prisma.item.create({
      data: {
        wishlistId,
        title: parsed.data.title,
        url: parsed.data.url,
        priceText: parsed.data.priceText ?? null,
        commentOwner: parsed.data.commentOwner ?? null,
        priority: parsed.data.priority ?? 'MEDIUM',
        deadline: parsed.data.deadline ? new Date(parsed.data.deadline) : null,
        imageUrl: parsed.data.imageUrl ?? null,
      },
      select: {
        id: true, wishlistId: true, title: true, url: true, priceText: true,
        commentOwner: true, priority: true, deadline: true, imageUrl: true,
        status: true, createdAt: true, updatedAt: true,
      },
    });

    return res.status(201).json({ item });
  }),
);

privateRouter.patch(
  '/items/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });
    const parsed = z
      .object({
        title: z.string().min(1).max(200).optional(),
        url: z.string().url().optional(),
        priceText: z.string().max(200).nullable().optional(),
        commentOwner: z.string().max(2000).nullable().optional(),
        priority: PrioritySchema.optional(),
        deadline: z.string().datetime().nullable().optional(),
        imageUrl: z.string().url().nullable().optional(),
        status: ItemStatusSchema.optional(),
      })
      .refine(
        (v) =>
          v.title !== undefined || v.url !== undefined || v.priceText !== undefined ||
          v.commentOwner !== undefined || v.priority !== undefined || v.deadline !== undefined ||
          v.imageUrl !== undefined || v.status !== undefined,
        { message: 'At least one field is required' },
      )
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    try {
      const item = await prisma.item.update({
        where: { id },
        data: {
          ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
          ...(parsed.data.url !== undefined ? { url: parsed.data.url } : {}),
          ...(parsed.data.priceText !== undefined ? { priceText: parsed.data.priceText } : {}),
          ...(parsed.data.commentOwner !== undefined ? { commentOwner: parsed.data.commentOwner } : {}),
          ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
          ...(parsed.data.deadline !== undefined
            ? { deadline: parsed.data.deadline ? new Date(parsed.data.deadline) : null }
            : {}),
          ...(parsed.data.imageUrl !== undefined ? { imageUrl: parsed.data.imageUrl } : {}),
          ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        },
        select: {
          id: true, wishlistId: true, title: true, url: true, priceText: true,
          commentOwner: true, priority: true, deadline: true, imageUrl: true,
          status: true, createdAt: true, updatedAt: true,
        },
      });
      return res.json({ item });
    } catch {
      return res.status(404).json({ error: 'Item not found' });
    }
  }),
);

privateRouter.delete(
  '/items/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });
    try {
      await prisma.item.delete({ where: { id } });
      return res.json({ ok: true });
    } catch {
      return res.status(404).json({ error: 'Item not found' });
    }
  }),
);

// Item-tag association endpoints
privateRouter.post(
  '/items/:itemId/tags/:tagId',
  asyncHandler(async (req, res) => {
    const { itemId, tagId } = req.params as { itemId: string; tagId: string };
    const [item, tag] = await Promise.all([
      prisma.item.findUnique({ where: { id: itemId }, select: { id: true, wishlistId: true } }),
      prisma.tag.findUnique({ where: { id: tagId }, select: { id: true, wishlistId: true } }),
    ]);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (!tag) return res.status(404).json({ error: 'Tag not found' });
    if (item.wishlistId !== tag.wishlistId)
      return res.status(422).json({ error: 'Item and tag belong to different wishlists' });
    try {
      await prisma.itemTag.create({ data: { itemId, tagId } });
      return res.status(201).json({ ok: true });
    } catch {
      return res.status(409).json({ error: 'Tag already assigned to item' });
    }
  }),
);

privateRouter.delete(
  '/items/:itemId/tags/:tagId',
  asyncHandler(async (req, res) => {
    const { itemId, tagId } = req.params as { itemId: string; tagId: string };
    try {
      await prisma.itemTag.delete({ where: { itemId_tagId: { itemId, tagId } } });
      return res.json({ ok: true });
    } catch {
      return res.status(404).json({ error: 'Association not found' });
    }
  }),
);

privateRouter.post(
  '/wishlists/:id/tags',
  asyncHandler(async (req, res) => {
    const wishlistId = req.params.id ?? '';
    if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });
    const parsed = z.object({ name: z.string().min(1).max(64) }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const wishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId }, select: { id: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });

    const tag = await prisma.tag.create({
      data: { wishlistId, name: parsed.data.name },
      select: { id: true, wishlistId: true, name: true, createdAt: true },
    });
    return res.status(201).json({ tag });
  }),
);

privateRouter.patch(
  '/tags/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing tag id' });
    const parsed = z.object({ name: z.string().min(1).max(64) }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    try {
      const tag = await prisma.tag.update({
        where: { id },
        data: { name: parsed.data.name },
        select: { id: true, wishlistId: true, name: true, createdAt: true },
      });
      return res.json({ tag });
    } catch {
      return res.status(404).json({ error: 'Tag not found' });
    }
  }),
);

privateRouter.delete(
  '/tags/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing tag id' });
    try {
      await prisma.tag.delete({ where: { id } });
      return res.json({ ok: true });
    } catch {
      return res.status(404).json({ error: 'Tag not found' });
    }
  }),
);

// ═══════════════════════════════════════════════════════
// TELEGRAM MINI APP ENDPOINTS
// ═══════════════════════════════════════════════════════

type TelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { tgUser?: TelegramUser; }
  }
}

function validateTelegramInitData(initData: string, botToken: string): TelegramUser | null {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const checkString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
    if (expectedHash !== hash) return null;
    const userStr = params.get('user');
    if (!userStr) return null;
    return JSON.parse(userStr) as TelegramUser;
  } catch {
    return null;
  }
}

/** Deterministic actor hash for a Telegram user ID. Formatted as UUID (8-4-4-4-12) to pass z.string().uuid(). */
function tgActorHash(telegramId: number): string {
  const h = crypto.createHash('sha256').update(`tg_actor:${telegramId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function requireTelegramAuth(req: Request, res: Response, next: NextFunction) {
  const botToken = process.env.BOT_TOKEN ?? '';
  if (!botToken) return res.status(500).json({ error: 'Bot not configured' });

  // Development bypass: X-TG-DEV: <telegram_id>
  if (process.env.NODE_ENV !== 'production') {
    const devId = req.get('X-TG-DEV');
    if (devId) {
      req.tgUser = { id: Number(devId) || 1, first_name: 'Dev User' };
      return next();
    }
  }

  const initData = req.get('X-TG-INIT-DATA') ?? '';
  const user = validateTelegramInitData(initData, botToken);
  if (!user) return res.status(401).json({ error: 'Invalid Telegram auth' });

  req.tgUser = user;
  return next();
}

// ─── Plan & Entitlement System ──────────────────────────────────────────────
const PLANS = {
  FREE: {
    code: 'FREE' as const,
    wishlists: 2,
    items: 20,       // reduced from 30; add-ons fill the gap; MAX tier will have 200+
    participants: 5,
    subscriptions: 2,
    features: [] as string[],
  },
  PRO: {
    code: 'PRO' as const,
    wishlists: 10,
    items: 70,       // reduced from 100; MAX tier will be 200+
    participants: 20,
    subscriptions: 5, // reduced from 7; 5 covers active users well; MAX will offer 15+
    features: ['comments', 'url_import', 'hints'],
  },
} as const;

type PlanCode = keyof typeof PLANS;
type PlanInfo = (typeof PLANS)[PlanCode];

const PRO_PRICE_XTR = parseInt(process.env.PRO_PRICE_XTR ?? '100', 10);
const PRO_SUBSCRIPTION_PERIOD = parseInt(process.env.PRO_SUBSCRIPTION_PERIOD ?? '2592000', 10);
const PRO_PLAN_CODE = process.env.PRO_PLAN_CODE ?? 'PRO';

// ─── One-time SKU catalogue ──────────────────────────────────────────────────
const ONE_TIME_SKUS = {
  extra_wishlist_slot:     { code: 'extra_wishlist_slot',     price: 39, type: 'permanent' as const,  addonType: 'wishlist_slot'       as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0,  targetRequired: false },
  extra_subscription_slot: { code: 'extra_subscription_slot', price: 25, type: 'permanent' as const,  addonType: 'subscription_slot'   as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0,  targetRequired: false },
  extra_items_5:           { code: 'extra_items_5',           price: 19, type: 'permanent' as const,  addonType: 'item_slot_5'         as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0,  targetRequired: true  },
  extra_items_15:          { code: 'extra_items_15',          price: 39, type: 'permanent' as const,  addonType: 'item_slot_15'        as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0,  targetRequired: true  },
  hints_pack_5:            { code: 'hints_pack_5',            price: 29, type: 'consumable' as const, addonType: null as string | null,                  creditKey: 'hint'   as 'hint' | 'import' | null, creditAmount: 5,  targetRequired: false },
  hints_pack_10:           { code: 'hints_pack_10',           price: 49, type: 'consumable' as const, addonType: null as string | null,                  creditKey: 'hint'   as 'hint' | 'import' | null, creditAmount: 10, targetRequired: false },
  import_pack_10:          { code: 'import_pack_10',          price: 39, type: 'consumable' as const, addonType: null as string | null,                  creditKey: 'import' as 'hint' | 'import' | null, creditAmount: 10, targetRequired: false },
  import_pack_25:          { code: 'import_pack_25',          price: 79, type: 'consumable' as const, addonType: null as string | null,                  creditKey: 'import' as 'hint' | 'import' | null, creditAmount: 25, targetRequired: false },
  seasonal_decoration:     { code: 'seasonal_decoration',     price: 29, type: 'cosmetic' as const,   addonType: 'seasonal_decoration' as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0,  targetRequired: true  },
} as const;

type SkuCode = keyof typeof ONE_TIME_SKUS;

// ─── Add-on caps — prevent add-ons from substituting PRO ────────────────────
const ADDON_CAPS = {
  extraWishlistSlots:        { FREE: 3, PRO: 5 }, // FREE total≤5; PRO total≤15
  extraSubscriptionSlots:    3,                   // any plan: +3 max (FREE→5, PRO→8)
  extraItems5PerWishlist:    3,                   // +5×3 = +15 items per wishlist
  extraItems15PerWishlist:   1,                   // +15×1 = +15 items per wishlist
} as const;

async function getUserEntitlement(userId: string, godMode = false): Promise<{
  plan: PlanInfo;
  isPro: boolean;
  subscription: { id: string; status: string; periodEnd: string; cancelledAt: string | null; cancelAtPeriodEnd: boolean } | null;
}> {
  const sub = await prisma.subscription.findFirst({
    where: {
      userId,
      planCode: PRO_PLAN_CODE,
      status: { in: ['ACTIVE', 'CANCELLED'] },
      currentPeriodEnd: { gt: new Date() },
    },
    orderBy: { currentPeriodEnd: 'desc' },
  });

  if (sub) {
    return {
      plan: PLANS.PRO,
      isPro: true,
      subscription: {
        id: sub.id,
        status: sub.status,
        periodEnd: sub.currentPeriodEnd.toISOString(),
        cancelledAt: sub.cancelledAt?.toISOString() ?? null,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      },
    };
  }

  // God Mode: virtual PRO without real subscription
  if (godMode) {
    return { plan: PLANS.PRO, isPro: true, subscription: null };
  }

  return { plan: PLANS.FREE, isPro: false, subscription: null };
}

/** Unified effective entitlement resolver — single source of truth for all limit checks */
async function getEffectiveEntitlements(userId: string, godMode = false) {
  const [base, addOns, credits] = await Promise.all([
    getUserEntitlement(userId, godMode),
    prisma.userAddOn.findMany({ where: { userId } }),
    prisma.userCredits.findUnique({ where: { userId } }),
  ]);

  const extraWishlistSlots = addOns
    .filter(a => a.addonType === 'wishlist_slot')
    .reduce((s, a) => s + a.quantity, 0);

  const extraSubscriptionSlots = addOns
    .filter(a => a.addonType === 'subscription_slot')
    .reduce((s, a) => s + a.quantity, 0);

  // Per-wishlist extra items: wishlistId → additional item count
  const extraItemsPerWishlist: Record<string, number> = {};
  for (const a of addOns.filter(a => a.addonType === 'item_slot_5' || a.addonType === 'item_slot_15')) {
    if (a.targetId) {
      extraItemsPerWishlist[a.targetId] = (extraItemsPerWishlist[a.targetId] ?? 0) + a.quantity;
    }
  }

  // Seasonal decoration wishlist IDs
  const seasonalWishlists = new Set<string>(
    addOns.filter(a => a.addonType === 'seasonal_decoration' && a.targetId).map(a => a.targetId!)
  );

  return {
    ...base,
    effectiveWishlistLimit: base.plan.wishlists + extraWishlistSlots,
    effectiveSubscriptionLimit: base.plan.subscriptions + extraSubscriptionSlots,
    extraItemsPerWishlist,
    seasonalWishlists,
    hintCredits: credits?.hintCredits ?? 0,
    importCredits: credits?.importCredits ?? 0,
    addOns,
  };
}

/** Check if a wishlist is writable (within plan limits) for the given user */
async function isWishlistWritable(userId: string, wishlistId: string, planLimit: number): Promise<boolean> {
  const allWishlists = await prisma.wishlist.findMany({
    where: { ownerId: userId, type: 'REGULAR', archivedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  const writableIds = new Set(allWishlists.slice(0, planLimit).map(w => w.id));
  return writableIds.has(wishlistId);
}

// Analytics / logging stub
function trackEvent(event: string, userId?: string, props?: Record<string, unknown>) {
  // eslint-disable-next-line no-console
  console.log(`[analytics] ${event}`, userId ? `user=${userId}` : '', props ?? '');
}
// ─────────────────────────────────────────────────────────────────────────────

/** Extract numeric price from formatted string like "51 975 ₽" → "51975" */
function extractNumericPrice(priceText: string | null): string | null {
  if (!priceText) return null;
  // Remove currency symbols, spaces, non-breaking spaces
  const digits = priceText.replace(/[^\d.,]/g, '').replace(',', '.');
  if (!digits) return null;
  const num = parseFloat(digits);
  return isNaN(num) ? null : String(num);
}

function priorityToNum(p: 'LOW' | 'MEDIUM' | 'HIGH'): 1 | 2 | 3 {
  return p === 'LOW' ? 1 : p === 'HIGH' ? 3 : 2;
}
function numToPriority(n: number): 'LOW' | 'MEDIUM' | 'HIGH' {
  return n === 1 ? 'LOW' : n === 3 ? 'HIGH' : 'MEDIUM';
}

function mapTgItem(item: {
  id: string;
  wishlistId: string;
  title: string;
  url: string;
  priceText: string | null;
  currency?: string;
  imageUrl?: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  position?: number;
  status: string;
  description?: string | null;
  sourceUrl?: string | null;
  sourceDomain?: string | null;
  importMethod?: string | null;
}) {
  return {
    id: item.id,
    wishlistId: item.wishlistId,
    title: item.title,
    url: item.url || null,
    price: item.priceText ? (Number(item.priceText) || null) : null,
    currency: item.currency ?? null,
    imageUrl: item.imageUrl ?? null,
    priority: priorityToNum(item.priority),
    position: item.position ?? 0,
    status: item.status.toLowerCase(),
    description: item.description ?? null,
    sourceUrl: item.sourceUrl ?? null,
    sourceDomain: item.sourceDomain ?? null,
    importMethod: item.importMethod ?? null,
  };
}

async function getOrCreateTgUser(tgUser: TelegramUser) {
  return prisma.user.upsert({
    where: { telegramId: String(tgUser.id) },
    update: { telegramChatId: String(tgUser.id), firstName: tgUser.first_name || null },
    create: { telegramId: String(tgUser.id), telegramChatId: String(tgUser.id), firstName: tgUser.first_name || null },
  });
}

async function getOrCreateProfile(userId: string, locale?: Locale) {
  // Try to fetch an existing profile first to avoid generating a supportId we won't use.
  let profile = await prisma.userProfile.findUnique({ where: { userId } });

  if (!profile) {
    // New user: create with a fresh supportId immediately.
    const supportId = await generateUniqueSupportId();
    profile = await prisma.userProfile.create({
      data: {
        userId,
        defaultCurrency: locale === 'ru' ? 'RUB' : 'USD',
        supportId,
      },
    });
  } else if (!profile.supportId) {
    // Existing user without supportId (pre-migration row): lazy backfill.
    const supportId = await generateUniqueSupportId();
    profile = await prisma.userProfile.update({
      where: { userId },
      data: { supportId },
    });
  }

  return profile;
}

type ItemRole = 'owner' | 'reserver' | 'third_party';

async function getItemRole(
  itemId: string,
  tgUser: TelegramUser,
): Promise<{
  role: ItemRole;
  item: { id: string; status: string; reservationEpoch: number; reserverUserId: string | null; title: string; wishlist: { ownerId: string }; reservationEvents: { actorHash: string; comment: string | null }[] };
  actorHash: string;
  user: { id: string; telegramChatId: string | null };
} | null> {
  const actorHash = tgActorHash(tgUser.id);
  const user = await getOrCreateTgUser(tgUser);

  const item = await prisma.item.findUnique({
    where: { id: itemId },
    select: {
      id: true, status: true, reservationEpoch: true, reserverUserId: true, title: true,
      wishlist: { select: { ownerId: true } },
      reservationEvents: {
        where: { type: 'RESERVED' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { actorHash: true, comment: true },
      },
    },
  });
  if (!item) return null;

  if (item.wishlist.ownerId === user.id) {
    return { role: 'owner', item, actorHash, user };
  }

  if (
    item.status === 'RESERVED' &&
    item.reservationEvents.length > 0 &&
    secureCompare(item.reservationEvents[0]!.actorHash, actorHash)
  ) {
    return { role: 'reserver', item, actorHash, user };
  }

  return { role: 'third_party', item, actorHash, user };
}

tgRouter.use(requireTelegramAuth);

// GET /tg/wishlists — my wishlists
tgRouter.get(
  '/wishlists',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);

    const wishlists = await prisma.wishlist.findMany({
      where: { ownerId: user.id, type: 'REGULAR', archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],  // position first, then createdAt for readOnly calculation
      select: {
        id: true, slug: true, title: true, description: true, deadline: true,
        visibility: true, allowSubscriptions: true, commentPolicy: true,
        shareToken: true,
        items: { select: { status: true } },
      },
    });

    // Drafts count (system wishlist)
    let drafts: { wishlistId: string; count: number } | null = null;
    const draftsWl = await prisma.wishlist.findFirst({
      where: { ownerId: user.id, type: 'SYSTEM_DRAFTS' },
      select: {
        id: true,
        items: { where: { status: { in: [...ACTIVE_STATUSES] } }, select: { id: true } },
      },
    });
    if (draftsWl && draftsWl.items.length > 0) {
      drafts = { wishlistId: draftsWl.id, count: draftsWl.items.length };
    }

    // Count user's active reservations (for "My Reservations" section)
    // Includes both regular item reservations and Santa-flow SantaItemReservation rows.
    const [regularReservationsCount, santaReservationsCount] = await Promise.all([
      prisma.item.count({ where: { reserverUserId: user.id, status: 'RESERVED' } }),
      prisma.santaItemReservation.count({
        where: {
          assignment: {
            giver: { userId: user.id },
            giftStatus: { notIn: ['RECEIVED', 'ORPHANED'] },
            round: { campaign: { status: { not: 'CANCELLED' } } },
          },
        },
      }),
    ]);
    const reservationsCount = regularReservationsCount + santaReservationsCount;

    return res.json({
      wishlists: wishlists.map((wl, idx) => {
        const active = wl.items.filter((i) => (ACTIVE_STATUSES as readonly string[]).includes(i.status));
        return {
          id: wl.id,
          slug: wl.slug,
          title: wl.title,
          description: wl.description,
          deadline: wl.deadline?.toISOString() ?? null,
          itemCount: active.length,
          reservedCount: active.filter((i) => i.status !== 'AVAILABLE').length,
          readOnly: idx >= ent.effectiveWishlistLimit,
          visibility: (wl.visibility as string).toLowerCase() as 'link_only' | 'public_profile' | 'private',
          allowSubscriptions: (wl.allowSubscriptions as string).toLowerCase() as 'all' | 'nobody',
          commentPolicy: (wl.commentPolicy as string).toLowerCase() as 'all' | 'subscribers',
          shareToken: wl.shareToken ?? null,
        };
      }),
      plan: {
        code: ent.plan.code,
        wishlists: ent.effectiveWishlistLimit,
        items: ent.plan.items,
        subscriptions: ent.effectiveSubscriptionLimit,
        participants: ent.plan.participants,
        features: [...ent.plan.features],
      },
      subscription: ent.subscription,
      godMode: user.godMode,
      canGodMode: user.telegramId
        ? (process.env.GOD_MODE_TELEGRAM_IDS ?? '').split(',').filter(Boolean).includes(user.telegramId)
        : false,
      drafts,
      reservationsCount,
      addOns: {
        extraWishlistSlots: ent.addOns.filter(a => a.addonType === 'wishlist_slot').reduce((s, a) => s + a.quantity, 0),
        extraSubscriptionSlots: ent.addOns.filter(a => a.addonType === 'subscription_slot').reduce((s, a) => s + a.quantity, 0),
        seasonalWishlists: [...ent.seasonalWishlists],
        extraItemsPerWishlist: ent.extraItemsPerWishlist,
      },
      credits: {
        hintCredits: ent.hintCredits,
        importCredits: ent.importCredits,
      },
      skus: Object.values(ONE_TIME_SKUS).map(s => ({
        code: s.code,
        price: s.price,
        type: s.type,
        targetRequired: s.targetRequired,
      })),
    });
  }),
);

// GET /tg/reservations — items reserved by current user across all wishlists
tgRouter.get(
  '/reservations',
  asyncHandler(async (req, res) => {
    const locale = getRequestLocale(req);
    const user = await getOrCreateTgUser(req.tgUser!);
    const actorHash = tgActorHash(req.tgUser!.id);

    // 1. Items reserved by this user (only TG-identified reservations)
    const items = await prisma.item.findMany({
      where: { reserverUserId: user.id, status: 'RESERVED' },
      select: {
        id: true, wishlistId: true, title: true, url: true, priceText: true,
        imageUrl: true, priority: true, status: true, description: true,
        sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
        wishlist: {
          select: {
            owner: {
              select: {
                id: true, firstName: true, telegramChatId: true,
                profile: { select: { displayName: true, username: true, avatarUrl: true, avatarPublic: true } },
              },
            },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    // 2. Batch fetch read cursors
    const itemIds = items.map(i => i.id);
    const cursors = itemIds.length > 0
      ? await prisma.commentReadCursor.findMany({
          where: { userId: user.id, itemId: { in: itemIds } },
        })
      : [];
    const cursorMap = new Map(cursors.map(c => [c.itemId, c.lastReadAt]));

    // 3. Count unread comments per item
    const unreadCounts: Record<string, number> = {};
    if (itemIds.length > 0) {
      await Promise.all(itemIds.map(async (itemId) => {
        const lastRead = cursorMap.get(itemId);
        unreadCounts[itemId] = await prisma.comment.count({
          where: {
            itemId,
            type: 'USER',
            ...(lastRead ? { createdAt: { gt: lastRead } } : {}),
            NOT: { authorActorHash: actorHash },
          },
        });
      }));
    }

    // 4. Resolve owner names + avatars (batch-dedupe by ownerId)
    const uniqueOwners = new Map<string, typeof items[0]['wishlist']['owner']>();
    for (const item of items) {
      if (!uniqueOwners.has(item.wishlist.owner.id)) {
        uniqueOwners.set(item.wishlist.owner.id, item.wishlist.owner);
      }
    }
    const ownerNames = new Map<string, string>();
    const ownerAvatarUrls = new Map<string, string | null>();
    await Promise.all(
      [...uniqueOwners.entries()].map(async ([ownerId, owner]) => {
        ownerNames.set(ownerId, await resolveUserFirstName(owner, locale));
        const profile = owner.profile;
        ownerAvatarUrls.set(
          ownerId,
          (profile?.avatarPublic !== false && profile?.avatarUrl) ? profile.avatarUrl : null,
        );
      }),
    );

    // 5. Map response
    const reservations = items.map(item => ({
      ...mapTgItem(item),
      ownerName: ownerNames.get(item.wishlist.owner.id) ?? t('api_user_fallback', locale),
      ownerAvatarUrl: ownerAvatarUrls.get(item.wishlist.owner.id) ?? null,
      ownerId: item.wishlist.owner.id,
      unreadComments: unreadCounts[item.id] ?? 0,
    }));

    return res.json({ reservations });
  }),
);

// GET /tg/santa/my-reservations — Santa items reserved by the current user (giver view)
// Excludes: campaign CANCELLED, assignment giftStatus RECEIVED or ORPHANED (both terminal).
// SELECTED_OUTSIDE already deletes SantaItemReservation rows in the status-change handler,
// so those never appear here naturally.
tgRouter.get('/santa/my-reservations', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);

  const rows = await prisma.santaItemReservation.findMany({
    where: {
      assignment: {
        giver: { userId: user.id },
        giftStatus: { notIn: ['RECEIVED', 'ORPHANED'] },
        round: { campaign: { status: { not: 'CANCELLED' } } },
      },
    },
    select: {
      assignmentId: true,
      item: {
        select: {
          id: true, wishlistId: true, title: true, url: true, priceText: true,
          imageUrl: true, priority: true, status: true, description: true,
          sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
        },
      },
      assignment: {
        select: {
          id: true,
          giftStatus: true,
          round: {
            select: {
              campaign: { select: { id: true, title: true, status: true } },
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const reservations = rows.map(r => ({
    ...mapTgItem(r.item),
    campaignId: r.assignment.round.campaign.id,
    campaignTitle: r.assignment.round.campaign.title,
    campaignStatus: r.assignment.round.campaign.status,
    giftStatus: r.assignment.giftStatus,
    assignmentId: r.assignmentId,
  }));

  return res.json({ reservations });
}));

// POST /tg/wishlists/:id/share-token — get or create share token for a wishlist (owner only)
tgRouter.post(
  '/wishlists/:id/share-token',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({
      where: { id },
      select: { id: true, ownerId: true, shareToken: true },
    });
    if (!wishlist || wishlist.ownerId !== user.id) {
      return res.status(404).json({ error: 'Wishlist not found' });
    }

    if (wishlist.shareToken) {
      return res.json({ shareToken: wishlist.shareToken });
    }

    const token = await generateUniqueShareToken();
    const updated = await prisma.wishlist.update({
      where: { id },
      data: { shareToken: token },
      select: { shareToken: true },
    });

    return res.json({ shareToken: updated.shareToken });
  }),
);

// POST /tg/wishlists/reorder — update wishlist positions (owner only)
tgRouter.post(
  '/wishlists/reorder',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({ orderedIds: z.array(z.string()).min(1).max(200) })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const { orderedIds } = parsed.data;

    // Verify all IDs belong to this user and are REGULAR non-archived wishlists
    const wishlists = await prisma.wishlist.findMany({
      where: { ownerId: user.id, type: 'REGULAR', archivedAt: null, id: { in: orderedIds } },
      select: { id: true },
    });
    if (wishlists.length !== orderedIds.length) {
      return res.status(400).json({ error: 'Some wishlist IDs are invalid or not owned by you' });
    }

    // Transactionally assign positions based on orderedIds index
    await prisma.$transaction(
      orderedIds.map((id, idx) =>
        prisma.wishlist.update({ where: { id }, data: { position: idx } }),
      ),
    );

    return res.json({ ok: true });
  }),
);

// POST /tg/wishlists — create wishlist
tgRouter.post(
  '/wishlists',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        title: z.string().min(1).max(200),
        deadline: z.string().datetime().nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id);
    const count = await prisma.wishlist.count({ where: { ownerId: user.id, type: 'REGULAR', archivedAt: null } });
    if (count >= ent.effectiveWishlistLimit) {
      trackEvent('feature_gate_hit_wishlist_limit', user.id, { plan: ent.plan.code, count, limit: ent.effectiveWishlistLimit });
      return res.status(402).json({ error: 'Plan limit reached', limit: ent.effectiveWishlistLimit, planCode: ent.plan.code });
    }

    // Determine insert position + inherit privacy defaults from profile
    const profile = await prisma.userProfile.findUnique({ where: { userId: user.id }, select: { newWishlistPosition: true, commentsEnabled: true } });
    // "top" is a PRO feature — FREE users always append to bottom regardless of stored value
    const addToTop = ent.isPro && profile?.newWishlistPosition === 'top';

    let newPosition: number;
    if (addToTop) {
      // Shift all existing REGULAR non-archived wishlists up by 1, then insert at 0
      await prisma.wishlist.updateMany({
        where: { ownerId: user.id, type: 'REGULAR', archivedAt: null },
        data: { position: { increment: 1 } },
      });
      newPosition = 0;
    } else {
      // Append at the end
      const maxResult = await prisma.wishlist.aggregate({
        where: { ownerId: user.id, type: 'REGULAR', archivedAt: null },
        _max: { position: true },
      });
      newPosition = (maxResult._max.position ?? -1) + 1;
    }

    const slug = await generateUniqueSlug(parsed.data.title);
    // Inherit commentPolicy from profile default: commentsEnabled=false → SUBSCRIBERS, else ALL
    const inheritedCommentPolicy = profile?.commentsEnabled === false ? 'SUBSCRIBERS' : 'ALL';
    const wishlist = await prisma.wishlist.create({
      data: {
        slug,
        ownerId: user.id,
        title: parsed.data.title,
        deadline: parsed.data.deadline ? new Date(parsed.data.deadline) : null,
        position: newPosition,
        commentPolicy: inheritedCommentPolicy,
      },
      select: { id: true, slug: true, title: true, description: true, deadline: true },
    });

    return res.status(201).json({
      wishlist: { ...wishlist, deadline: wishlist.deadline?.toISOString() ?? null, itemCount: 0, reservedCount: 0 },
    });
  }),
);

// PATCH /tg/wishlists/:id — update wishlist (title, deadline, privacy settings)
tgRouter.patch(
  '/wishlists/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });

    const parsed = z
      .object({
        title: z.string().min(1).max(200).optional(),
        deadline: z.string().datetime().nullable().optional(),
        visibility: z.enum(['LINK_ONLY', 'PUBLIC_PROFILE', 'PRIVATE']).optional(),
        allowSubscriptions: z.enum(['ALL', 'NOBODY']).optional(),
        commentPolicy: z.enum(['ALL', 'SUBSCRIBERS']).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getUserEntitlement(user.id, user.godMode);
    const isPro = ent.plan.code !== 'FREE';

    const wishlist = await prisma.wishlist.findUnique({ where: { id }, select: { ownerId: true, title: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // PRO-gate advanced visibility modes
    if (!isPro && (parsed.data.visibility === 'PUBLIC_PROFILE' || parsed.data.visibility === 'PRIVATE')) {
      return res.status(403).json({ error: 'pro_required', message: 'Upgrade to Pro to use this visibility setting' });
    }
    if (!isPro && parsed.data.allowSubscriptions === 'NOBODY') {
      return res.status(403).json({ error: 'pro_required', message: 'Upgrade to Pro to restrict subscriptions' });
    }
    if (!isPro && parsed.data.commentPolicy === 'SUBSCRIBERS') {
      return res.status(403).json({ error: 'pro_required', message: 'Upgrade to Pro to restrict comments' });
    }

    // Detect which subscriber-visible fields are changing
    const wlChangedFields: string[] = [];
    if (parsed.data.title !== undefined) wlChangedFields.push('wishlist_title');
    if (parsed.data.deadline !== undefined) wlChangedFields.push('wishlist_deadline');

    const updated = await prisma.wishlist.update({
      where: { id },
      data: {
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.deadline !== undefined
          ? { deadline: parsed.data.deadline ? new Date(parsed.data.deadline) : null }
          : {}),
        ...(parsed.data.visibility !== undefined ? { visibility: parsed.data.visibility } : {}),
        ...(parsed.data.allowSubscriptions !== undefined ? { allowSubscriptions: parsed.data.allowSubscriptions } : {}),
        ...(parsed.data.commentPolicy !== undefined ? { commentPolicy: parsed.data.commentPolicy } : {}),
      },
      select: {
        id: true, slug: true, title: true, description: true, deadline: true,
        visibility: true, allowSubscriptions: true, commentPolicy: true,
      },
    });

    // Notify subscribers of wishlist-level change
    if (wlChangedFields.length > 0) {
      void notifySubscribersOfChange(
        id,
        id,
        wlChangedFields,
        'wishlist_updated',
        { wishlistTitle: updated.title },
      );
    }

    return res.json({
      wishlist: {
        ...updated,
        deadline: updated.deadline?.toISOString() ?? null,
        visibility: (updated.visibility as string).toLowerCase(),
        allowSubscriptions: (updated.allowSubscriptions as string).toLowerCase(),
        commentPolicy: (updated.commentPolicy as string).toLowerCase(),
      },
    });
  }),
);

// DELETE /tg/wishlists/:id — delete wishlist
tgRouter.delete(
  '/wishlists/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({ where: { id }, select: { ownerId: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Block deletion if wishlist is linked to an active Santa campaign
    const activeSantaLink = await prisma.santaParticipant.findFirst({
      where: { linkedWishlistId: id, campaign: { status: { notIn: ['COMPLETED', 'CANCELLED'] } } },
      include: { campaign: { select: { title: true } } },
    });
    if (activeSantaLink) {
      return res.status(409).json({ error: 'wishlist_in_santa_campaign', campaignTitle: activeSantaLink.campaign.title });
    }

    await prisma.wishlist.delete({ where: { id } });

    // Repack positions for remaining REGULAR non-archived wishlists to keep them contiguous
    const remaining = await prisma.wishlist.findMany({
      where: { ownerId: user.id, type: 'REGULAR', archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    if (remaining.length > 0) {
      await prisma.$transaction(
        remaining.map((wl, idx) =>
          prisma.wishlist.update({ where: { id: wl.id }, data: { position: idx } }),
        ),
      );
    }

    return res.json({ ok: true });
  }),
);

// POST /tg/wishlists/:id/transfer-items — move RESERVED items to another wishlist before deletion
tgRouter.post(
  '/wishlists/:id/transfer-items',
  asyncHandler(async (req, res) => {
    const sourceId = req.params.id ?? '';
    if (!sourceId) return res.status(400).json({ error: 'Missing wishlist id' });

    const parsed = z
      .object({ targetWishlistId: z.string().min(1) })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const { targetWishlistId } = parsed.data;
    if (targetWishlistId === sourceId) {
      return res.status(400).json({ error: 'Source and target must be different' });
    }

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getUserEntitlement(user.id, user.godMode);

    // Verify ownership of both wishlists
    const [source, target] = await Promise.all([
      prisma.wishlist.findUnique({ where: { id: sourceId }, select: { ownerId: true, title: true } }),
      prisma.wishlist.findUnique({ where: { id: targetWishlistId }, select: { ownerId: true, title: true, archivedAt: true } }),
    ]);
    if (!source) return res.status(404).json({ error: 'Source wishlist not found' });
    if (source.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (!target) return res.status(404).json({ error: 'Target wishlist not found' });
    if (target.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (target.archivedAt) return res.status(409).json({ error: 'target_archived', message: 'Target wishlist is archived' });

    // Get reserved items from source
    const reservedItems = await prisma.item.findMany({
      where: { wishlistId: sourceId, status: 'RESERVED' },
      select: { id: true },
    });
    if (reservedItems.length === 0) {
      return res.json({ transferred: 0, targetWishlistId, targetTitle: target.title });
    }

    // Check target capacity
    const targetActiveCount = await prisma.item.count({
      where: { wishlistId: targetWishlistId, status: { in: [...ACTIVE_STATUSES] } },
    });
    const available = ent.plan.items - targetActiveCount;
    if (available < reservedItems.length) {
      return res.status(409).json({
        error: 'insufficient_capacity',
        message: `Target wishlist can accept ${available} more items but ${reservedItems.length} items need to be transferred`,
        available,
        needed: reservedItems.length,
      });
    }

    // Move all reserved items to target
    const itemIds = reservedItems.map((i) => i.id);
    await prisma.item.updateMany({
      where: { id: { in: itemIds } },
      data: { wishlistId: targetWishlistId },
    });

    return res.json({ transferred: reservedItems.length, targetWishlistId, targetTitle: target.title });
  }),
);

// POST /tg/wishlists/:id/archive — soft-archive a wishlist (owner only)
tgRouter.post(
  '/wishlists/:id/archive',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({ where: { id }, select: { ownerId: true, archivedAt: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (wishlist.archivedAt) return res.status(409).json({ error: 'Already archived' });

    // Block archiving if wishlist is linked to an active Santa campaign
    const activeSantaLink = await prisma.santaParticipant.findFirst({
      where: { linkedWishlistId: id, campaign: { status: { notIn: ['COMPLETED', 'CANCELLED'] } } },
      include: { campaign: { select: { title: true } } },
    });
    if (activeSantaLink) {
      return res.status(409).json({ error: 'wishlist_in_santa_campaign', campaignTitle: activeSantaLink.campaign.title });
    }

    await prisma.wishlist.update({ where: { id }, data: { archivedAt: new Date() } });
    return res.json({ ok: true });
  }),
);

// POST /tg/wishlists/:id/unarchive — restore a soft-archived wishlist (owner only)
tgRouter.post(
  '/wishlists/:id/unarchive',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({ where: { id }, select: { ownerId: true, archivedAt: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    await prisma.wishlist.update({ where: { id }, data: { archivedAt: null } });
    return res.json({ ok: true });
  }),
);

// POST /tg/wishlists/:id/subscribe — subscribe to a wishlist (non-owner only)
tgRouter.post(
  '/wishlists/:id/subscribe',
  asyncHandler(async (req, res) => {
    const wishlistId = req.params.id ?? '';
    if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({
      where: { id: wishlistId },
      select: { ownerId: true, title: true, shareToken: true, archivedAt: true, allowSubscriptions: true },
    });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId === user.id) return res.status(400).json({ error: 'Cannot subscribe to your own wishlist' });

    // Check wishlist-level allowSubscriptions override
    if (wishlist.allowSubscriptions === 'NOBODY') {
      return res.status(403).json({ error: 'subscriptions_closed' });
    }

    // Check owner's global subscribePolicy
    const ownerProfile = await prisma.userProfile.findUnique({
      where: { userId: wishlist.ownerId },
      select: { subscribePolicy: true },
    });
    if (ownerProfile?.subscribePolicy === 'NOBODY') {
      return res.status(403).json({ error: 'subscriptions_closed' });
    }

    // Check effective subscription limit (base plan + any purchased extra slots)
    const ent = await getEffectiveEntitlements(user.id);
    const currentCount = await prisma.wishlistSubscription.count({ where: { subscriberId: user.id } });
    if (currentCount >= ent.effectiveSubscriptionLimit) {
      return res.status(402).json({ error: 'Subscription limit reached', limit: ent.effectiveSubscriptionLimit, planCode: ent.plan.code });
    }

    const sub = await prisma.wishlistSubscription.upsert({
      where: { wishlistId_subscriberId: { wishlistId, subscriberId: user.id } },
      update: {},
      create: { wishlistId, subscriberId: user.id },
      select: { id: true, wishlistId: true, createdAt: true },
    });

    return res.json({ subscription: { id: sub.id, wishlistId: sub.wishlistId } });
  }),
);

// DELETE /tg/wishlists/:id/subscribe — unsubscribe from a wishlist
tgRouter.delete(
  '/wishlists/:id/subscribe',
  asyncHandler(async (req, res) => {
    const wishlistId = req.params.id ?? '';
    if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    await prisma.wishlistSubscription.deleteMany({ where: { wishlistId, subscriberId: user.id } });
    return res.json({ ok: true });
  }),
);

// GET /tg/wishlists/:id/subscribe — subscription status + subscriber count (for guest view)
tgRouter.get(
  '/wishlists/:id/subscribe',
  asyncHandler(async (req, res) => {
    const wishlistId = req.params.id ?? '';
    if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);

    const [sub, subscriberCount] = await Promise.all([
      prisma.wishlistSubscription.findUnique({
        where: { wishlistId_subscriberId: { wishlistId, subscriberId: user.id } },
        select: { id: true },
      }),
      prisma.wishlistSubscription.count({ where: { wishlistId } }),
    ]);

    return res.json({ subscribed: !!sub, subscriberCount });
  }),
);

// GET /tg/me/subscriptions — wishlists the user is subscribed to, with unread counts
tgRouter.get(
  '/me/subscriptions',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);

    const subs = await prisma.wishlistSubscription.findMany({
      where: { subscriberId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        wishlistId: true,
        createdAt: true,
        unreads: { select: { id: true, entityId: true, fieldName: true } },
        wishlist: {
          select: {
            id: true,
            slug: true,
            title: true,
            deadline: true,
            archivedAt: true,
            owner: {
              select: {
                firstName: true,
                telegramId: true,
                profile: { select: { displayName: true, username: true, avatarUrl: true, avatarPublic: true } },
              },
            },
            items: {
              where: { status: { in: [...ACTIVE_STATUSES] } },
              select: { id: true },
            },
          },
        },
      },
    });

    const result = subs.map((sub) => ({
      id: sub.id,
      wishlist: {
        id: sub.wishlist.id,
        slug: sub.wishlist.slug,
        title: sub.wishlist.title,
        deadline: sub.wishlist.deadline?.toISOString() ?? null,
        archivedAt: sub.wishlist.archivedAt?.toISOString() ?? null,
        itemCount: sub.wishlist.items.length,
        ownerName: sub.wishlist.owner.profile?.displayName?.trim() ||
          sub.wishlist.owner.profile?.username?.trim() ||
          sub.wishlist.owner.firstName?.trim() ||
          '…',
        ownerAvatarUrl: (sub.wishlist.owner.profile?.avatarPublic !== false && sub.wishlist.owner.profile?.avatarUrl)
          ? sub.wishlist.owner.profile.avatarUrl
          : null,
      },
      unreadCount: sub.unreads.length,
      unreadEntityIds: [...new Set(sub.unreads.map((u) => u.entityId))],
    }));

    return res.json({ subscriptions: result });
  }),
);

// POST /tg/me/subscriptions/:id/read — mark all unreads as read for a subscription
tgRouter.post(
  '/me/subscriptions/:id/read',
  asyncHandler(async (req, res) => {
    const subId = req.params.id ?? '';
    if (!subId) return res.status(400).json({ error: 'Missing subscription id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const sub = await prisma.wishlistSubscription.findUnique({
      where: { id: subId },
      select: { subscriberId: true },
    });
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });
    if (sub.subscriberId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    await prisma.subscriptionUnread.deleteMany({ where: { subId } });
    return res.json({ ok: true });
  }),
);

// GET /tg/wishlists/:id/items — owner view (no reservation names)
tgRouter.get(
  '/wishlists/:id/items',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({ where: { id }, select: { ownerId: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const items = await prisma.item.findMany({
      where: { wishlistId: id, status: { in: [...ACTIVE_STATUSES] } },
      orderBy: ITEM_ORDER_BY,
      select: {
        id: true, wishlistId: true, title: true, url: true, priceText: true,
        imageUrl: true, priority: true, position: true, status: true, description: true,
        sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
      },
    });

    return res.json({ items: items.map(mapTgItem) });
  }),
);

// POST /tg/wishlists/:id/items/reorder — reorder items within their priority group (owner only)
tgRouter.post(
  '/wishlists/:id/items/reorder',
  asyncHandler(async (req, res) => {
    const wishlistId = req.params.id ?? '';
    if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });

    const parsed = z
      .object({
        groups: z.array(z.object({
          priority: z.enum(['LOW', 'MEDIUM', 'HIGH']),
          orderedIds: z.array(z.string()).min(1).max(500),
        })).min(1).max(3),
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({
      where: { id: wishlistId },
      select: { ownerId: true },
    });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const { groups } = parsed.data;
    const allIds = groups.flatMap(g => g.orderedIds);

    // Verify all IDs belong to this wishlist and match their declared priority
    const dbItems = await prisma.item.findMany({
      where: { id: { in: allIds }, wishlistId },
      select: { id: true, priority: true },
    });
    if (dbItems.length !== allIds.length) {
      return res.status(400).json({ error: 'Some item IDs are invalid or not in this wishlist' });
    }
    const dbItemMap = new Map(dbItems.map(i => [i.id, i]));
    for (const group of groups) {
      for (const id of group.orderedIds) {
        if (dbItemMap.get(id)?.priority !== group.priority) {
          return res.status(400).json({ error: `Item ${id} does not belong to priority group ${group.priority}` });
        }
      }
    }

    // Transactionally assign positions within each priority group
    await prisma.$transaction(
      groups.flatMap(group =>
        group.orderedIds.map((id, idx) =>
          prisma.item.update({ where: { id }, data: { position: idx } }),
        ),
      ),
    );

    return res.json({ ok: true });
  }),
);

// GET /tg/items — flat list of all items across all user's active wishlists
tgRouter.get(
  '/items',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const items = await prisma.item.findMany({
      where: {
        wishlist: { ownerId: user.id, archivedAt: null },
        status: { in: [...ACTIVE_STATUSES] },
        archivedAt: null,
      },
      orderBy: [{ wishlistId: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true, wishlistId: true, title: true, url: true, priceText: true,
        imageUrl: true, priority: true, status: true, description: true,
        sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
        wishlist: { select: { title: true, slug: true } },
      },
    });
    return res.json({
      items: items.map(({ wishlist, ...rest }) => ({
        ...mapTgItem(rest),
        wishlistTitle: wishlist.title,
        wishlistSlug: wishlist.slug,
      })),
    });
  }),
);

// POST /tg/wishlists/:id/items — add item
tgRouter.post(
  '/wishlists/:id/items',
  asyncHandler(async (req, res) => {
    const wishlistId = req.params.id ?? '';
    if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });

    const parsed = z
      .object({
        title: z.string().min(1).max(200),
        url: z.string().url().optional(),
        price: z.number().int().nonnegative().nullable().optional(),
        priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        imageUrl: z.string().url().optional(),
        currency: z.enum(['RUB', 'USD']).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id);
    const wishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId }, select: { ownerId: true, type: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Read-only check for over-limit wishlists (only REGULAR)
    if (wishlist.type === 'REGULAR' && !(await isWishlistWritable(user.id, wishlistId, ent.effectiveWishlistLimit))) {
      return res.status(402).json({ error: 'Wishlist is read-only on current plan', planCode: ent.plan.code });
    }

    // Per-wishlist item limit = plan base + any permanent item upgrades for this wishlist
    const effectiveItemLimit = ent.plan.items + (ent.extraItemsPerWishlist[wishlistId] ?? 0);
    const itemCount = await prisma.item.count({ where: { wishlistId, status: { in: [...ACTIVE_STATUSES] } } });
    if (itemCount >= effectiveItemLimit) {
      trackEvent('feature_gate_hit_item_limit', user.id, { plan: ent.plan.code, count: itemCount, limit: effectiveItemLimit });
      return res.status(402).json({ error: 'Plan limit reached', limit: effectiveItemLimit, planCode: ent.plan.code });
    }

    // Resolve currency: use provided value, or fall back to user's profile default
    let currency = parsed.data.currency;
    if (!currency) {
      const profile = await getOrCreateProfile(user.id, getRequestLocale(req));
      currency = profile.defaultCurrency;
    }

    const wlForSub = await prisma.wishlist.findUnique({ where: { id: wishlistId }, select: { title: true } });

    const item = await prisma.item.create({
      data: {
        wishlistId,
        title: parsed.data.title,
        url: parsed.data.url ?? '',
        priceText: parsed.data.price != null ? String(parsed.data.price) : null,
        priority: numToPriority(parsed.data.priority ?? 2),
        imageUrl: parsed.data.imageUrl ?? null,
        currency,
      },
      select: { id: true, wishlistId: true, title: true, url: true, priceText: true, currency: true, imageUrl: true, priority: true, position: true, status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true },
    });

    // Notify wishlist subscribers
    void notifySubscribersOfChange(
      wishlistId,
      item.id,
      ['title'],
      'item_added',
      {
        itemTitle: item.title,
        wishlistTitle: wlForSub?.title ?? '…',
        ownerName: req.tgUser?.first_name ?? '…',
      },
    );

    return res.status(201).json({ item: mapTgItem(item) });
  }),
);

// POST /tg/items/bulk-move — move multiple items to a target wishlist
tgRouter.post(
  '/items/bulk-move',
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      itemIds: z.array(z.string().min(1)).min(1).max(100),
      targetWishlistId: z.string().min(1),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getUserEntitlement(user.id);
    const { itemIds, targetWishlistId } = parsed.data;

    // Validate target wishlist ownership + not a SYSTEM wishlist
    const targetWl = await prisma.wishlist.findUnique({
      where: { id: targetWishlistId },
      select: { id: true, ownerId: true, type: true },
    });
    if (!targetWl) return res.status(404).json({ error: 'Target wishlist not found' });
    if (targetWl.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (targetWl.type === 'SYSTEM_DRAFTS') return res.status(400).json({ error: 'Cannot move to system wishlist' });

    // Check target wishlist writable on current plan
    if (targetWl.type === 'REGULAR') {
      if (!(await isWishlistWritable(user.id, targetWl.id, ent.plan.wishlists))) {
        return res.status(402).json({ error: t('api_wishlist_items_limit', getRequestLocale(req)), planCode: ent.plan.code });
      }
    }

    // Load all requested items — filter to only those owned by the user and not already in target
    const items = await prisma.item.findMany({
      where: { id: { in: itemIds }, status: { in: [...ACTIVE_STATUSES] } },
      select: { id: true, wishlistId: true, wishlist: { select: { ownerId: true } } },
    });
    const ownedItems = items.filter(
      (i) => i.wishlist.ownerId === user.id && i.wishlistId !== targetWishlistId,
    );
    const notOwnedIds = itemIds.filter((id) => !items.find((i) => i.id === id) || items.find((i) => i.id === id)?.wishlist.ownerId !== user.id);

    // Check capacity: how many slots are available in the target wishlist
    const currentTargetCount = await prisma.item.count({
      where: { wishlistId: targetWishlistId, status: { in: [...ACTIVE_STATUSES] } },
    });
    const available = Math.max(0, ent.plan.items - currentTargetCount);
    const toMove = ownedItems.slice(0, available);
    const overLimit = ownedItems.slice(available);

    // Move in a transaction
    if (toMove.length > 0) {
      await prisma.$transaction(
        toMove.map((item) =>
          prisma.item.update({ where: { id: item.id }, data: { wishlistId: targetWishlistId } }),
        ),
      );
    }

    const failed = [
      ...notOwnedIds.map((id) => ({ itemId: id, reason: 'not_found_or_forbidden' })),
      ...overLimit.map((i) => ({ itemId: i.id, reason: 'limit_reached' })),
    ];
    return res.json({ moved: toMove.map((i) => i.id), failed });
  }),
);

// POST /tg/items/bulk-delete — soft-delete multiple items
tgRouter.post(
  '/items/bulk-delete',
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      itemIds: z.array(z.string().min(1)).min(1).max(100),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const { itemIds } = parsed.data;

    // Load and verify ownership
    const items = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, wishlist: { select: { ownerId: true } } },
    });
    const ownedIds = items
      .filter((i) => i.wishlist.ownerId === user.id)
      .map((i) => i.id);

    if (ownedIds.length === 0) return res.json({ deleted: 0 });

    const now = new Date();
    await prisma.$transaction(
      ownedIds.map((id) =>
        prisma.item.update({
          where: { id },
          data: {
            status: 'DELETED',
            archivedAt: now,
            purgeAfter: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
          },
        }),
      ),
    );

    return res.json({ deleted: ownedIds.length });
  }),
);

// POST /tg/items/bulk-restore — restore multiple archived items
// Must be placed before /items/:id to avoid route param collision.
tgRouter.post(
  '/items/bulk-restore',
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      itemIds: z.array(z.string().min(1)).min(1).max(100),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const { itemIds } = parsed.data;

    // Load all requested items with wishlist info for ownership + archived check
    const items = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: {
        id: true,
        status: true,
        wishlist: { select: { ownerId: true, archivedAt: true } },
      },
    });

    const restored: string[] = [];
    const failed: Array<{ itemId: string; reason: string }> = [];

    const toRestore: string[] = [];
    for (const req_id of itemIds) {
      const item = items.find((i) => i.id === req_id);
      if (!item || item.wishlist.ownerId !== user.id) {
        failed.push({ itemId: req_id, reason: 'not_found_or_forbidden' });
        continue;
      }
      if (item.status !== 'DELETED' && item.status !== 'COMPLETED') {
        failed.push({ itemId: req_id, reason: 'not_archived' });
        continue;
      }
      if (item.wishlist.archivedAt !== null) {
        failed.push({ itemId: req_id, reason: 'wishlist_archived' });
        continue;
      }
      toRestore.push(req_id);
    }

    if (toRestore.length > 0) {
      await prisma.item.updateMany({
        where: { id: { in: toRestore } },
        data: { status: 'AVAILABLE', archivedAt: null, purgeAfter: null },
      });
      restored.push(...toRestore);
    }

    return res.json({ ok: true, restored, failed });
  }),
);

// POST /tg/items/bulk-hard-delete — permanently delete archived items
// Hard delete is only permitted for items in DELETED or COMPLETED status.
// Must be placed before /items/:id to avoid route param collision.
tgRouter.post(
  '/items/bulk-hard-delete',
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      itemIds: z.array(z.string().min(1)).min(1).max(100),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const { itemIds } = parsed.data;

    // Only allow hard-delete for owned items that are already archived
    const items = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: {
        id: true,
        status: true,
        imageUrl: true,
        wishlist: { select: { ownerId: true } },
      },
    });

    const eligibleIds = items
      .filter(
        (i) =>
          i.wishlist.ownerId === user.id &&
          (i.status === 'DELETED' || i.status === 'COMPLETED'),
      )
      .map((i) => i.id);

    if (eligibleIds.length === 0) return res.json({ deleted: 0 });

    // Hard-delete — Prisma cascades handle child records (reservationEvents, itemTags, comments)
    await prisma.item.deleteMany({ where: { id: { in: eligibleIds } } });

    return res.json({ deleted: eligibleIds.length });
  }),
);

// POST /tg/archive/purge — permanently delete ALL archived items for the current user
// Two-step confirmation is enforced in the frontend; this endpoint is the final destructive step.
tgRouter.post(
  '/archive/purge',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);

    const items = await prisma.item.findMany({
      where: {
        status: { in: ['DELETED', 'COMPLETED'] },
        wishlist: { ownerId: user.id },
      },
      select: { id: true },
    });

    if (items.length === 0) return res.json({ deleted: 0 });

    await prisma.item.deleteMany({
      where: { id: { in: items.map((i) => i.id) } },
    });

    return res.json({ deleted: items.length });
  }),
);

// PATCH /tg/items/:id — edit item
tgRouter.patch(
  '/items/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const parsed = z
      .object({
        title: z.string().min(1).max(200).optional(),
        url: z.string().url().nullable().optional(),
        price: z.number().int().nonnegative().nullable().optional(),
        priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        imageUrl: z.string().url().nullable().optional(),
        description: z.string().max(500).nullable().optional(),
        currency: z.enum(['RUB', 'USD']).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, status: true, reservationEpoch: true, reserverUserId: true, title: true, wishlistId: true, wishlist: { select: { ownerId: true, title: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Detect which subscriber-visible fields are changing
    const subChangedFields: string[] = [];
    if (parsed.data.title !== undefined) subChangedFields.push('title');
    if (parsed.data.price !== undefined) subChangedFields.push('price');
    if (parsed.data.description !== undefined) subChangedFields.push('description');
    if (parsed.data.priority !== undefined) subChangedFields.push('priority');
    if (parsed.data.url !== undefined) subChangedFields.push('url');
    if (parsed.data.imageUrl !== undefined) subChangedFields.push('image');

    const updated = await prisma.item.update({
      where: { id },
      data: {
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.url !== undefined ? { url: parsed.data.url ?? '' } : {}),
        ...(parsed.data.price !== undefined
          ? { priceText: parsed.data.price != null ? String(parsed.data.price) : null }
          : {}),
        ...(parsed.data.priority !== undefined ? { priority: numToPriority(parsed.data.priority) } : {}),
        ...(parsed.data.imageUrl !== undefined ? { imageUrl: parsed.data.imageUrl } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.currency !== undefined ? { currency: parsed.data.currency } : {}),
      },
      select: { id: true, wishlistId: true, title: true, url: true, priceText: true, currency: true, imageUrl: true, priority: true, position: true, status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true },
    });

    // Notify wishlist subscribers of item change
    if (subChangedFields.length > 0) {
      void notifySubscribersOfChange(
        item.wishlistId,
        id,
        subChangedFields,
        'item_updated',
        { itemTitle: updated.title, wishlistTitle: item.wishlist.title },
      );
    }

    // After update, if description changed and item was reserved — notify reserver
    if (parsed.data.description !== undefined && item.status === 'RESERVED') {
      const locale = getRequestLocale(req);
      await prisma.comment.create({
        data: {
          itemId: id,
          type: 'SYSTEM',
          text: t('api_system_description_updated', locale),
          reservationEpoch: item.reservationEpoch,
        },
      });
      if (item.reserverUserId) {
        const reserver = await prisma.user.findUnique({
          where: { id: item.reserverUserId },
          select: { telegramChatId: true },
        });
        if (reserver?.telegramChatId) {
          const notifLocale: Locale = 'ru'; // notifications to other users default to Russian
          void sendTgNotification(reserver.telegramChatId, t('notif_description_updated', notifLocale, { title: item.title }));
        }
      }
    }

    return res.json({ item: mapTgItem(updated) });
  }),
);

// DELETE /tg/items/:id — soft-delete item (status → DELETED)
tgRouter.delete(
  '/items/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, title: true, reserverUserId: true, wishlist: { select: { ownerId: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const now = new Date();
    await prisma.item.update({
      where: { id },
      data: {
        status: 'DELETED',
        archivedAt: now,
        purgeAfter: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
      },
    });

    // Cancel active hints when item is deleted
    void cancelItemHints(id);

    // Notify reserver that item was archived
    if (item.reserverUserId) {
      const reserver = await prisma.user.findUnique({
        where: { id: item.reserverUserId },
        select: { telegramChatId: true },
      });
      if (reserver?.telegramChatId) {
        const notifLocale: Locale = 'ru'; // notifications to other users default to Russian
        void sendTgNotification(
          reserver.telegramChatId,
          t('notif_archived', notifLocale, { title: item.title }),
        );
      }
    }

    return res.json({ ok: true });
  }),
);

// POST /tg/items/:id/complete — mark item as received/completed
tgRouter.post(
  '/items/:id/complete',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, status: true, title: true, reserverUserId: true, wishlist: { select: { ownerId: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const now = new Date();
    const updated = await prisma.item.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        archivedAt: now,
        purgeAfter: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
      },
      select: { id: true, wishlistId: true, title: true, url: true, priceText: true, currency: true, imageUrl: true, priority: true, status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true },
    });

    // Cancel active hints when item is completed
    void cancelItemHints(id);

    // Set TTL on all comments when item is completed
    const ttl = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await prisma.comment.updateMany({
      where: { itemId: id, scheduledDeleteAt: null },
      data: { scheduledDeleteAt: ttl },
    });

    // Notify reserver that item was completed
    if (item.reserverUserId) {
      const reserver = await prisma.user.findUnique({
        where: { id: item.reserverUserId },
        select: { telegramChatId: true, id: true },
      });
      if (reserver?.telegramChatId) {
        const notifLocale: Locale = 'ru'; // notifications to other users default to Russian
        let msg = t('notif_completed', notifLocale, { title: item.title });
        // Soft CTA if reserver has no wishlists
        const reserverWlCount = await prisma.wishlist.count({
          where: { ownerId: reserver.id, type: 'REGULAR' },
        });
        if (reserverWlCount === 0) {
          msg += t('notif_create_your_wishlist', notifLocale);
        }
        void sendTgNotification(reserver.telegramChatId, msg);
      }
    }

    return res.json({ item: mapTgItem(updated) });
  }),
);

// POST /tg/items/:id/restore — restore item to AVAILABLE
tgRouter.post(
  '/items/:id/restore',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, status: true, wishlist: { select: { ownerId: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (item.status !== 'DELETED' && item.status !== 'COMPLETED') {
      return res.status(409).json({ error: 'Item is not archived' });
    }

    const updated = await prisma.item.update({
      where: { id },
      data: {
        status: 'AVAILABLE',
        archivedAt: null,
        purgeAfter: null,
      },
      select: {
        id: true, wishlistId: true, title: true, url: true, priceText: true,
        currency: true, imageUrl: true, priority: true, position: true,
        status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true,
        wishlist: { select: { id: true, title: true } },
      },
    });
    const { wishlist, ...itemFields } = updated;
    return res.json({ item: mapTgItem(itemFields), wishlistId: wishlist.id, wishlistTitle: wishlist.title });
  }),
);

// GET /tg/wishlists/:id/archive — archived items of a specific wishlist (DELETED + COMPLETED)
tgRouter.get(
  '/wishlists/:id/archive',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({ where: { id }, select: { ownerId: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const items = await prisma.item.findMany({
      where: { wishlistId: id, status: { in: ['DELETED', 'COMPLETED'] } },
      orderBy: ITEM_ORDER_BY,
      select: { id: true, wishlistId: true, title: true, url: true, priceText: true, currency: true, imageUrl: true, priority: true, position: true, status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true },
    });

    return res.json({ items: items.map(mapTgItem) });
  }),
);

// GET /tg/archive — global user archive (ALL DELETED + COMPLETED items across all wishlists)
tgRouter.get(
  '/archive',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);

    const items = await prisma.item.findMany({
      where: {
        status: { in: ['DELETED', 'COMPLETED'] },
        wishlist: { ownerId: user.id },
      },
      orderBy: [{ updatedAt: 'desc' }],
      select: {
        id: true, wishlistId: true, title: true, url: true, priceText: true,
        currency: true, imageUrl: true, priority: true, position: true,
        status: true, description: true, sourceUrl: true, sourceDomain: true,
        importMethod: true,
        wishlist: { select: { id: true, title: true, archivedAt: true } },
      },
    });

    return res.json({
      items: items.map(({ wishlist, ...item }) => ({
        ...mapTgItem(item),
        wishlistTitle: wishlist.title,
        wishlistId: wishlist.id,
        wishlistIsArchived: wishlist.archivedAt !== null,
      })),
    });
  }),
);

// POST /tg/items/:id/reserve — guest reserves (name stored as comment for other guests to see)
tgRouter.post(
  '/items/:id/reserve',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const parsed = z
      .object({ displayName: z.string().min(1).max(64).optional() })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const tgUser = req.tgUser!;
    const actorHash = tgActorHash(tgUser.id);
    const displayName = parsed.data.displayName ?? tgUser.first_name;

    const user = await getOrCreateTgUser(tgUser);

    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.item.findUnique({ where: { id }, select: { status: true, reservationEpoch: true, wishlistId: true } });
      if (!item) return { kind: 'not_found' as const };
      if (item.status !== 'AVAILABLE') return { kind: 'conflict' as const };

      // Check participant limit (based on wishlist owner's plan)
      const wishlist = await tx.wishlist.findUnique({
        where: { id: item.wishlistId },
        select: { ownerId: true },
      });
      if (wishlist) {
        const ownerEnt = await getUserEntitlement(wishlist.ownerId);
        const activeReservations = await tx.item.findMany({
          where: { wishlistId: item.wishlistId, status: 'RESERVED' },
          select: { reserverUserId: true },
          distinct: ['reserverUserId'],
        });
        const existingReserverIds = new Set(
          activeReservations.map((r) => r.reserverUserId).filter(Boolean),
        );
        if (!existingReserverIds.has(user.id) && existingReserverIds.size >= ownerEnt.plan.participants) {
          return { kind: 'participant_limit' as const, limit: ownerEnt.plan.participants };
        }
      }

      const newEpoch = item.reservationEpoch + 1;
      await tx.item.update({
        where: { id },
        data: {
          status: 'RESERVED',
          reservationEpoch: newEpoch,
          reserverUserId: user.id,
        },
      });
      await tx.reservationEvent.create({
        data: { itemId: id, type: 'RESERVED', actorHash, comment: displayName },
      });
      await tx.comment.create({
        data: { itemId: id, type: 'SYSTEM', text: t('api_system_reserved', getRequestLocale(req)), reservationEpoch: newEpoch },
      });
      // Clear TTL on existing comments (from previous unreserve)
      await tx.comment.updateMany({
        where: { itemId: id, scheduledDeleteAt: { not: null } },
        data: { scheduledDeleteAt: null },
      });
      return { kind: 'ok' as const, wishlistId: item.wishlistId };
    });

    if (result.kind === 'not_found') return res.status(404).json({ error: 'Item not found' });
    if (result.kind === 'conflict') return res.status(409).json({ error: 'Item is not available' });
    if (result.kind === 'participant_limit') return res.status(402).json({ error: 'Participant limit reached', feature: 'participant_limit', limit: result.limit });

    if (result.kind === 'ok') {
      // Notify owner
      const itemData = await prisma.item.findUnique({
        where: { id },
        select: { title: true, wishlist: { select: { ownerId: true } } },
      });
      if (itemData) {
        const owner = await prisma.user.findUnique({
          where: { id: itemData.wishlist.ownerId },
          select: { telegramChatId: true },
        });
        if (owner?.telegramChatId) {
          const notifLocale: Locale = 'ru'; // notifications to other users default to Russian
          void sendTgNotification(owner.telegramChatId, t('notif_reserved', notifLocale, { name: displayName, title: itemData.title }));
        }
      }
    }

    // Cancel active hints when item is reserved
    void cancelItemHints(id);

    return res.json({ ok: true });
  }),
);

// POST /tg/items/:id/unreserve — guest unreserves their own reservation
tgRouter.post(
  '/items/:id/unreserve',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const tgUser = req.tgUser!;
    const actorHash = tgActorHash(tgUser.id);

    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.item.findUnique({ where: { id }, select: { status: true, reservationEpoch: true } });
      if (!item) return { kind: 'not_found' as const };
      if (item.status !== 'RESERVED') return { kind: 'conflict' as const };

      const lastEvent = await tx.reservationEvent.findFirst({
        where: { itemId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { type: true, actorHash: true },
      });
      if (!lastEvent || lastEvent.type !== 'RESERVED') return { kind: 'conflict' as const };
      if (!secureCompare(lastEvent.actorHash, actorHash)) return { kind: 'forbidden' as const };

      await tx.item.update({ where: { id }, data: { status: 'AVAILABLE', reserverUserId: null } });
      await tx.reservationEvent.create({
        data: { itemId: id, type: 'UNRESERVED', actorHash, comment: null },
      });
      await tx.comment.create({
        data: { itemId: id, type: 'SYSTEM', text: t('api_system_unreserved', getRequestLocale(req)), reservationEpoch: item.reservationEpoch },
      });
      // Set TTL on all comments
      const ttl = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await tx.comment.updateMany({
        where: { itemId: id, scheduledDeleteAt: null },
        data: { scheduledDeleteAt: ttl },
      });
      return { kind: 'ok' as const };
    });

    if (result.kind === 'not_found') return res.status(404).json({ error: 'Item not found' });
    if (result.kind === 'conflict') return res.status(409).json({ error: 'Cannot unreserve' });
    if (result.kind === 'forbidden') return res.status(403).json({ error: 'Forbidden' });
    return res.json({ ok: true });
  }),
);

// GET /tg/items/:id/comments — list comments (owner/reserver only)
tgRouter.get(
  '/items/:id/comments',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const ctx = await getItemRole(id, req.tgUser!);
    if (!ctx) return res.status(404).json({ error: 'Item not found' });
    if (ctx.role === 'third_party') return res.status(403).json({ error: 'Forbidden' });

    const comments = await prisma.comment.findMany({
      where: { itemId: id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, type: true, authorActorHash: true, authorDisplayName: true,
        text: true, reservationEpoch: true, createdAt: true,
      },
    });

    // For reserver: anonymize previous epoch comments
    const locale = getRequestLocale(req);
    const mapped = comments.map((c) => {
      if (
        ctx.role === 'reserver' &&
        c.type === 'USER' &&
        c.reservationEpoch < ctx.item.reservationEpoch &&
        c.authorActorHash !== ctx.actorHash
      ) {
        return { ...c, authorDisplayName: t('comments_anon', locale), createdAt: c.createdAt.toISOString() };
      }
      return { ...c, createdAt: c.createdAt.toISOString() };
    });

    return res.json({ comments: mapped, role: ctx.role });
  }),
);

// POST /tg/items/:id/comments — create comment (owner/reserver only)
tgRouter.post(
  '/items/:id/comments',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const ctx = await getItemRole(id, req.tgUser!);
    if (!ctx) return res.status(404).json({ error: 'Item not found' });
    if (ctx.role === 'third_party') return res.status(403).json({ error: 'Forbidden' });

    // Feature gate: comments require PRO — allowed if either owner or commenter has it
    const ownerEnt = await getUserEntitlement(ctx.item.wishlist.ownerId);
    const commenterEnt = ctx.role === 'owner' ? ownerEnt : await getUserEntitlement(ctx.user.id);
    if (!ownerEnt.plan.features.includes('comments') && !commenterEnt.plan.features.includes('comments')) {
      trackEvent('feature_gate_hit_comments', ctx.user.id);
      return res.status(402).json({ error: 'Pro feature', feature: 'comments', planCode: commenterEnt.plan.code });
    }

    // Check wishlist commentPolicy (subscribers-only restriction)
    if (ctx.role !== 'owner') {
      const itemWishlist = await prisma.item.findUnique({
        where: { id },
        select: { wishlist: { select: { id: true, commentPolicy: true } } },
      });
      if (itemWishlist?.wishlist.commentPolicy === 'SUBSCRIBERS') {
        const isSub = await prisma.wishlistSubscription.findFirst({
          where: { wishlistId: itemWishlist.wishlist.id, subscriberId: ctx.user.id },
          select: { id: true },
        });
        if (!isSub) {
          return res.status(403).json({ error: 'comments_restricted' });
        }
      }
    }

    // Reject archived items
    if (ctx.item.status === 'COMPLETED' || ctx.item.status === 'DELETED') {
      const locale = getRequestLocale(req);
      return res.status(400).json({ error: t('api_comment_archived', locale) });
    }

    // Validate text
    const parsed = z.object({ text: z.string().min(1).max(300) }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const text = parsed.data.text.trim();
    if (!text) {
      const locale = getRequestLocale(req);
      return res.status(400).json({ error: t('api_comment_empty', locale) });
    }

    // Reject emoji/dots only
    const stripped = text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s.…]+/gu, '');
    if (stripped.length === 0) {
      const locale = getRequestLocale(req);
      return res.status(400).json({ error: t('api_comment_meaningful', locale) });
    }

    // Anti-spam checks
    const now = Date.now();

    // 1. Cooldown 10s
    const lastComment = await prisma.comment.findFirst({
      where: { itemId: id, authorActorHash: ctx.actorHash, type: 'USER' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, text: true },
    });
    if (lastComment && now - lastComment.createdAt.getTime() < 10_000) {
      return res.status(429).json({ error: t('api_comment_cooldown', getRequestLocale(req)) });
    }

    // 2. Deduplicate
    if (lastComment && lastComment.text === text) {
      return res.status(400).json({ error: t('api_comment_duplicate', getRequestLocale(req)) });
    }

    // 3. Max 3 consecutive without reply
    const recent3 = await prisma.comment.findMany({
      where: { itemId: id, type: 'USER' },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { authorActorHash: true },
    });
    if (recent3.length >= 3 && recent3.every((c) => c.authorActorHash === ctx.actorHash)) {
      return res.status(429).json({ error: t('api_comment_wait_reply', getRequestLocale(req)) });
    }

    // 4. Max 10/hour
    const hourAgo = new Date(now - 3600_000);
    const hourCount = await prisma.comment.count({
      where: { itemId: id, authorActorHash: ctx.actorHash, type: 'USER', createdAt: { gte: hourAgo } },
    });
    if (hourCount >= 10) {
      return res.status(429).json({ error: t('api_comment_hour_limit', getRequestLocale(req)) });
    }

    // 5. Max 20/30 days
    const monthAgo = new Date(now - 30 * 86400_000);
    const monthCount = await prisma.comment.count({
      where: { itemId: id, authorActorHash: ctx.actorHash, type: 'USER', createdAt: { gte: monthAgo } },
    });
    if (monthCount >= 20) {
      return res.status(429).json({ error: t('api_comment_month_limit', getRequestLocale(req)) });
    }

    // Determine display name: use reservation display name for reserver, Telegram name for owner
    const displayName = ctx.role === 'reserver'
      ? (ctx.item.reservationEvents[0]?.comment ?? req.tgUser!.first_name)
      : req.tgUser!.first_name;

    const comment = await prisma.comment.create({
      data: {
        itemId: id,
        type: 'USER',
        authorActorHash: ctx.actorHash,
        authorDisplayName: displayName,
        text,
        reservationEpoch: ctx.item.reservationEpoch,
      },
      select: {
        id: true, type: true, authorActorHash: true, authorDisplayName: true,
        text: true, reservationEpoch: true, createdAt: true,
      },
    });

    // Notify the other party
    const notifLocale: Locale = 'ru'; // notifications to other users default to Russian
    if (ctx.role === 'reserver') {
      // Notify owner
      const owner = await prisma.user.findUnique({
        where: { id: ctx.item.wishlist.ownerId },
        select: { telegramChatId: true, id: true },
      });
      if (owner?.telegramChatId) {
        const key = `${id}:${owner.id}`;
        queueCommentNotification(key, owner.telegramChatId, ctx.item.title,
          t('notif_commented_reserver', notifLocale, { name: displayName, title: ctx.item.title, text }));
      }
    } else if (ctx.role === 'owner' && ctx.item.reserverUserId) {
      // Notify reserver
      const reserver = await prisma.user.findUnique({
        where: { id: ctx.item.reserverUserId },
        select: { telegramChatId: true, id: true },
      });
      if (reserver?.telegramChatId) {
        const key = `${id}:${reserver.id}`;
        queueCommentNotification(key, reserver.telegramChatId, ctx.item.title,
          t('notif_commented_owner', notifLocale, { title: ctx.item.title, text }));
      }
    }

    return res.status(201).json({ comment: { ...comment, createdAt: comment.createdAt.toISOString() } });
  }),
);

// DELETE /tg/items/:id/comments/:commentId — delete comment
tgRouter.delete(
  '/items/:id/comments/:commentId',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const commentId = req.params.commentId ?? '';
    if (!id || !commentId) return res.status(400).json({ error: 'Missing ids' });

    const ctx = await getItemRole(id, req.tgUser!);
    if (!ctx) return res.status(404).json({ error: 'Item not found' });
    if (ctx.role === 'third_party') return res.status(403).json({ error: 'Forbidden' });

    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, type: true, authorActorHash: true, itemId: true },
    });
    if (!comment || comment.itemId !== id) return res.status(404).json({ error: 'Comment not found' });

    // System comments cannot be deleted manually
    if (comment.type === 'SYSTEM') return res.status(403).json({ error: t('api_system_cant_delete', getRequestLocale(req)) });

    // Owner can delete any USER comment; reserver can delete only own
    if (ctx.role === 'reserver' && comment.authorActorHash !== ctx.actorHash) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.comment.delete({ where: { id: commentId } });
    return res.json({ ok: true });
  }),
);

// POST /tg/items/:id/comments/mark-read — mark comments as read for current user
tgRouter.post(
  '/items/:id/comments/mark-read',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const user = await getOrCreateTgUser(req.tgUser!);

    await prisma.commentReadCursor.upsert({
      where: { userId_itemId: { userId: user.id, itemId: id } },
      update: { lastReadAt: new Date() },
      create: { userId: user.id, itemId: id, lastReadAt: new Date() },
    });

    return res.json({ ok: true });
  }),
);

// POST /tg/items/:id/hint — create a hint wave (Pro feature, owner-only)
tgRouter.post(
  '/items/:id/hint',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const user = await getOrCreateTgUser(req.tgUser!);

    // 1. Feature gate: hints require PRO (godMode overrides to PRO)
    const ent = await getUserEntitlement(user.id, user.godMode);
    if (!ent.plan.features.includes('hints')) {
      trackEvent('feature_gate_hit_hints', user.id);
      return res.status(402).json({ error: 'Pro feature', feature: 'hints', planCode: ent.plan.code });
    }

    // 2. Load item + verify ownership
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, title: true, status: true, wishlist: { select: { ownerId: true, slug: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // 2b. Check owner's hintsEnabled setting
    const ownerProfile = await prisma.userProfile.findUnique({
      where: { userId: user.id },
      select: { hintsEnabled: true },
    });
    if (ownerProfile?.hintsEnabled === false) {
      return res.status(403).json({ error: 'hints_disabled' });
    }

    // 3. Item must be AVAILABLE (not reserved/completed/deleted)
    if (item.status !== 'AVAILABLE') {
      return res.status(400).json({ error: 'item_not_available', message: t('api_hint_item_not_available', getRequestLocale(req)) });
    }

    // 4. Anti-spam: max 3 hint waves per item per 30 days
    if (!user.godMode) {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const itemHintCount = await prisma.hint.count({
        where: { itemId: id, senderUserId: user.id, status: { in: ['SENT', 'DELIVERED'] }, createdAt: { gte: thirtyDaysAgo } },
      });
      if (itemHintCount >= 3) {
        const oldestItemHint = await prisma.hint.findFirst({
          where: { itemId: id, senderUserId: user.id, status: { in: ['SENT', 'DELIVERED'] }, createdAt: { gte: thirtyDaysAgo } },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        });
        const retryAfterSeconds = oldestItemHint
          ? Math.max(0, Math.ceil((oldestItemHint.createdAt.getTime() + 30 * 24 * 60 * 60 * 1000 - Date.now()) / 1000))
          : 0;
        return res.status(429).json({
          error: 'item_hint_limit',
          message: t('api_hint_item_limit', getRequestLocale(req)),
          retryAfterSeconds,
        });
      }

      // 5. Anti-spam: max 5 hints per sender per day
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const dailyHintCount = await prisma.hint.count({
        where: { senderUserId: user.id, status: { in: ['SENT', 'DELIVERED'] }, createdAt: { gte: oneDayAgo } },
      });
      if (dailyHintCount >= 5) {
        const oldestDailyHint = await prisma.hint.findFirst({
          where: { senderUserId: user.id, status: { in: ['SENT', 'DELIVERED'] }, createdAt: { gte: oneDayAgo } },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        });
        const retryAfterSeconds = oldestDailyHint
          ? Math.max(0, Math.ceil((oldestDailyHint.createdAt.getTime() + 24 * 60 * 60 * 1000 - Date.now()) / 1000))
          : 0;
        return res.status(429).json({
          error: 'daily_hint_limit',
          message: t('api_hint_daily_limit', getRequestLocale(req)),
          retryAfterSeconds,
        });
      }
    }

    // 6. Create hint record
    const hint = await prisma.hint.create({
      data: {
        itemId: id,
        senderUserId: user.id,
        status: 'SENT',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    // 7. Send contact picker to sender's bot chat via request_users keyboard
    const senderChatId = user.telegramChatId;
    if (senderChatId) {
      const locale = getRequestLocale(req);
      const sent = await sendTgBotMessage(
        senderChatId,
        t('api_hint_picker_msg', locale, { title: item.title }),
        {
          keyboard: [[{
            text: t('bot_select_recipients', locale),
            request_users: { request_id: Number(hint.id.slice(-6).replace(/\D/g, '') || '1'), user_is_bot: false, max_quantity: 10 },
          }]],
          resize_keyboard: true,
          one_time_keyboard: true,
          is_persistent: true,
        },
      );
      if (!sent) console.error('[hint] failed to send contact picker to chat', senderChatId);
    } else {
      console.error('[hint] no telegramChatId for user', user.id);
    }

    trackEvent('hint_created', user.id);

    return res.json({ hintId: hint.id, status: 'pending_selection' });
  }),
);

// GET /tg/hints/:hintId — poll hint delivery status (for mini app)
tgRouter.get(
  '/hints/:hintId',
  asyncHandler(async (req, res) => {
    const hintId = req.params.hintId ?? '';
    if (!hintId) return res.status(400).json({ error: 'Missing hint id' });

    const user = await getOrCreateTgUser(req.tgUser!);

    const hint = await prisma.hint.findFirst({
      where: { id: hintId, senderUserId: user.id },
      select: {
        id: true,
        status: true,
        sentCount: true,
        pendingCount: true,
        deliveredAt: true,
        item: { select: { id: true, title: true, status: true } },
      },
    });

    if (!hint) return res.status(404).json({ error: 'Hint not found' });

    return res.json({
      hintId: hint.id,
      status: hint.status,
      sentCount: hint.sentCount,
      pendingCount: hint.pendingCount,
      deliveredAt: hint.deliveredAt,
      itemTitle: hint.item.title,
    });
  }),
);

// POST /tg/items/:id/photo — upload or replace item photo (with sharp processing)
tgRouter.post(
  '/items/:id/photo',
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, imageUrl: true, wishlist: { select: { ownerId: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Process image with sharp: compress, strip EXIF, resize
    const [full, thumb] = await Promise.all([
      processImage(req.file.buffer, { maxDim: 1600, quality: 80, suffix: 'full' }),
      processImage(req.file.buffer, { maxDim: 480, quality: 70, suffix: 'thumb' }),
    ]);

    // Delete the previous local upload if it exists.
    deleteUploadFile(item.imageUrl);

    const photoUrl = `/api/uploads/${full.filename}`;
    await prisma.item.update({ where: { id }, data: { imageUrl: photoUrl } });

    return res.json({ photoUrl, thumbUrl: `/api/uploads/${thumb.filename}`, width: full.width, height: full.height, sizeBytes: full.sizeBytes });
  }),
);

// DELETE /tg/items/:id/photo — remove item photo
tgRouter.delete(
  '/items/:id/photo',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, imageUrl: true, wishlist: { select: { ownerId: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    deleteUploadFile(item.imageUrl);
    await prisma.item.update({ where: { id }, data: { imageUrl: null } });

    return res.json({ ok: true });
  }),
);

// ─── Import URL: helpers ─────────────────────────────────────────────────────

const DRAFTS_ITEM_LIMIT = 50;

async function getOrCreateDraftsWishlist(userId: string) {
  const existing = await prisma.wishlist.findFirst({
    where: { ownerId: userId, type: 'SYSTEM_DRAFTS' },
    select: { id: true },
  });
  if (existing) return existing;
  return prisma.wishlist.create({
    data: {
      slug: `drafts-${crypto.randomUUID().slice(0, 12)}`,
      ownerId: userId,
      title: 'Неразобранное',
      type: 'SYSTEM_DRAFTS',
    },
    select: { id: true },
  });
}

async function importUrlForUser(
  userId: string,
  rawUrl: string,
  note?: string,
  source?: string,
): Promise<{ item: ReturnType<typeof mapTgItem>; wishlistId: string; parseStatus: 'ok' | 'partial' | 'failed' }> {
  const draftsWl = await getOrCreateDraftsWishlist(userId);

  // Check drafts limit
  const draftsCount = await prisma.item.count({
    where: { wishlistId: draftsWl.id, status: { in: [...ACTIVE_STATUSES] } },
  });
  if (draftsCount >= DRAFTS_ITEM_LIMIT) {
    throw Object.assign(new Error('Drafts limit reached'), { statusCode: 402 });
  }

  let parsed: Awaited<ReturnType<typeof parseUrl>>;
  let parseStatus: 'ok' | 'partial' | 'failed' = 'ok';

  try {
    parsed = await parseUrl(rawUrl);
    if (!parsed.title && !parsed.priceText && !parsed.imageUrl) {
      parseStatus = 'failed';
    } else if (!parsed.title || !parsed.priceText) {
      parseStatus = 'partial';
    }
  } catch {
    parseStatus = 'failed';
    let hostname = 'link';
    try { hostname = new URL(rawUrl).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    parsed = {
      title: null,
      description: null,
      priceText: null,
      imageUrl: null,
      sourceDomain: hostname,
      canonicalUrl: rawUrl,
    };
  }

  const title = parsed.title || parsed.sourceDomain || 'Link';

  // Description: user note (if any) + parsed description
  let description: string | null = null;
  if (note && parsed.description) {
    description = `💬 ${note}\n\n${parsed.description}`.slice(0, 500);
  } else if (note) {
    description = note.slice(0, 500);
  } else if (parsed.description) {
    description = parsed.description.slice(0, 500);
  }

  const item = await prisma.item.create({
    data: {
      wishlistId: draftsWl.id,
      title: title.slice(0, 200),
      url: parsed.canonicalUrl || rawUrl,
      description,
      priceText: extractNumericPrice(parsed.priceText),
      imageUrl: parsed.imageUrl ?? null,
      sourceUrl: rawUrl,
      sourceDomain: parsed.sourceDomain,
      importMethod: source || 'bot',
    },
    select: {
      id: true, wishlistId: true, title: true, url: true, priceText: true,
      imageUrl: true, priority: true, status: true, description: true,
      sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
    },
  });

  return { item: mapTgItem(item), wishlistId: draftsWl.id, parseStatus };
}

// ─── Import URL: TG endpoint ────────────────────────────────────────────────

const importUrlLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.tgUser ? String(req.tgUser.id) : 'anon',
  handler: (_req: Request, res: Response) => {
    const locale = getRequestLocale(_req);
    res.status(429).json({ error: t('api_import_rate_limit', locale) });
  },
  validate: false,
});

tgRouter.post(
  '/import-url',
  importUrlLimiter,
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      url: z.string().min(1).max(2048),
      note: z.string().max(500).optional(),
      source: z.string().max(20).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    // Validate URL first
    try { validateUrl(parsed.data.url); } catch (err: any) {
      return res.status(400).json({ error: err.message || 'Invalid URL' });
    }

    const user = await getOrCreateTgUser(req.tgUser!);

    // Feature gate: import by URL requires PRO
    const ent = await getUserEntitlement(user.id);
    if (!ent.plan.features.includes('url_import')) {
      trackEvent('feature_gate_hit_url_import', user.id);
      return res.status(402).json({ error: 'Pro feature', feature: 'url_import', planCode: ent.plan.code });
    }

    try {
      const result = await importUrlForUser(user.id, parsed.data.url, parsed.data.note, parsed.data.source || 'miniapp');
      return res.status(201).json(result);
    } catch (err: any) {
      if (err.statusCode === 402) {
        return res.status(402).json({ error: t('api_import_too_many', getRequestLocale(req)), limit: DRAFTS_ITEM_LIMIT });
      }
      throw err;
    }
  }),
);

// ─── Move item between wishlists ─────────────────────────────────────────────

tgRouter.post(
  '/items/:id/move',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const parsed = z.object({
      targetWishlistId: z.string().min(1),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getUserEntitlement(user.id);

    // Check item ownership
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, wishlistId: true, wishlist: { select: { ownerId: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Check target wishlist ownership
    const targetWl = await prisma.wishlist.findUnique({
      where: { id: parsed.data.targetWishlistId },
      select: { id: true, ownerId: true, type: true },
    });
    if (!targetWl) return res.status(404).json({ error: 'Target wishlist not found' });
    if (targetWl.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Check plan limit on target wishlist (only for REGULAR wishlists)
    if (targetWl.type === 'REGULAR') {
      // Check if target wishlist is writable
      if (!(await isWishlistWritable(user.id, targetWl.id, ent.plan.wishlists))) {
        return res.status(402).json({ error: 'Wishlist is read-only on current plan', planCode: ent.plan.code });
      }
      const targetItemCount = await prisma.item.count({
        where: { wishlistId: targetWl.id, status: { in: [...ACTIVE_STATUSES] } },
      });
      if (targetItemCount >= ent.plan.items) {
        return res.status(402).json({ error: t('api_wishlist_items_limit', getRequestLocale(req)), limit: ent.plan.items, planCode: ent.plan.code });
      }
    }

    // Move item
    const updated = await prisma.item.update({
      where: { id },
      data: { wishlistId: parsed.data.targetWishlistId },
      select: {
        id: true, wishlistId: true, title: true, url: true, priceText: true,
        imageUrl: true, priority: true, status: true, description: true,
        sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
      },
    });

    return res.json({ item: mapTgItem(updated) });
  }),
);

// ─── Billing & Plan endpoints ────────────────────────────────────────────────

// GET /tg/me/plan — current user's plan, subscription, effective limits, and add-ons
tgRouter.get(
  '/me/plan',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    const wishlistCount = await prisma.wishlist.count({ where: { ownerId: user.id, type: 'REGULAR' } });

    // God mode whitelist: only these Telegram IDs can toggle
    const godModeAllowedIds = (process.env.GOD_MODE_TELEGRAM_IDS ?? '').split(',').filter(Boolean);
    const canGodMode = user.telegramId ? godModeAllowedIds.includes(user.telegramId) : false;

    // Summarize add-ons for frontend
    const extraWishlistSlots = ent.addOns.filter(a => a.addonType === 'wishlist_slot').reduce((s, a) => s + a.quantity, 0);
    const extraSubscriptionSlots = ent.addOns.filter(a => a.addonType === 'subscription_slot').reduce((s, a) => s + a.quantity, 0);

    return res.json({
      plan: {
        code: ent.plan.code,
        wishlists: ent.effectiveWishlistLimit,
        items: ent.plan.items,
        subscriptions: ent.effectiveSubscriptionLimit,
        participants: ent.plan.participants,
        features: [...ent.plan.features],
      },
      subscription: ent.subscription,
      usage: { wishlists: wishlistCount },
      proPriceStars: PRO_PRICE_XTR,
      godMode: user.godMode,
      canGodMode,
      // Effective entitlements layer
      addOns: {
        extraWishlistSlots,
        extraSubscriptionSlots,
        seasonalWishlists: [...ent.seasonalWishlists],
      },
      credits: {
        hintCredits: ent.hintCredits,
        importCredits: ent.importCredits,
      },
      skus: Object.values(ONE_TIME_SKUS).map(s => ({
        code: s.code,
        price: s.price,
        type: s.type,
        targetRequired: s.targetRequired,
      })),
    });
  }),
);

// GET /tg/me/profile — user profile with stats
tgRouter.get(
  '/me/profile',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const locale = getRequestLocale(req);
    const profile = await getOrCreateProfile(user.id, locale);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);

    // God mode whitelist
    const godModeAllowedIds = (process.env.GOD_MODE_TELEGRAM_IDS ?? '').split(',').filter(Boolean);
    const canGodMode = user.telegramId ? godModeAllowedIds.includes(user.telegramId) : false;

    // Stats
    const [wishlists, totalWishes, regularReservedByMe, santaReservedByMe, archived] = await Promise.all([
      prisma.wishlist.count({ where: { ownerId: user.id, type: 'REGULAR', archivedAt: null } }),
      // Same formula as /tg/wishlists → itemCount:
      // only active (non-archived) REGULAR wishlists, only ACTIVE_STATUSES items.
      // SYSTEM_DRAFTS and archived wishlists are excluded to keep both counters in sync.
      prisma.item.count({
        where: {
          wishlist: { ownerId: user.id, type: 'REGULAR', archivedAt: null },
          status: { in: [...ACTIVE_STATUSES] },
        },
      }),
      prisma.item.count({
        where: { reserverUserId: user.id, status: 'RESERVED' },
      }),
      prisma.santaItemReservation.count({
        where: {
          assignment: {
            giver: { userId: user.id },
            giftStatus: { notIn: ['RECEIVED', 'ORPHANED'] },
            round: { campaign: { status: { not: 'CANCELLED' } } },
          },
        },
      }),
      prisma.item.count({
        where: {
          wishlist: { ownerId: user.id },
          status: { in: ['COMPLETED', 'DELETED'] },
        },
      }),
    ]);

    return res.json({
      profile: {
        displayName: profile.displayName,
        username: profile.username,
        bio: profile.bio,
        avatarUrl: profile.avatarUrl,
        avatarThumbUrl: profile.avatarThumbUrl,
        avatarUpdatedAt: profile.avatarUpdatedAt?.toISOString() ?? null,
        avatarPublic: profile.avatarPublic,
        birthday: profile.birthday?.toISOString() ?? null,
        hideYear: profile.hideYear,
        defaultCurrency: profile.defaultCurrency,
        // Owner-only — never exposed in public/share API responses
        supportId: profile.supportId,
      },
      stats: {
        wishlists,
        wishlistsLimit: ent.effectiveWishlistLimit,
        totalWishes,
        wishesLimit: ent.plan.items,
        reservedByMe: regularReservedByMe + santaReservedByMe,
        archived,
      },
      plan: {
        code: ent.plan.code,
        wishlists: ent.effectiveWishlistLimit,
        items: ent.plan.items,
        subscriptions: ent.effectiveSubscriptionLimit,
        participants: ent.plan.participants,
        features: [...ent.plan.features],
      },
      subscription: ent.subscription,
      godMode: user.godMode,
      canGodMode,
    });
  }),
);

// PATCH /tg/me/profile — update user profile
tgRouter.patch(
  '/me/profile',
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      displayName: z.string().min(1).max(100).nullable().optional(),
      username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/).nullable().optional(),
      bio: z.string().max(300).nullable().optional(),
      birthday: z.string().nullable().optional(),
      hideYear: z.boolean().optional(),
      avatarPublic: z.boolean().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const locale = getRequestLocale(req);

    // Check username uniqueness (skip if clearing username)
    if (parsed.data.username !== undefined && parsed.data.username !== null) {
      const currentProfile = await getOrCreateProfile(user.id, locale);
      if (parsed.data.username !== currentProfile.username) {
        const existing = await prisma.userProfile.findUnique({ where: { username: parsed.data.username } });
        if (existing && existing.userId !== user.id) {
          return res.status(409).json({ error: t('profile_username_taken', locale) });
        }
      }
    }

    const updateData: Record<string, unknown> = {};
    if (parsed.data.displayName !== undefined) updateData.displayName = parsed.data.displayName;
    if (parsed.data.username !== undefined) updateData.username = parsed.data.username;
    if (parsed.data.bio !== undefined) updateData.bio = parsed.data.bio;
    if (parsed.data.birthday !== undefined) updateData.birthday = parsed.data.birthday ? new Date(parsed.data.birthday) : null;
    if (parsed.data.hideYear !== undefined) updateData.hideYear = parsed.data.hideYear;
    if (parsed.data.avatarPublic !== undefined) updateData.avatarPublic = parsed.data.avatarPublic;

    const profile = await prisma.userProfile.upsert({
      where: { userId: user.id },
      update: updateData,
      create: {
        userId: user.id,
        defaultCurrency: locale === 'ru' ? 'RUB' : 'USD',
        ...updateData,
      },
    });

    return res.json({
      profile: {
        displayName: profile.displayName,
        username: profile.username,
        bio: profile.bio,
        avatarUrl: profile.avatarUrl,
        avatarThumbUrl: profile.avatarThumbUrl,
        avatarUpdatedAt: profile.avatarUpdatedAt?.toISOString() ?? null,
        avatarPublic: profile.avatarPublic,
        birthday: profile.birthday?.toISOString() ?? null,
        hideYear: profile.hideYear,
        defaultCurrency: profile.defaultCurrency,
      },
    });
  }),
);

// POST /tg/me/profile/avatar — upload profile avatar (generates full 512px + thumb 256px)
tgRouter.post(
  '/me/profile/avatar',
  upload.single('avatar'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const locale = getRequestLocale(req);
    const profile = await getOrCreateProfile(user.id, locale);

    // Process image — generate full (512px) and thumbnail (256px) simultaneously
    const [full, thumb] = await Promise.all([
      processImage(req.file.buffer, { maxDim: 512, quality: 80, suffix: 'avatar' }),
      processImage(req.file.buffer, { maxDim: 256, quality: 75, suffix: 'avatar-thumb' }),
    ]);

    // Delete old avatar files if they exist
    deleteUploadFile(profile.avatarUrl);
    deleteUploadFile(profile.avatarThumbUrl);

    const avatarUrl = `/api/uploads/${full.filename}`;
    const avatarThumbUrl = `/api/uploads/${thumb.filename}`;
    const avatarUpdatedAt = new Date();

    await prisma.userProfile.update({
      where: { userId: user.id },
      data: { avatarUrl, avatarThumbUrl, avatarUpdatedAt },
    });

    return res.json({ avatarUrl, avatarThumbUrl, avatarUpdatedAt: avatarUpdatedAt.toISOString() });
  }),
);

// DELETE /tg/me/profile/avatar — remove profile avatar
tgRouter.delete(
  '/me/profile/avatar',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const locale = getRequestLocale(req);
    const profile = await getOrCreateProfile(user.id, locale);

    deleteUploadFile(profile.avatarUrl);
    deleteUploadFile(profile.avatarThumbUrl);
    await prisma.userProfile.update({
      where: { userId: user.id },
      data: { avatarUrl: null, avatarThumbUrl: null, avatarUpdatedAt: null },
    });

    return res.json({ success: true });
  }),
);

// GET /tg/me/settings — user settings
tgRouter.get(
  '/me/settings',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const locale = getRequestLocale(req);
    const profile = await getOrCreateProfile(user.id, locale);
    const { isPro } = await getUserEntitlement(user.id, user.godMode);

    // FREE users: all notifications are always ON (they cannot opt out — only PRO users can
    // manage notification preferences). Normalise here so the UI always shows the correct
    // effective state regardless of what's stored in the DB.
    const notifications = isPro
      ? {
          comments: profile.notifyComments,
          reservations: profile.notifyReservations,
          subscriptions: profile.notifySubscriptions,
          marketing: profile.notifyMarketing,
        }
      : { comments: true, reservations: true, subscriptions: true, marketing: true };

    return res.json({
      language: locale,
      defaultCurrency: profile.defaultCurrency,
      notifications,
      privacy: {
        profileVisibility: profile.profileVisibility,
        subscribePolicy: profile.subscribePolicy,
        commentsEnabled: profile.commentsEnabled,
        hintsEnabled: profile.hintsEnabled,
      },
      appBehavior: {
        // "top" is PRO-only — normalize to "bottom" for FREE users (handles PRO→FREE downgrade)
        newWishlistPosition: isPro ? profile.newWishlistPosition : 'bottom',
      },
      isPro,
      // Owner-only — never exposed in public/share API responses
      supportId: profile.supportId,
    });
  }),
);

// PATCH /tg/me/settings — update user settings
tgRouter.patch(
  '/me/settings',
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      defaultCurrency: z.enum(['RUB', 'USD']).optional(),
      notifications: z.object({
        comments: z.boolean().optional(),
        reservations: z.boolean().optional(),
        subscriptions: z.boolean().optional(),
        marketing: z.boolean().optional(),
      }).optional(),
      privacy: z.object({
        profileVisibility: z.enum(['ALL', 'LINK_ONLY', 'SUBSCRIBERS', 'NOBODY']).optional(),
        subscribePolicy: z.enum(['ALL', 'LINK_ONLY', 'APPROVED', 'NOBODY']).optional(),
        commentsEnabled: z.boolean().optional(),
        hintsEnabled: z.boolean().optional(),
      }).optional(),
      appBehavior: z.object({
        newWishlistPosition: z.enum(['top', 'bottom']).optional(),
      }).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const locale = getRequestLocale(req);
    const { isPro } = await getUserEntitlement(user.id, user.godMode);
    const data = parsed.data;

    // Build update object
    const updateData: Record<string, unknown> = {};

    if (data.defaultCurrency !== undefined) updateData.defaultCurrency = data.defaultCurrency;

    if (data.notifications) {
      // All notification preferences are PRO-only — FREE users have all notifications ON
      // and cannot opt out. Silently ignore any notification changes from FREE users.
      if (isPro) {
        if (data.notifications.comments !== undefined) updateData.notifyComments = data.notifications.comments;
        if (data.notifications.reservations !== undefined) updateData.notifyReservations = data.notifications.reservations;
        if (data.notifications.subscriptions !== undefined) updateData.notifySubscriptions = data.notifications.subscriptions;
        if (data.notifications.marketing !== undefined) updateData.notifyMarketing = data.notifications.marketing;
      }
    }

    if (data.privacy) {
      if (data.privacy.profileVisibility !== undefined) updateData.profileVisibility = data.privacy.profileVisibility;
      if (data.privacy.subscribePolicy !== undefined) updateData.subscribePolicy = data.privacy.subscribePolicy;
      if (data.privacy.hintsEnabled !== undefined) updateData.hintsEnabled = data.privacy.hintsEnabled;
      // Pro-gated privacy settings
      if (isPro) {
        if (data.privacy.commentsEnabled !== undefined) updateData.commentsEnabled = data.privacy.commentsEnabled;
      }
    }

    if (data.appBehavior) {
      // Pro-gated: newWishlistPosition "top" requires Pro (free users can only use "bottom")
      if (data.appBehavior.newWishlistPosition !== undefined) {
        if (isPro || data.appBehavior.newWishlistPosition === 'bottom') {
          updateData.newWishlistPosition = data.appBehavior.newWishlistPosition;
        }
      }
    }

    const profile = await prisma.userProfile.upsert({
      where: { userId: user.id },
      update: updateData,
      create: {
        userId: user.id,
        defaultCurrency: (data.defaultCurrency as 'RUB' | 'USD' | undefined) ?? (locale === 'ru' ? 'RUB' : 'USD'),
        ...updateData,
      },
    });

    // Normalise notifications for FREE users — same logic as GET
    const updatedNotifications = isPro
      ? {
          comments: profile.notifyComments,
          reservations: profile.notifyReservations,
          subscriptions: profile.notifySubscriptions,
          marketing: profile.notifyMarketing,
        }
      : { comments: true, reservations: true, subscriptions: true, marketing: true };

    return res.json({
      language: locale,
      defaultCurrency: profile.defaultCurrency,
      notifications: updatedNotifications,
      privacy: {
        profileVisibility: profile.profileVisibility,
        subscribePolicy: profile.subscribePolicy,
        commentsEnabled: profile.commentsEnabled,
        hintsEnabled: profile.hintsEnabled,
      },
      appBehavior: {
        // "top" is PRO-only — normalize to "bottom" for FREE users
        newWishlistPosition: isPro ? profile.newWishlistPosition : 'bottom',
      },
      isPro,
      // Owner-only — never exposed in public/share API responses
      supportId: profile.supportId,
    });
  }),
);

// DELETE /tg/me/account — delete user and all related data
tgRouter.delete(
  '/me/account',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);

    // Block if user owns active Santa campaigns (must cancel first)
    const activeSantaCampaigns = await prisma.santaCampaign.findMany({
      where: { ownerId: user.id, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      select: { id: true, title: true, status: true },
    });
    if (activeSantaCampaigns.length > 0) {
      return res.status(409).json({
        error: 'active_santa_campaigns',
        message: 'Cancel or complete your Secret Santa campaigns before deleting your account.',
        campaigns: activeSantaCampaigns,
      });
    }

    await prisma.user.delete({ where: { id: user.id } });
    return res.json({ success: true });
  }),
);

// POST /tg/me/god-mode — toggle god mode (dev only, whitelisted users)
tgRouter.post(
  '/me/god-mode',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);

    const godModeAllowedIds = (process.env.GOD_MODE_TELEGRAM_IDS ?? '').split(',').filter(Boolean);
    if (!user.telegramId || !godModeAllowedIds.includes(user.telegramId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { godMode: !user.godMode },
      select: { godMode: true },
    });

    return res.json({ godMode: updated.godMode });
  }),
);

// GET /tg/me/god-stats — internal analytics dashboard (god mode users only)
// Double-gated: user must be in GOD_MODE_TELEGRAM_IDS whitelist AND have godMode=true.
// Active user definition (7d / 30d):
//   A user is "active" if within the period they created or updated a REGULAR wishlist
//   OR created or updated any non-deleted item — proxies real product usage from existing
//   entity timestamps without requiring a dedicated event log.
// Share proxy: users with ≥1 wishlist where shareToken was explicitly generated.
// Reservation funnel step: users who *received* ≥1 reservation on their wishlist items
//   (semantic: "your wishlist had real engagement from another person").
tgRouter.get(
  '/me/god-stats',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);

    const godModeAllowedIds = (process.env.GOD_MODE_TELEGRAM_IDS ?? '').split(',').filter(Boolean);
    const canGodMode = user.telegramId ? godModeAllowedIds.includes(user.telegramId) : false;
    if (!canGodMode || !user.godMode) return res.status(403).json({ error: 'Forbidden' });

    const now = new Date();
    const cut24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const cut7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const cut30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    type CountRow = { count: bigint };
    const n = (r: CountRow | undefined) => Number(r?.count ?? 0);

    const [
      totalUsers,
      newUsers24h,
      newUsers7d,
      active7dRows,
      active30dRows,
      totalWishlists,
      totalItems,
      totalReservations,
      proUsers,
      withWishlistRows,
      withItemRows,
      withShareRows,
      sharedLinkOpensRows,
      wishlistsWithLinkOpenRows,
      withReservationRows,
      totalComments,
      totalHints,
      totalWishlistSubs,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: cut24 } } }),
      prisma.user.count({ where: { createdAt: { gte: cut7 } } }),
      // Active users 7d: created/updated REGULAR wishlist OR created/updated non-deleted item
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(DISTINCT owner_id)::int AS count FROM (
          SELECT "ownerId" AS owner_id FROM "Wishlist"
            WHERE "updatedAt" >= ${cut7} AND type = 'REGULAR'
          UNION
          SELECT w."ownerId" AS owner_id FROM "Item" i
            JOIN "Wishlist" w ON i."wishlistId" = w.id
            WHERE i."updatedAt" >= ${cut7} AND i.status != 'DELETED'
        ) _a`,
      // Active users 30d: same definition
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(DISTINCT owner_id)::int AS count FROM (
          SELECT "ownerId" AS owner_id FROM "Wishlist"
            WHERE "updatedAt" >= ${cut30} AND type = 'REGULAR'
          UNION
          SELECT w."ownerId" AS owner_id FROM "Item" i
            JOIN "Wishlist" w ON i."wishlistId" = w.id
            WHERE i."updatedAt" >= ${cut30} AND i.status != 'DELETED'
        ) _a`,
      prisma.wishlist.count({ where: { type: 'REGULAR' } }),
      prisma.item.count({ where: { status: { not: 'DELETED' } } }),
      prisma.reservationEvent.count({ where: { type: 'RESERVED' } }),
      prisma.subscription.count({ where: { status: 'ACTIVE' } }),
      // Funnel — users with ≥1 REGULAR wishlist (= "activated" proxy)
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(DISTINCT "ownerId")::int AS count FROM "Wishlist"
        WHERE type = 'REGULAR'`,
      // Users with ≥1 non-deleted item
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(DISTINCT w."ownerId")::int AS count
        FROM "Item" i JOIN "Wishlist" w ON i."wishlistId" = w.id
        WHERE i.status != 'DELETED'`,
      // Funnel share step 1: users who opened share screen (shareToken generated via POST /share-token)
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(DISTINCT "ownerId")::int AS count FROM "Wishlist"
        WHERE "shareToken" IS NOT NULL AND type = 'REGULAR'`,
      // Funnel share step 2: total link opens across all wishlists (SUM of shareOpenCount)
      prisma.$queryRaw<CountRow[]>`
        SELECT COALESCE(SUM("shareOpenCount"), 0)::int AS count FROM "Wishlist"
        WHERE "shareToken" IS NOT NULL AND type = 'REGULAR'`,
      // Funnel share step 3: distinct wishlists that received ≥1 link open
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::int AS count FROM "Wishlist"
        WHERE "shareOpenCount" > 0 AND type = 'REGULAR'`,
      // Received ≥1 reservation on their wishlist items
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(DISTINCT w."ownerId")::int AS count
        FROM "ReservationEvent" re
        JOIN "Item" i ON re."itemId" = i.id
        JOIN "Wishlist" w ON i."wishlistId" = w.id
        WHERE re.type = 'RESERVED'`,
      // Engagement: total user-authored comments
      prisma.comment.count({ where: { type: 'USER' } }),
      // Engagement: total Santa hint requests
      prisma.santaHintRequest.count(),
      // Engagement: total wishlist subscriptions (social follows)
      prisma.wishlistSubscription.count(),
    ]);

    const withWishlist = n(withWishlistRows[0]);

    return res.json({
      overview: {
        totalUsers,
        newUsers24h,
        newUsers7d,
        activeUsers7d: n(active7dRows[0]),
        activeUsers30d: n(active30dRows[0]),
        totalWishlists,
        totalItems,
        totalReservations,
        proUsers,
      },
      funnel: {
        totalUsers,
        activatedUsers: withWishlist,   // proxy: users with ≥1 regular wishlist
        usersWithWishlist: withWishlist,
        usersWithItem: n(withItemRows[0]),
        // Share funnel — three distinct steps:
        // 1. Intent: user opened share screen → shareToken generated
        usersWhoInitiatedShare: n(withShareRows[0]),
        // 2. Actual link opens: total times guests opened a shared link (sum of shareOpenCount)
        sharedLinkOpens: n(sharedLinkOpensRows[0]),
        // 3. Wishlists with ≥1 link open (distinct reach)
        wishlistsWithLinkOpen: n(wishlistsWithLinkOpenRows[0]),
        usersWithReservation: n(withReservationRows[0]),
      },
      engagement: {
        totalComments,
        totalHints,
        totalWishlistSubs,
      },
      meta: {
        activeUserDef: 'users who created/updated a regular wishlist or item in the period',
        usersWhoInitiatedShareDef: 'users who opened share screen (shareToken generated via POST /share-token)',
        sharedLinkOpensDef: 'total times a guest opened a shared link (GET /public/share/:token, fire-and-forget increment)',
        wishlistsWithLinkOpenDef: 'distinct wishlists with shareOpenCount > 0',
        reservationDef: 'users whose wishlist items received ≥1 RESERVED event',
      },
      generatedAt: now.toISOString(),
    });
  }),
);

// POST /tg/billing/pro/checkout — create Stars invoice link
tgRouter.post(
  '/billing/pro/checkout',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getUserEntitlement(user.id);

    // If already active PRO — return current state, don't create new checkout
    if (ent.isPro && ent.subscription?.status === 'ACTIVE' && !ent.subscription.cancelAtPeriodEnd) {
      trackEvent('checkout_already_subscribed', user.id);
      return res.json({ subscription: ent.subscription, alreadySubscribed: true });
    }

    const botToken = process.env.BOT_TOKEN;
    if (!botToken) return res.status(500).json({ error: 'Bot not configured' });

    const checkoutSessionId = crypto.randomUUID();
    const payload = `pro_monthly:${req.tgUser!.id}:${checkoutSessionId}`;

    trackEvent('checkout_started', user.id);

    const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Wishlist Pro',
        description: t('api_invoice_desc', getRequestLocale(req)),
        payload,
        currency: 'XTR',
        prices: [{ label: t('api_invoice_label', getRequestLocale(req)), amount: PRO_PRICE_XTR }],
        subscription_period: PRO_SUBSCRIPTION_PERIOD,
      }),
    });

    const data = (await tgRes.json()) as { ok: boolean; result?: string; description?: string };
    if (!data.ok || !data.result) {
      // eslint-disable-next-line no-console
      console.error('[billing] createInvoiceLink failed:', data);
      trackEvent('checkout_failed', user.id, { reason: data.description });
      return res.status(502).json({ error: 'Failed to create invoice' });
    }

    // Save invoice_created event
    await prisma.paymentEvent.create({
      data: {
        userId: user.id,
        telegramPaymentChargeId: `checkout_${checkoutSessionId}`,
        invoicePayload: payload,
        totalAmount: PRO_PRICE_XTR,
        currency: 'XTR',
        eventType: 'invoice_created',
      },
    });

    return res.json({ invoiceUrl: data.result, checkoutSessionId });
  }),
);

// POST /tg/billing/pro/sync — verify subscription state after payment (does NOT activate — bot does)
tgRouter.post(
  '/billing/pro/sync',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    trackEvent('sync_requested', user.id);
    const ent = await getEffectiveEntitlements(user.id);

    return res.json({
      plan: {
        code: ent.plan.code,
        wishlists: ent.effectiveWishlistLimit,
        items: ent.plan.items,
        subscriptions: ent.effectiveSubscriptionLimit,
        participants: ent.plan.participants,
        features: [...ent.plan.features],
      },
      subscription: ent.subscription,
    });
  }),
);

// GET /tg/billing/history — payment history
tgRouter.get(
  '/billing/history',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const events = await prisma.paymentEvent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, totalAmount: true, currency: true, eventType: true, createdAt: true },
    });
    return res.json({ events });
  }),
);

// POST /tg/billing/subscription/cancel — cancel auto-renewal (keeps PRO until period end)
tgRouter.post(
  '/billing/subscription/cancel',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    trackEvent('subscription_cancel_requested', user.id);

    const sub = await prisma.subscription.findFirst({
      where: {
        userId: user.id,
        planCode: PRO_PLAN_CODE,
        status: 'ACTIVE',
        currentPeriodEnd: { gt: new Date() },
      },
    });
    if (!sub) {
      return res.status(404).json({ error: 'No active subscription' });
    }

    const updated = await prisma.subscription.update({
      where: { id: sub.id },
      data: { cancelAtPeriodEnd: true, cancelledAt: new Date() },
    });

    return res.json({
      subscription: {
        id: updated.id,
        status: updated.status,
        periodEnd: updated.currentPeriodEnd.toISOString(),
        cancelAtPeriodEnd: updated.cancelAtPeriodEnd,
        cancelledAt: updated.cancelledAt?.toISOString() ?? null,
      },
    });
  }),
);

// POST /tg/billing/subscription/reactivate — re-enable auto-renewal if period not expired
tgRouter.post(
  '/billing/subscription/reactivate',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    trackEvent('subscription_reactivated', user.id);

    const sub = await prisma.subscription.findFirst({
      where: {
        userId: user.id,
        planCode: PRO_PLAN_CODE,
        status: 'ACTIVE',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: { gt: new Date() },
      },
    });
    if (!sub) {
      return res.status(404).json({ error: 'No cancelled subscription to reactivate' });
    }

    const updated = await prisma.subscription.update({
      where: { id: sub.id },
      data: { cancelAtPeriodEnd: false, cancelledAt: null },
    });

    return res.json({
      subscription: {
        id: updated.id,
        status: updated.status,
        periodEnd: updated.currentPeriodEnd.toISOString(),
        cancelAtPeriodEnd: updated.cancelAtPeriodEnd,
        cancelledAt: null,
      },
    });
  }),
);

// POST /tg/billing/addon/checkout — create Stars invoice for a one-time SKU
tgRouter.post(
  '/billing/addon/checkout',
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      skuCode: z.string().min(1),
      targetId: z.string().optional(), // wishlistId for wishlist-scoped SKUs
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const { skuCode, targetId } = parsed.data;
    const sku = ONE_TIME_SKUS[skuCode as SkuCode];
    if (!sku) return res.status(400).json({ error: 'Unknown SKU', code: skuCode });

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);

    // Validate target for wishlist-scoped SKUs
    if (sku.targetRequired) {
      if (!targetId) return res.status(400).json({ error: 'targetId required for this SKU' });
      const wl = await prisma.wishlist.findUnique({ where: { id: targetId }, select: { ownerId: true } });
      if (!wl) return res.status(404).json({ error: 'Wishlist not found' });
      if (wl.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });
    }

    // Cap checks per SKU
    if (skuCode === 'extra_wishlist_slot') {
      const existing = ent.addOns.filter(a => a.addonType === 'wishlist_slot').reduce((s, a) => s + a.quantity, 0);
      const cap = ent.isPro ? ADDON_CAPS.extraWishlistSlots.PRO : ADDON_CAPS.extraWishlistSlots.FREE;
      if (existing >= cap) return res.status(409).json({ error: 'cap_reached', cap, current: existing });
    }
    if (skuCode === 'extra_subscription_slot') {
      const existing = ent.addOns.filter(a => a.addonType === 'subscription_slot').reduce((s, a) => s + a.quantity, 0);
      if (existing >= ADDON_CAPS.extraSubscriptionSlots) return res.status(409).json({ error: 'cap_reached', cap: ADDON_CAPS.extraSubscriptionSlots, current: existing });
    }
    if (skuCode === 'extra_items_5' && targetId) {
      const existing = ent.addOns.filter(a => a.addonType === 'item_slot_5' && a.targetId === targetId).length;
      // wishlist_cap_reached ≠ cap_reached: this is a per-wishlist limit, not a global SKU cap
      if (existing >= ADDON_CAPS.extraItems5PerWishlist) return res.status(409).json({ error: 'wishlist_cap_reached', cap: ADDON_CAPS.extraItems5PerWishlist, current: existing });
    }
    if (skuCode === 'extra_items_15' && targetId) {
      const existing = ent.addOns.filter(a => a.addonType === 'item_slot_15' && a.targetId === targetId).length;
      if (existing >= ADDON_CAPS.extraItems15PerWishlist) return res.status(409).json({ error: 'wishlist_cap_reached', cap: ADDON_CAPS.extraItems15PerWishlist, current: existing });
    }

    const botToken = process.env.BOT_TOKEN;
    if (!botToken) return res.status(500).json({ error: 'Bot not configured' });

    const sessionId = crypto.randomUUID();
    // Payload format: addon:<skuCode>:<telegramId>:<targetId|_>:<sessionId>
    const payload = `addon:${skuCode}:${req.tgUser!.id}:${targetId ?? '_'}:${sessionId}`;
    const locale = getRequestLocale(req);

    const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: t(`addon_title_${skuCode}` as any, locale, {}),
        description: t(`addon_desc_${skuCode}` as any, locale, {}),
        payload,
        currency: 'XTR',
        prices: [{ label: t('api_invoice_label', locale), amount: sku.price }],
      }),
    });

    const data = (await tgRes.json()) as { ok: boolean; result?: string; description?: string };
    if (!data.ok || !data.result) {
      console.error('[billing] addon createInvoiceLink failed:', data);
      trackEvent('addon_checkout_failed', user.id, { skuCode, reason: data.description });
      return res.status(502).json({ error: 'Failed to create invoice' });
    }

    // Log invoice_created event
    await prisma.paymentEvent.create({
      data: {
        userId: user.id,
        telegramPaymentChargeId: `addon_checkout_${sessionId}`,
        invoicePayload: payload,
        totalAmount: sku.price,
        currency: 'XTR',
        eventType: 'addon_invoice_created',
      },
    });

    trackEvent('addon_checkout_started', user.id, { skuCode, targetId });
    return res.json({ invoiceUrl: data.result, sessionId });
  }),
);

// POST /tg/billing/addon/sync — return current add-ons and credits after purchase
tgRouter.post(
  '/billing/addon/sync',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);

    const extraWishlistSlots = ent.addOns.filter(a => a.addonType === 'wishlist_slot').reduce((s, a) => s + a.quantity, 0);
    const extraSubscriptionSlots = ent.addOns.filter(a => a.addonType === 'subscription_slot').reduce((s, a) => s + a.quantity, 0);

    return res.json({
      plan: {
        code: ent.plan.code,
        wishlists: ent.effectiveWishlistLimit,
        items: ent.plan.items,
        subscriptions: ent.effectiveSubscriptionLimit,
        participants: ent.plan.participants,
        features: [...ent.plan.features],
      },
      addOns: {
        extraWishlistSlots,
        extraSubscriptionSlots,
        seasonalWishlists: [...ent.seasonalWishlists],
        extraItemsPerWishlist: ent.extraItemsPerWishlist,
      },
      credits: {
        hintCredits: ent.hintCredits,
        importCredits: ent.importCredits,
      },
    });
  }),
);

// ─── Internal router (bot → API communication) ──────────────────────────────

const internalRouter = express.Router();

const internalImportLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests' },
  validate: false,
});

function requireInternalAuth(req: Request, res: Response, next: NextFunction) {
  const botToken = process.env.BOT_TOKEN;
  if (!botToken) return res.status(500).json({ error: 'Not configured' });
  const provided = req.get('X-INTERNAL-KEY');
  if (!provided || !secureCompare(provided, botToken)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

internalRouter.use(requireInternalAuth);

internalRouter.post(
  '/import-url',
  internalImportLimiter,
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      userId: z.string().min(1),
      url: z.string().min(1).max(2048),
      note: z.string().max(500).optional(),
      source: z.string().max(20).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    // Validate URL
    try { validateUrl(parsed.data.url); } catch (err: any) {
      return res.status(400).json({ error: err.message || 'Invalid URL' });
    }

    // Feature gate: url_import requires PRO
    const ent = await getUserEntitlement(parsed.data.userId);
    if (!ent.plan.features.includes('url_import')) {
      return res.status(402).json({ error: 'Pro feature', feature: 'url_import' });
    }

    try {
      const result = await importUrlForUser(parsed.data.userId, parsed.data.url, parsed.data.note, parsed.data.source || 'bot');
      return res.status(201).json(result);
    } catch (err: any) {
      if (err.statusCode === 402) {
        return res.status(402).json({ error: 'Drafts limit reached', limit: DRAFTS_ITEM_LIMIT });
      }
      throw err;
    }
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Secret Santa endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the canonical "season start year" — the November year that anchors the current
 * or upcoming Santa season. This is the single source of truth for:
 *   - SantaSeasonConfig.seasonYear  (DB override lookup key)
 *   - SantaSeasonalBroadcastLog.year (broadcast dedup key)
 *   - getSeasonCalendar()            (season window computation)
 *
 * The Santa season crosses the calendar year boundary: Nov 15 (year Y) → Feb 15 (year Y+1).
 * Any date in Jan 1 – Feb 15 belongs to the season that STARTED last November (year Y-1).
 * All other dates belong to the season starting this November (year Y, current or upcoming).
 *
 * Examples:
 *   2026-10-31 → 2026  (off-season; next season opens Nov 15, 2026)
 *   2026-11-01 → 2026  (promo day; season key = 2026)
 *   2026-11-15 → 2026  (season opens)
 *   2026-12-25 → 2026  (mid-season)
 *   2027-01-10 → 2026  ← Jan is still the 2026 season, NOT 2027
 *   2027-02-10 → 2026  ← Feb 10 is still the 2026 season, closing Feb 15
 *   2027-02-15 → 2026  ← last day of the 2026 season
 *   2027-02-16 → 2027  (off-season; next season key = 2027)
 *   2027-11-14 → 2027  (off-season, one day before next season)
 *   2027-11-15 → 2027  (new 2027 season opens)
 *   2027-11-20 → 2027  (2027 season, NOT 2026)
 */
/**
 * Returns the canonical "season start year" — the November year that anchors the current
 * or upcoming Santa season. This is the single source of truth for:
 *   - SantaSeasonConfig.seasonYear  (DB override lookup key)
 *   - SantaSeasonalBroadcastLog.year (broadcast dedup key)
 *   - getSeasonCalendar()            (season window computation)
 *
 * The Santa season crosses the calendar year boundary: Nov 15 (year Y) → Feb 15 (year Y+1).
 * Any date in Jan 1 – Feb 15 belongs to the season that STARTED last November (year Y-1).
 * All other dates belong to the season starting this November (year Y, current or upcoming).
 *
 * All comparisons use UTC to be timezone-independent (server TZ never affects the result).
 *
 * Examples:
 *   2026-10-31 UTC → 2026  (off-season; next season opens Nov 15, 2026)
 *   2026-11-01 UTC → 2026  (promo day; season key = 2026)
 *   2026-11-15 UTC → 2026  (season opens)
 *   2026-12-25 UTC → 2026  (mid-season)
 *   2027-01-10 UTC → 2026  ← Jan is still the 2026 season, NOT 2027
 *   2027-02-10 UTC → 2026  ← Feb 10 is still the 2026 season, closing Feb 15
 *   2027-02-15 UTC → 2026  ← last day of the 2026 season
 *   2027-02-16 UTC → 2027  (off-season; next season key = 2027)
 *   2027-11-15 UTC → 2027  (new 2027 season opens)
 *   2027-11-20 UTC → 2027  (2027 season, NOT 2026)
 */
function getSeasonStartYear(now: Date): number {
  const m = now.getUTCMonth() + 1; // 1–12, UTC
  const d = now.getUTCDate();       // UTC day
  const y = now.getUTCFullYear();   // UTC year
  // Jan 1 – Feb 15 UTC: tail of the season that started Nov of year Y-1
  return (m === 1 || (m === 2 && d <= 15)) ? y - 1 : y;
}

/**
 * Pure calendar helper — season window is Nov 15 00:00 UTC (seasonStartYear) →
 * Feb 15 23:59:59.999 UTC (seasonStartYear+1).
 * Uses UTC timestamps throughout to be timezone-independent.
 * Requires zero DB access. Works correctly for any calendar year, forever.
 */
function getSeasonCalendar(now: Date): { inSeason: boolean; seasonStart: Date; seasonEnd: Date } {
  const startYear   = getSeasonStartYear(now);
  const seasonStart = new Date(Date.UTC(startYear,     10, 15));               // Nov 15 00:00:00.000 UTC
  const seasonEnd   = new Date(Date.UTC(startYear + 1,  1, 15, 23, 59, 59, 999)); // Feb 15 23:59:59.999 UTC
  return { inSeason: now >= seasonStart && now <= seasonEnd, seasonStart, seasonEnd };
}

/**
 * Compute season status and create-permission for the requesting user.
 *
 * Resolution priority (first match wins):
 *   1. SantaGlobalConfig.santaEnabled = false  → always off (unless santaTestMode)
 *   2. santaTestMode = true                    → always on (godMode bypass)
 *   3. SantaSeasonConfig row for current year  → explicit admin override (per-year dates)
 *   4. getSeasonCalendar()                     → automatic, recurring, zero annual setup
 *
 * Never mutates DB.
 */
async function getSantaSeasonInfo(userId: string, santaTestMode: boolean) {
  const now        = new Date();
  // seasonYear is the November-start year of the current season (e.g. 2026 for Jan/Feb 2027).
  // This is the canonical DB key — must match SantaSeasonConfig.seasonYear.
  // Using getSeasonStartYear() (not now.getFullYear()) is what makes Jan/Feb 2027 correctly
  // resolve to the 2026 season row instead of a non-existent 2027 row.
  const seasonYear = getSeasonStartYear(now);

  // 1. Global kill switch — allows retiring Santa entirely without touching per-year rows.
  //    Bypassed by santaTestMode so godMode users can always test even after retirement.
  if (!santaTestMode) {
    const globalConfig = await prisma.santaGlobalConfig.findUnique({ where: { id: 'global' } });
    if (globalConfig && !globalConfig.santaEnabled) {
      return { inSeason: false, canCreate: false, seasonStart: null, seasonEnd: null, config: null };
    }
  }

  // 2. santaTestMode: bypass season window and missing-config guard entirely.
  //    Must be checked before DB row query so god-mode users always land in-season.
  if (santaTestMode) {
    const config = await prisma.santaSeasonConfig.findUnique({ where: { seasonYear } });
    const cal    = getSeasonCalendar(now);
    return {
      inSeason:    true,
      canCreate:   true,
      seasonStart: (config?.seasonStartAt ?? cal.seasonStart).toISOString(),
      seasonEnd:   (config?.seasonEndAt   ?? cal.seasonEnd).toISOString(),
      config:      config ?? null,
    };
  }

  // 3. Explicit per-year admin override row takes priority over calendar.
  //    seasonYear = getSeasonStartYear(now) ensures Jan/Feb 2027 finds the 2026 row, not 2027.
  const config = await prisma.santaSeasonConfig.findUnique({ where: { seasonYear } });
  if (config) {
    const inSeason  = now >= config.seasonStartAt && now <= config.seasonEndAt;
    const canCreate = inSeason && config.campaignCreateEnabled;
    return {
      inSeason,
      canCreate,
      seasonStart: config.seasonStartAt.toISOString(),
      seasonEnd:   config.seasonEndAt.toISOString(),
      config,
    };
  }

  // 4. No DB override — apply recurring calendar rules (Nov 15 → Feb 15).
  //    Works automatically for every year: 2026, 2027, 2028, … with zero annual setup.
  const { inSeason, seasonStart, seasonEnd } = getSeasonCalendar(now);
  return {
    inSeason,
    canCreate:   inSeason, // calendar default: all in-season users may create
    seasonStart: seasonStart.toISOString(),
    seasonEnd:   seasonEnd.toISOString(),
    config:      null,
  };
}

// GET /tg/santa/season — season status and canCreate flag
tgRouter.get('/santa/season', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const info = await getSantaSeasonInfo(user.id, user.santaTestMode);
  return res.json({
    inSeason: info.inSeason,
    canCreate: info.canCreate,
    seasonStart: info.seasonStart,
    seasonEnd: info.seasonEnd,
    testMode: user.santaTestMode,
  });
}));

// POST /tg/santa/season/test-mode — toggle santa test mode (godMode users only)
tgRouter.post('/santa/season/test-mode', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  if (!user.godMode) return res.status(403).json({ error: 'Forbidden' });
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { santaTestMode: !user.santaTestMode },
    select: { santaTestMode: true },
  });
  return res.json({ santaTestMode: updated.santaTestMode });
}));

// GET /tg/santa/admin/global-config — read global master switch (godMode only)
tgRouter.get('/santa/admin/global-config', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  if (!user.godMode) return res.status(403).json({ error: 'Forbidden' });
  const config = await prisma.santaGlobalConfig.findUnique({ where: { id: 'global' } });
  return res.json({ santaEnabled: config?.santaEnabled ?? true });
}));

// PATCH /tg/santa/admin/global-config — toggle global master switch (godMode only)
// Set santaEnabled=false to retire Secret Santa entirely (affects all users except godMode/santaTestMode).
// Set santaEnabled=true to re-enable; yearly calendar rules take over automatically.
tgRouter.patch('/santa/admin/global-config', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  if (!user.godMode) return res.status(403).json({ error: 'Forbidden' });
  const parsed = z.object({ santaEnabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);
  const updated = await prisma.santaGlobalConfig.upsert({
    where:  { id: 'global' },
    create: { id: 'global', santaEnabled: parsed.data.santaEnabled },
    update: { santaEnabled: parsed.data.santaEnabled },
  });
  void sendAdminAlert(
    `🎛 Santa global switch <b>${updated.santaEnabled ? 'ENABLED ✅' : 'DISABLED 🔴'}</b> by godMode user ${user.id}`,
  );
  return res.json({ santaEnabled: updated.santaEnabled });
}));

// GET /tg/santa/admin/season-broadcasts — view sent seasonal broadcast history (godMode only)
tgRouter.get('/santa/admin/season-broadcasts', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  if (!user.godMode) return res.status(403).json({ error: 'Forbidden' });
  const logs = await prisma.santaSeasonalBroadcastLog.findMany({
    orderBy: [{ year: 'desc' }, { type: 'asc' }],
    take: 20,
  });
  return res.json(logs);
}));

// POST /tg/santa/admin/season-broadcasts — manually trigger a seasonal broadcast (godMode only)
// Used for testing or if the automated job missed the Nov 1 / Feb 1 window for any reason.
// Body: { type: 'PROMO' | 'CLOSING_SOON', seasonYear: number, force?: boolean }
// force=true skips the already-sent guard and re-sends even if log row exists.
tgRouter.post('/santa/admin/season-broadcasts', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  if (!user.godMode) return res.status(403).json({ error: 'Forbidden' });
  const parsed = z.object({
    type:       z.enum(['PROMO', 'CLOSING_SOON']),
    seasonYear: z.number().int().min(2020).max(2100),
    force:      z.boolean().optional().default(false),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const { type, seasonYear, force } = parsed.data;

  if (force) {
    // Delete existing log row so sendSeasonalBroadcast can re-create it
    await prisma.santaSeasonalBroadcastLog.deleteMany({
      where: { year: seasonYear, type },
    });
  }

  // Fire in background; response confirms the job was queued
  void sendSeasonalBroadcast(type, seasonYear);
  return res.json({ ok: true, queued: { type, seasonYear, force } });
}));

// POST /tg/santa/campaigns — create a new campaign
tgRouter.post('/santa/campaigns', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const parsed = z.object({
    title: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    type: z.enum(['CLASSIC', 'MULTI_WAVE']).default('CLASSIC'),
    minBudget: z.number().int().positive().optional(),
    maxBudget: z.number().int().positive().optional(),
    currency: z.string().max(3).default('RUB'),
    drawAt: z.string().datetime().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const info = await getSantaSeasonInfo(user.id, user.santaTestMode);
  if (!info.canCreate) return res.status(403).json({ error: 'santa_not_in_season' });

  // PRO gate for MULTI_WAVE
  if (parsed.data.type === 'MULTI_WAVE') {
    const ent = await getUserEntitlement(user.id);
    if (!ent.isPro) return res.status(402).json({ error: 'pro_required', feature: 'santa_multi_wave' });
  }

  const now = new Date();
  const campaign = await prisma.santaCampaign.create({
    data: {
      title: parsed.data.title,
      description: parsed.data.description,
      type: parsed.data.type,
      status: 'DRAFT',
      ownerId: user.id,
      minBudget: parsed.data.minBudget,
      maxBudget: parsed.data.maxBudget,
      currency: parsed.data.currency,
      drawAt: parsed.data.drawAt ? new Date(parsed.data.drawAt) : undefined,
      seasonYear: now.getFullYear(),
    },
    select: { id: true, title: true, status: true, inviteToken: true, type: true, seasonYear: true, createdAt: true },
  });

  await prisma.santaAdminAuditLog.create({
    data: { campaignId: campaign.id, actorId: user.id, action: 'campaign_created' },
  });

  return res.status(201).json({ campaign });
}));

// GET /tg/santa/campaigns — list my campaigns (owned + joined)
tgRouter.get('/santa/campaigns', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);

  const [owned, joined] = await Promise.all([
    prisma.santaCampaign.findMany({
      where: { ownerId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, title: true, status: true, type: true, seasonYear: true, createdAt: true,
        _count: { select: { participants: { where: { status: 'JOINED' } } } },
      },
    }),
    prisma.santaParticipant.findMany({
      where: { userId: user.id, status: 'JOINED', campaign: { ownerId: { not: user.id } } },
      orderBy: { joinedAt: 'desc' },
      select: {
        campaign: {
          select: {
            id: true, title: true, status: true, type: true, seasonYear: true, createdAt: true,
            _count: { select: { participants: { where: { status: 'JOINED' } } } },
            owner: { select: { firstName: true, profile: { select: { displayName: true } } } },
          },
        },
      },
    }),
  ]);

  return res.json({
    owned: owned.map(c => ({ ...c, participantCount: c._count.participants })),
    joined: joined.map(j => ({
      ...j.campaign,
      participantCount: j.campaign._count.participants,
      ownerName: j.campaign.owner.profile?.displayName || j.campaign.owner.firstName || null,
    })),
  });
}));

// GET /tg/santa/campaigns/:id — campaign detail (participants only)
tgRouter.get('/santa/campaigns/:id', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true, title: true, description: true, type: true, status: true, ownerId: true,
      inviteToken: true, minBudget: true, maxBudget: true, currency: true, drawAt: true,
      seasonYear: true, cancelledAt: true, cancelReason: true, createdAt: true,
      currentRoundId: true,
      participants: {
        where: { status: { in: ['JOINED', 'INVITED'] } },
        select: {
          id: true, status: true, role: true, joinedAt: true,
          user: { select: { id: true, firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
          linkedWishlist: { select: { id: true, title: true, slug: true } },
        },
        orderBy: { joinedAt: 'asc' },
      },
      rounds: { select: { id: true, roundNumber: true }, orderBy: { roundNumber: 'asc' } },
    },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const isOwner = campaign.ownerId === user.id;
  const isParticipant = campaign.participants.some(p => p.user.id === user.id);
  if (!isOwner && !isParticipant) return res.status(403).json({ error: 'Forbidden' });

  // Find caller's own assignment (post-draw) — role-aware, never leaks pairs
  let myAssignment: SantaAssignmentForGiver | null = null;
  let ownerProgress: SantaAssignmentForOwner | null = null;
  const myParticipant = campaign.participants.find(p => p.user.id === user.id);
  if (campaign.currentRoundId && ['ACTIVE', 'COMPLETED'].includes(campaign.status)) {
    const roundId = campaign.currentRoundId;
    // Organizer (owner or admin) sees aggregate progress — no individual pairs
    const callerParticipant = campaign.participants.find(p => p.user.id === user.id);
    const callerIsOrganizer = campaign.ownerId === user.id ||
      (callerParticipant?.status === 'JOINED' && callerParticipant.role === 'ADMIN');
    if (callerIsOrganizer) {
      const allAssignments = await prisma.santaAssignment.findMany({
        where: { roundId },
        select: { giftStatus: true },
      });
      // Count receivers without a linked wishlist (so organizer can nudge them)
      const receiverWithoutWishlistCount = campaign.participants.filter(
        p => p.status === 'JOINED' && !p.linkedWishlist,
      ).length;
      ownerProgress = serializeAssignment('owner', { assignments: allAssignments, receiverWithoutWishlistCount });
    }
    if (myParticipant) {
      // Giver view for all participants (including owner if they're also a participant)
      const giverAssignment = await prisma.santaAssignment.findUnique({
        where: { roundId_giverParticipantId: { roundId, giverParticipantId: myParticipant.id } },
        select: {
          giftStatus: true, giftNote: true,
          receiver: {
            select: {
              linkedWishlistId: true,
              user: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
            },
          },
          santaItemReservations: {
            select: { itemId: true, item: { select: { title: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
      if (giverAssignment) {
        const receiverDisplayName = giverAssignment.receiver.user.profile?.displayName
          || giverAssignment.receiver.user.firstName || 'Получатель';
        const receiverAvatarUrl = giverAssignment.receiver.user.profile?.avatarUrl || null;
        myAssignment = serializeAssignment('giver', {
          giftStatus: giverAssignment.giftStatus,
          giftNote: giverAssignment.giftNote,
          receiver: {
            displayName: receiverDisplayName,
            avatarUrl: receiverAvatarUrl,
            hasLinkedWishlist: !!giverAssignment.receiver.linkedWishlistId,
          },
          reservedItems: giverAssignment.santaItemReservations.map(r => ({ id: r.itemId, title: r.item.title })),
        });
      }
    }
  }

  // Pending exit request for caller (if they have one)
  let pendingExitRequestId: string | null = null;
  if (myParticipant && !isOwner) {
    const pendingReq = await prisma.santaExitRequest.findFirst({
      where: { participantId: myParticipant.id, status: 'PENDING' },
      select: { id: true },
    });
    pendingExitRequestId = pendingReq?.id ?? null;
  }

  // Number of pending exit requests visible to organizers
  const pendingExitRequestCount = (isOwner || myParticipant?.role === 'ADMIN')
    ? await prisma.santaExitRequest.count({ where: { campaignId, status: 'PENDING' } })
    : 0;

  // Is caller an organizer (owner or ADMIN participant)?
  const amOrganizer = isOrganizer(campaign, user.id, myParticipant);

  // Chat unread count + mute state for participant
  let chatUnreadCount = 0;
  let isMuted = false;
  if (myParticipant) {
    const [chatCursor, mutedEntry] = await Promise.all([
      prisma.santaChatReadCursor.findUnique({
        where: { campaignId_participantId: { campaignId, participantId: myParticipant.id } },
        select: { lastReadMessageId: true },
      }),
      prisma.santaChatMute.findUnique({
        where: { campaignId_participantId: { campaignId, participantId: myParticipant.id } },
        select: { id: true },
      }),
    ]);
    isMuted = !!mutedEntry;
    if (!chatCursor?.lastReadMessageId) {
      chatUnreadCount = await prisma.santaChatMessage.count({ where: { campaignId } });
    } else {
      const lastRead = await prisma.santaChatMessage.findUnique({
        where: { id: chatCursor.lastReadMessageId },
        select: { createdAt: true, id: true },
      });
      if (lastRead) {
        chatUnreadCount = await prisma.santaChatMessage.count({
          where: {
            campaignId,
            OR: [
              { createdAt: { gt: lastRead.createdAt } },
              { createdAt: lastRead.createdAt, id: { gt: lastRead.id } },
            ],
          },
        });
      } else {
        chatUnreadCount = await prisma.santaChatMessage.count({ where: { campaignId } });
      }
    }
  }

  return res.json({
    campaign: {
      id: campaign.id,
      title: campaign.title,
      description: campaign.description,
      type: campaign.type,
      status: campaign.status,
      isOwner,
      isOrganizer: amOrganizer,
      inviteToken: isOwner ? campaign.inviteToken : undefined,
      minBudget: campaign.minBudget,
      maxBudget: campaign.maxBudget,
      currency: campaign.currency,
      drawAt: campaign.drawAt,
      seasonYear: campaign.seasonYear,
      cancelledAt: campaign.cancelledAt,
      cancelReason: campaign.cancelReason,
      createdAt: campaign.createdAt,
    },
    participants: campaign.participants.map(p => ({
      id: p.id,
      status: p.status,
      role: p.role,
      joinedAt: p.joinedAt,
      userId: p.user.id,
      isMe: p.user.id === user.id,   // P0-A: frontend uses this; p.user.id is WishBoard cuid, not Telegram ID
      displayName: p.user.profile?.displayName || p.user.firstName || null,
      avatarUrl: p.user.profile?.avatarUrl || null,
      hasLinkedWishlist: !!p.linkedWishlist,
      linkedWishlist: isOwner ? p.linkedWishlist : (p.user.id === user.id ? p.linkedWishlist : null),
    })),
    rounds: campaign.rounds,
    currentRoundNumber: campaign.rounds.find(r => r.id === campaign.currentRoundId)?.roundNumber ?? null,
    totalRounds: campaign.rounds.length,
    myRole: myParticipant?.role ?? null,               // caller's role: 'PARTICIPANT' | 'ADMIN' | null
    pendingExitRequestId,                               // caller's pending exit request id, if any
    pendingExitRequestCount: amOrganizer ? pendingExitRequestCount : undefined, // organizer only
    myAssignment,
    ownerProgress: amOrganizer ? ownerProgress : undefined,
    chatUnreadCount,
    isMuted,
  });
}));

// PATCH /tg/santa/campaigns/:id — update campaign (owner only, non-COMPLETED/CANCELLED)
tgRouter.patch('/santa/campaigns/:id', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const parsed = z.object({
    title: z.string().min(1).max(80).optional(),
    description: z.string().max(500).nullable().optional(),
    minBudget: z.number().int().positive().nullable().optional(),
    maxBudget: z.number().int().positive().nullable().optional(),
    currency: z.string().max(3).optional(),
    drawAt: z.string().datetime().nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, status: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });
  if (['COMPLETED', 'CANCELLED'].includes(campaign.status)) return res.status(409).json({ error: 'Campaign is finished' });

  const data: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) data.title = parsed.data.title;
  if (parsed.data.description !== undefined) data.description = parsed.data.description;
  if (parsed.data.minBudget !== undefined) data.minBudget = parsed.data.minBudget;
  if (parsed.data.maxBudget !== undefined) data.maxBudget = parsed.data.maxBudget;
  if (parsed.data.currency !== undefined) data.currency = parsed.data.currency;
  if (parsed.data.drawAt !== undefined) data.drawAt = parsed.data.drawAt ? new Date(parsed.data.drawAt) : null;

  const updated = await prisma.santaCampaign.update({ where: { id: campaignId }, data });
  return res.json({ campaign: updated });
}));

// POST /tg/santa/campaigns/:id/open — DRAFT → OPEN
tgRouter.post('/santa/campaigns/:id/open', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, status: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });
  if (campaign.status !== 'DRAFT') return res.status(409).json({ error: 'Campaign is not in DRAFT status' });

  await prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'OPEN' } });
  await prisma.santaAdminAuditLog.create({ data: { campaignId, actorId: user.id, action: 'status_changed', payload: { from: 'DRAFT', to: 'OPEN' } } });
  return res.json({ ok: true });
}));

// POST /tg/santa/campaigns/:id/lock — OPEN → LOCKED
tgRouter.post('/santa/campaigns/:id/lock', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { ownerId: true, status: true, _count: { select: { participants: { where: { status: 'JOINED' } } } } },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });
  if (campaign.status !== 'OPEN') return res.status(409).json({ error: 'Campaign is not OPEN' });
  if (campaign._count.participants < 2) return res.status(422).json({ error: 'Need at least 2 participants to lock' });

  await prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'LOCKED' } });
  await prisma.santaAdminAuditLog.create({ data: { campaignId, actorId: user.id, action: 'status_changed', payload: { from: 'OPEN', to: 'LOCKED' } } });
  return res.json({ ok: true });
}));

// POST /tg/santa/campaigns/:id/cancel — cancel campaign (owner only)
tgRouter.post('/santa/campaigns/:id/cancel', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const parsed = z.object({ reason: z.string().max(200).optional() }).safeParse(req.body);

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, status: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  // Cancel is owner-only — admins cannot cancel campaigns
  if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can cancel the campaign' });
  if (['COMPLETED', 'CANCELLED'].includes(campaign.status)) return res.status(409).json({ error: 'Campaign is already finished' });

  const now = new Date();
  await prisma.$transaction([
    prisma.santaCampaign.update({
      where: { id: campaignId },
      data: { status: 'CANCELLED', cancelledAt: now, cancelReason: parsed.success ? (parsed.data.reason ?? null) : null },
    }),
    // Bulk-cancel all PENDING hint requests for this campaign (lifecycle rule: campaign cancel → hints CANCELLED)
    prisma.santaHintRequest.updateMany({
      where: { campaignId, status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt: now },
    }),
    prisma.santaAdminAuditLog.create({
      data: { campaignId, actorId: user.id, action: 'campaign_cancelled', payload: { reason: parsed.success ? parsed.data.reason : undefined } },
    }),
  ]);
  // System message: campaign cancelled
  void createSystemMessage(campaignId, 'campaign_cancelled', {}).catch(() => {});

  // CAMPAIGN_CANCELLED notifications — batch insert for all JOINED participants
  void (async () => {
    try {
      const joinedParticipants = await prisma.santaParticipant.findMany({
        where: { campaignId, status: 'JOINED' },
        select: { userId: true },
      });
      if (joinedParticipants.length > 0) {
        await prisma.santaNotification.createMany({
          data: joinedParticipants.map(p => ({
            campaignId,
            userId: p.userId,
            type: 'CAMPAIGN_CANCELLED' as const,
            payload: {},
            dedupeKey: `cancel:${campaignId}`,  // unique per (user, CAMPAIGN_CANCELLED, campaign)
          })),
          skipDuplicates: true,
        });
      }
    } catch {
      // Non-fatal
    }
  })();

  return res.json({ ok: true });
}));

// ─── Santa draw algorithm helpers ─────────────────────────────────────────────

/**
 * Build exclusion set as "smallerUserId:largerUserId" strings for O(1) lookup.
 */
/**
 * isOrganizer: returns true if the user is the campaign owner OR has a JOINED participant
 * record with role=ADMIN in this campaign. Used to gate organizer-only actions.
 *
 * Pass the campaign object (must include ownerId) and the participant record if already
 * loaded (can be null if the user has no participant record).
 */
function isOrganizer(
  campaign: { ownerId: string },
  userId: string,
  participant: { status: string; role: string } | null | undefined,
): boolean {
  if (campaign.ownerId === userId) return true;
  if (participant?.status === 'JOINED' && participant.role === 'ADMIN') return true;
  return false;
}

/**
 * checkIsOrganizer: async version of isOrganizer that loads the participant
 * record from DB when needed. Fast-paths if campaign.ownerId === userId.
 */
async function checkIsOrganizer(campaignId: string, campaign: { ownerId: string }, userId: string): Promise<boolean> {
  if (campaign.ownerId === userId) return true;
  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId } },
    select: { status: true, role: true },
  });
  return participant?.status === 'JOINED' && participant.role === 'ADMIN';
}

/**
 * Terminal gift statuses — used to check whether a round is complete enough
 * to allow starting the next round or to evaluate orphaned assignments.
 */
const TERMINAL_GIFT_STATUSES = ['RECEIVED', 'MISSED_DEADLINE', 'ORPHANED'] as const;

function buildExclusionSet(exclusions: { userId1: string; userId2: string }[]): Set<string> {
  const set = new Set<string>();
  for (const e of exclusions) {
    const key = [e.userId1, e.userId2].sort().join(':');
    set.add(key);
  }
  return set;
}

function exclusionKey(userIdA: string, userIdB: string): string {
  return [userIdA, userIdB].sort().join(':');
}

/**
 * Load all exclusions for a campaign (individual + group-expanded) and return:
 *  - exclusionSet: flat Set<string> ready for draw/feasibility (interface unchanged)
 *  - groups: raw group data used to annotate infeasible-draw errors with group labels
 *
 * Groups expand to C(n,2) pairs in-memory — no SantaExclusion rows are created.
 *
 * activeUserIds: Set of userIds who are currently JOINED in the campaign.
 * Group members who are no longer JOINED (left / removed) are silently skipped
 * during pair expansion so stale membership never blocks a valid draw.
 * The raw groups list returned still contains ALL members for UI/annotation use.
 */
async function loadExclusionSet(campaignId: string, activeUserIds: Set<string>): Promise<{
  exclusionSet: Set<string>;
  groups: { id: string; label: string; members: { userId: string }[] }[];
}> {
  const [individual, groups] = await Promise.all([
    prisma.santaExclusion.findMany({
      where: { campaignId },
      select: { userId1: true, userId2: true },
    }),
    prisma.santaExclusionGroup.findMany({
      where: { campaignId },
      select: { id: true, label: true, members: { select: { userId: true } } },
    }),
  ]);

  // Start with individual pair exclusions
  const allPairs: { userId1: string; userId2: string }[] = [...individual];

  // Expand each group: only expand members who are still JOINED participants.
  // Stale members (left / removed / deleted) are excluded from pair generation
  // but kept in the raw `groups` return value for UI display.
  for (const group of groups) {
    const members = group.members.map(m => m.userId).filter(uid => activeUserIds.has(uid));
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        allPairs.push({ userId1: members[i]!, userId2: members[j]! });
      }
    }
  }

  return { exclusionSet: buildExclusionSet(allPairs), groups };
}

/**
 * Given the loaded groups, find which group (if any) contributed a specific pair.
 * Used to annotate infeasible-draw error with a human-readable group label.
 */
function findGroupForPair(
  groups: { label: string; members: { userId: string }[] }[],
  uid1: string,
  uid2: string,
): string | null {
  for (const group of groups) {
    const memberIds = new Set(group.members.map(m => m.userId));
    if (memberIds.has(uid1) && memberIds.has(uid2)) return group.label;
  }
  return null;
}

/**
 * Hopcroft-Karp bipartite matching.
 * givers[i] can be assigned to receivers[j] if allowed[i][j] is true.
 * Returns maximum matching size. If size == N, a valid assignment exists.
 */
function hopcroftKarp(
  n: number,
  adj: number[][],   // adj[giver_index] = list of valid receiver_indexes
): { matchingSize: number; matchG: number[]; matchR: number[] } {
  const INF = Number.MAX_SAFE_INTEGER;
  const matchG = new Array<number>(n).fill(-1); // matchG[giver] = receiver index (-1 = unmatched)
  const matchR = new Array<number>(n).fill(-1); // matchR[receiver] = giver index
  const dist = new Array<number>(n);

  function bfs(): boolean {
    const queue: number[] = [];
    for (let u = 0; u < n; u++) {
      if (matchG[u] === -1) { dist[u] = 0; queue.push(u); }
      else dist[u] = INF;
    }
    let found = false;
    let qi = 0;
    while (qi < queue.length) {
      const u = queue[qi++]!;
      for (const v of adj[u]!) {
        const w = matchR[v]!;
        if (w === -1) { found = true; }
        else if (dist[w] === INF) { dist[w] = (dist[u] ?? 0) + 1; queue.push(w); }
      }
    }
    return found;
  }

  function dfs(u: number): boolean {
    for (const v of adj[u]!) {
      const w = matchR[v]!;
      if (w === -1 || (dist[w] === (dist[u] ?? 0) + 1 && dfs(w))) {
        matchG[u] = v; matchR[v] = u; return true;
      }
    }
    dist[u] = INF;
    return false;
  }

  let matchingSize = 0;
  while (bfs()) {
    for (let u = 0; u < n; u++) {
      if (matchG[u] === -1 && dfs(u)) matchingSize++;
    }
  }
  return { matchingSize, matchG, matchR };
}

/**
 * Check draw feasibility. Returns { feasible, problematic } without any side effects.
 * "problematic" lists participant userId pairs whose exclusion is most constraining.
 */
function checkDrawFeasibility(
  participants: { id: string; userId: string }[],
  exclusionSet: Set<string>,
): { feasible: boolean; problematic: { userId1: string; userId2: string }[] } {
  const n = participants.length;
  const idx = new Map<string, number>(); // participantId → index
  participants.forEach((p, i) => idx.set(p.id, i));

  const adj: number[][] = participants.map((giver, i) =>
    participants
      .map((receiver, j) => ({ receiver, j }))
      .filter(({ receiver, j }) =>
        j !== i && !exclusionSet.has(exclusionKey(giver.userId, receiver.userId))
      )
      .map(({ j }) => j)
  );

  const { matchingSize } = hopcroftKarp(n, adj);
  if (matchingSize === n) return { feasible: true, problematic: [] };

  // Identify most constrained participants (fewest valid receivers)
  const constrained = participants
    .map((p, i) => ({ userId: p.userId, options: adj[i]!.length }))
    .sort((a, b) => a.options - b.options)
    .slice(0, 3);

  // Find exclusions among the most constrained to give actionable feedback
  const problematic: { userId1: string; userId2: string }[] = [];
  for (let i = 0; i < constrained.length; i++) {
    for (let j = i + 1; j < constrained.length; j++) {
      const a = constrained[i]!.userId;
      const b = constrained[j]!.userId;
      if (exclusionSet.has(exclusionKey(a, b))) problematic.push({ userId1: a, userId2: b });
    }
  }
  // Also add exclusions where a participant has 0 valid receivers
  for (const c of constrained) {
    if (c.options === 0) {
      // Find all exclusions involving this participant
      for (const p2 of participants) {
        if (p2.userId !== c.userId && exclusionSet.has(exclusionKey(c.userId, p2.userId))) {
          problematic.push({ userId1: c.userId, userId2: p2.userId });
        }
      }
    }
  }

  return { feasible: false, problematic };
}

/**
 * Generate a random valid derangement (Secret Santa assignment) using Fisher-Yates + backtracking.
 * Returns array of { giverParticipantId, receiverParticipantId } or null if exhausted retries.
 */
function drawRandomAssignments(
  participants: { id: string; userId: string }[],
  exclusionSet: Set<string>,
  maxRetries = 1000,
): { giverParticipantId: string; receiverParticipantId: string }[] | null {
  const n = participants.length;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Fisher-Yates shuffle of receiver indexes
    const receivers = [...participants];
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [receivers[i], receivers[j]] = [receivers[j]!, receivers[i]!];
    }

    // Check all constraints
    let valid = true;
    for (let i = 0; i < n; i++) {
      const giver = participants[i]!;
      const receiver = receivers[i]!;
      if (giver.id === receiver.id) { valid = false; break; } // self-pair
      if (exclusionSet.has(exclusionKey(giver.userId, receiver.userId))) { valid = false; break; }
    }

    if (valid) {
      return participants.map((giver, i) => ({
        giverParticipantId: giver.id,
        receiverParticipantId: receivers[i]!.id,
      }));
    }
  }

  // Random approach exhausted → use deterministic backtracking
  const assignment = new Array<number>(n).fill(-1);
  const used = new Array<boolean>(n).fill(false);

  // Build adjacency list for each giver
  const adj: number[][] = participants.map((giver, i) => {
    const options: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      if (!exclusionSet.has(exclusionKey(giver.userId, participants[j]!.userId))) options.push(j);
    }
    // Shuffle options for randomness
    for (let k = options.length - 1; k > 0; k--) {
      const r = Math.floor(Math.random() * (k + 1));
      [options[k], options[r]] = [options[r]!, options[k]!];
    }
    return options;
  });

  function backtrack(pos: number): boolean {
    if (pos === n) return true;
    for (const j of adj[pos]!) {
      if (!used[j]) {
        assignment[pos] = j;
        used[j] = true;
        if (backtrack(pos + 1)) return true;
        assignment[pos] = -1;
        used[j] = false;
      }
    }
    return false;
  }

  if (!backtrack(0)) return null;
  return participants.map((giver, i) => ({
    giverParticipantId: giver.id,
    receiverParticipantId: participants[assignment[i]!]!.id,
  }));
}

// ─── Santa — role-aware assignment serializer ─────────────────────────────────

type SantaAssignmentForGiver = {
  role: 'giver';
  giftStatus: string;
  giftNote: string | null;
  receiver: { displayName: string; avatarUrl: string | null; hasLinkedWishlist: boolean };
  reservedItems: { id: string; title: string }[];
};

type SantaAssignmentForReceiver = {
  role: 'receiver';
  giftStatus: string;
  hasGiver: true;
};

type SantaAssignmentForOwner = {
  role: 'owner';
  progress: {
    pending: number;
    buying: number;              // legacy BUYING count
    selectedFromWishlist: number;
    selectedOutside: number;
    declinedToSay: number;
    missedDeadline: number;
    sent: number;
    received: number;
    orphaned: number;            // exits approved mid-round
    withoutWishlist: number;     // receivers without a linked wishlist
  };
};

// ─── Inbound signal helpers (Batch 3) ─────────────────────────────────────────

/**
 * Maps a raw SantaGiftStatus value to a clean receiver-facing inbound signal.
 * Deliberately coarse to prevent side-channel deduction of giver behaviour timing.
 *   waiting     = giver hasn't committed to anything yet
 *   in_progress = giver has made a selection (type intentionally hidden)
 *   ready       = giver says they sent it; receiver should confirm receipt
 *   received    = receiver confirmed; reveal is now unlocked personally
 */
function giftStatusToInboundSignal(giftStatus: string): 'waiting' | 'in_progress' | 'ready' | 'received' {
  switch (giftStatus) {
    case 'SELECTED_FROM_WISHLIST':
    case 'SELECTED_OUTSIDE':
    case 'DECLINED_TO_SAY':
    case 'BUYING':           // legacy
      return 'in_progress';
    case 'SENT':
      return 'ready';
    case 'RECEIVED':
      return 'received';
    case 'PENDING':
    case 'MISSED_DEADLINE':  // don't expose giver's failure to receiver
    default:
      return 'waiting';
  }
}

/** Allowed giver-initiated gift status transitions (Batch 3 state machine). */
const GIVER_ALLOWED_TRANSITIONS: Record<string, string[]> = {
  PENDING:                ['SELECTED_FROM_WISHLIST', 'SELECTED_OUTSIDE', 'DECLINED_TO_SAY', 'SENT', 'BUYING'],
  BUYING:                 ['SELECTED_FROM_WISHLIST', 'SELECTED_OUTSIDE', 'DECLINED_TO_SAY', 'SENT'],
  SELECTED_FROM_WISHLIST: ['SELECTED_OUTSIDE', 'DECLINED_TO_SAY', 'SENT'],
  SELECTED_OUTSIDE:       ['SELECTED_FROM_WISHLIST', 'DECLINED_TO_SAY', 'SENT'],
  DECLINED_TO_SAY:        ['SELECTED_FROM_WISHLIST', 'SELECTED_OUTSIDE', 'SENT'],
  // M3: BUYING removed from MISSED_DEADLINE — giver must commit to a real choice after missing deadline
  // BUYING is too vague to escape the cron loop (cron re-marks BUYING as MISSED_DEADLINE every hour)
  MISSED_DEADLINE:        ['SELECTED_FROM_WISHLIST', 'SELECTED_OUTSIDE', 'DECLINED_TO_SAY', 'SENT'],
  // SENT and RECEIVED are terminal from the giver side
};

/**
 * Single serialization codepath for assignment data.
 * NEVER expose receiverUserId/receiverParticipantId to giver.
 * NEVER expose giver identity to receiver.
 * NEVER expose individual pairs to owner.
 */
function serializeAssignment(
  role: 'giver',
  data: { giftStatus: string; giftNote: string | null; receiver: { displayName: string; avatarUrl: string | null; hasLinkedWishlist: boolean }; reservedItems?: { id: string; title: string }[] }
): SantaAssignmentForGiver;
function serializeAssignment(
  role: 'receiver',
  data: { giftStatus: string }
): SantaAssignmentForReceiver;
function serializeAssignment(
  role: 'owner',
  data: { assignments: { giftStatus: string }[]; receiverWithoutWishlistCount?: number }
): SantaAssignmentForOwner;
function serializeAssignment(
  role: 'giver' | 'receiver' | 'owner',
  data: unknown,
): SantaAssignmentForGiver | SantaAssignmentForReceiver | SantaAssignmentForOwner {
  if (role === 'giver') {
    const d = data as { giftStatus: string; giftNote: string | null; receiver: { displayName: string; avatarUrl: string | null; hasLinkedWishlist: boolean }; reservedItems?: { id: string; title: string }[] };
    return { role: 'giver', giftStatus: d.giftStatus, giftNote: d.giftNote, receiver: { displayName: d.receiver.displayName, avatarUrl: d.receiver.avatarUrl, hasLinkedWishlist: d.receiver.hasLinkedWishlist }, reservedItems: d.reservedItems ?? [] };
  }
  if (role === 'receiver') {
    const d = data as { giftStatus: string };
    return { role: 'receiver', giftStatus: d.giftStatus, hasGiver: true };
  }
  // owner — aggregate only, never per-assignment detail
  const d = data as { assignments: { giftStatus: string }[]; receiverWithoutWishlistCount?: number };
  const progress = {
    pending: 0, buying: 0, selectedFromWishlist: 0, selectedOutside: 0,
    declinedToSay: 0, missedDeadline: 0, sent: 0, received: 0,
    orphaned: 0,
    withoutWishlist: d.receiverWithoutWishlistCount ?? 0,
  };
  for (const a of d.assignments) {
    switch (a.giftStatus) {
      case 'PENDING':                 progress.pending++; break;
      case 'BUYING':                  progress.buying++; break;
      case 'SELECTED_FROM_WISHLIST':  progress.selectedFromWishlist++; break;
      case 'SELECTED_OUTSIDE':        progress.selectedOutside++; break;
      case 'DECLINED_TO_SAY':         progress.declinedToSay++; break;
      case 'MISSED_DEADLINE':         progress.missedDeadline++; break;
      case 'SENT':                    progress.sent++; break;
      case 'RECEIVED':                progress.received++; break;
      case 'ORPHANED':                progress.orphaned++; break;
    }
  }
  return { role: 'owner', progress };
}

// ─── Santa draw endpoints ──────────────────────────────────────────────────────

// GET /tg/santa/campaigns/:id/draw/validate — feasibility check, ZERO side effects
tgRouter.get('/santa/campaigns/:id/draw/validate', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: {
      ownerId: true,
      status: true,
      participants: {
        where: { status: 'JOINED' },
        select: { id: true, userId: true, user: { select: { firstName: true } } },
      },
      // SantaExclusion is not directly on campaign; query separately
    },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });
  if (!['LOCKED', 'OPEN', 'DRAFT'].includes(campaign.status)) {
    return res.status(409).json({ error: 'Draw can only be validated when campaign is LOCKED, OPEN or DRAFT' });
  }

  const participants = campaign.participants;
  if (participants.length < 2) {
    return res.json({ feasible: false, reason: 'not_enough_participants', minRequired: 2, actual: participants.length });
  }

  const activeUserIds = new Set(participants.map(p => p.userId));
  const { exclusionSet, groups } = await loadExclusionSet(campaignId, activeUserIds);
  const { feasible, problematic } = checkDrawFeasibility(participants, exclusionSet);

  if (feasible) {
    return res.json({ feasible: true, participantCount: participants.length });
  }

  // Build human-readable names + optional group label for each problematic pair
  const userIdToName = new Map(participants.map(p => [p.userId, p.user.firstName || p.userId]));
  const problematicWithNames = problematic.map(p => ({
    userId1: p.userId1, name1: userIdToName.get(p.userId1) ?? p.userId1,
    userId2: p.userId2, name2: userIdToName.get(p.userId2) ?? p.userId2,
    groupLabel: findGroupForPair(groups, p.userId1, p.userId2),
  }));

  return res.json({
    feasible: false,
    reason: 'exclusions_prevent_valid_assignment',
    participantCount: participants.length,
    problematicExclusions: problematicWithNames,
  });
}));

// POST /tg/santa/campaigns/:id/draw — execute draw with atomic lock
tgRouter.post('/santa/campaigns/:id/draw', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  // 1. Verify caller is organizer and campaign is LOCKED
  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { ownerId: true, status: true, id: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  // Draw is owner-only — admins cannot trigger draw
  if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can run the draw' });

  if (campaign.status === 'DRAW_IN_PROGRESS') {
    return res.status(409).json({ error: 'draw_already_running', message: 'A draw is already in progress for this campaign.' });
  }
  if (campaign.status !== 'LOCKED') {
    return res.status(409).json({ error: 'campaign_not_locked', message: 'Campaign must be in LOCKED status to start draw.' });
  }

  // 2. Load participants and exclusions
  const participants = await prisma.santaParticipant.findMany({
    where: { campaignId, status: 'JOINED' },
    select: { id: true, userId: true, user: { select: { firstName: true } } },
  });
  if (participants.length < 2) {
    return res.status(422).json({ error: 'not_enough_participants', minRequired: 2, actual: participants.length });
  }

  const activeUserIds = new Set(participants.map(p => p.userId));
  const { exclusionSet, groups: excGroups } = await loadExclusionSet(campaignId, activeUserIds);

  // 3. Pre-check feasibility before acquiring lock
  const { feasible, problematic } = checkDrawFeasibility(participants, exclusionSet);
  if (!feasible) {
    const userIdToName = new Map(participants.map(p => [p.userId, p.user.firstName || p.userId]));
    const problematicWithNames = problematic.map(p => ({
      userId1: p.userId1, name1: userIdToName.get(p.userId1) ?? p.userId1,
      userId2: p.userId2, name2: userIdToName.get(p.userId2) ?? p.userId2,
      groupLabel: findGroupForPair(excGroups, p.userId1, p.userId2),
    }));
    return res.status(422).json({
      error: 'draw_infeasible',
      reason: 'exclusions_prevent_valid_assignment',
      message: 'С текущими ограничениями жеребьёвка невозможна. Уберите одно из ограничений, чтобы продолжить.',
      problematicExclusions: problematicWithNames,
    });
  }

  // 4. Atomic lock: UPDATE only if still LOCKED (prevents double-draw)
  const drawJobId = crypto.randomUUID();
  const locked = await prisma.santaCampaign.updateMany({
    where: { id: campaignId, status: 'LOCKED' },
    data: { status: 'DRAW_IN_PROGRESS' },
  });
  if (locked.count === 0) {
    return res.status(409).json({ error: 'draw_already_running', message: 'Another draw job already acquired the lock.' });
  }

  // 5. Find the existing PENDING round (created by POST /rounds for multi-round),
  //    or create the first round if none exists.
  //    Invariant: at most one PENDING round per campaign (enforced by partial unique index).
  let round = await prisma.santaRound.findFirst({ where: { campaignId, drawStatus: 'PENDING' } });
  if (!round) {
    // First draw (or there's no pending round — create one)
    const maxRound = await prisma.santaRound.findFirst({
      where: { campaignId },
      orderBy: { roundNumber: 'desc' },
    });
    round = await prisma.santaRound.create({
      data: { campaignId, roundNumber: (maxRound?.roundNumber ?? 0) + 1, drawStatus: 'IN_PROGRESS', drawJobId },
    });
  } else {
    await prisma.santaRound.update({ where: { id: round.id }, data: { drawStatus: 'IN_PROGRESS', drawJobId } });
  }
  const roundId = round.id;

  try {
    // 6. Generate assignment (Fisher-Yates + backtracking)
    const assignments = drawRandomAssignments(participants, exclusionSet);
    if (!assignments) {
      // Should not happen since we pre-checked feasibility, but handle gracefully
      await prisma.$transaction([
        prisma.santaRound.update({ where: { id: roundId }, data: { drawStatus: 'FAILED' } }),
        prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'LOCKED' } }),
      ]);
      return res.status(500).json({ error: 'draw_failed', message: 'Draw algorithm failed despite feasibility check. Please retry.' });
    }

    // 7. Atomically persist assignments + mark ACTIVE
    await prisma.$transaction([
      prisma.santaAssignment.createMany({
        data: assignments.map(a => ({ roundId, ...a, giftStatus: 'PENDING' })),
      }),
      prisma.santaRound.update({ where: { id: roundId }, data: { drawStatus: 'DONE', drawnAt: new Date() } }),
      prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'ACTIVE', currentRoundId: round.id } }),
    ]);

    // 8. Audit log
    await prisma.santaAdminAuditLog.create({
      data: { campaignId, actorId: user.id, action: 'draw_completed', payload: { drawJobId, assignmentCount: assignments.length } },
    });

    // System message: draw done (no pair info — just a generic event marker)
    void createSystemMessage(campaignId, 'draw_done', {}).catch(() => {});

    // DRAW_DONE notifications — one per participant per round, deduped by dedupeKey
    void (async () => {
      try {
        await prisma.santaNotification.createMany({
          data: participants.map(p => ({
            campaignId,
            userId: p.userId,
            type: 'DRAW_DONE' as const,
            payload: {},
            dedupeKey: `draw:${roundId}`,   // unique per (user, DRAW_DONE, round)
          })),
          skipDuplicates: true,
        });
      } catch {
        // Non-fatal
      }
    })();

    return res.json({ ok: true, assignmentCount: assignments.length });

  } catch (err) {
    // Rollback: mark round FAILED, campaign back to LOCKED for retry
    try {
      await prisma.$transaction([
        prisma.santaRound.update({ where: { id: roundId }, data: { drawStatus: 'FAILED' } }),
        prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'LOCKED' } }),
      ]);
    } catch (_rollbackErr) {
      // Best-effort rollback
    }
    throw err; // Re-throw for asyncHandler to catch
  }
}));

// GET /tg/santa/invite/:token — resolve invite token → campaign preview
tgRouter.get('/santa/invite/:token', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const token = req.params.token ?? '';
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const campaign = await prisma.santaCampaign.findUnique({
    where: { inviteToken: token },
    select: {
      id: true, title: true, description: true, status: true, type: true, seasonYear: true,
      minBudget: true, maxBudget: true, currency: true,
      owner: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
      _count: { select: { participants: { where: { status: 'JOINED' } } } },
    },
  });

  if (!campaign) return res.status(404).json({ error: 'Invite not found' });
  if (campaign.status === 'CANCELLED') return res.status(410).json({ error: 'Campaign cancelled' });

  // P0-B: if user is already a JOINED participant, let them through regardless of campaign status
  // (they clicked the invite link from a running campaign — redirect them to campaign detail)
  const alreadyJoined = await prisma.santaParticipant.findFirst({
    where: { campaignId: campaign.id, userId: user.id, status: 'JOINED' },
    select: { id: true },
  });

  if (!alreadyJoined && !['OPEN', 'DRAFT'].includes(campaign.status)) {
    return res.status(409).json({ error: 'Campaign is not accepting new members', campaignId: campaign.id });
  }

  const campaignPreview = {
    id: campaign.id,
    title: campaign.title,
    description: campaign.description,
    status: campaign.status,
    type: campaign.type,
    seasonYear: campaign.seasonYear,
    minBudget: campaign.minBudget,
    maxBudget: campaign.maxBudget,
    currency: campaign.currency,
    participantCount: campaign._count.participants,
    ownerName: campaign.owner.profile?.displayName || campaign.owner.firstName || null,
    ownerAvatarUrl: campaign.owner.profile?.avatarUrl || null,
  };

  return res.json({ campaign: campaignPreview, alreadyJoined: !!alreadyJoined });
}));

// POST /tg/santa/campaigns/:id/join — join via invite token
tgRouter.post('/santa/campaigns/:id/join', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { status: true, ownerId: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status === 'CANCELLED') return res.status(410).json({ error: 'Campaign cancelled' });
  if (!['OPEN', 'DRAFT'].includes(campaign.status)) return res.status(409).json({ error: 'Campaign is not accepting new members' });

  // Already a participant?
  const existing = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
  });
  if (existing) {
    if (existing.status === 'JOINED') return res.json({ ok: true, alreadyJoined: true });
    // Rejoin if left/removed
    await prisma.santaParticipant.update({
      where: { id: existing.id },
      data: { status: 'JOINED', leftAt: null, joinedAt: new Date() },
    });
    // System message: rejoined
    const rejoinDisplayName = user.firstName || 'Someone';
    void createSystemMessage(campaignId, 'participant_joined', { displayName: rejoinDisplayName }).catch(() => {});
    return res.json({ ok: true });
  }

  const newParticipant = await prisma.santaParticipant.create({
    data: { campaignId, userId: user.id, status: 'JOINED' },
    select: { id: true },
  });
  // System message: participant joined
  const joinDisplayName = user.firstName || 'Someone';
  void createSystemMessage(campaignId, 'participant_joined', { displayName: joinDisplayName }).catch(() => {});
  // Notify owner
  void prisma.santaNotification.create({
    data: { campaignId, userId: campaign.ownerId, type: 'JOINED', payload: { participantId: newParticipant.id } },
  }).catch(() => {});

  return res.status(201).json({ ok: true });
}));

// POST /tg/santa/campaigns/:id/leave — leave campaign (before draw)
tgRouter.post('/santa/campaigns/:id/leave', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
    include: { campaign: { select: { status: true } } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(404).json({ error: 'Not a participant' });
  // COMPLETED/CANCELLED: cannot leave at all (terminal states)
  if (['COMPLETED', 'CANCELLED'].includes(participant.campaign.status)) {
    return res.status(409).json({ error: 'Campaign is already finished' });
  }
  // LOCKED, DRAW_IN_PROGRESS, or ACTIVE: must use exit-request flow
  if (['LOCKED', 'DRAW_IN_PROGRESS', 'ACTIVE'].includes(participant.campaign.status)) {
    return res.status(409).json({
      error: 'use_exit_request',
      message: 'Campaign is locked or active. Submit an exit request for the organizer to approve.',
      campaignStatus: participant.campaign.status,
    });
  }

  await prisma.santaParticipant.update({
    where: { id: participant.id },
    data: { status: 'LEFT', leftAt: new Date() },
  });
  // System message: participant left
  const leaveDisplayName = user.firstName || 'Someone';
  void createSystemMessage(campaignId, 'participant_left', { displayName: leaveDisplayName }).catch(() => {});

  return res.json({ ok: true });
}));

// DELETE /tg/santa/campaigns/:id/participants/:userId — remove participant (organizer only, before draw)
tgRouter.delete('/santa/campaigns/:id/participants/:userId', asyncHandler(async (req, res) => {
  const owner = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const targetUserId = req.params.userId ?? '';

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, status: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  // M5: removal is owner-only (admins can manage participants but not remove them)
  if (campaign.ownerId !== owner.id) return res.status(403).json({ error: 'Forbidden' });
  // Owner cannot remove themselves via this endpoint
  if (targetUserId === owner.id) return res.status(400).json({ error: 'Cannot remove yourself via this endpoint' });
  if (['ACTIVE', 'COMPLETED', 'DRAW_IN_PROGRESS'].includes(campaign.status)) {
    return res.status(409).json({ error: 'Cannot remove after draw' });
  }

  const participant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: targetUserId, status: 'JOINED' },
  });
  if (!participant) return res.status(404).json({ error: 'Participant not found' });

  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { firstName: true, profile: { select: { displayName: true } } },
  });
  await prisma.santaParticipant.update({
    where: { id: participant.id },
    data: { status: 'REMOVED', leftAt: new Date() },
  });
  // System message: participant was removed (no userId in payload — privacy)
  const removedDisplayName = targetUser?.profile?.displayName || targetUser?.firstName || 'Someone';
  void createSystemMessage(campaignId, 'participant_removed', { displayName: removedDisplayName }).catch(() => {});

  return res.json({ ok: true });
}));

// PATCH /tg/santa/campaigns/:id/wishlist — link or unlink wishlist (participant only)
tgRouter.patch('/santa/campaigns/:id/wishlist', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const parsed = z.object({ wishlistId: z.string().nullable() }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
    include: { campaign: { select: { status: true } } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(404).json({ error: 'Not a participant' });
  // Allow linking/changing during ACTIVE so participants who forgot to link pre-draw can still set a preference.
  // Block only terminal states and mid-draw state.
  if (['COMPLETED', 'CANCELLED', 'DRAW_IN_PROGRESS'].includes(participant.campaign.status)) {
    return res.status(409).json({ error: 'Cannot change wishlist after campaign is complete' });
  }

  if (parsed.data.wishlistId) {
    // Verify user owns this wishlist
    const wishlist = await prisma.wishlist.findUnique({ where: { id: parsed.data.wishlistId }, select: { ownerId: true } });
    if (!wishlist || wishlist.ownerId !== user.id) return res.status(404).json({ error: 'Wishlist not found' });
  }

  await prisma.santaParticipant.update({
    where: { id: participant.id },
    data: { linkedWishlistId: parsed.data.wishlistId },
  });
  return res.json({ ok: true });
}));

// GET /tg/santa/campaigns/:id/exclusions — list exclusions (owner only)
tgRouter.get('/santa/campaigns/:id/exclusions', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  // Load individual exclusions + groups + joined participants in parallel
  const [rawExclusions, groups, joinedParticipants] = await Promise.all([
    prisma.santaExclusion.findMany({ where: { campaignId }, orderBy: { createdAt: 'asc' } }),
    prisma.santaExclusionGroup.findMany({
      where: { campaignId },
      orderBy: { createdAt: 'asc' },
      include: {
        members: {
          include: {
            user: { select: { id: true, firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
          },
        },
      },
    }),
    prisma.santaParticipant.findMany({
      where: { campaignId, status: 'JOINED' },
      select: { userId: true },
    }),
  ]);

  const joinedUserIds = new Set(joinedParticipants.map(p => p.userId));

  // Resolve display names for individual pair exclusions
  const allUserIds = new Set([...rawExclusions.map(e => e.userId1), ...rawExclusions.map(e => e.userId2)]);
  const userRecords = allUserIds.size > 0
    ? await prisma.user.findMany({
        where: { id: { in: [...allUserIds] } },
        select: { id: true, firstName: true, profile: { select: { displayName: true, avatarUrl: true } } },
      })
    : [];
  const userMap = new Map(userRecords.map(u => [u.id, u]));
  const displayName = (uid: string) => {
    const u = userMap.get(uid);
    return u?.profile?.displayName || u?.firstName || uid;
  };

  return res.json({
    exclusions: rawExclusions.map(e => ({
      id: e.id,
      userId1: e.userId1, name1: displayName(e.userId1),
      userId2: e.userId2, name2: displayName(e.userId2),
    })),
    groups: groups.map(g => ({
      id: g.id,
      label: g.label,
      members: g.members.map(m => ({
        userId: m.userId,
        displayName: m.user.profile?.displayName || m.user.firstName || m.userId,
        avatarUrl: m.user.profile?.avatarUrl ?? null,
        // isStale: true means this member left/was removed; still shown in UI but
        // excluded from draw expansion by loadExclusionSet(activeUserIds) at draw time
        isStale: !joinedUserIds.has(m.userId),
      })),
      // activeCount: how many members are still JOINED — UI can warn if < 2
      activeCount: g.members.filter(m => joinedUserIds.has(m.userId)).length,
    })),
  });
}));

// POST /tg/santa/campaigns/:id/exclusions — add exclusion (owner + PRO only)
tgRouter.post('/santa/campaigns/:id/exclusions', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const parsed = z.object({ userId1: z.string().min(1), userId2: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  const ent = await getUserEntitlement(user.id);
  if (!ent.isPro) return res.status(402).json({ error: 'pro_required', feature: 'santa_exclusions' });

  const { userId1, userId2 } = parsed.data;
  // Normalize order to prevent (A,B) and (B,A) both existing
  const [uid1, uid2] = userId1 < userId2 ? [userId1, userId2] : [userId2, userId1];

  try {
    const exclusion = await prisma.santaExclusion.create({ data: { campaignId, userId1: uid1, userId2: uid2 } });
    return res.status(201).json({ exclusion });
  } catch {
    return res.status(409).json({ error: 'Exclusion already exists' });
  }
}));

// DELETE /tg/santa/campaigns/:id/exclusions/:exclusionId — remove exclusion (owner only)
tgRouter.delete('/santa/campaigns/:id/exclusions/:exclusionId', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const exclusionId = req.params.exclusionId ?? '';

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  const exclusion = await prisma.santaExclusion.findUnique({ where: { id: exclusionId } });
  if (!exclusion || exclusion.campaignId !== campaignId) return res.status(404).json({ error: 'Exclusion not found' });

  await prisma.santaExclusion.delete({ where: { id: exclusionId } });
  return res.json({ ok: true });
}));

// ─── Batch 5.1: Group exclusion endpoints ─────────────────────────────────────

// POST /tg/santa/campaigns/:id/exclusions/groups — create named group (owner + PRO)
tgRouter.post('/santa/campaigns/:id/exclusions/groups', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const parsed = z.object({
    label: z.string().min(1).max(60).trim(),
    memberUserIds: z.array(z.string().min(1)).min(2).max(50).optional().default([]),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  const ent = await getUserEntitlement(user.id);
  if (!ent.isPro) return res.status(402).json({ error: 'pro_required', feature: 'santa_exclusion_groups' });

  const group = await prisma.santaExclusionGroup.create({
    data: {
      campaignId,
      label: parsed.data.label,
      members: parsed.data.memberUserIds.length > 0
        ? { create: [...new Set(parsed.data.memberUserIds)].map(uid => ({ userId: uid })) }
        : undefined,
    },
    include: {
      members: {
        include: {
          user: { select: { id: true, firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
        },
      },
    },
  });

  return res.status(201).json({
    group: {
      id: group.id,
      label: group.label,
      members: group.members.map(m => ({
        userId: m.userId,
        displayName: m.user.profile?.displayName || m.user.firstName || m.userId,
        avatarUrl: m.user.profile?.avatarUrl ?? null,
      })),
    },
  });
}));

// PATCH /tg/santa/campaigns/:id/exclusions/groups/:gid — rename group (owner only)
tgRouter.patch('/santa/campaigns/:id/exclusions/groups/:gid', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const gid = req.params.gid ?? '';

  const parsed = z.object({ label: z.string().min(1).max(60).trim() }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  const group = await prisma.santaExclusionGroup.findUnique({ where: { id: gid } });
  if (!group || group.campaignId !== campaignId) return res.status(404).json({ error: 'Group not found' });

  const updated = await prisma.santaExclusionGroup.update({
    where: { id: gid },
    data: { label: parsed.data.label },
  });
  return res.json({ group: { id: updated.id, label: updated.label } });
}));

// DELETE /tg/santa/campaigns/:id/exclusions/groups/:gid — delete group + all members (owner only)
tgRouter.delete('/santa/campaigns/:id/exclusions/groups/:gid', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const gid = req.params.gid ?? '';

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  const group = await prisma.santaExclusionGroup.findUnique({ where: { id: gid } });
  if (!group || group.campaignId !== campaignId) return res.status(404).json({ error: 'Group not found' });

  // Cascade deletes members via FK constraint
  await prisma.santaExclusionGroup.delete({ where: { id: gid } });
  return res.json({ ok: true });
}));

// POST /tg/santa/campaigns/:id/exclusions/groups/:gid/members — add participant to group (owner + PRO only)
tgRouter.post('/santa/campaigns/:id/exclusions/groups/:gid/members', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const gid = req.params.gid ?? '';

  const parsed = z.object({ userId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  const ent = await getUserEntitlement(user.id);
  if (!ent.isPro) return res.status(402).json({ error: 'pro_required', feature: 'santa_exclusion_groups' });

  const group = await prisma.santaExclusionGroup.findUnique({ where: { id: gid } });
  if (!group || group.campaignId !== campaignId) return res.status(404).json({ error: 'Group not found' });

  // Verify userId belongs to a JOINED participant in this campaign
  const participant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: parsed.data.userId, status: 'JOINED' },
  });
  if (!participant) return res.status(404).json({ error: 'Participant not found or not joined' });

  try {
    const member = await prisma.santaExclusionGroupMember.create({
      data: { groupId: gid, userId: parsed.data.userId },
      include: {
        user: { select: { id: true, firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
      },
    });
    return res.status(201).json({
      member: {
        userId: member.userId,
        displayName: member.user.profile?.displayName || member.user.firstName || member.userId,
        avatarUrl: member.user.profile?.avatarUrl ?? null,
      },
    });
  } catch {
    return res.status(409).json({ error: 'already_in_group' });
  }
}));

// DELETE /tg/santa/campaigns/:id/exclusions/groups/:gid/members/:uid — remove member (owner only)
tgRouter.delete('/santa/campaigns/:id/exclusions/groups/:gid/members/:uid', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const gid = req.params.gid ?? '';
  const targetUserId = req.params.uid ?? '';

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  const group = await prisma.santaExclusionGroup.findUnique({ where: { id: gid } });
  if (!group || group.campaignId !== campaignId) return res.status(404).json({ error: 'Group not found' });

  const member = await prisma.santaExclusionGroupMember.findUnique({
    where: { groupId_userId: { groupId: gid, userId: targetUserId } },
  });
  if (!member) return res.status(404).json({ error: 'Member not found in group' });

  await prisma.santaExclusionGroupMember.delete({
    where: { groupId_userId: { groupId: gid, userId: targetUserId } },
  });
  return res.json({ ok: true });
}));

// POST /tg/santa/campaigns/:id/rounds — start next round (owner + all current round terminal)
tgRouter.post('/santa/campaigns/:id/rounds', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: {
      ownerId: true,
      status: true,
      currentRoundId: true,
      rounds: { select: { id: true, roundNumber: true }, orderBy: { roundNumber: 'desc' } },
    },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  // Starting a new round is owner-only — admins cannot start rounds
  if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can start a new round' });
  if (campaign.status !== 'ACTIVE') {
    return res.status(409).json({ error: 'campaign_not_active', message: 'Campaign must be ACTIVE to start next round' });
  }

  // Invariant: at most one PENDING round per campaign
  const existingPending = await prisma.santaRound.findFirst({
    where: { campaignId, drawStatus: 'PENDING' },
  });
  if (existingPending) {
    return res.status(409).json({ error: 'pending_round_exists', message: 'A round is already pending draw. Run the draw first.' });
  }

  // All assignments in current round must be in terminal states
  if (!campaign.currentRoundId) {
    return res.status(409).json({ error: 'no_active_round' });
  }
  const TERMINAL: string[] = ['RECEIVED', 'MISSED_DEADLINE', 'ORPHANED'];
  const blockingAssignments = await prisma.santaAssignment.findMany({
    where: { roundId: campaign.currentRoundId, giftStatus: { notIn: TERMINAL as never[] } },
    select: { id: true, giftStatus: true },
  });
  if (blockingAssignments.length > 0) {
    return res.status(409).json({
      error: 'round_not_complete',
      message: 'All gifts must reach RECEIVED, MISSED_DEADLINE, or ORPHANED before starting next round',
      blocking: blockingAssignments.map(a => ({ id: a.id, giftStatus: a.giftStatus })),
    });
  }

  // Create next round (PENDING)
  const nextRoundNumber = (campaign.rounds[0]?.roundNumber ?? 0) + 1;
  const nextRound = await prisma.santaRound.create({
    data: { campaignId, roundNumber: nextRoundNumber, drawStatus: 'PENDING' },
  });

  // Campaign back to LOCKED (ready to draw); currentRoundId stays pointing to completed round
  await prisma.santaCampaign.update({
    where: { id: campaignId },
    data: { status: 'LOCKED' },
  });

  return res.status(201).json({
    nextRound: { id: nextRound.id, roundNumber: nextRound.roundNumber },
    campaign: { status: 'LOCKED', currentRoundId: campaign.currentRoundId },
  });
}));

// POST /tg/santa/campaigns/:id/complete — force-complete campaign (organizer only, no assignment check)
tgRouter.post('/santa/campaigns/:id/complete', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { ownerId: true, status: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  // Force-complete is owner-only — admins cannot complete campaigns
  if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can complete the campaign' });
  if (campaign.status !== 'ACTIVE') {
    return res.status(409).json({ error: 'campaign_not_active', message: 'Only ACTIVE campaigns can be force-completed' });
  }

  await prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'COMPLETED' } });

  // campaign_completed system message in chat (guaranteed visible to all participants)
  void createSystemMessage(campaignId, 'campaign_completed', {}).catch(() => {});

  return res.json({ ok: true, status: 'COMPLETED' });
}));

// POST /tg/santa/campaigns/:id/gift-status — update gift status (giver only, post-draw)
tgRouter.patch('/santa/campaigns/:id/gift-status', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const parsed = z.object({
    // Accept all Batch-3 selection statuses + legacy BUYING + SENT
    status: z.enum(['BUYING', 'SELECTED_FROM_WISHLIST', 'SELECTED_OUTSIDE', 'DECLINED_TO_SAY', 'SENT']),
    note: z.string().max(300).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' }); // L1

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { status: true, currentRoundId: true } });
  if (!campaign || campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Campaign is not ACTIVE' });
  if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });

  const roundId = campaign.currentRoundId;
  const assignment = await prisma.santaAssignment.findUnique({
    where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
  });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  // Transition validation — SENT and RECEIVED are one-way doors
  const allowedNext = GIVER_ALLOWED_TRANSITIONS[assignment.giftStatus];
  if (!allowedNext) {
    return res.status(409).json({
      error: 'invalid_transition',
      message: `Cannot change gift status from ${assignment.giftStatus}`,
      currentStatus: assignment.giftStatus,
    });
  }
  if (!allowedNext.includes(parsed.data.status)) {
    return res.status(409).json({
      error: 'invalid_transition',
      message: `Transition from ${assignment.giftStatus} to ${parsed.data.status} is not allowed`,
      currentStatus: assignment.giftStatus,
    });
  }

  // When switching away from wishlist-based selection, clear all Santa-flow reservations
  const clearReservationStatuses = ['SELECTED_OUTSIDE', 'DECLINED_TO_SAY', 'SENT'];
  if (clearReservationStatuses.includes(parsed.data.status)) {
    await prisma.santaItemReservation.deleteMany({ where: { assignmentId: assignment.id } });
  }

  const updated = await prisma.santaAssignment.update({
    where: { id: assignment.id },
    data: { giftStatus: parsed.data.status, giftNote: parsed.data.note ?? assignment.giftNote },
    include: {
      receiver: {
        select: {
          linkedWishlistId: true,
          user: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
        },
      },
      santaItemReservations: {
        select: { itemId: true, item: { select: { title: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  await prisma.santaGiftProgress.create({ data: { assignmentId: assignment.id, status: parsed.data.status, note: parsed.data.note } });

  // Return role-aware serialized response — never expose receiverUserId/receiverParticipantId
  const receiverDisplayName = updated.receiver.user.profile?.displayName || updated.receiver.user.firstName || 'Получатель';
  const receiverAvatarUrl = updated.receiver.user.profile?.avatarUrl || null;
  return res.json(serializeAssignment('giver', {
    giftStatus: updated.giftStatus,
    giftNote: updated.giftNote,
    receiver: { displayName: receiverDisplayName, avatarUrl: receiverAvatarUrl, hasLinkedWishlist: !!updated.receiver.linkedWishlistId },
    reservedItems: updated.santaItemReservations.map(r => ({ id: r.itemId, title: r.item.title })),
  }));
}));

// POST /tg/santa/campaigns/:id/confirm-received — receiver confirms gift received
tgRouter.post('/santa/campaigns/:id/confirm-received', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' }); // L1

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { status: true, currentRoundId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!['ACTIVE', 'COMPLETED'].includes(campaign.status)) return res.status(409).json({ error: 'Campaign is not ACTIVE' });
  if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });

  const roundId = campaign.currentRoundId;
  // Receiver addresses via campaign-centric path — NOT assignmentId
  // M1: resolve assignment FIRST — check RECEIVED idempotency before campaign-active gate
  // This ensures a retry after the campaign auto-completes still returns the idempotent success.
  const assignment = await prisma.santaAssignment.findUnique({
    where: { roundId_receiverParticipantId: { roundId, receiverParticipantId: participant.id } },
    select: { id: true, giftStatus: true }, // Only what we need — never select giverParticipantId here
  });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  // Idempotency: already RECEIVED → return success regardless of campaign.status
  if (assignment.giftStatus === 'RECEIVED') return res.json({ ok: true, campaignCompleted: campaign.status === 'COMPLETED', alreadyReceived: true, canReveal: true });
  // Now enforce ACTIVE-only for actual state transition
  if (campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Campaign is not ACTIVE' });

  // Gate: only allowed from SENT (giver must acknowledge they sent before receiver can confirm)
  if (assignment.giftStatus !== 'SENT') {
    return res.status(409).json({
      error: 'gift_not_sent',
      message: 'Receiver can only confirm receipt after the giver marks the gift as sent',
      currentGiftStatus: assignment.giftStatus,
    });
  }

  // Fetch the giver's participantId (needed for notification — never exposed to receiver)
  const fullAssignment = await prisma.santaAssignment.findUnique({
    where: { id: assignment.id },
    select: { giverParticipantId: true, giver: { select: { userId: true } } },
  });

  await prisma.santaAssignment.update({ where: { id: assignment.id }, data: { giftStatus: 'RECEIVED' } });
  await prisma.santaGiftProgress.create({ data: { assignmentId: assignment.id, status: 'RECEIVED' } });

  // Check if all gifts received → complete campaign
  const allAssignments = await prisma.santaAssignment.findMany({ where: { roundId }, select: { id: true, giftStatus: true } });
  // After our update above, re-check: our assignment is now RECEIVED
  // Auto-complete: only for single-round campaigns where all assignments are RECEIVED.
  // Multi-round campaigns (totalRounds > 1) require organizer to explicitly call POST /complete.
  // MISSED_DEADLINE assignments do NOT trigger auto-complete; organizer uses POST /complete.
  const totalRounds = await prisma.santaRound.count({ where: { campaignId } });
  const allReceived = allAssignments.every(a => a.id === assignment.id ? true : a.giftStatus === 'RECEIVED');
  if (allReceived && totalRounds === 1) {
    await prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'COMPLETED' } });
    // campaign_completed system message in chat
    void createSystemMessage(campaignId, 'campaign_completed', {}).catch(() => {});
  }

  // Notifications (best-effort, non-blocking) — deduped by DB partial unique index
  if (fullAssignment) {
    const giverUserId = fullAssignment.giver.userId;
    // GIFT_RECEIVED → giver: "your recipient received your gift!" (once per assignment)
    void prisma.santaNotification.create({
      data: { campaignId, userId: giverUserId, type: 'GIFT_RECEIVED', payload: { assignmentId: assignment.id }, dedupeKey: `gift:${assignment.id}` },
    }).catch(() => { /* duplicate suppressed by dedupeKey unique index */ });

    // REVEAL_UNLOCKED → receiver: "you can now see who your Secret Santa was!" (once per assignment)
    void prisma.santaNotification.create({
      data: { campaignId, userId: user.id, type: 'REVEAL_UNLOCKED', payload: { assignmentId: assignment.id }, dedupeKey: `reveal:${assignment.id}` },
    }).catch(() => { /* duplicate suppressed by dedupeKey unique index */ });
  }

  return res.json({ ok: true, campaignCompleted: allReceived, canReveal: true });
}));

// ─── Santa — inbound (receiver-centric, post-draw) ────────────────────────────

// GET /tg/santa/campaigns/:id/inbound/wishlist — giver gets receiver's wishlist items
// Returns items with reservedByMe flag + myReservations summary for the dedicated wishlist screen.
tgRouter.get('/santa/campaigns/:id/inbound/wishlist', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const participant = await prisma.santaParticipant.findUnique({ where: { campaignId_userId: { campaignId, userId: user.id } } });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { status: true, currentRoundId: true } });
  if (!campaign || campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Campaign not ACTIVE' });
  if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });

  const roundId = campaign.currentRoundId;
  const assignment = await prisma.santaAssignment.findUnique({
    where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
    include: {
      receiver: { select: { linkedWishlistId: true, user: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } } } },
      santaItemReservations: { select: { itemId: true, item: { select: { title: true } } }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const receiverWishlistId = assignment.receiver.linkedWishlistId;
  // Receiver display name visible to giver: only display name or first name — no userId, no participantId
  const receiverDisplayName = assignment.receiver.user.profile?.displayName || assignment.receiver.user.firstName || 'Получатель';
  const receiverAvatarUrl = assignment.receiver.user.profile?.avatarUrl || null;

  const myReservedItemIds = new Set(assignment.santaItemReservations.map(r => r.itemId));
  const myReservations = assignment.santaItemReservations.map(r => ({ id: r.itemId, title: r.item.title }));

  const giverView = serializeAssignment('giver', {
    giftStatus: assignment.giftStatus,
    giftNote: assignment.giftNote,
    receiver: { displayName: receiverDisplayName, avatarUrl: receiverAvatarUrl, hasLinkedWishlist: !!receiverWishlistId },
    reservedItems: myReservations,
  });

  if (!receiverWishlistId) return res.json({ ...giverView, wishlist: null, items: [], myReservations });

  const items = await prisma.item.findMany({
    where: { wishlistId: receiverWishlistId, status: { in: ['AVAILABLE', 'RESERVED', 'PURCHASED'] } },
    orderBy: ITEM_ORDER_BY,
    select: { id: true, title: true, url: true, priceText: true, currency: true, priority: true, imageUrl: true, status: true, description: true },
  });
  const wishlist = await prisma.wishlist.findUnique({ where: { id: receiverWishlistId }, select: { title: true } });

  // Annotate items with reservedByMe flag — never expose reserver identity for items NOT reserved by this giver
  const annotatedItems = items.map(item => ({
    ...item,
    reservedByMe: myReservedItemIds.has(item.id),
    // For items reserved by others (status=RESERVED) but NOT by this giver, only expose the status flag
    // No reserver identity is ever returned
  }));

  return res.json({ ...giverView, wishlist: wishlist ? { title: wishlist.title } : null, items: annotatedItems, myReservations });
}));

// POST /tg/santa/campaigns/:id/inbound/reserve — giver reserves a wishlist item (Santa-flow)
// Creates SantaItemReservation and auto-syncs gift status to SELECTED_FROM_WISHLIST.
tgRouter.post('/santa/campaigns/:id/inbound/reserve', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const parsed = z.object({ itemId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);
  const { itemId } = parsed.data;

  const participant = await prisma.santaParticipant.findUnique({ where: { campaignId_userId: { campaignId, userId: user.id } } });
  if (!participant || participant.status !== 'JOINED') {
    console.error('[reserve] 403 not participant', { campaignId, userId: user.id, status: participant?.status });
    return res.status(403).json({ error: 'Not a participant' });
  }

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { status: true, currentRoundId: true } });
  if (!campaign || campaign.status !== 'ACTIVE') {
    console.error('[reserve] 409 campaign not ACTIVE', { campaignId, status: campaign?.status });
    return res.status(409).json({ error: 'Campaign not ACTIVE', message: `Campaign status is ${campaign?.status ?? 'not found'}` });
  }
  if (!campaign.currentRoundId) {
    console.error('[reserve] 404 no active round', { campaignId });
    return res.status(404).json({ error: 'No active round' });
  }

  const roundId = campaign.currentRoundId;
  const assignment = await prisma.santaAssignment.findUnique({
    where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
    select: { id: true, giftStatus: true, receiver: { select: { linkedWishlistId: true } } },
  });
  if (!assignment) {
    console.error('[reserve] 404 assignment not found', { roundId, participantId: participant.id });
    return res.status(404).json({ error: 'Assignment not found' });
  }

  // Terminal states: cannot reserve after SENT/RECEIVED
  if (['SENT', 'RECEIVED'].includes(assignment.giftStatus)) {
    return res.status(409).json({ error: 'invalid_state', message: `Cannot reserve items when gift status is ${assignment.giftStatus}` });
  }

  // Validate item belongs to receiver's wishlist
  const receiverWishlistId = assignment.receiver.linkedWishlistId;
  if (!receiverWishlistId) {
    console.error('[reserve] 409 receiver has no wishlist', { assignmentId: assignment.id });
    return res.status(409).json({ error: 'receiver_no_wishlist', message: 'Receiver has no linked wishlist' });
  }

  const item = await prisma.item.findFirst({
    where: { id: itemId, wishlistId: receiverWishlistId, status: { in: ['AVAILABLE', 'RESERVED', 'PURCHASED'] } },
    select: { id: true, title: true },
  });
  if (!item) {
    console.error('[reserve] 404 item not found', { itemId, receiverWishlistId });
    return res.status(404).json({ error: 'Item not found or not reservable' });
  }

  // Create reservation — explicit create+catch for idempotency (avoids upsert with empty update which can be unreliable)
  try {
    await prisma.santaItemReservation.create({ data: { assignmentId: assignment.id, itemId } });
  } catch (e: unknown) {
    // P2002 = unique constraint violation — item already reserved by this assignment (idempotent)
    const prismaErr = e as { code?: string };
    if (prismaErr.code !== 'P2002') throw e;
  }

  // Auto-sync gift status to SELECTED_FROM_WISHLIST if not already in a committed state
  const syncableStatuses = ['PENDING', 'BUYING', 'MISSED_DEADLINE', 'SELECTED_OUTSIDE', 'DECLINED_TO_SAY'];
  if (syncableStatuses.includes(assignment.giftStatus)) {
    await prisma.santaAssignment.update({
      where: { id: assignment.id },
      data: { giftStatus: 'SELECTED_FROM_WISHLIST' },
    });
    await prisma.santaGiftProgress.create({ data: { assignmentId: assignment.id, status: 'SELECTED_FROM_WISHLIST' } });
  }

  // Return updated reservation list
  const reservations = await prisma.santaItemReservation.findMany({
    where: { assignmentId: assignment.id },
    select: { itemId: true, item: { select: { title: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return res.json({
    ok: true,
    reservedItemIds: reservations.map(r => r.itemId),
    myReservations: reservations.map(r => ({ id: r.itemId, title: r.item.title })),
  });
}));

// DELETE /tg/santa/campaigns/:id/inbound/reserve/:itemId — giver removes a wishlist reservation
// Auto-syncs gift status back to PENDING if no reservations remain.
tgRouter.delete('/santa/campaigns/:id/inbound/reserve/:itemId', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const itemId = req.params.itemId ?? '';
  if (!itemId) return res.status(400).json({ error: 'Missing itemId' });

  const participant = await prisma.santaParticipant.findUnique({ where: { campaignId_userId: { campaignId, userId: user.id } } });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { status: true, currentRoundId: true } });
  if (!campaign || campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Campaign not ACTIVE' });
  if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });

  const roundId = campaign.currentRoundId;
  const assignment = await prisma.santaAssignment.findUnique({
    where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
    select: { id: true, giftStatus: true },
  });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  // Delete reservation (idempotent — no error if not found)
  await prisma.santaItemReservation.deleteMany({
    where: { assignmentId: assignment.id, itemId },
  });

  // Count remaining reservations
  const remainingCount = await prisma.santaItemReservation.count({ where: { assignmentId: assignment.id } });

  // Auto-sync: if no reservations remain AND status is SELECTED_FROM_WISHLIST → revert to PENDING
  if (remainingCount === 0 && assignment.giftStatus === 'SELECTED_FROM_WISHLIST') {
    await prisma.santaAssignment.update({
      where: { id: assignment.id },
      data: { giftStatus: 'PENDING' },
    });
    await prisma.santaGiftProgress.create({ data: { assignmentId: assignment.id, status: 'PENDING' } });
  }

  // Return updated reservation list
  const reservations = await prisma.santaItemReservation.findMany({
    where: { assignmentId: assignment.id },
    select: { itemId: true, item: { select: { title: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return res.json({
    ok: true,
    reservedItemIds: reservations.map(r => r.itemId),
    myReservations: reservations.map(r => ({ id: r.itemId, title: r.item.title })),
  });
}));

// GET /tg/santa/campaigns/:id/inbound/status — receiver gets their inbound gift signal
// Role: receiver only. Returns COARSE signal WITHOUT giver identity. Campaign-centric addressing.
// Batch 3: returns semantic signal + canConfirmReceived + canReveal flags. Raw giftStatus never exposed.
tgRouter.get('/santa/campaigns/:id/inbound/status', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { status: true, currentRoundId: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!['ACTIVE', 'COMPLETED'].includes(campaign.status)) {
    return res.json({ hasGiver: false, signal: 'waiting', canConfirmReceived: false, canReveal: false, campaignStatus: campaign.status });
  }
  if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });

  const roundId = campaign.currentRoundId;
  // Resolve via receiver side — campaign-centric, NOT assignment-id-centric
  const assignment = await prisma.santaAssignment.findUnique({
    where: { roundId_receiverParticipantId: { roundId, receiverParticipantId: participant.id } },
    // ONLY giftStatus + revealedAt — no giverParticipantId EVER exposed to receiver
    select: { giftStatus: true, revealedAt: true },
  });
  if (!assignment) return res.json({ hasGiver: false, signal: 'waiting', canConfirmReceived: false, canReveal: false });

  const signal = giftStatusToInboundSignal(assignment.giftStatus);
  return res.json({
    hasGiver: true,
    signal,
    canConfirmReceived: assignment.giftStatus === 'SENT',
    canReveal: assignment.giftStatus === 'RECEIVED',
    // revealedAt tells the frontend whether reveal was already viewed (no re-animation)
    revealedAt: assignment.revealedAt?.toISOString() ?? null,
  });
}));

// GET /tg/santa/campaigns/:id/assignment — giver's own assignment summary (role-aware)
tgRouter.get('/santa/campaigns/:id/assignment', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { ownerId: true, status: true, currentRoundId: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const isOwner = campaign.ownerId === user.id;

  if (!['ACTIVE', 'COMPLETED'].includes(campaign.status)) {
    return res.json({ status: campaign.status, ready: false });
  }
  if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });
  const roundId = campaign.currentRoundId;

  // Owner: return aggregate progress only
  if (isOwner) {
    const allAssignments = await prisma.santaAssignment.findMany({
      where: { roundId },
      select: { giftStatus: true },
    });
    // Count receivers (participants) without a linked wishlist for owner context
    const participantsWithoutWishlist = await prisma.santaParticipant.count({
      where: { campaignId, status: 'JOINED', linkedWishlistId: null },
    });
    return res.json({ ready: true, ...serializeAssignment('owner', { assignments: allAssignments, receiverWithoutWishlistCount: participantsWithoutWishlist }) });
  }

  // Giver view
  const giverAssignment = await prisma.santaAssignment.findUnique({
    where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
    select: {
      giftStatus: true,
      giftNote: true,
      receiver: {
        select: {
          linkedWishlistId: true,
          user: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
        },
      },
    },
  });
  if (!giverAssignment) return res.json({ ready: false, role: 'giver' });

  const receiverDisplayName = giverAssignment.receiver.user.profile?.displayName
    || giverAssignment.receiver.user.firstName || 'Получатель';
  const receiverAvatarUrl = giverAssignment.receiver.user.profile?.avatarUrl || null;

  return res.json({
    ready: true,
    ...serializeAssignment('giver', {
      giftStatus: giverAssignment.giftStatus,
      giftNote: giverAssignment.giftNote,
      receiver: {
        displayName: receiverDisplayName,
        avatarUrl: receiverAvatarUrl,
        hasLinkedWishlist: !!giverAssignment.receiver.linkedWishlistId,
      },
    }),
  });
}));

// GET /tg/santa/campaigns/:id/reveal — receiver reveals their Secret Santa identity
// Batch 3: gate is per-receiver RECEIVED (NOT campaign COMPLETED). Tracks revealedAt on first view.
// ANONYMITY: giver identity ONLY exposed after receiver's own giftStatus === RECEIVED.
tgRouter.get('/santa/campaigns/:id/reveal', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { status: true, currentRoundId: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!['ACTIVE', 'COMPLETED'].includes(campaign.status)) {
    return res.status(409).json({ error: 'reveal_not_available', campaignStatus: campaign.status });
  }
  if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });
  const roundId = campaign.currentRoundId;

  // Receiver-side lookup — assignment is resolved from the receiver's participant record
  const receiverAssignment = await prisma.santaAssignment.findUnique({
    where: { roundId_receiverParticipantId: { roundId, receiverParticipantId: participant.id } },
    select: {
      id: true,
      giftStatus: true,
      revealedAt: true,
      giftNote: true,
      giver: {
        select: {
          user: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
        },
      },
    },
  });

  if (!receiverAssignment) {
    return res.status(409).json({ error: 'reveal_not_available', reason: 'no_assignment' });
  }

  // Gate: receiver must have confirmed RECEIVED — personal reveal, not campaign-level
  if (receiverAssignment.giftStatus !== 'RECEIVED') {
    return res.status(409).json({
      error: 'reveal_not_available',
      reason: 'gift_not_received',
      signal: giftStatusToInboundSignal(receiverAssignment.giftStatus),
    });
  }

  // Track first reveal view — best-effort, non-blocking
  const isFirstReveal = !receiverAssignment.revealedAt;
  if (isFirstReveal) {
    await prisma.santaAssignment.update({
      where: { id: receiverAssignment.id },
      data: { revealedAt: new Date() },
    }).catch(() => { /* non-fatal — revealedAt is cosmetic tracking */ });
  }

  const giverName = receiverAssignment.giver.user.profile?.displayName
    || receiverAssignment.giver.user.firstName || 'Санта';
  const giverAvatarUrl = receiverAssignment.giver.user.profile?.avatarUrl || null;

  return res.json({
    revealed: true,
    isFirstReveal,
    giver: {
      displayName: giverName,
      avatarUrl: giverAvatarUrl,
      // giverUserId deliberately omitted — only display layer exposed
    },
    // Return giftNote if the giver left one (adds warmth to the reveal moment)
    giftNote: receiverAssignment.giftNote ?? null,
    revealedAt: receiverAssignment.revealedAt?.toISOString() ?? new Date().toISOString(),
  });
}));

// ─── Santa Hints (Batch 2.5) ──────────────────────────────────────────────────

const SANTA_HINT_TTL_HOURS = 48;
const SANTA_HINT_MAX_ITEMS = 3;

// Serializer: giver side — exposes selection results, NEVER receiver identity
type SantaHintForGiver = {
  id: string;
  status: string;
  requestedAt: string;
  expiresAt: string;
  fulfilledAt: string | null;
  // null until FULFILLED; array of item shapes after receiver selects
  selectedItems: { id: string; title: string; priceText: string | null; url: string | null }[] | null;
};

function serializeSantaHintForGiver(
  hint: { id: string; status: string; requestedAt: Date; expiresAt: Date; fulfilledAt: Date | null; selectedItemIds: unknown },
  itemsMap?: Map<string, { id: string; title: string; priceText: string | null; url: string | null }>,
): SantaHintForGiver {
  let selectedItems: { id: string; title: string; priceText: string | null; url: string | null }[] | null = null;
  if (hint.status === 'FULFILLED' && Array.isArray(hint.selectedItemIds)) {
    selectedItems = (hint.selectedItemIds as string[])
      .map(id => itemsMap?.get(id))
      .filter((item): item is { id: string; title: string; priceText: string | null; url: string | null } => item !== undefined);
  }
  return {
    id: hint.id,
    status: hint.status,
    requestedAt: hint.requestedAt.toISOString(),
    expiresAt: hint.expiresAt.toISOString(),
    fulfilledAt: hint.fulfilledAt?.toISOString() ?? null,
    selectedItems,
    // ⚠ receiverParticipantId / receiverUserId deliberately omitted — anonymity contract
  };
}

// Serializer: receiver side — exposes request metadata, NEVER giver identity
type SantaHintInboundForReceiver = {
  hasPendingHint: boolean;
  hint: { id: string; status: string; requestedAt: string; expiresAt: string } | null;
};

function serializeSantaHintInboundForReceiver(
  hint: { id: string; status: string; requestedAt: Date; expiresAt: Date } | null,
): SantaHintInboundForReceiver {
  if (!hint) return { hasPendingHint: false, hint: null };
  return {
    hasPendingHint: hint.status === 'PENDING',
    hint: {
      id: hint.id,
      status: hint.status,
      requestedAt: hint.requestedAt.toISOString(),
      expiresAt: hint.expiresAt.toISOString(),
      // ⚠ giverParticipantId / giverUserId deliberately omitted — anonymity contract
    },
  };
}

// POST /tg/santa/campaigns/:id/hints — giver requests a hint (idempotent; PRO-gated)
tgRouter.post('/santa/campaigns/:id/hints', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  // 1. Participant lookup
  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

  // 2. Campaign must be ACTIVE
  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { status: true, currentRoundId: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'campaign_not_active', message: 'Hint requests can only be sent in ACTIVE campaigns' });
  if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });
  const roundId = campaign.currentRoundId;

  // 3. PRO-gate: only giver's effective plan is checked — receiver's plan is irrelevant
  const ent = await getUserEntitlement(user.id, user.godMode);
  if (!ent.isPro) return res.status(403).json({ error: 'pro_required', message: 'Hint requests require a Pro subscription' });

  // 4. Resolve giver's assignment (giver-centric: roundId + giverParticipantId)
  const assignment = await prisma.santaAssignment.findUnique({
    where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
    select: { id: true, receiverParticipantId: true, receiver: { select: { linkedWishlistId: true } } },
  });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  // 5. Receiver must have a linked wishlist — no point in requesting a hint otherwise
  if (!assignment.receiver.linkedWishlistId) {
    return res.status(409).json({ error: 'receiver_no_wishlist', message: 'Your gift recipient has no linked wishlist' });
  }

  // 6. Idempotency: if PENDING hint already exists for this assignment, return it (don't duplicate)
  const existing = await prisma.santaHintRequest.findFirst({
    where: { assignmentId: assignment.id, status: 'PENDING' },
  });
  if (existing) {
    return res.status(200).json(serializeSantaHintForGiver(existing));
  }

  // 7. Create hint request with 48h TTL
  const expiresAt = new Date(Date.now() + SANTA_HINT_TTL_HOURS * 60 * 60 * 1000);
  const hint = await prisma.santaHintRequest.create({
    data: {
      campaignId,
      roundId,
      assignmentId: assignment.id,
      giverParticipantId: participant.id,
      receiverParticipantId: assignment.receiverParticipantId,
      status: 'PENDING',
      expiresAt,
    },
  });

  // Notification to receiver is sent by the TTL/polling loop or bot layer.
  // notificationSentAt is set by the notification sender — not here — to allow dedup on retry.

  return res.status(201).json(serializeSantaHintForGiver(hint));
}));

// GET /tg/santa/campaigns/:id/hints — giver polls hint status (includes fulfilled item preview)
tgRouter.get('/santa/campaigns/:id/hints', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { status: true, currentRoundId: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!['ACTIVE', 'COMPLETED'].includes(campaign.status)) return res.status(409).json({ error: 'Campaign not ACTIVE or COMPLETED' });
  if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });
  const roundId = campaign.currentRoundId;

  // Giver-centric assignment lookup
  const assignment = await prisma.santaAssignment.findUnique({
    where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
    select: { id: true },
  });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  // Most recent hint for this assignment (draw reset via cascade-delete clears old hints)
  const hint = await prisma.santaHintRequest.findFirst({
    where: { assignmentId: assignment.id },
    orderBy: { requestedAt: 'desc' },
  });
  if (!hint) return res.json({ hint: null });

  // Resolve item details for FULFILLED hints
  let itemsMap: Map<string, { id: string; title: string; priceText: string | null; url: string | null }> | undefined;
  if (hint.status === 'FULFILLED' && Array.isArray(hint.selectedItemIds) && hint.selectedItemIds.length > 0) {
    const ids = hint.selectedItemIds as string[];
    const items = await prisma.item.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true, priceText: true, url: true },
    });
    itemsMap = new Map(items.map(i => [i.id, i]));
  }

  return res.json({ hint: serializeSantaHintForGiver(hint, itemsMap) });
}));

// GET /tg/santa/campaigns/:id/inbound/hint — receiver checks for pending hint request
// Role: receiver only. Anonymity: NEVER exposes giverParticipantId or giverUserId.
tgRouter.get('/santa/campaigns/:id/inbound/hint', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { status: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Campaign not ACTIVE' });

  // Campaign-centric receiver lookup — receiverParticipantId, never assignmentId
  // Returns the most recently created PENDING hint (there should be at most one per assignment,
  // but we guard against duplicates by taking the latest)
  const hint = await prisma.santaHintRequest.findFirst({
    where: { campaignId, receiverParticipantId: participant.id, status: 'PENDING' },
    orderBy: { requestedAt: 'desc' },
  });

  return res.json(serializeSantaHintInboundForReceiver(hint));
}));

// POST /tg/santa/campaigns/:id/inbound/hint/fulfill — receiver selects 1–3 items, marks hint FULFILLED
tgRouter.post('/santa/campaigns/:id/inbound/hint/fulfill', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const parsed = z.object({
    hintId: z.string().min(1),
    selectedItemIds: z.array(z.string().min(1)).min(1).max(SANTA_HINT_MAX_ITEMS),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });

  const { hintId, selectedItemIds } = parsed.data;

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
    select: { id: true, status: true, linkedWishlistId: true },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { status: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Campaign not ACTIVE' });

  // Fetch hint — must belong to this receiver and be PENDING
  const hint = await prisma.santaHintRequest.findUnique({
    where: { id: hintId },
    select: { id: true, campaignId: true, receiverParticipantId: true, status: true, expiresAt: true },
  });
  if (!hint) return res.status(404).json({ error: 'Hint not found' });
  // Verify ownership (campaignId + receiverParticipantId) — never trust hintId alone
  if (hint.campaignId !== campaignId) return res.status(404).json({ error: 'Hint not found' });
  if (hint.receiverParticipantId !== participant.id) return res.status(403).json({ error: 'Forbidden' });
  if (hint.status !== 'PENDING') return res.status(409).json({ error: 'hint_not_pending', message: `Hint status is ${hint.status}` });
  if (hint.expiresAt <= new Date()) return res.status(409).json({ error: 'hint_expired', message: 'Hint TTL exceeded; request a new one' });

  // Receiver must have a linked wishlist to select from
  if (!participant.linkedWishlistId) {
    return res.status(409).json({ error: 'no_linked_wishlist', message: 'Link a wishlist to your Secret Santa profile first' });
  }

  // Validate: all selectedItemIds must belong to receiver's current linked wishlist and be AVAILABLE
  // This guards against stale selections (wishlist changed between request and fulfill)
  const validItems = await prisma.item.findMany({
    where: { id: { in: selectedItemIds }, wishlistId: participant.linkedWishlistId, status: 'AVAILABLE' },
    select: { id: true },
  });
  if (validItems.length !== selectedItemIds.length) {
    return res.status(400).json({
      error: 'invalid_items',
      message: 'Some selected items are not available in your linked wishlist',
    });
  }

  // Mark FULFILLED
  await prisma.santaHintRequest.update({
    where: { id: hintId },
    data: { status: 'FULFILLED', selectedItemIds, fulfilledAt: new Date() },
  });

  // Notify giver — deduped via notificationSentAt on the hint record (handled by bot polling layer)

  return res.json({ ok: true });
}));

// ─── Maintenance mode middleware ──────────────────────────────────────────────
// When MAINTENANCE_MODE=true, block /tg/* and /public/* with 503 + code=MAINTENANCE.
// /health, /health/deep, /uploads, /internal remain accessible.
app.use(['/tg', '/public'], (req: Request, res: Response, next: NextFunction) => {
  if ((process.env.MAINTENANCE_MODE ?? '').toLowerCase() === 'true') {
    return res.status(503).json({ error: 'Service temporarily unavailable', code: 'MAINTENANCE' });
  }
  return next();
});

// ─── Mount routers ───────────────────────────────────────────────────────────

app.use('/public', publicRouter);
app.use('/tg', tgRouter);
app.use('/internal', internalRouter);
app.use(privateRouter);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // Multer errors (file too large, wrong type, etc.)
  if (err && typeof err === 'object' && 'code' in err) {
    const multerErr = err as { code: string; message: string };
    if (multerErr.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: t('item_photo_too_large', getRequestLocale(_req)) });
    }
    if (multerErr.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Unexpected field name. Use "photo".' });
    }
  }
  if (err instanceof Error && err.message.startsWith('Unsupported file type')) {
    return res.status(415).json({ error: err.message });
  }

  // eslint-disable-next-line no-console
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
});

// TTL cleanup for expired comments (runs every hour)
setInterval(async () => {
  try {
    const result = await prisma.comment.deleteMany({
      where: { scheduledDeleteAt: { lte: new Date() } },
    });
    if (result.count > 0) {
      // eslint-disable-next-line no-console
      console.log(`[ttl] cleaned ${result.count} expired comments`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[ttl] cleanup failed', err);
  }
}, 60 * 60 * 1000);

// Archive purge: hard-delete items past 90-day TTL + cleanup media files (hourly)
setInterval(async () => {
  try {
    const expired = await prisma.item.findMany({
      where: { purgeAfter: { lte: new Date() } },
      select: { id: true, imageUrl: true },
      take: 100, // batch limit — rest picked up next hour
    });
    if (expired.length === 0) return;

    // eslint-disable-next-line no-console
    console.log(`[purge] found ${expired.length} expired archive items`);
    let deleted = 0, files = 0, errors = 0;

    for (const item of expired) {
      try {
        // DB first, files second — orphaned files are harmless, orphaned DB records with broken images are not
        await prisma.item.delete({ where: { id: item.id } });
        deleted++;
        if (item.imageUrl) {
          deleteUploadFile(item.imageUrl);
          files++;
        }
      } catch (err) {
        errors++;
        // eslint-disable-next-line no-console
        console.error(`[purge] item ${item.id}:`, err);
      }
    }

    // eslint-disable-next-line no-console
    console.log(`[purge] done: ${deleted} deleted, ${files} files cleaned, ${errors} errors`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[purge] job failed:', err);
  }
}, 60 * 60 * 1000);

// Subscription expiry: mark overdue subscriptions as EXPIRED (hourly)
setInterval(async () => {
  try {
    const expired = await prisma.subscription.updateMany({
      where: {
        status: { in: ['ACTIVE', 'CANCELLED'] },
        currentPeriodEnd: { lte: new Date() },
      },
      data: { status: 'EXPIRED' },
    });
    if (expired.count > 0) {
      // eslint-disable-next-line no-console
      console.log(`[billing] expired ${expired.count} subscriptions`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[billing] expiry check failed:', err);
  }
}, 60 * 60 * 1000);

// Santa hint expiry: mark PENDING santa hint requests past their TTL as EXPIRED (hourly)
setInterval(async () => {
  try {
    const expired = await prisma.santaHintRequest.updateMany({
      where: { status: 'PENDING', expiresAt: { lte: new Date() } },
      data: { status: 'EXPIRED' },
    });
    if (expired.count > 0) {
      // eslint-disable-next-line no-console
      console.log(`[santa-hints] expired ${expired.count} hint requests`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[santa-hints] expiry check failed:', err);
  }
}, 60 * 60 * 1000);

// Santa deadline enforcement: mark overdue PENDING/BUYING assignments as MISSED_DEADLINE (hourly)
// Recoverable: giver can still update their status after missing the deadline.
setInterval(async () => {
  try {
    const now = new Date();
    // Find rounds belonging to ACTIVE campaigns whose drawAt has passed
    const overdueRounds = await prisma.santaRound.findMany({
      where: {
        campaign: { status: 'ACTIVE', drawAt: { lte: now, not: null } },
        drawStatus: 'DONE',
      },
      select: { id: true, campaignId: true },
    });
    if (overdueRounds.length === 0) return;

    let totalMissed = 0;
    for (const round of overdueRounds) {
      // Find assignments still in actionable but uncommitted states
      const overdueAssignments = await prisma.santaAssignment.findMany({
        where: { roundId: round.id, giftStatus: { in: ['PENDING', 'BUYING'] } },
        select: { id: true, giver: { select: { userId: true } } },
      });
      if (overdueAssignments.length === 0) continue;

      // Bulk update — MISSED_DEADLINE is recoverable (giver can still pick a status)
      await prisma.santaAssignment.updateMany({
        where: { id: { in: overdueAssignments.map(a => a.id) } },
        data: { giftStatus: 'MISSED_DEADLINE' },
      });
      totalMissed += overdueAssignments.length;

      // Create DEADLINE_MISSED notifications — batch insert, deduped per assignment
      await prisma.santaNotification.createMany({
        data: overdueAssignments.map(a => ({
          campaignId: round.campaignId,
          userId: a.giver.userId,
          type: 'DEADLINE_MISSED' as const,
          payload: { assignmentId: a.id },
          dedupeKey: `missed:${a.id}`,   // unique per (user, DEADLINE_MISSED, assignment)
        })),
        skipDuplicates: true,
      }).catch(() => { /* non-fatal */ });
    }

    if (totalMissed > 0) {
      // eslint-disable-next-line no-console
      console.log(`[santa-deadlines] marked ${totalMissed} assignments as MISSED_DEADLINE`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[santa-deadlines] missed-deadline job failed:', err);
  }
}, 60 * 60 * 1000);

// Santa deadline warning: notify PENDING/BUYING givers ~3 days before drawAt (hourly check)
// Warning window: between 72h and 96h before drawAt (fires once per ~day, not every hour).
setInterval(async () => {
  try {
    const now = new Date();
    const warningWindowStart = new Date(now.getTime() + 72 * 60 * 60 * 1000);  // 3 days from now
    const warningWindowEnd   = new Date(now.getTime() + 96 * 60 * 60 * 1000);  // 4 days from now

    const warningRounds = await prisma.santaRound.findMany({
      where: {
        campaign: {
          status: 'ACTIVE',
          drawAt: { gte: warningWindowStart, lte: warningWindowEnd },
        },
        drawStatus: 'DONE',
      },
      select: { id: true, campaignId: true },
    });
    if (warningRounds.length === 0) return;

    let totalWarned = 0;
    for (const round of warningRounds) {
      const pendingAssignments = await prisma.santaAssignment.findMany({
        where: { roundId: round.id, giftStatus: { in: ['PENDING', 'BUYING'] } },
        select: { id: true, giver: { select: { userId: true } } },
      });
      if (pendingAssignments.length === 0) continue;

      // Batch insert DEADLINE_WARNING — deduped per assignment via dedupeKey; no findFirst needed
      const warnResult = await prisma.santaNotification.createMany({
        data: pendingAssignments.map(a => ({
          campaignId: round.campaignId,
          userId: a.giver.userId,
          type: 'DEADLINE_WARNING' as const,
          payload: { assignmentId: a.id },
          dedupeKey: `warn:${a.id}`,    // unique per (user, DEADLINE_WARNING, assignment)
        })),
        skipDuplicates: true,
      }).catch(() => ({ count: 0 }));
      totalWarned += warnResult.count;
    }

    if (totalWarned > 0) {
      // eslint-disable-next-line no-console
      console.log(`[santa-deadlines] sent DEADLINE_WARNING to ${totalWarned} givers`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[santa-deadlines] deadline-warning job failed:', err);
  }
}, 60 * 60 * 1000);

// ─── Santa seasonal broadcasts ───────────────────────────────────────────────

/**
 * Send a seasonal broadcast Telegram message to every user who has a telegramChatId.
 * Deduplication is handled by SantaSeasonalBroadcastLog — inserting the log row acts as a
 * distributed lock: if the row already exists (unique constraint), this function exits
 * immediately.  Safe to call concurrently or in a crash-restart scenario.
 *
 * @param type        'PROMO' (sent Nov 1) or 'CLOSING_SOON' (sent Feb 1)
 * @param seasonYear  The November-start year of the season (e.g. 2026 for Nov 2026 → Feb 2027)
 */
async function sendSeasonalBroadcast(type: 'PROMO' | 'CLOSING_SOON', seasonYear: number): Promise<void> {
  // Insert log row FIRST — acts as an atomic write-once lock.
  // Unique constraint on (year, type) means only the first caller proceeds; all others exit.
  try {
    await prisma.santaSeasonalBroadcastLog.create({
      data: { year: seasonYear, type },
    });
  } catch {
    // UniqueConstraintViolation = already sent (or concurrent runner beat us). Skip.
    return;
  }

  const BATCH      = 25;   // users per DB page
  const PAUSE_MS   = 1200; // ~20 req/s; Telegram allows 30 req/s per bot

  // RU + EN in one message — we don't store per-user locale, so serve both languages.
  const textRu = type === 'PROMO'
    ? '🎅 Тайный Санта скоро открывается! Подготовьте вишлист — обмен подарками начнётся 15 ноября.'
    : '⏰ Тайный Санта закроется 15 февраля. Успейте завершить обмен подарками!';
  const textEn = type === 'PROMO'
    ? '🎅 Secret Santa is opening soon! Prepare your wishlist — the gift exchange starts November 15.'
    : '⏰ Secret Santa closes on February 15. Make sure to finish your gift exchange!';
  const text = `${textRu}\n\n${textEn}`;

  let cursor: string | undefined;
  let totalSent = 0;

  // eslint-disable-next-line no-constant-condition
  for (;;) {
    const users = await prisma.user.findMany({
      where:   { telegramChatId: { not: null } },
      select:  { id: true, telegramChatId: true },
      take:    BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
    });

    if (users.length === 0) break;

    for (const u of users) {
      if (!u.telegramChatId) continue;
      await sendTgNotification(u.telegramChatId, text);
      totalSent++;
    }

    cursor = users[users.length - 1]!.id;
    if (users.length < BATCH) break;
    await new Promise<void>(r => setTimeout(r, PAUSE_MS));
  }

  // Record final count for audit trail
  await prisma.santaSeasonalBroadcastLog.update({
    where: { year_type: { year: seasonYear, type } },
    data:  { userCount: totalSent },
  }).catch(() => { /* non-fatal */ });

  // eslint-disable-next-line no-console
  console.log(`[santa-season] broadcast ${type} for season ${seasonYear} sent to ${totalSent} users`);
  void sendAdminAlert(`🎅 Santa broadcast <b>${type}</b> (season ${seasonYear}) sent to <b>${totalSent}</b> users`);
}

/**
 * Idempotent seasonal event handler — runs hourly, triggers broadcasts on calendar milestones.
 *
 * Triggers:
 *   Nov 1  → PROMO broadcast for this year's upcoming season
 *   Feb 1  → CLOSING_SOON broadcast for the season that started last November
 *
 * Deduplication via SantaSeasonalBroadcastLog ensures each broadcast fires exactly once per year,
 * regardless of restarts, multi-instance deployments, or the hourly tick firing multiple times
 * on the same day.
 */
async function maybeRunSeasonalEvents(): Promise<void> {
  try {
    // Abort if the feature is globally disabled
    const globalConfig = await prisma.santaGlobalConfig.findUnique({ where: { id: 'global' } });
    if (!globalConfig?.santaEnabled) return;

    const now        = new Date();
    const seasonYear = getSeasonStartYear(now); // canonical season key (Nov-year); handles cross-year boundary
    const month      = now.getMonth() + 1;
    const day        = now.getDate();

    // ── November 1: promo notification ──────────────────────────────────────
    // Nov 1, 2026 → seasonYear = getSeasonStartYear = 2026 (season opens Nov 15, 2026) ✓
    if (month === 11 && day === 1) {
      const alreadySent = await prisma.santaSeasonalBroadcastLog.findUnique({
        where: { year_type: { year: seasonYear, type: 'PROMO' } },
      });
      if (!alreadySent) {
        // eslint-disable-next-line no-console
        console.log(`[santa-season] Nov 1 — triggering PROMO broadcast for season ${seasonYear}`);
        void sendSeasonalBroadcast('PROMO', seasonYear);
      }
    }

    // ── February 1: closing-soon notification ───────────────────────────────
    // Feb 1, 2027 → seasonYear = getSeasonStartYear = 2026 (season started Nov 2026) ✓
    // getSeasonStartYear() handles the cross-year shift automatically — no manual "year - 1" needed.
    if (month === 2 && day === 1) {
      const alreadySent = await prisma.santaSeasonalBroadcastLog.findUnique({
        where: { year_type: { year: seasonYear, type: 'CLOSING_SOON' } },
      });
      if (!alreadySent) {
        // eslint-disable-next-line no-console
        console.log(`[santa-season] Feb 1 — triggering CLOSING_SOON broadcast for season ${seasonYear}`);
        void sendSeasonalBroadcast('CLOSING_SOON', seasonYear);
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[santa-season] seasonal event check failed:', err);
  }
}

// Santa seasonal events: check every hour for calendar milestones (Nov 1, Feb 1).
// Idempotent — safe to run hourly; each broadcast fires at most once per year via DB dedup.
setInterval(() => { void maybeRunSeasonalEvents(); }, 60 * 60 * 1000);

// ─── Batch 4.1: Santa Campaign Chat ──────────────────────────────────────────

// Helper: createSystemMessage — creates a SYSTEM message in the campaign chat.
// Called at lifecycle events (join, leave, remove, draw, cancel, complete).
// NEVER includes userId, participantId, or Santa pair data in payload.
async function createSystemMessage(
  campaignId: string,
  systemEvent: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  // Find campaign owner's participant record to use as the pseudo-sender for system messages.
  // If not found (owner left, edge case), skip silently.
  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { ownerId: true },
  });
  if (!campaign) return;
  const ownerParticipant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: campaign.ownerId },
    select: { id: true },
  });
  if (!ownerParticipant) return;

  await prisma.santaChatMessage.create({
    data: {
      campaignId,
      participantId: ownerParticipant.id,
      body: '',         // empty for SYSTEM; body is reserved for USER plaintext
      messageType: 'SYSTEM',
      systemEvent,
      payload: payload as Parameters<typeof prisma.santaChatMessage.create>[0]['data']['payload'],
    },
  }).catch(() => {}); // non-blocking; system message failures never surface to caller
}

// Serializer for a single chat message (role-aware, never leaks participantId)
function serializeChatMessage(
  msg: {
    id: string;
    messageType: string;
    body: string;
    systemEvent: string | null;
    payload: unknown;
    createdAt: Date;
    participantId: string;
    participant: {
      userId: string;
      user: { firstName: string | null; profile: { displayName: string | null; avatarUrl: string | null } | null };
    };
  },
  myUserId: string,
) {
  const isSystem = msg.messageType === 'SYSTEM';
  return {
    id: msg.id,
    messageType: msg.messageType as 'USER' | 'SYSTEM',
    body: isSystem ? '' : msg.body,
    systemEvent: isSystem ? (msg.systemEvent ?? null) : null,
    payload: isSystem ? (msg.payload ?? null) : null,
    sender: isSystem
      ? null
      : {
          displayName:
            msg.participant.user.profile?.displayName || msg.participant.user.firstName || null || 'Unknown',
          avatarUrl: msg.participant.user.profile?.avatarUrl ?? null,
          isMe: msg.participant.userId === myUserId,
        },
    createdAt: msg.createdAt.toISOString(),
  };
}

// GET /tg/santa/campaigns/:id/chat — list messages (keyset pagination)
// Read access: JOINED or LEFT participants only (REMOVED cannot read; owner via participant record)
tgRouter.get('/santa/campaigns/:id/chat', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const participant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: user.id },
    select: { id: true, status: true },
  });
  // REMOVED participants cannot read chat history
  if (!participant || participant.status === 'REMOVED') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const rawLimit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 100);
  const before = typeof req.query.before === 'string' ? req.query.before : null;

  // Keyset pagination: resolve cursor message's (createdAt, id) for stable compound comparison
  let cursorCreatedAt: Date | null = null;
  let cursorId: string | null = null;
  if (before) {
    const cursorMsg = await prisma.santaChatMessage.findUnique({
      where: { id: before },
      select: { createdAt: true, id: true },
    });
    if (cursorMsg) {
      cursorCreatedAt = cursorMsg.createdAt;
      cursorId = cursorMsg.id;
    }
  }

  const messages = await prisma.santaChatMessage.findMany({
    where: {
      campaignId,
      ...(cursorCreatedAt && cursorId
        ? {
            OR: [
              { createdAt: { lt: cursorCreatedAt } },
              { createdAt: cursorCreatedAt, id: { lt: cursorId } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: rawLimit + 1,
    select: {
      id: true, messageType: true, body: true, systemEvent: true, payload: true, createdAt: true,
      participantId: true,
      participant: {
        select: {
          userId: true,
          user: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
        },
      },
    },
  });

  const hasMore = messages.length > rawLimit;
  if (hasMore) messages.pop();

  // Unread count (keyset-consistent with read cursor)
  const chatCursor = await prisma.santaChatReadCursor.findUnique({
    where: { campaignId_participantId: { campaignId, participantId: participant.id } },
    select: { lastReadMessageId: true },
  });
  let totalUnread = 0;
  if (!chatCursor?.lastReadMessageId) {
    totalUnread = await prisma.santaChatMessage.count({ where: { campaignId } });
  } else {
    const lastRead = await prisma.santaChatMessage.findUnique({
      where: { id: chatCursor.lastReadMessageId },
      select: { createdAt: true, id: true },
    });
    if (lastRead) {
      totalUnread = await prisma.santaChatMessage.count({
        where: {
          campaignId,
          OR: [
            { createdAt: { gt: lastRead.createdAt } },
            { createdAt: lastRead.createdAt, id: { gt: lastRead.id } },
          ],
        },
      });
    } else {
      totalUnread = await prisma.santaChatMessage.count({ where: { campaignId } });
    }
  }

  const isMuted = !!(await prisma.santaChatMute.findUnique({
    where: { campaignId_participantId: { campaignId, participantId: participant.id } },
    select: { id: true },
  }));

  return res.json({
    messages: messages.map(m => serializeChatMessage(m, user.id)),
    hasMore,
    totalUnread,
    isMuted,
  });
}));

// POST /tg/santa/campaigns/:id/chat — send a user message
// Write access: JOINED participants only + campaign in (OPEN, LOCKED, ACTIVE)
tgRouter.post('/santa/campaigns/:id/chat', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const parsed = z.object({
    body: z.string().min(1).max(1000),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { status: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!['OPEN', 'LOCKED', 'ACTIVE'].includes(campaign.status)) {
    return res.status(409).json({ error: 'Chat is read-only for this campaign status' });
  }

  const participant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: user.id },
    select: { id: true, status: true },
  });
  if (!participant || participant.status !== 'JOINED') {
    return res.status(403).json({ error: 'Only joined participants can send messages' });
  }

  const msg = await prisma.santaChatMessage.create({
    data: {
      campaignId,
      participantId: participant.id,
      body: parsed.data.body,
      messageType: 'USER',
    },
    select: {
      id: true, messageType: true, body: true, systemEvent: true, payload: true, createdAt: true,
      participantId: true,
      participant: {
        select: {
          userId: true,
          user: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
        },
      },
    },
  });

  // CHAT_MESSAGE notification — batch, non-blocking, mute-aware
  void (async () => {
    try {
      const [joinedParticipants, mutedEntries] = await Promise.all([
        prisma.santaParticipant.findMany({
          where: { campaignId, status: 'JOINED' },
          select: { id: true, userId: true },
        }),
        prisma.santaChatMute.findMany({ where: { campaignId }, select: { participantId: true } }),
      ]);
      const mutedIds = new Set(mutedEntries.map(m => m.participantId));
      const senderDisplayName =
        msg.participant.user.profile?.displayName || msg.participant.user.firstName || 'Someone';

      const notifData = joinedParticipants
        .filter(p => p.userId !== user.id && !mutedIds.has(p.id))
        .map(p => ({
          campaignId,
          userId: p.userId,
          type: 'CHAT_MESSAGE' as const,
          payload: { messageId: msg.id, senderName: senderDisplayName },
        }));
      if (notifData.length > 0) {
        await prisma.santaNotification.createMany({ data: notifData, skipDuplicates: false });
      }
    } catch {}
  })();

  return res.json({ message: serializeChatMessage(msg, user.id) });
}));

// POST /tg/santa/campaigns/:id/chat/read — mark messages as read (upsert cursor)
tgRouter.post('/santa/campaigns/:id/chat/read', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const parsed = z.object({
    lastReadMessageId: z.string().min(1),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const participant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: user.id },
    select: { id: true, status: true },
  });
  if (!participant || participant.status === 'REMOVED') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Verify the referenced message exists in this campaign
  const msgExists = await prisma.santaChatMessage.findFirst({
    where: { id: parsed.data.lastReadMessageId, campaignId },
    select: { id: true },
  });
  if (!msgExists) return res.status(404).json({ error: 'Message not found' });

  await prisma.santaChatReadCursor.upsert({
    where: { campaignId_participantId: { campaignId, participantId: participant.id } },
    update: { lastReadMessageId: parsed.data.lastReadMessageId, lastReadAt: new Date() },
    create: {
      campaignId,
      participantId: participant.id,
      lastReadMessageId: parsed.data.lastReadMessageId,
      lastReadAt: new Date(),
    },
  });

  return res.json({ ok: true });
}));

// POST /tg/santa/campaigns/:id/mute — mute chat notifications for this campaign
tgRouter.post('/santa/campaigns/:id/mute', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const participant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: user.id },
    select: { id: true, status: true },
  });
  if (!participant || participant.status !== 'JOINED') {
    return res.status(403).json({ error: 'Only joined participants can mute' });
  }

  await prisma.santaChatMute.upsert({
    where: { campaignId_participantId: { campaignId, participantId: participant.id } },
    update: { mutedAt: new Date() },
    create: { campaignId, participantId: participant.id },
  });

  return res.json({ ok: true, isMuted: true });
}));

// DELETE /tg/santa/campaigns/:id/mute — unmute chat notifications
tgRouter.delete('/santa/campaigns/:id/mute', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const participant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: user.id },
    select: { id: true, status: true },
  });
  if (!participant || participant.status !== 'JOINED') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  await prisma.santaChatMute.deleteMany({
    where: { campaignId, participantId: participant.id },
  });

  return res.json({ ok: true, isMuted: false });
}));

// ─── Batch 4.2: Santa Campaign Polls ─────────────────────────────────────────

// Serializer for a poll (role-aware, anonymous policy enforced)
function serializePoll(
  poll: {
    id: string;
    question: string;
    options: unknown;
    isAnonymous: boolean;
    createdAt: Date;
    deadlineAt: Date | null;
    closedAt: Date | null;
    votes: { optionIndex: number; participantId: string; participant: { userId: string; user: { firstName: string | null; profile: { displayName: string | null } | null } } }[];
  },
  myParticipantId: string,
  isOwner: boolean,
) {
  const options = (poll.options as string[]);
  const now = new Date();
  const isOpen = !poll.closedAt && (!poll.deadlineAt || poll.deadlineAt > now);
  const myVoteEntry = poll.votes.find(v => v.participantId === myParticipantId);
  const myVote = myVoteEntry ? myVoteEntry.optionIndex : null;

  // Tally results
  const counts = new Array<number>(options.length).fill(0);
  for (const v of poll.votes) counts[v.optionIndex] = (counts[v.optionIndex] ?? 0) + 1;
  const total = poll.votes.length;

  const results = options.map((_, idx) => {
    const count = counts[idx] ?? 0;
    const percentage = total > 0 ? Math.round((count / total) * 100) : 0;
    // voters: always null for anonymous polls; show displayNames for public polls
    const voters = poll.isAnonymous
      ? null
      : poll.votes
          .filter(v => v.optionIndex === idx)
          .map(v => ({ displayName: v.participant.user.profile?.displayName || v.participant.user.firstName || 'Unknown' }));
    return { optionIndex: idx, count, percentage, voters };
  });

  return {
    id: poll.id,
    question: poll.question,
    options,
    isAnonymous: poll.isAnonymous,
    createdAt: poll.createdAt.toISOString(),
    deadlineAt: poll.deadlineAt ? poll.deadlineAt.toISOString() : null,
    closedAt: poll.closedAt ? poll.closedAt.toISOString() : null,
    isOpen,
    myVote,
    results,
  };
}

const POLL_SELECT = {
  id: true, question: true, options: true, isAnonymous: true, createdAt: true,
  deadlineAt: true, closedAt: true,
  votes: {
    select: {
      optionIndex: true, participantId: true,
      participant: { select: { userId: true, user: { select: { firstName: true, profile: { select: { displayName: true } } } } } },
    },
  },
} as const;

// GET /tg/santa/campaigns/:id/polls — list all polls for this campaign
tgRouter.get('/santa/campaigns/:id/polls', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const participant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: user.id },
    select: { id: true, status: true, userId: true },
  });
  if (!participant || participant.status === 'REMOVED') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  const isOwner = campaign.ownerId === user.id;

  const polls = await prisma.santaPoll.findMany({
    where: { campaignId },
    orderBy: { createdAt: 'desc' },
    select: POLL_SELECT,
  });

  return res.json({ polls: polls.map(p => serializePoll(p, participant.id, isOwner)) });
}));

// POST /tg/santa/campaigns/:id/polls — create poll (owner only, campaign ACTIVE)
tgRouter.post('/santa/campaigns/:id/polls', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const parsed = z.object({
    question: z.string().min(1).max(300),
    options: z.array(z.string().min(1).max(100)).min(2).max(10),
    isAnonymous: z.boolean(),
    deadlineAt: z.string().datetime().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { ownerId: true, status: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Polls can only be created in ACTIVE campaigns' });

  const myParticipant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: user.id, status: 'JOINED' },
    select: { id: true, status: true, role: true },
  });
  if (!isOrganizer(campaign, user.id, myParticipant)) return res.status(403).json({ error: 'Only organizers can create polls' });
  if (!myParticipant) return res.status(403).json({ error: 'Organizer must be a participant to create polls' });

  const poll = await prisma.santaPoll.create({
    data: {
      campaignId,
      question: parsed.data.question,
      options: parsed.data.options,
      isAnonymous: parsed.data.isAnonymous,
      createdByParticipantId: myParticipant.id,
      deadlineAt: parsed.data.deadlineAt ? new Date(parsed.data.deadlineAt) : null,
    },
    select: POLL_SELECT,
  });

  // System message: poll created (in chat)
  void createSystemMessage(campaignId, 'poll_created', { question: parsed.data.question.slice(0, 80) }).catch(() => {});

  // POLL_CREATED notifications — batch, mute-aware
  void (async () => {
    try {
      const [joinedParticipants, mutedEntries] = await Promise.all([
        prisma.santaParticipant.findMany({ where: { campaignId, status: 'JOINED' }, select: { id: true, userId: true } }),
        prisma.santaChatMute.findMany({ where: { campaignId }, select: { participantId: true } }),
      ]);
      const mutedIds = new Set(mutedEntries.map(m => m.participantId));
      const notifData = joinedParticipants
        .filter(p => p.userId !== user.id && !mutedIds.has(p.id))
        .map(p => ({ campaignId, userId: p.userId, type: 'POLL_CREATED' as const, payload: { pollId: poll.id } }));
      if (notifData.length > 0) {
        await prisma.santaNotification.createMany({ data: notifData, skipDuplicates: false });
      }
    } catch {}
  })();

  return res.status(201).json({ poll: serializePoll(poll, myParticipant.id, true) });
}));

// POST /tg/santa/campaigns/:id/polls/:pollId/vote — vote on a poll
tgRouter.post('/santa/campaigns/:id/polls/:pollId/vote', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const pollId = req.params.pollId ?? '';
  if (!campaignId || !pollId) return res.status(400).json({ error: 'Missing params' });

  const parsed = z.object({ optionIndex: z.number().int().min(0) }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const participant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: user.id, status: 'JOINED' },
    select: { id: true },
  });
  if (!participant) return res.status(403).json({ error: 'Only joined participants can vote' });

  const poll = await prisma.santaPoll.findUnique({ where: { id: pollId, campaignId }, select: POLL_SELECT });
  if (!poll) return res.status(404).json({ error: 'Poll not found' });

  const options = poll.options as string[];
  if (parsed.data.optionIndex < 0 || parsed.data.optionIndex >= options.length) {
    return res.status(400).json({ error: 'invalid_option_index', message: `optionIndex must be 0–${options.length - 1}` });
  }

  const now = new Date();
  if (poll.closedAt || (poll.deadlineAt && poll.deadlineAt <= now)) {
    return res.status(409).json({ error: 'Poll is closed' });
  }

  // Already voted?
  const existing = poll.votes.find(v => v.participantId === participant.id);
  if (existing) return res.status(409).json({ error: 'already_voted', message: 'You have already voted on this poll' });

  await prisma.santaPollVote.create({
    data: { pollId, participantId: participant.id, optionIndex: parsed.data.optionIndex },
  });

  // Re-fetch poll with updated votes
  const updatedPoll = await prisma.santaPoll.findUnique({ where: { id: pollId }, select: POLL_SELECT });
  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  const isOwner = campaign?.ownerId === user.id;

  return res.json({ poll: serializePoll(updatedPoll!, participant.id, isOwner) });
}));

// POST /tg/santa/campaigns/:id/polls/:pollId/close — close a poll (owner only)
tgRouter.post('/santa/campaigns/:id/polls/:pollId/close', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const pollId = req.params.pollId ?? '';
  if (!campaignId || !pollId) return res.status(400).json({ error: 'Missing params' });

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Only organizers can close polls' });

  const poll = await prisma.santaPoll.findUnique({ where: { id: pollId, campaignId }, select: { id: true, closedAt: true } });
  if (!poll) return res.status(404).json({ error: 'Poll not found' });

  // Idempotent: already closed → just return current state
  if (!poll.closedAt) {
    await prisma.santaPoll.update({ where: { id: pollId }, data: { closedAt: new Date() } });
  }

  const myParticipant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: user.id },
    select: { id: true },
  });

  const updatedPoll = await prisma.santaPoll.findUnique({ where: { id: pollId }, select: POLL_SELECT });
  return res.json({ poll: serializePoll(updatedPoll!, myParticipant?.id ?? '', true) });
}));

// ─── Batch 5.3: Roles + Organizer Controls + Exit Request Flow ────────────────

// PATCH /tg/santa/campaigns/:id/participants/:userId/role — change participant role (owner only)
// Admin role cannot be delegated by another admin — owner only.
tgRouter.patch('/santa/campaigns/:id/participants/:userId/role', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const targetUserId = req.params.userId ?? '';

  const parsed = z.object({
    role: z.enum(['PARTICIPANT', 'ADMIN']),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, status: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  // Owner only — admins cannot promote/demote other participants
  if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can change roles' });
  if (['COMPLETED', 'CANCELLED'].includes(campaign.status)) return res.status(409).json({ error: 'Campaign is finished' });
  // Owner cannot change their own role (they own the campaign, role is irrelevant)
  if (targetUserId === user.id) return res.status(400).json({ error: 'Cannot change your own role' });

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: targetUserId } },
    select: { id: true, status: true, role: true },
  });
  if (!participant) return res.status(404).json({ error: 'Participant not found' });
  if (participant.status === 'REMOVED' || participant.status === 'LEFT') return res.status(409).json({ error: 'Cannot change role of a participant who has left or been removed' });

  const updated = await prisma.santaParticipant.update({
    where: { id: participant.id },
    data: { role: parsed.data.role },
    select: { id: true, userId: true, role: true, status: true },
  });
  await prisma.santaAdminAuditLog.create({
    data: { campaignId, actorId: user.id, action: 'role_changed', payload: { targetUserId, newRole: parsed.data.role } },
  });

  return res.json({ ok: true, participant: { id: updated.id, userId: updated.userId, role: updated.role, status: updated.status } });
}));

// GET /tg/santa/campaigns/:id/organizer/summary — rich stats for organizer (organizer only)
tgRouter.get('/santa/campaigns/:id/organizer/summary', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { ownerId: true, status: true, currentRoundId: true, drawAt: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  // Participants
  const participants = await prisma.santaParticipant.findMany({
    where: { campaignId },
    select: {
      id: true,
      userId: true,
      status: true,
      role: true,
      joinedAt: true,
      leftAt: true,
      linkedWishlistId: true,
      user: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
    },
    orderBy: { joinedAt: 'asc' },
  });

  // Assignment progress for current round
  let giftProgress: {
    pending: number; buying: number; selectedFromWishlist: number; selectedOutside: number;
    declinedToSay: number; sent: number; received: number; missedDeadline: number; orphaned: number;
  } | null = null;

  if (campaign.currentRoundId) {
    const assignments = await prisma.santaAssignment.findMany({
      where: { roundId: campaign.currentRoundId },
      select: { giftStatus: true },
    });
    giftProgress = {
      pending: 0, buying: 0, selectedFromWishlist: 0, selectedOutside: 0,
      declinedToSay: 0, sent: 0, received: 0, missedDeadline: 0, orphaned: 0,
    };
    for (const a of assignments) {
      if (a.giftStatus === 'PENDING') giftProgress.pending++;
      else if (a.giftStatus === 'BUYING') giftProgress.buying++;
      else if (a.giftStatus === 'SELECTED_FROM_WISHLIST') giftProgress.selectedFromWishlist++;
      else if (a.giftStatus === 'SELECTED_OUTSIDE') giftProgress.selectedOutside++;
      else if (a.giftStatus === 'DECLINED_TO_SAY') giftProgress.declinedToSay++;
      else if (a.giftStatus === 'SENT') giftProgress.sent++;
      else if (a.giftStatus === 'RECEIVED') giftProgress.received++;
      else if (a.giftStatus === 'MISSED_DEADLINE') giftProgress.missedDeadline++;
      else if (a.giftStatus === 'ORPHANED') giftProgress.orphaned++;
    }
  }

  // Pending exit requests
  const pendingExitRequests = await prisma.santaExitRequest.findMany({
    where: { campaignId, status: 'PENDING' },
    select: {
      id: true,
      participantId: true,
      reason: true,
      createdAt: true,
      participant: {
        select: { userId: true, user: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } } },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const formatParticipant = (p: typeof participants[number]) => ({
    id: p.id,
    userId: p.userId,
    status: p.status,
    role: p.role,
    joinedAt: p.joinedAt.toISOString(),
    leftAt: p.leftAt?.toISOString() ?? null,
    displayName: p.user.profile?.displayName || p.user.firstName || p.userId,
    avatarUrl: p.user.profile?.avatarUrl ?? null,
    hasLinkedWishlist: !!p.linkedWishlistId,
  });

  return res.json({
    campaign: {
      status: campaign.status,
      currentRoundId: campaign.currentRoundId,
      drawAt: campaign.drawAt?.toISOString() ?? null,
    },
    participants: participants.map(formatParticipant),
    giftProgress,
    pendingExitRequests: pendingExitRequests.map(r => ({
      id: r.id,
      participantId: r.participantId,
      userId: r.participant.userId,
      displayName: r.participant.user.profile?.displayName || r.participant.user.firstName || r.participant.userId,
      avatarUrl: r.participant.user.profile?.avatarUrl ?? null,
      reason: r.reason ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}));

// POST /tg/santa/campaigns/:id/exit-request — submit exit request (JOINED participants, not owner)
tgRouter.post('/santa/campaigns/:id/exit-request', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const parsed = z.object({ reason: z.string().max(300).optional() }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { ownerId: true, status: true, currentRoundId: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  // Owner cannot submit an exit request (they own the campaign; use cancel instead)
  if (campaign.ownerId === user.id) return res.status(403).json({ error: 'Owner cannot submit an exit request' });
  // Only allowed when campaign is LOCKED or ACTIVE
  if (!['LOCKED', 'ACTIVE'].includes(campaign.status)) {
    return res.status(409).json({ error: 'exit_request_not_applicable', message: 'Exit requests only apply to LOCKED or ACTIVE campaigns' });
  }

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
    select: { id: true, status: true },
  });
  if (!participant || participant.status !== 'JOINED') {
    return res.status(403).json({ error: 'Only JOINED participants can submit exit requests' });
  }

  // Check for existing PENDING exit request (partial unique index enforces this at DB level too)
  const existing = await prisma.santaExitRequest.findFirst({
    where: { participantId: participant.id, status: 'PENDING' },
  });
  if (existing) return res.status(409).json({ error: 'exit_request_already_pending', requestId: existing.id });

  const exitRequest = await prisma.santaExitRequest.create({
    data: {
      campaignId,
      participantId: participant.id,
      roundId: campaign.currentRoundId ?? null,
      reason: parsed.data?.reason ?? null,
      status: 'PENDING',
    },
  });

  // Notify all organizers (owner + ADMIN participants)
  void (async () => {
    try {
      const adminParticipants = await prisma.santaParticipant.findMany({
        where: { campaignId, status: 'JOINED', role: 'ADMIN' },
        select: { userId: true },
      });
      const organizerUserIds = [
        campaign.ownerId,
        ...adminParticipants.map(p => p.userId).filter(uid => uid !== campaign.ownerId),
      ];
      if (organizerUserIds.length > 0) {
        await prisma.santaNotification.createMany({
          data: organizerUserIds.map(uid => ({
            campaignId,
            userId: uid,
            type: 'EXIT_REQUEST_SUBMITTED' as const,
            payload: { requestId: exitRequest.id, participantId: participant.id },
          })),
          skipDuplicates: true,
        });
      }
    } catch { /* best-effort */ }
  })();

  return res.status(201).json({
    exitRequest: {
      id: exitRequest.id,
      status: exitRequest.status,
      reason: exitRequest.reason,
      createdAt: exitRequest.createdAt.toISOString(),
    },
  });
}));

// GET /tg/santa/campaigns/:id/exit-requests — list exit requests (organizer only)
tgRouter.get('/santa/campaigns/:id/exit-requests', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  const requests = await prisma.santaExitRequest.findMany({
    where: { campaignId },
    select: {
      id: true,
      participantId: true,
      roundId: true,
      reason: true,
      status: true,
      resolvedAt: true,
      createdAt: true,
      participant: {
        select: { userId: true, status: true, user: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } } },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return res.json({
    exitRequests: requests.map(r => ({
      id: r.id,
      participantId: r.participantId,
      userId: r.participant.userId,
      displayName: r.participant.user.profile?.displayName || r.participant.user.firstName || r.participant.userId,
      avatarUrl: r.participant.user.profile?.avatarUrl ?? null,
      participantStatus: r.participant.status,
      roundId: r.roundId,
      reason: r.reason ?? null,
      status: r.status,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}));

// POST /tg/santa/campaigns/:id/exit-requests/:requestId/approve — approve exit (owner only)
// Owner only — admin cannot approve their own request (self-approve guard) and role management
// is owner-scoped, so approval authority stays with owner.
tgRouter.post('/santa/campaigns/:id/exit-requests/:requestId/approve', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const requestId = req.params.requestId ?? '';

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { ownerId: true, status: true, currentRoundId: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can approve exit requests' });

  const exitRequest = await prisma.santaExitRequest.findUnique({
    where: { id: requestId },
    select: { id: true, campaignId: true, participantId: true, status: true },
  });
  if (!exitRequest || exitRequest.campaignId !== campaignId) return res.status(404).json({ error: 'Exit request not found' });
  if (exitRequest.status !== 'PENDING') return res.status(409).json({ error: 'Exit request is not pending' });

  const participant = await prisma.santaParticipant.findUnique({
    where: { id: exitRequest.participantId },
    select: { id: true, userId: true, status: true },
  });
  if (!participant) return res.status(404).json({ error: 'Participant not found' });

  // M1: one-to-one warning — if approving this exit would leave only 1 JOINED participant
  const remainingJoinedCount = await prisma.santaParticipant.count({
    where: { campaignId, status: 'JOINED', id: { not: participant.id } },
  });
  const warning = remainingJoinedCount === 1 ? 'only_one_participant_remaining' : undefined;

  const now = new Date();

  // Approval transaction:
  // 1. Mark exit request as APPROVED
  // 2. Set participant status → LEFT (voluntary exit with organizer approval, not forced removal)
  // 3. If ACTIVE campaign + participant has non-terminal assignments in current round → ORPHANED
  await prisma.$transaction(async (tx) => {
    await tx.santaExitRequest.update({
      where: { id: requestId },
      data: { status: 'APPROVED', resolvedAt: now },
    });
    await tx.santaParticipant.update({
      where: { id: participant.id },
      data: { status: 'LEFT', leftAt: now },
    });
    // If there's an active round, orphan any non-terminal assignments from this participant
    if (campaign.status === 'ACTIVE' && campaign.currentRoundId) {
      await tx.santaAssignment.updateMany({
        where: {
          roundId: campaign.currentRoundId,
          giverParticipantId: participant.id,
          giftStatus: { notIn: ['RECEIVED', 'MISSED_DEADLINE', 'ORPHANED'] as never[] },
        },
        data: { giftStatus: 'ORPHANED' },
      });
    }
    // Deny any other PENDING exit requests from the same participant (shouldn't exist due to unique index, but be safe)
    await tx.santaExitRequest.updateMany({
      where: { participantId: participant.id, status: 'PENDING', id: { not: requestId } },
      data: { status: 'DENIED', resolvedAt: now },
    });
  });

  // Notify the participant that their request was approved
  void prisma.santaNotification.create({
    data: {
      campaignId,
      userId: participant.userId,
      type: 'EXIT_REQUEST_APPROVED',
      payload: { requestId },
    },
  }).catch(() => {});

  // System message in chat (participant_left — they chose to leave, organizer approved)
  const participantUser = await prisma.user.findUnique({
    where: { id: participant.userId },
    select: { firstName: true, profile: { select: { displayName: true } } },
  });
  const displayName = participantUser?.profile?.displayName || participantUser?.firstName || 'Someone';
  void createSystemMessage(campaignId, 'participant_left', { displayName }).catch(() => {});

  return res.json({ ok: true, exitRequest: { id: requestId, status: 'APPROVED' }, ...(warning ? { warning } : {}) });
}));

// POST /tg/santa/campaigns/:id/exit-requests/:requestId/deny — deny exit (owner only)
tgRouter.post('/santa/campaigns/:id/exit-requests/:requestId/deny', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const requestId = req.params.requestId ?? '';

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can deny exit requests' });

  const exitRequest = await prisma.santaExitRequest.findUnique({
    where: { id: requestId },
    select: { id: true, campaignId: true, participantId: true, status: true },
  });
  if (!exitRequest || exitRequest.campaignId !== campaignId) return res.status(404).json({ error: 'Exit request not found' });
  if (exitRequest.status !== 'PENDING') return res.status(409).json({ error: 'Exit request is not pending' });

  const participant = await prisma.santaParticipant.findUnique({
    where: { id: exitRequest.participantId },
    select: { userId: true },
  });

  await prisma.santaExitRequest.update({
    where: { id: requestId },
    data: { status: 'DENIED', resolvedAt: new Date() },
  });

  // Notify the participant that their request was denied
  if (participant) {
    void prisma.santaNotification.create({
      data: {
        campaignId,
        userId: participant.userId,
        type: 'EXIT_REQUEST_DENIED',
        payload: { requestId },
      },
    }).catch(() => {});
  }

  return res.json({ ok: true, exitRequest: { id: requestId, status: 'DENIED' } });
}));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://localhost:${PORT}`);
  // Send startup alert to admins (best-effort)
  void sendAdminAlert(`🟢 <b>API started</b>\nPort: ${PORT}\nEnv: ${process.env.NODE_ENV ?? 'development'}`);

  // Ensure SantaGlobalConfig singleton exists.
  // This is idempotent — upsert preserves the existing santaEnabled value if already set.
  // If the row doesn't exist yet (fresh DB), it is created with santaEnabled=true (default on).
  void prisma.santaGlobalConfig.upsert({
    where:  { id: 'global' },
    create: { id: 'global', santaEnabled: true },
    update: {}, // never overwrite an existing setting on startup
  }).catch(err => {
    // eslint-disable-next-line no-console
    console.error('[startup] SantaGlobalConfig upsert failed:', err);
  });
});

// ─── Uncaught exception / rejection alerts ────────────────────────────────────
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[api] uncaughtException:', err);
  void sendAdminAlert(`🔴 <b>API uncaughtException</b>\n${String(err)}`).finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[api] unhandledRejection:', reason);
  void sendAdminAlert(`🔴 <b>API unhandledRejection</b>\n${String(reason)}`);
});
