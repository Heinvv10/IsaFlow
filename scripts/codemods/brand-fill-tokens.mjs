/**
 * Codemod: filled teal/emerald backgrounds that carry white text -> the AA brand/success tokens
 * (master plan 3b.1; white on teal-600 is 3.7:1, on emerald-600 3.8:1).
 *
 *   bg-teal-600 / bg-teal-700            -> bg-brand-600 / bg-brand-700
 *   bg-emerald-600 / 700 / 800           -> bg-success-700 / 800 / 900
 *   bg-teal-500 / bg-emerald-500 / dark:bg-teal-500 on a line with text-white -> bg-brand-600 / bg-success-700 / dark:bg-brand-600
 *   a hover that is not darker than its base fill -> the next step darker (brand-600>700>800, success-700>800)
 *   text-blue-500 / text-rose-500 with no dark: twin on the line -> text-<hue>-600 dark:text-<hue>-400
 *     (the 500 stop is 3.98:1 on the dark slate-800 cards; the light theme remap would otherwise be all that fixes it)
 *
 * Variant prefixes (hover:, disabled:, dark:, ...) are kept. A token followed by `/` is an opacity
 * tint, not a fill under white text, and is left alone. Idempotent; safe to re-run on top of a merge:
 *   node scripts/codemods/brand-fill-tokens.mjs [--check]
 * --check exits 1 if any file would change (used by the CI gate in tests/unit/ci).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RULES = [
  ['bg-teal-600', 'bg-brand-600'],
  ['bg-teal-700', 'bg-brand-700'],
  ['bg-emerald-600', 'bg-success-700'],
  ['bg-emerald-700', 'bg-success-800'],
  ['bg-emerald-800', 'bg-success-900'],
];

const WHITE_TEXT = /(?<![\w:-])text-white(?![\w-])/;
const bare = (cls) => new RegExp(`(?<![\\w:-])${cls}(?![\\w/-])`, 'g');
const variant = (v, cls) => new RegExp(`(?<![\\w-])${v}:${cls}(?![\\w/-])`, 'g');

/**
 * Rules that read the whole line (a Tailwind class list is one string literal, so the line is the unit):
 *  - a lighter fill under white text, bare or `dark:`, becomes the AA token;
 *  - a text stop with no dark twin gets one;
 *  - a hover must be one step DARKER than its base, never equal or lighter: a hover that matches the
 *    base looks dead, and one that lightens a white-text fill falls under AA.
 */
function transformLine(line) {
  let out = line;
  const white = WHITE_TEXT.test(out);
  if (white) {
    out = out.replace(bare('bg-teal-500'), 'bg-brand-600').replace(bare('bg-emerald-500'), 'bg-success-700');
    if (!out.includes('dark:text-')) out = out.replace(variant('dark', 'bg-teal-500'), 'dark:bg-brand-600');
  }
  for (const hue of ['blue', 'rose']) {
    if (!out.includes(`dark:text-${hue}-`)) {
      out = out.replace(bare(`text-${hue}-500`), `text-${hue}-600 dark:text-${hue}-400`);
    }
  }
  // Only the plain `hover:` of the light layer: `disabled:hover:` keeps its meaning, `dark:hover:` is handled below.
  const hover = (cls) => new RegExp(`(?<![\\w:-])hover:${cls}(?![\\w/-])`, 'g');
  const darker = [
    // [base class, hover shades that are not darker than it, the hover it gets]
    ['bg-brand-600', ['teal-400', 'teal-500', 'teal-600', 'teal-800', 'brand-600'], 'brand-700'],
    ['bg-brand-700', ['teal-400', 'teal-500', 'teal-600', 'teal-800', 'brand-700'], 'brand-800'],
    ['bg-success-700', ['emerald-400', 'emerald-500', 'emerald-600', 'success-700'], 'success-800'],
  ];
  for (const [base, hovers, to] of darker) {
    if (!bare(base).test(out)) continue;
    for (const h of hovers) out = out.replace(hover(`bg-${h}`), `hover:bg-${to}`);
  }
  // The dark: layer: under a brand-600 fill (bare, or dark:) a dark:hover that is not darker gets brand-700. A bare
  // brand-600 on the line makes dark:bg-brand-600 redundant, so it is dropped.
  const bareBrand = bare('bg-brand-600').test(out);
  if (bareBrand || out.includes('dark:bg-brand-600')) {
    for (const h of ['teal-400', 'teal-500', 'teal-600', 'teal-800', 'brand-600']) {
      out = out.replace(new RegExp(`dark:hover:bg-${h}(?![\\w/-])`, 'g'), 'dark:hover:bg-brand-700');
    }
  }
  if (bareBrand) out = out.replace(/ dark:bg-brand-600(?![\w/-])/g, '');
  return out;
}

/** A file may opt out with this marker: its colours are categorical (an avatar palette), not brand fills. */
export const SKIP_MARKER = 'brand-fill-tokens: skip';

export function transform(src) {
  if (src.includes(SKIP_MARKER)) return src;
  let out = src;
  for (const [from, to] of RULES) {
    out = out.replace(new RegExp(`(?<![\\w-])${from}(?![\\w/-])`, 'g'), to);
  }
  return out.split('\n').map(transformLine).join('\n');
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(tsx?|ts)$/.test(name)) yield p;
  }
}

if (process.argv[1] && process.argv[1].endsWith('brand-fill-tokens.mjs')) {
  const check = process.argv.includes('--check');
  let changed = 0;
  for (const root of ['src', 'pages']) {
    for (const file of walk(root)) {
      const before = readFileSync(file, 'utf8');
      const after = transform(before);
      if (after !== before) {
        changed += 1;
        if (!check) writeFileSync(file, after);
      }
    }
  }
  console.log(`${check ? 'would change' : 'changed'} ${changed} file(s)`);
  process.exit(check && changed > 0 ? 1 : 0);
}
