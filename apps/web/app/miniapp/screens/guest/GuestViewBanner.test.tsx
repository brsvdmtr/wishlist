// RTL component test for the E13 GuestViewBanner.
//
// Covers the runtime-trickiest part of E13 that the pure-logic gate tests
// can't reach: the IntersectionObserver one-shot `shown` signal (fires once,
// only on viewport entry, never on a non-intersecting entry, idempotent across
// repeated emits), the IO-absent fallback (old WebViews → fire on mount), and
// the CTA / dismiss wiring.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { GuestViewBanner } from './GuestViewBanner';

// jsdom doesn't implement IntersectionObserver — controllable mock so the test
// decides exactly when (and whether) the banner "enters the viewport".
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  private cb: IntersectionObserverCallback;
  private elements: Element[] = [];
  disconnected = false;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    MockIntersectionObserver.instances.push(this);
  }
  observe(el: Element) { this.elements.push(el); }
  unobserve() {}
  disconnect() { this.disconnected = true; }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  /** Most-recently constructed instance (one per banner mount). Throws if none. */
  static last(): MockIntersectionObserver {
    const inst = MockIntersectionObserver.instances.at(-1);
    if (!inst) throw new Error('no IntersectionObserver instance constructed');
    return inst;
  }
  /** Test helper — emit an intersection event for every observed element. */
  emit(isIntersecting: boolean) {
    this.cb(
      this.elements.map((target) => ({ isIntersecting, target } as IntersectionObserverEntry)),
      this as unknown as IntersectionObserver,
    );
  }
}

const noop = () => {};

describe('GuestViewBanner', () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver as unknown as typeof IntersectionObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the title and CTA copy', () => {
    render(<GuestViewBanner locale="en" onShown={noop} onCreate={noop} onDismiss={noop} />);
    expect(screen.getByText('Want a list like this for yourself?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create my wishlist' })).toBeInTheDocument();
  });

  it('does NOT fire onShown before the banner intersects the viewport', () => {
    const onShown = vi.fn();
    render(<GuestViewBanner locale="en" onShown={onShown} onCreate={noop} onDismiss={noop} />);
    expect(onShown).not.toHaveBeenCalled();
  });

  it('fires onShown once when it intersects', () => {
    const onShown = vi.fn();
    render(<GuestViewBanner locale="en" onShown={onShown} onCreate={noop} onDismiss={noop} />);
    act(() => MockIntersectionObserver.last().emit(true));
    expect(onShown).toHaveBeenCalledTimes(1);
  });

  it('does not fire onShown for a non-intersecting entry', () => {
    const onShown = vi.fn();
    render(<GuestViewBanner locale="en" onShown={onShown} onCreate={noop} onDismiss={noop} />);
    act(() => MockIntersectionObserver.last().emit(false));
    expect(onShown).not.toHaveBeenCalled();
  });

  it('fires onShown only once even if intersection emits repeatedly', () => {
    const onShown = vi.fn();
    render(<GuestViewBanner locale="en" onShown={onShown} onCreate={noop} onDismiss={noop} />);
    act(() => {
      const io = MockIntersectionObserver.last();
      io.emit(true);
      io.emit(true);
      io.emit(true);
    });
    expect(onShown).toHaveBeenCalledTimes(1);
  });

  it('falls back to firing onShown on mount when IntersectionObserver is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const onShown = vi.fn();
    render(<GuestViewBanner locale="en" onShown={onShown} onCreate={noop} onDismiss={noop} />);
    expect(onShown).toHaveBeenCalledTimes(1);
  });

  it('fires onCreate when the CTA is tapped', () => {
    const onCreate = vi.fn();
    render(<GuestViewBanner locale="en" onShown={noop} onCreate={onCreate} onDismiss={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create my wishlist' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('fires onDismiss when the × close is tapped', () => {
    const onDismiss = vi.fn();
    render(<GuestViewBanner locale="en" onShown={noop} onCreate={noop} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
