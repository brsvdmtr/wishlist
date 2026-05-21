// Regression test for the 2026-05-21 Mini App white-screen outage.
//
// `ThemeProvider`'s `useState` initializer used to call `readStoredPref()`,
// which reads `window.localStorage`. The server has no `localStorage`, so a
// PRO user who had persisted a non-default theme got:
//   server HTML  → data-theme="dark"
//   client first → data-theme="black"
// React could not reconcile that and bailed hydration (#418/#423/#425),
// which the Telegram WebView surfaces as a hard "Application error".
//
// `renderToString` performs a SINGLE render pass with NO effects run — it is
// exactly the render the server commits, and exactly the render the client
// must reproduce on its first pass to hydrate cleanly. So the regression
// guard is: that render must equal the hard default no matter what
// `localStorage` holds.

import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ThemeProvider } from '@wishlist/ui';

const STORAGE_KEY = 'wb-theme-v1';
// Non-default values from @wishlist/ui-tokens
// (themes = ['dark','black'], accents = ['violet','blue','pink','green']).
const CUSTOM_THEME = 'black';
const CUSTOM_ACCENT = 'blue';

describe('ThemeProvider — SSR-safe initial render (hydration regression)', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('initial render ignores a custom localStorage theme — stays the SSR default', () => {
    // A PRO user persisted a non-default theme/accent in a previous session.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ theme: CUSTOM_THEME, accent: CUSTOM_ACCENT }),
    );

    const html = renderToString(
      <ThemeProvider>
        <div data-testid="child" />
      </ThemeProvider>,
    );

    // The first render MUST be the hard default. The server cannot see
    // localStorage, so anything else diverges from the SSR HTML and breaks
    // hydration. The stored preference is applied post-mount, in an effect.
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('data-accent="violet"');
    expect(html).not.toContain(`data-theme="${CUSTOM_THEME}"`);
    expect(html).not.toContain(`data-accent="${CUSTOM_ACCENT}"`);
  });

  it('initial render with no stored preference is the default', () => {
    const html = renderToString(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('data-accent="violet"');
  });

  it('an explicit `initial` prop is honored in the first render', () => {
    // `initial` is a prop: it serializes identically into the server and the
    // client, so honoring it in the initial render stays hydration-safe —
    // unlike localStorage, which only exists on the client.
    const html = renderToString(
      <ThemeProvider initial={{ theme: CUSTOM_THEME }}>
        <div />
      </ThemeProvider>,
    );
    expect(html).toContain(`data-theme="${CUSTOM_THEME}"`);
  });
});
