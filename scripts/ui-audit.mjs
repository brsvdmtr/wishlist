#!/usr/bin/env node
// @ts-check
/**
 * ui-audit — quantify UI debt in apps/web.
 *
 * Counts inline `style={{...}}` objects, hardcoded hex colors, raw rgba()
 * strings, arbitrary Tailwind values (`className="... [42px] ..."`), unique
 * radius / font-size / spacing values, and flags files most in need of
 * migration.
 *
 * Reports per-file totals + repo totals. Non-zero exit code only when
 * `--strict` is passed and touched files worsened (reserved for Phase 4+;
 * for now this script is informational).
 *
 * Usage:
 *   pnpm ui:audit
 *   pnpm ui:audit --json        # machine-readable
 *   pnpm ui:audit --top=20      # top N worst files (default 10)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = join(__filename, '../..');
const webRoot = join(repoRoot, 'apps', 'web');

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const topArg = args.find((a) => a.startsWith('--top='));
const topN = topArg ? parseInt(topArg.split('=')[1], 10) : 10;

/** @type {string[]} */
const scanned = [];
const skipDirs = new Set(['node_modules', '.next', 'dist', '.turbo', 'public']);

function walk(/** @type {string} */ dir) {
  for (const entry of readdirSync(dir)) {
    if (skipDirs.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p);
    } else if (st.isFile()) {
      const ext = extname(p);
      if (ext === '.tsx' || ext === '.ts' || ext === '.jsx' || ext === '.js') {
        scanned.push(p);
      }
    }
  }
}

walk(webRoot);

/**
 * @typedef {{
 *   file: string,
 *   inlineStyles: number,
 *   hexColors: number,
 *   rgba: number,
 *   arbitraryTailwind: number,
 *   radiusValues: Set<string>,
 *   fontSizes: Set<string>,
 *   spacingValues: Set<string>,
 *   shadows: Set<string>,
 * }} FileReport
 */

/** @type {FileReport[]} */
const reports = [];
const globalRadii = new Set();
const globalFontSizes = new Set();
const globalSpacings = new Set();
const globalShadows = new Set();
const globalHexes = new Map(); // hex → count

