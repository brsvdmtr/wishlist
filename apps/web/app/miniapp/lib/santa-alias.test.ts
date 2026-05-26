import { describe, expect, it } from 'vitest';
import { renderSantaAlias, SANTA_ADJ, SANTA_ANIMAL } from './santa-alias';

describe('renderSantaAlias', () => {
  it('renders English as "Adjective Animal"', () => {
    expect(renderSantaAlias('sleepy', 'giraffe', 'en')).toBe('Sleepy Giraffe');
    expect(renderSantaAlias('cheerful', 'panda', 'en')).toBe('Cheerful Panda');
  });

  it('renders zh-CN with no space', () => {
    expect(renderSantaAlias('sleepy', 'giraffe', 'zh-CN')).toBe('瞌睡的长颈鹿');
  });

  it('renders Hindi as "adjective animal" with space', () => {
    expect(renderSantaAlias('cheerful', 'fox', 'hi')).toMatch(/\s/);
  });

  it('renders Spanish as "Animal Adjective" with gender agreement', () => {
    // panda gender=f, kind=Bondadoso/Bondadosa
    expect(renderSantaAlias('kind', 'panda', 'es')).toBe('Panda Bondadosa');
    // giraffe gender=m
    expect(renderSantaAlias('kind', 'giraffe', 'es')).toBe('Jirafa Bondadoso');
  });

  it('renders Arabic noun-first with gender agreement', () => {
    // panda gender=f → kind=طيبة
    expect(renderSantaAlias('kind', 'panda', 'ar')).toBe('باندا طيبة');
    expect(renderSantaAlias('kind', 'giraffe', 'ar')).toBe('زرافة طيب');
  });

  it('defaults to Russian adjective-first with gender agreement', () => {
    // unknown locale → default branch
    expect(renderSantaAlias('cheerful', 'panda', 'ru')).toBe('Весёлая панда');
    expect(renderSantaAlias('cheerful', 'giraffe', 'ru')).toBe('Весёлый жираф');
    expect(renderSantaAlias('cheerful', 'panda', 'whatever')).toBe('Весёлая панда');
  });

  it('falls back to the default participant copy on unknown keys', () => {
    const out = renderSantaAlias('unknown-key', 'giraffe', 'en');
    expect(out).toBeTypeOf('string');
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toBe('Sleepy Giraffe');
  });

  it('exposes 30 adjective keys and 30 animal keys', () => {
    expect(Object.keys(SANTA_ADJ).length).toBe(30);
    expect(Object.keys(SANTA_ANIMAL).length).toBe(30);
  });
});
