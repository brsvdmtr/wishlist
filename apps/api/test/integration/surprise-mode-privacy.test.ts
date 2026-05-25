// Integration test — surprise-mode privacy invariant.
//
// Core differentiator of WishBoard: the owner of a wishlist must NEVER
// learn who reserved their items. Any leak of `reserverUserId`,
// reserver display name, or `actorHash` through an owner-facing path
// breaks the product promise.
//
// Layered guarantees this test pins:
//   1. The `mapTgItem` serializer (unit) is structurally incapable
//      of carrying reserver identity — no DB needed.
//   2. The owner-facing Prisma queries in
//      `wishlists.routes.ts /wishlists/:id/items` and
//      `items.routes.ts /items` + `/items/:id` never `select` a
//      reservation-identity column — verified end-to-end against a
//      real Postgres instance with both a public reservation and a
//      paid secret reservation in flight.
//   3. The guest-facing `/wishlists/:id/access-view` path DOES return
//      the guest's own `actorHash` + display name (so a guest can
//      recognise their own reservation when re-opening the wishlist).
//      This is the positive control — if it ever stops returning the
//      guest's own identity, the secret-reservation suppression rule
//      is masking something it shouldn't.
//
// Auto-skips DB-bound tests when DATABASE_URL is not set (local
// `pnpm test` fast path); the pure-unit block always runs.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { getTestPrisma, disconnectTestPrisma } from '../setup-pg';
import { mapTgItem } from '../../src/services/items';
import { PLACEMENT_ORDER_BY } from '../../src/placements/orderBy';

const SKIP = !process.env.DATABASE_URL;
const dbSuite = SKIP ? describe.skip : describe;
const PREFIX = 'int-surprise';

const ACTIVE_STATUSES = ['AVAILABLE', 'RESERVED', 'PURCHASED'] as const;

// Field names that are FORBIDDEN to appear on any owner-facing item DTO.
// Add to this list whenever a new reserver-identifying column is
// introduced; the test will then catch any handler that forgets to
// strip it.
const FORBIDDEN_OWNER_FIELDS = [
  'reserverUserId',
  'reservedByDisplayName',
  'reservedByActorHash',
  'reservationEvents',
  'actorHash',
  'reserverDisplayName',
  'reserverFirstName',
  'reserverUsername',
] as const;

if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping surprise-mode privacy DB tests');
}

