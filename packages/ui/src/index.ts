/**
 * @wishlist/ui — UI primitives for WishBoard.
 *
 * Use these components for ALL new UI. Do not create feature-local
 * variants of these patterns. If a new pattern is required, extend
 * this package first (and document in docs/design-system/COMPONENTS.md).
 *
 * v2.1 refresh (2026-04-21) introduces glass surfaces + runtime
 * theme/accent switching via `ThemeProvider`. See
 * `docs/design-system/mockups/approved/v2.1-refresh-all-screens.html`.
 *
 * Registry: `docs/design-system/COMPONENT_REGISTRY.md`.
 */

// Core primitives (v2 — updated for v2.1 glass + CSS-var consumption)
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

// v2.1 refresh primitives (2026-04-21, all `provisional` until validated in prod)
export {
  ThemeProvider,
  useTheme,
  type ThemeContextValue,
  type ThemeProviderProps,
  type ThemePreference,
  type UpsellReason,
} from './ThemeProvider';
export { FloatingNav, type FloatingNavProps, type FloatingNavItem } from './FloatingNav';
export { HeroCard, type HeroCardProps, type HeroCardTone } from './HeroCard';
export { AccentSwatch, type AccentSwatchProps, type SwatchKind } from './AccentSwatch';
export { StickyCTAFade, type StickyCTAFadeProps } from './StickyCTAFade';
