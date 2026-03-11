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
async function resolveUserFirstName(user: { id: string; firstName: string | null; telegramChatId: string | null }): Promise<string> {
  if (user.firstName) return user.firstName;
  const token = process.env.BOT_TOKEN;
  if (!token || !user.telegramChatId) return 'Пользователь';
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: user.telegramChatId }),
    });
    if (!resp.ok) return 'Пользователь';
    const json = await resp.json() as { ok: boolean; result?: { first_name?: string } };
    const name = json.result?.first_name;
    if (name) {
      // Cache in DB for future calls
      await prisma.user.update({ where: { id: user.id }, data: { firstName: name } }).catch(() => {});
      return name;
    }
  } catch { /* best-effort */ }
  return 'Пользователь';
}

/** Cancel all active hints for an item (called when item leaves AVAILABLE state). */
async function cancelItemHints(itemId: string): Promise<void> {
  try {
    await prisma.hint.updateMany({
      where: { itemId, status: 'SENT' },
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
    const data = await resp.json() as { ok: boolean };
    return data.ok;
  } catch {
    return false;
  }
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
      void sendTgNotification(e.chatId, `💬 У вас ${e.count} ${e.count === 1 ? 'новый комментарий' : 'новых комментариев'} в «${e.itemTitle}»`);
    }, 30_000),
  };
  pendingNotifications.set(key, entry);
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

    return res.json({
      wishlist: {
        id: wishlist.id,
        slug: wishlist.slug,
        title: wishlist.title,
        description: wishlist.description,
        deadline: wishlist.deadline,
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

    return res.json({
      wishlist: {
        id: wishlist.id,
        slug: wishlist.slug,
        title: wishlist.title,
        description: wishlist.description,
        deadline: wishlist.deadline,
      },
      items: wishlist.items.map(mapItemForPublic),
      tags: wishlist.tags,
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
    items: 30,
    participants: 5,
    features: [] as string[],
  },
  PRO: {
    code: 'PRO' as const,
    wishlists: 10,
    items: 100,
    participants: 20,
    features: ['comments', 'url_import', 'hints'],
  },
} as const;

type PlanCode = keyof typeof PLANS;
type PlanInfo = (typeof PLANS)[PlanCode];

const PRO_PRICE_XTR = parseInt(process.env.PRO_PRICE_XTR ?? '100', 10);
const PRO_SUBSCRIPTION_PERIOD = parseInt(process.env.PRO_SUBSCRIPTION_PERIOD ?? '2592000', 10);
const PRO_PLAN_CODE = process.env.PRO_PLAN_CODE ?? 'PRO';

async function getUserEntitlement(userId: string): Promise<{
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

  return { plan: PLANS.FREE, isPro: false, subscription: null };
}

/** Check if a wishlist is writable (within plan limits) for the given user */
async function isWishlistWritable(userId: string, wishlistId: string, planLimit: number): Promise<boolean> {
  const allWishlists = await prisma.wishlist.findMany({
    where: { ownerId: userId, type: 'REGULAR' },
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
  imageUrl?: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
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
    imageUrl: item.imageUrl ?? null,
    priority: priorityToNum(item.priority),
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
    const ent = await getUserEntitlement(user.id);

    const wishlists = await prisma.wishlist.findMany({
      where: { ownerId: user.id, type: 'REGULAR' },
      orderBy: { createdAt: 'asc' },  // oldest first for readOnly calculation
      select: {
        id: true, slug: true, title: true, description: true, deadline: true,
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
    const reservationsCount = await prisma.item.count({
      where: { reserverUserId: user.id, status: 'RESERVED' },
    });

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
          readOnly: idx >= ent.plan.wishlists,
        };
      }),
      plan: {
        code: ent.plan.code,
        wishlists: ent.plan.wishlists,
        items: ent.plan.items,
        participants: ent.plan.participants,
        features: [...ent.plan.features],
      },
      subscription: ent.subscription,
      drafts,
      reservationsCount,
    });
  }),
);

// GET /tg/reservations — items reserved by current user across all wishlists
tgRouter.get(
  '/reservations',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const actorHash = tgActorHash(req.tgUser!.id);

    // 1. Items reserved by this user (only TG-identified reservations)
    const items = await prisma.item.findMany({
      where: { reserverUserId: user.id, status: 'RESERVED' },
      select: {
        id: true, wishlistId: true, title: true, url: true, priceText: true,
        imageUrl: true, priority: true, status: true, description: true,
        sourceUrl: true, sourceDomain: true, importMethod: true,
        wishlist: {
          select: { owner: { select: { id: true, firstName: true, telegramChatId: true } } },
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

    // 4. Resolve owner names (batch-dedupe by ownerId)
    const uniqueOwners = new Map<string, typeof items[0]['wishlist']['owner']>();
    for (const item of items) {
      if (!uniqueOwners.has(item.wishlist.owner.id)) {
        uniqueOwners.set(item.wishlist.owner.id, item.wishlist.owner);
      }
    }
    const ownerNames = new Map<string, string>();
    await Promise.all(
      [...uniqueOwners.entries()].map(async ([ownerId, owner]) => {
        ownerNames.set(ownerId, await resolveUserFirstName(owner));
      }),
    );

    // 5. Map response
    const reservations = items.map(item => ({
      ...mapTgItem(item),
      ownerName: ownerNames.get(item.wishlist.owner.id) ?? 'Пользователь',
      ownerId: item.wishlist.owner.id,
      unreadComments: unreadCounts[item.id] ?? 0,
    }));

    return res.json({ reservations });
  }),
);

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
    const ent = await getUserEntitlement(user.id);
    const count = await prisma.wishlist.count({ where: { ownerId: user.id, type: 'REGULAR' } });
    if (count >= ent.plan.wishlists) {
      trackEvent('feature_gate_hit_wishlist_limit', user.id, { plan: ent.plan.code, count });
      return res.status(402).json({ error: 'Plan limit reached', limit: ent.plan.wishlists, planCode: ent.plan.code });
    }

    const slug = await generateUniqueSlug(parsed.data.title);
    const wishlist = await prisma.wishlist.create({
      data: {
        slug,
        ownerId: user.id,
        title: parsed.data.title,
        deadline: parsed.data.deadline ? new Date(parsed.data.deadline) : null,
      },
      select: { id: true, slug: true, title: true, description: true, deadline: true },
    });

    return res.status(201).json({
      wishlist: { ...wishlist, deadline: wishlist.deadline?.toISOString() ?? null, itemCount: 0, reservedCount: 0 },
    });
  }),
);

