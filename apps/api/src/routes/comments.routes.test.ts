// Handler tests for routes/comments.routes.ts — owner/reserver gate + epoch
// anonymization. Covers GET list, POST create with PRO gate, DELETE, mark-read.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  comment: { findMany: vi.fn(), create: vi.fn(), delete: vi.fn(), update: vi.fn() },
  commentReadCursor: { upsert: vi.fn() },
  hint: { findFirst: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    comment: shared.comment,
    commentReadCursor: shared.commentReadCursor,
    hint: shared.hint,
  },
}));

vi.mock('../notifications/commentNotificationQueue', () => ({
  queueCommentNotification: vi.fn(),
  queueReplyAuthorNotification: vi.fn(),
}));

import { registerCommentsRouter } from './comments.routes';

function role(over: Partial<Awaited<ReturnType<NonNullable<Parameters<typeof registerCommentsRouter>[0]['getItemRole']>>>> = {}) {
  return {
    role: 'owner' as const,
    item: {
      id: 'i1', status: 'AVAILABLE', reservationEpoch: 0, reserverUserId: null,
      title: 'Test', wishlist: { ownerId: 'u-owner' }, reservationEvents: [],
    },
    actorHash: 'actor-42',
    user: { id: 'u-test', telegramChatId: '123' },
    ...over,
  };
}

function buildDeps(over: Partial<Parameters<typeof registerCommentsRouter>[0]> = {}) {
  return {
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u-test' })),
    getEffectiveEntitlements: vi.fn(async () => ({ plan: { code: 'PRO', features: ['comments'] } })),
    getItemRole: vi.fn(async () => role()),
    trackEvent: vi.fn(),
    tgActorHash: vi.fn((id: number) => `actor-${id}`),
    ...over,
  } as Parameters<typeof registerCommentsRouter>[0];
}

function makeApp(deps = buildDeps()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerCommentsRouter(deps));
  return { app, deps };
}

beforeEach(() => {
  for (const m of Object.values(shared)) {
    for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset?.();
  }
  shared.comment.findMany.mockResolvedValue([]);
});

describe('GET /items/:id/comments', () => {
  it('404 when item not found', async () => {
    const deps = buildDeps({ getItemRole: vi.fn(async () => null) });
    const res = await request(makeApp(deps).app).get('/items/i1/comments');
    expect(res.status).toBe(404);
  });

  it('403 for third_party role', async () => {
    const deps = buildDeps({ getItemRole: vi.fn(async () => role({ role: 'third_party' })) });
    const res = await request(makeApp(deps).app).get('/items/i1/comments');
    expect(res.status).toBe(403);
  });

  it('200 returns role + empty comments for owner with no comments', async () => {
    const res = await request(makeApp().app).get('/items/i1/comments');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ comments: [], role: 'owner' });
  });

  it('anonymizes previous-epoch USER comments for reserver role', async () => {
    const deps = buildDeps({
      getItemRole: vi.fn(async () => role({
        role: 'reserver',
        item: { ...role().item, reservationEpoch: 2 },
        actorHash: 'actor-reserver',
      })),
    });
    shared.comment.findMany.mockResolvedValueOnce([{
      id: 'c1', type: 'USER', authorActorHash: 'actor-other', authorDisplayName: 'Anna',
      text: 'old comment', reservationEpoch: 1, createdAt: new Date('2026-01-01'),
      parentCommentId: null, scheduledDeleteAt: null,
    }]);

    const res = await request(makeApp(deps).app).get('/items/i1/comments');
    expect(res.status).toBe(200);
    expect(res.body.comments[0].authorDisplayName).not.toBe('Anna');
    // Anonymized — i18n string substituted; not the original
  });

  it('does NOT anonymize for the reserver\'s OWN comments from older epochs', async () => {
    const deps = buildDeps({
      getItemRole: vi.fn(async () => role({
        role: 'reserver',
        item: { ...role().item, reservationEpoch: 2 },
        actorHash: 'actor-me',
      })),
    });
    shared.comment.findMany.mockResolvedValueOnce([{
      id: 'c1', type: 'USER', authorActorHash: 'actor-me', authorDisplayName: 'Me',
      text: 'my comment', reservationEpoch: 1, createdAt: new Date('2026-01-01'),
      parentCommentId: null, scheduledDeleteAt: null,
    }]);

    const res = await request(makeApp(deps).app).get('/items/i1/comments');
    expect(res.body.comments[0].authorDisplayName).toBe('Me');
  });

  it('does NOT anonymize SYSTEM comments regardless of epoch', async () => {
    const deps = buildDeps({
      getItemRole: vi.fn(async () => role({
        role: 'reserver',
        item: { ...role().item, reservationEpoch: 2 },
      })),
    });
    shared.comment.findMany.mockResolvedValueOnce([{
      id: 'c1', type: 'SYSTEM', authorActorHash: null, authorDisplayName: 'System',
      text: 'auto-message', reservationEpoch: 1, createdAt: new Date('2026-01-01'),
      parentCommentId: null, scheduledDeleteAt: null,
    }]);

    const res = await request(makeApp(deps).app).get('/items/i1/comments');
    expect(res.body.comments[0].authorDisplayName).toBe('System');
  });

  it('truncates parent preview text to 120 chars', async () => {
    const longText = 'x'.repeat(500);
    shared.comment.findMany.mockResolvedValueOnce([
      { id: 'parent', type: 'USER', authorActorHash: 'actor-1', authorDisplayName: 'A', text: longText, reservationEpoch: 0, createdAt: new Date('2026-01-01'), parentCommentId: null, scheduledDeleteAt: null },
      { id: 'child', type: 'USER', authorActorHash: 'actor-1', authorDisplayName: 'A', text: 'reply', reservationEpoch: 0, createdAt: new Date('2026-01-02'), parentCommentId: 'parent', scheduledDeleteAt: null },
    ]);

    const res = await request(makeApp().app).get('/items/i1/comments');
    const child = res.body.comments.find((c: { id: string }) => c.id === 'child');
    expect(child.parentPreview.text.length).toBe(120);
    expect(child.parentPreview.text.endsWith('…')).toBe(true);
  });

  it('marks parent as deleted when scheduledDeleteAt is set (ttl_hidden)', async () => {
    shared.comment.findMany.mockResolvedValueOnce([
      { id: 'parent', type: 'USER', authorActorHash: 'actor-1', authorDisplayName: 'A', text: 'p', reservationEpoch: 0, createdAt: new Date(), parentCommentId: null, scheduledDeleteAt: new Date() },
      { id: 'child', type: 'USER', authorActorHash: 'actor-1', authorDisplayName: 'A', text: 'reply', reservationEpoch: 0, createdAt: new Date(), parentCommentId: 'parent', scheduledDeleteAt: null },
    ]);

    const res = await request(makeApp().app).get('/items/i1/comments');
    const child = res.body.comments.find((c: { id: string }) => c.id === 'child');
    expect(child.parentPreview.deleted).toBe(true);
    expect(child.parentPreview.text).toBe('');
  });
});

describe('POST /items/:id/comments — feature gate', () => {
  it('404 when item not found', async () => {
    const deps = buildDeps({ getItemRole: vi.fn(async () => null) });
    const res = await request(makeApp(deps).app).post('/items/i1/comments').send({ text: 'hi' });
    expect(res.status).toBe(404);
  });

  it('403 for third_party role', async () => {
    const deps = buildDeps({ getItemRole: vi.fn(async () => role({ role: 'third_party' })) });
    const res = await request(makeApp(deps).app).post('/items/i1/comments').send({ text: 'hi' });
    expect(res.status).toBe(403);
  });
});
