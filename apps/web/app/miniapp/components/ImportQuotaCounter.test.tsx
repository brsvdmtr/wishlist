// RTL test — ImportQuotaCounter renders the correct copy + tone per state.
// Covers the "UI shows correct counter" self-check for the credit-based
// URL-import model (FREE 5/month → paid pack → PRO unlimited).

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ImportQuotaCounter, importQuotaLabel } from './ImportQuotaCounter';

const noop = () => {};

describe('ImportQuotaCounter', () => {
  it('PRO users see an "unlimited" line, no count', () => {
    render(<ImportQuotaCounter isPro freeLeft={0} freeLimit={5} paidLeft={0} locale="en" onUpsell={noop} />);
    expect(screen.getByText('Unlimited imports')).toBeInTheDocument();
  });

  it('with quota left, shows "{n} of {limit} imports left this month"', () => {
    render(<ImportQuotaCounter isPro={false} freeLeft={3} freeLimit={5} paidLeft={0} locale="en" onUpsell={noop} />);
    expect(screen.getByText('3 of 5 imports left this month')).toBeInTheDocument();
  });

  it('on the last free import, escalates to the warning tone', () => {
    render(<ImportQuotaCounter isPro={false} freeLeft={1} freeLimit={5} paidLeft={0} locale="en" onUpsell={noop} />);
    const text = screen.getByText('1 of 5 imports left this month');
    expect(text.parentElement?.style.background).toContain('--wb-warning-soft');
  });

  it('quota exhausted with no paid credits — danger tone, tappable', () => {
    render(<ImportQuotaCounter isPro={false} freeLeft={0} freeLimit={5} paidLeft={0} locale="en" onUpsell={noop} />);
    const strip = screen.getByRole('button');
    expect(strip).toHaveTextContent('No free imports left this month');
    expect(strip.style.background).toContain('--wb-danger-soft');
  });

  it('tapping the exhausted counter opens the upsell', () => {
    const onUpsell = vi.fn();
    render(<ImportQuotaCounter isPro={false} freeLeft={0} freeLimit={5} paidLeft={0} locale="en" onUpsell={onUpsell} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onUpsell).toHaveBeenCalledOnce();
  });

  it('with free quota gone but paid credits left, shows the paid balance', () => {
    render(<ImportQuotaCounter isPro={false} freeLeft={0} freeLimit={5} paidLeft={4} locale="en" onUpsell={noop} />);
    expect(screen.getByText('4 paid imports left')).toBeInTheDocument();
  });

  it('a healthy counter is not tappable (no upsell affordance)', () => {
    render(<ImportQuotaCounter isPro={false} freeLeft={3} freeLimit={5} paidLeft={0} locale="en" onUpsell={noop} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

// importQuotaLabel — the shared quota-line resolver, reused by the home
// "import by link" card so the 4-branch wording lives in one place.
describe('importQuotaLabel', () => {
  it('PRO → unlimited', () => {
    expect(importQuotaLabel({ isPro: true, freeLeft: 0, freeLimit: 5, paidLeft: 0, locale: 'en' }))
      .toBe('Unlimited imports');
  });

  it('free quota left → "{n} of {limit} imports left this month"', () => {
    expect(importQuotaLabel({ isPro: false, freeLeft: 3, freeLimit: 5, paidLeft: 0, locale: 'en' }))
      .toBe('3 of 5 imports left this month');
  });

  it('free gone, paid credits left → paid balance', () => {
    expect(importQuotaLabel({ isPro: false, freeLeft: 0, freeLimit: 5, paidLeft: 4, locale: 'en' }))
      .toBe('4 paid imports left');
  });

  it('free + paid both exhausted → "no free imports left"', () => {
    expect(importQuotaLabel({ isPro: false, freeLeft: 0, freeLimit: 5, paidLeft: 0, locale: 'en' }))
      .toBe('No free imports left this month');
  });
});