// PATCH /tg/wishlists/:id — update wishlist
tgRouter.patch(
  '/wishlists/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });

    const parsed = z
      .object({
        title: z.string().min(1).max(200).optional(),
        deadline: z.string().datetime().nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({ where: { id }, select: { ownerId: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const updated = await prisma.wishlist.update({
      where: { id },
      data: {
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.deadline !== undefined
          ? { deadline: parsed.data.deadline ? new Date(parsed.data.deadline) : null }
          : {}),
      },
      select: { id: true, slug: true, title: true, description: true, deadline: true },
    });

    return res.json({ wishlist: { ...updated, deadline: updated.deadline?.toISOString() ?? null } });
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

    await prisma.wishlist.delete({ where: { id } });
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
        imageUrl: true, priority: true, status: true, description: true,
        sourceUrl: true, sourceDomain: true, importMethod: true,
      },
    });

    return res.json({ items: items.map(mapTgItem) });
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
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getUserEntitlement(user.id);
    const wishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId }, select: { ownerId: true, type: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Read-only check for over-limit wishlists (only REGULAR)
    if (wishlist.type === 'REGULAR' && !(await isWishlistWritable(user.id, wishlistId, ent.plan.wishlists))) {
      return res.status(402).json({ error: 'Wishlist is read-only on current plan', planCode: ent.plan.code });
    }

    const itemCount = await prisma.item.count({ where: { wishlistId, status: { in: [...ACTIVE_STATUSES] } } });
    if (itemCount >= ent.plan.items) {
      trackEvent('feature_gate_hit_item_limit', user.id, { plan: ent.plan.code, count: itemCount });
      return res.status(402).json({ error: 'Plan limit reached', limit: ent.plan.items, planCode: ent.plan.code });
    }

    const item = await prisma.item.create({
      data: {
        wishlistId,
        title: parsed.data.title,
        url: parsed.data.url ?? '',
        priceText: parsed.data.price != null ? String(parsed.data.price) : null,
        priority: numToPriority(parsed.data.priority ?? 2),
        imageUrl: parsed.data.imageUrl ?? null,
      },
      select: { id: true, wishlistId: true, title: true, url: true, priceText: true, imageUrl: true, priority: true, status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true },
    });

    return res.status(201).json({ item: mapTgItem(item) });
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
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, status: true, reservationEpoch: true, reserverUserId: true, title: true, wishlist: { select: { ownerId: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

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
      },
      select: { id: true, wishlistId: true, title: true, url: true, priceText: true, imageUrl: true, priority: true, status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true },
    });

    // After update, if description changed and item was reserved — notify reserver
    if (parsed.data.description !== undefined && item.status === 'RESERVED') {
      await prisma.comment.create({
        data: {
          itemId: id,
          type: 'SYSTEM',
          text: 'Описание обновлено',
          reservationEpoch: item.reservationEpoch,
        },
      });
      if (item.reserverUserId) {
        const reserver = await prisma.user.findUnique({
          where: { id: item.reserverUserId },
          select: { telegramChatId: true },
        });
        if (reserver?.telegramChatId) {
          void sendTgNotification(reserver.telegramChatId, `📝 Описание обновлено в «${item.title}»`);
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
        void sendTgNotification(
          reserver.telegramChatId,
          `📦 Автор поместил желание «${item.title}» в архив`,
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
      select: { id: true, wishlistId: true, title: true, url: true, priceText: true, imageUrl: true, priority: true, status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true },
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
        let msg = `✅ Автор отметил желание «${item.title}» как исполненное. Спасибо за подарок! 🎉`;
        // Soft CTA if reserver has no wishlists
        const reserverWlCount = await prisma.wishlist.count({
          where: { ownerId: reserver.id, type: 'REGULAR' },
        });
        if (reserverWlCount === 0) {
          msg += '\n\nА ты уже создал свой вишлист? Открой WishBoard и расскажи друзьям о своих желаниях!';
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
      select: { id: true, wishlistId: true, title: true, url: true, priceText: true, imageUrl: true, priority: true, status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true },
    });
    return res.json({ item: mapTgItem(updated) });
  }),
);

// GET /tg/wishlists/:id/archive — archived items (DELETED + COMPLETED)
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
      select: { id: true, wishlistId: true, title: true, url: true, priceText: true, imageUrl: true, priority: true, status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true },
    });

    return res.json({ items: items.map(mapTgItem) });
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
        data: { itemId: id, type: 'SYSTEM', text: 'Подарок забронирован', reservationEpoch: newEpoch },
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
          void sendTgNotification(owner.telegramChatId, `🎁 ${displayName} забронировал желание «${itemData.title}»`);
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
        data: { itemId: id, type: 'SYSTEM', text: 'Бронь отменена', reservationEpoch: item.reservationEpoch },
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
    const mapped = comments.map((c) => {
      if (
        ctx.role === 'reserver' &&
        c.type === 'USER' &&
        c.reservationEpoch < ctx.item.reservationEpoch &&
        c.authorActorHash !== ctx.actorHash
      ) {
        return { ...c, authorDisplayName: 'Аноним', createdAt: c.createdAt.toISOString() };
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

    // Reject archived items
    if (ctx.item.status === 'COMPLETED' || ctx.item.status === 'DELETED') {
      return res.status(400).json({ error: 'Комментарии в архиве запрещены' });
    }

    // Validate text
    const parsed = z.object({ text: z.string().min(1).max(300) }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const text = parsed.data.text.trim();
    if (!text) return res.status(400).json({ error: 'Комментарий не может быть пустым' });

    // Reject emoji/dots only
    const stripped = text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s.…]+/gu, '');
    if (stripped.length === 0) {
      return res.status(400).json({ error: 'Напиши что-нибудь содержательное' });
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
      return res.status(429).json({ error: 'Подожди немного перед следующим комментарием' });
    }

    // 2. Deduplicate
    if (lastComment && lastComment.text === text) {
      return res.status(400).json({ error: 'Этот комментарий уже отправлен' });
    }

    // 3. Max 3 consecutive without reply
    const recent3 = await prisma.comment.findMany({
      where: { itemId: id, type: 'USER' },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { authorActorHash: true },
    });
    if (recent3.length >= 3 && recent3.every((c) => c.authorActorHash === ctx.actorHash)) {
      return res.status(429).json({ error: 'Дождись ответа перед отправкой новых комментариев' });
    }

    // 4. Max 10/hour
    const hourAgo = new Date(now - 3600_000);
    const hourCount = await prisma.comment.count({
      where: { itemId: id, authorActorHash: ctx.actorHash, type: 'USER', createdAt: { gte: hourAgo } },
    });
    if (hourCount >= 10) {
      return res.status(429).json({ error: 'Слишком много комментариев за час' });
    }

    // 5. Max 20/30 days
    const monthAgo = new Date(now - 30 * 86400_000);
    const monthCount = await prisma.comment.count({
      where: { itemId: id, authorActorHash: ctx.actorHash, type: 'USER', createdAt: { gte: monthAgo } },
    });
    if (monthCount >= 20) {
      return res.status(429).json({ error: 'Достигнут лимит комментариев' });
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
    if (ctx.role === 'reserver') {
      // Notify owner
      const owner = await prisma.user.findUnique({
        where: { id: ctx.item.wishlist.ownerId },
        select: { telegramChatId: true, id: true },
      });
      if (owner?.telegramChatId) {
        const key = `${id}:${owner.id}`;
        queueCommentNotification(key, owner.telegramChatId, ctx.item.title,
          `💬 ${displayName} прокомментировал «${ctx.item.title}»:\n${text}`);
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
          `💬 Автор прокомментировал «${ctx.item.title}»:\n${text}`);
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
    if (comment.type === 'SYSTEM') return res.status(403).json({ error: 'Системные события нельзя удалить' });

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

    // 1. Feature gate: hints require PRO
    const ent = await getUserEntitlement(user.id);
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

    // 3. Item must be AVAILABLE (not reserved/completed/deleted)
    if (item.status !== 'AVAILABLE') {
      return res.status(400).json({ error: 'item_not_available', message: 'На это желание намекать уже не нужно — его забронировали' });
    }

    // 4. Anti-spam: max 3 hint waves per item per 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const itemHintCount = await prisma.hint.count({
      where: { itemId: id, senderUserId: user.id, status: 'SENT', createdAt: { gte: thirtyDaysAgo } },
    });
    if (itemHintCount >= 3) {
      return res.status(429).json({ error: 'По этому желанию уже отправлено максимум намёков. Попробуй позже.' });
    }

    // 5. Anti-spam: max 5 hints per sender per day
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dailyHintCount = await prisma.hint.count({
      where: { senderUserId: user.id, status: 'SENT', createdAt: { gte: oneDayAgo } },
    });
    if (dailyHintCount >= 5) {
      return res.status(429).json({ error: 'Лимит намёков на сегодня. Попробуй завтра.' });
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
      await sendTgBotMessage(
        senderChatId,
        `💡 Намёк на «${item.title}» создан!\n\nВыбери друзей, которым хочешь намекнуть:`,
        {
          keyboard: [[{
            text: '👥 Выбрать получателей',
            request_users: { request_id: Number(hint.id.slice(-6).replace(/\D/g, '') || '1'), user_is_bot: false, max_quantity: 10 },
          }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      );
    }

    trackEvent('hint_created', user.id);

    return res.json({ hintId: hint.id, status: 'pending_selection' });
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
    let hostname = 'ссылка';
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

  const title = parsed.title || parsed.sourceDomain || 'Ссылка';

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
      sourceUrl: true, sourceDomain: true, importMethod: true,
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
  message: { error: 'Слишком много запросов. Попробуй через минуту.' },
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
        return res.status(402).json({ error: 'Слишком много неразобранных желаний. Разбери часть, потом добавляй новые.', limit: DRAFTS_ITEM_LIMIT });
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
        return res.status(402).json({ error: 'Лимит желаний в этом вишлисте', limit: ent.plan.items, planCode: ent.plan.code });
      }
    }

    // Move item
    const updated = await prisma.item.update({
      where: { id },
      data: { wishlistId: parsed.data.targetWishlistId },
      select: {
        id: true, wishlistId: true, title: true, url: true, priceText: true,
        imageUrl: true, priority: true, status: true, description: true,
        sourceUrl: true, sourceDomain: true, importMethod: true,
      },
    });

    return res.json({ item: mapTgItem(updated) });
  }),
);

