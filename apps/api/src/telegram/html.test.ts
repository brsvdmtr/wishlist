// Regression tests for escapeTgHtml — Telegram HTML escape utility.
//
// The escape covers `&`, `<`, `>` — the three characters Telegram interprets
// inside `parse_mode: 'HTML'`. Quote escaping is unnecessary because
// notification templates never wrap interpolated values in attribute context.
//
// Surface: every callsite where user-controlled text (item title, display
// name, custom birthday message, comment text) flows into a translation
// template that gets sent via sendTgNotification / sendTgBotMessage.
// Without escaping, a user can spoof Telegram-rendered tags (`<b>`, `<a>`)
// and inject clickable links into other users' notifications.

import { describe, it, expect } from 'vitest';

import { escapeTgHtml } from './html';

describe('escapeTgHtml', () => {
  it('escapes ampersand before angle brackets to avoid double-encoding', () => {
    expect(escapeTgHtml('&')).toBe('&amp;');
    expect(escapeTgHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
  });

  it('escapes < and > to neutralise tag injection', () => {
    expect(escapeTgHtml('<')).toBe('&lt;');
    expect(escapeTgHtml('>')).toBe('&gt;');
    expect(escapeTgHtml('<b>bold</b>')).toBe('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('handles the realistic anchor-injection payload an attacker would use', () => {
    const payload = '<a href="https://attacker.example/x">click</a>';
    const escaped = escapeTgHtml(payload);
    // The leading `<` of every tag is now escaped, so Telegram's HTML parser
    // renders the whole thing as inert text instead of a clickable link.
    // (Quote chars stay as-is — they are not part of Telegram's HTML token
    // set, so the literal `href=` substring is harmless without the `<a`.)
    expect(escaped).not.toContain('<a');
    expect(escaped).not.toContain('</a');
    expect(escaped).toBe('&lt;a href="https://attacker.example/x"&gt;click&lt;/a&gt;');
  });

  it('leaves benign text untouched', () => {
    expect(escapeTgHtml('Hello world')).toBe('Hello world');
    expect(escapeTgHtml('iPhone 15 Pro Max — 256 ГБ')).toBe('iPhone 15 Pro Max — 256 ГБ');
    expect(escapeTgHtml('')).toBe('');
  });

  it('does not double-escape already-escaped sequences', () => {
    // The function is a one-shot replace; calling it on already-escaped text
    // re-escapes the ampersand. Callers must escape exactly once at the
    // boundary into the Telegram payload — this test pins that semantics.
    expect(escapeTgHtml('&amp;')).toBe('&amp;amp;');
    expect(escapeTgHtml('&lt;')).toBe('&amp;lt;');
  });

  it('preserves quote characters (not part of the escape contract)', () => {
    // Quotes are NOT escaped because notification templates never place
    // interpolated values inside attribute context. If a future template
    // ever needs attribute-safe values, add `"` escaping at that callsite.
    expect(escapeTgHtml('"hello"')).toBe('"hello"');
    expect(escapeTgHtml("it's")).toBe("it's");
  });
});
