import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pino from 'pino';
import { z } from 'zod';
import { prisma } from '@wishlist/db';

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

// Logger setup
const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

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
    allowedHeaders: ['Content-Type', 'X-ADMIN-KEY', 'X-Telegram-User-Id'],
  }),
);
app.use(express.json());

// Rate limiting
const readLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !req.path.startsWith('/public'), // Only apply to public routes
});

const writeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute
  message: { error: 'Too many reservation requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(readLimiter);

app.get('/health', (_req, res) => res.json({ ok: true }));

const publicRouter = express.Router();
const privateRouter = express.Router();

// --- Helpers
const ItemStatusSchema = z.enum(['AVAILABLE', 'RESERVED', 'PURCHASED']);
const PrioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);

const actorBodySchema = z.object({
  actorHash: z.string().min(1).max(128),
});

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    logger.error({ path: req.path }, 'ADMIN_KEY is not configured');
    return res.status(500).json({ error: 'ADMIN_KEY is not configured' });
  }

  const provided = req.get('X-ADMIN-KEY');
  if (!provided || provided !== adminKey) {
    logger.warn({ path: req.path, method: req.method }, 'Unauthorized admin access attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

/**
 * Audit logging middleware for private endpoints
 */
function auditLog(req: Request, res: Response, next: NextFunction) {
  const startTime = Date.now();

  // Capture original send
  const originalSend = res.send;
  res.send = function (body) {
    const duration = Date.now() - startTime;

    // Extract IDs from path params
    const wishlistId = req.params.id || req.params.wishlistId;
    const itemId = req.params.itemId;
    const tagId = req.params.tagId;

    const logData: {
      method: string;
      path: string;
      statusCode: number;
      duration: number;
      wishlistId?: string;
      itemId?: string;
      tagId?: string;
      error?: string;
    } = {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
    };

    if (wishlistId) logData.wishlistId = wishlistId;
    if (itemId) logData.itemId = itemId;
    if (tagId) logData.tagId = tagId;

    // Log error details if status >= 400
    if (res.statusCode >= 400) {
      try {
        const parsed = JSON.parse(body as string);
        if (parsed.error) logData.error = parsed.error;
      } catch {
        // Ignore parse errors
      }
    }

    if (res.statusCode >= 500) {
      logger.error(logData, 'Admin operation failed');
    } else if (res.statusCode >= 400) {
      logger.warn(logData, 'Admin operation client error');
    } else {
      logger.info(logData, 'Admin operation');
    }

    return originalSend.call(this, body);
  };

  next();
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
  // URL-safe short suffix.
  return crypto.randomBytes(Math.ceil(len)).toString('base64url').slice(0, len);
}

async function generateUniqueSlug(title: string) {
  const base = slugify(title).slice(0, 24);
  for (let i = 0; i < 10; i++) {
    const candidate = `${base}-${randomSuffix(6)}`;
    const existing = await prisma.wishlist.findUnique({ where: { slug: candidate } });
    if (!existing) return candidate;
  }
  // Extremely unlikely fallback.
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

async function getSystemUser() {
  const email = (process.env.SYSTEM_USER_EMAIL ?? 'owner@local').trim();
  if (!email) throw new Error('SYSTEM_USER_EMAIL is not configured');

  return prisma.user.upsert({
    where: { email },
    update: {},
    create: { email },
  });
}

/** For bot: resolve owner by Telegram ID (when X-Telegram-User-Id + ADMIN_KEY). Else system user. */
async function getRequestOwner(req: Request) {
  const telegramIdRaw = req.get('X-Telegram-User-Id');
  if (telegramIdRaw?.trim()) {
    const telegramId = telegramIdRaw.trim();
    return prisma.user.upsert({
      where: { telegramId },
      update: {},
      create: { telegramId },
    });
  }
  return getSystemUser();
}

function mapItemForPublic(item: {
  id: string;
  title: string;
  url: string;
  priceText: string | null;
  commentOwner: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  deadline: Date | null;
  imageUrl: string | null;
  status: 'AVAILABLE' | 'RESERVED' | 'PURCHASED';
  createdAt: Date;
  updatedAt: Date;
  itemTags: { tag: { id: string; name: string } }[];
}) {
  return {
    id: item.id,
    title: item.title,
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
  };
}

// --- Public endpoints (no auth)
publicRouter.get(
  '/wishlists/:slug/items',
  asyncHandler(async (req, res) => {
    const slug = req.params.slug ?? '';
    if (!slug) return res.status(400).json({ error: 'Missing slug' });

    // Parse query params: status, tag (ID), tagName, limit, offset
    const queryParsed = z
      .object({
        status: ItemStatusSchema.optional(),
        tag: z.string().min(1).optional(),
        tagName: z.string().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional().default(50),
        offset: z.coerce.number().int().min(0).optional().default(0),
      })
      .safeParse(req.query);
    if (!queryParsed.success) return zodError(res, queryParsed.error);

    const wishlist = await prisma.wishlist.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });

    // Build where clause
    const where: {
      wishlistId: string;
      status?: 'AVAILABLE' | 'RESERVED' | 'PURCHASED';
      itemTags?: { some: { tagId?: string; tag?: { name: string } } };
    } = { wishlistId: wishlist.id };

    if (queryParsed.data.status) where.status = queryParsed.data.status;

    // Support both tag (ID) and tagName filters
    if (queryParsed.data.tag) {
      where.itemTags = { some: { tagId: queryParsed.data.tag } };
    } else if (queryParsed.data.tagName) {
      where.itemTags = { some: { tag: { name: queryParsed.data.tagName } } };
    }

    // Get total count for pagination metadata
    const total = await prisma.item.count({ where });

    const items = await prisma.item.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      skip: queryParsed.data.offset,
      take: queryParsed.data.limit,
      include: { itemTags: { include: { tag: { select: { id: true, name: true } } } } },
    });

    return res.json({
      items: items.map(mapItemForPublic),
      pagination: {
        limit: queryParsed.data.limit,
        offset: queryParsed.data.offset,
        total,
      },
    });
  }),
);

