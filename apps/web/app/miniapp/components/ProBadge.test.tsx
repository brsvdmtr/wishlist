// RTL component test — pattern proof for the MiniApp extraction wave.
//
// ProBadge is the simplest cleanly-extractable component from MiniApp.tsx.
// Its test surface: renders the "PRO" label, applies the accent gradient,
// merges custom style overrides. The point of this test is not just to
// guard ProBadge — it's to prove the RTL + jsdom + jest-dom matchers stack
// works end-to-end inside this repo, so the remaining 100+ inline
// components can follow the same shape when extracted.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProBadge } from './ProBadge';

describe('ProBadge', () => {
  it('renders the literal "PRO" label', () => {
    render(<ProBadge />);
    expect(screen.getByText('PRO')).toBeInTheDocument();
  });

  it('default style includes accent gradient background', () => {
    render(<ProBadge />);
    const el = screen.getByText('PRO');
    const bg = el.style.background;
    // The gradient string contains both accent CSS vars.
    expect(bg).toContain('linear-gradient');
    expect(bg).toContain('--wb-accent');
  });

  it('default style sets a 20px badge height (icon-sized inline)', () => {
    render(<ProBadge />);
    const el = screen.getByText('PRO');
    expect(el.style.height).toBe('20px');
  });

  it('default font-weight is bold (700)', () => {
    render(<ProBadge />);
    const el = screen.getByText('PRO');
    expect(el.style.fontWeight).toBe('700');
  });

  it('default white-space is nowrap (badge mustn\'t wrap mid-text)', () => {
    render(<ProBadge />);
    const el = screen.getByText('PRO');
    expect(el.style.whiteSpace).toBe('nowrap');
  });

  it('custom style overrides merge over defaults', () => {
    render(<ProBadge style={{ marginLeft: 8, opacity: 0.5 }} />);
    const el = screen.getByText('PRO');
    expect(el.style.marginLeft).toBe('8px');
    expect(el.style.opacity).toBe('0.5');
    // Defaults still present:
    expect(el.style.height).toBe('20px');
  });

  it('custom style with `height` override wins (last-write-wins via spread)', () => {
    render(<ProBadge style={{ height: 32 }} />);
    const el = screen.getByText('PRO');
    expect(el.style.height).toBe('32px');
  });

  it('renders as a <span> (inline element for use mid-text)', () => {
    render(<ProBadge />);
    const el = screen.getByText('PRO');
    expect(el.tagName).toBe('SPAN');
  });
});
