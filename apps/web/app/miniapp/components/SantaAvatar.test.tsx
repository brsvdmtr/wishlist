import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SantaAvatar, santaAliasHue } from './SantaAvatar';

describe('santaAliasHue', () => {
  it('is deterministic — same input always yields same hue', () => {
    expect(santaAliasHue('Сонный жираф')).toBe(santaAliasHue('Сонный жираф'));
  });

  it('returns a hue in [0, 360) on a 10° step', () => {
    for (const alias of ['a', 'b', 'long alias here', '🦒 жираф']) {
      const hue = santaAliasHue(alias);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(hue % 10).toBe(0);
    }
  });

  it('different aliases usually produce different hues (basic distribution sanity)', () => {
    const hues = new Set<number>();
    const aliases = ['Сонный жираф', 'Весёлая лиса', 'Хитрый енот', 'Ловкая белка', 'Тихий медведь'];
    for (const a of aliases) hues.add(santaAliasHue(a));
    // At least 3 distinct hues across 5 aliases (allow some collision)
    expect(hues.size).toBeGreaterThanOrEqual(3);
  });
});

describe('SantaAvatar', () => {
  it('renders the emoji label inside the circle', () => {
    render(<SantaAvatar alias="Сонный жираф" emoji="🦒" size={40} />);
    expect(screen.getByText('🦒')).toBeInTheDocument();
  });

  it('falls back to 🎅 when emoji is empty', () => {
    render(<SantaAvatar alias="x" emoji="" size={40} />);
    expect(screen.getByText('🎅')).toBeInTheDocument();
  });

  it('background colour is set (jsdom normalises hsl→rgb but it must be set)', () => {
    const { container } = render(<SantaAvatar alias="x" emoji="🦒" size={40} />);
    const circle = container.querySelector('div')!;
    // jsdom converts hsl() to rgb() — assert non-empty + matches a colour notation
    expect(circle.style.background).toMatch(/^(hsl|rgb)\(/);
  });

  it('font size is ~55% of avatar size', () => {
    const { container } = render(<SantaAvatar alias="x" emoji="🦒" size={40} />);
    const circle = container.querySelector('div')!;
    expect(circle.style.fontSize).toBe('22px'); // round(40 * 0.55) = 22
  });

  it('without hat prop: no SVG overlay rendered', () => {
    const { container } = render(<SantaAvatar alias="x" emoji="🦒" size={40} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('with hat={true}: includes SantaHatOverlay SVG', () => {
    const { container } = render(<SantaAvatar alias="x" emoji="🦒" size={40} hat />);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('with hat={true}: wraps the circle in a position:relative container', () => {
    const { container } = render(<SantaAvatar alias="x" emoji="🦒" size={40} hat />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.position).toBe('relative');
    expect(wrapper.style.flexShrink).toBe('0');
  });

  it('honours optional border style', () => {
    const { container } = render(<SantaAvatar alias="x" emoji="🦒" size={40} border="2px solid red" />);
    const circle = container.querySelector('div')!;
    expect(circle.style.border).toBe('2px solid red');
  });

  it('same alias renders the same hue regardless of size or hat', () => {
    const { container: c1 } = render(<SantaAvatar alias="stable" emoji="🦒" size={40} />);
    const { container: c2 } = render(<SantaAvatar alias="stable" emoji="🦒" size={80} hat />);
    const bg1 = (c1.querySelector('div')!).style.background;
    // Find the inner circle in c2 (the one with a colour background, not the wrapper)
    const allDivs = Array.from(c2.querySelectorAll('div')) as HTMLElement[];
    const circleInC2 = allDivs.find((d) => /^(hsl|rgb)\(/.test(d.style.background));
    expect(circleInC2).toBeDefined();
    expect(circleInC2!.style.background).toBe(bg1);
  });
});