publicRouter.get(
  '/wishlists/:slug',
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
        items: {
          orderBy: [{ createdAt: 'desc' }],
          include: {
            itemTags: { include: { tag: { select: { id: true, name: true } } } },
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
      },
      items: wishlist.items.map(mapItemForPublic),
      tags: wishlist.tags,
    });
  }),
);

publicRouter.post(
  '/items/:id/reserve',
  writeLimiter,
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
        include: { itemTags: { include: { tag: { select: { id: true, name: true } } } } },
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
  writeLimiter,
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
      if (lastEvent.actorHash !== parsed.data.actorHash) return { kind: 'forbidden' as const };

      const updated = await tx.item.update({
        where: { id },
        data: { status: 'AVAILABLE' },
        include: { itemTags: { include: { tag: { select: { id: true, name: true } } } } },
      });

      await tx.reservationEvent.create({
        data: {
          itemId: id,
          type: 'UNRESERVED',
          actorHash: parsed.data.actorHash,
          comment: null,
        },
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
  writeLimiter,
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
        include: { itemTags: { include: { tag: { select: { id: true, name: true } } } } },
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
privateRouter.use(auditLog);

privateRouter.get(
  '/wishlists',
  asyncHandler(async (req, res) => {
    const owner = await getRequestOwner(req);

    const wishlists = await prisma.wishlist.findMany({
      where: { ownerId: owner.id },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { items: true, tags: true } },
      },
    });

    return res.json({ wishlists });
  }),
);

privateRouter.post(
  '/wishlists',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        title: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        slug: z.string().min(1).max(80).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const owner = await getRequestOwner(req);
    const slug = parsed.data.slug
      ? slugify(parsed.data.slug).slice(0, 80) || `list-${randomSuffix(6)}`
      : await generateUniqueSlug(parsed.data.title);
    const existing = await prisma.wishlist.findUnique({ where: { slug } });
    if (existing) {
      if (existing.ownerId !== owner.id) return res.status(409).json({ error: 'Slug already taken' });
      return res.status(200).json({
        wishlist: {
          id: existing.id,
          slug: existing.slug,
          title: existing.title,
          description: existing.description,
        },
      });
    }

    const wishlist = await prisma.wishlist.create({
      data: {
        slug,
        ownerId: owner.id,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
      },
      select: { id: true, slug: true, title: true, description: true },
    });

    return res.status(201).json({ wishlist });
  }),
);

// PATCH/DELETE wishlists and POST :id/items - allow only if owner matches (for bot: telegram user)
privateRouter.use(
  '/wishlists/:id',
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const id = req.params.id ?? '';
    if (!id) return next();
    const owner = await getRequestOwner(req);
    const list = await prisma.wishlist.findUnique({ where: { id }, select: { ownerId: true } });
    if (list && list.ownerId !== owner.id) return res.status(403).json({ error: 'Forbidden' });
    return next();
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
        select: { id: true, slug: true, title: true, description: true },
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
        id: true,
        wishlistId: true,
        title: true,
        url: true,
        priceText: true,
        commentOwner: true,
        priority: true,
        deadline: true,
        imageUrl: true,
        status: true,
        createdAt: true,
        updatedAt: true,
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
          v.title !== undefined ||
          v.url !== undefined ||
          v.priceText !== undefined ||
          v.commentOwner !== undefined ||
          v.priority !== undefined ||
          v.deadline !== undefined ||
          v.imageUrl !== undefined ||
          v.status !== undefined,
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
          ...(parsed.data.commentOwner !== undefined
            ? { commentOwner: parsed.data.commentOwner }
            : {}),
          ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
          ...(parsed.data.deadline !== undefined
            ? { deadline: parsed.data.deadline ? new Date(parsed.data.deadline) : null }
            : {}),
          ...(parsed.data.imageUrl !== undefined ? { imageUrl: parsed.data.imageUrl } : {}),
          ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        },
        select: {
          id: true,
          wishlistId: true,
          title: true,
          url: true,
          priceText: true,
          commentOwner: true,
          priority: true,
          deadline: true,
          imageUrl: true,
          status: true,
          createdAt: true,
          updatedAt: true,
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

privateRouter.post(
  '/wishlists/:id/tags',
  asyncHandler(async (req, res) => {
    const wishlistId = req.params.id ?? '';
    if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });
    const parsed = z
      .object({ name: z.string().min(1).max(64) })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const wishlist = await prisma.wishlist.findUnique({
      where: { id: wishlistId },
      select: { id: true },
    });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });

    const tag = await prisma.tag.create({
      data: { wishlistId, name: parsed.data.name },
      select: { id: true, wishlistId: true, name: true, createdAt: true },
    });

    return res.status(201).json({ tag });
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

app.use('/public', publicRouter);
app.use(privateRouter);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err: err instanceof Error ? err.message : err }, 'Unhandled error');

  // Keep error output predictable for the client.
  return res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'API server started');
});
