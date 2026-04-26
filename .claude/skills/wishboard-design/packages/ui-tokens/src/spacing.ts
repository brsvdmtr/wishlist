/**
 * Spacing tokens — evidence-based scale from inline-style analysis of MiniApp.tsx.
 * Most-frequent values: 8 (flex gap), 14 (list/button), 16 (card padding), 24 (sheet).
 *
 * Numeric indexing (spacing[3] = 8) is Tailwind-compatible; semantic names
 * preferred in component code.
 */
export const spacing = {
  0: 0,
  0.5: 2,
  1: 4,   // micro
  1.5: 6, // tight
  2: 8,   // PRIMARY flex gap
  2.5: 10,
  3: 12,  // secondary flex gap
  3.5: 14, // list layout / button vertical
  4: 16,  // card padding / list row padding (PRIMARY)
  5: 20,  // generous section
  6: 24,  // sheet padding / large section (PRIMARY)
  8: 32,
  10: 40,
} as const;

/**
 * Semantic spacing — use these in component code. Changes happen here first.
 */
export const spacingSemantic = {
  /** Card inner padding. 16 */
  cardPadding: 16,
  /** Gap between card contents (thumb ↔ text). 14 */
  cardGap: 14,

  /** Bottom-sheet / modal inner padding. 24 */
  sheetPadding: 24,
  /** Sheet title → content spacing. 16 */
  sheetTitleGap: 16,

  /** Button vertical padding. 14 */
  buttonPaddingY: 14,
  /** Button horizontal padding. 24 */
  buttonPaddingX: 24,
  /** Compact button vertical padding. 10 */
  buttonPaddingYCompact: 10,
  /** Compact button horizontal padding. 16 */
  buttonPaddingXCompact: 16,

  /** List row padding. 16 */
  listRowPadding: 16,
  /** Gap between list row slots (leading / content / trailing). 14 */
  listRowGap: 14,
  /** Compact list row padding. 12 14 */
  listRowPaddingCompactY: 12,
  listRowPaddingCompactX: 14,

  /** Screen horizontal padding. 16 */
  screenPaddingX: 16,
  /** Default gap between sections. 16 */
  sectionGap: 16,

  /** Gap between icon and label inside buttons/chips. 8 */
  inlineIconGap: 8,

  /** Gap between chip label and its leading dot. 4 */
  chipDotGap: 4,
} as const;

export type SpacingToken = keyof typeof spacing;
