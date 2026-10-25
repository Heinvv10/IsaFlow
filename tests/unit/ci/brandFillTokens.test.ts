/**
 * Filled brand backgrounds carry white text, so they use the AA brand/success tokens, not the raw
 * teal-600/700 and emerald-600+ stops (white on teal-600 is 3.7:1). The codemod is the fix and this
 * is the gate: the tree must be a fixed point of it.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs module, no declaration file
import { transform } from '../../../scripts/codemods/brand-fill-tokens.mjs';

const t = transform as (s: string) => string;

describe('brand-fill-tokens transform', () => {
  it('moves white-text fills to the tokens, keeping variant prefixes', () => {
    expect(t('bg-teal-600 hover:bg-teal-700 text-white')).toBe('bg-brand-600 hover:bg-brand-700 text-white');
    expect(t('disabled:bg-teal-600')).toBe('disabled:bg-brand-600');
    expect(t('bg-emerald-600 hover:bg-emerald-700')).toBe('bg-success-700 hover:bg-success-800');
  });

  it('leaves tints, other stops and non-fill uses alone', () => {
    expect(t('bg-teal-600/20 bg-teal-500/10 text-teal-600 border-teal-600 ring-teal-700')).toBe(
      'bg-teal-600/20 bg-teal-500/10 text-teal-600 border-teal-600 ring-teal-700',
    );
    expect(t('bg-teal-6000 bg-teal-60')).toBe('bg-teal-6000 bg-teal-60');
  });

  it('a lighter fill under white text becomes brand-600, and its hover stops lightening', () => {
    expect(t('bg-teal-500 text-white rounded')).toBe('bg-brand-600 text-white rounded');
    expect(t('bg-teal-500 text-gray-900')).toBe('bg-teal-500 text-gray-900');
    expect(t('bg-brand-600 hover:bg-teal-500 text-white')).toBe('bg-brand-600 hover:bg-brand-700 text-white');
  });

  it('pairs a dark-only 500 stop with a dark twin, once', () => {
    expect(t('text-blue-500 hover:underline')).toBe('text-blue-600 dark:text-blue-400 hover:underline');
    expect(t('text-rose-500 dark:text-rose-300')).toBe('text-rose-500 dark:text-rose-300');
    expect(t(t('text-rose-500'))).toBe('text-rose-600 dark:text-rose-400');
  });
});

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

describe('the tree', () => {
  it('has no raw white-text teal/emerald fill left for the codemod to change', () => {
    const dirty: string[] = [];
    for (const root of ['src', 'pages']) {
      for (const file of walk(join(process.cwd(), root))) {
        const src = readFileSync(file, 'utf8');
        if (t(src) !== src) dirty.push(file.replace(`${process.cwd()}/`, ''));
      }
    }
    expect(dirty, 'run: node scripts/codemods/brand-fill-tokens.mjs').toEqual([]);
  });
});
