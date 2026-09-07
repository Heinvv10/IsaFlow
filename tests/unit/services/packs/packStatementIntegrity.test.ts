/**
 * The statement half of the figure-integrity gate — does each statement foot,
 * and does each column hold what its heading claims?
 *
 * Split from `packFigureIntegrity.test.ts` along the seam the implementation
 * already uses: `packStatementIntegrity.ts` owns the identities, the column
 * rules and the comparative period, and this file drives them. Same
 * discipline — every rejection is pinned by an acceptance case of the same
 * shape, because a gate that threw on everything would satisfy every
 * `.toThrow()` here.
 */
import { describe, expect, it } from 'vitest';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { DEPRECIATION_SOURCE, EBITDA_SOURCE } from '@/modules/accounting/services/packs/pages/packDefinitions';
import { OPERATING_PROFIT_SOURCE } from '@/modules/accounting/services/packs/figures/packMetricReads';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type {
  PackComparativePeriod,
  PackPage,
  PackPageBlock,
  PackPagesDocument,
  PackTable,
  PackTableColumnKey,
} from '@/modules/accounting/services/packs/pages/packPageModel';
import { demoInput } from './fixtures/boardPackInputs';

const template = buildBoardPackPages(demoInput);

/** The demo pack's real comparative window, and the label that describes it. */
const comparative: PackComparativePeriod = {
  label: '1 September 2025 to 28 February 2026',
  start: '2025-09-01',
  end: '2026-02-28',
};

/** The three totals every pack must record, at values that foot. Overriding
 *  one is how the balance-sheet branch is reached. */
function balanced(
  p: PackFigureProvenance,
  totals: { assets?: number; liabilities?: number; equity?: number } = {},
): void {
  p.figure('packFigureSet.current.totalAssets', totals.assets ?? 3_900_000, 'money');
  p.figure('packFigureSet.current.totalLiabilities', totals.liabilities ?? 1_640_000, 'money');
  p.figure('packFigureSet.current.totalEquity', totals.equity ?? 2_260_000, 'money');
}

function page(blocks: PackPageBlock[]): PackPage {
  return { number: 7, title: 'Cash rose to 610', section: 'Financials', orientation: 'portrait', density: 'high', blocks, footnotes: [] };
}

/** `comparativePeriod` defaults to NULL: the pages built here carry no
 *  comparative column, and a document claiming a period nothing compares
 *  against is itself a failure (R-P55). */
function docOf(
  p: PackFigureProvenance,
  blocks: PackPageBlock[] = [],
  comparativePeriod: PackComparativePeriod | null = null,
): PackPagesDocument {
  return { ...template, provenance: p, pages: [page(blocks)], comparativePeriod };
}

function tableOf(columns: PackTableColumnKey[], figures: PackTable['rows'][number]['figures']): PackPageBlock {
  return {
    kind: 'table',
    table: { scale: "R'000", columns, rows: [{ label: 'Revenue', level: 0, role: 'line', figures }] },
  };
}

