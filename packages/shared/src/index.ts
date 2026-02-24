import { z } from 'zod';

// --- Enums
export const ItemStatusSchema = z.enum(['AVAILABLE', 'RESERVED', 'PURCHASED']);
export const PrioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export const ReservationTypeSchema = z.enum(['RESERVED', 'UNRESERVED', 'PURCHASED']);

export type ItemStatus = z.infer<typeof ItemStatusSchema>;
export type Priority = z.infer<typeof PrioritySchema>;
export type ReservationType = z.infer<typeof ReservationTypeSchema>;

// --- Public API response types
export const TagSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const PublicItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  priceText: z.string().nullable(),
  commentOwner: z.string().nullable(),
  priority: PrioritySchema,
  deadline: z.string().datetime().nullable(),
  imageUrl: z.string().nullable(),
  status: ItemStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  tags: z.array(TagSchema),
});

export const PublicWishlistResponseSchema = z.object({
  wishlist: z.object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    description: z.string().nullable(),
  }),
  items: z.array(PublicItemSchema),
  tags: z.array(TagSchema),
});

export type Tag = z.infer<typeof TagSchema>;
export type PublicItem = z.infer<typeof PublicItemSchema>;
export type PublicWishlistResponse = z.infer<typeof PublicWishlistResponseSchema>;

// --- Actor
export const ActorHashSchema = z.string().uuid();
