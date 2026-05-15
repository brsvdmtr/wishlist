import { PrismaClient } from '@wishlist/db';

let prisma: PrismaClient | null = null;

export function getTestPrisma(): PrismaClient {
  if (!prisma) {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set. Integration tests need a real Postgres connection.\n' +
          'Local: see apps/api/test/README.md.\n' +
          'CI: GitHub Actions postgres service sets it automatically.',
      );
    }
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  }
  return prisma;
}

const TRUNCATE_TABLES_SQL = `
  DO $$ DECLARE
    r RECORD;
  BEGIN
    FOR r IN (
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
    ) LOOP
      EXECUTE 'TRUNCATE TABLE "' || r.tablename || '" RESTART IDENTITY CASCADE';
    END LOOP;
  END $$;
`;

export async function resetDb(): Promise<void> {
  const db = getTestPrisma();
  await db.$executeRawUnsafe(TRUNCATE_TABLES_SQL);
}

export async function disconnectTestPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}
