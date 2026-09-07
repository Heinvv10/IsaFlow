/**
 * The statement IDENTITIES — the arithmetic every board pack's statements
 * must satisfy — and check 3, which walks them.
 *
 * Split from `packStatementIntegrity.ts` at the 300-line cap. The seam is the
 * one the file already had: a table of six declared identities plus the
 * failure prose built from them is a DATA table and its reader, and it sits
 * beside checks 4, 6 and the cash-bridge endpoints, which walk a document's
 * columns and charts and share nothing with it but `valueOf`. That reader is
 * here too, because it is what an identity is resolved through; every other
 * check imports it from this file.
 *
 * Each identity is checked against the provenance map rather than against
 * table rows — see `packStatementIntegrity.ts`'s header for why summing a
 * table's own rows is the wrong formulation and reports every correct income
 * statement as broken.
 */

import { formatMoney } from '@/lib/format/money';
import type { PackPagesDocument } from '../pages/packPageModel';
// The CONSTANT, not the string it holds. Two reasons: `packOperatingProfitReading`
// guards the one-reading rule by scanning these files for reads of the raw
// optional field, and it matches on text, so spelling the source out here
// would trip a guard this file does not break; and an identity keyed to a
// COPY of a source name silently stops checking anything the day that source
// is renamed.
import { OPERATING_PROFIT_SOURCE } from './packMetricReads';
import { MONEY_TOLERANCE } from './packWaterfallIntegrity';

/** The one value a source was issued with, or null when it was never issued
 *  or is not meaningful. `assertConsistent` has already refused a source with
 *  two values, so the first reading is THE reading. */
export function valueOf(doc: PackPagesDocument, source: string): number | null {
  const issued = doc.provenance.all().get(source);
  return issued?.[0]?.value ?? null;
}

interface Identity {
  /** What fails, in the sentence a reader sees. */
  statement: string;
  target: string;
  /**
   * What the target is CALLED on the page, for that same reader.
   *
   * The refusal reaches a director's screen — the Brightsphere pack was
   * refused, correctly, and the message they were given read
   * "'packFigureSet.current.totalAssets' states 3191495.16 but +
   * packFigureSet.current.totalLiabilities 5368200.63 …". The first sentence
   * was fine and the rest was a stack trace in prose, with nothing in it a
   * reader could act on. The source paths stay in the code, where the person
   * who needs them is; the sentence names the figures the way the statement
   * does and states the gap.
   */
  targetLabel: string;
  terms: ReadonlyArray<{ source: string; label: string; sign: 1 | -1 }>;
}

const IDENTITIES: readonly Identity[] = [
  {
    statement: 'The balance sheet does not foot: assets do not equal liabilities plus equity',
    target: 'packFigureSet.current.totalAssets',
    targetLabel: 'total assets',
    terms: [
      { source: 'packFigureSet.current.totalLiabilities', label: 'total liabilities', sign: 1 },
      { source: 'packFigureSet.current.totalEquity', label: 'total equity', sign: 1 },
    ],
  },
  {
    statement: 'Non-current assets do not equal total assets less current assets',
    target: 'packStatementTables.nonCurrentAssets',
    targetLabel: 'non-current assets',
    terms: [
      { source: 'packFigureSet.current.totalAssets', label: 'total assets', sign: 1 },
      { source: 'packFigureSet.current.currentAssets', label: 'current assets', sign: -1 },
    ],
  },
  {
    statement: 'Non-current liabilities do not equal total liabilities less current liabilities',
    target: 'packStatementTables.nonCurrentLiabilities',
    targetLabel: 'non-current liabilities',
    terms: [
      { source: 'packFigureSet.current.totalLiabilities', label: 'total liabilities', sign: 1 },
      { source: 'packFigureSet.current.currentLiabilities', label: 'current liabilities', sign: -1 },
    ],
  },
  {
    // I-2. EBITDA is a DERIVED subtotal here in the strictest sense: the pack
    // hands `calculateExtendedRatios` no depreciation or amortisation field,
    // so `ebitda = ebit + dep + amort` reduces to the operating line, rounded
    // to two decimals. That identity is worth pinning precisely because it is
    // invisible on the page — a reader sees "EBITDA" and reads a different
    // measure from the one above it. If a depreciation figure is ever added
    // to `toFinancialData`, this check FAILS, which is the correct alarm:
    // EBITDA would then genuinely differ from EBIT and this identity must
    // gain the term rather than be deleted.
    statement:
      'EBITDA does not equal the operating line. The pack captures no depreciation or amortisation, so the two cannot differ — if one has been added, this identity needs the extra term',
    target: 'calculateExtendedRatios.ebitda',
    targetLabel: 'EBITDA',
    terms: [{ source: OPERATING_PROFIT_SOURCE, label: 'the operating line', sign: 1 }],
  },
  {
    statement: 'Gross profit does not equal revenue less cost of sales',
    target: 'packStatementTables.grossProfit',
    targetLabel: 'gross profit',
    terms: [
      { source: 'packFigureSet.current.revenue', label: 'revenue', sign: 1 },
      { source: 'packFigureSet.current.costOfSales', label: 'cost of sales', sign: -1 },
    ],
  },
];

/**
 * The three balance-sheet totals every board pack must have recorded.
 *
 * Without this, a pack that simply never issued them would SKIP the footing
 * check and pass — the quietest false green there is, and the one a fixture
 * built for some other purpose walks into first.
 */
const REQUIRED_SOURCES = [
  'packFigureSet.current.totalAssets',
  'packFigureSet.current.totalLiabilities',
  'packFigureSet.current.totalEquity',
] as const;

/** Check 3 — the statements foot on the figures the pack itself recorded. */
export function checkStatements(doc: PackPagesDocument): string[] {
  const failures: string[] = [];
  for (const source of REQUIRED_SOURCES) {
    if (!doc.provenance.all().has(source)) {
      failures.push(
        `The pack never recorded '${source}', so the balance sheet cannot be ` +
          `checked. An unverifiable statement is refused, not assumed correct.`,
      );
    }
  }

  for (const identity of IDENTITIES) {
    const target = valueOf(doc, identity.target);
    const terms = identity.terms.map((term) => ({ ...term, value: valueOf(doc, term.source) }));
    // A figure this pack never issued, or issued as not meaningful, leaves
    // nothing to reconcile — that is R-P44's honest absence, not a mismatch.
    if (target === null || terms.some((term) => term.value === null)) continue;

    const expected = terms.reduce((sum, term) => sum + term.sign * (term.value as number), 0);
    if (Math.abs(target - expected) > MONEY_TOLERANCE) {
      const money = (n: number) => formatMoney(n, { cents: true, symbol: true });
      const detail = terms
        .map((term, index) => {
          const word = index === 0 ? '' : term.sign === 1 ? 'plus ' : 'less ';
          return `${word}${term.label} of ${money(term.value as number)}`;
        })
        .join(' ');
      failures.push(
        `${identity.statement}. The pack states ${identity.targetLabel} as ${money(target)}; ` +
          `${detail} adds up to ${money(expected)}, a difference of ` +
          `${money(Math.abs(target - expected))}.`,
      );
    }
  }
  return failures;
}