const reInlineStyle = /style\s*=\s*\{\s*\{/g;
const reHex = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;
const reRgba = /rgba?\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)/g;
const reArbitrary = /className\s*=\s*["'][^"']*\[[^\]]+\][^"']*["']/g;
const reRadius = /borderRadius\s*:\s*([0-9]+|'[^']+'|"[^"]+")/g;
const reFontSize = /fontSize\s*:\s*([0-9]+|'[^']+'|"[^"]+")/g;
const reSpacingPadding = /(?:padding(?:Top|Right|Bottom|Left|X|Y)?|gap|margin(?:Top|Right|Bottom|Left|X|Y)?)\s*:\s*([0-9]+|'[^']+'|"[^"]+")/g;
const reShadow = /boxShadow\s*:\s*(['"][^'"]+['"])/g;

for (const file of scanned) {
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (src.length === 0) continue;

  const report = {
    file,
    inlineStyles: 0,
    hexColors: 0,
    rgba: 0,
    arbitraryTailwind: 0,
    radiusValues: new Set(),
    fontSizes: new Set(),
    spacingValues: new Set(),
    shadows: new Set(),
  };

  report.inlineStyles = (src.match(reInlineStyle) || []).length;
  const hexes = src.match(reHex) || [];
  report.hexColors = hexes.length;
  for (const h of hexes) {
    globalHexes.set(h.toLowerCase(), (globalHexes.get(h.toLowerCase()) || 0) + 1);
  }
  report.rgba = (src.match(reRgba) || []).length;
  report.arbitraryTailwind = (src.match(reArbitrary) || []).length;

  for (const m of src.matchAll(reRadius)) {
    const v = m[1].trim();
    report.radiusValues.add(v);
    globalRadii.add(v);
  }
  for (const m of src.matchAll(reFontSize)) {
    const v = m[1].trim();
    report.fontSizes.add(v);
    globalFontSizes.add(v);
  }
  for (const m of src.matchAll(reSpacingPadding)) {
    const v = m[1].trim();
    report.spacingValues.add(v);
    globalSpacings.add(v);
  }
  for (const m of src.matchAll(reShadow)) {
    const v = m[1].trim();
    report.shadows.add(v);
    globalShadows.add(v);
  }

  // Only keep files with any meaningful signal
  if (
    report.inlineStyles +
      report.hexColors +
      report.rgba +
      report.arbitraryTailwind >
    0
  ) {
    reports.push(report);
  }
}

// Aggregate
const totals = reports.reduce(
  (acc, r) => {
    acc.inlineStyles += r.inlineStyles;
    acc.hexColors += r.hexColors;
    acc.rgba += r.rgba;
    acc.arbitraryTailwind += r.arbitraryTailwind;
    return acc;
  },
  { inlineStyles: 0, hexColors: 0, rgba: 0, arbitraryTailwind: 0 },
);

// Rank by weighted debt
const weight = (/** @type {FileReport} */ r) =>
  r.inlineStyles * 1 + r.hexColors * 3 + r.arbitraryTailwind * 5 + r.rgba * 1;

reports.sort((a, b) => weight(b) - weight(a));
const topFiles = reports.slice(0, topN);

const topHexes = [...globalHexes.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15);

if (jsonMode) {
  const out = {
    scanned: scanned.length,
    filesWithDebt: reports.length,
    totals,
    uniqueRadii: globalRadii.size,
    uniqueFontSizes: globalFontSizes.size,
    uniqueSpacingValues: globalSpacings.size,
    uniqueShadows: globalShadows.size,
    uniqueHexColors: globalHexes.size,
    topHexes: topHexes.map(([h, c]) => ({ hex: h, count: c })),
    topFiles: topFiles.map((r) => ({
      file: relative(repoRoot, r.file),
      inlineStyles: r.inlineStyles,
      hexColors: r.hexColors,
      rgba: r.rgba,
      arbitraryTailwind: r.arbitraryTailwind,
      uniqueRadii: r.radiusValues.size,
      uniqueFontSizes: r.fontSizes.size,
      uniqueSpacingValues: r.spacingValues.size,
    })),
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

// Human-readable output
const line = '─'.repeat(72);
console.log(`\n  WishBoard UI audit\n${line}`);
console.log(`  Scanned:              ${scanned.length} .ts/.tsx files under apps/web/`);
console.log(`  Files with UI debt:   ${reports.length}`);
console.log(line);
console.log(`  Inline style={{}}:    ${totals.inlineStyles.toLocaleString()}`);
console.log(`  Hardcoded hex:        ${totals.hexColors.toLocaleString()}  (${globalHexes.size} unique)`);
console.log(`  rgba()/rgb() strings: ${totals.rgba.toLocaleString()}`);
console.log(`  Arbitrary Tailwind:   ${totals.arbitraryTailwind.toLocaleString()}`);
console.log(line);
console.log(`  Unique radius values:  ${globalRadii.size}`);
console.log(`  Unique fontSize:       ${globalFontSizes.size}`);
console.log(`  Unique spacing values: ${globalSpacings.size}`);
console.log(`  Unique shadows:        ${globalShadows.size}`);
console.log(line);
console.log(`  Top hex colors by frequency:`);
for (const [h, c] of topHexes) {
  console.log(`    ${h.padEnd(10)}  ${String(c).padStart(4)}  ${ansiSwatch(h)}`);
}
console.log(line);
console.log(`  Top ${topN} files by weighted debt (inline×1 + hex×3 + arb×5):`);
console.log(`  ${'File'.padEnd(55)} ${'Inl'.padStart(5)} ${'Hex'.padStart(4)} ${'Arb'.padStart(4)}`);
for (const r of topFiles) {
  const rel = relative(repoRoot, r.file);
  const short = rel.length > 55 ? '…' + rel.slice(-54) : rel;
  console.log(
    `  ${short.padEnd(55)} ${String(r.inlineStyles).padStart(5)} ${String(r.hexColors).padStart(4)} ${String(r.arbitraryTailwind).padStart(4)}`,
  );
}
console.log(line);
console.log(`  See docs/design-system/MIGRATION_PLAYBOOK.md for how to reduce these numbers.\n`);

function ansiSwatch(/** @type {string} */ hex) {
  // Best-effort ANSI truecolor swatch (works in most terminals; degrades gracefully)
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return '';
  return `\x1b[48;2;${r};${g};${b}m    \x1b[0m`;
}
