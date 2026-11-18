/**
 * WP4a light-theme parity: the bank-transactions page and its components may not hard-code a dark-theme text colour
 * (any Tailwind palette colour at -300 or -400: red, teal, amber, blue, purple, orange, yellow, sky, cyan, green, ...; and
 * -500 of the warm hues, which are too pale on white) without a `dark:` pairing - on the light background those read as
 * washed-out pastel. The fix is `text-red-700 dark:text-red-400`. This scans every file of the page's component folders;
 * the detector itself is pinned by the sample cases.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const FILES = [
  'pages/accounting/bank-transactions/index.tsx',
  ...['src/components/accounting/bank-transactions', 'src/components/accounting/bankTx'].flatMap(d =>
    readdirSync(join(ROOT, d)).filter(f => f.endsWith('.tsx')).map(f => `${d}/${f}`)),
  ...readdirSync(join(ROOT, 'src/components/accounting')).filter(f => /^BankTx.*\.tsx$/.test(f)).map(f => `src/components/accounting/${f}`),
  // The modals and rows the page opens (not named BankTx*):
  ...['ExcludeReasonModal', 'FindMatchModal', 'SplitLineRow', 'SplitTransactionModal', 'CreateRuleModal', 'CreateEntityModal'].map(n => `src/components/accounting/${n}.tsx`),
];

const WARM = 'orange|amber|yellow|lime'; // -500 of these is too pale on white as well
const PALETTE = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';

/** Class tokens that use a dark-theme text colour with no `dark:` variant in front of them. */
export function unpairedDarkText(source: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![\\w:-])((?:[a-z-]+:)*)text-(?:(?:${PALETTE})-(?:300|400)|(?:${WARM})-500)(?![\\w-])`, 'g');
  for (const m of source.matchAll(re)) if (!m[1]!.includes('dark:')) out.push(m[0]);
  return out;
}

describe('the detector', () => {
  it.each([
    ['text-red-400', 1], ['text-teal-400 hover:underline', 1], ['hover:text-teal-300', 1], ['text-amber-300', 1],
    ['text-red-700 dark:text-red-400', 0], ['dark:hover:text-teal-300 hover:text-teal-800', 0],
    ['bg-red-400', 0], ['text-red-4000', 0], ['text-green-400', 1], ['text-blue-400', 1], ['text-purple-300', 1], ['text-orange-400', 1],
    ['text-yellow-400 hover:text-sky-300', 2], ['text-amber-500', 1], ['text-yellow-500', 1], ['text-orange-500', 1], ['text-red-500', 0], ['text-blue-500', 0], ['text-amber-700 dark:text-amber-500', 0], ['text-blue-700 dark:text-blue-400', 0], ['text-gray-900', 0], ['text-white', 0],
  ])('%j -> %i violation(s)', (src, n) => { expect(unpairedDarkText(`className="${src}"`)).toHaveLength(n); });
  it('finds each one in a longer string', () => {
    expect(unpairedDarkText("x ? 'text-red-400' : 'text-teal-400'")).toEqual(['text-red-400', 'text-teal-400']);
  });
});

describe('the page and its components', () => {
  it('scans real files, the modals the page opens among them', () => {
    expect(FILES.length).toBeGreaterThan(40);
    for (const n of ['FindMatchModal', 'SplitTransactionModal', 'ExcludeReasonModal', 'CreateRuleModal', 'SplitLineRow', 'BankTxLinkModal', 'BankTxSelectionCell', 'AutoPostRunsPanel', 'CreateEntityModal']) {
      expect(FILES.some(f => f.endsWith(`/${n}.tsx`)), n).toBe(true);
    }
  });
  it.each(FILES)('%s has no unpaired dark-theme text colour', (file) => {
    expect(unpairedDarkText(readFileSync(join(ROOT, file), 'utf8'))).toEqual([]);
  });
});
