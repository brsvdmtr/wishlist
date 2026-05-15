// Unit tests for schedulers/cleanup.ts — three hourly TTL/purge jobs.
//
// All three jobs share the same shape: list expired rows → delete (and
// optionally clean up associated files). Errors are swallowed by design;
// tests verify the dispatch shape + best-effort behaviour.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Logger } from 'pino';
import type { PrismaClient } from '@wishlist/db';
import { startCleanupSchedulers } from './cleanup';

const HOURLY_MS = 60 * 60 * 1000;

function fakeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

let mockPrisma: {
  comment: { deleteMany: ReturnType<typeof vi.fn> };
  curatedSelectionSubscription: { deleteMany: ReturnType<typeof vi.fn> };
  item: { findMany: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
};
let deleteUploadFile: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  mockPrisma = {
    comment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    curatedSelectionSubscription: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    item: {
      findMany: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
  deleteUploadFile = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllTimers();
});

describe('startCleanupSchedulers — comment TTL', () => {
  it('deletes comments past scheduledDeleteAt every hour', async () => {
    mockPrisma.comment.deleteMany.mockResolvedValue({ count: 3 });

    startCleanupSchedulers({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: fakeLogger(),
      deleteUploadFile,
    });

    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(mockPrisma.comment.deleteMany).toHaveBeenCalledOnce();
    const arg = mockPrisma.comment.deleteMany.mock.calls[0]![0];
    expect(arg.where.scheduledDeleteAt.lte).toBeInstanceOf(Date);
  });

  it('logs count when comments were deleted', async () => {
    mockPrisma.comment.deleteMany.mockResolvedValue({ count: 7 });
    const logger = fakeLogger();

    startCleanupSchedulers({
      prisma: mockPrisma as unknown as PrismaClient,
      logger,
      deleteUploadFile,
    });
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(logger.info).toHaveBeenCalledWith({ count: 7 }, 'ttl: cleaned expired comments');
  });

  it('does NOT log when nothing was deleted (zero-noise idle)', async () => {
    const logger = fakeLogger();

    startCleanupSchedulers({
      prisma: mockPrisma as unknown as PrismaClient,
      logger,
      deleteUploadFile,
    });
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(logger.info).not.toHaveBeenCalled();
  });

  it('swallows comment cleanup errors', async () => {
    mockPrisma.comment.deleteMany.mockRejectedValue(new Error('DB down'));
    const logger = fakeLogger();

    startCleanupSchedulers({
      prisma: mockPrisma as unknown as PrismaClient,
      logger,
      deleteUploadFile,
    });
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(logger.error).toHaveBeenCalled();
  });
});

describe('startCleanupSchedulers — curated selection subscription cleanup', () => {
  it('deletes subscriptions for expired or deactivated curated selections', async () => {
    mockPrisma.curatedSelectionSubscription.deleteMany.mockResolvedValue({ count: 4 });

    startCleanupSchedulers({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: fakeLogger(),
      deleteUploadFile,
    });
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(mockPrisma.curatedSelectionSubscription.deleteMany).toHaveBeenCalledOnce();
    const arg = mockPrisma.curatedSelectionSubscription.deleteMany.mock.calls[0]![0];
    expect(arg.where.curatedSelection.OR).toHaveLength(2);
  });
});

describe('startCleanupSchedulers — archive purge', () => {
  it('takes up to 100 items per cycle (batch limit)', async () => {
    startCleanupSchedulers({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: fakeLogger(),
      deleteUploadFile,
    });
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(mockPrisma.item.findMany).toHaveBeenCalledOnce();
    const arg = mockPrisma.item.findMany.mock.calls[0]![0];
    expect(arg.take).toBe(100);
  });

  it('exits silently when nothing is expired', async () => {
    const logger = fakeLogger();

    startCleanupSchedulers({
      prisma: mockPrisma as unknown as PrismaClient,
      logger,
      deleteUploadFile,
    });
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(mockPrisma.item.delete).not.toHaveBeenCalled();
    expect(deleteUploadFile).not.toHaveBeenCalled();
  });

  it('deletes each expired item + its image file (DB-first ordering)', async () => {
    mockPrisma.item.findMany.mockResolvedValue([
      { id: 'i1', imageUrl: '/api/uploads/x.jpg' },
      { id: 'i2', imageUrl: null },
    ]);

    startCleanupSchedulers({
      prisma: mockPrisma as unknown as PrismaClient,
      logger: fakeLogger(),
      deleteUploadFile,
    });
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(mockPrisma.item.delete).toHaveBeenCalledTimes(2);
    expect(deleteUploadFile).toHaveBeenCalledOnce(); // only i1 had imageUrl
    expect(deleteUploadFile).toHaveBeenCalledWith('/api/uploads/x.jpg');
  });

  it('continues processing other items when one item.delete fails', async () => {
    mockPrisma.item.findMany.mockResolvedValue([
      { id: 'i1', imageUrl: '/api/uploads/x.jpg' },
      { id: 'i2', imageUrl: '/api/uploads/y.jpg' },
      { id: 'i3', imageUrl: '/api/uploads/z.jpg' },
    ]);
    mockPrisma.item.delete.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === 'i2') return Promise.reject(new Error('FK violation'));
      return Promise.resolve({});
    });

    const logger = fakeLogger();
    startCleanupSchedulers({
      prisma: mockPrisma as unknown as PrismaClient,
      logger,
      deleteUploadFile,
    });
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    // i1 and i3 should have been processed; i2 failed.
    expect(deleteUploadFile).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
    // Final summary log should mention errors:1.
    const summary = (logger.info as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[1] === 'purge: done');
    expect(summary![0]).toMatchObject({ deleted: 2, files: 2, errors: 1 });
  });

  it('purge job-level error is swallowed and logged', async () => {
    mockPrisma.item.findMany.mockRejectedValue(new Error('DB hard down'));
    const logger = fakeLogger();

    startCleanupSchedulers({
      prisma: mockPrisma as unknown as PrismaClient,
      logger,
      deleteUploadFile,
    });
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(logger.error).toHaveBeenCalled();
  });
});
