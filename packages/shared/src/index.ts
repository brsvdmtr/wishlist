import { z } from 'zod';

export const WishlistItemSchema = z.object({
  title: z.string().min(1),
  url: z.string().url().optional(),
  note: z.string().max(2000).optional(),
});

export type WishlistItemInput = z.infer<typeof WishlistItemSchema>;
