// Emoji utility functions extracted from MiniApp.tsx — Phase 5b pilot
// continuation. These are pure logic (no React, no state) so they live in
// `lib/` rather than `components/`. Both pieces have callsites scattered
// across the monolith; centralising them avoids drift.

const EMOJIS = ['🎧','📖','☕','🎵','🎒','📚','🎮','👟','💄','🎨','⌚','🖥','📷','🎸','🏀','🧩','🕯','🍫','🧸','✈️'] as const;

/**
 * Deterministic emoji pick for a given string. Same input always yields the
 * same emoji; falls into a 20-emoji rotation by a simple djb2-style hash.
 * Used by `ItemThumb` to pick a placeholder emoji when an item has no
 * imageUrl.
 */
export function getEmoji(s: string): string {
  const code = [...s].reduce((h, c) => ((h << 5) - h) + c.charCodeAt(0), 0);
  return EMOJIS[Math.abs(code) % EMOJIS.length]!;
}

/**
 * Extract the FIRST emoji from arbitrary user input as a single grapheme
 * cluster. Returns null when the input contains no emoji.
 *
 * Handles all emoji oddities correctly:
 *   - Skin-tone modifiers (👋🏽 = base + modifier, 2 codepoints, 1 grapheme)
 *   - ZWJ sequences (👨‍👩‍👧 = 5 codepoints joined, 1 grapheme)
 *   - Regional-indicator pairs / flags (🇷🇺 = 2 codepoints, 1 grapheme)
 *   - Variation selectors (✈️ = ✈ + U+FE0F, 1 grapheme)
 *
 * Used by the wishlist emoji picker — strips letters/digits/punctuation so
 * the user can't break the wishlist hero by pasting "Hello".
 */
export function extractFirstEmoji(input: string): string | null {
  if (!input) return null;
  let segments: Iterable<{ segment: string }> | null = null;
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    segments = seg.segment(input);
  } catch { /* old runtime: fall through */ }

  const isEmoji = (s: string): boolean => /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}/u.test(s);

  if (segments) {
    for (const { segment } of segments) {
      if (isEmoji(segment)) return segment;
    }
    return null;
  }

  // Fallback: scan codepoints, return the first one that's a pictographic.
  for (const cp of input) {
    if (isEmoji(cp)) return cp;
  }
  return null;
}

/** Re-export the corpus for callers that need to render the full pool. */
export { EMOJIS };
