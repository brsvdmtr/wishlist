/**
 * Item sort logic — single source of truth shared between Prisma orderBy and unit tests.
 * No external dependencies so it can be imported in tests without mocking Prisma/Express.
 */

/** Prisma orderBy array — mirrors sortItemsJs logic. */
export const ITEM_ORDER_BY = [
  { priority: 'desc' as const },
  { position: 'asc' as const },     // manual order within priority group
  { createdAt: 'desc' as const },   // fallback for equal positions
  { id: 'desc' as const },
];

export const PRIORITY_RANK: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
export const ACTIVE_STATUS_SET = new Set<string>(['AVAILABLE', 'RESERVED', 'PURCHASED']);

export type SortableItem = {
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  position: number;
  createdAt: Date;
  id: string;
  status: string;
};

/**
 * Pure JS sort that mirrors ITEM_ORDER_BY:
 * 1. Active items before archived (COMPLETED/DELETED)
 * 2. Priority DESC (HIGH → MEDIUM → LOW)
 * 3. position ASC (manual order within priority group)
 * 4. createdAt DESC (fallback)
 * 5. id DESC (stable tiebreaker)
 */
export function sortItemsJs<T extends SortableItem>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aActive = ACTIVE_STATUS_SET.has(a.status) ? 0 : 1;
    const bActive = ACTIVE_STATUS_SET.has(b.status) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;

    const pDiff = (PRIORITY_RANK[b.priority] ?? 1) - (PRIORITY_RANK[a.priority] ?? 1);
    if (pDiff !== 0) return pDiff;

    const posDiff = a.position - b.position;
    if (posDiff !== 0) return posDiff;

    const cDiff = b.createdAt.getTime() - a.createdAt.getTime();
    if (cDiff !== 0) return cDiff;

    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
  });
}
