import { describe, it, expect } from 'vitest';
import { toggleSelection, canAdvance } from './logic';

describe('toggleSelection — single / nps', () => {
  it('replaces the prior pick on single', () => {
    const r = toggleSelection({ selected: ['a'], optionId: 'b', type: 'single', maxSelections: 1 });
    expect(r).toEqual({ next: ['b'], capHit: false });
  });

  it('replaces on nps', () => {
    const r = toggleSelection({ selected: ['score_3'], optionId: 'score_8', type: 'nps', maxSelections: 1 });
    expect(r).toEqual({ next: ['score_8'], capHit: false });
  });

  it('first click on single picks the option', () => {
    const r = toggleSelection({ selected: [], optionId: 'a', type: 'single', maxSelections: 1 });
    expect(r).toEqual({ next: ['a'], capHit: false });
  });
});

describe('toggleSelection — multi (Q3/Q6/Q7 with max 2)', () => {
  it('first click adds the option', () => {
    const r = toggleSelection({ selected: [], optionId: 'a', type: 'multi', maxSelections: 2 });
    expect(r).toEqual({ next: ['a'], capHit: false });
  });

  it('second click on a different option adds it', () => {
    const r = toggleSelection({ selected: ['a'], optionId: 'b', type: 'multi', maxSelections: 2 });
    expect(r).toEqual({ next: ['a', 'b'], capHit: false });
  });

  it('third click on a different option is BLOCKED (no FIFO swap) and surfaces capHit', () => {
    const r = toggleSelection({ selected: ['a', 'b'], optionId: 'c', type: 'multi', maxSelections: 2 });
    expect(r).toEqual({ next: ['a', 'b'], capHit: true });
  });

  it('re-click on a selected option DESELECTS it (and frees the cap slot)', () => {
    const r = toggleSelection({ selected: ['a', 'b'], optionId: 'a', type: 'multi', maxSelections: 2 });
    expect(r).toEqual({ next: ['b'], capHit: false });
  });

  it('after a deselect, a new pick fits again without capHit', () => {
    const afterDeselect = toggleSelection({ selected: ['a', 'b'], optionId: 'b', type: 'multi', maxSelections: 2 });
    expect(afterDeselect).toEqual({ next: ['a'], capHit: false });
    const afterAdd = toggleSelection({ selected: afterDeselect.next, optionId: 'c', type: 'multi', maxSelections: 2 });
    expect(afterAdd).toEqual({ next: ['a', 'c'], capHit: false });
  });

  it('respects a custom maxSelections (e.g. 3) without hardcoding 2', () => {
    const r = toggleSelection({ selected: ['a', 'b'], optionId: 'c', type: 'multi', maxSelections: 3 });
    expect(r).toEqual({ next: ['a', 'b', 'c'], capHit: false });
    const blocked = toggleSelection({ selected: r.next, optionId: 'd', type: 'multi', maxSelections: 3 });
    expect(blocked).toEqual({ next: ['a', 'b', 'c'], capHit: true });
  });
});

describe('toggleSelection — open (Q10)', () => {
  it('click is a no-op; the open answer is driven by text input', () => {
    const r = toggleSelection({ selected: ['__text__'], optionId: '__text__', type: 'open', maxSelections: 1 });
    expect(r).toEqual({ next: ['__text__'], capHit: false });
  });
});

describe('canAdvance', () => {
  it('disabled when nothing selected on single/multi/nps', () => {
    expect(canAdvance({ type: 'single', selected: [] })).toBe(false);
    expect(canAdvance({ type: 'multi',  selected: [] })).toBe(false);
    expect(canAdvance({ type: 'nps',    selected: [] })).toBe(false);
  });

  it('enabled when ≥1 option is picked', () => {
    expect(canAdvance({ type: 'single', selected: ['a'] })).toBe(true);
    expect(canAdvance({ type: 'multi',  selected: ['a'] })).toBe(true);
    expect(canAdvance({ type: 'multi',  selected: ['a', 'b'] })).toBe(true);
    expect(canAdvance({ type: 'nps',    selected: ['score_8'] })).toBe(true);
  });

  it('always enabled for open (Q10 optional skip)', () => {
    expect(canAdvance({ type: 'open', selected: [] })).toBe(true);
    expect(canAdvance({ type: 'open', selected: ['__text__'] })).toBe(true);
  });
});
