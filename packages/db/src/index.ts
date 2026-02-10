import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { __wishlistPrisma?: PrismaClient };

// Ensure a single PrismaClient instance in dev (hot reload, ts-node-dev).
export const prisma = globalForPrisma.__wishlistPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__wishlistPrisma = prisma;
}

export { PrismaClient };