describe('assertPackIntegrity — statements', () => {
  it('fails when the balance sheet does not foot', () => {
    const p = new PackFigureProvenance();
    balanced(p, { equity: 2_000_000 });
    expect(() => assertPackIntegrity(docOf(p)))
      .toThrow(/assets.*liabilities.*equity|does not foot/i);
  });

  it('says what failed in words a director can act on, not in source paths', () => {
    // The refusal reaches the SCREEN — a Brightsphere pack was refused,
    // correctly, and the reader was handed
    // "'packFigureSet.current.totalAssets' states 3191495.16 but +
    // packFigureSet.current.totalLiabilities 5368200.63 …". The first sentence
    // was fine and the rest was a stack trace in prose, in unrounded rands,
    // with nothing in it a reader could act on and no statement of the gap.
    const p = new PackFigureProvenance();
    balanced(p, { equity: 2_000_000 });
    let message = '';
    try { assertPackIntegrity(docOf(p)); } catch (error) { message = (error as Error).message; }

    expect(message).toContain('total assets');
    expect(message).toContain('total liabilities');
    expect(message).toContain('total equity');
    // The gap itself, which is the one number a reader can chase.
    expect(message).toContain('a difference of R 260 000.00');
    // And no internal identifier anywhere in it.
    expect(message).not.toMatch(/packFigureSet\.|packStatementTables\./);
  });

  it('accepts the same balance sheet when it foots', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    expect(() => assertPackIntegrity(docOf(p))).not.toThrow();
  });

  it('fails when EBITDA does not equal the operating line plus the add-back (I-2)', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    p.figure(OPERATING_PROFIT_SOURCE, 735_000, 'money');
    p.figure(DEPRECIATION_SOURCE, 96_000, 'money');
    p.figure(EBITDA_SOURCE, 800_000, 'money');
    expect(() => assertPackIntegrity(docOf(p))).toThrow(/EBITDA does not equal the operating line/);
  });

  it('accepts EBITDA as the operating line plus depreciation, within the rounding', () => {
    // `calculateExtendedRatios` rounds EBITDA to two decimals, so the two
    // legitimately differ by up to half a cent.
    const p = new PackFigureProvenance();
    balanced(p);
    p.figure(OPERATING_PROFIT_SOURCE, 735_000.004, 'money');
    p.figure(DEPRECIATION_SOURCE, 96_000, 'money');
    p.figure(EBITDA_SOURCE, 831_000, 'money');
    expect(() => assertPackIntegrity(docOf(p))).not.toThrow();
  });

  it('fails an EBITDA that ignores a depreciation charge the ledger carries', () => {
    // The defect this identity gained its second term for: the pack printed
    // an EBITDA row equal to the operating line to the rand, on a company
    // that charged depreciation, because the charge was never handed to the
    // engine. Without this the old one-term identity would still pass.
    const p = new PackFigureProvenance();
    balanced(p);
    p.figure(OPERATING_PROFIT_SOURCE, 735_000, 'money');
    p.figure(DEPRECIATION_SOURCE, 96_000, 'money');
    p.figure(EBITDA_SOURCE, 735_000, 'money');
    expect(() => assertPackIntegrity(docOf(p))).toThrow(/EBITDA/);
  });

  it('fails a comparative column filled from a current-period reading', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    const actual = p.figure('packFigureSet.current.revenue', 4_200_000, 'money');
    const prior = p.figure('packFigureSet.current.revenue.prior', 3_750_000, 'money');
    const wrong = tableOf(['actual', 'prior'], { actual, prior: actual });
    const right = tableOf(['actual', 'prior'], { actual, prior });
    expect(() => assertPackIntegrity(docOf(p, [wrong], comparative))).toThrow(/not a prior-period reading/i);
    expect(() => assertPackIntegrity(docOf(p, [right], comparative))).not.toThrow();
  });

  it('fails a table declaring a column no row carries', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    const actual = p.figure('packFigureSet.current.revenue', 4_200_000, 'money');
    expect(() => assertPackIntegrity(docOf(p, [tableOf(['actual', 'budget'], { actual })])))
      .toThrow(/no row carries/i);
  });

  it('fails when the comparative column is headed a period other than the one it holds (R-P55)', () => {
    // The half a provenance check cannot see. Every cell below IS a
    // prior-period reading — `checkColumns` is satisfied — and the heading
    // names the wrong six months, which is what the director reads.
    const p = new PackFigureProvenance();
    balanced(p);
    const actual = p.figure('packFigureSet.current.revenue', 4_200_000, 'money');
    const prior = p.figure('packFigureSet.current.revenue.prior', 3_750_000, 'money');
    const table = tableOf(['actual', 'prior'], { actual, prior });
    const mislabelled: PackComparativePeriod = { ...comparative, label: '1 March 2026 to 31 August 2026' };
    expect(() => assertPackIntegrity(docOf(p, [table], mislabelled)))
      .toThrow(/headed '1 March 2026 to 31 August 2026'/);
  });

  it('accepts the same comparative column when the header describes its window', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    const actual = p.figure('packFigureSet.current.revenue', 4_200_000, 'money');
    const prior = p.figure('packFigureSet.current.revenue.prior', 3_750_000, 'money');
    expect(() => assertPackIntegrity(docOf(p, [tableOf(['actual', 'prior'], { actual, prior })], comparative)))
      .not.toThrow();
  });

  it('fails a comparative column the pack states no period for', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    const actual = p.figure('packFigureSet.current.revenue', 4_200_000, 'money');
    const prior = p.figure('packFigureSet.current.revenue.prior', 3_750_000, 'money');
    expect(() => assertPackIntegrity(docOf(p, [tableOf(['actual', 'prior'], { actual, prior })], null)))
      .toThrow(/states no comparative period/i);
  });

  it('fails a stated comparative period no statement compares against', () => {
    // Page 12 prints this period in the basis of preparation, so it is a
    // claim made to a reader that nothing in the pack used.
    const p = new PackFigureProvenance();
    balanced(p);
    expect(() => assertPackIntegrity(docOf(p, [], comparative)))
      .toThrow(/claims a comparison the pack does not make/i);
  });

});
