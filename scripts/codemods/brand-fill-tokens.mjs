/**
 * Codemod: filled teal/emerald backgrounds that carry white text -> the AA brand/success tokens
 * (master plan 3b.1; white on teal-600 is 3.7:1, on emerald-600 3.8:1).
 *
 *   bg-teal-600 / bg-teal-700            -> bg-brand-600 / bg-brand-700
 *   bg-emerald-600 / 700 / 800           -> bg-success-700 / 800 / 900
 *   bg-teal-500 on a line with text-white -> bg-brand-600 (badges, the current wizard step)
 *   hover:bg-teal-500 beside bg-brand-600 -> hover:bg-brand-700 (a hover must not get lighter under white text)
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

/** Rules that read the whole line: a white-text fill, a brand fill with a hover, a text stop with no dark twin. */
function transformLine(line) {
  let out = line;
  if (/(?<![\w-])text-white(?![\w-])/.test(out)) out = out.replace(/(?<![\w:-])bg-teal-500(?![\w/-])/g, 'bg-brand-600');
  for (const hue of ['blue', 'rose']) {
    if (!out.includes(`dark:text-${hue}-`)) {
      out = out.replace(new RegExp(`(?<![\\w:-])text-${hue}-500(?![\\w/-])`, 'g'), `text-${hue}-600 dark:text-${hue}-400`);
    }
  }
  if (out.includes('bg-brand-600')) out = out.replace(/(?<![\w-])hover:bg-teal-500(?![\w/-])/g, 'hover:bg-brand-700');
  return out;
}

export function transform(src) {
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
