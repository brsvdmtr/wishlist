// Unit test — importResultToast maps each URL-import parse outcome to the
// correct toast copy + tone. Covers the "failed parse must read differently
// from a real success" gap: a failed parse creates a domain stub but spends
// no credit, so the generic "Card created!" toast was misleading.

import { describe, it, expect } from 'vitest';
import { importResultToast } from './importResultToast';

describe('importResultToast', () => {
  it('ok → success tone, generic "card created" copy', () => {
    const r = importResultToast('ok', 'en');
    expect(r.tone).toBe('success');
    expect(r.message).toBe('Card created!');
  });

  it('partial → success tone, nudges to check the details', () => {
    const r = importResultToast('partial', 'en');
    expect(r.tone).toBe('success');
    expect(r.message).toBe('Card created — check the details');
  });

  it('failed → info tone, signals no credit was counted', () => {
    const r = importResultToast('failed', 'en');
    expect(r.tone).toBe('info');
    expect(r.message).toBe('Link not recognized — card added, did not count toward your limit');
  });

  it('failed copy differs from the plain success copy (the whole point)', () => {
    expect(importResultToast('failed', 'en').message)
      .not.toBe(importResultToast('ok', 'en').message);
  });

  it('resolves localized copy — RU', () => {
    expect(importResultToast('ok', 'ru').message).toBe('Карточка создана!');
    expect(importResultToast('failed', 'ru').message)
      .toBe('Ссылку не удалось разобрать — добавили карточку, добавление не засчитано');
  });
});
