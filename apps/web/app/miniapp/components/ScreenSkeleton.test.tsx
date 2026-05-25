import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ScreenSkeleton } from './ScreenSkeleton';

describe('ScreenSkeleton', () => {
  it('renders an aria-busy status region so screen readers announce loading', () => {
    const { container } = render(<ScreenSkeleton />);
    const root = container.querySelector('[role="status"]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute('aria-busy')).toBe('true');
  });

  it('default variant (list) renders the row pattern', () => {
    const { container } = render(<ScreenSkeleton />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(3);
  });

  it('form variant renders form-like blocks', () => {
    const { container } = render(<ScreenSkeleton variant="form" />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(3);
  });

  it('calendar variant renders calendar layout', () => {
    const { container } = render(<ScreenSkeleton variant="calendar" />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(3);
  });

  it('settings variant renders settings rows', () => {
    const { container } = render(<ScreenSkeleton variant="settings" />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(3);
  });

  it('uses theme CSS variable for background so it adapts to active accent', () => {
    const { container } = render(<ScreenSkeleton />);
    const block = container.querySelector('.animate-pulse') as HTMLElement;
    expect(block.style.background).toContain('--wb-surface');
  });
});