// ─── Billing & Plan endpoints ────────────────────────────────────────────────

// GET /tg/me/plan — current user's plan, subscription, and usage
tgRouter.get(
  '/me/plan',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getUserEntitlement(user.id);
    const wishlistCount = await prisma.wishlist.count({ where: { ownerId: user.id, type: 'REGULAR' } });

    return res.json({
      plan: {
        code: ent.plan.code,
        wishlists: ent.plan.wishlists,
        items: ent.plan.items,
        participants: ent.plan.participants,
        features: [...ent.plan.features],
      },
      subscription: ent.subscription,
      usage: { wishlists: wishlistCount },
      proPriceStars: PRO_PRICE_XTR,
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
        description: 'Больше вишлистов, комментарии, добавление по ссылке и умные напоминания',
        payload,
        currency: 'XTR',
        prices: [{ label: 'PRO на месяц', amount: PRO_PRICE_XTR }],
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
    const ent = await getUserEntitlement(user.id);

    return res.json({
      plan: {
        code: ent.plan.code,
        wishlists: ent.plan.wishlists,
        items: ent.plan.items,
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
      return res.status(413).json({ error: 'Файл слишком большой. Максимум 30 МБ.' });
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

// Hint expiry: mark overdue hints as EXPIRED (hourly)
setInterval(async () => {
  try {
    const expired = await prisma.hint.updateMany({
      where: { status: 'SENT', expiresAt: { lte: new Date() } },
      data: { status: 'EXPIRED' },
    });
    if (expired.count > 0) {
      // eslint-disable-next-line no-console
      console.log(`[hints] expired ${expired.count} hints`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[hints] expiry check failed:', err);
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://localhost:${PORT}`);
});
