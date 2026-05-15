// Tests for emoji utilities extracted from MiniApp.tsx.

import { describe, it, expect } from 'vitest';
import { getEmoji, extractFirstEmoji, EMOJIS } from './emoji';

describe('EMOJIS corpus', () => {
  it('has exactly 20 emoji in the rotation pool', () => {
    expect(EMOJIS.length).toBe(20);
  });

  it('every entry is a non-empty string (catches stray null/undefined refactors)', () => {
    for (const e of EMOJIS) {
      expect(typeof e).toBe('string');
      expect(e.length).toBeGreaterThan(0);
    }
  });
});

describe('getEmoji', () => {
  it('is deterministic — same input always yields same emoji', () => {
    expect(getEmoji('Headphones')).toBe(getEmoji('Headphones'));
    expect(getEmoji('Книга')).toBe(getEmoji('Книга'));
  });

  it('returns an emoji from the EMOJIS pool', () => {
    for (const input of ['x', 'PS5', 'Книга', 'foo bar baz']) {
      expect(EMOJIS).toContain(getEmoji(input));
    }
  });

  it('distribution: different inputs usually map to different emoji (basic sanity)', () => {
    const seen = new Set<string>();
    const inputs = ['a', 'b', 'c', 'd', 'e', 'PS5', 'Книга', 'foo'];
    for (const i of inputs) seen.add(getEmoji(i));
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it('handles empty string deterministically (reduces to seed 0)', () => {
    expect(typeof getEmoji('')).toBe('string');
    expect(EMOJIS).toContain(getEmoji(''));
  });
});

describe('extractFirstEmoji', () => {
  it('returns null on empty input', () => {
    expect(extractFirstEmoji('')).toBeNull();
  });

  it('returns null on plain text', () => {
    expect(extractFirstEmoji('Hello World')).toBeNull();
  });

  it('returns the first emoji from mixed text', () => {
    expect(extractFirstEmoji('Hello 🎮 world')).toBe('🎮');
  });

  it('returns the first emoji when it leads the input', () => {
    expect(extractFirstEmoji('🎨 some art')).toBe('🎨');
  });

  it('handles emoji with variation selector (✈️ = ✈ + U+FE0F)', () => {
    const result = extractFirstEmoji('✈️ travel');
    expect(result).toBeTruthy();
    // The result should be the airplane (with or without VS-16; both are valid)
    expect(result?.includes('✈')).toBe(true);
  });

  it('handles emoji with skin-tone modifier as a single grapheme', () => {
    const result = extractFirstEmoji('👋🏽 hello');
    expect(result).toBeTruthy();
    expect(result?.length).toBeGreaterThan(1);
  });

  it('handles ZWJ family emoji as a single grapheme', () => {
    const result = extractFirstEmoji('👨‍👩‍👧 family');
    expect(result).toBeTruthy();
    // ZWJ sequence is multiple codepoints
    expect([...(result ?? '')].length).toBeGreaterThan(1);
  });

  it('handles country flag emoji (regional indicator pair)', () => {
    const result = extractFirstEmoji('🇷🇺 Russia');
    expect(result).toBeTruthy();
  });

  it('extracts only the first emoji, ignores the rest', () => {
    expect(extractFirstEmoji('🎮🎨🎵')).toBe('🎮');
  });

  it('strips leading punctuation/digits before the emoji', () => {
    expect(extractFirstEmoji('   123 — 🎨 art')).toBe('🎨');
  });

  it('handles all-emoji input', () => {
    expect(extractFirstEmoji('🎉')).toBe('🎉');
  });
});
