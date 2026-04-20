/**
 * @wishlist/ui — UI primitives for WishBoard.
 *
 * Use these components for ALL new UI. Do not create feature-local
 * variants of these patterns. If a new pattern is required, extend
 * this package first (and document in docs/design-system/COMPONENTS.md).
 *
 * STATUS NOTE (2026-04-19): approved v2 North Star mockups are the
 * binding visual spec. Primitives here codify that spec. All are
 * `provisional` pending real-call-site adoption validation, then
 * promoted to `canonical` per `PROMOTION_CHECKLIST.md`.
 *
 * Registry: `docs/design-system/COMPONENT_REGISTRY.md`.
 */

// Core primitives
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button';
export { Card, type CardProps, type CardVariant, type CardPadding } from './Card';
export { Sheet, type SheetProps } from './Sheet';
export { SectionHeader, type SectionHeaderProps } from './SectionHeader';
export { ListRow, type ListRowProps, type ListRowVariant, type ListRowState } from './ListRow';
export { Banner, type BannerProps, type BannerTone } from './Banner';

// Phase-2 extension primitives (codified from approved v2 mockups, 2026-04-19)
export { Chip, type ChipProps, type ChipTone, type ChipSize } from './Chip';
export { CounterBadge, type CounterBadgeProps } from './CounterBadge';
export { StatTile, type StatTileProps, type StatTileTone } from './StatTile';
export { AvatarStack, type AvatarStackProps, type AvatarEntry, type AvatarStackSize } from './AvatarStack';
export { LockedTile, type LockedTileProps } from './LockedTile';