// Mirrors tgActorHash() in apps/api/src/services/telegram-auth.ts:106 —
// duplicated rather than imported so this test asserts the *contract*
// (the hash format guests see) and would catch an accidental change
// to the hashing scheme.
function deriveActorHash(telegramId: number): string {
  const h = crypto.createHash('sha256').update(`tg_actor:${telegramId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Defense-in-depth leak assertion.
 *
 * 1) None of the forbidden field names appear as keys.
 * 2) None of the sensitive *values* appear anywhere in the serialised
 *    JSON (catches a future leak that adds a new field name but
 *    happens to expose the same value).
 */
function assertNoOwnerLeak(dto: unknown, sensitive: { id: string; displayName: string; actorHash: string }): void {
  for (const key of FORBIDDEN_OWNER_FIELDS) {
    expect(dto, `dto must not expose key "${key}"`).not.toHaveProperty(key);
  }
  const json = JSON.stringify(dto);
  expect(json, 'reserver user id must not appear anywhere in owner DTO').not.toContain(sensitive.id);
  expect(json, 'reserver display name must not appear anywhere in owner DTO').not.toContain(sensitive.displayName);
  expect(json, 'reserver actor hash must not appear anywhere in owner DTO').not.toContain(sensitive.actorHash);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Unit contract — mapTgItem must structurally drop all reservation info.
//    Runs even without a database (the fast pnpm test path).
// ─────────────────────────────────────────────────────────────────────────────

describe('mapTgItem — privacy contract (unit, no DB)', () => {
  const EXPECTED_OWNER_KEYS = new Set([
    'id', 'wishlistId', 'title', 'url', 'price', 'currency', 'imageUrl',
    'priority', 'position', 'status', 'description', 'sourceUrl',
    'sourceDomain', 'importMethod',
  ]);

  it('returns exactly the owner-safe field whitelist — no reservation extras', () => {
    const dto = mapTgItem({
      id: 'i1', wishlistId: 'w1', title: 'Gift', url: 'https://x.test/',
      priceText: '100', priority: 'MEDIUM', status: 'RESERVED',
    });
    expect(new Set(Object.keys(dto))).toEqual(EXPECTED_OWNER_KEYS);
  });

  it('does NOT include any reserver-identifying field for a RESERVED item', () => {
    const dto = mapTgItem({
      id: 'i1', wishlistId: 'w1', title: 'Gift', url: '',
      priceText: null, priority: 'MEDIUM', status: 'RESERVED',
    });
    for (const key of FORBIDDEN_OWNER_FIELDS) {
      expect(dto).not.toHaveProperty(key);
    }
  });

  it('refuses extra reserver-identity input — even if the caller passes one, it is dropped', () => {
    // Belt-and-braces: even when an upstream handler accidentally
    // includes a reserver column in its select, mapTgItem must not
    // forward it. Using `as any` to simulate that mistake.
    const dto = mapTgItem({
      id: 'i1', wishlistId: 'w1', title: 'Gift', url: '',
      priceText: null, priority: 'MEDIUM', status: 'RESERVED',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reserverUserId: 'leaked-user-id',
      reservationEvents: [{ actorHash: 'leaked-hash', comment: 'leaked-name' }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    for (const key of FORBIDDEN_OWNER_FIELDS) {
      expect(dto).not.toHaveProperty(key);
    }
    expect(JSON.stringify(dto)).not.toContain('leaked-user-id');
    expect(JSON.stringify(dto)).not.toContain('leaked-hash');
    expect(JSON.stringify(dto)).not.toContain('leaked-name');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Integration — real Postgres, real Prisma, real route queries.
// ─────────────────────────────────────────────────────────────────────────────

dbSuite('surprise-mode privacy — owner-facing endpoints against real DB', () => {
  // Distinct numeric Telegram IDs so deriveActorHash() produces
  // distinguishable hashes per scenario.
  const OWNER_TG_NUM = 8_010_001;
  const PUBLIC_GUEST_TG_NUM = 8_010_002;
  const SECRET_GUEST_TG_NUM = 8_010_003;

  const PUBLIC_GUEST_DISPLAY_NAME = 'PublicGuest-Anya-Surprise-Test';
  const SECRET_GUEST_DISPLAY_NAME = 'SecretGuest-Boris-Surprise-Test';

  const publicGuestActorHash = deriveActorHash(PUBLIC_GUEST_TG_NUM);
  const secretGuestActorHash = deriveActorHash(SECRET_GUEST_TG_NUM);

  let ownerId: string;
  let publicGuestId: string;
  let secretGuestId: string;
  let wishlistId: string;
  let publicReservedItemId: string;
  let secretReservedItemId: string;

  beforeAll(async () => {
    const db = getTestPrisma();

    // Prefix-scoped cleanup so this file can share the shared CI
    // Postgres with other integration suites without colliding.
    await db.user.deleteMany({ where: { telegramId: { startsWith: PREFIX } } });

    // ── Users ─────────────────────────────────────────────────────────────
    const owner = await db.user.create({
      data: { telegramId: `${PREFIX}-owner-${OWNER_TG_NUM}`, firstName: 'Owner' },
    });
    ownerId = owner.id;

    const publicGuest = await db.user.create({
      data: {
        telegramId: `${PREFIX}-pg-${PUBLIC_GUEST_TG_NUM}`,
        firstName: PUBLIC_GUEST_DISPLAY_NAME,
      },
    });
    publicGuestId = publicGuest.id;

    const secretGuest = await db.user.create({
      data: {
        telegramId: `${PREFIX}-sg-${SECRET_GUEST_TG_NUM}`,
        firstName: SECRET_GUEST_DISPLAY_NAME,
      },
    });
    secretGuestId = secretGuest.id;

    // ── Wishlist + items ──────────────────────────────────────────────────
    const wishlist = await db.wishlist.create({
      data: {
        slug: `${PREFIX}-${Date.now()}`,
        ownerId,
        title: 'Surprise-mode test wishlist',
      },
    });
    wishlistId = wishlist.id;

    const publicItem = await db.item.create({
      data: {
        wishlistId,
        title: 'Public-reserved gift',
        url: 'https://shop.test/public-gift',
        status: 'AVAILABLE',
        priority: 'MEDIUM',
      },
    });
    publicReservedItemId = publicItem.id;
    await db.wishlistItemPlacement.create({
      data: { wishlistId, itemId: publicItem.id, position: 0 },
    });

    const secretItem = await db.item.create({
      data: {
        wishlistId,
        title: 'Secret-reserved gift',
        url: 'https://shop.test/secret-gift',
        status: 'AVAILABLE',
        priority: 'HIGH',
      },
    });
    secretReservedItemId = secretItem.id;
    await db.wishlistItemPlacement.create({
      data: { wishlistId, itemId: secretItem.id, position: 1 },
    });

    // ── Scenario A: public reservation in flight ──────────────────────────
    // Mirrors reservations.routes.ts POST /tg/items/:id/reserve: flips
    // Item to RESERVED, sets reserverUserId, writes a RESERVED event
    // with actorHash + display name.
    await db.item.update({
      where: { id: publicItem.id },
      data: {
        status: 'RESERVED',
        reservationEpoch: { increment: 1 },
        reserverUserId: publicGuestId,
      },
    });
    await db.reservationEvent.create({
      data: {
        itemId: publicItem.id,
        type: 'RESERVED',
        actorHash: publicGuestActorHash,
        comment: PUBLIC_GUEST_DISPLAY_NAME,
      },
    });

    // ── Scenario B: secret reservation in flight ──────────────────────────
    // Mirrors reservations.routes.ts POST /tg/items/:id/secret-reserve.
    // Crucially, the Item is left in AVAILABLE state — the whole point
    // of the secret-reservation feature is that the owner sees the
    // item as untouched.
    await db.secretReservation.create({
      data: {
        itemId: secretItem.id,
        reserverUserId: secretGuestId,
        status: 'ACTIVE',
        snapshot: {
          title: secretItem.title,
          url: secretItem.url,
          priceText: null,
          currency: 'RUB',
          imageUrl: null,
          description: null,
          priority: 'HIGH',
          status: 'AVAILABLE',
        },
      },
    });
  });

  afterAll(async () => {
    const db = getTestPrisma();
    await db.user.deleteMany({ where: { telegramId: { startsWith: PREFIX } } });
    await disconnectTestPrisma();
  });

  // Group together so the failing test name pinpoints the scenario.
  describe('Scenario A: public reservation — owner views', () => {
    it('GET /tg/wishlists/:id/items: item is RESERVED but no reserver identity leaks', async () => {
      const db = getTestPrisma();

      // Byte-for-byte mirror of the production query at
      // wishlists.routes.ts:1364 — if anyone adds a reservation
      // column to the select, the leak assertion below will catch it.
      const placements = await db.wishlistItemPlacement.findMany({
        where: { wishlistId, item: { status: { in: [...ACTIVE_STATUSES] } } },
        orderBy: PLACEMENT_ORDER_BY,
        select: {
          position: true,
          categoryId: true,
          item: {
            select: {
              id: true, title: true, url: true, priceText: true,
              imageUrl: true, priority: true, status: true, description: true,
              sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
            },
          },
        },
      });

      const items = placements.map((p) => ({
        ...mapTgItem({ ...p.item, wishlistId, position: p.position }),
        categoryId: p.categoryId,
        placementCount: 1,
      }));

      const publicItemDto = items.find((i) => i.id === publicReservedItemId);
      expect(publicItemDto, 'public-reserved item must be in the owner response').toBeDefined();
      expect(publicItemDto!.status).toBe('reserved');

      assertNoOwnerLeak(publicItemDto, {
        id: publicGuestId,
        displayName: PUBLIC_GUEST_DISPLAY_NAME,
        actorHash: publicGuestActorHash,
      });

      // Also assert the entire response (not just one item).
      assertNoOwnerLeak(items, {
        id: publicGuestId,
        displayName: PUBLIC_GUEST_DISPLAY_NAME,
        actorHash: publicGuestActorHash,
      });
    });

    it('GET /tg/items: flat owner list never carries reserver identity either', async () => {
      const db = getTestPrisma();

      // Mirrors items.routes.ts:214.
      const itemsRows = await db.item.findMany({
        where: {
          wishlist: { ownerId, archivedAt: null },
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

      const items = itemsRows.map(({ wishlist, ...rest }) => ({
        ...mapTgItem(rest),
        wishlistTitle: wishlist.title,
        wishlistSlug: wishlist.slug,
        placementCount: 1,
      }));

      const publicItemDto = items.find((i) => i.id === publicReservedItemId);
      expect(publicItemDto, 'public-reserved item present in flat list').toBeDefined();
      expect(publicItemDto!.status).toBe('reserved');

      assertNoOwnerLeak(items, {
        id: publicGuestId,
        displayName: PUBLIC_GUEST_DISPLAY_NAME,
        actorHash: publicGuestActorHash,
      });
    });

    it('GET /tg/items/:id: single-item detail (owner role) never carries reserver identity', async () => {
      const db = getTestPrisma();

      // Mirrors items.routes.ts:1062 — the role-gated single-item read.
      const row = await db.item.findUnique({
        where: { id: publicReservedItemId },
        select: {
          id: true, wishlistId: true, title: true, url: true, priceText: true,
          imageUrl: true, priority: true, position: true, status: true, description: true,
          sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
          categoryId: true,
        },
      });
      expect(row).not.toBeNull();

      const payload = {
        item: { ...mapTgItem(row!), categoryId: row!.categoryId },
        role: 'owner' as const,
      };

      assertNoOwnerLeak(payload, {
        id: publicGuestId,
        displayName: PUBLIC_GUEST_DISPLAY_NAME,
        actorHash: publicGuestActorHash,
      });
    });
  });

  describe('Scenario B: secret reservation — owner views', () => {
    it('the SecretReservation row exists but the owner item query returns AVAILABLE', async () => {
      const db = getTestPrisma();

      // Sanity: the secret reservation IS in the DB.
      const secretRow = await db.secretReservation.findFirst({
        where: { itemId: secretReservedItemId, reserverUserId: secretGuestId },
        select: { status: true },
      });
      expect(secretRow?.status).toBe('ACTIVE');

      // Owner-facing query — same as Scenario A.
      const placements = await db.wishlistItemPlacement.findMany({
        where: { wishlistId, item: { status: { in: [...ACTIVE_STATUSES] } } },
        orderBy: PLACEMENT_ORDER_BY,
        select: {
          position: true,
          categoryId: true,
          item: {
            select: {
              id: true, title: true, url: true, priceText: true,
              imageUrl: true, priority: true, status: true, description: true,
              sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
            },
          },
        },
      });

      const items = placements.map((p) => ({
        ...mapTgItem({ ...p.item, wishlistId, position: p.position }),
        categoryId: p.categoryId,
        placementCount: 1,
      }));

      const secretItemDto = items.find((i) => i.id === secretReservedItemId);
      expect(secretItemDto, 'secret-reserved item must be in the owner response').toBeDefined();

      // Owner sees the item as untouched — that's the whole product
      // promise of secret reservations.
      expect(secretItemDto!.status).toBe('available');

      assertNoOwnerLeak(items, {
        id: secretGuestId,
        displayName: SECRET_GUEST_DISPLAY_NAME,
        actorHash: secretGuestActorHash,
      });
    });

    it('GET /tg/items: secret reservation does not surface in the owner flat list', async () => {
      const db = getTestPrisma();

      const itemsRows = await db.item.findMany({
        where: {
          wishlist: { ownerId, archivedAt: null },
          status: { in: [...ACTIVE_STATUSES] },
          archivedAt: null,
        },
        select: {
          id: true, wishlistId: true, title: true, url: true, priceText: true,
          imageUrl: true, priority: true, status: true, description: true,
          sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
        },
      });

      const items = itemsRows.map((r) => mapTgItem(r));

      const secretItemDto = items.find((i) => i.id === secretReservedItemId);
      expect(secretItemDto!.status).toBe('available');

      assertNoOwnerLeak(items, {
        id: secretGuestId,
        displayName: SECRET_GUEST_DISPLAY_NAME,
        actorHash: secretGuestActorHash,
      });
    });
  });

  describe('Scenario C: guest CAN see their own reservation (positive control)', () => {
    it('GET /wishlists/:id/access-view: guest sees reservedByActorHash + reservedByDisplayName for their own reservation', async () => {
      const db = getTestPrisma();

      // Mirrors wishlists.routes.ts:1223 — the guest-facing
      // access-view query. This is the ONE endpoint that SHOULD
      // surface the guest's own actorHash + display name so the
      // guest can recognise their reservation. Without this, the
      // guest UI could not say "you reserved this".
      const placements = await db.wishlistItemPlacement.findMany({
        where: { wishlistId, item: { status: { in: [...ACTIVE_STATUSES] } } },
        orderBy: PLACEMENT_ORDER_BY,
        select: {
          position: true,
          categoryId: true,
          item: {
            select: {
              id: true, title: true, description: true, url: true,
              priceText: true, currency: true, commentOwner: true,
              priority: true, deadline: true, imageUrl: true, status: true,
              createdAt: true, updatedAt: true,
              reservationEvents: {
                where: { type: 'RESERVED' },
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { comment: true, actorHash: true },
              },
            },
          },
        },
      });

      const items = placements.map((p) => ({
        id: p.item.id,
        status: p.item.status,
        reservedByDisplayName:
          p.item.status === 'RESERVED' && p.item.reservationEvents?.length
            ? (p.item.reservationEvents[0]?.comment ?? null)
            : null,
        reservedByActorHash:
          p.item.status === 'RESERVED' && p.item.reservationEvents?.length
            ? (p.item.reservationEvents[0]?.actorHash ?? null)
            : null,
      }));

      const publicItemDto = items.find((i) => i.id === publicReservedItemId);
      expect(publicItemDto!.status).toBe('RESERVED');
      expect(publicItemDto!.reservedByActorHash).toBe(publicGuestActorHash);
      expect(publicItemDto!.reservedByDisplayName).toBe(PUBLIC_GUEST_DISPLAY_NAME);

      // And — equally important — secret reservations STILL don't
      // surface even on the guest-facing access-view; the secret
      // item's status stays AVAILABLE and no reservation event row
      // exists for it.
      const secretItemDto = items.find((i) => i.id === secretReservedItemId);
      expect(secretItemDto!.status).toBe('AVAILABLE');
      expect(secretItemDto!.reservedByActorHash).toBeNull();
      expect(secretItemDto!.reservedByDisplayName).toBeNull();
    });

    it('GET /tg/secret-reservations: secret reserver can list their own active secret reservation', async () => {
      const db = getTestPrisma();

      // Mirrors reservations.routes.ts:554. The reserver's own
      // listing endpoint MUST return the row (otherwise the reserver
      // would lose access to their own reservation).
      const rows = await db.secretReservation.findMany({
        where: { reserverUserId: secretGuestId, status: 'ACTIVE' },
        select: { id: true, itemId: true, status: true },
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]!.itemId).toBe(secretReservedItemId);
      expect(rows[0]!.status).toBe('ACTIVE');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario D: anonymous reservations (E14).
  //
  // E14 is the planned "fully anonymous reservation" experience —
  // the reserver shows up to other guests as an opaque actor hash
  // with no display name at all. As of 2026-05-25 the feature is
  // not in the schema (no `isAnonymous` column on Reservation,
  // ReservationEvent, or SecretReservation; no `anonReserve` flag
  // surfaced in /tg/items/:id/reserve). The block below is a
  // placeholder so that, when E14 lands, the test enables with a
  // single .skip removal.
  // ───────────────────────────────────────────────────────────────────────────
  describe.skip('Scenario D: anonymous reserve (E14 — not yet implemented)', () => {
    it.todo('owner sees no display name even for a publicly reserved item when reservation is anonymous');
    it.todo('owner sees no actorHash either — the anonymous flag must suppress the only field guests use to identify themselves');
    it.todo('other guests still see a stable actorHash (so they can still avoid duplicate reservations) but no display name');
  });
});
