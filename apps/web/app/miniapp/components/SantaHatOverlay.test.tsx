import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SantaHatOverlay } from './SantaHatOverlay';

describe('SantaHatOverlay', () => {
  it('renders an aria-hidden SVG (decorative only)', () => {
    const { container } = render(<SantaHatOverlay size={40} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('scales the SVG to ~68% width × 58% height of the parent size', () => {
    const { container } = render(<SantaHatOverlay size={100} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('68');
    expect(svg.getAttribute('height')).toBe('58');
  });

  it('rounds non-integer scaled dimensions', () => {
    const { container } = render(<SantaHatOverlay size={37} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe(String(Math.round(37 * 0.68)));
    expect(svg.getAttribute('height')).toBe(String(Math.round(37 * 0.58)));
  });

  it('has pointer-events:none + user-select:none (purely decorative)', () => {
    const { container } = render(<SantaHatOverlay size={40} />);
    const svg = container.querySelector('svg')!;
    expect(svg.style.pointerEvents).toBe('none');
    expect(svg.style.userSelect).toBe('none');
  });

  it('positioned absolute (overlays the parent avatar)', () => {
    const { container } = render(<SantaHatOverlay size={40} />);
    const svg = container.querySelector('svg')!;
    expect(svg.style.position).toBe('absolute');
  });

  it('contains the red cone polygon + white brim + pom-pom (festive shape)', () => {
    const { container } = render(<SantaHatOverlay size={40} />);
    // 2 polygons (cone + sheen) + 5 circles (4 brim dots + 2 pom-pom) + 1 rect (brim)
    expect(container.querySelectorAll('polygon').length).toBe(2);
    expect(container.querySelectorAll('rect').length).toBe(1);
    expect(container.querySelectorAll('circle').length).toBe(6);
  });
});
