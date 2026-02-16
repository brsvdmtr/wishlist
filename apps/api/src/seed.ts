import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@wishlist/db';

// Prefer app-local .env when running from repo root (pnpm seed),
// but also support running from within apps/api.
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

async function main() {
  const wishlist = await prisma.$transaction(async (tx) => {
    const owner = await tx.user.upsert({
      where: { email: (process.env.SYSTEM_USER_EMAIL ?? 'owner@local').trim() || 'owner@local' },
      update: {},
      create: { email: (process.env.SYSTEM_USER_EMAIL ?? 'owner@local').trim() || 'owner@local' },
    });

    const wl = await tx.wishlist.upsert({
      where: { slug: 'demo' },
      update: {
        title: 'Demo wishlist',
        description: 'Демо-список подарков для проверки UI и API.',
        ownerId: owner.id,
      },
      create: {
        slug: 'demo',
        title: 'Demo wishlist',
        description: 'Демо-список подарков для проверки UI и API.',
        ownerId: owner.id,
      },
      select: { id: true, slug: true },
    });

    // Reset demo contents to a known state (idempotent seed).
    await tx.item.deleteMany({ where: { wishlistId: wl.id } });
    await tx.tag.deleteMany({ where: { wishlistId: wl.id } });

    const tags = await Promise.all(
      ['вкусняхи', 'техника', 'дорого'].map((name) =>
        tx.tag.create({
          data: { wishlistId: wl.id, name },
          select: { id: true, name: true },
        }),
      ),
    );

    const tagByName = new Map(tags.map((t) => [t.name, t.id]));

    const itemsSeed = [
      {
        title: 'Кофе в зернах (1 кг)',
        url: 'https://example.com/coffee',
        priceText: '≈ 1 500 ₽',
        priority: 'MEDIUM' as const,
        commentOwner: 'Любой свежей обжарки, без ароматизаторов.',
        deadline: null as Date | null,
        tags: ['вкусняхи'],
      },
      {
        title: 'Наушники (over-ear)',
        url: 'https://example.com/headphones',
        priceText: '≈ 12 000 ₽',
        priority: 'HIGH' as const,
        commentOwner: 'Желательно с шумодавом.',
        deadline: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
        tags: ['техника', 'дорого'],
      },
      {
        title: 'Умная лампочка',
        url: 'https://example.com/bulb',
        priceText: '≈ 1 200 ₽',
        priority: 'LOW' as const,
        commentOwner: 'Под HomeKit/Google Home.',
        deadline: null as Date | null,
        tags: ['техника'],
      },
      {
        title: 'Сертификат в книжный',
        url: 'https://example.com/books',
        priceText: '≈ 3 000 ₽',
        priority: 'MEDIUM' as const,
        commentOwner: 'Любой номинал ок.',
        deadline: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14),
        tags: [],
      },
      {
        title: 'Набор шоколада',
        url: 'https://example.com/chocolate',
        priceText: '≈ 900 ₽',
        priority: 'LOW' as const,
        commentOwner: 'Горький/без изюма.',
        deadline: null as Date | null,
        tags: ['вкусняхи'],
      },
    ];

    for (const seed of itemsSeed) {
      const item = await tx.item.create({
        data: {
          wishlistId: wl.id,
          title: seed.title,
          url: seed.url,
          priceText: seed.priceText,
          priority: seed.priority,
          commentOwner: seed.commentOwner,
          deadline: seed.deadline,
          imageUrl: null,
          status: 'AVAILABLE',
        },
        select: { id: true },
      });

      for (const tagName of seed.tags) {
        const tagId = tagByName.get(tagName);
        if (!tagId) continue;
        await tx.itemTag.create({ data: { itemId: item.id, tagId } });
      }
    }

    return wl;
  });

  // eslint-disable-next-line no-console
  console.log(`[seed] ok: /public/wishlists/${wishlist.slug}`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[seed] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
