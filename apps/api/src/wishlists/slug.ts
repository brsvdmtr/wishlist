// Wishlist slug generation. Two-step:
//   1. slugify(title) — lowercase, ASCII alnum, hyphen-collapsed, trimmed.
//   2. generateUniqueSlug — slugify base, append a 6-char base64url suffix,
//      collide-check against Wishlist.slug, retry up to 10 times. Falls back
//      to base + 8-char UUID slice if all 10 attempts collide.
//
// Empty/non-ASCII titles fall through to the literal slug 'list'. The 24-char
// truncation on the base keeps the final slug under ~31 chars (24 + '-' + 6).

import crypto from 'node:crypto';
import { prisma } from '@wishlist/db';

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

export async function generateUniqueSlug(title: string) {
  const base = slugify(title).slice(0, 24);
  for (let i = 0; i < 10; i++) {
    const candidate = `${base}-${randomSuffix(6)}`;
    const existing = await prisma.wishlist.findUnique({ where: { slug: candidate } });
    if (!existing) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}
