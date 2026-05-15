import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SnowflakeOverlay } from './SnowflakeOverlay';

describe('SnowflakeOverlay', () => {
  it('renders 7 hardcoded snowflakes (no Math.random)', () => {
    const { container } = render(<SnowflakeOverlay />);
    const flakes = container.querySelectorAll('.snowflake');
    expect(flakes.length).toBe(7);
  });

  it('container has pointer-events:none (purely decorative band)', () => {
    const { container } = render(<SnowflakeOverlay />);
    const div = container.firstChild as HTMLElement;
    expect(div.style.pointerEvents).toBe('none');
    expect(div.style.userSelect).toBe('none');
  });

  it('container height defaults to 72', () => {
    const { container } = render(<SnowflakeOverlay />);
    const div = container.firstChild as HTMLElement;
    expect(div.style.height).toBe('72px');
  });

  it('container height honours override prop', () => {
    const { container } = render(<SnowflakeOverlay height={120} />);
    const div = container.firstChild as HTMLElement;
    expect(div.style.height).toBe('120px');
  });

  it('each snowflake has CSS animation keyframe reference', () => {
    const { container } = render(<SnowflakeOverlay />);
    const flakes = Array.from(container.querySelectorAll('.snowflake')) as HTMLElement[];
    for (const f of flakes) {
      expect(f.style.animation).toContain('snowfall');
    }
  });

  it('snowflakes render the ❄ character (not an image)', () => {
    const { container } = render(<SnowflakeOverlay />);
    const flake = container.querySelector('.snowflake') as HTMLElement;
    expect(flake.textContent).toBe('❄');
  });

  it('container has overflow:hidden so flakes that drift past the band are clipped', () => {
    const { container } = render(<SnowflakeOverlay />);
    const div = container.firstChild as HTMLElement;
    expect(div.style.overflow).toBe('hidden');
  });
});
