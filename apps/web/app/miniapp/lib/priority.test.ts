import { describe, expect, it } from 'vitest';
import {
  PRIO_EMOJI,
  PRIO_COLOR,
  PRIO_BG,
  PRIO_GRADIENT,
  PRIO_GLOW,
  prioEmoji,
} from './priority';

describe('priority constants', () => {
  it('PRIO_EMOJI covers all three levels', () => {
    expect(PRIO_EMOJI[1]).toBe('🙂');
    expect(PRIO_EMOJI[2]).toBe('😊');
    expect(PRIO_EMOJI[3]).toBe('😍');
  });

  it('PRIO_COLOR returns hex strings for all three levels', () => {
    expect(PRIO_COLOR[1]).toMatch(/^#[0-9A-F]{6}$/i);
    expect(PRIO_COLOR[2]).toMatch(/^#[0-9A-F]{6}$/i);
    expect(PRIO_COLOR[3]).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it('PRIO_BG returns rgba strings for all three levels', () => {
    expect(PRIO_BG[1]).toMatch(/^rgba\(/);
    expect(PRIO_BG[2]).toMatch(/^rgba\(/);
    expect(PRIO_BG[3]).toMatch(/^rgba\(/);
  });

  it('PRIO_GRADIENT returns linear-gradient strings for all three levels', () => {
    expect(PRIO_GRADIENT[1]).toMatch(/^linear-gradient/);
    expect(PRIO_GRADIENT[2]).toMatch(/^linear-gradient/);
    expect(PRIO_GRADIENT[3]).toMatch(/^linear-gradient/);
  });

  it('PRIO_GLOW returns rgba strings for all three levels', () => {
    expect(PRIO_GLOW[1]).toMatch(/^rgba\(/);
    expect(PRIO_GLOW[2]).toMatch(/^rgba\(/);
    expect(PRIO_GLOW[3]).toMatch(/^rgba\(/);
  });
});

describe('prioEmoji', () => {
  it('returns the matching emoji for known priorities', () => {
    expect(prioEmoji(1)).toBe('🙂');
    expect(prioEmoji(2)).toBe('😊');
    expect(prioEmoji(3)).toBe('😍');
  });

  it('falls back to LOW emoji for unknown priorities', () => {
    expect(prioEmoji(0)).toBe('🙂');
    expect(prioEmoji(99)).toBe('🙂');
    expect(prioEmoji(-1)).toBe('🙂');
  });
});
