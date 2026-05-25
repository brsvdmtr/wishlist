/**
 * Tests for `Skeleton` primitive in @wishlist/ui.
 *
 * Lives in `apps/web/test/` rather than `packages/ui/` because there's no
 * vitest+RTL infrastructure in the ui package yet — every primitive in
 * `@wishlist/ui` is currently consumer-tested from `apps/web`.
 *
 * The variant-shape assertions matter: a regression that makes every
 * variant render identically (count-only test passing) would silently
 * destroy the visual layout-stability contract that justifies multiple
 * variants in the first place.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Skeleton } from '@wishlist/ui';

function shimmerBlocks(container: HTMLElement): HTMLElement[] {
  // Skeleton blocks are the only animated div children — animation token
  // string contains `skeletonShimmer`.
  return Array.from(container.querySelectorAll('div')).filter((el) => {
    return (el as HTMLElement).style.animation?.includes('skeletonShimmer');
  }) as HTMLElement[];
}

function rootStyle(container: HTMLElement): CSSStyleDeclaration {
  const root = container.querySelector('[role="status"]') as HTMLElement;
  return root.style;
}

describe('Skeleton — a11y contract', () => {
  it('renders an aria-busy status region in every variant', () => {
    for (const variant of ['list', 'form', 'calendar', 'settings'] as const) {
      const { container } = render(<Skeleton variant={variant} />);
      const root = container.querySelector('[role="status"]');
      expect(root, `variant=${variant}`).not.toBeNull();
      // React serializes boolean `aria-busy={true}` to the string "true".
      expect(root?.getAttribute('aria-busy'), `variant=${variant}`).toBe('true');
    }
  });

  it('default aria-label is "Loading" (fallback for pre-locale render)', () => {
    const { container } = render(<Skeleton />);
    const root = container.querySelector('[role="status"]') as HTMLElement;
    expect(root.getAttribute('aria-label')).toBe('Loading');
  });

  it('accepts a localized label override', () => {
    const { container } = render(<Skeleton label="Загрузка" />);
    const root = container.querySelector('[role="status"]') as HTMLElement;
    expect(root.getAttribute('aria-label')).toBe('Загрузка');
  });
});

describe('Skeleton — layout-stability contract', () => {
  it('reserves at least 320px min-height so the parent layout does not collapse', () => {
    const { container } = render(<Skeleton />);
    expect(rootStyle(container).minHeight).toBe('320px');
  });

  it('list variant renders 1 header + 4 list rows (= 1 + 4·3 blocks = 13 shimmers)', () => {
    const { container } = render(<Skeleton variant="list" />);
    // 1 header (40% × 28) + 4 rows × (1 avatar + 2 text lines) = 13
    expect(shimmerBlocks(container)).toHaveLength(13);
  });

  it('form variant renders 1 header + 3 field blocks + 1 button (= 5 shimmers)', () => {
    const { container } = render(<Skeleton variant="form" />);
    expect(shimmerBlocks(container)).toHaveLength(5);
    const heights = shimmerBlocks(container).map((el) => el.style.height);
    expect(heights).toContain('56px');  // input field
    expect(heights).toContain('120px'); // textarea
    expect(heights).toContain('44px');  // submit button
  });

  it('calendar variant renders header + 88px banner + 220px grid + day rows (8 shimmers)', () => {
    const { container } = render(<Skeleton variant="calendar" />);
    const heights = shimmerBlocks(container).map((el) => el.style.height);
    expect(heights).toContain('88px');  // banner
    expect(heights).toContain('220px'); // month grid
    // 1 header (28) + 88 + 220 + 20 + 2 rows × (1 avatar + 2 lines) = 1+1+1+1+6 = 10 blocks
    expect(shimmerBlocks(container)).toHaveLength(10);
  });

  it('settings variant renders 1 header + 4 list-row blocks of equal 64px height', () => {
    const { container } = render(<Skeleton variant="settings" />);
    const blocks = shimmerBlocks(container);
    expect(blocks).toHaveLength(5);
    const settingsRows = blocks.filter((el) => el.style.height === '64px');
    expect(settingsRows).toHaveLength(4);
  });

  it('different variants produce visibly different shapes (regression for count-only tests)', () => {
    // The signature is the multi-set of heights. If a future change makes
    // every variant render the same blocks, this test catches it.
    const heightsFor = (variant: 'list' | 'form' | 'calendar' | 'settings') => {
      const { container } = render(<Skeleton variant={variant} />);
      return shimmerBlocks(container)
        .map((el) => el.style.height)
        .sort()
        .join(',');
    };
    const sigs = new Set([heightsFor('list'), heightsFor('form'), heightsFor('calendar'), heightsFor('settings')]);
    expect(sigs.size).toBe(4); // all four are distinct
  });
});

describe('Skeleton — design-system contract', () => {
  it('uses the canonical skeletonShimmer animation (not Tailwind animate-pulse)', () => {
    const { container } = render(<Skeleton />);
    const block = shimmerBlocks(container)[0];
    expect(block.style.animation).toContain('skeletonShimmer');
    // Explicit guard: must NOT use Tailwind's animate-pulse class as a substitute.
    expect(block.className).not.toContain('animate-pulse');
  });

  it('block background uses theme CSS var so accent switching propagates', () => {
    const { container } = render(<Skeleton />);
    const block = shimmerBlocks(container)[0];
    expect(block.style.background).toContain('--wb-surface');
  });

  it('block border-radius uses radius.lg (14px) from tokens', () => {
    const { container } = render(<Skeleton />);
    const block = shimmerBlocks(container)[0];
    expect(block.style.borderRadius).toBe('14px');
  });
});
